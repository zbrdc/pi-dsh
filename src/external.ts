/** External subagent providers (dsh subagent-claude-code, subagent-codex, subagent-acp).
 *
 * Each run is one unattended, one-shot session of another agent product in the
 * workspace: a text task in, the final answer or a safe failure diagnostic out.
 * Reasoning, tool traffic and stderr stay out of the parent session, and the
 * run accepts no follow-up input. Choosing a provider never widens access: the
 * standing sandbox mode caps the product's own permission settings, and a
 * product that has no native sandbox (ACP) runs under bubblewrap. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_ORDER, bwrapArgs, type SandboxMode } from "./core.ts";
import { probeSandboxRunner } from "./terminal.ts";

export type ExternalKind = "claude-code" | "codex" | "acp";
export const EXTERNAL_KINDS: readonly ExternalKind[] = ["claude-code", "codex", "acp"];

/** One entry of `externalSubagents` in pi-dsh.json. */
export interface ExternalConfig {
  /** Which product to drive; defaults to the entry's own name. */
  type?: ExternalKind;
  /** Executable to run; defaults to `claude` or `codex`, and is required for acp. */
  command?: string;
  /** Arguments after the executable (acp: the flags that start its ACP server). */
  args?: string[];
  /** Model name passed to the product; omitted keeps the product's own setting. */
  model?: string;
  /** claude-code: dontAsk (default), acceptEdits, auto, plan, bypassPermissions. */
  permissionMode?: string;
  /** codex: never (default), approve-for-me, dangerously-bypass-approvals-and-sandbox. acp: reject (default) or allow. */
  permission?: string;
  /** Environment layered over the credential-scrubbed parent environment; API keys go here. */
  env?: Record<string, string>;
  /** Grace between SIGTERM and SIGKILL when a run is stopped. */
  graceMs?: number;
  /** acp: extra paths the sandboxed agent may write (its own state directories). */
  writablePaths?: string[];
}

export interface ExternalSandbox { mode: SandboxMode; runner?: string[] }
export interface ExternalRunInput {
  task: string; cwd: string; signal: AbortSignal;
  /** Reports a tool the product ran, for agent_status. */
  onActivity: (name: string, detail: string) => void;
}
export interface ExternalProvider {
  name: string; product: string;
  /** Resolves the product's final answer; rejects with an ExternalFailure carrying a safe diagnostic. */
  run(input: ExternalRunInput): Promise<string>;
}

const DEFAULT_GRACE_MS = 3000;
const STDERR_TAIL_CHARS = 2048;
/** dsh scrubbedParentEnv: ambient credentials do not reach a product unless the config names them. */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key)) env[key] = value;
  return env;
}

export interface FailureFacts { product: string; stage: string; category: string; exitCode?: number | null; signal?: string | null }

/** Fixed-shape facts only: product output, stderr and paths never reach the model (dsh failureDiagnostic). */
export function failureDiagnostic(facts: FailureFacts): string {
  const fields = [`product: ${facts.product}`, `stage: ${facts.stage}`, `category: ${facts.category}`];
  if (facts.exitCode !== null && facts.exitCode !== undefined) fields.push(`exit code: ${facts.exitCode}`);
  if (facts.signal !== null && facts.signal !== undefined) fields.push(`signal: ${facts.signal}`);
  return `Product subagent failure (${fields.join("; ")})`;
}

export class ExternalFailure extends Error {
  diagnostic: string;
  constructor(facts: FailureFacts) {
    const diagnostic = failureDiagnostic(facts);
    super(diagnostic);
    this.name = "ExternalFailure";
    this.diagnostic = diagnostic;
  }
}

const stopped = (product: string) => Object.assign(new Error(`${product} run aborted`), { aborted: true });

// ---- process management -------------------------------------------------------------------

export interface ManagedProcess {
  proc: ChildProcess;
  /** Resolves once the process and its process group are gone. */
  exited: Promise<{ exitCode: number | null; signal: string | null; spawnError?: Error }>;
  /** Last bytes of stderr, for host-side diagnosis only. */
  stderrTail(): string;
  /** SIGTERM the process group, SIGKILL after the grace period. */
  stop(): void;
}

export interface SpawnSpec { argv: string[]; cwd: string; env: Record<string, string>; graceMs: number; onLine?: (line: string) => void }

