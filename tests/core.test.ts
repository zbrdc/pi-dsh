import test from "node:test";
import assert from "node:assert/strict";
import { validateRules, MAX_RULES, MAX_RULE_CHARS, validateTodos, RepeatTracker, spillText, pruneText, assertLosslessJson, OutputRing, newGoal, applyBlocker, generateSdk, canonical, normalizeStructured, captureStructuredSubmission, renderTaskControlSection, jsonSchemaToTs, Semaphore, completedTurnCut, bwrapArgs, resolveToolTimeoutMs, timeoutFieldCaps, fuseSignal, ToolWatchdog, tmuxSessionName, tmuxSendKeysChunks, parseOutputSchema, modelRouteAllowed, roundFenceFailure, roundKey } from "../src/core.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { JobRegistry } from "../src/jobs.ts";
import { capLines, layoutColumns, renderAgentsWidget, renderDashboard, renderJobsWidget, renderStatusLine, renderTodoWidget } from "../src/ui.ts";
import { TerminalRegistry, tmuxAvailable } from "../src/terminal.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodePtcProvider, MossbedProvider } from "../src/ptc.ts";
import { buildChildPrompt, structuredToolParameters, SubagentManager } from "../src/subagent.ts";
import { TeamBoard, scopesOverlap } from "../src/team.ts";

test("todo validation", () => {
  assert.equal(validateTodos([{ content: "a", status: "pending" }], true).length, 1);
  assert.throws(() => validateTodos([{ content: "", status: "pending" }], true), /empty/);
  assert.throws(() => validateTodos([{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }], false), /only one/);
  assert.throws(() => validateTodos([{ content: "a", status: "pending" }, { content: "a", status: "pending" }], true), /duplicate/);
});

test("repeat tracker fires at 3/5/8 only for consecutive identical calls", () => {
  const r = new RepeatTracker([3, 5, 8]);
  assert.equal(r.observe("bash", { a: 1 }), undefined);
  assert.equal(r.observe("bash", { a: 1 }), undefined);
  assert.ok(r.observe("bash", { a: 1 })?.includes("3 times"));
  assert.equal(r.observe("bash", { a: 2 }), undefined);
  assert.ok(r.observe("bash", { a: 2 }) === undefined);
});

test("spill keeps small text, spills large with locator", () => {
  assert.equal(spillText("hi", 100, "/tmp/x").spilled, false);
  const s = spillText("x".repeat(100_000), 1000, "/tmp/x.txt");
  assert.equal(s.spilled, true);
  assert.ok(s.text.includes("/tmp/x.txt"));
  assert.ok(s.text.length <= 4100);
});

test("prune bounds length", () => {
  assert.ok(pruneText("y".repeat(50_000), 8000).length <= 8000);
});

test("lossless json", () => {
  assertLosslessJson({ a: [1, "x", null] });
  assert.throws(() => assertLosslessJson({ a: undefined }), /undefined/);
  assert.throws(() => assertLosslessJson(NaN), /non-finite/);
  const cyc: any = {}; cyc.self = cyc;
  assert.throws(() => assertLosslessJson(cyc), /cyclic/);
});

test("goal blocker needs 3 consecutive", () => {
  let g = newGoal("g1", "do it");
  g = applyBlocker(g, "no network"); assert.equal(g.status, "active");
  g = applyBlocker(g, "different"); assert.equal(g.status, "active"); assert.equal(g.blockerRounds, 1);
  g = applyBlocker(g, "different"); g = applyBlocker(g, "different");
  assert.equal(g.status, "blocked");
});

test("jobs: foreground wait, exactly-once result, owner isolation", async () => {
  const jobs = new JobRegistry();
  jobs.start({ kind: "bash", label: "t", owner: "s1", run: async (h) => { h.append("out\n"); return { result: "final" }; } });
  const list = jobs.list("s1"); assert.equal(list.length, 1);
  const id = (list[0] as { id: string }).id;
  const r1 = await jobs.output(id, "s1", { wait: true });
  assert.ok(r1.text.includes("final"));
  const r2 = await jobs.output(id, "s1");
  assert.ok(!r2.text.includes("final"), "result delivered exactly once");
  await assert.rejects(() => jobs.output(id, "other"), /unknown job/);
});

test("jobs: kill settles as killed", async () => {
  const jobs = new JobRegistry();
  const id = jobs.start({ kind: "bash", label: "sleep", owner: "s1", run: async (h) => {
    await new Promise<void>((res) => { h.signal.addEventListener("abort", () => res(), { once: true }); setTimeout(res, 10_000); });
  } });
  const r = await jobs.kill(id, "s1");
  assert.equal(r.job.status, "killed");
});

