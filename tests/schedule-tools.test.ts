import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleService } from "../src/schedule-service.ts";
import { registerScheduleTools } from "../src/schedule-tools.ts";
import { describeRule, runScheduleCommand } from "../src/schedule-command.ts";
import { FakeClock } from "./support/fake-clock.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-schedule-tools-"));
  const clock = new FakeClock("2026-09-16T00:00:00Z");
  const delivered: string[] = [];
  const service = new ScheduleService({ dir, clock, deliver: (text) => { delivered.push(text); }, warn: () => undefined });
  service.attach("session-a");
  const tools = new Map<string, any>();
  registerScheduleTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, { schedule: service, remember: () => undefined, zone: "Asia/Shanghai" });
  const call = async (name: string, params: Record<string, unknown>) => {
    const result = await tools.get(name).execute("id", params, undefined, undefined, {});
    return { isError: Boolean(result.isError), value: JSON.parse(result.content[0].text) };
  };
  return { dir, clock, service, tools, delivered, call, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the four tools register with their DSH names and a zone hint", (t) => {
  const s = setup(); t.after(s.cleanup);
  assert.deepEqual([...s.tools.keys()].sort(), ["schedule_create", "schedule_delete", "schedule_list", "schedule_update"]);
  assert.match(s.tools.get("schedule_create").description, /use Asia\/Shanghai/);
  for (const field of ["prompt", "title", "after_seconds", "at", "every_seconds", "daily", "weekly", "cron"]) assert.ok(JSON.stringify(s.tools.get("schedule_create").parameters).includes(`"${field}"`), field);
});

test("create returns the record with its state and delivery mode, list shows it, delete removes it", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const created = await s.call("schedule_create", { prompt: "Review the week", title: "Weekly review", weekly: { time: "09:00:00", time_zone: "Asia/Shanghai", weekdays: [3, 1] } });
  assert.equal(created.isError, false);
  assert.deepEqual({ ...created.value, id: "x" }, {
    id: "x", kind: "weekly", title: "Weekly review", prompt: "Review the week", time: "09:00:00.000", timeZone: "Asia/Shanghai", weekdays: [1, 3],
    scheduledAt: "2026-09-16T01:00:00.000Z", state: "scheduled", deliveryMode: "host",
  });
  const listed = await s.call("schedule_list", {});
  assert.deepEqual(listed.value.map((r: any) => r.id), [created.value.id]);
  assert.deepEqual((await s.call("schedule_delete", { id: created.value.id })).value, { id: created.value.id, deleted: true });
  assert.deepEqual((await s.call("schedule_delete", { id: created.value.id })).value, { id: created.value.id, deleted: false, code: "schedule_not_found" });
  assert.deepEqual((await s.call("schedule_list", {})).value, []);
});

test("creation errors carry a stable code and are marked as errors", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const cases: [Record<string, unknown>, string][] = [
    [{ prompt: "p", title: "t" }, "invalid_selector"],
    [{ prompt: "p", title: "t", after_seconds: 60, every_seconds: 60 }, "invalid_selector"],
    [{ prompt: "p", title: "t", after_seconds: 60, surprise: 1 }, "invalid_selector"],
    [{ prompt: "  ", title: "t", after_seconds: 60 }, "invalid_prompt"],
    [{ prompt: "p", title: "", after_seconds: 60 }, "invalid_prompt"],
    [{ prompt: "p", title: "t", after_seconds: 0 }, "invalid_rule"],
    [{ prompt: "p", title: "t", every_seconds: 59 }, "frequency_too_high"],
    [{ prompt: "p", title: "t", at: "2020-01-01T00:00:00Z" }, "not_future"],
    [{ prompt: "p", title: "t", daily: { time: "09:00:00", time_zone: "Mars/Base" } }, "invalid_time_zone"],
    [{ prompt: "p", title: "t", cron: { expression: "0 0 L * *", time_zone: "UTC" } }, "invalid_rule"],
  ];
  for (const [params, code] of cases) {
    const result = await s.call("schedule_create", params);
    assert.equal(result.isError, true, JSON.stringify(params));
    assert.equal(result.value.code, code, JSON.stringify(params));
    assert.equal(typeof result.value.message, "string");
  }
  assert.deepEqual((await s.call("schedule_list", {})).value, []);
});

