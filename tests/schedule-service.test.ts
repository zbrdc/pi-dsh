import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_MS, ScheduleService, type ScheduleClock } from "../src/schedule-service.ts";
import { FakeClock } from "./support/fake-clock.ts";
import { ScheduleStore, decodeTaskFile, historyPage, scheduleFile, withDelivery, type ScheduleTask } from "../src/schedule-store.ts";
import { ScheduleInputError } from "../src/schedule-time.ts";

function setup(start = "2026-09-16T00:00:00Z", extra: Partial<ConstructorParameters<typeof ScheduleService>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-schedule-"));
  const clock = new FakeClock(start);
  const delivered: { text: string; key?: string }[] = [];
  const warnings: string[] = [];
  let changes = 0;
  const make = (clk: ScheduleClock = clock) => new ScheduleService({
    dir, clock: clk, deliver: (text, key) => { delivered.push({ text, key }); }, warn: (m) => warnings.push(m), changed: () => { changes++; }, ...extra,
  });
  const service = make();
  service.attach("session-a");
  return { dir, clock, service, make, delivered, warnings, changes: () => changes, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a one-shot fires at its target, is framed, and ends with a receipt", (t) => {
  const s = setup(); t.after(s.cleanup);
  const record = s.service.create({ prompt: "Check the build", title: "Build check", after_seconds: 600 });
  assert.equal(s.clock.nextIn, HEARTBEAT_MS, "a distant target is rechecked each heartbeat");
  s.clock.advance(599_999);
  assert.equal(s.delivered.length, 0);
  s.clock.advance(1);
  assert.equal(s.delivered.length, 1);
  assert.match(s.delivered[0]!.text, /^\[SCHEDULE REMINDER\]\nThis is a scheduled message from the user\nschedule_id_json: /);
  assert.match(s.delivered[0]!.text, /reminder_prompt_json: "Check the build"$/);
  assert.equal(s.delivered[0]!.key, undefined);
  assert.deepEqual(s.service.list(), [], "an ended reminder leaves the active list");
  const [task] = s.service.tasks();
  assert.equal(task!.status, "inactive");
  assert.equal(task!.lastDelivery!.scheduledAt, record.scheduledAt);
  assert.equal(task!.lastDelivery!.deliveredAt, record.scheduledAt);
  assert.equal(s.clock.pending, 0, "no timer once nothing is active");
  s.clock.advance(86_400_000);
  assert.equal(s.delivered.length, 1, "it never fires twice");
});

test("a recurring reminder advances from the occurrence it delivered", (t) => {
  const s = setup(); t.after(s.cleanup);
  s.service.create({ prompt: "Queue", title: "Queue", every_seconds: 300 });
  s.clock.advance(300_000);
  assert.equal(s.delivered.length, 1);
  assert.match(s.delivered[0]!.text, /^\[SCHEDULE REMINDER BATCH\]\nThis is a scheduled message from the user\nreminders_json: \[\{"schedule_id":"schedule-[0-9a-f]{16}","occurrence_at":"2026-09-16T00:05:00.000Z","reminder_prompt":"Queue"\}\]$/);
  assert.equal(s.service.list()[0]!.scheduledAt, "2026-09-16T00:10:00.000Z");
  s.clock.advance(600_000);
  assert.equal(s.delivered.length, 3);
  assert.equal(s.service.tasks()[0]!.deliveryHistory.records.length, 3);
});

test("recurring reminders due together share one message; a lone one is keyed so a newer occurrence replaces an older", (t) => {
  const s = setup(); t.after(s.cleanup);
  const a = s.service.create({ prompt: "A", title: "A", every_seconds: 60 });
  const b = s.service.create({ prompt: "B", title: "B", every_seconds: 120 });
  s.clock.advance(120_000);
  const batches = s.delivered.filter((d) => d.text.includes(b.id));
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.key, undefined, "a batch of several has no single owner");
  assert.ok(batches[0]!.text.includes(a.id));
  assert.deepEqual(s.delivered.filter((d) => d.key !== undefined).map((d) => d.key), [`schedule:${a.id}`], "the lone minute-mark delivery is keyed to its task");
  const one = setup(); t.after(one.cleanup);
  const only = one.service.create({ prompt: "A", title: "A", every_seconds: 60 });
  one.clock.advance(180_000);
  assert.deepEqual(one.delivered.map((d) => d.key), [`schedule:${only.id}`, `schedule:${only.id}`, `schedule:${only.id}`]);
});

