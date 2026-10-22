/** PTC execution seam (dsh ctx.ptcRuntime): resolve(request) -> run(spec).
 * Providers: Node per-call process (+ persistent-in-memory owner), mossbed (pure compute). */
import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLosslessJson, bwrapArgs, type SandboxMode } from "./core.ts";
import { probeSandboxRunner } from "./terminal.ts";

export type PtcBindings = Record<string, Record<string, (args: any) => Promise<any>>>;
export interface PtcRequest {
  program: string; bindings?: PtcBindings; cwd?: string;
  timeoutMs?: number | null; signal?: AbortSignal; prelude?: string;
  stateOwner?: string; sandboxMode?: SandboxMode; sandboxRunner?: string[];
}
export type PtcErrorKind = "exception" | "timeout" | "abort" | "worker-exit" | "invalid-output" | "protocol" | "sandbox-unavailable" | "output-limit";
export interface PtcResult {
  value?: unknown; logs: string[];
  error?: { kind: PtcErrorKind; message: string };
}

/** Resource bounds on one program (dsh ptc-runtime-node config). */
export interface PtcLimits {
  /** Combined bytes of serialized logs and the return value. */
  maxOutputBytes: number;
  /** Binding calls a program may have in flight at once. */
  maxPendingCalls: number;
  /** Bytes of binding-call arguments in flight at once. */
  maxMessageBytes: number;
  /** How long a program that was told to stop may keep running before it is killed. */
  graceMs: number;
}
export const DEFAULT_PTC_LIMITS: PtcLimits = { maxOutputBytes: 67_108_864, maxPendingCalls: 128, maxMessageBytes: 134_217_728, graceMs: 3000 };

/** Positive integers from config, else the dsh defaults. */
export function ptcLimitsFrom(config: Partial<PtcLimits>): PtcLimits {
  const pick = (value: unknown, fallback: number) => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback);
  return {
    maxOutputBytes: pick(config.maxOutputBytes, DEFAULT_PTC_LIMITS.maxOutputBytes),
    maxPendingCalls: pick(config.maxPendingCalls, DEFAULT_PTC_LIMITS.maxPendingCalls),
    maxMessageBytes: pick(config.maxMessageBytes, DEFAULT_PTC_LIMITS.maxMessageBytes),
    graceMs: pick(config.graceMs, DEFAULT_PTC_LIMITS.graceMs),
  };
}

/** Ask a process to stop with SIGTERM and kill it if it is still running after `graceMs` (dsh terminateProcess). */
function stopProcess(proc: ChildProcess, graceMs: number): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  const timer = setTimeout(() => proc.kill("SIGKILL"), graceMs);
  timer.unref?.();
  proc.once("exit", () => clearTimeout(timer));
}

/** Append `text` to `into` unless the running byte total would pass `cap`. */
function keepWithinCap(into: { logs: string[]; bytes: number }, text: string, cap: number): void {
  const cost = Buffer.byteLength(JSON.stringify(text)) + 1;
  if (into.bytes + cost > cap) return;
  into.bytes += cost;
  into.logs.push(text);
}

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "ptc-child.mjs");
const STDERR_TAIL_CHARS = 2048;
let runSeq = 0;

const isSandboxed = (req: PtcRequest): req is PtcRequest & { sandboxMode: SandboxMode } =>
  req.sandboxMode !== undefined && req.sandboxMode !== "danger-full-access";

/** A confined run fails closed: no bubblewrap, or a runner that cannot confine, means the program does not start. */
function sandboxFailure(req: PtcRequest): PtcResult | undefined {
  if (!isSandboxed(req)) return undefined;
  if (!req.sandboxRunner?.length && !existsSync("/usr/bin/bwrap")) {
    return { logs: [], error: { kind: "sandbox-unavailable", message: "bubblewrap not found at /usr/bin/bwrap" } };
  }
  if (!probeSandboxRunner(req.sandboxRunner, req.cwd ?? process.cwd())) {
    return { logs: [], error: { kind: "sandbox-unavailable", message: "sandbox runner failed its functional probe (fails closed)" } };
  }
  return undefined;
}

interface RunSpec {
  program: string; namespaces: Record<string, string[]>; prelude: string; persistent: boolean;
  timeoutMs: number | null; signal?: AbortSignal;
}
interface SessionOptions { cwd: string; sandboxMode?: SandboxMode; sandboxRunner?: string[]; limits: PtcLimits }

