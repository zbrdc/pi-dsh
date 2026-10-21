/** pi-dsh: DeepSeek Harness on-track tooling ported to Pi.
 * One owner for todos, plan mode, goals, guards, spill/pruning, FS policy,
 * jobs, PTY terminals, subagents, PTC run_code, and workflow. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import {
  RepeatTracker, spillText, pruneText, validateTodos, generateSdk,
  newGoal, applyBlocker, renderGoalRound, renderTaskControlSection, validateRules, Semaphore, completedTurnCut,
  resolveToolTimeoutMs, timeoutFieldCaps, fuseSignal, ToolWatchdog, parseOutputSchema,
  SANDBOX_ORDER, type TodoItem, type Goal, type SandboxMode,
} from "./core.ts";
import { JobRegistry } from "./jobs.ts";
import { TerminalRegistry, PersistentBash, runShellJob } from "./terminal.ts";
import { NodePtcProvider, MossbedProvider, PythonPtcProvider, type PtcBindings } from "./ptc.ts";
import { SubagentManager, renderAgentLine, type CatalogEntry } from "./subagent.ts";
import { TeamBoard, renderTeamTask, type TeamTaskAction } from "./team.ts";
import { PANEL_KEY, WIDGET_KEYS, columnsWidget, renderAgentsWidget, renderDashboard, renderJobsWidget, renderStatusLine, renderTodoWidget, renderWidgetSections, type UiState } from "./ui.ts";

const ENTRY = { todo: "pi-dsh/todo", rules: "pi-dsh/rules", plan: "pi-dsh/plan", goal: "pi-dsh/goal", catalog: "pi-dsh/catalog", team: "pi-dsh/team-tasks" };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
const errText = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details, isError: true as const });

interface Config {
  allowParallelInProgress: boolean; spillMaxInlineTokens: number; pruneThresholdChars: number;
  ptcOnly: boolean; persistentPtc: boolean; maxActiveSubagents: number; goalBlockedThreshold: number;
  sandboxMode: SandboxMode; maxParallelSubCalls: number;
  completionDelivery: "wakeup" | "quiet"; maxConsecutiveWakes?: number;
  uiWidgets: boolean;
  toolTimeoutMs?: Record<string, number>; defaultToolTimeoutMs?: number;
  toolTimeoutAction: "abort" | "notify";
  durableTerminals: boolean;
  sandboxRunnerCommand?: string[];
  maxSubagentDepth: number; subagentTimeoutMs?: number;
  subagentModels?: string[];
  subagentPresets?: Record<string, { description?: string; systemAppend?: string; tools?: string[]; model?: string; thinkingLevel?: string }>;
  maxTeamMembers: number; maxTeamTasks: number;
}
function loadConfig(): Config {
  const defaults: Config = {
    allowParallelInProgress: true, spillMaxInlineTokens: 12500, pruneThresholdChars: 400_000,
    ptcOnly: false, persistentPtc: false, maxActiveSubagents: 8, goalBlockedThreshold: 3,
    sandboxMode: "danger-full-access", maxParallelSubCalls: 10, completionDelivery: "wakeup",
    uiWidgets: true, toolTimeoutAction: "abort", durableTerminals: false,
    maxSubagentDepth: 1, maxTeamMembers: 16, maxTeamTasks: 256,
  };
  try {
    const path = join(homedir(), ".pi", "agent", "pi-dsh.json");
    if (existsSync(path)) return { ...defaults, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<Config>) };
  } catch { /* invalid config falls back to defaults; surfaced at session_start */ }
  return defaults;
}