test("after downtime only the latest occurrence of a rule arrives, on attach", (t) => {
  const s = setup("2026-09-16T00:00:00Z"); t.after(s.cleanup);
  s.service.create({ prompt: "Standup", title: "Standup", daily: { time: "09:00:00", time_zone: "UTC" } });
  s.service.create({ prompt: "Once", title: "Once", after_seconds: 60 });
  s.service.detach();
  s.clock.jump(5 * 86_400_000 + 12 * 3_600_000); // five and a half days with no process running
  const again = s.make();
  again.attach("session-a");
  assert.equal(s.delivered.length, 2, "the one-shot and one batch for the daily rule");
  assert.match(s.delivered[0]!.text, /^\[SCHEDULE REMINDER\]/);
  assert.match(s.delivered[1]!.text, /"occurrence_at":"2026-09-21T09:00:00.000Z"/);
  assert.equal(again.list()[0]!.scheduledAt, "2026-09-22T09:00:00.000Z");
  assert.equal(again.tasks().find((t) => t.record.kind === "after")!.status, "inactive");
});

test("only the open session's reminders fire; other sessions stay stored and listed", (t) => {
  const s = setup(); t.after(s.cleanup);
  s.service.create({ prompt: "Mine", title: "Mine", after_seconds: 60 });
  s.service.detach();
  const other = s.make();
  other.attach("session-b");
  other.create({ prompt: "Theirs", title: "Theirs", after_seconds: 60 });
  s.clock.advance(120_000);
  assert.equal(s.delivered.length, 1);
  assert.match(s.delivered[0]!.text, /Theirs/);
  assert.deepEqual(other.allSessions().map((t) => [t.sessionId, t.status]).sort(), [["session-a", "active"], ["session-b", "inactive"]]);
  assert.equal(other.list().length, 0);
});

test("a timer is never armed past the heartbeat, so a slept-through deadline is still met", (t) => {
  const s = setup(); t.after(s.cleanup);
  s.service.create({ prompt: "Far", title: "Far", after_seconds: 3600 });
  assert.equal(s.clock.nextIn, HEARTBEAT_MS);
  s.clock.jump(3_600_000); // suspended: the timer did not run
  assert.equal(s.delivered.length, 0);
  s.clock.advance(HEARTBEAT_MS);
  assert.equal(s.delivered.length, 1);
});

test("management: update keeps the id and receipts; delete stops delivery", (t) => {
  const s = setup(); t.after(s.cleanup);
  const record = s.service.create({ prompt: "Old", title: "Old name", every_seconds: 600 });
  s.clock.advance(600_000);
  const renamed = s.service.update(record.id, { title: "New name", prompt: "New" });
  assert.equal(renamed.updated, true);
  assert.equal(s.service.list()[0]!.title, "New name");
  assert.equal(s.service.list()[0]!.scheduledAt, "2026-09-16T00:20:00.000Z", "a rename keeps the committed target");
  assert.equal(s.service.tasks()[0]!.deliveryHistory.records.length, 1, "receipts survive an update");
  const moved = s.service.update(record.id, { change: { kind: "every", every_seconds: 60 } });
  assert.equal("record" in moved && moved.record.scheduledAt, "2026-09-16T00:11:00.000Z", "a new interval starts at the save time");
  assert.deepEqual(s.service.update("nope", { title: "x" }), { id: "nope", updated: false, code: "schedule_not_found" });
  assert.deepEqual(s.service.remove("nope"), { id: "nope", deleted: false, code: "schedule_not_found" });
  const before = s.delivered.length;
  assert.deepEqual(s.service.remove(record.id), { id: record.id, deleted: true });
  s.clock.advance(3_600_000);
  assert.equal(s.delivered.length, before);
  assert.equal(s.service.tasks().length, 0);
  assert.ok(s.changes() >= 3);
});

