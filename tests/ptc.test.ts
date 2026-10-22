import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PTC_LIMITS, NodePtcProvider, PythonPtcProvider, ptcLimitsFrom } from "../src/ptc.ts";

const limits = (over: Partial<typeof DEFAULT_PTC_LIMITS>) => ({ ...DEFAULT_PTC_LIMITS, ...over });
const scratch = mkdtempSync(join(tmpdir(), "pi-dsh-ptc-"));
// bubblewrap mounts a fresh tmpfs over /tmp, which would hide a /tmp workspace.
const sandboxable = existsSync("/usr/bin/bwrap") && !scratch.startsWith("/tmp/");
const needsSandbox = { skip: !sandboxable && "bubblewrap unavailable or scratch is under /tmp" };

test("limits fall back to the dsh defaults unless they are positive integers", () => {
  assert.deepEqual(ptcLimitsFrom({}), DEFAULT_PTC_LIMITS);
  assert.deepEqual(ptcLimitsFrom({ maxOutputBytes: 10, maxPendingCalls: -1, maxMessageBytes: 0.5, graceMs: 0 }), { ...DEFAULT_PTC_LIMITS, maxOutputBytes: 10 });
});

test("node: logs past the output cap fail the run with the retained prefix, not unbounded memory", async () => {
  const ptc = new NodePtcProvider(limits({ maxOutputBytes: 1000 }));
  const r = await ptc.run({ program: "for (let i = 0; i < 1e6; i++) console.log('x'.repeat(100));", timeoutMs: 20_000 });
  assert.equal(r.error?.kind, "output-limit", JSON.stringify(r.error));
  assert.match(r.error?.message ?? "", /exceeded 1000 bytes/);
  assert.ok(r.logs.length > 0 && r.logs.length <= 10, `kept ${r.logs.length} logs`);
});

test("node: a return value that pushes output over the cap is an output-limit failure", async () => {
  const ptc = new NodePtcProvider(limits({ maxOutputBytes: 1000 }));
  const r = await ptc.run({ program: "console.log('small'); return 'y'.repeat(5000);", timeoutMs: 20_000 });
  assert.equal(r.error?.kind, "output-limit");
  assert.deepEqual(r.logs, ["small"]);
});

test("node: a program that swallows the cap error still fails", async () => {
  const ptc = new NodePtcProvider(limits({ maxOutputBytes: 200 }));
  const r = await ptc.run({ program: "for (let i = 0; i < 50; i++) { try { console.log('z'.repeat(100)); } catch {} } return 'finished';", timeoutMs: 20_000 });
  assert.equal(r.error?.kind, "output-limit");
});

test("node: output within the cap is untouched", async () => {
  const ptc = new NodePtcProvider(limits({ maxOutputBytes: 1000 }));
  const r = await ptc.run({ program: "console.log('a'); console.log('b'); return { n: 1 };", timeoutMs: 20_000 });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.logs, ["a", "b"]);
  assert.deepEqual(r.value, { n: 1 });
});

test("node: an output overflow drops the persistent process and its variables", async () => {
  const ptc = new NodePtcProvider(limits({ maxOutputBytes: 300 }));
  t_cleanup(ptc);
  const first = await ptc.run({ program: "var kept = 41; kept", stateOwner: "s", timeoutMs: 20_000 });
  assert.equal(first.value, 41);
  const flood = await ptc.run({ program: "for (let i = 0; i < 100; i++) console.log('q'.repeat(100));", stateOwner: "s", timeoutMs: 20_000 });
  assert.equal(flood.error?.kind, "output-limit");
  const after = await ptc.run({ program: "typeof kept", stateOwner: "s", timeoutMs: 20_000 });
  assert.equal(after.value, "undefined", "variables survived an overflow");
});

test("node: too many calls in flight ends the program with a protocol failure", async () => {
  const ptc = new NodePtcProvider(limits({ maxPendingCalls: 3 }));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const r = await ptc.run({
    program: "return await Promise.all(Array.from({ length: 10 }, () => tools.slow({})));",
    bindings: { tools: { slow: async () => { await gate; return 1; } } }, timeoutMs: 20_000,
  });
  release();
  assert.equal(r.error?.kind, "protocol");
  assert.match(r.error?.message ?? "", /pending binding calls exceed/);
});

