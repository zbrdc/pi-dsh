/** Pure text renderers for pi-dsh widgets, status line, and /dsh dashboard.
 * Pi's extension UI offers string-array widgets and a footer status; these
 * functions produce bounded lines for them (dsh ui-goal/ui-jobs/ui-subagent
 * equivalents within what a Pi extension can draw). Only pi-tui's pure width
 * helpers are imported, so everything stays unit-testable without a TUI. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Goal, TodoItem } from "./core.ts";
import type { JobSnapshot } from "./jobs.ts";
import { renderAgentLine, type CatalogEntry } from "./subagent.ts";

export interface TerminalRow { id: string; label: string; alive: boolean; backend: string }
export interface TeamTaskRow { id: string; subject: string; status: string; owner?: string }
export interface UiState {
  goal?: Goal; todos: TodoItem[]; planActive: boolean;
  /** Notices waiting for the model (see outbox.ts). */
  inbox?: number;
  /** Active reminders of this session (see schedule-service.ts). */
  reminders?: number;
  jobs: JobSnapshot[]; agents: CatalogEntry[]; terminals: TerminalRow[]; teamTasks: TeamTaskRow[];
}

const clip = (s: string, n = 72): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ago = (ts: number, now: number): string => {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
};
/** Keep the first `max` lines, collapsing the rest into one summary line. */
export function capLines(lines: string[], max: number): string[] {
  if (max <= 0 || lines.length <= max) return lines;
  return [...lines.slice(0, max - 1), `… +${lines.length - (max - 1)} more`];
}

