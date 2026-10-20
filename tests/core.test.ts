import test from "node:test";
import assert from "node:assert/strict";
import { validateTodos, RepeatTracker, spillText, pruneText, assertLosslessJson, OutputRing, newGoal, applyBlocker, generateSdk, canonical, normalizeStructured, captureStructuredSubmission, renderTaskControlSection, jsonSchemaToTs, Semaphore, completedTurnCut, bwrapArgs, resolveToolTimeoutMs, timeoutFieldCaps, fuseSignal, ToolWatchdog, tmuxSessionName, tmuxSendKeysChunks } from "../src/core.ts";
import { JobRegistry } from "../src/jobs.ts";
import { capLines, renderAgentsWidget, renderDashboard, renderJobsWidget, renderStatusLine, renderTodoWidget } from "../src/ui.ts";
import { TerminalRegistry, tmuxAvailable } from "../src/terminal.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodePtcProvider, MossbedProvider } from "../src/ptc.ts";
import { buildChildPrompt, structuredToolParameters } from "../src/subagent.ts";

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
    agents: [{ childId: "c1", provider: "spawn", label: "audit", owner: "o", cwd: "/tmp", createdAt: now, status: "live" as const }],
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