test("node: calls within the pending limit run normally, one batch after another", async () => {
  const ptc = new NodePtcProvider(limits({ maxPendingCalls: 3 }));
  const r = await ptc.run({
    program: "const out = []; for (let i = 0; i < 4; i++) out.push(...await Promise.all([1, 2, 3].map((n) => tools.id({ n })))); return out.length;",
    bindings: { tools: { id: async (a: any) => a.n } }, timeoutMs: 20_000,
  });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.value, 12);
});

test("node: argument bytes in flight are capped too", async () => {
  const ptc = new NodePtcProvider(limits({ maxMessageBytes: 1000 }));
  const r = await ptc.run({
    program: "await Promise.all([tools.hold({ s: 'a'.repeat(700) }), tools.hold({ s: 'b'.repeat(700) })]); return 1;",
    bindings: { tools: { hold: async () => { await new Promise((res) => setTimeout(res, 100)); return 1; } } }, timeoutMs: 20_000,
  });
  assert.equal(r.error?.kind, "protocol");
});

test("node: a program writing floods straight to stdout and stderr is not blocked by unread pipes", async () => {
  const ptc = new NodePtcProvider();
  const flood = (fd: number) => `await (async () => { const fs = await import('node:fs'); const chunk = Buffer.alloc(4096, 'x'); let left = 400000; while (left > 0) { try { left -= fs.writeSync(${fd}, chunk); } catch (e) { if (e.code !== 'EAGAIN') throw e; await new Promise((r) => setTimeout(r, 1)); } } })();`;
  const r = await ptc.run({ program: `${flood(1)} ${flood(2)} return 'alive';`, timeoutMs: 15_000 });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.value, "alive");
});

test("node: a crash reports the exit status and the stderr tail", async () => {
  const ptc = new NodePtcProvider();
  const r = await ptc.run({ program: "process.stderr.write('fatal detail here\\n'); process.exit(3);", timeoutMs: 15_000 });
  assert.equal(r.error?.kind, "worker-exit");
  assert.match(r.error?.message ?? "", /code 3/);
  assert.match(r.error?.message ?? "", /fatal detail here/);
});

test("python: runs a program and returns result", async () => {
  const r = await new PythonPtcProvider().run({ program: "print('hi')\nresult = 6 * 7", timeoutMs: 15_000 });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.value, 42);
  assert.deepEqual(r.logs, ["hi"]);
});

test("python: prints past the output cap fail the run, even inside a bare except", async () => {
  const ptc = new PythonPtcProvider(limits({ maxOutputBytes: 500 }));
  const r = await ptc.run({ program: "for i in range(1000000):\n    try:\n        print('x' * 100)\n    except Exception:\n        pass", timeoutMs: 20_000 });
  assert.equal(r.error?.kind, "output-limit", JSON.stringify(r.error));
});

test("python: a crash reports the stderr tail", async () => {
  const r = await new PythonPtcProvider().run({ program: "import os, sys\nsys.stderr.write('py detail\\n')\nsys.stderr.flush()\nos._exit(4)", timeoutMs: 15_000 });
  assert.equal(r.error?.kind, "worker-exit");
  assert.match(r.error?.message ?? "", /code 4/);
  assert.match(r.error?.message ?? "", /py detail/);
});

test("python: the read-only sandbox applies, so choosing python does not widen access", needsSandbox, async () => {
  const target = join(scratch, "py-write.txt");
  const program = `open(${JSON.stringify(target)}, 'w').write('data')\nresult = 'wrote'`;
  const confined = await new PythonPtcProvider().run({ program, cwd: scratch, sandboxMode: "read-only", timeoutMs: 15_000 });
  assert.equal(confined.error?.kind, "exception", JSON.stringify(confined));
  assert.equal(existsSync(target), false);

  const allowed = await new PythonPtcProvider().run({ program, cwd: scratch, sandboxMode: "workspace-write", timeoutMs: 15_000 });
  assert.equal(allowed.error, undefined, JSON.stringify(allowed));
  assert.equal(readFileSync(target, "utf8"), "data");
});

