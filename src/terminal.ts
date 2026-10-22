/** Persistent PTY seam (dsh ctx.terminals). Backends: node-pty when the optional
 * @lydell/node-pty dependency loads, else util-linux `script`. Owner-scoped sessions
 * with bounded output rings, resize, and signals. Also owns job bash execution. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OutputRing, stripAnsi, bwrapArgs, tmuxNewSessionArgs, tmuxSendKeysChunks, tmuxSessionName, type SandboxMode } from "./core.ts";

let seq = 0;
export interface TerminalSession {
  id: string; owner: string; label: string; ring: OutputRing; alive: boolean;
  backend: "node-pty" | "script" | "tmux";
  cwd: string; shell: string; durable: boolean; createdAt: number;
  tmuxName?: string; transcriptFile?: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  exited: Promise<{ code: number | null; signal: string | null }>;
}
interface TerminalMeta {
  id: string; owner: string; label: string; backend: TerminalSession["backend"];
  cwd: string; shell: string; durable: boolean; createdAt: number; tmuxName?: string;
}

let tmuxAvailableCache: boolean | undefined;
export function tmuxAvailable(): boolean {
  if (tmuxAvailableCache !== undefined) return tmuxAvailableCache;
  try { tmuxAvailableCache = spawnSync("tmux", ["-V"], { timeout: 3000 }).status === 0; }
  catch { tmuxAvailableCache = false; }
  return tmuxAvailableCache;
}
function tmux(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("tmux", args, { timeout: 5000, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
}

/** Cached functional probe of the bubblewrap-compatible runner (dsh sandbox-local
 * probes before trusting a runner; an unusable runner fails closed). */
const probeCache = new Map<string, boolean>();
export function probeSandboxRunner(runner: string[] | undefined, cwd: string): boolean {
  const cmd = runner && runner.length > 0 ? runner : ["/usr/bin/bwrap"];
  const key = cmd.join("\0");
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const r = spawnSync(cmd[0] as string, [...cmd.slice(1), ...bwrapArgs("read-only", cwd), "/bin/true"], { timeout: 10_000 });
    ok = r.status === 0;
  } catch { ok = false; }
  probeCache.set(key, ok);
  return ok;
}

let ptyMod: any | undefined | null = null;
async function loadPty(): Promise<any> {
  if (ptyMod !== null) return ptyMod;
  try { ptyMod = await import("@lydell/node-pty"); }
  catch { ptyMod = undefined; }
  return ptyMod;
}

export class TerminalRegistry {
  private sessions = new Map<string, TerminalSession>();
  private persistRoot: string | undefined;
  private pollers = new Map<string, ReturnType<typeof setInterval>>();