export function spawnManaged(spec: SpawnSpec): ManagedProcess {
  const [command, ...args] = spec.argv;
  const proc = spawn(command as string, args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stderr = "";
  let spawnError: Error | undefined;
  const signalGroup = (sig: NodeJS.Signals) => { try { if (proc.pid) process.kill(-proc.pid, sig); } catch { /* group already gone */ } };
  let buffer = "";
  proc.stdout?.on("data", (d: Buffer) => {
    buffer += d.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) spec.onLine?.(line);
    }
  });
  proc.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-STDERR_TAIL_CHARS); });
  proc.stdin?.on("error", () => undefined); // a product that exits early closes its stdin
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<{ exitCode: number | null; signal: string | null; spawnError?: Error }>((resolve) => {
    proc.once("error", (error) => { spawnError = error; resolve({ exitCode: null, signal: null, spawnError: error }); });
    proc.once("close", (exitCode, signal) => {
      clearTimeout(killTimer);
      signalGroup("SIGKILL"); // sweep strays the product left in its group
      resolve({ exitCode, signal, ...(spawnError ? { spawnError } : {}) });
    });
  });
  return {
    proc, exited, stderrTail: () => stderr,
    stop() {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), spec.graceMs);
      killTimer.unref?.();
    },
  };
}

/** Run a one-shot product: write `stdin`, collect lines, stop on abort. */
async function runOneShot(spec: SpawnSpec & { stdin: string; signal: AbortSignal; product: string }) {
  if (spec.signal.aborted) throw stopped(spec.product);
  const managed = spawnManaged(spec);
  const onAbort = () => managed.stop();
  spec.signal.addEventListener("abort", onAbort, { once: true });
  managed.proc.stdin?.end(spec.stdin);
  try {
    const outcome = await managed.exited;
    if (spec.signal.aborted) throw stopped(spec.product);
    return outcome;
  } finally { spec.signal.removeEventListener("abort", onAbort); }
}

const asRecord = (value: unknown): Record<string, any> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined);
const parseLine = (line: string): Record<string, any> | undefined => { try { return asRecord(JSON.parse(line)); } catch { return undefined; } };
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A product asking for more access than the standing sandbox mode grants is refused before it starts. */
function requireSandbox(product: string, setting: string, needed: SandboxMode, standing: SandboxMode): void {
  if (SANDBOX_ORDER.indexOf(standing) < SANDBOX_ORDER.indexOf(needed)) {
    throw new ExternalFailure({ product, stage: "configuration", category: `${setting} needs sandboxMode ${needed}` });
  }
}

// ---- Claude Code --------------------------------------------------------------------------

export const CLAUDE_PERMISSION_MODES = ["dontAsk", "acceptEdits", "auto", "plan", "bypassPermissions"] as const;
const CLAUDE_MIN_SANDBOX: Record<string, SandboxMode> = { dontAsk: "read-only", plan: "read-only", acceptEdits: "workspace-write", auto: "danger-full-access", bypassPermissions: "danger-full-access" };

/** Built-in tools Claude Code may use under each restrictive sandbox mode; danger-full-access leaves its own set alone. */
const CLAUDE_TOOLS: Partial<Record<SandboxMode, string>> = {
  "read-only": "Read,Grep,Glob",
  "workspace-write": "Read,Grep,Glob,Edit,Write,NotebookEdit",
};

/** Claude Code argv for one run (the task goes in on stdin).
 *
 * Under a restrictive sandbox mode the product gets an allowlist of file tools only, with no command tools, no user MCP servers and no skills.
 * Measured against the real CLI: `--restricted` alone hid the file tools from the model, while `--tools` with `--strict-mcp-config` kept them. */
