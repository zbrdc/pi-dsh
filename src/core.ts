/** Pure, pi-independent logic ported from dsh: todo validation, repeat detection,
 * spill/prune formatting, lossless-JSON checks, goal transitions, output rings. */

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem { content: string; status: TodoStatus }

/** Validate a whole-list todo replacement (dsh tool-todo semantics). */
export function validateTodos(raw: unknown, allowParallel: boolean): TodoItem[] {
  if (!Array.isArray(raw)) throw new Error("todos must be an array");
  const seen = new Set<string>();
  const out: TodoItem[] = [];
  let active = 0;
  for (const item of raw) {
    const content = String((item as TodoItem)?.content ?? "").trim();
    const status = (item as TodoItem)?.status;
    if (!content) throw new Error("todo content must not be empty");
    if (seen.has(content)) throw new Error(`duplicate todo: ${content}`);
    if (status !== "pending" && status !== "in_progress" && status !== "completed") throw new Error(`invalid todo status: ${String(status)}`);
    seen.add(content);
    if (status === "in_progress") active++;
    out.push({ content, status });
  }
  if (!allowParallel && active > 1) throw new Error("only one todo may be in_progress");
  return out;
}

/** Canonical JSON for repeat detection: stable key order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** Consecutive identical-call tracker (dsh repeat-tool-reminder, thresholds 3/5/8). */
export class RepeatTracker {
  private lastKey = "";
  private count = 0;
  thresholds: number[];
  constructor(thresholds: number[] = [3, 5, 8]) { this.thresholds = thresholds; }
  reset(): void { this.lastKey = ""; this.count = 0; }
  /** Returns a reminder when this call hits a threshold, else undefined. */
  observe(toolName: string, args: unknown): string | undefined {
    const key = `${toolName}\n${canonical(args)}`;
    this.count = key === this.lastKey ? this.count + 1 : 1;
    this.lastKey = key;
    if (!this.thresholds.includes(this.count)) return undefined;
    if (this.count === this.thresholds[0]) {
      return `[pi-dsh] You have called ${toolName} with identical arguments ${this.count} times in a row. Inspect the previous result and change approach or finish.`;
    }
    return `[pi-dsh] ${toolName} called ${this.count} times consecutively with identical arguments: ${key.slice(toolName.length + 1, toolName.length + 501)}. Stop, inspect the previous result, and change approach or finish.`;
  }
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** Spill formatting: retained head/tail within an estimated token budget (dsh spill-policy). */
export function spillText(text: string, maxInlineTokens: number, locator: string): { spilled: boolean; text: string } {
  if (approxTokens(text) <= maxInlineTokens) return { spilled: false, text };
  const budgetChars = maxInlineTokens * 4;
  const notice = `\n\n[... output spilled: full result (${text.length} chars) saved to ${locator}. Read it with read, or grep it, to recover the omitted middle ...]\n\n`;
  const keep = Math.max(0, budgetChars - notice.length);
  const head = Math.floor(keep / 2);
  const tail = keep - head;
  return { spilled: true, text: text.slice(0, head) + notice + (tail > 0 ? text.slice(text.length - tail) : "") };
}

/** Tool-result pruning: head/marker/tail, no model call (dsh compaction-tool-result-pruner). */
export function pruneText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n[... middle pruned by pi-dsh ...]\n";
  const keep = Math.max(0, maxChars - marker.length);
  const head = Math.floor(keep * 0.6);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

/** Reject values that cannot cross a lossless-JSON boundary (dsh PTC realm rules). */
export function assertLosslessJson(value: unknown, seen = new Set<object>()): void {
  if (value === undefined) throw new Error("invalid-output: undefined is not lossless JSON");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("invalid-output: non-finite number");
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error(`invalid-output: ${typeof value} is not lossless JSON`);
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) throw new Error("invalid-output: cyclic value");
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new Error("invalid-output: sparse array");
        assertLosslessJson(value[i], seen);
      }
    } else {
      for (const v of Object.values(value)) assertLosslessJson(v, seen);
    }
    seen.delete(value);
  }
}