  /** Enable metadata/transcript persistence under root/<owner>/<id>.{json,log}. */
  setPersistRoot(root: string): void { this.persistRoot = root; }
  private dirFor(owner: string): string | undefined {
    if (!this.persistRoot) return undefined;
    const dir = join(this.persistRoot, owner.replace(/[^A-Za-z0-9_-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  private writeMeta(s: TerminalSession): void {
    try {
      const dir = this.dirFor(s.owner); if (!dir) return;
      const meta: TerminalMeta = { id: s.id, owner: s.owner, label: s.label, backend: s.backend, cwd: s.cwd, shell: s.shell, durable: s.durable, createdAt: s.createdAt, tmuxName: s.tmuxName };
      writeFileSync(join(dir, `${s.id}.json`), JSON.stringify(meta), "utf8");
    } catch { /* persistence is best-effort beside the live registry */ }
  }
  private transcriptFor(owner: string, id: string): string | undefined {
    const dir = this.dirFor(owner);
    return dir ? join(dir, `${id}.log`) : undefined;
  }
  private mirror(s: TerminalSession, text: string): void {
    s.ring.append(text);
    if (s.transcriptFile) { try { appendFileSync(s.transcriptFile, text, "utf8"); } catch { /* mirror only */ } }
  }
  private stopPolling(id: string): void {
    const iv = this.pollers.get(id);
    if (iv) clearInterval(iv);
    this.pollers.delete(id);
  }
  /** Attach to a tmux session: poll its pipe-pane transcript into the ring. */
  private attachTmux(session: TerminalSession, startOffset: number): Promise<{ code: number | null; signal: string | null }> {
    let offset = startOffset;
    const file = session.transcriptFile;
    const poll = setInterval(() => {
      if (!file) return;
      try {
        const body = readFileSync(file, "utf8");
        if (body.length > offset) { session.ring.append(stripAnsi(body.slice(offset))); offset = body.length; }
      } catch { /* not created yet */ }
    }, 200);
    if (typeof (poll as any).unref === "function") (poll as any).unref();
    this.pollers.set(session.id, poll);
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!session.tmuxName || tmux(["has-session", "-t", session.tmuxName]).status !== 0) {
          clearInterval(check); this.stopPolling(session.id); session.alive = false;
          resolve({ code: null, signal: null });
        }
      }, 500);
      if (typeof (check as any).unref === "function") (check as any).unref();
    });
  }
  private tmuxSessionObject(meta: TerminalMeta): TerminalSession {
    const ring = new OutputRing(256 * 1024);
    const session: TerminalSession = {
      id: meta.id, owner: meta.owner, label: meta.label, ring, alive: true, backend: "tmux",
      cwd: meta.cwd, shell: meta.shell, durable: meta.durable, createdAt: meta.createdAt, tmuxName: meta.tmuxName,
      transcriptFile: this.transcriptFor(meta.owner, meta.id),
      write: (d) => {
        for (const chunk of tmuxSendKeysChunks(d)) {
          if (chunk.literal !== undefined) tmux(["send-keys", "-t", meta.tmuxName as string, "-l", "--", chunk.literal]);
          if (chunk.enter) tmux(["send-keys", "-t", meta.tmuxName as string, "Enter"]);
        }
      },
      resize: (cols, rows) => { tmux(["resize-window", "-t", meta.tmuxName as string, "-x", String(cols), "-y", String(rows)]); },
      kill: (sig) => {
        if (sig && sig !== "SIGTERM" && sig !== "SIGKILL") {
          const pid = Number(tmux(["display-message", "-p", "-t", meta.tmuxName as string, "#{pane_pid}"]).stdout.trim());
          if (pid > 0) { try { process.kill(pid, sig as NodeJS.Signals); } catch { /* gone */ } return; }
        }
        tmux(["kill-session", "-t", meta.tmuxName as string]);
      },
      exited: Promise.resolve({ code: null, signal: null }),
    };
    return session;
  }
  /** Reattach live durable tmux terminals; restore others as exited stubs whose
   * transcripts stay readable. Honest limit: a dead PTY process cannot resume. */
  restore(owner: string): void {
    const dir = this.dirFor(owner); if (!dir || !existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(dir, file), "utf8")) as TerminalMeta;
        if (this.sessions.has(meta.id)) continue;
        const num = Number(meta.id.replace(/^term-/, ""));
        if (Number.isFinite(num) && num > seq) seq = num;
        const transcript = join(dir, `${meta.id}.log`);
        const tail = existsSync(transcript) ? readFileSync(transcript, "utf8").slice(-64 * 1024) : "";
        if (meta.backend === "tmux" && meta.tmuxName && tmux(["has-session", "-t", meta.tmuxName]).status === 0) {
          const session = this.tmuxSessionObject(meta);
          if (tail) session.ring.append(`[reattached after restart; recent output]\n${stripAnsi(tail)}`);
          session.exited = this.attachTmux(session, existsSync(transcript) ? readFileSync(transcript, "utf8").length : 0);
          this.sessions.set(meta.id, session);
        } else {
          const ring = new OutputRing(256 * 1024);
          if (tail) ring.append(stripAnsi(tail));
          ring.append("\n[terminal process ended while pi was not running; transcript preserved, shell state is gone — open a new terminal]\n");
          const stub: TerminalSession = {
            id: meta.id, owner: meta.owner, label: meta.label, ring, alive: false, backend: meta.backend,
            cwd: meta.cwd, shell: meta.shell, durable: meta.durable, createdAt: meta.createdAt, tmuxName: meta.tmuxName,
            transcriptFile: transcript,
            write: () => { throw new Error(`terminal ${meta.id} has exited`); },
            resize: () => { throw new Error(`terminal ${meta.id} has exited`); },
            kill: () => undefined,
            exited: Promise.resolve({ code: null, signal: null }),
          };
          this.sessions.set(meta.id, stub);
        }
      } catch { /* one unreadable record must not block the rest */ }
    }
  }

  async open(owner: string, opts?: { cwd?: string; label?: string; shell?: string; durable?: boolean }): Promise<TerminalSession> {
    const id = `term-${++seq}`;
    const cwd = opts?.cwd ?? process.cwd();
    const shell = opts?.shell ?? "bash";
    const ring = new OutputRing(256 * 1024);
    if (opts?.durable) {
      if (!tmuxAvailable()) throw new Error("durable terminals require tmux (not found on PATH); open a non-durable terminal instead");
      const name = tmuxSessionName(owner, seq);
      const created = tmux(tmuxNewSessionArgs(name, cwd, shell));
      if (created.status !== 0) throw new Error(`tmux failed to create durable session ${name}`);
      tmux(["set-option", "-t", name, "window-size", "manual"]);
      tmux(["resize-window", "-t", name, "-x", "80", "-y", "24"]);
      const meta: TerminalMeta = { id, owner, label: opts?.label ?? shell, backend: "tmux", cwd, shell, durable: true, createdAt: Date.now(), tmuxName: name };
      const session = this.tmuxSessionObject(meta);
      if (session.transcriptFile) tmux(["pipe-pane", "-o", "-t", name, `cat >> ${JSON.stringify(session.transcriptFile)}`]);
      session.exited = this.attachTmux(session, 0);
      this.sessions.set(id, session);
      this.writeMeta(session);
      return session;
    }
    const pty = await loadPty();
    let session: TerminalSession;
    if (pty?.spawn) {
      const term = pty.spawn(shell, [], { cwd, env: { ...process.env, TERM: "xterm-256color" }, cols: 80, rows: 24 });
      session = {
        id, owner, label: opts?.label ?? shell, ring, alive: true, backend: "node-pty",
        cwd, shell, durable: false, createdAt: Date.now(), transcriptFile: this.transcriptFor(owner, id),
        write: (d) => term.write(d),
        resize: (cols, rows) => { try { term.resize(cols, rows); } catch { /* exited */ } },
        kill: (sig) => { try { term.kill(sig); } catch { /* exited */ } },
        exited: new Promise((resolve) => term.onExit(({ exitCode, signal }: any) => { session.alive = false; resolve({ code: exitCode ?? null, signal: signal ?? null }); })),
      };
      term.onData((d: string) => this.mirror(session, stripAnsi(d)));
    } else {
      const proc: ChildProcess = spawn("script", ["-q", "-e", "-c", `cd ${JSON.stringify(cwd)} && exec ${shell}`, "/dev/null"], {
        stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "dumb", PS1: "" },
      });
      session = {
        id, owner, label: opts?.label ?? shell, ring, alive: true, backend: "script",
        cwd, shell, durable: false, createdAt: Date.now(), transcriptFile: this.transcriptFor(owner, id),
        write: (d) => { proc.stdin?.write(d); },
        resize: () => { throw new Error("terminal_resize requires the node-pty backend"); },
        kill: (sig) => { proc.kill((sig ?? "SIGTERM") as NodeJS.Signals); },
        exited: new Promise((resolve) => proc.once("exit", (code, signal) => { session.alive = false; resolve({ code, signal }); })),
      };
      proc.stdout?.on("data", (d: Buffer) => this.mirror(session, stripAnsi(d.toString("utf8"))));
      proc.stderr?.on("data", (d: Buffer) => this.mirror(session, stripAnsi(d.toString("utf8"))));
    }
    this.sessions.set(id, session);
    this.writeMeta(session);
    return session;
  }
  get(owner: string, id: string): TerminalSession {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) throw new Error(`unknown terminal: ${id}`);
    return s;
  }
  list(owner: string): Array<{ id: string; label: string; alive: boolean; backend: string; durable: boolean; cwd: string }> {
    return [...this.sessions.values()].filter((s) => s.owner === owner).map((s) => ({ id: s.id, label: s.label, alive: s.alive, backend: s.backend, durable: s.durable, cwd: s.cwd }));
  }
  send(owner: string, id: string, input: string): void {
    const s = this.get(owner, id);
    if (!s.alive) throw new Error(`terminal ${id} has exited`);
    s.write(input.endsWith("\n") || input.endsWith("\r") ? input : input + (s.backend === "node-pty" ? "\r" : "\n"));
  }
  signal(owner: string, id: string, signalName: string): void {
    const s = this.get(owner, id);
    // TTY line discipline: SIGINT etc. to the foreground job is Ctrl-C through the PTY.
    if (s.backend === "node-pty" && signalName === "SIGINT") s.write("\x03");
    else if (s.backend === "tmux" && signalName === "SIGINT" && s.tmuxName) tmux(["send-keys", "-t", s.tmuxName, "C-c"]);
    else s.kill(signalName);
  }
  resize(owner: string, id: string, cols: number, rows: number): void {
    this.get(owner, id).resize(cols, rows);
  }
  async close(owner: string, id: string): Promise<void> {
    const s = this.get(owner, id);
    s.kill("SIGTERM");
    await Promise.race([s.exited, new Promise((r) => setTimeout(r, 2000))]);
    if (s.alive) s.kill("SIGKILL");
    this.stopPolling(id);
    this.sessions.delete(id);
    try { const dir = this.dirFor(owner); if (dir) unlinkSync(join(dir, `${id}.json`)); } catch { /* already gone */ }
  }
  /** Session teardown. Durable tmux terminals survive when keepDurable is set:
   * polling stops but the tmux session and its metadata stay for reattach. */
  async disposeOwner(owner: string, opts?: { keepDurable?: boolean }): Promise<void> {
    const owned = [...this.sessions.values()].filter((s) => s.owner === owner);
    for (const s of owned) {
      if (opts?.keepDurable && s.durable && s.backend === "tmux") { this.stopPolling(s.id); this.sessions.delete(s.id); }
    }
    await Promise.allSettled(owned.filter((s) => !(opts?.keepDurable && s.durable && s.backend === "tmux")).map((s) => this.close(owner, s.id)));
  }
}