export default function (pi: any) {
  const config = loadConfig();
  const jobs = new JobRegistry();
  const terminals = new TerminalRegistry();
  const nodePtc = new NodePtcProvider();
  const pythonPtc = new PythonPtcProvider();
  const mossbed = new MossbedProvider();
  jobs.setPersistRoot(join(homedir(), ".pi", "agent", "pi-dsh", "jobs"));
  terminals.setPersistRoot(join(homedir(), ".pi", "agent", "pi-dsh", "terminals"));
  const board = new TeamBoard(config.maxTeamTasks);
  const subagents = new SubagentManager({
    maxActive: config.maxActiveSubagents, maxDepth: config.maxSubagentDepth,
    defaultTimeoutMs: config.subagentTimeoutMs, board,
  });
  const watchdog = new ToolWatchdog();

  let lastCtx: any;
  let owner = "unknown";
  let todos: TodoItem[] = [];
  let rules: string[] = [];
  let planActive = false;
  let goal: Goal | undefined;
  let humanTurn = false;
  let wakeCount = 0;
  let pendingGoalRound: number | undefined;
  let pendingPlanPrompt: string | undefined;
  let lastControlSection = "";
  let teamEntries: unknown[] = [];
  let persistentBash: PersistentBash | undefined;
  let persistentPwsh: PersistentBash | undefined;
  const repeat = new RepeatTracker([3, 5, 8]);
  const observed = new Map<string, string>();
  const absent = new Set<string>();

  const remember = (ctx: any) => { lastCtx = ctx; try { owner = ctx.sessionManager.getSessionId(); } catch { /* keep */ } };
  const notify = (content: string, customType = "pi-dsh/notice") => {
    try {
      const quiet = config.completionDelivery === "quiet";
      const capped = config.maxConsecutiveWakes !== undefined && wakeCount >= config.maxConsecutiveWakes;
      if (lastCtx?.isIdle?.() && !quiet && !capped) { wakeCount++; pi.sendMessage({ customType, content, display: true }, { triggerTurn: true }); }
      else if (lastCtx?.isIdle?.()) pi.sendMessage({ customType, content, display: true }, { deliverAs: "nextTurn" });
      else pi.sendMessage({ customType, content, display: true }, { deliverAs: "steer" });
    } catch { /* disposed session: notice is best-effort, state is durable */ }
  };
  const uiState = (): UiState => ({
    goal, todos, planActive,
    jobs: jobs.list(owner), agents: subagents.list(owner), terminals: terminals.list(owner), teamTasks: board.snapshot(),
  });
  /** One refresh for every widget + status (DSH ui-goal/ui-jobs/ui-subagent, Pi-shaped). */
  const refreshUI = () => {
    if (!config.uiWidgets) return;
    try {
      if (!lastCtx?.hasUI) return;
      const state = uiState();
      lastCtx.ui.setStatus("pi-dsh", renderStatusLine(state));
      const sections = renderWidgetSections(state);
      if (lastCtx.mode === "tui") {
        // One side-by-side panel; component widgets exist only in the TUI.
        const columns = WIDGET_KEYS.map((key) => sections[key]).filter((s): s is string[] => s !== undefined);
        lastCtx.ui.setWidget(PANEL_KEY, columns.length > 0 ? columnsWidget(columns) : undefined);
      } else {
        for (const key of WIDGET_KEYS) lastCtx.ui.setWidget(`pi-dsh-${key}`, sections[key]);
      }
    } catch { /* UI gone */ }
  };
  const updateGoalWidget = refreshUI;
  /** Command feedback that works headless: TUI notify, else a displayed session message. */
  const safeNotify = (ctx: any, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      if (ctx?.hasUI) ctx.ui.notify(message, type);
      else pi.sendMessage({ customType: "pi-dsh/notice", content: message, display: true }, { deliverAs: "nextTurn" });
    } catch { /* disposed session */ }
  };
  /** Resolve a sandbox request against the standing mode; widening needs justification + approval. */
  const resolveSandbox = async (ctx: any, requested?: string, justification?: string): Promise<{ mode: SandboxMode } | { error: string }> => {
    const standing = config.sandboxMode;
    const target = (requested as SandboxMode | undefined) ?? standing;
    if (!(SANDBOX_ORDER as string[]).includes(target)) return { error: `unknown sandbox_permissions: ${String(target)}` };
    if (SANDBOX_ORDER.indexOf(target) <= SANDBOX_ORDER.indexOf(standing)) return { mode: target };
    if (!justification?.trim()) return { error: `sandbox escalation to ${target} requires a non-empty justification` };
    if (!ctx.hasUI) return { error: `sandbox escalation to ${target} denied: no UI to approve it` };
    const ok = await ctx.ui.confirm(`Allow sandbox escalation to ${target}?`, justification);
    return ok ? { mode: target } : { error: `sandbox escalation to ${target} denied by user` };
  };
  /** Expand @file references: text files inline (capped), images as read_image pointers. */
  const expandAttachments = (input: string, cwd: string): string => input.replace(/@(\S+\.[A-Za-z0-9]+)/g, (whole, rel) => {
    try {
      const path = isAbsolute(rel) ? rel : resolve(cwd, rel);
      if (/\.(png|jpe?g|webp|gif)$/i.test(rel)) return `[attached image: ${path} — load with read_image]`;
      const body = readFileSync(path, "utf8");
      return body.length > 8000 ? `[attached file ${path}]\n${body.slice(0, 8000)}\n[... truncated ...]` : `[attached file ${path}]\n${body}`;
    } catch { return whole; }
  });
  const currentControlSection = () => renderTaskControlSection({ goal, todos, planActive, rules });
  const hasControlState = () => Boolean(goal) || todos.some((t) => t.status !== "completed") || planActive || rules.length > 0;
  const persistGoal = () => { if (goal) pi.appendEntry(ENTRY.goal, goal); updateGoalWidget(); };
  const hashFile = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const resolvePath = (ctx: any, p: string) => (isAbsolute(p) ? p : resolve(ctx.cwd, p));

  function restore(ctx: any) {
    remember(ctx);
    todos = []; rules = []; planActive = false; goal = undefined; teamEntries = []; pendingGoalRound = undefined; pendingPlanPrompt = undefined; observed.clear(); absent.clear();
    const catalog: CatalogEntry[] = [];
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type !== "custom") continue;
      if (e.customType === ENTRY.todo) todos = (e.data as TodoItem[]) ?? [];
      if (e.customType === ENTRY.rules) rules = (e.data as string[]) ?? [];
      if (e.customType === ENTRY.plan) { planActive = Boolean((e.data as any)?.active); if (typeof (e.data as any)?.prompt === "string" && planActive) pendingPlanPrompt = (e.data as any).prompt; }
      if (e.customType === ENTRY.goal) goal = e.data as Goal;
      if (e.customType === ENTRY.team) teamEntries = (e.data as unknown[]) ?? [];
      if (e.customType === ENTRY.catalog) {
        const entry = e.data as CatalogEntry;
        const i = catalog.findIndex((c) => c.childId === entry.childId);
        if (i >= 0) catalog[i] = entry; else catalog.push(entry);
      }
    }
    board.restore(teamEntries);
    subagents.restore(catalog);
    jobs.restore(owner);
    terminals.restore(owner);
    refreshUI();
  }

  pi.on("session_start", async (_e: any, ctx: any) => restore(ctx));
  pi.on("session_tree", async (_e: any, ctx: any) => restore(ctx));
  pi.on("session_compact", async (_e: any, ctx: any) => {
    remember(ctx);
    // Compaction summaries are derivative; force the authoritative goal/todo
    // snapshot back into the next request even if it has not changed.
    lastControlSection = "";
    updateGoalWidget();
  });
  pi.on("session_shutdown", async () => {
    await jobs.disposeOwner(owner, { keepDurable: true }).catch(() => undefined);
    await terminals.disposeOwner(owner, { keepDurable: true }).catch(() => undefined);
    await subagents.disposeOwner(owner).catch(() => undefined);
    nodePtc.disposeAll();
  });
  pi.on("input", async (e: any, ctx: any) => {
    remember(ctx);
    if (e.source !== "extension") { humanTurn = true; repeat.reset(); wakeCount = 0; }
  });
  pi.on("turn_start", async (_e: any, ctx: any) => {
    remember(ctx);
    // A queued goal round counts only once its turn actually starts (admission).
    if (goal && pendingGoalRound !== undefined) {
      goal.roundsStarted = pendingGoalRound; pendingGoalRound = undefined; persistGoal();
    }
    updateGoalWidget();
  });
  pi.on("before_agent_start", async (e: any, ctx: any) => {
    remember(ctx);
    const control = currentControlSection();
    e.systemPromptOptions.sections["pi_dsh"] = control;
    lastControlSection = control;
    if (!planActive) return undefined;
    // Deliver a /plan <task> queued headlessly (print mode may never run the
    // follow-up user message; whichever turn happens first carries the task).
    const queued = pendingPlanPrompt;
    pendingPlanPrompt = undefined;
    return { message: {
      customType: "pi-dsh/plan", display: false,
      content: `Plan mode is active. Explore and design before executing. Do not make changes yet. When the plan is complete, call exit_plan_mode with the full plan as markdown for user review.${queued ? `\n\nPlan task (from /plan): ${queued}` : ""}`,
    } };
  });

  // ---- Tool deadlines (dsh timeout-policy, Pi-shaped) ----
  // DSH wraps dispatch and swaps in a deadline signal per call. A Pi extension
  // cannot swap the signal of a model-issued foreign call, so enforcement is:
  // cap timeout-shaped inputs at tool_call, fuse real deadline signals into
  // nested executeTool calls (PTC), and run a watchdog over top-level calls
  // whose configured deadline aborts the turn and stamps TOOL_TIMEOUT on the
  // result. Tools with no configured limit are untouched, as in DSH.
  pi.on("tool_execution_start", async (e: any, ctx: any) => {
    remember(ctx);
    if (e.parentToolCallId) return; // nested calls carry their own fused signal
    const timeoutMs = resolveToolTimeoutMs(e.toolName, config);
    if (timeoutMs === undefined) return;
    watchdog.arm(e.toolCallId, e.toolName, timeoutMs, (toolName, ms) => {
      notify(`[pi-dsh] TOOL_TIMEOUT: ${toolName} exceeded its ${ms}ms deadline${config.toolTimeoutAction === "abort" ? "; aborting the turn" : ""}.`, "pi-dsh/tool-timeout");
      if (config.toolTimeoutAction === "abort") { try { lastCtx?.abort?.(); } catch { /* already settled */ } }
    });
  });
  pi.on("tool_execution_end", async (e: any) => { watchdog.clear(e.toolCallId, true); refreshUI(); });

  // ---- Guards, FS policy (tool_call) ----
  pi.on("tool_call", async (e: any, ctx: any) => {
    remember(ctx);
    const reminder = repeat.observe(e.toolName, e.input);
    if (reminder) notify(reminder, "pi-dsh/repeat-reminder");
    const capMs = Math.min(resolveToolTimeoutMs(e.toolName, config) ?? 600_000, 600_000);
    for (const { field, capped } of timeoutFieldCaps(e.input, capMs)) e.input[field] = capped;
    if ((e.toolName === "edit" || e.toolName === "write") && typeof e.input?.path === "string") {
      const path = resolvePath(ctx, e.input.path);
      let exists = true;
      try { await stat(path); } catch { exists = false; }
      if (!exists) {
        if (e.toolName === "edit") return { block: true, reason: `FS_NOT_FOUND: cannot edit "${path}": file does not exist — create it with write, then retry` };
        return undefined; // creating needs no observation
      }
      const seen = observed.get(path);
      if (seen === undefined) return { block: true, reason: `FS_NOT_OBSERVED: cannot modify "${path}": file has not been read — read the file, then retry` };
      const now = await hashFile(path).catch(() => "");
      if (now !== seen) return { block: true, reason: `FS_STALE_VERSION: "${path}" changed since it was read — re-read the file, then retry` };
    }
    return undefined;
  });

  // ---- Spill + observation recording (tool_result) ----
  pi.on("tool_result", async (e: any, ctx: any) => {
    remember(ctx);
    const timedOut = watchdog.settle(e.toolCallId);
    if (e.toolName === "read" && typeof e.input?.path === "string") {
      const path = resolvePath(ctx, e.input.path);
      const h = await hashFile(path).catch(() => undefined);
      if (h !== undefined && !e.isError) { observed.set(path, h); absent.delete(path); }
      else { absent.add(path); observed.delete(path); }
    }
    if ((e.toolName === "edit" || e.toolName === "write") && !e.isError && typeof e.input?.path === "string") {
      const path = resolvePath(ctx, e.input.path);
      const h = await hashFile(path).catch(() => undefined);
      if (h !== undefined) { observed.set(path, h); absent.delete(path); }
    }
    if (timedOut) {
      const body = (e.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      return {
        content: [{ type: "text", text: `Error: tool call timed out after ${timedOut.timeoutMs}ms (TOOL_TIMEOUT)${body ? `\nPartial result before the deadline:\n${body.slice(0, 4000)}` : ""}` }],
        structuredContent: e.structuredContent, details: { ...(e.details ?? {}), piDshTimeout: timedOut }, isError: true,
      };
    }
    const imageBlocks = (e.content ?? []).filter((c: any) => c.type === "image");
    if (imageBlocks.length > 0 && !e.isError) {
      const textNow = (e.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      const estTokens = Math.ceil(textNow.length / 4) + imageBlocks.length * 1500;
      if (estTokens > config.spillMaxInlineTokens) {
        const dir = join(homedir(), ".pi", "agent", "pi-dsh", "spill", owner);
        try {
          mkdirSync(dir, { recursive: true });
          const content = [];
          let n = 0;
          for (const c of e.content ?? []) {
            if (c.type !== "image") { content.push(c); continue; }
            const ext = c.mimeType === "image/jpeg" ? "jpg" : c.mimeType === "image/webp" ? "webp" : c.mimeType === "image/gif" ? "gif" : "png";
            const file = join(dir, `${String(e.toolCallId).replace(/[^A-Za-z0-9_-]/g, "_")}-${n++}.${ext}`);
            writeFileSync(file, Buffer.from(c.data ?? "", "base64"));
            content.push({ type: "text", text: `[image spilled to ${file}; load it with read_image]` });
          }
          return { content, structuredContent: e.structuredContent, details: e.details };
        } catch { /* leave original */ }
      }
    }
    const joined = (e.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    if (joined.length > config.spillMaxInlineTokens * 4 && !e.isError) {
      const dir = join(homedir(), ".pi", "agent", "pi-dsh", "spill", owner);
      const file = join(dir, `${String(e.toolCallId).replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
      let locator = file;
      try { mkdirSync(dir, { recursive: true }); writeFileSync(file, joined, "utf8"); }
      catch { return undefined; } // recovery failure leaves original content (dsh spill-policy)
      const spilled = spillText(joined, config.spillMaxInlineTokens, locator);
      if (spilled.spilled) return { content: [{ type: "text", text: spilled.text }], structuredContent: e.structuredContent, details: e.details };
    }
    return undefined;
  });

  // ---- Pruner (context) ----
  pi.on("context", async (e: any) => {
    const size = JSON.stringify(e.messages).length;
    if (size < config.pruneThresholdChars) {
      const control = currentControlSection();
      if (hasControlState() && control !== lastControlSection) {
        lastControlSection = control;
        return { messages: [...e.messages, {
          role: "custom", customType: "pi-dsh/control", display: false, timestamp: Date.now(),
          content: [{ type: "text", text: `<pi_dsh>\n${control}\n</pi_dsh>` }],
        }] };
      }
      return undefined;
    }
    const toolIdx = e.messages.map((m: any, i: number) => (m.role === "toolResult" ? i : -1)).filter((i: number) => i >= 0);
    const keepFrom = toolIdx.length > 6 ? (toolIdx[toolIdx.length - 6] as number) : Number.POSITIVE_INFINITY;
    let changed = false;
    const messages = [];
    const offloadDir = join(homedir(), ".pi", "agent", "pi-dsh", "spill", owner);
    for (let i = 0; i < e.messages.length; i++) {
      const m = e.messages[i];
      const isOld = i < keepFrom;
      if ((m.role !== "toolResult" && m.role !== "user") || !isOld) { messages.push(m); continue; }
      const content = [];
      for (const c of m.content ?? []) {
        if (c.type === "image" && typeof c.data === "string") {
          try {
            mkdirSync(offloadDir, { recursive: true });
            const ext = c.mimeType === "image/jpeg" ? "jpg" : "png";
            const file = join(offloadDir, `offload-${i}-${content.length}.${ext}`);
            writeFileSync(file, Buffer.from(c.data, "base64"));
            changed = true;
            content.push({ type: "text", text: `[image offloaded under context pressure: ${file}; load with read_image]` });
            continue;
          } catch { /* keep inline */ }
        }
        if (m.role === "toolResult" && c.type === "text" && c.text.length > 8000) {
          changed = true; content.push({ ...c, text: pruneText(c.text, 8000) }); continue;
        }
        content.push(c);
      }
      messages.push({ ...m, content });
    }
    const control = currentControlSection();
    if (hasControlState() && control !== lastControlSection) {
      lastControlSection = control;
      messages.push({
        role: "custom", customType: "pi-dsh/control", display: false, timestamp: Date.now(),
        content: [{ type: "text", text: `<pi_dsh>\n${control}\n</pi_dsh>` }],
      });
      changed = true;
    }
    return changed ? { messages } : undefined;
  });

  // ---- todo_write ----
  pi.registerTool({
    name: "todo_write", label: "Todo write",
    description: "Maintain a structured task list: break multi-step work into concrete tasks, mark actively worked tasks in_progress, check tasks off as they finish. Send the COMPLETE list on every update; it replaces the previous list. Several tasks may be in_progress at once.",
    promptSnippet: "Replace the whole task list",
    parameters: Type.Object({ todos: Type.Array(Type.Object({
      content: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
    })) }),
    async execute(_id: string, params: any, _sig: unknown, _upd: unknown, ctx: any) {
      remember(ctx);
      try { todos = validateTodos(params.todos, config.allowParallelInProgress); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
      pi.appendEntry(ENTRY.todo, todos);
      refreshUI();
      const n = (s: string) => todos.filter((t) => t.status === s).length;
      return text(`Updated todo list: ${n("pending")} pending, ${n("in_progress")} in progress, ${n("completed")} completed.`);
    },
  });

  // ---- Standing rules (pi-dsh addition; DSH carries these in AGENTS.md and its LLM checkpoint) ----
  pi.registerTool({
    name: "rules_write", label: "Rules write",
    description: "Record durable user instructions (preferences, constraints, prohibitions) that must outlive this turn and any context summary. Send the COMPLETE list on every update; it replaces the previous list. Remove a rule once the user lifts it. Not for task steps (use todo_write) or the objective (use create_goal).",
    promptSnippet: "Replace the standing rules list",
    parameters: Type.Object({ rules: Type.Array(Type.String()) }),
    async execute(_id: string, params: any, _sig: unknown, _upd: unknown, ctx: any) {
      remember(ctx);
      try { rules = validateRules(params.rules); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
      pi.appendEntry(ENTRY.rules, rules);
      return text(`Updated standing rules: ${rules.length} active.`);
    },
  });

  // ---- Plan mode ----
  pi.registerCommand("plan", {
    description: "Enter or leave plan mode (/plan [task], /plan off)",
    handler: async (args: string, ctx: any) => {
      remember(ctx);
      const task = args.trim();
      if (task === "off") {
        planActive = false; pendingPlanPrompt = undefined;
        pi.appendEntry(ENTRY.plan, { active: false });
        refreshUI(); safeNotify(ctx, "Plan mode off"); return;
      }
      planActive = true;
      // Persist the task with the plan state so print/json mode (where a
      // follow-up user message may never be dispatched) still delivers it:
      // before_agent_start injects it into the next turn that does run.
      pendingPlanPrompt = task || undefined;
      pi.appendEntry(ENTRY.plan, { active: true, ...(task ? { prompt: task } : {}) });
      refreshUI(); safeNotify(ctx, "Plan mode on");
      // A custom message entry (not only a custom entry) so a fresh session persists its file.
      pi.sendMessage({ customType: "pi-dsh/plan", content: "Plan mode is active: explore and design, then present the plan with exit_plan_mode.", display: true });
      if (task) {
        if (ctx.hasUI) pi.sendUserMessage(task);
        else pi.sendUserMessage(task, { deliverAs: "followUp" });
      }
    },
  });
  pi.registerTool({
    name: "exit_plan_mode", label: "Exit plan mode", exposure: "model-only",
    description: "Present the completed plan for user review. Only callable in plan mode. Approval leaves plan mode and the plan is carried out from the next step; rejection returns feedback and planning continues.",
    promptSnippet: "Present plan for review",
    parameters: Type.Object({ plan: Type.String() }),
    async execute(_id: string, params: any, _sig: unknown, _upd: unknown, ctx: any) {
      remember(ctx);
      if (!planActive) return errText("Error: exit_plan_mode called outside plan mode");
      let approved = true; let feedback = "";
      if (ctx.hasUI) {
        const choice = await ctx.ui.select(`Plan review\n\n${params.plan}`, ["Approve — carry out the plan", "Keep planning — send feedback"]);
        approved = choice?.startsWith("Approve") ?? false;
        if (!approved) feedback = (await ctx.ui.input("Feedback for the plan", "What should change?")) ?? "";
      }
      if (!approved) return text(`User kept plan mode active. Feedback: ${feedback || "(none)"}. Revise the plan and call exit_plan_mode again.`);
      planActive = false; pendingPlanPrompt = undefined; pi.appendEntry(ENTRY.plan, { active: false }); refreshUI();
      return text("Plan approved. Plan mode is now inactive; carry out the plan from the next step.");
    },
  });

  // ---- read_image ----
  pi.registerTool({
    name: "read_image", label: "Read image",
    description: "Read a PNG/JPEG/WebP/GIF image file and return it for visual inspection. Extension-less paths are identified by file signature.",
    parameters: Type.Object({ file_path: Type.String() }),
    async execute(_id: string, params: any, _sig: unknown, _upd: unknown, ctx: any) {
      remember(ctx);
      const path = resolvePath(ctx, params.file_path);
      let bytes: Buffer;
      try { bytes = await readFile(path); } catch { return errText(`Error: FS_NOT_FOUND: cannot read image "${path}"`); }
      if (bytes.length > 10 * 1024 * 1024) return errText(`Error: image too large (${bytes.length} bytes)`);
      const sig = bytes.subarray(0, 12);
      let mime: string | undefined;
      if (sig[0] === 0x89 && sig[1] === 0x50) mime = "image/png";
      else if (sig[0] === 0xff && sig[1] === 0xd8) mime = "image/jpeg";
      else if (sig.toString("ascii", 0, 4) === "RIFF" && sig.toString("ascii", 8, 12) === "WEBP") mime = "image/webp";
      else if (sig.toString("ascii", 0, 3) === "GIF") mime = "image/gif";
      if (!mime) return errText(`Error: unsupported image signature in "${path}"`);
      observed.set(path, createHash("sha256").update(bytes).digest("hex"));
      return { content: [
        { type: "text" as const, text: `Image: ${path} (${mime}, ${bytes.length} bytes)` },
        { type: "image" as const, data: bytes.toString("base64"), mimeType: mime },
      ], details: {} };
    },
  });

  // ---- Jobs + bash ----
  jobs.onSettle = (snap, info) => {
    refreshUI();
    if (info.owner !== owner || info.awaited || info.killRequested) return;
    notify(`background job ${snap.id} (${snap.kind}: ${snap.label}) finished [status: ${snap.status}]. Read its output with job_output.`, "pi-dsh/job-complete");
  };
  pi.registerTool({
    name: "job_output", label: "Job output", description: "Read a background job's output since the previous read. wait=true blocks up to timeout_ms (capped) and leaves a running job alive.",
    parameters: Type.Object({ job_id: Type.String(), wait: Type.Optional(Type.Boolean()), timeout_ms: Type.Optional(Type.Number()) }),
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try { const r = await jobs.output(p.job_id, owner, { wait: p.wait, timeoutMs: p.timeout_ms }); return text(r.text); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "job_list", label: "Job list", description: "List your background jobs with ids, kinds, and statuses.",
    parameters: Type.Object({}),
    async execute(_id: string, _p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      const rows = jobs.list(owner).map((j) => `${j.id} [${j.kind}] ${j.status}${j.progress ? ` — ${j.progress}` : ` — ${j.label}`}`);
      return text(rows.length ? rows.join("\n") : "No background jobs.");
    },
  });
  pi.registerTool({
    name: "job_kill", label: "Job kill", description: "Cancel a running background job; settles once the work actually stops.",
    parameters: Type.Object({ job_id: Type.String(), reason: Type.Optional(Type.String()) }),
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try { const r = await jobs.kill(p.job_id, owner, p.reason); return text(`${r.outcome}: ${r.job.id} [status: ${r.job.status}]`); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });

  const startBashJob = (command: string, cwd: string, description: string, sandboxMode: SandboxMode, shell = "bash") => {
    // Durable output lives under the workspace (reachable inside the sandbox too).
    const dir = join(cwd, ".pi-dsh", "jobs");
    const stamp = `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outFile = join(dir, `${stamp}.out`); const exitFile = join(dir, `${stamp}.exit`);
    try { mkdirSync(dir, { recursive: true }); } catch { /* shell will report */ }
    const startedId = jobs.start({
      kind: "bash", label: description || command.slice(0, 60), owner, durable: { outFile, exitFile },
      run: async (h) => {
        let offset = 0;
        const poll = setInterval(() => {
          try {
            const body = readFileSync(outFile, "utf8");
            if (body.length > offset) { h.append(body.slice(offset)); offset = body.length; }
          } catch { /* not created yet */ }
        }, 250);
        try {
          await runShellJob({ command, cwd, signal: h.signal, append: (t) => h.append(t), sandboxMode, shell, outFile, exitFile, sandboxRunner: config.sandboxRunnerCommand });
        } finally { clearInterval(poll); }
        try { const body = readFileSync(outFile, "utf8"); if (body.length > offset) h.append(body.slice(offset)); } catch { /* gone */ }
        let code = "0";
        try { code = readFileSync(exitFile, "utf8").trim(); } catch { /* killed before writing */ }
        if (code !== "0" && code !== "") h.append(`\n[exit code: ${code}]\n`);
        return {};
      },
    });
    refreshUI();
    return startedId;
  };
  pi.registerTool({
    name: "bash", label: "Bash (pi-dsh)",
    description: "Run a Bash command in a fresh shell. State does not persist; pass workdir instead of cd. With run_in_background, returns a job id at once. A foreground command that outlives timeout is promoted to its background job (same id); collect it with job_output. Verify the resolved absolute target path before any delete or move, and guard variables in such paths with ${VAR:?}.",
    promptSnippet: "Run a bash command (job-aware)",
    parameters: Type.Object({
      command: Type.String(), description: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.Number()), workdir: Type.Optional(Type.String()),
      run_in_background: Type.Optional(Type.Boolean()),
      sandbox_permissions: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write"), Type.Literal("danger-full-access")])),
      justification: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      const sb = await resolveSandbox(ctx, p.sandbox_permissions, p.justification);
      if ("error" in sb) return errText(`Error: ${sb.error}`);
      const cwd = p.workdir ? resolvePath(ctx, p.workdir) : ctx.cwd;
      const jobId = startBashJob(p.command, cwd, p.description ?? "", sb.mode);
      if (p.run_in_background) return text(`started background job ${jobId}`);
      const timeoutMs = Math.min(Math.max(1, (p.timeout ?? 120)) * 1000, 600_000);
      const r = await jobs.output(jobId, owner, { wait: true, timeoutMs });
      if (r.job.status === "running") return text(`${r.text}\n[command still running as background job ${jobId}; read it with job_output]`);
      return text(r.text.replace(/\n\[status: \w+\]$/, ""));
    },
  });
  pi.registerTool({
    name: "bash_persistent", label: "Bash persistent",
    description: "Run a command in a persistent Bash shell. cwd, exported variables, and functions persist across calls for this agent. exit, timeout, or cancellation resets the shell. Interactive stdin is unsupported; use terminal tools for that.",
    parameters: Type.Object({ command: Type.String(), timeout_ms: Type.Optional(Type.Number()) }),
    executionMode: "sequential",
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      persistentBash ??= new PersistentBash(terminals, owner, ctx.cwd);
      const r = await persistentBash.run(p.command, p.timeout_ms ?? 300_000);
      return text(r.text);
    },
  });

  // ---- Terminal tools ----
  const termParams = (extra: Record<string, unknown> = {}) => Type.Object({ terminal_id: Type.String(), ...extra });
  pi.registerTool({
    name: "terminal_open", label: "Terminal open", description: "Open a persistent PTY terminal session owned by this agent. durable=true runs it in a detached tmux session that survives a pi exit and reattaches on restore (requires tmux); non-durable terminals keep a transcript but their shell dies with pi.",
    parameters: Type.Object({ label: Type.Optional(Type.String()), durable: Type.Optional(Type.Boolean()) }),
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        const s = await terminals.open(owner, { cwd: ctx.cwd, label: p.label, durable: p.durable ?? config.durableTerminals });
        refreshUI();
        return text(`opened terminal ${s.id} [${s.backend}${s.durable ? ", durable" : ""}]`);
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "terminal_send", label: "Terminal send", description: "Send input to a PTY terminal. run_in_background registers the send as a job.",
    parameters: termParams({ input: Type.String(), run_in_background: Type.Optional(Type.Boolean()) }),
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        const s = terminals.get(owner, p.terminal_id);
        terminals.send(owner, p.terminal_id, p.input);
        if (p.run_in_background) {
          const jobId = jobs.start({ kind: "terminal", label: p.input.slice(0, 60), owner,
            run: async (h) => { const iv = setInterval(() => { const out = s.ring.readNew(); if (out) h.append(out); }, 250); await s.exited; clearInterval(iv); h.append(s.ring.readNew()); } });
          return text(`sent; background job ${jobId}`);
        }
        await new Promise((r) => setTimeout(r, 500));
        return text(s.ring.readNew() || "(no output yet)");
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "terminal_read", label: "Terminal read", description: "Read new output from a PTY terminal.",
    parameters: termParams(),
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try { return text(terminals.get(owner, p.terminal_id).ring.readNew() || "(no new output)"); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "terminal_list", label: "Terminal list", description: "List this agent's PTY terminals.",
    parameters: Type.Object({}),
    async execute(_id: string, _p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      const rows = terminals.list(owner).map((t) => `${t.id} [${t.backend}${t.durable ? ",durable" : ""}] ${t.alive ? "alive" : "exited"} — ${t.label} (${t.cwd})`);
      return text(rows.length ? rows.join("\n") : "No terminals.");
    },
  });
  pi.registerTool({
    name: "terminal_close", label: "Terminal close", description: "Close a PTY terminal.",
    parameters: termParams(),
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try { await terminals.close(owner, p.terminal_id); refreshUI(); return text(`closed terminal ${p.terminal_id}`); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "terminal_signal", label: "Terminal signal", description: "Send a signal (for example SIGINT) to a PTY terminal's process.",
    parameters: termParams({ signal: Type.String() }),
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try { terminals.signal(owner, p.terminal_id, p.signal); return text(`sent ${p.signal} to ${p.terminal_id}`); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });

  pi.registerTool({
    name: "terminal_resize", label: "Terminal resize", description: "Resize a PTY terminal (node-pty backend only).",
    parameters: termParams({ cols: Type.Number(), rows: Type.Number() }),
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try { terminals.resize(owner, p.terminal_id, Math.max(1, Math.floor(p.cols)), Math.max(1, Math.floor(p.rows))); return text(`resized ${p.terminal_id} to ${Math.floor(p.cols)}x${Math.floor(p.rows)}`); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  // PowerShell tools register only when a pwsh/powershell binary exists (Windows-shaped hosts).
  const pwshBin = ["/usr/bin/pwsh", "/usr/local/bin/pwsh"].find((f) => existsSync(f));
  if (pwshBin) {
    pi.registerTool({
      name: "pwsh", label: "PowerShell",
      description: "Run a PowerShell command in a fresh process with native paths and $env: variables. Job-aware like bash.",
      parameters: Type.Object({ command: Type.String(), description: Type.Optional(Type.String()), timeout: Type.Optional(Type.Number()), workdir: Type.Optional(Type.String()), run_in_background: Type.Optional(Type.Boolean()) }),
      async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
        remember(ctx);
        const cwd = p.workdir ? resolvePath(ctx, p.workdir) : ctx.cwd;
        const jobId = startBashJob(p.command, cwd, p.description ?? "", config.sandboxMode, pwshBin);
        if (p.run_in_background) return text(`started background job ${jobId}`);
        const r = await jobs.output(jobId, owner, { wait: true, timeoutMs: Math.min(Math.max(1, (p.timeout ?? 120)) * 1000, 600_000) });
        return text(r.job.status === "running" ? `${r.text}\n[still running as job ${jobId}]` : r.text.replace(/\n\[status: \w+\]$/, ""));
      },
    });
    pi.registerTool({
      name: "pwsh_persistent", label: "PowerShell persistent",
      description: "Run a command in a persistent PowerShell session (state persists across calls).",
      parameters: Type.Object({ command: Type.String(), timeout_ms: Type.Optional(Type.Number()) }),
      executionMode: "sequential",
      async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
        remember(ctx);
        persistentPwsh ??= new PersistentBash(terminals, owner, ctx.cwd, pwshBin);
        return text((await persistentPwsh.run(p.command, p.timeout_ms ?? 300_000)).text);
      },
    });
  }

  // ---- Subagents ----
  subagents.onCatalog = (entry) => { refreshUI(); try { pi.appendEntry(ENTRY.catalog, entry); } catch { /* session gone */ } };
  subagents.onSettle = (entry, result, delivery) => {
    refreshUI();
    if (entry.owner !== owner || delivery !== "parent") return;
    notify(`subagent ${entry.childId} (${entry.provider}: ${entry.label}, depth ${entry.depth}) finished [status: ${result.status}${result.stopReason && result.stopReason !== result.status ? `/${result.stopReason}` : ""}]. Final answer:\n${result.text.slice(0, 8000)}${result.data !== undefined ? `\nStructured result: ${JSON.stringify(result.data).slice(0, 4000)}` : ""}`, "pi-dsh/subagent-complete");
  };
  subagents.onParentMessage = (from, message, messageId) => {
    notify(`Agent ${from.name ?? from.label} (${from.childId}) sent a message (${messageId}):\n${message.slice(0, 8000)}`, "pi-dsh/agent-message");
  };
  /** Resolve an optional child model route ("provider/modelId" preferred,
   * bare modelId when unique) against the live registry + allowlist. */
  const resolveChildModel = (ctx: any, wanted?: string): { model: unknown; label?: string } | { error: string } => {
    if (!wanted) return { model: ctx.model };
    const available: any[] = ctx.modelRegistry?.getAvailable?.() ?? ctx.modelRegistry?.getAll?.() ?? [];
    const labelOf = (m: any) => `${m.provider}/${m.id}`;
    let found: any;
    if (wanted.includes("/")) {
      const slash = wanted.indexOf("/");
      found = ctx.modelRegistry?.find?.(wanted.slice(0, slash), wanted.slice(slash + 1)) ?? available.find((m: any) => labelOf(m) === wanted);
    } else {
      const matches = available.filter((m: any) => m.id === wanted);
      if (matches.length > 1) return { error: `model "${wanted}" is ambiguous (${matches.map(labelOf).join(", ")}); use provider/modelId` };
      found = matches[0];
    }
    if (!found) return { error: `unknown subagent model route "${wanted}"; call list_subagent_models` };
    const label = labelOf(found);
    if (config.subagentModels && config.subagentModels.length > 0 && !config.subagentModels.includes(label)) {
      return { error: `subagent model ${label} is not in the configured subagentModels allowlist` };
    }
    return { model: found, label };
  };
  subagents.opts.resolveModel = (label: string) => {
    if (!lastCtx) return undefined;
    const r = resolveChildModel(lastCtx, label);
    return "model" in r ? r.model : undefined;
  };
  const resolvePreset = (name?: string): { preset?: NonNullable<Config["subagentPresets"]>[string] } | { error: string } => {
    if (!name) return {};
    const preset = config.subagentPresets?.[name];
    if (!preset) return { error: `unknown subagent preset "${name}" (configured: ${Object.keys(config.subagentPresets ?? {}).join(", ") || "none"})` };
    return { preset };
  };
  const forkSeed = (ctx: any): any[] => {
    const msgs = ctx.sessionManager.getBranch()
      .filter((e: any) => e.type === "message").map((e: any) => e.message);
    return msgs.slice(0, completedTurnCut(msgs));
  };
  const THINKING = Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")]));
  const delegate = (provider: "spawn" | "fork", name: string, contextNote: string) => pi.registerTool({
    name, label: `Subagent (${provider})`, exposure: "model-only" as const,
    description: `Delegate work to a fresh child agent and return its id immediately; the final answer arrives in a completion notice. ${contextNote} The child shares the workspace and runs at depth 1 of ${config.maxSubagentDepth}. Optional: model (provider/modelId, see list_subagent_models), thinking_level, preset (spawn only), timeout_ms, output_schema (requires structured_output). Use for bounded, self-contained subtasks; start independent delegations together. In single-shot print runs, collect results with wait_agent before finishing — background children are aborted when the process exits.`,
    parameters: Type.Object({
      task: Type.String(), label: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()), thinking_level: THINKING, preset: Type.Optional(Type.String()),
      timeout_ms: Type.Optional(Type.Number()),
      // Models often stringify the schema; accept both shapes and parse below.
      output_schema: Type.Optional(Type.Union([Type.Object({}, { additionalProperties: true }), Type.String()])),
      require_structured: Type.Optional(Type.Boolean()),
    }),
    prepareArguments: (args: any) => {
      if (args && typeof args.output_schema === "string") {
        try { return { ...args, output_schema: parseOutputSchema(args.output_schema) }; } catch { return args; }
      }
      return args;
    },
    async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        const presetRes = resolvePreset(p.preset);
        if ("error" in presetRes) return errText(`Error: ${presetRes.error}`);
        const preset = presetRes.preset;
        const modelRes = resolveChildModel(ctx, p.model ?? preset?.model);
        if ("error" in modelRes) return errText(`Error: ${modelRes.error}`);
        const childId = await subagents.start({
          provider, label: p.label ?? "task", task: p.task, owner,
          cwd: p.cwd ? resolvePath(ctx, p.cwd) : ctx.cwd, model: modelRes.model, modelLabel: modelRes.label,
          thinkingLevel: p.thinking_level ?? preset?.thinkingLevel, preset: p.preset,
          tools: preset?.tools, systemAppend: preset?.systemAppend,
          timeoutMs: p.timeout_ms, outputSchema: parseOutputSchema(p.output_schema),
          requireStructured: p.require_structured === true,
          seedMessages: provider === "fork" ? forkSeed(ctx) : undefined, delivery: "parent",
        });
        return text(`started subagent ${childId}`);
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  delegate("spawn", "subagent", "It does NOT see this conversation; the task must stand alone.");
  delegate("fork", "subagent_fork", "It sees this conversation's completed turns, but NOT the current in-flight turn.");
  pi.registerTool({
    name: "list_subagent_models", label: "List subagent models", exposure: "model-only",
    description: "List model routes available for subagent delegation (provider/modelId). Pass one as the model argument to subagent, subagent_fork, or spawn_teammate.",
    parameters: Type.Object({}),
    async execute(_i: string, _p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      const available: any[] = ctx.modelRegistry?.getAvailable?.() ?? [];
      const allow = config.subagentModels && config.subagentModels.length > 0 ? new Set(config.subagentModels) : undefined;
      const rows = available.map((m: any) => `${m.provider}/${m.id}`).filter((r: string) => !allow || allow.has(r)).sort();
      return text(rows.length ? rows.join("\n") : "No models available.");
    },
  });
  const resolveAgentRef = (p: any): string => String(p.agent_id ?? p.child_id ?? "");
  pi.registerTool({
    name: "send_message", label: "Send message (subagent)", exposure: "model-only",
    description: "Send a follow-up message to a continuable child subagent (steers if working, resumes if settled, cold-resumes from its saved session after a restart). Accepts a child id or teammate name. Returns delivery acceptance with a messageId, never a reply.",
    parameters: Type.Object({ agent_id: Type.String(), message: Type.String(), deliver_as: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])) }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        const target = subagents.resolve(owner, resolveAgentRef(p));
        if (!target) return errText(`Error: message not delivered: unknown agent ${resolveAgentRef(p)}`);
        return text(await subagents.sendMessageAs(owner, target.childId, String(p.message), p.deliver_as ?? "steer"));
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "interrupt_agent", label: "Interrupt agent", exposure: "model-only",
    description: "Interrupt a running descendant's current turn and wait for it to settle. The child stays continuable via send_message. Accepts a child id or teammate name.",
    parameters: Type.Object({ agent_id: Type.String() }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        const target = subagents.resolve(owner, resolveAgentRef(p));
        if (!target) return errText(`Error: unknown agent ${resolveAgentRef(p)}`);
        await subagents.interrupt(target.childId);
        return text(`interrupt requested for agent ${target.childId}`);
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "list_agents", label: "List agents", exposure: "model-only",
    description: "List subagents in this session tree from the catalog (no transcripts loaded). scope=children: direct children. scope=descendants: the whole tree in pre-order with parent and depth. Status running/live means a turn may be executing; settled rows show their outcome.",
    parameters: Type.Object({ scope: Type.Optional(Type.Union([Type.Literal("children"), Type.Literal("descendants")])) }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      const entries = p.scope === "descendants" ? subagents.descendants(owner) : subagents.childrenOf(owner);
      const rows = entries.map((e) => {
        const line = renderAgentLine(e, e.status === "live" && subagents.status(e.childId).running);
        return p.scope === "descendants" ? `${line} parent=${e.parentId}` : line;
      });
      return text(rows.length ? rows.join("\n") : "(no subagents)");
    },
  });
  pi.registerTool({
    name: "agent_status", label: "Agent status", exposure: "model-only",
    description: "Inspect one subagent in depth: status, depth, parent, model, elapsed, turns, tool calls, recent activity, latest text, structured result, and session file. Accepts a child id or teammate name.",
    parameters: Type.Object({ agent_id: Type.String() }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        const target = subagents.resolve(owner, resolveAgentRef(p));
        if (!target) return errText(`Error: unknown agent ${resolveAgentRef(p)}`);
        const s = subagents.status(target.childId);
        const e = s.entry;
        const lines = [
          renderAgentLine(e, s.running),
          `parent=${e.parentId} role=${e.role}${e.name ? ` name=${e.name}` : ""} continuable=${e.continuable} elapsed=${Math.round(s.elapsedMs / 1000)}s turns=${e.turns} toolCalls=${e.toolCalls}`,
          `cwd=${e.cwd}${e.sessionFile ? `\nsession=${e.sessionFile}` : ""}${e.preset ? `\npreset=${e.preset}` : ""}${e.thinkingLevel ? `\nthinking=${e.thinkingLevel}` : ""}`,
        ];
        if (s.activity.length > 0) lines.push(`recent activity:\n${s.activity.slice(-10).map((a) => `- ${a.text}`).join("\n")}`);
        if (e.resultData !== undefined) lines.push(`structured result: ${JSON.stringify(e.resultData).slice(0, 4000)}`);
        if (s.lastText) lines.push(`latest text:\n${s.lastText.slice(0, 2000)}`);
        return text(lines.join("\n"));
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });

  // ---- Agent teams (dsh experimental agent-team) ----
  const persistTeam = () => { refreshUI(); try { pi.appendEntry(ENTRY.team, board.snapshot()); } catch { /* gone */ } };
  board.onChange = () => persistTeam();
  pi.registerTool({
    name: "spawn_teammate", label: "Spawn teammate", exposure: "model-only",
    description: "Create a named teammate (lead only). Names are permanent lowercase slugs, never reused. The teammate shares this workspace and the team task board, can message any member by name, and can claim board tasks. fork=true seeds it with your completed turns. Returns its id; results arrive as completion notices, or via wait_agent.",
    parameters: Type.Object({
      name: Type.String(), task: Type.String(), description: Type.Optional(Type.String()),
      fork: Type.Optional(Type.Boolean()), model: Type.Optional(Type.String()), thinking_level: THINKING,
      preset: Type.Optional(Type.String()), timeout_ms: Type.Optional(Type.Number()),
    }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      const name = String(p.name ?? "");
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return errText(`Error: invalid teammate name "${name}" (lowercase slug, max 32 chars)`);
      if (subagents.nameTaken(owner, name)) return errText(`Error: teammate name "${name}" is already taken and names are never reused`);
      const members = subagents.list(owner).filter((e) => e.role === "teammate").length;
      if (members >= config.maxTeamMembers) return errText(`Error: TEAM_MEMBER_LIMIT: this team already has ${config.maxTeamMembers} teammates`);
      const presetRes = resolvePreset(p.preset);
      if ("error" in presetRes) return errText(`Error: ${presetRes.error}`);
      const modelRes = resolveChildModel(ctx, p.model ?? presetRes.preset?.model);
      if ("error" in modelRes) return errText(`Error: ${modelRes.error}`);
      try {
        const childId = await subagents.start({
          provider: p.fork === true ? "fork" : "spawn", label: `team:${name}`, name, role: "teammate",
          task: String(p.task), owner, cwd: ctx.cwd, model: modelRes.model, modelLabel: modelRes.label,
          thinkingLevel: p.thinking_level ?? presetRes.preset?.thinkingLevel, preset: p.preset,
          tools: presetRes.preset?.tools, timeoutMs: p.timeout_ms, delivery: "parent",
          seedMessages: p.fork === true ? forkSeed(ctx) : undefined,
          systemAppend: [p.description ? `Your role on the team: ${String(p.description)}` : "", presetRes.preset?.systemAppend ?? ""].filter(Boolean).join("\n\n") || undefined,
        });
        return text(`spawned teammate ${name}: ${childId}`);
      } catch (e) {
        subagents.recordFailed({ owner, name, label: `team:${name}`, role: "teammate", cwd: ctx.cwd, error: e instanceof Error ? e.message : String(e) });
        refreshUI();
        return errText(`Error: teammate ${name} failed to start: ${e instanceof Error ? e.message : String(e)} (recorded as failed; the name stays taken)`);
      }
    },
  });
  pi.registerTool({
    name: "wait_agent", label: "Wait agent", exposure: "model-only",
    description: "With agent_id: wait for that subagent/teammate to settle (up to timeout_ms) and return its status, final text, and structured result. Without agent_id: wait for the next team change (a settle, start, message, or task-board update), then re-read state with list_agents/team_task_list. Returns noProgress immediately when nothing is running.",
    parameters: Type.Object({ agent_id: Type.Optional(Type.String()), timeout_ms: Type.Optional(Type.Number()) }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        if (p.agent_id) {
          const target = subagents.resolve(owner, String(p.agent_id));
          if (!target) return errText(`Error: unknown agent ${String(p.agent_id)}`);
          const wait = subagents.wait(target.childId);
          const r = p.timeout_ms !== undefined
            ? await Promise.race([wait, new Promise<undefined>((res) => setTimeout(() => res(undefined), Math.min(Math.max(1, Number(p.timeout_ms)), 3_600_000)))])
            : await wait;
          if (r === undefined) return text(`timeout: agent ${target.childId} is still ${subagents.status(target.childId).running ? "running" : target.status}; wait again or keep working`);
          return text(`[${r.status}${r.stopReason && r.stopReason !== r.status ? `/${r.stopReason}` : ""}] ${r.text}${r.data !== undefined ? `\nStructured result: ${JSON.stringify(r.data).slice(0, 8000)}` : ""}`);
        }
        if (!subagents.hasLive(owner)) return text("noProgress: no subagent is running; wake one with send_message or spawn one first");
        const timeout = Math.min(Math.max(1000, Number(p.timeout_ms ?? 60_000)), 3_600_000);
        const changed = await Promise.race([board.waitForChange(timeout), subagents.waitForChange(timeout)]);
        return text(changed ? "changed: team state moved (agent settle/start/message or task-board update); re-read with list_agents and team_task_list" : "timeout: no team change within the wait window");
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "team_task_create", label: "Team task create", exposure: "model-only",
    description: "Add a task to the durable shared team board. blockedBy: task ids that must complete before this is claimable. writeScopes: workspace-relative prefixes the task will modify (advisory overlap warnings).",
    parameters: Type.Object({
      subject: Type.String(), description: Type.Optional(Type.String()),
      blockedBy: Type.Optional(Type.Array(Type.String())), writeScopes: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try { return text(renderTeamTask(board.create("lead", p))); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "team_task_list", label: "Team task list", exposure: "model-only",
    description: "List durable shared team tasks with owner, revision, readiness, dependencies, and write-scope warnings.",
    parameters: Type.Object({}),
    async execute(_i: string, _p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      const rows = board.list();
      return text(rows.length ? rows.map(renderTeamTask).join("\n\n") : "No team tasks.");
    },
  });
  pi.registerTool({
    name: "team_task_get", label: "Team task get", exposure: "model-only",
    description: "Read one team task in full (note its revision before updating).",
    parameters: Type.Object({ task_id: Type.String() }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try { return text(renderTeamTask(board.get(String(p.task_id)))); }
      catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "team_task_update", label: "Team task update", exposure: "model-only",
    description: "Update a team task with compare-and-set (revision from team_task_get/list). Actions: claim, release, complete, reopen, assign (lead only, sets owner), delete, edit (subject/description/blockedBy/writeScopes). Stale revisions are rejected with TEAM_TASK_STALE_REVISION.",
    parameters: Type.Object({
      task_id: Type.String(), revision: Type.Number(),
      action: Type.Union([Type.Literal("claim"), Type.Literal("release"), Type.Literal("complete"), Type.Literal("reopen"), Type.Literal("assign"), Type.Literal("delete"), Type.Literal("edit")]),
      owner: Type.Optional(Type.String()), subject: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
      blockedBy: Type.Optional(Type.Array(Type.String())), writeScopes: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        return text(renderTeamTask(board.update("lead", true, {
          taskId: String(p.task_id), expectedRevision: Number(p.revision), action: p.action as TeamTaskAction,
          owner: p.owner, subject: p.subject, description: p.description, blockedBy: p.blockedBy, writeScopes: p.writeScopes,
        })));
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });

  // ---- Goals ----
  const requireHuman = () => {
    if (!humanTurn) throw new Error("goal create/edit/pause/resume requires a direct human request in a top-level turn");
  };
  const cas = (p: any) => {
    if (!goal) throw new Error("no goal exists");
    if (p.goal_id !== goal.id || p.revision !== goal.revision) throw new Error(`stale goal view: current is id=${goal.id} revision=${goal.revision}; call get_goal first`);
    return goal;
  };
  pi.registerTool({
    name: "create_goal", label: "Create goal", exposure: "model-only",
    description: "Create the session's single long-running goal from a direct human request. The goal persists across turns and auto-continues while armed.",
    parameters: Type.Object({ objective: Type.String(), max_rounds: Type.Optional(Type.Number()) }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        requireHuman();
        goal = newGoal(`goal-${Date.now()}`, expandAttachments(String(p.objective), ctx.cwd), p.max_rounds ?? 256);
        persistGoal();
        return text(`Created goal ${goal.id} revision ${goal.revision}: ${goal.objective}`);
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerTool({
    name: "get_goal", label: "Get goal", exposure: "model-only",
    description: "Read the current persisted goal (id, revision, objective, status, rounds).",
    parameters: Type.Object({}),
    async execute(_i: string, _p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      return text(goal ? `id=${goal.id} revision=${goal.revision} status=${goal.status} rounds=${goal.roundsStarted}/${goal.maxGoalRounds} armed=${goal.armed}\nObjective: ${goal.objective}${goal.blocker ? `\nBlocker: ${goal.blocker} (x${goal.blockerRounds})` : ""}` : "No goal.");
    },
  });
  pi.registerTool({
    name: "update_goal", label: "Update goal", exposure: "model-only",
    description: "Update the goal. Requires exact goal_id and revision from get_goal. action: edit|pause|resume|complete|block. complete triggers an independent reviewer audit; rejected completions stay active with feedback. block needs the same concrete blocker for 3 consecutive rounds.",
    parameters: Type.Object({
      goal_id: Type.String(), revision: Type.Number(),
      action: Type.Union([Type.Literal("edit"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("complete"), Type.Literal("block")]),
      objective: Type.Optional(Type.String()), blocker: Type.Optional(Type.String()), evidence: Type.Optional(Type.String()),
    }),
    async execute(_i: string, p: any, _s: unknown, _u: unknown, ctx: any) {
      remember(ctx);
      try {
        const g = cas(p);
        if (p.action === "edit" || p.action === "pause" || p.action === "resume") requireHuman();
        if (p.action === "edit") { if (p.objective) g.objective = String(p.objective); g.revision++; }
        if (p.action === "pause") { g.status = "paused"; g.armed = false; g.revision++; }
        if (p.action === "resume") { g.status = "active"; g.armed = true; g.blockerRounds = 0; g.revision++; }
        if (p.action === "block") {
          if (!p.blocker) throw new Error("block requires a concrete blocker string");
          goal = applyBlocker(g, String(p.blocker), config.goalBlockedThreshold); persistGoal();
          return text(goal.status === "blocked" ? `Goal blocked after ${config.goalBlockedThreshold} consecutive rounds: ${goal.blocker}` : `Blocker recorded (${goal.blockerRounds}/${config.goalBlockedThreshold}); goal stays active.`);
        }
        if (p.action === "complete") {
          g.status = "auditing"; g.revision++; persistGoal();
          const reviewerId = await subagents.start({
            provider: "spawn", label: "goal-auditor", role: "auditor", owner, cwd: ctx.cwd, model: ctx.model, delivery: "caller",
            tools: ["read", "grep", "find", "ls", "bash", "structured_output"], requireStructured: true,
            outputSchema: {
              type: "object",
              properties: {
                verdict: { type: "string", enum: ["accept", "reject"] },
                gaps: { type: "string", description: "What is missing or wrong; empty when accepting." },
                summary: { type: "string" },
                evidence: {},
              },
              required: ["verdict", "gaps"],
            },
            task: `You are an independent auditor. Verify whether this goal is genuinely complete in the current workspace: ${JSON.stringify(g.objective)}. Claimed evidence: ${JSON.stringify(p.evidence ?? "")}. Inspect the workspace yourself. You MUST finish by calling the structured_output tool exactly once with verdict set to "accept" or "reject" and gaps set to what is missing or wrong (empty if accepting). Do not only answer in prose.`,
          });
          const res = await subagents.wait(reviewerId);
          let data = res.data as { verdict?: string; gaps?: string } | undefined;
          if (data?.verdict === undefined) {
            // The auditor is an independent agent; accept its explicit JSON verdict from text as a fallback.
            const m = res.text.match(/\{\s*"verdict"\s*:\s*"(accept|reject)"[^}]*\}/);
            if (m) { try { data = JSON.parse(m[0]) as { verdict?: string; gaps?: string }; } catch { data = { verdict: m[1], gaps: "" }; } }
            else if (/verdict[:\s*]+accept\b/i.test(res.text) && !/verdict[:\s*]+reject\b/i.test(res.text)) data = { verdict: "accept", gaps: "" };
          }
          if (data?.verdict === "accept") {
            g.status = "complete"; g.armed = false; g.revision++; persistGoal();
            return text("Goal completion accepted by auditor. Goal marked complete.");
          }
          g.status = "active"; g.revision++; persistGoal();
          return text(`Completion REJECTED by auditor. Gaps: ${data?.gaps ?? res.text.slice(0, 2000)}. Keep working; do not claim completion until these are addressed.`);
        }
        persistGoal();
        return text(`Goal updated: status=${g.status} revision=${g.revision}.`);
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  pi.registerCommand("goal", {
    description: "Inspect or control the session goal (/goal status|pause|resume|clear|<objective>)",
    handler: async (args: string, ctx: any) => {
      remember(ctx);
      const a = args.trim();
      if (!a || a === "status") { safeNotify(ctx, goal ? `${goal.status} r${goal.roundsStarted}/${goal.maxGoalRounds}: ${goal.objective}` : "No goal"); return; }
      if (a === "clear") { goal = undefined; pi.appendEntry(ENTRY.goal, undefined); refreshUI(); safeNotify(ctx, "Goal cleared"); return; }
      if (a === "pause" && goal) { goal.status = "paused"; goal.armed = false; goal.revision++; }
      else if (a === "resume" && goal) { goal.status = "active"; goal.armed = true; goal.revision++; }
      else if (a !== "pause" && a !== "resume") goal = newGoal(`goal-${Date.now()}`, expandAttachments(a, ctx.cwd));
      persistGoal(); safeNotify(ctx, `Goal: ${goal?.status} — ${goal?.objective}`);
    },
  });
  // ---- Dashboard commands (user-facing views over widget state) ----
  pi.registerCommand("dsh", {
    description: "Show the pi-dsh dashboard (goal, todos, jobs, agents, terminals)",
    handler: async (_args: string, ctx: any) => { remember(ctx); refreshUI(); safeNotify(ctx, renderDashboard(uiState())); },
  });
  pi.registerCommand("rules", {
    description: "Show the standing rules (/rules clear to drop them all)",
    handler: async (args: string, ctx: any) => {
      remember(ctx);
      if (args.trim() === "clear") { rules = []; pi.appendEntry(ENTRY.rules, rules); safeNotify(ctx, "Standing rules cleared."); return; }
      safeNotify(ctx, rules.length > 0 ? ["Standing rules:", ...rules.map((r) => `- ${r}`)].join("\n") : "No standing rules.");
    },
  });
  pi.registerCommand("todos", {
    description: "Show the current todo list",
    handler: async (_args: string, ctx: any) => { remember(ctx); safeNotify(ctx, renderTodoWidget(todos, 40)?.join("\n") ?? "No todos."); },
  });
  pi.registerCommand("jobs", {
    description: "Show background jobs (or /jobs kill <id>)",
    handler: async (args: string, ctx: any) => {
      remember(ctx);
      const killId = args.trim().match(/^kill\s+(\S+)$/)?.[1];
      if (killId) {
        try { const r = await jobs.kill(killId, owner); refreshUI(); safeNotify(ctx, `${r.outcome}: ${killId} [${r.job.status}]`); }
        catch (e) { safeNotify(ctx, `Error: ${e instanceof Error ? e.message : String(e)}`, "error"); }
        return;
      }
      safeNotify(ctx, renderJobsWidget(jobs.list(owner), 30)?.join("\n") ?? "No background jobs.");
    },
  });
  pi.registerCommand("agents", {
    description: "Show subagents and team tasks",
    handler: async (_args: string, ctx: any) => { remember(ctx); safeNotify(ctx, renderAgentsWidget(uiState(), 40)?.join("\n") ?? "No subagents, terminals, or team tasks."); },
  });
  pi.registerCommand("terminals", {
    description: "Show PTY terminals (or /terminals close <id>)",
    handler: async (args: string, ctx: any) => {
      remember(ctx);
      const closeId = args.trim().match(/^close\s+(\S+)$/)?.[1];
      if (closeId) {
        try { await terminals.close(owner, closeId); refreshUI(); safeNotify(ctx, `closed terminal ${closeId}`); }
        catch (e) { safeNotify(ctx, `Error: ${e instanceof Error ? e.message : String(e)}`, "error"); }
        return;
      }
      const rows = terminals.list(owner).map((t) => `${t.id} [${t.backend}${t.durable ? ",durable" : ""}] ${t.alive ? "alive" : "exited"} — ${t.label} (${t.cwd})`);
      safeNotify(ctx, rows.length ? rows.join("\n") : "No terminals.");
    },
  });
  // Goal round driver: continue at quiescence while armed, allowance remains, no live descendants.
  pi.on("agent_settled", async (_e: any, ctx: any) => {
    remember(ctx); humanTurn = false;
    if (!goal || goal.status !== "active" || !goal.armed) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (subagents.hasLive(owner) || jobs.hasRunning(owner)) return;
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      goal.status = "blocked"; goal.blocker = `round-limit: reached ${goal.maxGoalRounds} rounds`; goal.armed = false; goal.revision++;
      persistGoal(); notify("Goal reached its round limit and was blocked.", "pi-dsh/goal"); return;
    }
    if (pendingGoalRound !== undefined) return;
    pendingGoalRound = goal.roundsStarted + 1;
    pi.sendUserMessage(renderGoalRound(goal, pendingGoalRound));
  });

  // ---- PTC run_code ----
  const toolText = (outcome: any): string => (outcome?.result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const buildBindings = (ctx: any, signal: AbortSignal | undefined, capturedImages?: any[]): PtcBindings => {
    const tools: Record<string, (args: any) => Promise<any>> = {};
    const scheduler = new Semaphore(Math.max(1, config.maxParallelSubCalls));
    for (const t of (ctx.tools ?? [])) {
      if (t.name === "run_code" || t.name === "codemode") continue;
      tools[t.name] = (args: any) => scheduler.run(async () => {
        // Nested calls get a real fused deadline signal (per-tool config).
        const outcome = await ctx.executeTool(t.name, args ?? {}, { signal: fuseSignal(signal, resolveToolTimeoutMs(t.name, config)) });
        // Surface image results after the outer run_code result (dsh PTC behaviour).
        const images = (outcome.result?.content ?? []).filter((c: any) => c.type === "image");
        if (capturedImages && images.length > 0 && !outcome.isError) capturedImages.push(...images);
        if (outcome.isError) throw new Error(toolText(outcome) || `tool ${t.name} failed`);
        const textOut = toolText(outcome);
        return outcome.result?.structuredContent ?? (images.length > 0 ? `${textOut}\n[${images.length} image(s) returned; attached after the program result]` : textOut);
      });
    }
    return { tools };
  };
  const renderPtc = (name: string, r: { value?: unknown; logs: string[]; error?: { kind: string; message: string } }) => {
    const logs = r.logs.join("\n");
    if (r.error) return errText(`Error: code run failed (${r.error.kind}): ${r.error.message}${logs ? `\nCaptured output:\n${logs}` : ""}`);
    const value = r.value === null || r.value === undefined ? "" : JSON.stringify(r.value, null, 2);
    const out = [logs, value ? `Return value: ${value}` : ""].filter(Boolean).join("\n");
    return text(out || `(${name} completed with no output)`);
  };
  pi.registerTool({
    name: "run_code", label: "Run code (PTC)", exposure: "model-only",
    description: "Run a program as an async function body (node, erasable TypeScript), Python statements that assign result (python), or sandboxed JS (mossbed). Call tools as await tools.<name>(args) (python: tools.<name>(args_dict)); nested calls run through the full tool pipeline (max 10 parallel) and resolve to structured content when declared, else text. Image results attach after the program result. A wider sandbox_permissions than the standing mode needs justification and user approval. Default timeout 120000ms, max 600000ms.",
    promptSnippet: "Run code that calls tools programmatically",
    reachesTools: () => "all" as const,
    parameters: Type.Object({
      code: Type.String(), description: Type.String(),
      timeout_ms: Type.Optional(Type.Number()),
      backend: Type.Optional(Type.Union([Type.Literal("node"), Type.Literal("mossbed"), Type.Literal("python")])),
      sandbox_permissions: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write"), Type.Literal("danger-full-access")])),
      justification: Type.Optional(Type.String()),
    }),
    prepareLoadout: (loadout: any) => {
      const sdk = generateSdk(loadout.callable.filter((t: any) => t.name !== "run_code").map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters, outputSchema: t.outputSchema })));
      const self = loadout.declared.find((t: any) => t.name === "run_code");
      const descriptions = self ? { run_code: `${self.description}\n\nSDK bindings for this program (not directly callable tools):\n${sdk}` } : undefined;
      // Like codemode "only": hide direct tools (still callable via tools.*),
      // but keep model-only orchestrators (subagent, workflow, goals) declared.
      return config.ptcOnly
        ? { descriptions, hiddenDeclarations: loadout.declared.filter((t: any) => t.name !== "run_code" && loadout.getExposure(t.name) === "direct").map((t: any) => t.name) }
        : { descriptions };
    },
    async execute(_id: string, p: any, signal: AbortSignal | undefined, _u: unknown, ctx: any) {
      remember(ctx);
      const sb = await resolveSandbox(ctx, p.sandbox_permissions, p.justification);
      if ("error" in sb) return errText(`Error: ${sb.error}`);
      const capturedImages: any[] = [];
      const bindings = buildBindings(ctx, signal, capturedImages);
      let rendered;
      if (p.backend === "mossbed") rendered = renderPtc("run_code", await mossbed.run({ program: p.code, bindings, cwd: ctx.cwd, timeoutMs: p.timeout_ms, signal }));
      else if (p.backend === "python") rendered = renderPtc("run_code", await pythonPtc.run({ program: p.code, bindings, cwd: ctx.cwd, timeoutMs: p.timeout_ms, signal }));
      else rendered = renderPtc("run_code", await nodePtc.run({
        program: await stripTypes(p.code), bindings, cwd: ctx.cwd,
        timeoutMs: p.timeout_ms, signal, stateOwner: config.persistentPtc ? owner : undefined, sandboxMode: sb.mode,
        sandboxRunner: config.sandboxRunnerCommand,
      }));
      if (capturedImages.length > 0) {
        rendered = { ...rendered, content: [...(rendered.content ?? []), ...capturedImages.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))] };
      }
      return rendered;
    },
  });

  // ---- Workflow ----
  pi.registerTool({
    name: "workflow", label: "Workflow", exposure: "model-only",
    description: "Run a JavaScript orchestration script that fans work out across many subagents and returns a final JSON value. Use ONLY when the user explicitly asks for a workflow or large multi-agent orchestration; for one or two delegations prefer subagent. Script hooks: agent(prompt, opts?), parallel(thunks), pipeline(items, ...stages), phase(title), log(msg); meta and args are globals. Child failures resolve agent() to null; partial output is never reported as success.",
    promptGuidelines: ["Use the workflow tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration. For one or two delegations, prefer plain subagent calls."],
    reachesTools: () => "all" as const,
    parameters: Type.Object({
      meta: Type.Object({ name: Type.String(), description: Type.String() }),
      script: Type.String(), args: Type.Optional(Type.Any()),
      run_in_background: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, p: any, signal: AbortSignal | undefined, _u: unknown, ctx: any) {
      remember(ctx);
      const runWorkflow = async (jobSignal: AbortSignal, logLine: (s: string) => void) => {
        let started = 0;
        // Queue workflow starts through the tree capacity instead of failing
        // wide parallel() fan-outs: a slot is held for the child's lifetime.
        const slots = new Semaphore(Math.max(1, config.maxActiveSubagents));
        const wf: Record<string, (a: any) => Promise<any>> = {
          agent: async (a: any) => {
            if (++started > 1000) throw new Error("workflow agent cap (1000) reached");
            const o = typeof a === "object" && a !== null ? a : { task: String(a) };
            return slots.run(async () => {
              try {
                const presetRes = resolvePreset(o.preset);
                if ("error" in presetRes) return null;
                const modelRes = resolveChildModel(ctx, o.model ?? presetRes.preset?.model);
                if ("error" in modelRes) return null;
                const childId = await subagents.start({
                  provider: "spawn", label: o.label ?? p.meta.name, task: o.task ?? o.prompt ?? "", role: "workflow",
                  owner, cwd: o.cwd ? resolvePath(ctx, String(o.cwd)) : ctx.cwd,
                  model: modelRes.model, modelLabel: modelRes.label,
                  thinkingLevel: o.thinkingLevel ?? o.thinking_level ?? presetRes.preset?.thinkingLevel,
                  preset: o.preset, tools: presetRes.preset?.tools, systemAppend: presetRes.preset?.systemAppend,
                  timeoutMs: o.timeoutMs ?? o.timeout_ms, delivery: "caller",
                  outputSchema: o.schema, requireStructured: o.requireStructured === true || o.schema !== undefined,
                });
                const res = await subagents.wait(childId);
                if (res.status !== "completed") return null;
                return res.data ?? res.text;
              } catch { return null; }
            });
          },
          phase: async (t: any) => { logLine(`[phase] ${String(t)}`); return null; },
          log: async (t: any) => { logLine(String(t)); return null; },
        };
        const prelude = [
          `const meta = ${JSON.stringify(p.meta)}; const args = ${JSON.stringify(p.args ?? {})};`,
          "const agent = (a, o) => _wf.agent(typeof a === 'string' ? { task: a, ...(o ?? {}) } : a);",
          "const phase = (t) => _wf.phase(t); const log = (t) => _wf.log(t);",
          "const parallel = async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));",
          "const pipeline = async (items, ...stages) => { let cur = items; for (const s of stages) cur = await parallel(cur.map((it, i) => () => s(it, it, i))); return cur; };",
        ].join("\n");
        const r = await nodePtc.run({ program: await stripTypes(p.script), bindings: { _wf: wf }, cwd: ctx.cwd, timeoutMs: null, signal: jobSignal, prelude });
        return { r, started };
      };
      if (p.run_in_background) {
        const jobId = jobs.start({ kind: "workflow", label: p.meta.name, owner, run: async (h) => {
          const { r } = await runWorkflow(h.signal, (s) => h.append(s + "\n"));
          if (r.error) throw new Error(r.error.message);
          return { result: `workflow "${p.meta.name}" completed.\nReturn value:\n${JSON.stringify(r.value, null, 2)}` };
        } });
        return text(`started background workflow job ${jobId}`);
      }
      const { r, started } = await runWorkflow(signal ?? new AbortController().signal, () => undefined);
      if (r.error) return errText(`Error: workflow run failed: ${r.error.message}`);
      const rendered = JSON.stringify(r.value, null, 2) ?? "null";
      return text(`workflow "${p.meta.name}" completed (${started} agent${started === 1 ? "" : "s"}).\nReturn value:\n${rendered.length > 50_000 ? rendered.slice(0, 50_000) + "\n[... truncated ...]" : rendered}`);
    },
  });
}

/** Erasable TypeScript: strip types with Node's built-in stripper when available. */
async function stripTypes(code: string): Promise<string> {
  try {
    const mod: any = await import("node:module");
    if (typeof mod.stripTypeScriptTypes === "function") return mod.stripTypeScriptTypes(code);
  } catch { /* fall through: program was plain JavaScript */ }
  return code;
}
