import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFauxModelRuntime, fauxAssistantMessage, fauxToolCall, scratchHome } from "./support/pi-session.ts";
import { SubagentManager, createSdkChild } from "../src/subagent.ts";
import type { ChildSandbox } from "../src/child-bash.ts";

const workspace = () => mkdtempSync(join(scratchHome, "child-ws-"));
// bubblewrap mounts a fresh tmpfs over /tmp, which would hide a /tmp workspace.
const sandboxable = existsSync("/usr/bin/bwrap") && !scratchHome.startsWith("/tmp/");

async function runChild(opts: { tools: string[]; sandbox?: ChildSandbox; script: any[]; cwd?: string }) {
  const { faux, modelRuntime } = await createFauxModelRuntime();
  const cwd = opts.cwd ?? workspace();
  const manager = new SubagentManager({
    maxActive: 2, maxDepth: 1, sandbox: opts.sandbox,
    createChild: (childOpts) => createSdkChild(childOpts, { modelRuntime }),
  });
  faux.setResponses(opts.script);
  const id = await manager.start({
    provider: "spawn", label: "it-child", task: "do the work", owner: "root", cwd,
    model: faux.getModel(), delivery: "caller", tools: opts.tools,
  });
  const result = await manager.wait(id);
  return { faux, cwd, result, manager };
}

/** Faux step that records the newest tool result the child saw, then answers. */
function recordToolResult(into: { last?: any }, answer = "done") {
  return (context: { messages: any[] }) => {
    into.last = [...context.messages].reverse().find((m) => m.role === "toolResult");
    return fauxAssistantMessage(answer);
  };
}

test("structured_output ends the child run through the tool result, not an abort", async () => {
  const { faux, result } = await runChild({
    tools: ["read", "structured_output"],
    script: [
      fauxAssistantMessage([fauxToolCall("structured_output", { result: { answer: 42 } })]),
      fauxAssistantMessage("a second request must never be made"),
    ],
  });
  assert.equal(result.status, "completed");
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(result.data, { answer: 42 });
  assert.equal(faux.state.callCount, 1);
  assert.equal(faux.getPendingResponseCount(), 1);
});

test("structured_output beside another tool still closes the run", async () => {
  const { faux, result } = await runChild({
    tools: ["read", "structured_output"],
    script: [
      fauxAssistantMessage([
        fauxToolCall("read", { path: "/definitely/not/here" }),
        fauxToolCall("structured_output", { result: { answer: 7 } }),
      ]),
      fauxAssistantMessage("a second request must never be made"),
    ],
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.data, { answer: 7 });
  assert.equal(faux.state.callCount, 1);
});

test("a read-only sandbox confines the child's bash", { skip: !sandboxable }, async () => {
  const cwd = workspace();
  const escape = join(cwd, "escape.txt");
  const seen: { last?: any } = {};
  const { result } = await runChild({
    cwd, tools: ["bash"], sandbox: { mode: "read-only" },
    script: [fauxAssistantMessage([fauxToolCall("bash", { command: `echo escaped > ${escape}` })]), recordToolResult(seen)],
  });
  assert.equal(result.status, "completed");
  assert.equal(existsSync(escape), false, "child wrote to a read-only workspace");
  assert.equal(seen.last?.isError, true);
});

test("a sandboxed child's bash still runs ordinary commands", { skip: !sandboxable }, async () => {
  const seen: { last?: any } = {};
  await runChild({
    tools: ["bash"], sandbox: { mode: "read-only" },
    script: [fauxAssistantMessage([fauxToolCall("bash", { command: "echo sandbox-ok" })]), recordToolResult(seen)],
  });
  assert.equal(seen.last?.isError, false);
  assert.match(JSON.stringify(seen.last?.content), /sandbox-ok/);
});

test("workspace-write lets the child write inside its workspace only", { skip: !sandboxable }, async () => {
  const cwd = workspace();
  const inside = join(cwd, "inside.txt");
  const seen: { last?: any } = {};
  await runChild({
    cwd, tools: ["bash"], sandbox: { mode: "workspace-write" },
    script: [fauxAssistantMessage([fauxToolCall("bash", { command: "echo in > inside.txt" })]), recordToolResult(seen)],
  });
  assert.equal(readFileSync(inside, "utf8").trim(), "in");
});

test("without a sandbox the child keeps pi's stock bash", { skip: !existsSync("/bin/sh") }, async () => {
  const cwd = workspace();
  const file = join(cwd, "stock.txt");
  await runChild({
    cwd, tools: ["bash"],
    script: [fauxAssistantMessage([fauxToolCall("bash", { command: `echo stock > ${file}` })]), fauxAssistantMessage("done")],
  });
  assert.equal(readFileSync(file, "utf8").trim(), "stock");
});
