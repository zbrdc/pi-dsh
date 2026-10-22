import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, fauxAssistantMessage, fauxToolCall, scratchHome } from "./support/pi-session.ts";

// bubblewrap mounts a fresh tmpfs over /tmp, which would hide a /tmp workspace.
const sandboxable = existsSync("/usr/bin/bwrap") && !scratchHome.startsWith("/tmp/");

const runWorkflow = (script: string) => fauxAssistantMessage([fauxToolCall("workflow", { meta: { name: "it", description: "integration" }, script })]);

/** Faux child step that holds its request open and counts the abort that ends it. */
function holdUntilAborted(aborted: { count: number }) {
  return (_context: unknown, options: { signal?: AbortSignal } | undefined) => new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    const onAbort = () => { aborted.count++; resolve(fauxAssistantMessage("", { stopReason: "aborted" })); };
    if (options?.signal?.aborted) onAbort();
    else options?.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Faux step that records the newest tool result the model saw, then answers. */
function recordToolResult(into: { last?: any }) {
  return (context: { messages: any[] }) => {
    into.last = [...context.messages].reverse().find((m) => m.role === "toolResult");
    return fauxAssistantMessage("acknowledged");
  };
}

test("agents run through pipeline and come back as the script's return value", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const seen: { last?: any } = {};
  h.faux.setResponses([
    runWorkflow("return await pipeline(['x', 'y'], (item) => agent(`review ${item}`), (verdict) => `got: ${verdict}`);"),
    fauxAssistantMessage("verdict one"), fauxAssistantMessage("verdict two"),
    recordToolResult(seen),
  ]);
  await h.session.prompt("run the workflow");
  await h.settled();
  assert.notEqual(seen.last?.isError, true, JSON.stringify(seen.last));
  const text = JSON.stringify(seen.last?.content);
  assert.match(text, /completed \(2 agents\)/);
  assert.match(text, /got: verdict (one|two)/);
});

test("an unknown preset ends the script instead of becoming a null result", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const seen: { last?: any } = {};
  h.faux.setResponses([
    runWorkflow("return await parallel([() => agent('review', { preset: 'no-such-preset' })]);"),
    recordToolResult(seen),
  ]);
  await h.session.prompt("run the workflow");
  await h.settled();
  assert.equal(seen.last?.isError, true, JSON.stringify(seen.last));
  assert.match(JSON.stringify(seen.last?.content), /no-such-preset/);
  assert.equal(h.faux.state.callCount, 2, "a child ran for an invalid option");
});

test("a script that dies on a tripped cap stops the children it already started", async (t) => {
  const h = await createHarness({ config: { workflowMaxAgents: 2 } });
  t.after(() => h.dispose());
  const aborted = { count: 0 };
  const seen: { last?: any } = {};
  h.faux.setResponses([
    runWorkflow("return await parallel([() => agent('a'), () => agent('b'), () => agent('c')]);"),
    holdUntilAborted(aborted), holdUntilAborted(aborted),
    recordToolResult(seen),
  ]);
  await h.session.prompt("run the workflow");
  await h.settled();
  assert.equal(seen.last?.isError, true, JSON.stringify(seen.last));
  assert.match(JSON.stringify(seen.last?.content), /per-run cap/);
  assert.equal(aborted.count, 2, "children kept running after the script ended");
});

test("workflow scripts run under the standing sandbox mode", { skip: !sandboxable && "bubblewrap unavailable or scratch is under /tmp" }, async (t) => {
  const h = await createHarness({ config: { sandboxMode: "read-only" } });
  t.after(() => h.dispose());
  const target = join(h.cwd, "escaped.txt");
  const seen: { last?: any } = {};
  h.faux.setResponses([
    runWorkflow(`const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(target)}, 'free'); return 'wrote';`),
    recordToolResult(seen),
  ]);
  await h.session.prompt("run the workflow");
  await h.settled();
  assert.equal(seen.last?.isError, true, JSON.stringify(seen.last));
  assert.equal(existsSync(target), false, "the script wrote outside the sandbox");
});

test("without a sandbox mode a workflow script can use the filesystem", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const target = join(h.cwd, "allowed.txt");
  const seen: { last?: any } = {};
  h.faux.setResponses([
    runWorkflow(`const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(target)}, 'ok'); return 'wrote';`),
    recordToolResult(seen),
  ]);
  await h.session.prompt("run the workflow");
  await h.settled();
  assert.equal(readFileSync(target, "utf8"), "ok");
});