export function claudeArgs(cfg: ExternalConfig, sandbox: SandboxMode): string[] {
  // Measured against the real CLI: under workspace-write, dontAsk denied the Write tool, so edits need acceptEdits.
  const mode = cfg.permissionMode ?? (sandbox === "workspace-write" ? "acceptEdits" : "dontAsk");
  if (!(CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) throw new ExternalFailure({ product: "Claude Code", stage: "configuration", category: `unknown permissionMode ${mode}` });
  requireSandbox("Claude Code", `permissionMode ${mode}`, CLAUDE_MIN_SANDBOX[mode] as SandboxMode, sandbox);
  const tools = CLAUDE_TOOLS[sandbox];
  return [
    "-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--permission-mode", mode,
    ...(tools ? ["--tools", tools, "--strict-mcp-config", "--disable-slash-commands"] : []),
    ...(cfg.model ? ["--model", cfg.model] : []),
    "--disallowed-tools", "AskUserQuestion", ...(mode === "plan" ? ["ExitPlanMode"] : []),
  ];
}

function createClaudeCode(name: string, cfg: ExternalConfig, sandbox: ExternalSandbox): ExternalProvider {
  const product = "Claude Code";
  return {
    name, product,
    async run({ task, cwd, signal, onActivity }) {
      const argv = [cfg.command ?? "claude", ...(cfg.args ?? []), ...claudeArgs(cfg, sandbox.mode)];
      let result: Record<string, any> | undefined;
      const onLine = (line: string) => {
        const message = parseLine(line);
        if (!message) return;
        if (message.type === "result") result = message;
        else if (message.type === "assistant" && Array.isArray(message.message?.content)) {
          for (const block of message.message.content) if (block?.type === "tool_use") onActivity(String(block.name), clip(JSON.stringify(block.input ?? {})));
        }
      };
      const outcome = await runOneShot({ argv, cwd, env: { ...scrubbedEnv(), ...(cfg.env ?? {}) }, graceMs: cfg.graceMs ?? DEFAULT_GRACE_MS, onLine, stdin: task, signal, product });
      const facts = { product, stage: "run", exitCode: outcome.exitCode, signal: outcome.signal };
      if (outcome.spawnError) throw new ExternalFailure({ product, stage: "process", category: "unavailable" });
      if (!result) throw new ExternalFailure({ ...facts, category: outcome.exitCode === 0 ? "invalid-result" : "process" });
      if (result.subtype !== "success") {
        const limit = ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(String(result.subtype));
        throw new ExternalFailure({ ...facts, category: limit ? "limit" : result.subtype === "error_during_execution" ? "product-error" : "unknown" });
      }
      if (result.is_error || typeof result.result !== "string" || result.result.trim() === "" || outcome.exitCode !== 0) throw new ExternalFailure({ ...facts, category: "invalid-result" });
      return result.result;
    },
  };
}

// ---- Codex --------------------------------------------------------------------------------

export const CODEX_PERMISSIONS = ["never", "approve-for-me", "dangerously-bypass-approvals-and-sandbox"] as const;

/** Codex argv for one run. Its own `--sandbox` takes the standing mode, so the product enforces the same boundary. */
export function codexArgs(cfg: ExternalConfig, sandbox: SandboxMode, cwd: string, outputFile: string): string[] {
  const permission = cfg.permission ?? "never";
  if (!(CODEX_PERMISSIONS as readonly string[]).includes(permission)) throw new ExternalFailure({ product: "Codex", stage: "configuration", category: `unknown permission ${permission}` });
  if (permission === "approve-for-me") requireSandbox("Codex", "permission approve-for-me", "workspace-write", sandbox);
  if (permission === "dangerously-bypass-approvals-and-sandbox") requireSandbox("Codex", `permission ${permission}`, "danger-full-access", sandbox);
  const access = permission === "never" ? ["--sandbox", sandbox] : permission === "approve-for-me" ? ["--approve-for-me"] : ["--dangerously-bypass-approvals-and-sandbox"];
  return ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", cwd, ...access, "-o", outputFile, ...(cfg.model ? ["-m", cfg.model] : [])];
}

function codexActivity(event: Record<string, any>): [string, string] | undefined {
  const item = asRecord(event.item);
  if (!item || event.type !== "item.started") return undefined;
  if (item.type === "command_execution") return ["shell", clip(String(item.command ?? ""))];
  if (item.type === "file_change") return ["edit", clip(JSON.stringify(item.changes ?? []))];
  if (item.type === "mcp_tool_call") return ["mcp", `${item.server ?? ""}.${item.tool ?? ""}`];
  if (item.type === "web_search") return ["web_search", clip(String(item.query ?? ""))];
  return undefined;
}

function createCodex(name: string, cfg: ExternalConfig, sandbox: ExternalSandbox): ExternalProvider {
  const product = "Codex";
  return {
    name, product,
    async run({ task, cwd, signal, onActivity }) {
      const dir = mkdtempSync(join(tmpdir(), "pi-dsh-codex-"));
      const outputFile = join(dir, "last-message.txt");
      try {
        const argv = [cfg.command ?? "codex", ...(cfg.args ?? []), ...codexArgs(cfg, sandbox.mode, cwd, outputFile)];
        let turnFailed = false;
        let lastAgentMessage = "";
        const onLine = (line: string) => {
          const event = parseLine(line);
          if (!event) return;
          if (event.type === "turn.failed") turnFailed = true;
          const activity = codexActivity(event);
          if (activity) onActivity(...activity);
          if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") lastAgentMessage = event.item.text;
        };
        const outcome = await runOneShot({ argv, cwd, env: { ...scrubbedEnv(), ...(cfg.env ?? {}) }, graceMs: cfg.graceMs ?? DEFAULT_GRACE_MS, onLine, stdin: task, signal, product });
        if (outcome.spawnError) throw new ExternalFailure({ product, stage: "process", category: "unavailable" });
        const facts = { product, stage: "run", exitCode: outcome.exitCode, signal: outcome.signal };
        if (turnFailed) throw new ExternalFailure({ ...facts, category: "product-error" });
        if (outcome.exitCode !== 0) throw new ExternalFailure({ ...facts, category: "process" });
        const written = existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "";
        const answer = written.trim() !== "" ? written : lastAgentMessage;
        if (answer.trim() === "") throw new ExternalFailure({ ...facts, category: "invalid-result" });
        return answer;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

// ---- ACP ----------------------------------------------------------------------------------

/** Minimal newline-delimited JSON-RPC 2.0 peer over a child's stdio. */
export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private write: (line: string) => void;
  onRequest: (method: string, params: any) => Promise<unknown> | unknown = () => { throw Object.assign(new Error("method not found"), { code: -32601 }); };
  onNotification: (method: string, params: any) => void = () => undefined;
  constructor(write: (line: string) => void) { this.write = write; }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  }
  notify(method: string, params: unknown): void { this.write(JSON.stringify({ jsonrpc: "2.0", method, params })); }
  /** Reject every request still waiting, e.g. when the process exits. */
  failAll(error: Error): void { for (const p of this.pending.values()) p.reject(error); this.pending.clear(); }

  handleLine(line: string): void {
    const message = parseLine(line);
    if (!message) return;
    if (typeof message.method === "string") { void this.dispatch(message); return; }
    const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.error) waiting.reject(Object.assign(new Error(String(message.error.message ?? "rpc error")), { code: message.error.code }));
    else waiting.resolve(message.result);
  }
  private async dispatch(message: Record<string, any>): Promise<void> {
    if (message.id === undefined) { this.onNotification(message.method, message.params); return; }
    try { this.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: (await this.onRequest(message.method, message.params)) ?? null })); }
    catch (error: any) { this.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: error?.code ?? -32603, message: String(error?.message ?? error) } })); }
  }
}

