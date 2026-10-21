/** Unified background-job registry (dsh ctx.jobs): one registry for bash, PTY sends,
 * subagent activations, and workflow runs. Process-local, as in dsh jobs-local. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OutputRing } from "./core.ts";

export type JobStatus = "running" | "completed" | "failed" | "killed";
export interface JobSnapshot {
  id: string; kind: string; label: string; status: JobStatus;
  progress?: string; result?: string; startedAt: number; finishedAt?: number;
  outFile?: string; exitFile?: string;
}
export interface JobHandle {
  append(text: string): void;
  updateProgress(text: string): void;
  signal: AbortSignal;
}
interface Job {
  snap: JobSnapshot; ring: OutputRing; owner: string;
  cancel: (reason?: string) => void; controller: AbortController;
  awaited: boolean; killRequested: boolean; resultDelivered: boolean;
  done: Promise<void>; settleWaiters: Array<() => void>;
}

let seq = 0;
export class JobRegistry {
  private jobs = new Map<string, Job>();
  private persistRoot: string | undefined;
  /** Enable snapshot/output persistence under root/<owner>/<job>.{json,log}. */
  setPersistRoot(root: string): void { this.persistRoot = root; }
  private dirFor(owner: string): string | undefined {
    if (!this.persistRoot) return undefined;
    const dir = join(this.persistRoot, owner.replace(/[^A-Za-z0-9_-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  private writeSnapshot(job: Job): void {
    try {
      const dir = this.dirFor(job.owner); if (!dir) return;
      writeFileSync(join(dir, `${job.snap.id}.json`), JSON.stringify({ snap: job.snap, owner: job.owner }), "utf8");
    } catch { /* persistence is best-effort beside the live registry */ }
  }
  /** Reload settled jobs for an owner; running-at-exit jobs reconcile from exitFile or fail honestly. */
  restore(owner: string): void {
    const dir = this.dirFor(owner); if (!dir || !existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const { snap } = JSON.parse(readFileSync(join(dir, file), "utf8")) as { snap: JobSnapshot };
        if (this.jobs.has(snap.id)) continue;
        const ring = new OutputRing();
        const source = snap.outFile && existsSync(snap.outFile) ? snap.outFile : join(dir, `${snap.id}.log`);
        if (existsSync(source)) ring.append(readFileSync(source, "utf8").slice(-256 * 1024));
        if (snap.status === "running") {
          if (snap.exitFile && existsSync(snap.exitFile)) { snap.status = "completed"; ring.append(`\n[recovered after restart; exit ${readFileSync(snap.exitFile, "utf8").trim()}]\n`); }
          else { snap.status = "failed"; ring.append("\n[pi exited while this job was running; outcome unknown]\n"); }
          snap.finishedAt = Date.now();
        }
        const controller = new AbortController();
        const job: Job = { snap, ring, owner, controller, cancel: () => controller.abort(), awaited: true, killRequested: false, resultDelivered: false, done: Promise.resolve(), settleWaiters: [] };
        this.jobs.set(snap.id, job);
        this.writeSnapshot(job);
      } catch { /* one unreadable record must not block the rest */ }
    }
  }
  onSettle: ((snap: JobSnapshot, info: { awaited: boolean; killRequested: boolean; owner: string }) => void) | undefined;

  start(opts: {
    kind: string; label: string; owner: string;
    durable?: { outFile: string; exitFile: string };
    run: (handle: JobHandle) => Promise<{ result?: string } | void>;
  }): string {
    const id = `${opts.kind}-${++seq}`;
    const controller = new AbortController();
    const job: Job = {
      snap: { id, kind: opts.kind, label: opts.label, status: "running", startedAt: Date.now(), outFile: opts.durable?.outFile, exitFile: opts.durable?.exitFile },
      ring: new OutputRing(), owner: opts.owner, controller,
      cancel: () => controller.abort(), awaited: false, killRequested: false,
      resultDelivered: false, done: Promise.resolve(), settleWaiters: [],
    };
    this.jobs.set(id, job);
    this.writeSnapshot(job);
    const dir = this.dirFor(opts.owner);
    const logFile = dir ? join(dir, `${id}.log`) : undefined;
    const handle: JobHandle = {
      append: (t) => { job.ring.append(t); if (logFile) { try { appendFileSync(logFile, t, "utf8"); } catch { /* mirror only */ } } },
      updateProgress: (t) => { job.snap.progress = t; },
      signal: controller.signal,
    };
    job.done = (async () => {
      try {
        const out = await opts.run(handle);
        if (out?.result !== undefined) job.snap.result = out.result;
        job.snap.status = controller.signal.aborted ? "killed" : "completed";
      } catch (err) {
        job.snap.status = controller.signal.aborted ? "killed" : "failed";
        job.ring.append(`\n[error: ${err instanceof Error ? err.message : String(err)}]\n`);
      } finally {
        job.snap.finishedAt = Date.now();
        this.writeSnapshot(job);
        for (const wake of job.settleWaiters) wake();
        job.settleWaiters = [];
        this.onSettle?.({ ...job.snap }, { awaited: job.awaited, killRequested: job.killRequested, owner: job.owner });
      }
    })();
    return id;
  }

  list(owner: string): JobSnapshot[] {
    return [...this.jobs.values()].filter((j) => j.owner === owner).map((j) => ({ ...j.snap }));
  }
  hasRunning(owner: string): boolean {
    return [...this.jobs.values()].some((j) => j.owner === owner && j.snap.status === "running");
  }
  get(id: string, owner: string): Job | undefined {
    const job = this.jobs.get(id);
    return job && job.owner === owner ? job : undefined;
  }
  /** With `wait`, blocks until the job settles, the timeout passes, or `signal` aborts; the job keeps running in every case. */
  async output(id: string, owner: string, opts?: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<{ text: string; job: JobSnapshot }> {
    const job = this.get(id, owner);
    if (!job) throw new Error(`unknown job: ${id}`);
    if (opts?.wait && job.snap.status === "running") {
      job.awaited = true;
      await this.waitForSettle(job, Math.min(opts.timeoutMs ?? 30_000, 600_000), opts.signal);
    }
    let text = job.ring.readNew();
    if (job.snap.status !== "running" && job.snap.result !== undefined && !job.resultDelivered) {
      job.resultDelivered = true;
      text += (text ? "\n" : "") + job.snap.result;
    }
    return { text: `${text}\n[status: ${job.snap.status}]`, job: { ...job.snap } };
  }
  private async waitForSettle(job: Job, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    job.settleWaiters.push(wake);
    const timer = setTimeout(wake, timeoutMs);
    if (signal?.aborted) wake(); else signal?.addEventListener("abort", wake, { once: true });
    try { await woken; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", wake); }
  }
  async kill(id: string, owner: string, _reason?: string): Promise<{ outcome: string; job: JobSnapshot }> {
    const job = this.get(id, owner);
    if (!job) throw new Error(`unknown job: ${id}`);
    if (job.snap.status !== "running") return { outcome: "already-finished", job: { ...job.snap } };
    job.killRequested = true;
    job.cancel(_reason);
    await job.done;
    return { outcome: "cancellation-requested", job: { ...job.snap } };
  }
  /** Cancel running jobs of an owner (session teardown). Durable file-backed jobs
   * survive a process exit when keepDurable is set, so restart can reconcile them. */
  async disposeOwner(owner: string, opts?: { keepDurable?: boolean }): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.owner === owner && j.snap.status === "running" && !(opts?.keepDurable && j.snap.exitFile));
    for (const job of running) job.cancel();
    await Promise.allSettled(running.map((j) => j.done));
  }
}