/** Persistent bash over a dedicated PTY session (dsh tool-bash-persistent). Sequential per owner. */
export class PersistentBash {
  terminals: TerminalRegistry; owner: string; cwd: string; shellName: string;
  private session: TerminalSession | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(terminals: TerminalRegistry, owner: string, cwd: string, shellName = "bash") {
    this.terminals = terminals; this.owner = owner; this.cwd = cwd; this.shellName = shellName;
  }

  run(command: string, timeoutMs = 300_000): Promise<{ text: string; exitCode: number | null; reset: boolean }> {
    const task = async () => {
      if (!this.session || !this.session.alive) {
        this.session = await this.terminals.open(this.owner, { cwd: this.cwd, label: `${this.shellName}-persistent`, shell: this.shellName });
        await new Promise((r) => setTimeout(r, 300));
        this.session.ring.readNew();
      }
      const s = this.session;
      const marker = `__PIDSH_DONE_${Math.random().toString(36).slice(2)}__`;
      const before = s.ring.all().length;
      const isPwsh = this.shellName.includes("pwsh") || this.shellName.includes("powershell");
      s.write(isPwsh ? `${command}\nWrite-Output "${marker}:$LASTEXITCODE"\n` : `${command}\necho ${marker}:$?\n`);
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (!s.alive) {
          const out = s.ring.all().slice(before);
          this.session = undefined;
          return { text: `${cleanEcho(out, command, marker)}\n[shell exited] The next call starts a fresh shell in the workspace.`, exitCode: null, reset: true };
        }
        const all = s.ring.all().slice(before);
        const m = all.match(new RegExp(`${marker}:(\\d+)`));
        if (m) {
          const end = all.indexOf(m[0]);
          return { text: `${cleanEcho(all.slice(0, end), command, marker)}\n[Command finished with exit code ${m[1]}]`, exitCode: Number(m[1]), reset: false };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      await this.terminals.close(this.owner, s.id).catch(() => undefined);
      this.session = undefined;
      return { text: "[command timed out; shell reset] The next call starts a fresh shell in the workspace.", exitCode: null, reset: true };
    };
    const result = this.chain.then(task, task);
    this.chain = result.catch(() => undefined);
    return result;
  }
}

function cleanEcho(out: string, command: string, marker: string): string {
  return out.split("\n").filter((l) => !l.includes(marker) && l.trim() !== command.trim() && !l.includes(`echo ${marker}`)).join("\n").replace(/\r/g, "").trim();
}

/** Pids in process group `pgid` other than `except`, read from /proc; undefined where /proc is not available. */
function groupMembers(pgid: number, except: number): number[] | undefined {
  let names: string[];
  try { names = readdirSync("/proc"); } catch { return undefined; }
  const members: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === except) continue;
    try {
      // stat is "pid (comm) state ppid pgrp ..."; comm may hold spaces and parentheses, so split after the last ")".
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) members.push(Number(name));
    } catch { /* exited while scanning */ }
  }
  return members;
}

