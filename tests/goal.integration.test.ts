import test from "node:test";
import assert from "node:assert/strict";
import { blockUntilAborted, createHarness, fauxAssistantMessage, fauxToolCall } from "./support/pi-session.ts";

const createGoal = (maxRounds?: number) => fauxAssistantMessage([
  fauxToolCall("create_goal", { objective: "ship the fix", ...(maxRounds ? { max_rounds: maxRounds } : {}) }),
]);

test("goal rounds chain after the human turn until the round limit blocks the goal", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  h.faux.setResponses([
    createGoal(2), fauxAssistantMessage("goal created"), fauxAssistantMessage("round one"), fauxAssistantMessage("round two"),
    fauxAssistantMessage("understood, the goal is blocked"),
  ]);
  await h.session.prompt("set up a goal to ship the fix");
  await h.settled();
  // Two goal turns, two rounds, and the model's reaction to the round-limit notice.
  assert.equal(h.faux.state.callCount, 5);
  assert.equal(h.goal().status, "blocked");
  assert.match(h.goal().blocker, /round-limit/);
  // Each round prompt is stamped with the goal and revision it was requested under.
  const rounds = (h.session.sessionManager.getBranch() as any[]).filter((e) => e.type === "custom_message" && e.customType === "pi-dsh/goal-round");
  assert.deepEqual(rounds.map((e) => e.details.round), [1, 2]);
  assert.ok(rounds.every((e) => e.details.goalId === h.goal().id && Number.isInteger(e.details.revision)));
});

test("aborting a goal round pauses the goal and starts no further round", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  h.faux.setResponses([createGoal(), fauxAssistantMessage("goal created"), blockUntilAborted()]);
  const run = h.session.prompt("set up a goal to ship the fix");
  await h.waitForCalls(3);
  await h.session.abort();
  await run;
  await h.settled();
  assert.equal(h.faux.state.callCount, 3, "a round started after the abort");
  assert.equal(h.goal().status, "paused");
  assert.equal(h.goal().armed, false);
});

test("aborting the human turn disarms the goal without pausing it", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  h.faux.setResponses([createGoal(), blockUntilAborted()]);
  const run = h.session.prompt("set up a goal to ship the fix");
  await h.waitForCalls(2);
  await h.session.abort();
  await run;
  await h.settled();
  assert.equal(h.faux.state.callCount, 2, "a round started after the abort");
  assert.equal(h.goal().armed, false);
  assert.equal(h.goal().status, "active");
});

test("/goal pause aborts the live round", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  h.faux.setResponses([createGoal(), fauxAssistantMessage("goal created"), blockUntilAborted()]);
  const run = h.session.prompt("set up a goal to ship the fix");
  await h.waitForCalls(3);
  await h.session.prompt("/goal pause");
  await run;
  await h.settled();
  assert.equal(h.faux.state.callCount, 3);
  assert.equal(h.goal().status, "paused");
});

test("a goal round does not inherit the human turn's authority to create goals", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  h.faux.setResponses([
    createGoal(2), fauxAssistantMessage("goal created"),
    fauxAssistantMessage([fauxToolCall("create_goal", { objective: "hijack" })]), fauxAssistantMessage("round one done"),
  ]);
  await h.session.prompt("set up a goal to ship the fix");
  await h.settled();
  const results = h.session.messages.filter((m: any) => m.role === "toolResult" && m.toolName === "create_goal");
  assert.equal(results.length, 2);
  assert.match(JSON.stringify(results[1]), /requires a direct human request/);
});

test("a run that ends in an error disarms the goal instead of burning rounds", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  h.faux.setResponses([
    createGoal(), fauxAssistantMessage("goal created"),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
    fauxAssistantMessage("acknowledged the disarm notice"),
  ]);
  await h.session.prompt("set up a goal to ship the fix");
  await h.settled();
  assert.equal(h.goal().armed, false);
  assert.equal(h.goal().status, "active");
  assert.ok(h.faux.state.callCount <= 4, `provider served ${h.faux.state.callCount} requests`);
});