test("ptc node: bindings round-trip and errors", async () => {
  const ptc = new NodePtcProvider();
  const r = await ptc.run({ program: "const v = await tools.add({a:2,b:3}); console.log('hi'); return v;", bindings: { tools: { add: async (a: any) => a.a + a.b } } });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.value, 5);
  assert.deepEqual(r.logs, ["hi"]);
  const bad = await ptc.run({ program: "throw new Error('boom')" });
  assert.equal(bad.error?.kind, "exception");
  const lossy = await ptc.run({ program: "return () => 1;" });
  assert.ok(!lossy.error || lossy.error.kind === "invalid-output" || lossy.error.kind === "protocol", JSON.stringify(lossy));
  const slow = await ptc.run({ program: "while(true){}", timeoutMs: 500 });
  assert.equal(slow.error?.kind, "timeout");
});

test("ptc persistent owner retains globals", async () => {
  const ptc = new NodePtcProvider();
  await ptc.run({ program: "globalThis.keep = 41;", stateOwner: "owner1" });
  const r = await ptc.run({ program: "return globalThis.keep + 1;", stateOwner: "owner1" });
  assert.equal(r.value, 42, JSON.stringify(r));
  ptc.release("owner1");
});

test("mossbed bridge round-trips a host tool call", async () => {
  const m = new MossbedProvider();
  if (!m.available()) return;
  const r = await m.run({ program: "return await tools.add({a: 19, b: 23});", bindings: { tools: { add: async (a: any) => a.a + a.b } }, timeoutMs: 30000 });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.value, 42);
});

test("sdk generation and canonical stability", () => {
  assert.ok(generateSdk([{ name: "read", description: "Read a file" }]).includes("read(args: any)"));
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
});

test("output ring dropped accounting", () => {
  const ring = new OutputRing(100);
  ring.append("x".repeat(300));
  assert.ok(ring.dropped > 0);
  assert.ok(ring.all().length <= 100);
});

test("structured normalization parses stringified JSON (auditor regression)", () => {
  assert.deepEqual(normalizeStructured('{"gaps": "", "verdict": "accept"}'), { gaps: "", verdict: "accept" });
  assert.equal(normalizeStructured("plain text"), "plain text");
  assert.deepEqual(normalizeStructured({ verdict: "reject" }), { verdict: "reject" });
});

test("sdk types are exact, semaphore caps at N in FIFO order", async () => {
  const ts = jsonSchemaToTs({ type: "object", properties: { path: { type: "string" }, limit: { type: "number" } }, required: ["path"] });
  assert.equal(ts, "{ path: string; limit?: number }");
  const sdk = generateSdk([{ name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }]);
  assert.ok(sdk.includes("read(args: { path: string })"));
  const sem = new Semaphore(2); let peak = 0; let cur = 0; const order: number[] = [];
  await Promise.all([0,1,2,3].map((i) => sem.run(async () => { order.push(i); cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 10)); cur--; })));
  assert.equal(peak, 2); assert.deepEqual(order.slice(0, 2), [0, 1]);
});

test("fork cut and bwrap args", () => {
  const msgs: any[] = [ { role: "user" }, { role: "assistant", stopReason: "toolUse" }, { role: "toolResult" }, { role: "assistant", stopReason: "stop" }, { role: "user" }, { role: "assistant", stopReason: "toolUse" } ];
  assert.equal(completedTurnCut(msgs), 4);
  assert.equal(completedTurnCut([{ role: "user" }]), 0);
  assert.ok(bwrapArgs("workspace-write", "/w").join(" ").includes("--bind /w /w"));
  assert.deepEqual(bwrapArgs("danger-full-access", "/w"), []);
});

test("bwrap mounts the root first and layers /proc, /dev and /tmp over it, with the workspace last", () => {
  for (const mode of ["read-only", "workspace-write"] as const) {
    const args = bwrapArgs(mode, "/w");
    const at = (flag: string, value?: string) => args.findIndex((a, i) => a === flag && (value === undefined || args[i + 1] === value));
    assert.ok(at("--ro-bind", "/") < at("--proc") && at("--proc") < at("--dev"), "a mount placed before the root bind is covered by it");
    assert.ok(at("--dev") < at("--tmpfs"), "tmpfs after dev");
    assert.ok(at("--tmpfs") < args.indexOf("/w"), "the workspace is bound after /tmp so a workspace under /tmp stays visible");
    assert.equal(args[args.indexOf("/w") - 1], mode === "workspace-write" ? "--bind" : "--ro-bind");
    assert.deepEqual(args.slice(-3), ["--chdir", "/w", "--"]);
  }
});