test("an ended one-shot cannot be edited, but it can still be deleted", (t) => {
  const s = setup(); t.after(s.cleanup);
  const record = s.service.create({ prompt: "p", title: "t", after_seconds: 60 });
  s.clock.advance(60_000);
  assert.deepEqual(s.service.update(record.id, { title: "x" }), { id: record.id, updated: false, code: "schedule_ended" });
  assert.deepEqual(s.service.remove(record.id), { id: record.id, deleted: true });
});

test("invalid requests leave the store untouched", (t) => {
  const s = setup(); t.after(s.cleanup);
  assert.throws(() => s.service.create({ prompt: "p", title: "t" }), ScheduleInputError);
  assert.throws(() => s.service.create({ prompt: "p", title: "t", every_seconds: 30 }), (e: any) => e.code === "frequency_too_high");
  assert.equal(existsSync(scheduleFile(s.dir, "session-a")), false, "nothing was written");
  assert.throws(() => s.service.history("x", 0), ScheduleInputError);
  assert.throws(() => s.service.history("x", 101), ScheduleInputError);
});

test("reminders survive a restart byte for byte", (t) => {
  const s = setup(); t.after(s.cleanup);
  const record = s.service.create({ prompt: "Weekly", title: "Weekly", weekly: { time: "09:00:00", time_zone: "Asia/Shanghai", weekdays: [3, 1] } });
  s.service.detach();
  const file = scheduleFile(s.dir, "session-a");
  const bytes = readFileSync(file, "utf8");
  const again = s.make();
  again.attach("session-a");
  assert.deepEqual(again.list(), [record]);
  assert.equal(readFileSync(file, "utf8"), bytes, "attaching rewrote nothing");
  assert.deepEqual(readdirSync(s.dir), ["session-a.json"], "no temporary file is left behind");
});

test("a failed delivery keeps the task, warns once, and retries only after a change or a restart", (t) => {
  let fail = true;
  const s = setup("2026-09-16T00:00:00Z", { deliver: () => { if (fail) throw new Error("outbox is gone"); } });
  t.after(s.cleanup);
  const record = s.service.create({ prompt: "p", title: "t", after_seconds: 60 });
  s.clock.advance(60_000);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0]!, /were not delivered: outbox is gone/);
  assert.equal(s.service.list().length, 1, "still active");
  s.clock.advance(5 * HEARTBEAT_MS);
  assert.equal(s.warnings.length, 1, "no retry on every heartbeat");
  fail = false;
  s.service.create({ prompt: "later", title: "later", after_seconds: 3600 }); // a management change retries
  assert.equal(s.service.tasks().find((x) => x.record.id === record.id)!.status, "inactive");
});

test("a damaged file is never overwritten; reminders stay paused until it is fixed", (t) => {
  const s = setup(); t.after(s.cleanup);
  s.service.detach();
  const file = scheduleFile(s.dir, "session-a");
  writeFileSync(file, "{broken json");
  const again = s.make();
  again.attach("session-a");
  assert.match(s.warnings.at(-1)!, /paused until the file is fixed/);
  assert.deepEqual(again.list(), []);
  assert.throws(() => again.create({ prompt: "p", title: "t", after_seconds: 60 }), /unreadable/);
  assert.throws(() => again.remove("x"), /unreadable/);
  assert.equal(readFileSync(file, "utf8"), "{broken json");
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ sessionId: "session-a", status: "active", deliveryHistory: { records: [], earlierRecordsPruned: false }, record: { id: "x", kind: "later" } }] }));
  const invalidTask = s.make();
  invalidTask.attach("session-a");
  assert.match(s.warnings.at(-1)!, /schedule kind/);
});

test("a write that fails changes nothing in memory", (t) => {
  const s = setup(); t.after(s.cleanup);
  const blocker = join(s.dir, "blocked");
  writeFileSync(blocker, "a file where a directory should be");
  const store = new ScheduleStore(join(blocker, "x.json"));
  const task = { sessionId: "s", status: "active", deliveryHistory: { records: [], earlierRecordsPruned: false }, record: { id: "a", kind: "at", title: "t", prompt: "p", scheduledAt: "2099-01-01T00:00:00.000Z" } } as ScheduleTask;
  assert.throws(() => store.put(task));
  assert.deepEqual(store.all(), []);
});

// ---- delivery history ----

