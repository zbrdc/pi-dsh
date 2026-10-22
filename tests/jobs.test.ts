import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobRegistry } from "../src/jobs.ts";
import { runShellJob } from "../src/terminal.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-dsh-jobs-"));
// bubblewrap mounts a fresh tmpfs over /tmp, which would hide a /tmp workspace.
const sandboxable = existsSync("/usr/bin/bwrap") && !scratch.startsWith("/tmp/");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start `command`, cancel it after `afterMs`, and report how the shell ended and how long that took. */
async function cancelAfter(command: string, opts: { afterMs?: number; killGraceMs: number; sandboxMode?: "workspace-write" }) {
  const controller = new AbortController();
  const started = Date.now();
  const run = runShellJob({ command, cwd: scratch, signal: controller.signal, append: () => undefined, killGraceMs: opts.killGraceMs, sandboxMode: opts.sandboxMode });
  await sleep(opts.afterMs ?? 300);
  const cancelledAt = Date.now();
  controller.abort();
  const { exitCode } = await run;
  return { exitCode, waitedMs: Date.now() - cancelledAt, totalMs: Date.now() - started };
}

test("a cancelled job gets SIGTERM first, so its cleanup handler runs", async () => {
  const marker = join(scratch, "term-cleanup.txt");
  const { waitedMs } = await cancelAfter(`trap 'echo cleaned > ${marker}; exit 0' TERM; sleep 30 & wait`, { killGraceMs: 5000 });
  assert.equal(readFileSync(marker, "utf8").trim(), "cleaned");
  assert.ok(waitedMs < 3000, `waited ${waitedMs}ms; the handler should end the job without using the grace period`);
});

test("a job that ignores SIGTERM is killed once the grace period passes", async () => {
  const { waitedMs } = await cancelAfter("trap '' TERM; while true; do sleep 0.1; done", { killGraceMs: 400 });
  assert.ok(waitedMs >= 300, `killed after ${waitedMs}ms, before the grace period`);
  assert.ok(waitedMs < 5000, `still running ${waitedMs}ms after cancel`);
});

test("a straggler that outlives the shell is swept with SIGKILL", async () => {
  const pidFile = join(scratch, "straggler.pid");
  await cancelAfter(`(trap '' TERM; echo $BASHPID > ${pidFile}; exec sleep 30) & wait`, { killGraceMs: 400 });
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await sleep(100);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the straggler is still alive");
});

test("a job that was already cancelled when it starts is still terminated", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await runShellJob({ command: "sleep 30", cwd: scratch, signal: controller.signal, append: () => undefined, killGraceMs: 400 });
  assert.ok(Date.now() - started < 5000);
});

test("a sandboxed job gets the same SIGTERM cleanup", { skip: !sandboxable && "bubblewrap unavailable or scratch is under /tmp" }, async () => {
  const marker = join(scratch, "sandbox-term-cleanup.txt");
  const { waitedMs } = await cancelAfter(`trap 'echo cleaned > ${marker}; exit 0' TERM; sleep 30 & wait`, { killGraceMs: 5000, sandboxMode: "workspace-write" });
  await sleep(100);
  assert.equal(readFileSync(marker, "utf8").trim(), "cleaned");
  assert.ok(waitedMs < 3000, `waited ${waitedMs}ms`);
});

test("a killed job records why it was cancelled", async () => {
  const jobs = new JobRegistry();
  const hang = async (h: { signal: AbortSignal }) => { await new Promise<void>((res) => { h.signal.addEventListener("abort", () => res(), { once: true }); }); };
  const id = jobs.start({ kind: "bash", label: "hang", owner: "s", run: hang });
  const killed = await jobs.kill(id, "s", "  no longer needed ");
  assert.equal(killed.job.status, "killed");
  assert.equal(killed.job.detail, "no longer needed");
  assert.match((await jobs.output(id, "s")).text, /\[status: killed \(no longer needed\)\]/);

  const unexplained = jobs.start({ kind: "bash", label: "hang", owner: "s", run: hang });
  assert.equal((await jobs.kill(unexplained, "s")).job.detail, "cancelled");
});

test("a job that finished before the kill keeps no kill reason", async () => {
  const jobs = new JobRegistry();
  const id = jobs.start({ kind: "bash", label: "quick", owner: "s", run: async () => undefined });
  await jobs.output(id, "s", { wait: true });
  const late = await jobs.kill(id, "s", "too late");
  assert.equal(late.outcome, "already-finished");
  assert.equal(late.job.status, "completed");
  assert.equal(late.job.detail, undefined);
});

test("session teardown marks running jobs as ended with the session", async () => {
  const jobs = new JobRegistry();
  const id = jobs.start({ kind: "bash", label: "hang", owner: "s", run: async (h) => { await new Promise<void>((res) => h.signal.addEventListener("abort", () => res(), { once: true })); } });
  await jobs.disposeOwner("s");
  const [snap] = jobs.list("s");
  assert.equal(snap?.id, id);
  assert.equal(snap?.detail, "session ended");
});
