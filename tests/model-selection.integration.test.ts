import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, fauxAssistantMessage, fauxToolCall } from "./support/pi-session.ts";

const ALLOWED = "faux/faux-1";

/** Run one scripted tool call and return the tool result the model saw. */
async function callTool(config: Record<string, unknown>, tool: string, args: Record<string, unknown>, extraResponses: any[] = []) {
  const h = await createHarness({ config });
  try {
    h.faux.setResponses([fauxAssistantMessage([fauxToolCall(tool, args as any)]), ...extraResponses, fauxAssistantMessage("noted")]);
    await h.session.prompt("go");
    await h.settled();
    const end = h.events.find((e) => e.type === "tool_execution_end" && e.toolName === tool);
    return { isError: end?.isError === true, text: JSON.stringify(end?.result ?? "") };
  } finally { h.dispose(); }
}

test("an explicit model outside subagentModels is refused before any child starts", async () => {
  const r = await callTool({ subagentModels: ["faux/other"] }, "subagent", { task: "x", model: ALLOWED });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /not in the configured subagentModels allowlist/);
});

test("an explicit model on the allowlist starts a child", async () => {
  const r = await callTool({ subagentModels: [ALLOWED] }, "subagent", { task: "x", model: ALLOWED }, [fauxAssistantMessage("child done")]);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /started subagent/);
});

test("leaving the model out inherits the parent's, which the allowlist does not gate (dsh: inheritance is no model-facing choice)", async () => {
  const r = await callTool({ subagentModels: ["faux/other"] }, "subagent", { task: "x" }, [fauxAssistantMessage("child done")]);
  assert.equal(r.isError, false, r.text);
});

test("a preset cannot smuggle in a model the allowlist excludes", async () => {
  const config = { subagentModels: ["faux/other"], subagentPresets: { cheap: { model: ALLOWED } } };
  const r = await callTool(config, "subagent", { task: "x", preset: "cheap" });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /allowlist/);
});

test("a workflow agent() asking for an excluded model ends the script", async () => {
  const script = `return await parallel([() => agent('x', { model: '${ALLOWED}' })]);`;
  const r = await callTool({ subagentModels: ["faux/other"] }, "workflow", { meta: { name: "it", description: "d" }, script });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /allowlist/);
});
