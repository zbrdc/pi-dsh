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
export interface PtcResult {
  value?: unknown; logs: string[];
  error?: { kind: "exception" | "timeout" | "abort" | "worker-exit" | "invalid-output" | "protocol" | "sandbox-unavailable"; message: string };
}

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "ptc-child.mjs");
let runSeq = 0;

class NodeSession {
  proc: ChildProcess;
  private callWaiters = new Map<string, { resolve: (m: any) => void }>();
  private doneWaiters = new Map<number, (m: any) => void>();
  exited = false;
  bindingsFn: () => PtcBindings;
  constructor(bindings: () => PtcBindings, cwd: string, sandboxMode?: SandboxMode, sandboxRunner?: string[]) { this.bindingsFn = bindings;
    const sandboxed = sandboxMode !== undefined && sandboxMode !== "danger-full-access";
    const runner = sandboxRunner && sandboxRunner.length > 0 ? sandboxRunner : ["/usr/bin/bwrap"];
    this.proc = sandboxed
      ? fork(CHILD, [], { cwd, env: { HOME: "/tmp" }, silent: true, execPath: runner[0] as string, execArgv: [...runner.slice(1), ...bwrapArgs(sandboxMode, cwd), process.execPath, "--max-old-space-size=512"] })
      : fork(CHILD, [], { cwd, env: {}, silent: true, execArgv: ["--max-old-space-size=512"] });
    this.proc.on("exit", () => { this.exited = true; });
    this.proc.on("message", async (msg: any) => {
      if (msg?.type === "call") {
        const [ns, fn] = String(msg.fn).split(".");
        try {
          const f = this.bindingsFn()[ns ?? ""]?.[fn ?? ""];
          if (!f) throw new Error(`unknown binding: ${msg.fn}`);
          const v = await f(msg.args?.[0]);
          this.proc.send({ type: "call-result", callId: msg.callId, ok: true, value: v === undefined ? null : v });
        } catch (e) {
          this.proc.send({ type: "call-result", callId: msg.callId, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      } else if (msg?.type === "done") {
        this.doneWaiters.get(msg.runId)?.(msg);
        this.doneWaiters.delete(msg.runId);
      }
    });
  }
  run(program: string, namespaces: Record<string, string[]>, prelude: string, persistent: boolean, timeoutMs: number | null, signal?: AbortSignal): Promise<any> {
    const runId = ++runSeq;
    return new Promise((resolve) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.proc.kill("SIGKILL"); resolve({ __kind: "timeout" });
      }, timeoutMs);
      const onAbort = () => { this.proc.kill("SIGKILL"); resolve({ __kind: "abort" }); };
      if (signal?.aborted) { resolve({ __kind: "abort" }); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.doneWaiters.set(runId, (m) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(m); });
      this.proc.once("exit", () => { clearTimeout(timer); resolve({ __kind: "worker-exit" }); });
      this.proc.send({ type: "run", runId, code: program, namespaces, prelude, persistent });
    });
  }
  dispose(): void { if (!this.exited) this.proc.kill("SIGKILL"); }
}

export class NodePtcProvider {
  readonly language = "typescript";
  readonly timeout = { defaultMs: 120_000, maxMs: 600_000 };
  private persistent = new Map<string, NodeSession>();
  private chains = new Map<string, Promise<unknown>>();

  async run(req: PtcRequest): Promise<PtcResult> {
    if (req.sandboxMode && req.sandboxMode !== "danger-full-access" && !req.sandboxRunner?.length && !existsSync("/usr/bin/bwrap")) {
      return { logs: [], error: { kind: "sandbox-unavailable", message: "bubblewrap not found at /usr/bin/bwrap" } };
    }
    if (req.sandboxMode && req.sandboxMode !== "danger-full-access" && !probeSandboxRunner(req.sandboxRunner, req.cwd ?? process.cwd())) {
      return { logs: [], error: { kind: "sandbox-unavailable", message: "sandbox runner failed its functional probe (fails closed)" } };
    }
    const timeoutMs = req.timeoutMs === null ? null : Math.min(Math.max(1, req.timeoutMs ?? this.timeout.defaultMs), this.timeout.maxMs);
    const namespaces: Record<string, string[]> = {};
    for (const [ns, fns] of Object.entries(req.bindings ?? {})) namespaces[ns] = Object.keys(fns);
    const exec = async (): Promise<PtcResult> => {
      let session: NodeSession;
      let persistent = false;
      if (req.stateOwner) {
        persistent = true;
        session = this.persistent.get(req.stateOwner) ?? new NodeSession(() => req.bindings ?? {}, req.cwd ?? process.cwd(), req.sandboxMode, req.sandboxRunner);
        if (session.exited) session = new NodeSession(() => req.bindings ?? {}, req.cwd ?? process.cwd(), req.sandboxMode, req.sandboxRunner);
        this.persistent.set(req.stateOwner, session);
      } else {
        session = new NodeSession(() => req.bindings ?? {}, req.cwd ?? process.cwd(), req.sandboxMode, req.sandboxRunner);
      }
      try {
        const msg = await session.run(req.program, namespaces, req.prelude ?? "", persistent, timeoutMs, req.signal);
        if (msg?.__kind) return { logs: [], error: { kind: msg.__kind, message: msg.__kind === "timeout" ? "program timed out" : String(msg.__kind) } };
        if (!msg?.ok) return { logs: msg?.logs ?? [], error: { kind: "exception", message: msg?.error ?? "program failed" } };
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
 * Program assigns `result`; tools are called as tools.<name>(args_dict). */
export class PythonPtcProvider {
  readonly language = "python";
  async run(req: PtcRequest): Promise<PtcResult> {
    const script = join(dirname(fileURLToPath(import.meta.url)), "ptc-child.py");
    return new Promise((resolve) => {
      const proc = spawn("python3", ["-u", script], { cwd: req.cwd ?? process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      let buf = ""; let done = false;
      const finish = (r: PtcResult) => { if (!done) { done = true; clearTimeout(timer); try { proc.kill("SIGKILL"); } catch { /* gone */ } resolve(r); } };
      const timer = setTimeout(() => finish({ logs: [], error: { kind: "timeout", message: "python program timed out" } }), req.timeoutMs === null ? 600_000 : Math.min(req.timeoutMs ?? 120_000, 600_000));
      req.signal?.addEventListener("abort", () => finish({ logs: [], error: { kind: "abort", message: "aborted" } }), { once: true });
      proc.stdout?.on("data", async (d: Buffer) => {
        buf += d.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg: any; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "call") {
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
            if (!msg.ok) finish({ logs: msg.logs ?? [], error: { kind: "exception", message: msg.error ?? "python program failed" } });
            else {
              try { assertLosslessJson(msg.value); finish({ value: msg.value, logs: msg.logs ?? [] }); }
              catch (e) { finish({ logs: msg.logs ?? [], error: { kind: "invalid-output", message: e instanceof Error ? e.message : String(e) } }); }
            }
          }
        }
      });
      proc.once("error", (e) => finish({ logs: [], error: { kind: "worker-exit", message: e.message } }));
      const namespaces: Record<string, string[]> = {};
      for (const [ns, fns] of Object.entries(req.bindings ?? {})) namespaces[ns] = Object.keys(fns);
      proc.stdin?.write(JSON.stringify({ code: req.program, namespaces }) + "\n");
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