test("update changes content or one timing selector and reports missing or ended reminders", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const { value: created } = await s.call("schedule_create", { prompt: "p", title: "Old", daily: { time: "09:00:00", time_zone: "UTC" } });
  const renamed = await s.call("schedule_update", { id: created.id, title: "New" });
  assert.equal(renamed.value.title, "New");
  assert.equal(renamed.value.scheduledAt, created.scheduledAt, "a rename keeps the committed target");
  const moved = await s.call("schedule_update", { id: created.id, cron: { expression: "0 12 * * *", time_zone: "UTC" } });
  assert.equal(moved.value.kind, "cron");
  assert.equal(moved.value.id, created.id);
  assert.deepEqual((await s.call("schedule_update", { id: "missing", title: "x" })).value, { id: "missing", updated: false, code: "schedule_not_found" });
  for (const [params, code] of [
    [{ id: created.id }, "invalid_selector"],
    [{ id: created.id, at: "2099-01-01T00:00:00Z", every_seconds: 60 }, "invalid_selector"],
    [{ id: created.id, after_seconds: 60 }, "invalid_selector"],
    [{ id: " padded", title: "x" }, "invalid_rule"],
    [{ id: created.id, every_seconds: 30 }, "frequency_too_high"],
    [{ id: created.id, title: "  " }, "invalid_prompt"],
  ] as [Record<string, unknown>, string][]) {
    const result = await s.call("schedule_update", params);
    assert.equal(result.isError, true, JSON.stringify(params));
    assert.equal(result.value.code, code, JSON.stringify(params));
  }
  const once = (await s.call("schedule_create", { prompt: "p", title: "Once", after_seconds: 60 })).value;
  s.clock.advance(60_000);
  assert.deepEqual((await s.call("schedule_update", { id: once.id, title: "x" })).value, { id: once.id, updated: false, code: "schedule_ended" });
});

test("a store problem surfaces as an internal error with its reason", async (t) => {
  const s = setup(); t.after(s.cleanup);
  s.service.detach();
  const result = await s.call("schedule_create", { prompt: "p", title: "t", after_seconds: 60 });
  assert.equal(result.isError, true);
  assert.equal(result.value.code, "internal_error");
  assert.match(result.value.message, /No session is open/);
});

test("/schedule lists, shows, pages history, deletes, and spans sessions", (t) => {
  const s = setup(); t.after(s.cleanup);
  const run = (args: string) => runScheduleCommand(s.service, args, s.clock.now());
  assert.equal(run("").text, "No reminders in this session.");
  const daily = s.service.create({ prompt: "Standup", title: "Standup", daily: { time: "09:00:00", time_zone: "Asia/Shanghai" } });
  const every = s.service.create({ prompt: "Queue", title: "Queue", every_seconds: 120 });
  const list = run("list").text;
  assert.match(list, /^Reminders \(2\):/);
  assert.match(list, new RegExp(`${every.id} active — Queue: every 120s; next 2026-09-16T00:02:00.000Z \\(in 2m\\)`));
  assert.match(list, /Standup: daily at 09:00:00.000 Asia\/Shanghai/);
  s.clock.advance(240_000);
  assert.match(run(`show ${every.id}`).text, /prompt: Queue\nlast delivery: occurrence 2026-09-16T00:04:00.000Z/);
  assert.match(run(`history ${every.id}`).text, /2026-09-16T00:04:00.000Z — occurrence 2026-09-16T00:04:00.000Z: Queue/);
  assert.equal(run(`history ${every.id} nope`).text, `No delivery nope in the history of ${every.id}.`);
  assert.equal(run("history ghost").text, "No reminder ghost.");
  const other = new ScheduleService({ dir: s.dir, clock: s.clock, deliver: () => undefined, warn: () => undefined });
  other.attach("session-b");
  other.create({ prompt: "Theirs", title: "Theirs", after_seconds: 3600 });
  other.detach();
  assert.match(run("all").text, /Reminders in all sessions \(3\); only this session's fire here:[\s\S]*\[session session-b\]/);
  assert.deepEqual(run(`delete ${daily.id}`), { text: `Deleted ${daily.id}. A reminder already queued is not retracted.`, changed: true });
  assert.deepEqual(run("delete ghost"), { text: "No reminder ghost.", changed: false });
  assert.match(run("bogus").text, /^Usage: \/schedule/);
  assert.match(run("history").text, /^Usage: \/schedule/);
});

test("rules read back in words", () => {
  const base = { id: "i", title: "t", prompt: "p", scheduledAt: "2099-01-01T00:00:00.000Z" };
  assert.equal(describeRule({ ...base, kind: "after", afterSeconds: 600 }), "once, 600s after creation");
  assert.equal(describeRule({ ...base, kind: "at" }), "once");
  assert.equal(describeRule({ ...base, kind: "weekly", time: "09:00:00.000", timeZone: "UTC", weekdays: [1, 5, 7] }), "Mon,Fri,Sun at 09:00:00.000 UTC");
  assert.equal(describeRule({ ...base, kind: "cron", expression: "*/15 9-17 * * 1-5", timeZone: "UTC" }), 'cron "*/15 9-17 * * 1-5" UTC');
});