class NodeSession {
  proc: ChildProcess;
  private doneWaiters = new Map<number, (m: any) => void>();
  exited = false;
  /** Set when the host ended the child itself for a limit, so the result names the limit instead of a bare worker-exit. */
  private failure: { kind: PtcErrorKind; message: string } | undefined;
  private stderrTail = "";
  private exitSummary = "";
  private pendingCalls = 0;
  private pendingBytes = 0;
  /** Logs the running program has produced so far, kept host-side so a stopped program still reports its output. */
  private streamed = { logs: [] as string[], bytes: 2 };
  private activeRun = 0;
  private limits: PtcLimits;
  bindingsFn: () => PtcBindings;
  constructor(bindings: () => PtcBindings, opts: SessionOptions) {
    this.bindingsFn = bindings;
    this.limits = opts.limits;
    const sandboxed = opts.sandboxMode !== undefined && opts.sandboxMode !== "danger-full-access";
    const runner = opts.sandboxRunner && opts.sandboxRunner.length > 0 ? opts.sandboxRunner : ["/usr/bin/bwrap"];
    this.proc = sandboxed
      ? fork(CHILD, [], { cwd: opts.cwd, env: { HOME: "/tmp" }, silent: true, execPath: runner[0] as string, execArgv: [...runner.slice(1), ...bwrapArgs(opts.sandboxMode as SandboxMode, opts.cwd), process.execPath, "--max-old-space-size=512"] })
      : fork(CHILD, [], { cwd: opts.cwd, env: {}, silent: true, execArgv: ["--max-old-space-size=512"] });
    // Drain stdout so an unread pipe cannot block a child that writes to it synchronously, and keep the stderr tail so a crash has a diagnostic.
    this.proc.stdout?.resume();
    this.proc.stderr?.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-STDERR_TAIL_CHARS); });
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitSummary = code !== null ? `code ${code}` : `signal ${signal}`;
    });
    this.proc.on("message", (msg: any) => {
      if (msg?.type === "call") void this.handleCall(msg);
      else if (msg?.type === "log") { if (msg.runId === this.activeRun) keepWithinCap(this.streamed, String(msg.text), this.limits.maxOutputBytes); }
      else if (msg?.type === "done") {
        this.doneWaiters.get(msg.runId)?.(msg);
        this.doneWaiters.delete(msg.runId);
      }
    });
  }
  private reply(message: object): void {
    if (this.exited || !this.proc.connected) return; // the program is gone; its in-flight calls finish unheard
    this.proc.send(message, () => undefined);
  }
  /** Stop the child for a timeout, abort or limit breach; the pending run reports `kind` with `message` and the output so far. */
  private terminate(kind: PtcErrorKind, message: string): void {
    if (this.failure) return;
    this.failure = { kind, message };
    stopProcess(this.proc, this.limits.graceMs);
  }
  private async handleCall(msg: any): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(msg.args ?? null));
    this.pendingCalls++;
    this.pendingBytes += bytes;
    try {
      if (this.pendingCalls > this.limits.maxPendingCalls || this.pendingBytes > this.limits.maxMessageBytes) {
        this.terminate("protocol", "pending binding calls exceed configured limits");
        return;
      }
      const [ns, fn] = String(msg.fn).split(".");
      const f = this.bindingsFn()[ns ?? ""]?.[fn ?? ""];
      if (!f) throw new Error(`unknown binding: ${msg.fn}`);
      const v = await f(msg.args?.[0]);
      this.reply({ type: "call-result", callId: msg.callId, ok: true, value: v === undefined ? null : v });
    } catch (e) {
      this.reply({ type: "call-result", callId: msg.callId, ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.pendingCalls--;
      this.pendingBytes -= bytes;
    }
  }
  private exitMessage(): string {
    const tail = this.stderrTail.trim();
    return `worker process exited (${this.exitSummary})${tail ? `: ${tail}` : ""}`;
  }
  /** Failure text plus the stderr tail, so a stopped program leaves a diagnostic. */
  private withStderr(message: string): string {
    const tail = this.stderrTail.trim();
    return tail ? `${message}: ${tail}` : message;
  }
  run(spec: RunSpec): Promise<any> {
    const runId = ++runSeq;
    this.activeRun = runId;
    this.streamed = { logs: [], bytes: 2 };
    return new Promise((resolve) => {
      if (spec.signal?.aborted) { resolve({ __kind: "abort", message: "aborted", logs: [] }); return; }
      const timer = spec.timeoutMs === null ? undefined : setTimeout(() => this.terminate("timeout", "program timed out"), spec.timeoutMs);
      const onAbort = () => this.terminate("abort", "aborted");
      spec.signal?.addEventListener("abort", onAbort, { once: true });
      const settle = () => { clearTimeout(timer); spec.signal?.removeEventListener("abort", onAbort); };
      this.doneWaiters.set(runId, (m) => { settle(); resolve(m); });
      this.proc.once("exit", () => {
        settle();
        const stopped = this.failure;
        resolve({
          __kind: stopped?.kind ?? "worker-exit",
          message: stopped ? this.withStderr(stopped.message) : this.exitMessage(),
          logs: this.streamed.logs,
        });
      });
      this.proc.send({
        type: "run", runId, code: spec.program, namespaces: spec.namespaces, prelude: spec.prelude, persistent: spec.persistent,
        maxOutputBytes: this.limits.maxOutputBytes,
      });
    });
  }
  dispose(): void { if (!this.exited) this.proc.kill("SIGKILL"); }
}