export function renderStatusLine(state: UiState): string {
  const parts = ["dsh"];
  if (state.planActive) parts.push("plan");
  if (state.goal) parts.push(`goal ${state.goal.status} r${state.goal.roundsStarted}/${state.goal.maxGoalRounds}`);
  const open = state.todos.filter((t) => t.status !== "completed").length;
  if (open > 0) parts.push(`${open} todo${open === 1 ? "" : "s"}`);
  const running = state.jobs.filter((j) => j.status === "running").length;
  if (running > 0) parts.push(`${running} job${running === 1 ? "" : "s"}`);
  const live = state.agents.filter((a) => a.status === "live").length;
  if (live > 0) parts.push(`${live} agent${live === 1 ? "" : "s"}`);
  const terms = state.terminals.filter((t) => t.alive).length;
  if (terms > 0) parts.push(`${terms} term${terms === 1 ? "" : "s"}`);
  if (state.inbox) parts.push(`${state.inbox} notice${state.inbox === 1 ? "" : "s"}`);
  if (state.reminders) parts.push(`${state.reminders} reminder${state.reminders === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function renderGoalWidget(goal: Goal | undefined): string[] | undefined {
  if (!goal) return undefined;
  const icon = goal.status === "complete" ? "✔" : goal.status === "blocked" ? "⛔" : goal.status === "paused" ? "⏸" : "◎";
  const lines = [`${icon} Goal (${goal.status}, round ${goal.roundsStarted}/${goal.maxGoalRounds}${goal.armed ? ", armed" : ""}): ${clip(goal.objective, 90)}`];
  if (goal.blocker) lines.push(`  blocker x${goal.blockerRounds}: ${clip(goal.blocker, 90)}`);
  return lines;
}

export function renderTodoWidget(todos: TodoItem[], maxLines = 8): string[] | undefined {
  if (todos.length === 0) return undefined;
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = [`☑ Todos ${done}/${todos.length}`];
  for (const t of todos) lines.push(`${t.status === "completed" ? "✔" : t.status === "in_progress" ? "▶" : "○"} ${clip(t.content)}`);
  return capLines(lines, maxLines);
}

const JOB_ICON: Record<string, string> = { running: "▶", completed: "✔", failed: "✖", killed: "■" };
export function renderJobsWidget(jobs: JobSnapshot[], maxLines = 6, now = Date.now()): string[] | undefined {
  if (jobs.length === 0) return undefined;
  const sorted = [...jobs].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt);
  const lines = sorted.map((j) => {
    const when = j.status === "running" ? `${ago(j.startedAt, now)}…` : ago(j.finishedAt ?? j.startedAt, now);
    return `${JOB_ICON[j.status] ?? "?"} ${j.id} [${j.kind}] ${j.status} ${when} — ${clip(j.progress ?? j.label, 48)}`;
  });
  return capLines([`⚙ Jobs (${jobs.filter((j) => j.status === "running").length} running)`, ...lines], maxLines);
}

export function renderAgentsWidget(state: UiState, maxLines = 8): string[] | undefined {
  const lines: string[] = [];
  const live = state.agents.filter((a) => a.status === "live");
  const settled = state.agents.length - live.length;
  if (state.agents.length > 0) {
    lines.push(`🤖 Agents (${live.length} live${settled ? `, ${settled} settled` : ""})`);
    for (const a of live) lines.push(`▶ ${clip(renderAgentLine(a, false), 96)}`);
  }
  const aliveTerms = state.terminals.filter((t) => t.alive);
  if (state.terminals.length > 0) {
    lines.push(`🖥 Terminals (${aliveTerms.length} alive)`);
    for (const t of aliveTerms) lines.push(`▶ ${t.id} [${t.backend}] ${clip(t.label, 48)}`);
  }
  const openTeam = state.teamTasks.filter((t) => t.status !== "completed" && t.status !== "deleted");
  if (openTeam.length > 0) {
    lines.push(`👥 Team (${openTeam.length} open)`);
    for (const t of openTeam) lines.push(`○ ${t.id} [${t.status}]${t.owner ? ` @${t.owner}` : ""} ${clip(t.subject, 44)}`);
  }
  return lines.length > 0 ? capLines(lines, maxLines) : undefined;
}

export type WidgetKey = "goal" | "todo" | "jobs" | "agents";
export const WIDGET_KEYS: readonly WidgetKey[] = ["goal", "todo", "jobs", "agents"];
export const PANEL_KEY = "pi-dsh-panel";

/** Every widget section by key; undefined when it has nothing to show. */
export function renderWidgetSections(state: UiState): Record<WidgetKey, string[] | undefined> {
  return {
    goal: renderGoalWidget(state.goal),
    todo: renderTodoWidget(state.todos),
    jobs: renderJobsWidget(state.jobs),
    agents: renderAgentsWidget(state),
  };
}

const MIN_COLUMN_WIDTH = 30;
const COLUMN_GAP = 3;

/** Place sections side by side at `width` columns. Sections that cannot all
 * fit one row wrap into evenly filled rows, down to a plain stack when narrow. */
export function layoutColumns(sections: string[][], width: number): string[] {
  if (sections.length === 0) return [];
  const inner = Math.max(1, width - 2); // one column of padding each side, like Pi's string widgets
  const fit = Math.max(1, Math.floor((inner + COLUMN_GAP) / (MIN_COLUMN_WIDTH + COLUMN_GAP)));
  const rows = Math.ceil(sections.length / fit);
  const perRow = Math.ceil(sections.length / rows);
  const lines: string[] = [];
  for (let i = 0; i < sections.length; i += perRow) lines.push(...layoutRow(sections.slice(i, i + perRow), inner));
  return lines;
}

/** Give each column its natural width; when the row is too wide, shave the widest columns first. */
function columnWidths(natural: number[], available: number): number[] {
  let cap = Math.max(...natural);
  while (cap > 1 && natural.reduce((sum, w) => sum + Math.min(w, cap), 0) > available) cap--;
  return natural.map((w) => Math.min(w, cap));
}

function layoutRow(row: string[][], inner: number): string[] {
  const natural = row.map((col) => Math.max(1, ...col.map(visibleWidth)));
  const widths = columnWidths(natural, inner - COLUMN_GAP * (row.length - 1));
  const height = Math.max(...row.map((col) => col.length));
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    const cells = row.map((col, i) => truncateToWidth(col[y] ?? "", widths[i], "…", true));
    lines.push(` ${cells.join(" ".repeat(COLUMN_GAP))}`.trimEnd());
  }
  return lines;
}

/** Widget factory for Pi's TUI: re-lays the columns out at the live terminal width. */
export function columnsWidget(sections: string[][]) {
  return () => ({ render: (width: number) => layoutColumns(sections, width), invalidate() { /* stateless */ } });
}

/** Full dashboard text for the /dsh command (notify body, also usable headless). */
export function renderDashboard(state: UiState, now = Date.now()): string {
  const sections: string[] = [`pi-dsh — ${renderStatusLine(state)}`];
  const goal = renderGoalWidget(state.goal);
  if (goal) sections.push(goal.join("\n"));
  if (state.planActive) sections.push("📋 Plan mode: ACTIVE (exit_plan_mode to present, /plan off to leave)");
  const todos = renderTodoWidget(state.todos, 30);
  if (todos) sections.push(todos.join("\n"));
  const jobs = renderJobsWidget(state.jobs, 20, now);
  if (jobs) sections.push(jobs.join("\n"));
  const agents = renderAgentsWidget(state, 30);
  if (agents) sections.push(agents.join("\n"));
  if (sections.length === 1) sections.push("No goal, todos, jobs, agents, or terminals.");
  return sections.join("\n\n");
}
