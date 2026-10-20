/** Subagent seam port (dsh ctx.subagents): managed Activations over named providers.
 * Local providers run child pi sessions through the pi SDK with a minimal resource
 * loader (no extension discovery), so children never recursively load pi-dsh. */
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Type } from "typebox";
import { RepeatTracker, captureStructuredSubmission, normalizeStructured, pruneText, spillText } from "./core.ts";

export interface ActivationResult { childId: string; text: string; data?: unknown; status: "completed" | "failed" | "killed" }
export interface CatalogEntry {
  childId: string; provider: string; label: string; owner: string;
  sessionFile?: string; cwd: string; createdAt: number; status: "live" | "settled";
}

interface ChildHandle {
  sessionId: string; sessionFile?: string;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<unknown>;
  followUp(text: string): Promise<unknown>;
  abort(): Promise<void>;
  isStreaming(): boolean;
  lastText(): string;
  structured(): unknown;
  dispose(): void;
}

export interface StartOptions {
  provider: "spawn" | "fork"; label: string; task: string; owner: string;
  cwd: string; model?: unknown; parentSessionFile?: string;
  /** Fork seed: parent messages already cut at the last completed turn. */
  seedMessages?: any[];
  /** When true, settling without a structured_output submission is a failure. */
  requireStructured?: boolean;
  /** Exact JSON Schema for structured_output arguments when this run is schema-led. */
  outputSchema?: Record<string, unknown>;
  delivery: "parent" | "caller"; tools?: string[]; systemAppend?: string;
  signal?: AbortSignal;
}

interface Activation {
  entry: CatalogEntry; handle?: ChildHandle; result: Promise<ActivationResult>;
  resolveResult?: (r: ActivationResult) => void; inputClosed: boolean; settled: boolean;
  requireStructured?: boolean; outputSchema?: Record<string, unknown>; systemAppend?: string; model?: unknown;
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "structured_output"];

export class SubagentManager {
  private activations = new Map<string, Activation>();
  private catalog: CatalogEntry[] = [];
  onSettle: ((entry: CatalogEntry, result: ActivationResult, delivery: "parent" | "caller") => void) | undefined;
  onCatalog: ((entry: CatalogEntry) => void) | undefined;
  opts: { maxActive?: number; childDir?: string };
  constructor(opts: { maxActive?: number; childDir?: string } = {}) { this.opts = opts; }