/** Bounded output ring for jobs/terminals. Tracks dropped bytes honestly. */
export class OutputRing {
  private chunks: string[] = [];
  private bytes = 0;
  dropped = 0;
  private readOffset = 0;
  private total = 0;
  maxBytes: number;
  constructor(maxBytes = 256 * 1024) { this.maxBytes = maxBytes; }
  append(text: string): void {
    this.chunks.push(text); this.bytes += text.length; this.total += text.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const first = this.chunks.shift() as string; this.bytes -= first.length; this.dropped += first.length;
    }
    if (this.bytes > this.maxBytes && this.chunks.length === 1) {
      const excess = this.bytes - this.maxBytes;
      this.chunks[0] = (this.chunks[0] as string).slice(excess); this.dropped += excess; this.bytes = this.maxBytes;
    }
  }
  /** Output since previous read (stream jobs) plus a dropped-bytes note when relevant. */
  readNew(): string {
    const all = this.chunks.join("");
    const start = Math.max(0, all.length - (this.total - this.readOffset - Math.min(this.dropped, this.total - this.readOffset)));
    void start;
    // Simpler honest semantics: track absolute offsets over retained text.
    const retainedStart = this.total - all.length;
    const from = Math.max(this.readOffset, retainedStart);
    const out = all.slice(from - retainedStart);
    const lost = from > this.readOffset ? from - this.readOffset : 0;
    this.readOffset = this.total;
    return lost > 0 ? `[... ${lost} chars dropped before this read ...]\n${out}` : out;
  }
  all(): string { return this.chunks.join(""); }
}

/** Goal state (dsh dsh-goal). */
export type GoalStatus = "active" | "paused" | "auditing" | "complete" | "blocked";
export interface Goal {
  id: string; revision: number; objective: string; status: GoalStatus;
  roundsStarted: number; maxGoalRounds: number; blocker?: string; blockerRounds: number;
  armed: boolean;
}
export function newGoal(id: string, objective: string, maxGoalRounds = 256): Goal {
  return { id, revision: 1, objective, status: "active", roundsStarted: 0, maxGoalRounds, blockerRounds: 0, armed: true };
}
/** Blocked only after the same blocker for `threshold` consecutive rounds (dsh tool-goal default 3). */
export function applyBlocker(goal: Goal, blocker: string, threshold = 3): Goal {
  const next = { ...goal };
  next.blockerRounds = goal.blocker === blocker ? goal.blockerRounds + 1 : 1;
  next.blocker = blocker;
  if (next.blockerRounds >= threshold) { next.status = "blocked"; next.armed = false; }
  next.revision++;
  return next;
}
export function renderGoalRound(goal: Goal, round: number): string {
  return `<goal_round>\nObjective: ${JSON.stringify(goal.objective)}\nRound: ${round}/${goal.maxGoalRounds}\n\nContinue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal with get_goal, and call update_goal to mark it complete (an auditor will verify). If work remains, leave the goal active for the next round. Report a blocker only with a concrete blocker string.\n</goal_round>`;
}

/** Parse an output_schema argument: models often pass the schema as a JSON
 * string instead of an object (observed live). Returns the schema object,
 * undefined when absent, and throws on anything else. */
export function parseOutputSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { throw new Error("output_schema is not valid JSON"); } })() : value;
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("output_schema must be a JSON Schema object");
  return parsed as Record<string, unknown>;
}

/** Normalize a structured-output submission: models often stringify the object.
 * A JSON string that parses to an object/array becomes that value; anything else stays as-is. */
export function normalizeStructured(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try { return JSON.parse(trimmed) as unknown; } catch { return value; }
}

/** Capture one structured_output submission without dropping sibling verdict fields.
 * Models may put an evidence object in `result` and the audit verdict beside it;
 * the verdict is part of the submission and must survive normalization. */
export function captureStructuredSubmission(params: any): unknown {
  if (!params || typeof params !== "object") return normalizeStructured(params);
  const normalized = normalizeStructured(params.result);
  const hasVerdict = typeof params.verdict === "string";
  const hasGaps = typeof params.gaps === "string";
  if (!hasVerdict && !hasGaps) return normalized ?? params.summary;
  if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
    const base = normalized as Record<string, unknown>;
    return {
      ...base,
      ...(base["verdict"] === undefined && hasVerdict ? { verdict: params.verdict } : {}),
      ...(base["gaps"] === undefined && hasGaps ? { gaps: params.gaps } : {}),
      ...(base["summary"] === undefined && typeof params.summary === "string" ? { summary: params.summary } : {}),
    };
  }
  if (normalized === undefined) return { verdict: params.verdict, gaps: params.gaps ?? "", summary: params.summary };
  return { result: normalized, verdict: params.verdict, gaps: params.gaps ?? "", summary: params.summary };
}

/** Standing DSH-style operating guidance plus a bounded snapshot of live task
 * controls. Completed todos are not repeated; long objectives are bounded. */