export class NodePtcProvider {
  readonly language = "typescript";
  readonly timeout = { defaultMs: 120_000, maxMs: 600_000 };
  private persistent = new Map<string, NodeSession>();
  private chains = new Map<string, Promise<unknown>>();
  private limits: PtcLimits;
  constructor(limits: PtcLimits = DEFAULT_PTC_LIMITS) { this.limits = limits; }

  async run(req: PtcRequest): Promise<PtcResult> {
    const unavailable = sandboxFailure(req);
    if (unavailable) return unavailable;
    const timeoutMs = req.timeoutMs === null ? null : Math.min(Math.max(1, req.timeoutMs ?? this.timeout.defaultMs), this.timeout.maxMs);
    const namespaces: Record<string, string[]> = {};
    for (const [ns, fns] of Object.entries(req.bindings ?? {})) namespaces[ns] = Object.keys(fns);
    const open = () => new NodeSession(() => req.bindings ?? {}, { cwd: req.cwd ?? process.cwd(), sandboxMode: req.sandboxMode, sandboxRunner: req.sandboxRunner, limits: this.limits });
    const exec = async (): Promise<PtcResult> => {
      let session: NodeSession;
      let persistent = false;
      if (req.stateOwner) {
        persistent = true;
        session = this.persistent.get(req.stateOwner) ?? open();
        if (session.exited) session = open();
        this.persistent.set(req.stateOwner, session);
      } else {
        session = open();
      }
      try {
        const msg = await session.run({ program: req.program, namespaces, prelude: req.prelude ?? "", persistent, timeoutMs, signal: req.signal });
        if (msg?.__kind) return { logs: msg.logs ?? [], error: { kind: msg.__kind, message: msg.message ?? String(msg.__kind) } };
        if (!msg?.ok) {
          // Retained variables cannot be trusted after an output overflow, so the persistent process is dropped (dsh).
          if (msg?.errorKind === "output-limit" && req.stateOwner) this.release(req.stateOwner);
          return { logs: msg?.logs ?? [], error: { kind: msg?.errorKind ?? "exception", message: msg?.error ?? "program failed" } };
        }
        try { assertLosslessJson(msg.value); } catch (e) { return { logs: msg.logs ?? [], error: { kind: "invalid-output", message: e instanceof Error ? e.message : String(e) } }; }
        return { value: msg.value, logs: msg.logs ?? [] };
      } finally {
        if (!persistent) session.dispose();
      }
    };
    if (req.stateOwner) {
      const prev = this.chains.get(req.stateOwner) ?? Promise.resolve();
      const next = prev.then(exec, exec);
      this.chains.set(req.stateOwner, next);
      return next;
    }
    return exec();
  }
  release(owner: string): void { this.persistent.get(owner)?.dispose(); this.persistent.delete(owner); }
  disposeAll(): void { for (const s of this.persistent.values()) s.dispose(); this.persistent.clear(); }
}

/** Mossbed provider: MCP stdio client to the tardigrade-runner binary. Pure compute only:
 * the guest has no host bindings, no Node, no filesystem, and no network unless granted. */
