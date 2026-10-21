import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, fauxAssistantMessage, fauxToolCall } from "./support/pi-session.ts";

test("Escape kills a foreground bash command instead of waiting for it", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  h.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30", description: "long sleep" })]),
    fauxAssistantMessage("must not be requested after the abort"),
  ]);
  const started = Date.now();
  const run = h.session.prompt("sleep for a while");
  await h.until(() => h.events.some((e) => e.type === "tool_execution_start"));
  await h.session.abort();
  await run;
  assert.ok(Date.now() - started < 10_000, "the abort waited for the command to finish");
  const result = h.events.find((e) => e.type === "tool_execution_end");
  assert.equal(result?.isError, true);
  assert.match(JSON.stringify(result?.result), /command aborted/);
});