test("ptc persistent retains let/const across await evaluations", async () => {
  const ptc = new NodePtcProvider();
  const b = { tools: { add: async (a: any) => a.a + a.b } };
  const r1 = await ptc.run({ program: "let base = await tools.add({a: 40, b: 1}); const tag = 'kept';", bindings: b, stateOwner: "repl1" });
  assert.equal(r1.error, undefined, JSON.stringify(r1));
  const r2 = await ptc.run({ program: "return base + 1;", stateOwner: "repl1" });
  assert.equal(r2.value, 42, JSON.stringify(r2));
  const r3 = await ptc.run({ program: "return tag;", stateOwner: "repl1" });
  assert.equal(r3.value, "kept", JSON.stringify(r3));
  const r4 = await ptc.run({ program: "const dup = await Promise.resolve(1);", bindings: b, stateOwner: "repl1" });
  assert.equal(r4.error, undefined, JSON.stringify(r4));
  const r5 = await ptc.run({ program: "const dup = await Promise.resolve(2);", bindings: b, stateOwner: "repl1" });
  assert.ok(r5.error, "redeclaring const must fail");
  ptc.release("repl1");
});

test("jobs durability: fresh registry restores settled and crashed jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidsh-test-"));
  const j1 = new JobRegistry(); j1.setPersistRoot(root);
  const outF = join(root, "o.txt"); const exitF = join(root, "o.exit");
  const id = j1.start({ kind: "bash", label: "d", owner: "s", durable: { outFile: outF, exitFile: exitF }, run: async (h) => { h.append("kept\n"); writeFileSync(outF, "kept\n"); writeFileSync(exitF, "0"); } });
  await j1.output(id, "s", { wait: true });
  const j2 = new JobRegistry(); j2.setPersistRoot(root); j2.restore("s");
  const r = await j2.output(id, "s");
  assert.equal(r.job.status, "completed");
  assert.ok(r.text.includes("kept"));
});

test("structured capture preserves sibling audit verdict (drift regression)", () => {
  const captured = captureStructuredSubmission({
    result: '{"file_checked":"doc.txt","matches_claim":true}',
    verdict: "accept",
    gaps: "",
    summary: "verified",
  }) as any;
  assert.equal(captured.verdict, "accept");
  assert.equal(captured.matches_claim, true);
  assert.equal(captured.gaps, "");
});

test("standing control section renders rules and current task state", () => {
  const section = renderTaskControlSection({
    goal: { id: "g1", revision: 4, objective: "Ship the bounded fix", status: "active", roundsStarted: 2, maxGoalRounds: 12, blockerRounds: 0, armed: true },
    todos: [
      { content: "Inspect the failing path", status: "completed" },
      { content: "Patch the capture schema", status: "in_progress" },
      { content: "Run verification", status: "pending" },
    ],
    planActive: false,
  });
  assert.ok(section.includes("Ship the bounded fix"));
  assert.ok(section.includes("Patch the capture schema"));
  assert.ok(section.includes("Run verification"));
  assert.ok(!section.includes("Inspect the failing path"), "completed todos stay out of the live control surface");
  assert.ok(section.includes("[exit code: N]"));
  assert.ok(section.includes("read it before editing"));
});

test("child prompt and schema-led structured parameters are explicit", () => {
  const prompt = buildChildPrompt({ requireStructured: true, systemAppend: "Audit only." });
  assert.ok(prompt.includes("Audit only."));
  assert.ok(prompt.includes("delegated pi-dsh subagent"));
  assert.ok(prompt.includes("read it before editing"));
  assert.ok(prompt.includes("structured_output"));
  assert.ok(prompt.includes("Do not finish with a plain text answer"));
  const audit = { type: "object", properties: { verdict: { type: "string", enum: ["accept", "reject"] }, gaps: { type: "string" } }, required: ["verdict", "gaps"] };
  assert.deepEqual(structuredToolParameters(audit), audit);
});

