import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness, fauxAssistantMessage, fauxToolCall, scratchHome } from "./support/pi-session.ts";

const TYPE = "pi-dsh/schedule";
const create = (extra: Record<string, unknown>) => fauxToolCall("schedule_create", { prompt: "Stretch your legs", title: "Stretch", ...extra });

/** Faux step that records the reminder messages the model is shown, then answers. */
function recordReminders(into: { seen?: string[] }, answer = "stretching") {
  return (context: { messages: any[] }) => {
    into.seen = context.messages
      .filter((m) => m.role === "user" && JSON.stringify(m.content).includes("[SCHEDULE REMINDER"))
      .map((m) => JSON.stringify(m.content));
    return fauxAssistantMessage(answer);
  };
}

test("a reminder created by the model comes due, wakes the idle model, and ends", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const shown: { seen?: string[] } = {};
  h.faux.setResponses([fauxAssistantMessage([create({ after_seconds: 1 })]), fauxAssistantMessage("reminder set"), recordReminders(shown)]);
  await h.session.prompt("remind me in a second");
  await h.waitForCalls(3, 10_000);
  await h.settled();
  assert.equal(h.faux.state.callCount, 3);
  const messages = h.customMessages(TYPE);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^\[SCHEDULE REMINDER\]\nThis is a scheduled message from the user\nschedule_id_json: "schedule-/);
  assert.match(messages[0]!, /reminder_prompt_json: "Stretch your legs"$/);
  assert.equal(shown.seen?.length, 1, "the model saw the reminder as a message in its context");
  assert.deepEqual(h.outbox(), []);
  // The model can list it: it ended, so it is no longer active.
  h.faux.setResponses([fauxAssistantMessage([fauxToolCall("schedule_list", {})]), fauxAssistantMessage("none left")]);
  await h.session.prompt("what is scheduled?");
  await h.settled();
  const results = (h.session.sessionManager.getBranch() as any[]).filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "schedule_list");
  assert.equal(JSON.stringify(results.at(-1)?.message.content).includes('"kind"'), false);
});

test("a reminder that comes due during a run reaches the model at the next step, without a second wake", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const shown: { seen?: string[] } = {};
  h.faux.setResponses([
    fauxAssistantMessage([create({ after_seconds: 1 }), fauxToolCall("bash", { command: "sleep 1.6" })]),
    recordReminders(shown, "done"),
  ]);
  await h.session.prompt("set a reminder and keep working");
  await h.settled();
  assert.equal(h.faux.state.callCount, 2, "the reminder rode the run instead of waking the model again");
  assert.equal(shown.seen?.length, 1);
  assert.equal(h.customMessages(TYPE).length, 1);
});

test("quiet delivery still wakes the model for a reminder", async (t) => {
  const h = await createHarness({ config: { completionDelivery: "quiet", maxConsecutiveWakes: 0 } });
  t.after(() => h.dispose());
  h.faux.setResponses([fauxAssistantMessage([create({ after_seconds: 1 })]), fauxAssistantMessage("reminder set"), fauxAssistantMessage("here it is")]);
  await h.session.prompt("remind me");
  await h.waitForCalls(3, 10_000);
  await h.settled();
  assert.equal(h.customMessages(TYPE).length, 1);
});

test("a reminder that came due while no session ran is delivered when the session starts again", async (t) => {
  const first = await createHarness();
  first.faux.setResponses([fauxAssistantMessage([create({ after_seconds: 1 })]), fauxAssistantMessage("reminder set")]);
  await first.session.prompt("remind me");
  await first.settled();
  const entries = first.entries();
  await first.shutdown();
  first.dispose();
  await new Promise((r) => setTimeout(r, 1300));
  const second = await createHarness({ entries });
  t.after(() => second.dispose());
  second.faux.setResponses([fauxAssistantMessage("late, but noted")]);
  await second.waitForCalls(1, 10_000);
  await second.settled();
  assert.equal(second.customMessages(TYPE).length, 1);
  assert.match(second.customMessages(TYPE)[0]!, /Stretch your legs/);
});

test("a session torn down without a shutdown event does not consume a reminder it cannot deliver", async (t) => {
  const first = await createHarness();
  first.faux.setResponses([fauxAssistantMessage([create({ after_seconds: 1 })]), fauxAssistantMessage("reminder set")]);
  await first.session.prompt("remind me");
  await first.settled();
  const entries = first.entries();
  first.dispose(); // its timer is still armed
  await new Promise((r) => setTimeout(r, 1300));
  const second = await createHarness({ entries });
  t.after(() => second.dispose());
  second.faux.setResponses([fauxAssistantMessage("still got it")]);
  await second.waitForCalls(1, 10_000);
  await second.settled();
  assert.equal(second.customMessages(TYPE).length, 1);
});

test("a recurring reminder is stored per session and survives the session closing", async (t) => {
  const h = await createHarness();
  h.faux.setResponses([
    fauxAssistantMessage([create({ daily: { time: "09:00:00", time_zone: "UTC" }, title: "Standup" })]), fauxAssistantMessage("set"),
  ]);
  await h.session.prompt("every morning");
  await h.settled();
  const dir = join(scratchHome, ".pi", "agent", "pi-dsh", "schedule");
  assert.equal(readdirSync(dir).length >= 1, true);
  const entries = h.entries();
  h.dispose();
  const again = await createHarness({ entries });
  t.after(() => again.dispose());
  again.faux.setResponses([fauxAssistantMessage([fauxToolCall("schedule_list", {})]), fauxAssistantMessage("listed")]);
  await again.session.prompt("what is scheduled?");
  await again.settled();
  const listing = (again.session.sessionManager.getBranch() as any[]).filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "schedule_list");
  assert.match(JSON.stringify(listing.at(-1)?.message.content), /Standup/);
});

test("/schedule delete removes a reminder before it fires", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  h.faux.setResponses([fauxAssistantMessage([create({ after_seconds: 2 })]), fauxAssistantMessage("reminder set")]);
  await h.session.prompt("remind me");
  await h.settled();
  const id = /schedule-[0-9a-f]{16}/.exec(JSON.stringify(h.session.sessionManager.getBranch()))?.[0];
  assert.ok(id);
  await h.session.prompt(`/schedule delete ${id}`);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(h.faux.state.callCount, 2, "nothing woke the model");
  assert.equal(h.customMessages(TYPE).length, 0);
});

test("schedule: false registers no reminder tools or command", async (t) => {
  const on = await createHarness();
  t.after(() => on.dispose());
  assert.deepEqual(on.session.getActiveToolNames().filter((n) => n.startsWith("schedule_")).sort(), ["schedule_create", "schedule_delete", "schedule_list", "schedule_update"]);
  const off = await createHarness({ config: { schedule: false } });
  t.after(() => off.dispose());
  assert.deepEqual(off.session.getActiveToolNames().filter((n) => n.startsWith("schedule_")), []);
});
