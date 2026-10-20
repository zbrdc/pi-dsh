/** Persistent PTY seam (dsh ctx.terminals). Backends: node-pty when the optional
 * @lydell/node-pty dependency loads, else util-linux `script`. Owner-scoped sessions
 * with bounded output rings, resize, and signals. Also owns job bash execution. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { OutputRing, stripAnsi, bwrapArgs, type SandboxMode } from "./core.ts";

let seq = 0;
export interface TerminalSession {
  id: string; owner: string; label: string; ring: OutputRing; alive: boolean;
  backend: "node-pty" | "script";
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  exited: Promise<{ code: number | null; signal: string | null }>;
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

  async open(owner: string, opts?: { cwd?: string; label?: string; shell?: string }): Promise<TerminalSession> {
    const id = `term-${++seq}`;
    const cwd = opts?.cwd ?? process.cwd();
    const shell = opts?.shell ?? "bash";
    const ring = new OutputRing(256 * 1024);
    const pty = await loadPty();
    let session: TerminalSession;
    if (pty?.spawn) {
      const term = pty.spawn(shell, [], { cwd, env: { ...process.env, TERM: "xterm-256color" }, cols: 80, rows: 24 });
      session = {
        id, owner, label: opts?.label ?? shell, ring, alive: true, backend: "node-pty",
        write: (d) => term.write(d),
        resize: (cols, rows) => { try { term.resize(cols, rows); } catch { /* exited */ } },
        kill: (sig) => { try { term.kill(sig); } catch { /* exited */ } },
        exited: new Promise((resolve) => term.onExit(({ exitCode, signal }: any) => { session.alive = false; resolve({ code: exitCode ?? null, signal: signal ?? null }); })),
      };
      term.onData((d: string) => ring.append(stripAnsi(d)));
    } else {
      const proc: ChildProcess = spawn("script", ["-q", "-e", "-c", `cd ${JSON.stringify(cwd)} && exec ${shell}`, "/dev/null"], {
        stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "dumb", PS1: "" },
      });
      proc.stdout?.on("data", (d: Buffer) => ring.append(stripAnsi(d.toString("utf8"))));
      proc.stderr?.on("data", (d: Buffer) => ring.append(stripAnsi(d.toString("utf8"))));
      session = {
        id, owner, label: opts?.label ?? shell, ring, alive: true, backend: "script",
        write: (d) => { proc.stdin?.write(d); },
        resize: () => { throw new Error("terminal_resize requires the node-pty backend"); },
        kill: (sig) => { proc.kill((sig ?? "SIGTERM") as NodeJS.Signals); },
        exited: new Promise((resolve) => proc.once("exit", (code, signal) => { session.alive = false; resolve({ code, signal }); })),
      };
    }
    this.sessions.set(id, session);
    return session;
  }
  get(owner: string, id: string): TerminalSession {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) throw new Error(`unknown terminal: ${id}`);
    return s;
  }
  list(owner: string): Array<{ id: string; label: string; alive: boolean; backend: string }> {
    return [...this.sessions.values()].filter((s) => s.owner === owner).map((s) => ({ id: s.id, label: s.label, alive: s.alive, backend: s.backend }));
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
    this.sessions.delete(id);
  }
  async disposeOwner(owner: string): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].filter((s) => s.owner === owner).map((s) => this.close(owner, s.id)));
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

/** One-shot bash as a job-friendly spawn: resolves on exit, streams into the ring, honors the job signal.
 * With a sandbox mode, the shell runs under bubblewrap (root read-only, workspace per mode). */
export function runShellJob(opts: {
  command: string; cwd: string; signal: AbortSignal; append: (t: string) => void;
  onSpawn?: (p: ChildProcess) => void; sandboxMode?: SandboxMode; shell?: string;
  outFile?: string; exitFile?: string;
}): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const shell = opts.shell ?? "bash";
    const sandboxed = opts.sandboxMode !== undefined && opts.sandboxMode !== "danger-full-access";
    if (sandboxed && !existsSync("/usr/bin/bwrap")) { reject(new Error("sandbox-unavailable: bubblewrap not found at /usr/bin/bwrap")); return; }
    // Durable mode: the shell itself writes output/exit files, so a detached job
    // keeps producing evidence after the pi process dies.
    const command = opts.outFile && opts.exitFile
      ? `( ${opts.command} ) > ${JSON.stringify(opts.outFile)} 2>&1; printf %s $? > ${JSON.stringify(opts.exitFile)}`
      : opts.command;
    const proc = sandboxed
      ? spawn("/usr/bin/bwrap", [...bwrapArgs(opts.sandboxMode as SandboxMode, opts.cwd), shell, "-c", command], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true })
      : spawn(shell, ["-c", command], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    opts.onSpawn?.(proc);
    const killTree = () => { try { if (proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); } };
    const onAbort = () => killTree();
    if (opts.signal.aborted) killTree(); else opts.signal.addEventListener("abort", onAbort, { once: true });
    proc.stdout?.on("data", (d: Buffer) => opts.append(d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => opts.append(d.toString("utf8")));
    proc.once("error", (e) => { opts.signal.removeEventListener("abort", onAbort); reject(e); });
    proc.once("exit", (code) => { opts.signal.removeEventListener("abort", onAbort); resolve({ exitCode: code }); });
  });
}