/** One-shot bash as a job-friendly spawn: resolves on exit, streams into the ring, honors the job signal.
 * With a sandbox mode, the shell runs under bubblewrap (root read-only, workspace per mode). */
export function runShellJob(opts: {
  command: string; cwd: string; signal: AbortSignal; append: (t: string) => void;
  onSpawn?: (p: ChildProcess) => void; sandboxMode?: SandboxMode; shell?: string;
  outFile?: string; exitFile?: string;
  /** Operator-asserted bwrap-compatible runner prefix (dsh sandbox-local runnerCommand). */
  sandboxRunner?: string[];
  /** How long a cancelled job gets between SIGTERM and SIGKILL to clean up. */
  killGraceMs?: number;
}): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const shell = opts.shell ?? "bash";
    const sandboxed = opts.sandboxMode !== undefined && opts.sandboxMode !== "danger-full-access";
    const runner = opts.sandboxRunner && opts.sandboxRunner.length > 0 ? opts.sandboxRunner : ["/usr/bin/bwrap"];
    if (sandboxed && !opts.sandboxRunner?.length && !existsSync("/usr/bin/bwrap")) { reject(new Error("sandbox-unavailable: bubblewrap not found at /usr/bin/bwrap")); return; }
    if (sandboxed && !probeSandboxRunner(opts.sandboxRunner, opts.cwd)) { reject(new Error(`sandbox-unavailable: runner ${runner[0]} failed its functional probe (fails closed, command not run unconfined)`)); return; }
    // Durable mode: the shell itself writes output/exit files, so a detached job
    // keeps producing evidence after the pi process dies.
    const command = opts.outFile && opts.exitFile
      ? `( ${opts.command} ) > ${JSON.stringify(opts.outFile)} 2>&1; printf %s $? > ${JSON.stringify(opts.exitFile)}`
      : opts.command;
    const proc = sandboxed
      ? spawn(runner[0] as string, [...runner.slice(1), ...bwrapArgs(opts.sandboxMode as SandboxMode, opts.cwd), shell, "-c", command], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true })
      : spawn(shell, ["-c", command], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    opts.onSpawn?.(proc);
    const signalTree = (sig: NodeJS.Signals) => { try { if (proc.pid) process.kill(-proc.pid, sig); } catch { proc.kill(sig); } };
    // bwrap exits on SIGTERM and takes the sandbox down with it, so a group-wide SIGTERM races the job's own handler.
    // Ask only the processes inside the sandbox to stop, and let bwrap end when they do.
    const askToStop = () => {
      const inside = sandboxed && proc.pid ? groupMembers(proc.pid, proc.pid) : undefined;
      if (!inside?.length) { signalTree("SIGTERM"); return; }
      for (const pid of inside) { try { process.kill(pid, "SIGTERM"); } catch { /* exited */ } }
    };
    // Cancel with SIGTERM so the job can release locks and temp files, then SIGKILL whatever is left (dsh jobs-local).
    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      cancelled = true;
      askToStop();
      killTimer = setTimeout(() => signalTree("SIGKILL"), opts.killGraceMs ?? 3000);
      killTimer.unref?.();
    };
    const release = () => {
      clearTimeout(killTimer);
      opts.signal.removeEventListener("abort", onAbort);
      if (cancelled) signalTree("SIGKILL"); // sweep stragglers that outlived the shell
    };
    if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener("abort", onAbort, { once: true });
    proc.stdout?.on("data", (d: Buffer) => opts.append(d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => opts.append(d.toString("utf8")));
    proc.once("error", (e) => { release(); reject(e); });
    proc.once("exit", (code) => { release(); resolve({ exitCode: code }); });
  });
}
