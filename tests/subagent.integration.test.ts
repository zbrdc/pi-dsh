import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFauxModelRuntime, fauxAssistantMessage, fauxToolCall, scratchHome } from "./support/pi-session.ts";
import { git, makeRepo } from "./support/git-repo.ts";
import { SubagentManager, createSdkChild } from "../src/subagent.ts";
import type { ChildSandbox } from "../src/child-bash.ts";

const workspace = () => mkdtempSync(join(scratchHome, "child-ws-"));
// bubblewrap mounts a fresh tmpfs over /tmp, which would hide a /tmp workspace.
const sandboxable = existsSync("/usr/bin/bwrap") && !scratchHome.startsWith("/tmp/");

async function runChild(opts: { tools: string[]; sandbox?: ChildSandbox; script: any[]; cwd?: string; isolation?: "worktree"; worktreeRoot?: string }) {
  const { faux, modelRuntime } = await createFauxModelRuntime();
  const cwd = opts.cwd ?? workspace();
  const manager = new SubagentManager({
    maxActive: 2, maxDepth: 1, sandbox: opts.sandbox, worktreeRoot: opts.worktreeRoot,
    createChild: (childOpts) => createSdkChild(childOpts, { modelRuntime }),
  });
  faux.setResponses(opts.script);
  const id = await manager.start({
    provider: "spawn", label: "it-child", task: "do the work", owner: "root", cwd,
    model: faux.getModel(), delivery: "caller", tools: opts.tools, isolation: opts.isolation,
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

const writeShared = (content: string) => fauxAssistantMessage([fauxToolCall("bash", { command: `echo ${content} > shared.txt` })]);

test("isolated children write the same file without touching the parent checkout or each other", async () => {
  const { repo, root } = makeRepo();
  const first = await runChild({ cwd: repo, worktreeRoot: root, isolation: "worktree", tools: ["bash"], script: [writeShared("from-first"), fauxAssistantMessage("first done")] });
  const second = await runChild({ cwd: repo, worktreeRoot: root, isolation: "worktree", tools: ["bash"], script: [writeShared("from-second"), fauxAssistantMessage("second done")] });
  assert.equal(existsSync(join(repo, "shared.txt")), false, "the child wrote into the parent's checkout");
  assert.equal(git(repo, "status", "--porcelain"), "");
  const kept = [first, second].map((r) => r.manager.list("root")[0]!.worktree!);
  assert.notEqual(kept[0]!.path, kept[1]!.path);
  assert.equal(readFileSync(join(kept[0]!.path, "shared.txt"), "utf8").trim(), "from-first");
  assert.equal(readFileSync(join(kept[1]!.path, "shared.txt"), "utf8").trim(), "from-second");
  assert.match(first.result.text, /^\[worktree kept: .*1 uncommitted file/);
  assert.match(first.result.text, /first done$/);
});

test("an isolated child that changes nothing leaves no worktree behind", async () => {
  const { repo, root } = makeRepo();
  const { result, manager } = await runChild({ cwd: repo, worktreeRoot: root, isolation: "worktree", tools: ["read"], script: [fauxAssistantMessage("looked, changed nothing")] });
  const wt = manager.list("root")[0]!.worktree!;
  assert.equal(result.text, "looked, changed nothing");
  assert.equal(existsSync(wt.path), false);
  assert.equal(git(repo, "branch", "--list", wt.branch), "");
});

test("a failed child start removes the worktree it created", async () => {
  const { repo, root } = makeRepo();
  const manager = new SubagentManager({ maxActive: 1, maxDepth: 1, worktreeRoot: root, createChild: async () => { throw new Error("no model"); } });
  await assert.rejects(manager.start({ provider: "spawn", label: "x", task: "t", owner: "root", cwd: repo, delivery: "caller", isolation: "worktree" }), /no model/);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
  assert.equal(git(repo, "branch", "--list", "pi-dsh/*"), "");
});

test("isolation outside a git repository is refused before a child starts", async () => {
  const manager = new SubagentManager({ maxActive: 1, maxDepth: 1, createChild: async () => { throw new Error("must not start"); } });
  await assert.rejects(manager.start({ provider: "spawn", label: "x", task: "t", owner: "root", cwd: workspace(), delivery: "caller", isolation: "worktree" }), /needs a git repository/);
});

test("a sandboxed isolated child can edit its worktree but not commit into the shared .git", { skip: !sandboxable }, async () => {
  const { repo, root } = makeRepo();
  const seen: { last?: any } = {};
  const { manager } = await runChild({
    cwd: repo, worktreeRoot: root, isolation: "worktree", tools: ["bash"], sandbox: { mode: "workspace-write" },
    script: [
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo edit > edited.txt && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm child" })]),
      recordToolResult(seen),
    ],
  });
  const wt = manager.list("root")[0]!.worktree!;
  assert.equal(readFileSync(join(wt.path, "edited.txt"), "utf8").trim(), "edit");
  assert.equal(seen.last?.isError, true, "the commit unexpectedly succeeded; the README note about commits is stale");
  assert.equal(git(repo, "rev-list", "--count", `${wt.base}..${wt.branch}`), "0");
});