  private get maxActive(): number { return this.opts.maxActive ?? 8; }
  private childDir(): string {
    const dir = this.opts.childDir ?? join(homedir(), ".pi", "agent", "pi-dsh", "children");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  restore(entries: CatalogEntry[]): void { this.catalog = entries.map((e) => ({ ...e, status: "settled" as const })); }
  list(owner: string): CatalogEntry[] { return this.catalog.filter((e) => e.owner === owner); }
  hasLive(owner: string): boolean { return this.list(owner).some((e) => e.status === "live"); }

  async start(opts: StartOptions): Promise<string> {
    const live = this.catalog.filter((e) => e.owner === opts.owner && e.status === "live").length;
    if (live >= this.maxActive) throw new Error(`ACTIVATION_LIMIT_REACHED: ${this.maxActive} live subagents in this tree; wait for one to finish`);
    if (opts.signal?.aborted) throw new Error("subagent start aborted");
    const handle = await createSdkChild({
      cwd: opts.cwd, model: opts.model, tools: opts.tools ?? DEFAULT_TOOLS,
      systemAppend: opts.systemAppend, childDir: this.childDir(),
      seedMessages: opts.provider === "fork" ? opts.seedMessages : undefined,
      requireStructured: opts.requireStructured === true || opts.outputSchema !== undefined,
      outputSchema: opts.outputSchema,
    });
    const entry: CatalogEntry = {
      childId: handle.sessionId, provider: opts.provider, label: opts.label, owner: opts.owner,
      sessionFile: handle.sessionFile, cwd: opts.cwd, createdAt: Date.now(), status: "live",
    };
    let resolveResult: (r: ActivationResult) => void = () => undefined;
    const result = new Promise<ActivationResult>((resolve) => { resolveResult = resolve; });
    const activation: Activation = {
      entry, handle, result, resolveResult, inputClosed: false, settled: false,
      requireStructured: opts.requireStructured === true || opts.outputSchema !== undefined,
      outputSchema: opts.outputSchema, systemAppend: opts.systemAppend, model: opts.model,
    };
    this.activations.set(entry.childId, activation);
    this.catalog.push(entry);
    this.onCatalog?.(entry);
    void this.run(activation, opts.task, opts.delivery, opts.cwd, opts.model, opts.requireStructured === true);
    return entry.childId;
  }

  private async run(activation: Activation, task: string, delivery: "parent" | "caller", cwd: string, model: unknown, requireStructured = false): Promise<void> {
    const handle = activation.handle as ChildHandle;
    let status: ActivationResult["status"] = "completed";
    try {
      await handle.prompt(task);
    } catch (err) {
      status = err instanceof Error && /abort/i.test(err.message) ? "killed" : "failed";
    }
    const data = handle.structured();
    if (data !== undefined) {
      activation.inputClosed = true;
      // Structured capture aborts the tail of the child turn; that is a
      // successful conclusion, not an externally killed activation.
      if (status === "killed") status = "completed";
    }
    else if (requireStructured && status === "completed") status = "failed";
    const result: ActivationResult = {
      childId: activation.entry.childId, status,
      text: handle.lastText() || (data !== undefined ? JSON.stringify(data) : ""),
      data,
    };
    void cwd; void model;
    activation.entry.status = "settled";
    activation.entry.sessionFile = handle.sessionFile ?? activation.entry.sessionFile;
    activation.settled = true;
    activation.resolveResult?.(result);
    handle.dispose();
    activation.handle = undefined;
    this.onCatalog?.(activation.entry);
    this.onSettle?.(activation.entry, result, delivery);
  }

  async wait(childId: string): Promise<ActivationResult> {
    const a = this.activations.get(childId);
    if (!a) throw new Error(`unknown subagent: ${childId}`);
    return a.result;
  }

  async sendMessage(childId: string, message: string, deliver: "steer" | "followUp" = "steer"): Promise<string> {
    const a = this.activations.get(childId);
    if (!a) throw new Error(`unknown subagent: ${childId}`);
    if (a.inputClosed) throw new Error(`subagent ${childId} already submitted its structured result; input is closed`);
    if (a.handle) {
      if (a.handle.isStreaming()) { if (deliver === "steer") await a.handle.steer(message); else await a.handle.followUp(message); }
      else void this.resumeRun(a, message);
      return `message sent to subagent ${childId}`;
    }
    // Cold resume from the persisted child session file.
    if (!a.entry.sessionFile) throw new Error(`subagent ${childId} is NOT_RESUMABLE (no persisted session)`);
    a.handle = await createSdkChild({
      cwd: a.entry.cwd, tools: DEFAULT_TOOLS, childDir: this.childDir(), model: a.model,
      openFile: a.entry.sessionFile, systemAppend: a.systemAppend,
      requireStructured: a.requireStructured === true, outputSchema: a.outputSchema,
    });
    a.entry.status = "live";
    await this.resumeRun(a, message);
    return `subagent ${childId} resumed`;
  }

  private async resumeRun(a: Activation, message: string): Promise<void> {
    a.settled = false;
    a.entry.status = "live";
    a.result = new Promise<ActivationResult>((resolve) => { a.resolveResult = resolve; });
    await this.run(a, message, "parent", a.entry.cwd, a.model, a.requireStructured === true);
  }

  async interrupt(childId: string): Promise<void> {
    const a = this.activations.get(childId);
    if (!a?.handle) throw new Error(`subagent ${childId} is not live`);
    await a.handle.abort();
    await a.result;
  }

  async disposeOwner(owner: string): Promise<void> {
    const live = [...this.activations.values()].filter((a) => a.entry.owner === owner && a.entry.status === "live");
    await Promise.allSettled(live.map(async (a) => { await a.handle?.abort(); await a.result; }));
  }
}

/** Parameters for structured_output: the caller's exact schema for schema-led
 * runs, otherwise the generic result envelope. Keeping one authority prevents
 * audit verdicts from being hidden beside an unrelated evidence object. */
export function structuredToolParameters(outputSchema?: Record<string, unknown>): any {
  if (outputSchema !== undefined) return outputSchema;
  return Type.Object({
    result: Type.Optional(Type.Any()),
    summary: Type.Optional(Type.String()),
    verdict: Type.Optional(Type.String()),
    gaps: Type.Optional(Type.String()),
  });
}

/** DSH-style delegated-child instructions rendered into the child's system prompt. */
export function buildChildPrompt(opts: { requireStructured?: boolean; systemAppend?: string }): string {
  const lines = [
    "You are a delegated pi-dsh subagent. Stay strictly within the assigned task and current workspace; do not broaden scope or take over the parent task.",
    "Your permission scope was fixed when you were started and cannot be widened from inside this session. If the task needs access beyond that scope, do not retry the denied operation; state the limitation in your result.",
    "Use only the tools actually available in this child session. Ignore inherited instructions that name unavailable tools (including ctx_* helpers), and use the available read/search/shell tools directly.",
    "Inspect current files before deciding. Read a file with read — not shell inspection commands — and read it before editing unless you just created or edited it. Check shell exit codes and verify the result before finishing.",
    "For multi-step work, proceed in dependency order and do not wander into unrelated cleanup or refactors.",
  ];
  if (opts.systemAppend) lines.push(opts.systemAppend);
  if (opts.requireStructured) {
    lines.push("When you have your final answer, you MUST report it by calling the structured_output tool exactly once with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only the tool call counts as your result.");
  }
  return lines.join("\n\n");
}

/** Pi-dsh safety and context hooks for SDK children. The child does not discover
 * user extensions, but it gets the same FS, repeated-call, spill, and pruning
 * discipline as the parent instead of a bare stock session. */
function createChildPolicyExtension(): (pi: any) => void {
  return (childPi: any) => {
    const observed = new Map<string, string>();
    const repeat = new RepeatTracker([3, 5, 8]);
    const resolvePath = (ctx: any, path: string) => (isAbsolute(path) ? path : resolve(ctx.cwd, path));
    const hashFile = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
    const observe = async (ctx: any, e: any) => {
      if (typeof e.input?.path !== "string") return;
      const path = resolvePath(ctx, e.input.path);
      const hash = await hashFile(path).catch(() => undefined);
      if (hash !== undefined && !e.isError) observed.set(path, hash);
      else if (e.toolName === "read") observed.delete(path);
    };
    childPi.on("tool_call", async (e: any, ctx: any) => {
      const reminder = repeat.observe(e.toolName, e.input);
      if (reminder) {
        try { childPi.sendMessage({ customType: "pi-dsh/repeat-reminder", content: reminder, display: false }, { deliverAs: "steer" }); }
        catch { /* the next tool result still supplies the evidence */ }
      }
      if (e.toolName === "bash" && typeof e.input?.timeout === "number" && e.input.timeout > 600) e.input.timeout = 600;
      if ((e.toolName === "edit" || e.toolName === "write") && typeof e.input?.path === "string") {
        const path = resolvePath(ctx, e.input.path);
        let exists = true;
        try { await stat(path); } catch { exists = false; }
        if (!exists) {
          if (e.toolName === "edit") return { block: true, reason: `FS_NOT_FOUND: cannot edit "${path}": file does not exist — create it with write, then retry` };
          return undefined;
        }
        const seen = observed.get(path);
        if (seen === undefined) return { block: true, reason: `FS_NOT_OBSERVED: cannot modify "${path}": file has not been read — read the file, then retry` };
        const now = await hashFile(path).catch(() => "");
        if (now !== seen) return { block: true, reason: `FS_STALE_VERSION: "${path}" changed since it was read — re-read the file, then retry` };
      }
      return undefined;
    });
    childPi.on("tool_result", async (e: any, ctx: any) => {
      if (e.toolName === "read" || e.toolName === "edit" || e.toolName === "write") await observe(ctx, e);
      const joined = (e.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      if (joined.length <= 50_000 || e.isError) return undefined;
      const dir = join(homedir(), ".pi", "agent", "pi-dsh", "spill", "children");
      const file = join(dir, `${String(e.toolCallId).replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
      try { mkdirSync(dir, { recursive: true }); writeFileSync(file, joined, "utf8"); }
      catch { return undefined; }
      const spilled = spillText(joined, 12_500, file);
      return spilled.spilled ? { content: [{ type: "text", text: spilled.text }], structuredContent: e.structuredContent, details: e.details } : undefined;
    });
    childPi.on("context", async (e: any) => {
      if (JSON.stringify(e.messages).length < 400_000) return undefined;
      const toolIndexes = e.messages.map((m: any, i: number) => (m.role === "toolResult" ? i : -1)).filter((i: number) => i >= 0);
      const keepFrom = toolIndexes.length > 6 ? toolIndexes[toolIndexes.length - 6] : Number.POSITIVE_INFINITY;
      let changed = false;
      const messages = e.messages.map((m: any, i: number) => {
        if (m.role !== "toolResult" || i >= keepFrom) return m;
        const content = (m.content ?? []).map((c: any) => {
          if (c.type !== "text" || c.text.length <= 8000) return c;
          changed = true;
          return { ...c, text: pruneText(c.text, 8000) };
        });
        return { ...m, content };
      });
      return changed ? { messages } : undefined;
    });
  };
}

async function createSdkChild(opts: {
  cwd: string; model?: unknown; tools: string[]; systemAppend?: string;
  childDir: string; seedMessages?: any[]; openFile?: string;
  requireStructured?: boolean; outputSchema?: Record<string, unknown>;
}): Promise<ChildHandle> {
  const sdk: any = await import("@earendil-works/pi-coding-agent");
  let structured: unknown;
  const structuredTool = {
    name: "structured_output", label: "Structured output",
    description: "Report your final structured result. Call this exactly once, when your answer is complete; submitting closes input.",
    parameters: structuredToolParameters(opts.outputSchema),
    async execute(_id: string, params: any) {
      if (structured !== undefined) throw new Error("structured output already recorded: the run is complete");
      structured = opts.outputSchema !== undefined ? normalizeStructured(params) : captureStructuredSubmission(params);
      return { content: [{ type: "text", text: "Structured result recorded." }], details: {} };
    },
  };
  const agentDir = sdk.getAgentDir ? sdk.getAgentDir() : join(homedir(), ".pi", "agent");
  const loader = new sdk.DefaultResourceLoader({
    cwd: opts.cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    appendSystemPrompt: [buildChildPrompt(opts)],
    extensionFactories: [createChildPolicyExtension()],
  });
  await loader.reload();
  let sessionManager: any;
  if (opts.openFile) sessionManager = sdk.SessionManager.open(opts.openFile, opts.childDir, opts.cwd);
  else {
    sessionManager = sdk.SessionManager.create(opts.cwd, opts.childDir);
    // Fork seed: replay only the caller's completed-turn prefix, message by message.
    for (const m of opts.seedMessages ?? []) {
      if (!m || m.role === "system") continue;
      try { sessionManager.appendMessage(m); } catch { /* summary/custom types the manager owns elsewhere */ }
    }
  }
  const { session } = await sdk.createAgentSession({
    cwd: opts.cwd, resourceLoader: loader, sessionManager,
    model: opts.model, tools: opts.tools, customTools: [structuredTool],
  });
  const handle: ChildHandle = {
    sessionId: session.sessionId,
    get sessionFile() { return session.sessionFile; },
    prompt: async (text: string) => {
      // Staging structured output closes the run (dsh terminal guard): abort tail work.
      const iv = setInterval(() => { if (structured !== undefined) { clearInterval(iv); void session.abort().catch(() => undefined); } }, 200);
      try { await session.prompt(text); } finally { clearInterval(iv); }
    },
    steer: (text: string) => session.steer(text),
    followUp: (text: string) => session.followUp(text),
    abort: () => session.abort(),
    isStreaming: () => session.isStreaming,
    lastText: () => session.getLastAssistantText() ?? "",
    structured: () => structured,
    dispose: () => { try { session.dispose(); } catch { /* already disposed */ } },
  };
  return handle;
}