export function renderTaskControlSection(state: {
  goal?: Goal; todos: TodoItem[]; planActive: boolean;
}): string {
  const liveTodos = state.todos.filter((t) => t.status !== "completed").slice(0, 20);
  const objective = state.goal && state.goal.objective.length > 1000
    ? `${state.goal.objective.slice(0, 1000)}… [call get_goal for the full objective]`
    : state.goal?.objective;
  const lines = [
    "Stay on the current assigned task. Inspect current workspace and tool results rather than relying on stale narration.",
    "For multi-step work, keep todo_write current: mark a task in_progress before starting it and completed immediately after verifying it. Do not expand into unrelated work.",
    "Read a file with read — not shell inspection commands — and read it before editing, unless you just created or edited it in this session.",
    "Check the [exit code: N] marker on every bash result; investigate failures before moving on and change approach after an identical failure.",
    "Track every background job and subagent id. Do not busy-poll or duplicate its work; before finishing, collect still-relevant jobs and account for delegated results.",
    "For goals, mark complete only when the whole objective is actually achieved and evidenced. Difficulty, uncertainty, or useful remaining work is not blocked.",
  ];
  if (state.planActive) lines.push("Plan mode is active: research and plan only; do not implement or mutate files until the plan is approved.");
  if (state.goal) {
    lines.push(`Current goal (${state.goal.id}, revision ${state.goal.revision}, ${state.goal.status}, rounds ${state.goal.roundsStarted}/${state.goal.maxGoalRounds}, armed=${state.goal.armed}): ${objective}`);
    if (state.goal.blocker) lines.push(`Current goal blocker (${state.goal.blockerRounds} consecutive round(s)): ${state.goal.blocker}`);
  }
  if (liveTodos.length > 0) {
    lines.push("Current unfinished todos:");
    for (const todo of liveTodos) lines.push(`- [${todo.status}] ${todo.content.length > 240 ? `${todo.content.slice(0, 240)}…` : todo.content}`);
  }
  return lines.join("\n");
}

/** Strip ANSI escape sequences from PTY output. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g, "");
}

/** JSON Schema -> TypeScript type text (bounded, lossy by design at exotic keywords). */
export function jsonSchemaToTs(schema: any, depth = 0): string {
  if (!schema || typeof schema !== "object" || depth > 6) return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ") || "any";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((s: any) => jsonSchemaToTs(s, depth + 1)).join(" | ");
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((s: any) => jsonSchemaToTs(s, depth + 1)).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.map((t: string) => jsonSchemaToTs({ ...schema, type: t }, depth + 1)).join(" | ");
  switch (schema.type) {
    case "string": return "string";
    case "number": case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `Array<${jsonSchemaToTs(schema.items, depth + 1)}>`;
    case "object": case undefined: {
      const props = schema.properties as Record<string, any> | undefined;
      if (!props) return schema.additionalProperties ? `Record<string, ${jsonSchemaToTs(schema.additionalProperties, depth + 1)}>` : "Record<string, any>";
      const required = new Set<string>(schema.required ?? []);
      const parts = Object.entries(props).map(([k, v]) => {
        const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        return `${safeKey}${required.has(k) ? "" : "?"}: ${jsonSchemaToTs(v, depth + 1)}`;
      });
      return `{ ${parts.join("; ")} }`;
    }
    default: return "any";
  }
}

/** Generate a typed TypeScript SDK declaration block for PTC run_code from tool JSON schemas. */
export function generateSdk(tools: Array<{ name: string; description?: string; parameters?: any; outputSchema?: any }>): string {
  const lines = ["declare const tools: {"];
  for (const t of tools) {
    const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t.name) ? t.name : JSON.stringify(t.name);
    lines.push(`  /** ${(t.description ?? "").replace(/\*\//g, "*\\/").split("\n")[0]?.slice(0, 200) ?? ""} */`);
    lines.push(`  ${safe}(args: ${jsonSchemaToTs(t.parameters)}): Promise<${t.outputSchema ? jsonSchemaToTs(t.outputSchema) : "any"}>;`);
  }
  lines.push("};");
  return lines.join("\n");
}

/** FIFO semaphore: submission-ordered starts (dsh PTC sub-call scheduler). */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  max: number;
  constructor(max: number) { this.max = max; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try { return await fn(); }
    finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Index after the last completed turn: an assistant message that ended the turn
 * (stop/end_turn), plus any tool results that immediately follow it. */
export function completedTurnCut(messages: any[]): number {
  let cut = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "assistant" && (m.stopReason === "stop" || m.stopReason === "end_turn")) {
      cut = i + 1;
      while (cut < messages.length && messages[cut]?.role === "toolResult") cut++;
    }
  }
  return cut;
}

/** Cooperative per-tool deadline resolution (dsh timeout-policy: the tool's own
 * declared limit wins; no limit means untouched). Values are milliseconds. */