test("tool timeout resolution, input caps, fused signal, watchdog", async () => {
  assert.equal(resolveToolTimeoutMs("web_fetch", { toolTimeoutMs: { web_fetch: 30_000 } }), 30_000);
  assert.equal(resolveToolTimeoutMs("read", { toolTimeoutMs: { web_fetch: 30_000 } }), undefined);
  assert.equal(resolveToolTimeoutMs("read", { defaultToolTimeoutMs: 5_000 }), 5_000);
  assert.equal(resolveToolTimeoutMs("read", { defaultToolTimeoutMs: 0 }), undefined);
  assert.deepEqual(timeoutFieldCaps({ timeout: 9999, timeout_ms: 999_999, keep: 1 }), [
    { field: "timeout", capped: 600 }, { field: "timeout_ms", capped: 600_000 },
  ]);
  assert.deepEqual(timeoutFieldCaps({ timeout: 10 }), []);
  const fused = fuseSignal(undefined, 5) as AbortSignal;
  assert.equal(fused.aborted, false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fused.aborted, true);
  const wd = new ToolWatchdog();
  let fired: string | undefined;
  wd.arm("call-1", "web_fetch", 5, (name) => { fired = name; });
  wd.arm("call-2", "read", 60_000, () => undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, "web_fetch");
  assert.deepEqual(wd.settle("call-1"), { toolName: "web_fetch", timeoutMs: 5 });
  assert.equal(wd.settle("call-2"), undefined);
  assert.equal(wd.active, 0);
});

test("tmux naming and send-keys chunks", () => {
  assert.equal(tmuxSessionName("owner/with:chars", 3), "pidsh-owner_with_chars-3");
  assert.deepEqual(tmuxSendKeysChunks("echo hi\n"), [{ literal: "echo hi" }, { enter: true }]);
  assert.deepEqual(tmuxSendKeysChunks("echo hi\r"), [{ literal: "echo hi" }, { enter: true }]);
  assert.deepEqual(tmuxSendKeysChunks("a\nb"), [{ literal: "a" }, { enter: true }, { literal: "b" }]);
  assert.deepEqual(tmuxSendKeysChunks("no-newline"), [{ literal: "no-newline" }]);
});

test("ui widgets render bounded goal/todo/jobs/agents state", () => {
  const now = Date.now();
  const state = {
    goal: newGoal("g1", "Ship it", 10), planActive: true,
    todos: [
      { content: "done thing", status: "completed" as const },
      { content: "live thing", status: "in_progress" as const },
    ],
    jobs: [{ id: "bash-1", kind: "bash", label: "sleep", status: "running" as const, startedAt: now - 5000 }],
    agents: [{ childId: "c1", provider: "spawn", label: "audit", owner: "o", parentId: "o", depth: 1, role: "child" as const, continuable: true, toolCalls: 0, turns: 0, cwd: "/tmp", createdAt: now, status: "live" as const }],
    terminals: [{ id: "term-1", label: "bash", alive: true, backend: "tmux" }],
    teamTasks: [{ id: "task-1", subject: "Review", status: "pending" }],
  };
  assert.match(renderStatusLine(state), /plan/);
  assert.match(renderStatusLine(state), /1 job/);
  assert.match(renderTodoWidget(state.todos)!.join("\n"), /Todos 1\/2/);
  assert.match(renderJobsWidget(state.jobs, 6, now)!.join("\n"), /bash-1/);
  const agents = renderAgentsWidget(state)!.join("\n");
  assert.match(agents, /c1/); assert.match(agents, /term-1/); assert.match(agents, /task-1/);
  assert.match(renderDashboard(state, now), /Plan mode: ACTIVE/);
  assert.deepEqual(capLines(["a", "b", "c", "d"], 3), ["a", "b", "… +2 more"]);
  assert.equal(renderTodoWidget([]), undefined);
  assert.equal(renderJobsWidget([]), undefined);
});

test("layoutColumns places sections side by side and stacks when narrow", () => {
  const sections = [["G1", "G2"], ["T1"], ["J1", "J2", "J3"]];
  const wide = layoutColumns(sections, 120);
  assert.equal(wide.length, 3);
  assert.match(wide[0], /G1 +T1 +J1/);
  assert.match(wide[2], /^ {2,}J3$/);
  assert.ok(wide.every((l) => l.length <= 120));
  const narrow = layoutColumns(sections, 40);
  assert.deepEqual(narrow.map((l) => l.trim()), ["G1", "G2", "T1", "J1", "J2", "J3"]);
  const four = layoutColumns([["a"], ["b"], ["c"], ["d"]], 100);
  assert.deepEqual(four.map((l) => l.trim().split(/ +/)), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(layoutColumns([], 80), []);
});

test("layoutColumns truncates cells to the column width, wide characters included", () => {
  const lines = layoutColumns([["🤖 " + "x".repeat(80)], ["y".repeat(80)]], 70);
  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0]) <= 70);
  assert.match(lines[0], /…/);
  const short = layoutColumns([["x".repeat(20)], ["y".repeat(20)], ["z".repeat(90)]], 100);
  assert.ok(short[0].includes("x".repeat(20)) && short[0].includes("y".repeat(20)), "short columns keep full width");
  assert.ok(visibleWidth(short[0]) <= 100);
});

