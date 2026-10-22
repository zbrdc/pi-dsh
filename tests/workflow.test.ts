import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FATAL_MARKER, WorkflowError, createWorkflow, runWorkflowScript } from "../src/workflow-guest.mjs";
import { DEFAULT_WORKFLOW_LIMITS, workflowLimitsFrom, workflowProgram, workflowSyncTimeoutFrom } from "../src/workflow.ts";
import { NodePtcProvider } from "../src/ptc.ts";

const limits = { maxTotalAgents: 5, maxItemsPerCall: 3 };
const quietHost = (agent: (spec: any) => Promise<unknown> = async (spec) => `ran ${spec.task}`) =>
  ({ agent, phase: () => null, log: () => null });
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

test("pipeline moves each item through its stages without waiting for the others", async () => {
  const wf = createWorkflow(quietHost(), limits);
  const slowFirstStage = deferred();
  const order: string[] = [];
  const done = wf.pipeline(["slow", "fast"],
    async (item: string) => { if (item === "slow") await slowFirstStage.promise; order.push(`${item}:1`); return item; },
    async (item: string) => { order.push(`${item}:2`); return item; });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["fast:1", "fast:2"], "the fast item waited at a stage barrier");
  slowFirstStage.resolve();
  assert.deepEqual(await done, ["slow", "fast"]);
});

test("a pipeline stage receives the running value, the original item and the index", async () => {
  const wf = createWorkflow(quietHost(), limits);
  const seen: unknown[][] = [];
  await wf.pipeline(["a", "b"],
    (value: string) => `${value}!`,
    (value: string, item: string, index: number) => { seen.push([value, item, index]); return value; });
  assert.deepEqual(seen, [["a!", "a", 0], ["b!", "b", 1]]);
});

test("an ordinary error nulls one item and the rest still finish", async () => {
  const wf = createWorkflow(quietHost(), limits);
  assert.deepEqual(await wf.parallel([() => 1, () => { throw new Error("one item broke"); }, async () => 3]), [1, null, 3]);
  assert.deepEqual(await wf.pipeline([1, 2], (n: number) => { if (n === 1) throw new Error("bad"); return n; }), [null, 2]);
});

test("a fatal error ends parallel and pipeline instead of becoming null", async () => {
  const wf = createWorkflow(quietHost(), limits);
  const fatal = new WorkflowError("typo'd option", "INVALID_ARGUMENT");
  await assert.rejects(() => wf.parallel([() => 1, () => { throw fatal; }]), (e: any) => e === fatal);
  await assert.rejects(() => wf.pipeline([1], () => { throw fatal; }), (e: any) => e === fatal);
});

test("the total agent cap is fatal even when agent() runs inside parallel", async () => {
  const wf = createWorkflow(quietHost(), { maxTotalAgents: 2, maxItemsPerCall: 10 });
  await wf.agent("one");
  await wf.agent("two");
  await assert.rejects(() => wf.agent("three"), (e: any) => e instanceof WorkflowError && e.code === "AGENT_CAP");
  await assert.rejects(() => wf.parallel([() => wf.agent("four")]), (e: any) => e.code === "AGENT_CAP");
});

test("an error the host marks fatal arrives as a WorkflowError", async () => {
  const wf = createWorkflow(quietHost(async () => { throw new Error(`${FATAL_MARKER}unknown preset "x"`); }), limits);
  await assert.rejects(() => wf.parallel([() => wf.agent("task", { preset: "x" })]),
    (e: any) => e instanceof WorkflowError && e.message === 'unknown preset "x"');
});

test("an unmarked host error stays an ordinary error and nulls its item", async () => {
  const wf = createWorkflow(quietHost(async () => { throw new Error("child crashed"); }), limits);
  assert.deepEqual(await wf.parallel([() => wf.agent("task")]), [null]);
});

test("bad arguments are rejected loudly", async () => {
  const wf = createWorkflow(quietHost(), limits);
  const invalid = (e: any) => e instanceof WorkflowError && e.code === "INVALID_ARGUMENT";
  await assert.rejects(() => wf.parallel("nope" as any), invalid);
  await assert.rejects(() => wf.parallel([Promise.resolve(1)] as any), invalid, "promises are not thunks");
  await assert.rejects(() => wf.pipeline("nope" as any, () => 1), invalid);
  await assert.rejects(() => wf.pipeline([1]), invalid, "a pipeline needs a stage");
  await assert.rejects(() => wf.pipeline([1], "x" as any), invalid);
  await assert.rejects(() => wf.agent(""), invalid);
  await assert.rejects(() => wf.agent({ nothing: true } as any), invalid);
  assert.throws(() => wf.phase(""), invalid);
  assert.throws(() => wf.log(42 as any), invalid);
});