export interface ToolTimeoutConfig {
  toolTimeoutMs?: Record<string, number>;
  defaultToolTimeoutMs?: number;
}
export function resolveToolTimeoutMs(toolName: string, config: ToolTimeoutConfig): number | undefined {
  const perTool = config.toolTimeoutMs?.[toolName];
  const value = perTool !== undefined ? perTool : config.defaultToolTimeoutMs;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), 3_600_000);
}

/** Timeout-shaped input fields an extension can cap at tool_call time, across
 * foreign tools (seconds- and millisecond-denominated conventions). */
export function timeoutFieldCaps(input: any, maxMs = 600_000): Array<{ field: string; capped: number }> {
  if (!input || typeof input !== "object") return [];
  const out: Array<{ field: string; capped: number }> = [];
  for (const field of ["timeout", "timeoutSeconds", "timeout_seconds"]) {
    if (typeof input[field] === "number" && input[field] * 1000 > maxMs) out.push({ field, capped: maxMs / 1000 });
  }
  for (const field of ["timeoutMs", "timeout_ms", "timeoutMillis"]) {
    if (typeof input[field] === "number" && input[field] > maxMs) out.push({ field, capped: maxMs });
  }
  return out;
}

/** Fuse a caller signal with a fresh deadline (DSH `deadline()` equivalent). */
export function fuseSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!signal) return deadline;
  const anyFn = (AbortSignal as any).any as ((signals: AbortSignal[]) => AbortSignal) | undefined;
  if (typeof anyFn === "function") return anyFn([signal, deadline]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted || deadline.aborted) controller.abort();
  else { signal.addEventListener("abort", abort, { once: true }); deadline.addEventListener("abort", abort, { once: true }); }
  return controller.signal;
}

/** Watchdog over in-flight top-level tool executions. Firing is recorded so the
 * eventual tool_result can be annotated TOOL_TIMEOUT even when the tool settles
 * late (cooperative tools settle on abort; uncooperative ones settle whenever). */
export class ToolWatchdog {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private firedAt = new Map<string, { toolName: string; timeoutMs: number }>();
  arm(toolCallId: string, toolName: string, timeoutMs: number, onFire: (toolName: string, timeoutMs: number) => void): void {
    this.clear(toolCallId, true);
    const timer = setTimeout(() => {
      this.timers.delete(toolCallId);
      this.firedAt.set(toolCallId, { toolName, timeoutMs });
      onFire(toolName, timeoutMs);
    }, timeoutMs);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    this.timers.set(toolCallId, timer);
  }
  /** Returns the timeout record if this call previously fired, clearing state. */
  settle(toolCallId: string): { toolName: string; timeoutMs: number } | undefined {
    this.clear(toolCallId, true);
    const fired = this.firedAt.get(toolCallId);
    this.firedAt.delete(toolCallId);
    return fired;
  }
  clear(toolCallId: string, keepFired = false): void {
    const timer = this.timers.get(toolCallId);
    if (timer) clearTimeout(timer);
    this.timers.delete(toolCallId);
    if (!keepFired) this.firedAt.delete(toolCallId);
  }
  get active(): number { return this.timers.size; }
}

/** tmux naming/argv helpers for durable terminals (pure for tests). */
export function tmuxSessionName(owner: string, seq: number): string {
  const safe = owner.replace(/[^A-Za-z0-9_-]/g, "_").slice(-24);
  return `pidsh-${safe}-${seq}`;
}
export function tmuxNewSessionArgs(name: string, cwd: string, shell: string): string[] {
  return ["new-session", "-d", "-s", name, "-c", cwd, shell];
}
/** Literal send-keys argv per chunk; a trailing newline becomes a separate Enter. */
export function tmuxSendKeysChunks(input: string): Array<{ literal?: string; enter?: boolean }> {
  const chunks: Array<{ literal?: string; enter?: boolean }> = [];
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  lines.forEach((line, i) => {
    if (line) chunks.push({ literal: line });
    if (i < lines.length - 1) chunks.push({ enter: true });
  });
  return chunks;
}

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export const SANDBOX_ORDER: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
/** Bubblewrap argv prefix confining a command. Caller appends the real argv.
 * Root is bound read-only so host toolchains stay usable; only the workspace
 * (workspace-write) is writable. Network is not unshared. */
export function bwrapArgs(mode: SandboxMode, cwd: string): string[] {
  if (mode === "danger-full-access") return [];
  const args = ["--die-with-parent", "--unshare-pid", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/tmp", "--ro-bind", "/", "/"];
  if (mode === "workspace-write") args.push("--bind", cwd, cwd);
  args.push("--chdir", cwd, "--");
  return args;
}
