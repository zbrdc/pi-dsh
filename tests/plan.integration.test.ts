import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, fauxAssistantMessage, fauxToolCall } from "./support/pi-session.ts";

const planStates = (h: Awaited<ReturnType<typeof createHarness>>) => (h.session.sessionManager.getBranch() as any[])
  .filter((e) => e.type === "custom" && e.customType === "pi-dsh/plan")
  .map((e) => Boolean(e.data?.active));

test("without a UI nobody can approve the plan, so plan mode stays on", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  await h.session.prompt("/plan");
  assert.deepEqual(planStates(h), [true]);

  let seen: any;
  h.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("exit_plan_mode", { plan: "1. do the thing" })]),
    (context: { messages: any[] }) => {
      seen = [...context.messages].reverse().find((m) => m.role === "toolResult");
      return fauxAssistantMessage("Here is the plan: 1. do the thing");
    },
  ]);
  await h.session.prompt("plan it");
  await h.settled();

  assert.equal(seen?.isError, true, "the refusal was not reported as an error");
  assert.match(JSON.stringify(seen?.content), /no interactive UI/);
  assert.match(JSON.stringify(seen?.content), /Plan mode stays active/);
  assert.deepEqual(planStates(h), [true], "plan mode was switched off without a review");
});

test("/plan off still leaves plan mode without a UI", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  await h.session.prompt("/plan");
  await h.session.prompt("/plan off");
  assert.deepEqual(planStates(h), [true, false]);
});