export class MossbedProvider {
  readonly language = "javascript";
  private bin: string;
  constructor() {
    this.bin = process.env["MOSSBED_BIN"] ?? join(homedir(), ".local/bin/mossbed");
  }
  available(): boolean { return existsSync(this.bin); }
  async run(req: PtcRequest): Promise<PtcResult> {
    if (!this.available()) return { logs: [], error: { kind: "sandbox-unavailable", message: `mossbed binary not found at ${this.bin}` } };
    // Host bridge: a per-run loopback HTTP endpoint granted to the guest by NAME
    // only (vm.net.request('tools', body)). The URL and its token are operator-side
    // env for the mossbed process we spawn; the guest never sees either.
    let bridge: { url: string; close: () => Promise<void> } | undefined;
    let prelude = "";
    const bindingNames = Object.entries(req.bindings ?? {});
    if (bindingNames.length > 0) {
      bridge = await startToolBridge(req.bindings ?? {});
      const parts: string[] = [
        "const __bridgeCall = async (fn, args) => { const r = await vm.net.request('tools', JSON.stringify({ fn, args })); const p = JSON.parse(r.text); if (!p.ok) throw new Error(p.error); return p.value; };",
      ];
      for (const [ns, fns] of bindingNames) {
        const fnsJs = Object.keys(fns).map((f) => `${JSON.stringify(f)}: (args) => __bridgeCall(${JSON.stringify(`${ns}.${f}`)}, args)`).join(", ");
        parts.push(`const ${ns} = { ${fnsJs} };`);
      }
      prelude = parts.join("\n") + "\n";
    }
    try {
      return await this.runGuest(req, prelude, bridge?.url);
    } finally {
      await bridge?.close();
    }
  }
  private async runGuest(req: PtcRequest, prelude: string, bridgeUrl?: string): Promise<PtcResult> {
    return new Promise((resolve) => {
      const env: Record<string, string | undefined> = { ...process.env, TARDIGRADE_BIN: process.env["TARDIGRADE_BIN"] ?? join(homedir(), ".local/bin/tardigrade") };
      if (bridgeUrl) { env["MOSSBED_ALLOW_CALL"] = `tools=${bridgeUrl},POST`; env["MOSSBED_NET_ALLOW_PRIVATE"] = "1"; }
      const proc = spawn(this.bin, [], { stdio: ["pipe", "pipe", "pipe"], env });
      let buf = ""; let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; proc.kill("SIGKILL"); resolve({ logs: [], error: { kind: "timeout", message: "mossbed run timed out" } }); } }, req.timeoutMs === null ? 600_000 : (req.timeoutMs ?? 120_000));
      const send = (o: unknown) => proc.stdin?.write(JSON.stringify(o) + "\n");
      proc.stdout?.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg: any; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_js", arguments: { module: true, code: `${prelude}const __r = await (async () => { ${req.program} })(); console.log(JSON.stringify(__r ?? null));` } } });
          } else if (msg.id === 2 && !done) {
            done = true; clearTimeout(timer); proc.kill();
            const sc = msg.result?.structuredContent;
            const stdout = String(sc?.stdout ?? "");
            const lines = stdout.trim().split("\n").filter(Boolean);
            let value: unknown = null;
            try { value = JSON.parse(lines[lines.length - 1] ?? "null"); } catch { value = null; }
            if (sc?.status && sc.status !== "ok") resolve({ logs: [stdout], error: { kind: "exception", message: String(sc.stderr ?? sc.status) } });
            else resolve({ value, logs: lines.slice(0, -1) });
          }
        }
      });
      proc.once("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ logs: [], error: { kind: "worker-exit", message: e.message } }); } });
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-dsh", version: "0.1.0" } } });
    });
  }
}

/** Python provider: one CPython subprocess per run, synchronous tool bridge.
 * Program assigns `result`; tools are called as tools.<name>(args_dict).
 * Under a sandbox mode the interpreter runs inside the same bubblewrap profile as Node, so choosing this backend never widens access. */
export class PythonPtcProvider {
  readonly language = "python";
  private limits: PtcLimits;
  constructor(limits: PtcLimits = DEFAULT_PTC_LIMITS) { this.limits = limits; }