const dueTask = (): ScheduleTask => ({
  sessionId: "s", status: "active", deliveryHistory: { records: [], earlierRecordsPruned: false },
  record: { id: "t", kind: "every", title: "t", prompt: "the prompt", everySeconds: 60, scheduledAt: "2026-09-16T00:00:00.000Z" },
});

test("history keeps the sent prompt, newest first, and pages by identity", () => {
  let task = dueTask();
  for (let i = 1; i <= 5; i++) task = { ...task, ...withDelivery(task, { scheduledAt: `2026-09-16T00:0${i}:00.000Z`, deliveredAt: `2026-09-16T00:0${i}:01.000Z`, messageId: `m${i}` }, { days: 30, records: 200 }) };
  const first = historyPage(task, 2, { days: 30, records: 200 });
  assert.ok("records" in first);
  assert.deepEqual(first.records.map((r) => r.messageId), ["m5", "m4"]);
  assert.equal(first.records[0]!.prompt, "the prompt");
  assert.equal(first.nextBefore, "m4");
  const second = historyPage(task, 2, { days: 30, records: 200 }, first.nextBefore);
  assert.ok("records" in second);
  assert.deepEqual(second.records.map((r) => r.messageId), ["m3", "m2"]);
  const last = historyPage(task, 2, { days: 30, records: 200 }, "m2");
  assert.ok("records" in last);
  assert.deepEqual(last.records.map((r) => r.messageId), ["m1"]);
  assert.equal(last.nextBefore, undefined);
  assert.deepEqual(historyPage(task, 2, { days: 30, records: 200 }, "missing"), { id: "t", code: "delivery_cursor_not_found" });
});

test("history is pruned to the window and cap on append, and says so", () => {
  let task = dueTask();
  const retention = { days: 1, records: 3 };
  for (let i = 1; i <= 5; i++) task = { ...task, ...withDelivery(task, { scheduledAt: "2026-09-16T00:00:00.000Z", deliveredAt: `2026-09-${10 + i * 3}T00:00:00.000Z`, messageId: `m${i}` }, retention) };
  assert.deepEqual(task.deliveryHistory.records.map((r) => r.messageId), ["m5"], "only the last day survives");
  assert.equal(task.deliveryHistory.earlierRecordsPruned, true);
  let capped = dueTask();
  for (let i = 1; i <= 5; i++) capped = { ...capped, ...withDelivery(capped, { scheduledAt: "2026-09-16T00:00:00.000Z", deliveredAt: "2026-09-16T00:00:00.000Z", messageId: `c${i}` }, { days: 30, records: 3 }) };
  assert.deepEqual(capped.deliveryHistory.records.map((r) => r.messageId), ["c3", "c4", "c5"]);
  assert.equal(capped.lastDelivery!.messageId, "c5");
});

test("the service reads history of its own tasks and answers not-found for others", (t) => {
  const s = setup(); t.after(s.cleanup);
  const record = s.service.create({ prompt: "p", title: "t", every_seconds: 60 });
  s.clock.advance(180_000);
  const page = s.service.history(record.id, 2);
  assert.ok("records" in page);
  assert.equal(page.records.length, 2);
  assert.ok(page.nextBefore !== undefined);
  assert.deepEqual(s.service.history("nope", 5), { id: "nope", code: "schedule_not_found" });
});

test("stored files must be exactly {version: 1, tasks: [...]} with valid, unique tasks", () => {
  const good = JSON.stringify({ version: 1, tasks: [dueTask()] });
  assert.equal(decodeTaskFile(good).length, 1);
  const task = dueTask();
  for (const bad of [
    "[]", JSON.stringify({ version: 2, tasks: [] }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, tasks: [task, task] }),
    JSON.stringify({ version: 1, tasks: [{ ...task, status: "paused" }] }), JSON.stringify({ version: 1, tasks: [{ ...task, sessionId: 7 }] }),
    JSON.stringify({ version: 1, tasks: [{ ...task, deliveryHistory: { records: [{ scheduledAt: "a", deliveredAt: "b", messageId: "m" }, { scheduledAt: "a", deliveredAt: "b", messageId: "m" }], earlierRecordsPruned: false } }] }),
  ]) assert.throws(() => decodeTaskFile(bad), /./, bad.slice(0, 60));
});