test("one call over the item cap is fatal", async () => {
  const wf = createWorkflow(quietHost(), limits);
  const items = Array.from({ length: 4 }, (_, i) => i);
  await assert.rejects(() => wf.pipeline(items, (n: number) => n), (e: any) => e.code === "ITEM_CAP");
  await assert.rejects(() => wf.parallel(items.map(() => () => 1)), (e: any) => e.code === "ITEM_CAP");
});

test("agent() passes a prompt string and options through as one spec", async () => {
  const specs: any[] = [];
  const wf = createWorkflow(quietHost(async (spec) => { specs.push(spec); return "ok"; }), limits);
  await wf.agent("review it", { label: "r" });
  await wf.agent({ prompt: "second", preset: "p" });
  assert.deepEqual(specs.map((s) => [s.task, s.label, s.preset]), [["review it", "r", undefined], ["second", undefined, "p"]]);
});

test("limits fall back to the defaults unless they are positive integers", () => {
  assert.deepEqual(workflowLimitsFrom({}), DEFAULT_WORKFLOW_LIMITS);
  assert.deepEqual(workflowLimitsFrom({ maxTotalAgents: 7, maxItemsPerCall: 0 }), { maxTotalAgents: 7, maxItemsPerCall: DEFAULT_WORKFLOW_LIMITS.maxItemsPerCall });
  assert.equal(workflowLimitsFrom({ maxTotalAgents: 1.5 }).maxTotalAgents, DEFAULT_WORKFLOW_LIMITS.maxTotalAgents);
});

// The program must load the guest module inside the real PTC child, with and without bubblewrap.
const runScript = (script: string, extra: Record<string, unknown> = {}, syncTimeoutMs = 5000) => {
  const calls: string[] = [];
  const wf = {
    agent: async (a: any) => { calls.push(a.task); return `done ${a.task}`; },
    phase: async () => null, log: async () => null,
  };
  return new NodePtcProvider().run({
    program: workflowProgram(script, { name: "t", description: "d" }, { n: 2 }, DEFAULT_WORKFLOW_LIMITS, syncTimeoutMs),
    bindings: { _wf: wf }, timeoutMs: 20_000, ...extra,
  }).then((result) => ({ result, calls }));
};

test("a workflow program gives scripts meta, args and working hooks in the child process", async () => {
  const { result, calls } = await runScript("phase('go'); return await pipeline(['a','b'], (x) => agent(x), (r) => `${meta.name}:${args.n}:${r}`);");
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(result.value, ["t:2:done a", "t:2:done b"]);
  assert.deepEqual(calls.sort(), ["a", "b"]);
});

test("script logs reach the result through the capturing console", async () => {
  const { result } = await runScript("console.log('from the script'); return 1;");
  assert.deepEqual(result.logs, ["from the script"]);
});

test("a fatal workflow error fails the run with its own message", async () => {
  const { result } = await runScript("return await parallel([() => agent('')]);");
  assert.equal(result.error?.kind, "exception");
  assert.match(result.error?.message ?? "", /non-empty prompt/);
});

test("a syntax error in the script is reported, not swallowed", async () => {
  const { result } = await runScript("return (;");
  assert.equal(result.error?.kind, "exception");
  assert.match(result.error?.message ?? "", /Unexpected|SyntaxError/);
});

test("a script stuck in a loop with no await ends at the synchronous timeout", async () => {
  const started = Date.now();
  const { result } = await runScript("while (true) {}", {}, 300);
  assert.equal(result.error?.kind, "exception", JSON.stringify(result));
  assert.match(result.error?.message ?? "", /without reaching an await/);
  assert.ok(Date.now() - started < 10_000);
});

test("the synchronous timeout stops after the first await, so a slow awaited script is not cut off", async () => {
  const { result } = await runScript("await new Promise((r) => setTimeout(r, 700)); return 'finished';", {}, 300);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.value, "finished");
});

test("runWorkflowScript raises a WorkflowError for the timeout", async () => {
  const host = quietHost();
  await assert.rejects(
    () => runWorkflowScript({ source: "for (;;) {}", meta: {}, args: {}, host, limits, syncTimeoutMs: 200, console }),
    (e: any) => e instanceof WorkflowError && e.code === "SYNC_TIMEOUT",
  );
});

test("the synchronous timeout falls back to dsh's 5000 ms unless it is a positive integer", () => {
  assert.equal(workflowSyncTimeoutFrom(undefined), 5000);
  assert.equal(workflowSyncTimeoutFrom(0), 5000);
  assert.equal(workflowSyncTimeoutFrom(250), 250);
});

const scratch = mkdtempSync(join(tmpdir(), "pi-dsh-wf-"));
const sandboxable = existsSync("/usr/bin/bwrap") && !scratch.startsWith("/tmp/");
test("the program also runs under a read-only sandbox", { skip: !sandboxable && "bubblewrap unavailable or scratch is under /tmp" }, async () => {
  const { result } = await runScript("return await parallel([() => agent('x')]);", { cwd: scratch, sandboxMode: "read-only" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(result.value, ["done x"]);
});