/** The permission option to answer an agent's request with, or undefined to cancel it. */
export function permissionOutcome(policy: string, options: unknown): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  if (policy === "allow" && Array.isArray(options)) {
    const pick = options.find((o) => o?.kind === "allow_once") ?? options.find((o) => o?.kind === "allow_always");
    if (pick && typeof pick.optionId === "string") return { outcome: "selected", optionId: pick.optionId };
  }
  return { outcome: "cancelled" };
}

const ACP_STOP_CATEGORIES: Record<string, string> = { max_tokens: "limit", max_turn_requests: "limit", refusal: "refusal" };

/** argv for an ACP agent: confined by bubblewrap under a restrictive standing mode, since the protocol has no sandbox of its own. */
export function acpArgv(cfg: ExternalConfig, sandbox: ExternalSandbox, cwd: string): string[] {
  const product = "ACP agent";
  if (!cfg.command) throw new ExternalFailure({ product, stage: "configuration", category: "missing command" });
  const agent = [cfg.command, ...(cfg.args ?? [])];
  if (sandbox.mode === "danger-full-access") return agent;
  const runner = sandbox.runner?.length ? sandbox.runner : ["/usr/bin/bwrap"];
  if (!sandbox.runner?.length && !existsSync("/usr/bin/bwrap")) throw new ExternalFailure({ product, stage: "process", category: "sandbox-unavailable" });
  if (!probeSandboxRunner(sandbox.runner, cwd)) throw new ExternalFailure({ product, stage: "process", category: "sandbox-unavailable" });
  const profile = bwrapArgs(sandbox.mode, cwd);
  // The agent's own state directories: ~ expands, and a missing one is created because bwrap refuses to bind a path that does not exist.
  const extra = (cfg.writablePaths ?? []).map((p) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p))
    .flatMap((p) => { mkdirSync(p, { recursive: true }); return ["--bind", p, p]; });
  // bwrapArgs ends with "--" before the command; extra binds go ahead of it.
  return [...runner, ...profile.slice(0, -1), ...extra, "--", ...agent];
}