test("validateRules trims, deduplicates, and bounds the standing-rules list", () => {
  assert.deepEqual(validateRules(["  Never push to main ", "Never push to main", "Use tabs"]), ["Never push to main", "Use tabs"]);
  assert.deepEqual(validateRules([]), []);
  assert.throws(() => validateRules("rule"), /array/);
  assert.throws(() => validateRules([42]), /string/);
  assert.throws(() => validateRules(["ok", "   "]), /empty/);
  assert.throws(() => validateRules(["x".repeat(MAX_RULE_CHARS + 1)]), /exceeds/);
  assert.throws(() => validateRules(Array.from({ length: MAX_RULES + 1 }, (_, i) => `rule ${i}`)), /at most/);
});

test("control section carries standing rules and the instruction to record them", () => {
  const withRules = renderTaskControlSection({ todos: [], planActive: false, rules: ["Never run reviewers during a window", "Commit every green slice"] });
  assert.match(withRules, /Standing rules \(obey until the user lifts them\):\n- Never run reviewers during a window\n- Commit every green slice/);
  assert.match(withRules, /rules_write/);
  assert.doesNotMatch(renderTaskControlSection({ todos: [], planActive: false }), /Standing rules/);
});

test("terminal restore: dead session becomes readable exited stub", () => {
  const root = mkdtempSync(join(tmpdir(), "pidsh-term-"));
  const dir = join(root, "owner1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "term-7.json"), JSON.stringify({ id: "term-7", owner: "owner1", label: "bash", backend: "node-pty", cwd: "/tmp", shell: "bash", durable: false, createdAt: 1 }), "utf8");
  writeFileSync(join(dir, "term-7.log"), "hello from before\n", "utf8");
  const reg = new TerminalRegistry();
  reg.setPersistRoot(root);
  reg.restore("owner1");
  const rows = reg.list("owner1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.alive, false);
  const out = reg.get("owner1", "term-7").ring.readNew();
  assert.match(out, /hello from before/);
  assert.match(out, /transcript preserved/);
  assert.throws(() => reg.send("owner1", "term-7", "x"), /exited/);
});

test("durable tmux terminal survives dispose and reattaches on restore", async () => {
  if (!tmuxAvailable()) return; // backend unavailable on this host
  const root = mkdtempSync(join(tmpdir(), "pidsh-tmux-"));
  const owner = `test-${Date.now()}`;
  const reg = new TerminalRegistry();
  reg.setPersistRoot(root);
  const s = await reg.open(owner, { cwd: "/tmp", durable: true });
  try {
    assert.equal(s.backend, "tmux");
    reg.send(owner, s.id, "echo PIDSH_TMUX_OK");
    let seen = "";
    for (let i = 0; i < 40 && !seen.includes("PIDSH_TMUX_OK"); i++) {
      await new Promise((r) => setTimeout(r, 150));
      seen += s.ring.readNew();
    }
    assert.match(seen, /PIDSH_TMUX_OK/);
    await reg.disposeOwner(owner, { keepDurable: true });
    const reg2 = new TerminalRegistry();
    reg2.setPersistRoot(root);
    reg2.restore(owner);
    const back = reg2.get(owner, s.id);
    assert.equal(back.alive, true);
    assert.match(back.ring.readNew(), /reattached after restart/);
    await reg2.close(owner, s.id);
    assert.equal(reg2.list(owner).length, 0);
  } finally {
    await reg.disposeOwner(owner).catch(() => undefined);
  }
});

test("team board: CAS, dependency readiness, claim lifecycle, overlap warnings", async () => {
  const board = new TeamBoard(8);
  let changes = 0;
  board.onChange = () => { changes++; };
  const a = board.create("lead", { subject: "Build API", writeScopes: ["src/api"] });
  const b = board.create("lead", { subject: "Wire UI", blockedBy: [a.id], writeScopes: ["src/api/client.ts"] });
  assert.equal(a.ready, true);
  assert.equal(b.ready, false);
  assert.throws(() => board.update("rev", false, { taskId: b.id, expectedRevision: 1, action: "claim" }), /blocked by incomplete/);
  assert.throws(() => board.update("rev", false, { taskId: a.id, expectedRevision: 9, action: "claim" }), /TEAM_TASK_STALE_REVISION/);
  const claimed = board.update("rev", false, { taskId: a.id, expectedRevision: 1, action: "claim" });
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.owner, "rev");
  assert.throws(() => board.update("other", false, { taskId: a.id, expectedRevision: 2, action: "complete" }), /only its owner or the lead/);
  board.update("rev", false, { taskId: a.id, expectedRevision: 2, action: "complete" });
  assert.equal(board.get(b.id).ready, true);
  const waitChanged = board.waitForChange(5000);
  const claimedB = board.update("ui", false, { taskId: b.id, expectedRevision: 1, action: "claim" });
  assert.equal(await waitChanged, true);
  // Overlap: another in-progress task touching src/api warns on both views.
  const c = board.create("lead", { subject: "API tests", writeScopes: ["src/api"] });
  board.update("qa", false, { taskId: c.id, expectedRevision: 1, action: "claim" });
  assert.ok(board.get(b.id).writeScopeWarnings.some((w) => w.includes(c.id)));
  assert.ok(board.get(c.id).writeScopeWarnings.some((w) => w.includes(b.id)));
  assert.equal(scopesOverlap("src/api", "src/apix"), false);
  board.update("lead", true, { taskId: c.id, expectedRevision: board.get(c.id).revision, action: "edit", blockedBy: [b.id] });
  assert.throws(() => board.update("lead", true, { taskId: b.id, expectedRevision: board.get(b.id).revision, action: "edit", blockedBy: [c.id] }), /cycle/);
  board.update("lead", true, { taskId: c.id, expectedRevision: board.get(c.id).revision, action: "delete" });
  assert.equal(board.list().some((t) => t.id === c.id), false);
  assert.ok(changes >= 5);
  // Restore migrates the legacy shape.
  const fresh = new TeamBoard();
  fresh.restore([{ id: "task-3", subject: "old", description: "", status: "pending", owner: "x" } as any]);
  assert.equal(fresh.get("task-3").revision, 1);
  assert.equal(fresh.create("lead", { subject: "next" }).id, "task-4");
});

function makeFakeChildren() {
  const created: Array<{ opts: any; handle: any }> = [];
  const state = { auto: false, seq: 0 };
  const factory = async (opts: any) => {
    const id = `fake-${++state.seq}`;
    const handle: any = {
      sessionId: id, sessionFile: `/tmp/${id}.jsonl`, prompts: [] as string[], steers: [] as string[], followUps: [] as string[],
      structuredValue: undefined, listeners: [] as Array<(e: any) => void>, streaming: false, release: undefined as undefined | (() => void),
      prompt: async (t: string) => {
        handle.prompts.push(t); handle.streaming = true;
        for (const f of handle.listeners) f({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
        await new Promise<void>((r) => { handle.release = r; if (state.auto) r(); });
        handle.streaming = false;
      },
      steer: async (t: string) => { handle.steers.push(t); },
      followUp: async (t: string) => { handle.followUps.push(t); },
      abort: async () => { handle.release?.(); },
      isStreaming: () => handle.streaming,
      lastText: () => `last:${handle.prompts.at(-1) ?? ""}`,
      structured: () => handle.structuredValue,
      subscribe: (fn: (e: any) => void) => { handle.listeners.push(fn); return () => undefined; },
      dispose: () => undefined,
    };
    created.push({ opts, handle });
    return handle;
  };
  return { created, state, factory };
}

test("subagent manager: tree capacity, depth cap, nested delegation tools", async () => {
  const board = new TeamBoard();
  const { created, factory } = makeFakeChildren();
  const mgr = new SubagentManager({ maxActive: 2, maxDepth: 2, childDir: "/tmp", createChild: factory as any, board });
  const aId = await mgr.start({ provider: "spawn", label: "a", task: "task-a", owner: "root", cwd: "/tmp", delivery: "parent" });
  assert.equal(mgr.get(aId)?.depth, 1);
  assert.equal(mgr.status(aId).entry.toolCalls, 1); // progress subscription saw the tool event
  const childTools = created[0]!.opts.extraTools as any[];
  const spawnTool = childTools.find((t) => t.name === "subagent");
  assert.ok(spawnTool, "depth-1 child gets delegation tool when maxDepth=2");
  const ctx: any = { cwd: "/tmp", sessionManager: { getBranch: () => [] } };
  const started = await spawnTool.execute("t1", { task: "grandchild task" }, undefined, undefined, ctx);
  const gId = started.content[0].text.replace("started subagent ", "");
  assert.equal(mgr.get(gId)?.depth, 2);
  assert.equal(mgr.get(gId)?.parentId, aId);
  const grandchildTools = created[1]!.opts.extraTools as any[];
  assert.equal(grandchildTools.some((t) => t.name === "subagent"), false); // at cap: no delegation tools
  await assert.rejects(() => mgr.start({ provider: "spawn", label: "c", task: "x", owner: "root", cwd: "/tmp", delivery: "parent" }), /ACTIVATION_LIMIT_REACHED/);
  await assert.rejects(() => mgr.start({ provider: "spawn", label: "d", task: "x", owner: "root", parentId: gId, depth: 3, cwd: "/tmp", delivery: "parent" }), /exceeds maxDepth/);
  assert.deepEqual(mgr.descendants("root").map((e) => e.childId), [aId, gId]);
  created[1]!.handle.release();
  const gRes = await mgr.wait(gId);
  assert.equal(gRes.status, "completed");
  assert.ok(created[0]!.handle.steers.some((s: string) => s.includes("finished")), "direct parent child receives completion steer");
  created[0]!.handle.release();
  await mgr.wait(aId);
});

test("subagent manager: adjacency messaging, team sibling messaging, timeout", async () => {
  const board = new TeamBoard();
  const { created, state, factory } = makeFakeChildren();
  const mgr = new SubagentManager({ maxActive: 8, maxDepth: 1, childDir: "/tmp", createChild: factory as any, board });
  const parentNotes: string[] = [];
  mgr.onParentMessage = (_from, message) => parentNotes.push(message);
  const t1 = await mgr.start({ provider: "spawn", label: "team:rev", name: "rev", role: "teammate", task: "review", owner: "root", cwd: "/tmp", delivery: "parent" });
  const t2 = await mgr.start({ provider: "spawn", label: "team:qa", name: "qa", role: "teammate", task: "test", owner: "root", cwd: "/tmp", delivery: "parent" });
  const plain = await mgr.start({ provider: "spawn", label: "plain", task: "solo", owner: "root", cwd: "/tmp", delivery: "parent" });
  const t1Tools = created[0]!.opts.extraTools as any[];
  assert.ok(t1Tools.some((t) => t.name === "team_task_create"), "teammate receives board tools");
  assert.equal((created[2]!.opts.extraTools as any[]).some((t) => t.name === "team_task_create"), false);
  const send = t1Tools.find((t) => t.name === "send_message");
  const toQa = await send.execute("m1", { agent_id: "qa", message: "diff is ready" });
  assert.match(toQa.content[0].text, /message delivered to agent/);
  assert.ok(created[1]!.handle.steers.some((s: string) => s.includes("diff is ready") && s.includes("rev")));
  const toLead = await send.execute("m2", { agent_id: "lead", message: "blocked on fixtures" });
  assert.match(toLead.content[0].text, /delivered to lead/);
  assert.deepEqual(parentNotes, ["blocked on fixtures"]);
  await assert.rejects(() => send.execute("m3", { agent_id: plain, message: "hi" }), /may only message/);
  // Child-visible board write lands on the shared board.
  const create = t1Tools.find((t) => t.name === "team_task_create");
  await create.execute("b1", { subject: "Review diff", writeScopes: ["src"] });
  assert.equal(board.list().at(-1)?.createdBy, "rev");
  // auto stays false: the timed child's prompt hangs until the deadline aborts it.
  const timed = await mgr.start({ provider: "spawn", label: "slow", task: "hang", owner: "root", cwd: "/tmp", delivery: "caller", timeoutMs: 10 });
  const timedRes = await mgr.wait(timed);
  assert.equal(timedRes.stopReason, "timeout");
  assert.equal(timedRes.status, "killed");
  for (const c of created) c.handle.release?.();
  await Promise.allSettled([mgr.wait(t1), mgr.wait(t2), mgr.wait(plain)]);
});

test("subagent manager: restore stubs replay results and cold-resume after restart", async () => {
  const { created, state, factory } = makeFakeChildren();
  state.auto = true;
  const mgr = new SubagentManager({ maxActive: 8, maxDepth: 1, childDir: "/tmp", createChild: factory as any });
  const id = await mgr.start({ provider: "spawn", label: "worker", task: "first", owner: "root", cwd: "/tmp", delivery: "parent", modelLabel: "prov/model" });
  const first = await mgr.wait(id);
  assert.equal(first.status, "completed");
  const catalog = mgr.list("root");
  const mgr2 = new SubagentManager({ maxActive: 8, maxDepth: 1, childDir: "/tmp", createChild: factory as any });
  mgr2.restore(catalog);
  const replayed = await mgr2.wait(id);
  assert.equal(replayed.text, first.text);
  const before = created.length;
  const ack = await mgr2.sendMessageAs("root", id, "second task");
  assert.match(ack, /resumed/);
  assert.equal(created[before]!.opts.openFile, `/tmp/${id}.jsonl`);
  assert.equal(created[before]!.opts.thinkingLevel, undefined);
  const second = await mgr2.wait(created[before]!.handle.sessionId);
  assert.match(second.text, /second task/);
});

test("subagent manager: required structured output fails silent children", async () => {
  const { state, factory } = makeFakeChildren();
  state.auto = true;
  const mgr = new SubagentManager({ maxActive: 8, maxDepth: 1, childDir: "/tmp", createChild: factory as any });
  const id = await mgr.start({ provider: "spawn", label: "auditor", task: "audit", owner: "root", cwd: "/tmp", delivery: "caller", requireStructured: true });
  const res = await mgr.wait(id);
  assert.equal(res.status, "failed");
});

test("subagent manager: restore never clobbers a live activation", async () => {
  const { created, factory } = makeFakeChildren();
  const mgr = new SubagentManager({ maxActive: 8, maxDepth: 1, childDir: "/tmp", createChild: factory as any });
  const id = await mgr.start({ provider: "spawn", label: "live", task: "hang", owner: "root", cwd: "/tmp", delivery: "parent" });
  mgr.restore(mgr.list("root")); // session_tree-style re-restore from the branch snapshot
  assert.equal(mgr.get(id)?.status, "live");
  created[0]!.handle.release();
  const res = await mgr.wait(id);
  assert.equal(res.status, "completed");
});

test("parseOutputSchema accepts object and stringified schema (live regression)", () => {
  assert.equal(parseOutputSchema(undefined), undefined);
  assert.deepEqual(parseOutputSchema({ type: "object" }), { type: "object" });
  assert.deepEqual(parseOutputSchema('{"type":"object","properties":{"contents":{"type":"string"}}}'), { type: "object", properties: { contents: { type: "string" } } });
  assert.throws(() => parseOutputSchema("{not json"), /not valid JSON/);
  assert.throws(() => parseOutputSchema('"just a string"'), /must be a JSON Schema object/);
  assert.throws(() => parseOutputSchema([1, 2]), /must be a JSON Schema object/);
});

test("modelRouteAllowed: no allowlist allows every route, a list allows only its entries", () => {
  assert.equal(modelRouteAllowed("a/x", undefined), true);
  assert.equal(modelRouteAllowed("a/x", []), true);
  assert.equal(modelRouteAllowed("a/x", ["a/x", "b/y"]), true);
  assert.equal(modelRouteAllowed("a/z", ["a/x", "b/y"]), false);
  assert.equal(modelRouteAllowed("x", ["a/x"]), false, "a bare id is not a route");
});

test("roundFenceFailure: a round owns the goal only while id, revision, state, and round number all match", () => {
  const goal = { id: "g1", revision: 3, objective: "o", status: "active" as const, roundsStarted: 1, maxGoalRounds: 5, blockerRounds: 0, armed: true };
  const round = { goalId: "g1", revision: 3, round: 2 };
  assert.equal(roundFenceFailure(goal, round), undefined);
  assert.match(roundFenceFailure(undefined, round) ?? "", /cleared/);
  assert.match(roundFenceFailure({ ...goal, id: "g2" }, round) ?? "", /replaced/);
  assert.match(roundFenceFailure({ ...goal, revision: 4 }, round) ?? "", /changed/);
  assert.match(roundFenceFailure({ ...goal, armed: false }, round) ?? "", /armed/);
  assert.match(roundFenceFailure({ ...goal, status: "paused" }, round) ?? "", /armed/);
  assert.match(roundFenceFailure({ ...goal, roundsStarted: 2 }, round) ?? "", /already started/);
  assert.equal(roundKey(round), "g1:3:2");
});