test("python: an unusable sandbox runner fails closed instead of running unconfined", async () => {
  const r = await new PythonPtcProvider().run({ program: "result = 1", sandboxMode: "read-only", sandboxRunner: ["/nonexistent/runner"], timeoutMs: 15_000 });
  assert.equal(r.error?.kind, "sandbox-unavailable");
});

function t_cleanup(ptc: NodePtcProvider) { test.after(() => ptc.disposeAll()); }

// A stopped program: SIGTERM first, SIGKILL after the grace period, and the output it already logged.
test("node: a timed-out program reports what it logged before it was stopped", async () => {
  const r = await new NodePtcProvider().run({ program: "console.log('before'); console.log('still going'); while (true) {}", timeoutMs: 400 });
  assert.equal(r.error?.kind, "timeout");
  assert.deepEqual(r.logs, ["before", "still going"]);
});

test("node: an aborted program reports what it logged and the abort", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const r = await new NodePtcProvider().run({ program: "console.log('partial'); while (true) {}", signal: controller.signal, timeoutMs: 20_000 });
  assert.equal(r.error?.kind, "abort");
  assert.deepEqual(r.logs, ["partial"]);
});

test("node: a program that has already been aborted does not start", async () => {
  const controller = new AbortController();
  controller.abort();
  const r = await new NodePtcProvider().run({ program: "return 1", signal: controller.signal });
  assert.equal(r.error?.kind, "abort");
});

test("node: a program that ignores SIGTERM is killed once the grace period passes", async () => {
  const ptc = new NodePtcProvider(limits({ graceMs: 500 }));
  const started = Date.now();
  const r = await ptc.run({ program: "process.on('SIGTERM', () => {}); console.log('ready'); while (true) {}", timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.equal(r.error?.kind, "timeout");
  assert.deepEqual(r.logs, ["ready"]);
  assert.ok(elapsed >= 700, `stopped after ${elapsed}ms, before the timeout plus the grace period`);
  assert.ok(elapsed < 6000, `still running ${elapsed}ms in`);
});

test("node: a stopped program's stderr tail comes back with the timeout", async () => {
  const r = await new NodePtcProvider().run({ program: "process.stderr.write('last words\\n'); while (true) {}", timeoutMs: 400 });
  assert.equal(r.error?.kind, "timeout");
  assert.match(r.error?.message ?? "", /last words/);
});

test("node: the pending-call limit reports the output the program had already produced", async () => {
  const ptc = new NodePtcProvider(limits({ maxPendingCalls: 1 }));
  const r = await ptc.run({
    program: "console.log('started'); await Promise.all([tools.hold({}), tools.hold({})]);",
    bindings: { tools: { hold: async () => { await new Promise((res) => setTimeout(res, 200)); return 1; } } }, timeoutMs: 20_000,
  });
  assert.equal(r.error?.kind, "protocol");
  assert.deepEqual(r.logs, ["started"]);
});

test("python: a timed-out program reports the lines it printed", async () => {
  const r = await new PythonPtcProvider().run({ program: "print('one')\nprint('two')\nwhile True:\n    pass", timeoutMs: 600 });
  assert.equal(r.error?.kind, "timeout");
  assert.deepEqual(r.logs, ["one", "two"]);
});

test("python: a program that ignores SIGTERM is killed once the grace period passes", async () => {
  const ptc = new PythonPtcProvider(limits({ graceMs: 500 }));
  const started = Date.now();
  const r = await ptc.run({ program: "import signal\nsignal.signal(signal.SIGTERM, lambda *a: None)\nprint('ready')\nwhile True:\n    pass", timeoutMs: 600 });
  const elapsed = Date.now() - started;
  assert.equal(r.error?.kind, "timeout");
  assert.deepEqual(r.logs, ["ready"]);
  assert.ok(elapsed >= 900, `stopped after ${elapsed}ms, before the timeout plus the grace period`);
  assert.ok(elapsed < 6000, `still running ${elapsed}ms in`);
});

test("python: an aborted program reports the abort", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  const r = await new PythonPtcProvider().run({ program: "print('hello')\nwhile True:\n    pass", signal: controller.signal, timeoutMs: 20_000 });
  assert.equal(r.error?.kind, "abort");
  assert.deepEqual(r.logs, ["hello"]);
});