function createAcp(name: string, cfg: ExternalConfig, sandbox: ExternalSandbox): ExternalProvider {
  const product = "ACP agent";
  return {
    name, product,
    async run({ task, cwd, signal, onActivity }) {
      if (signal.aborted) throw stopped(product);
      const policy = cfg.permission ?? "reject";
      const argv = acpArgv(cfg, sandbox, cwd);
      const peer = new JsonRpcPeer((line) => { managed.proc.stdin?.write(`${line}\n`); });
      const managed = spawnManaged({ argv, cwd, env: { ...scrubbedEnv(), ...(cfg.env ?? {}) }, graceMs: cfg.graceMs ?? DEFAULT_GRACE_MS, onLine: (line) => peer.handleLine(line) });
      let text = "";
      let sessionId: string | undefined;
      peer.onNotification = (method, params) => {
        if (method !== "session/update") return;
        const update = asRecord(params?.update);
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") text += String(update.content.text ?? "");
        else if (update?.sessionUpdate === "tool_call") onActivity(String(update.kind ?? "tool"), clip(String(update.title ?? "")));
      };
      peer.onRequest = (method, params) => {
        if (method === "session/request_permission") return { outcome: permissionOutcome(policy, params?.options) };
        throw Object.assign(new Error(`client does not implement ${method}`), { code: -32601 });
      };
      const onAbort = () => { if (sessionId) peer.notify("session/cancel", { sessionId }); managed.stop(); };
      signal.addEventListener("abort", onAbort, { once: true });
      void managed.exited.then((o) => peer.failAll(new Error(`process exited (${o.exitCode ?? o.signal ?? "spawn error"})`)));
      let stage = "initialize";
      try {
        await peer.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
        stage = "new-session";
        const created = await peer.request("session/new", { cwd, mcpServers: [] });
        if (typeof created?.sessionId !== "string" || created.sessionId === "") throw new ExternalFailure({ product, stage, category: "invalid-result" });
        sessionId = created.sessionId;
        stage = "prompt";
        const done = await peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text: task }] });
        const stopReason = String(done?.stopReason ?? "unknown");
        if (stopReason === "cancelled") throw stopped(product);
        if (stopReason !== "end_turn") throw new ExternalFailure({ product, stage, category: ACP_STOP_CATEGORIES[stopReason] ?? "unknown" });
        if (text.trim() === "") throw new ExternalFailure({ product, stage, category: "invalid-result" });
        return text;
      } catch (error: any) {
        if (signal.aborted) throw stopped(product);
        if (error instanceof ExternalFailure) throw error;
        const outcome = await Promise.race([managed.exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), 200))]);
        throw new ExternalFailure({ product, stage: outcome?.spawnError ? "process" : stage, category: outcome?.spawnError ? "unavailable" : outcome ? "process" : "protocol", exitCode: outcome?.exitCode, signal: outcome?.signal });
      } finally {
        signal.removeEventListener("abort", onAbort);
        managed.proc.stdin?.end(); // EOF first: a well-behaved agent flushes and exits by itself
        managed.stop();
        await managed.exited;
      }
    },
  };
}

// ---- registry -----------------------------------------------------------------------------

/** Build the provider for an `externalSubagents` entry, or throw a message naming the bad setting. */
export function createExternalProvider(name: string, cfg: ExternalConfig, sandbox: ExternalSandbox): ExternalProvider {
  const kind = cfg.type ?? (name as ExternalKind);
  if (!EXTERNAL_KINDS.includes(kind)) throw new Error(`externalSubagents.${name}: type must be one of ${EXTERNAL_KINDS.join(", ")}`);
  if (kind === "acp" && !cfg.command) throw new Error(`externalSubagents.${name}: an acp provider needs "command"`);
  if (kind === "claude-code") return createClaudeCode(name, cfg, sandbox);
  if (kind === "codex") return createCodex(name, cfg, sandbox);
  return createAcp(name, cfg, sandbox);
}

/** Tool name for a provider entry, e.g. claude-code becomes subagent_claude_code. */
export const externalToolName = (name: string): string => `subagent_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