  private launch(req: PtcRequest, script: string): ChildProcess {
    const cwd = req.cwd ?? process.cwd();
    if (!isSandboxed(req)) return spawn("python3", ["-u", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const runner = req.sandboxRunner?.length ? req.sandboxRunner : ["/usr/bin/bwrap"];
    return spawn(runner[0] as string, [...runner.slice(1), ...bwrapArgs(req.sandboxMode, cwd), "python3", "-u", script], {
      cwd, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/tmp" },
    });
  }

  async run(req: PtcRequest): Promise<PtcResult> {
    const unavailable = sandboxFailure(req);
    if (unavailable) return unavailable;
    const script = join(dirname(fileURLToPath(import.meta.url)), "ptc-child.py");
    return new Promise((resolve) => {
      const proc = this.launch(req, script);
      let buf = ""; let done = false; let stderrTail = "";
      const streamed = { logs: [] as string[], bytes: 2 };
      /** Why the host asked the program to stop; the process is gone by the time this is reported. */
      let stopping: { kind: PtcErrorKind; message: string } | undefined;
      const withStderr = (message: string) => (stderrTail.trim() ? `${message}: ${stderrTail.trim()}` : message);
      const finish = (r: PtcResult) => { if (!done) { done = true; clearTimeout(timer); try { proc.kill("SIGKILL"); } catch { /* gone */ } resolve(r); } };
      /** Timeout, abort and limit breaches stop the program with SIGTERM, then report once it has exited with what it logged. */
      const stop = (kind: PtcErrorKind, message: string) => {
        if (done || stopping) return;
        stopping = { kind, message };
        stopProcess(proc, this.limits.graceMs);
      };
      const timer = setTimeout(() => stop("timeout", "python program timed out"), req.timeoutMs === null ? 600_000 : Math.min(req.timeoutMs ?? 120_000, 600_000));
      if (req.signal?.aborted) stop("abort", "aborted");
      else req.signal?.addEventListener("abort", () => stop("abort", "aborted"), { once: true });
      proc.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString("utf8")).slice(-STDERR_TAIL_CHARS); });
      proc.stdout?.on("data", async (d: Buffer) => {
        buf += d.toString("utf8");
        if (buf.length > this.limits.maxMessageBytes) { stop("protocol", "python program wrote an oversized message"); return; }
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg: any; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "log") keepWithinCap(streamed, String(msg.text), this.limits.maxOutputBytes);
          else if (msg.type === "call") {
            const [ns, fn] = String(msg.fn).split(".");
            try {
              const f = (req.bindings ?? {})[ns ?? ""]?.[fn ?? ""];
              if (!f) throw new Error(`unknown binding: ${msg.fn}`);
              const v = await f(msg.args?.[0]);
              proc.stdin?.write(JSON.stringify({ type: "call-result", callId: msg.callId, ok: true, value: v ?? null }) + "\n");
            } catch (e) {
              proc.stdin?.write(JSON.stringify({ type: "call-result", callId: msg.callId, ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n");
            }
          } else if (msg.type === "done") {
            if (!msg.ok) finish({ logs: msg.logs ?? [], error: { kind: msg.errorKind ?? "exception", message: msg.error ?? "python program failed" } });
            else {
              try { assertLosslessJson(msg.value); finish({ value: msg.value, logs: msg.logs ?? [] }); }
              catch (e) { finish({ logs: msg.logs ?? [], error: { kind: "invalid-output", message: e instanceof Error ? e.message : String(e) } }); }
            }
          }
        }
      });
      proc.once("error", (e) => finish({ logs: [], error: { kind: "worker-exit", message: e.message } }));
      // "close", not "exit": stdout is fully read by then, so a finished program's result is not mistaken for a crash.
      proc.once("close", (code, signal) => {
        if (stopping) { finish({ logs: streamed.logs, error: { kind: stopping.kind, message: withStderr(stopping.message) } }); return; }
        const tail = stderrTail.trim();
        finish({ logs: streamed.logs, error: { kind: "worker-exit", message: `python process exited (${code !== null ? `code ${code}` : `signal ${signal}`})${tail ? `: ${tail}` : ""}` } });
      });
      const namespaces: Record<string, string[]> = {};
      for (const [ns, fns] of Object.entries(req.bindings ?? {})) namespaces[ns] = Object.keys(fns);
      proc.stdin?.write(JSON.stringify({ code: req.program, namespaces, maxOutputBytes: this.limits.maxOutputBytes }) + "\n");
    });
  }
}

/** Per-run loopback tool bridge for the mossbed guest. Token lives in the granted
 * URL (operator-side only); responses are capped below mossbed's 1 MiB net budget. */
async function startToolBridge(bindings: PtcBindings): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const token = randomUUID();
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url !== `/call/${token}` || req.method !== "POST") return reply(404, { ok: false, error: "not found" });
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 900_000) return reply(413, { ok: false, error: "bridge request too large; pass a spill path instead" }); }
    try {
      const { fn, args } = JSON.parse(raw) as { fn: string; args: unknown };
      const [ns, name] = String(fn).split(".");
      const f = bindings[ns ?? ""]?.[name ?? ""];
      if (!f) return reply(400, { ok: false, error: `unknown binding: ${fn}` });
      const value = (await f(args)) ?? null;
      const text = JSON.stringify({ ok: true, value });
      if (text.length > 900_000) return reply(413, { ok: false, error: "tool result exceeds mossbed net budget (1 MiB); narrow the call or use the node backend" });
      res.writeHead(200, { "content-type": "application/json" }); res.end(text);
    } catch (e) {
      reply(200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("bridge listen failed");
  return {
    url: `http://127.0.0.1:${addr.port}/call/${token}`,
    close: () => new Promise<void>((r) => { server.close(() => r()); setTimeout(r, 500).unref?.(); }),
  };
}
