/** Durable shared team task board (dsh experimental agent-team task-board):
 * versioned task snapshots with compare-and-set updates, dependency readiness,
 * advisory write-scope overlap warnings, tombstone deletes, and one-shot
 * change waiters. Pure and Pi-independent; the parent session persists
 * snapshots and every team member (parent tools or child custom tools)
 * operates on the same in-process board. */

export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export interface TeamTask {
  id: string; subject: string; description: string; status: TeamTaskStatus;
  owner?: string; blockedBy: string[]; writeScopes: string[];
  revision: number; createdBy: string; createdAt: number; updatedAt: number;
}
export interface TeamTaskView extends TeamTask {
  ready: boolean; blockedByIncomplete: string[]; writeScopeWarnings: string[];
}
export type TeamTaskAction = "claim" | "release" | "complete" | "reopen" | "assign" | "delete" | "edit";

const MAX_SUBJECT = 500;
const MAX_DESCRIPTION = 20_000;

/** Normalize a workspace-relative scope prefix (no absolute paths, no ..). */
export function normalizeScope(raw: string): string {
  let s = String(raw).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!s || s.startsWith("/") || s.split("/").includes("..")) throw new Error(`invalid writeScope "${raw}": use a workspace-relative path prefix`);
  return s;
}
/** Path-component prefix overlap (a/b overlaps a/b/c and a, not a/bc). */
export function scopesOverlap(a: string, b: string): boolean {
  const pa = a.split("/"); const pb = b.split("/");
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

export class TeamBoard {
  private tasks = new Map<string, TeamTask>();
  private seq = 0;
  private listeners = new Set<() => void>();
  onChange: ((task: TeamTask) => void) | undefined;
  maxTasks: number;
  constructor(maxTasks = 256) { this.maxTasks = maxTasks; }

  private emit(task: TeamTask): void {
    this.onChange?.({ ...task });
    for (const fn of [...this.listeners]) fn();
  }
  /** Resolve true on the next board change, false on timeout. */
  waitForChange(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (v: boolean) => { clearTimeout(timer); this.listeners.delete(fn); resolve(v); };
      const fn = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      if (typeof (timer as any).unref === "function") (timer as any).unref();
      this.listeners.add(fn);
    });
  }

  snapshot(): TeamTask[] { return [...this.tasks.values()].map((t) => ({ ...t, blockedBy: [...t.blockedBy], writeScopes: [...t.writeScopes] })); }
  /** Restore snapshots; migrates the pre-v2 shape ({id, subject, description, status, owner}). */
  restore(raw: unknown[]): void {
    this.tasks.clear(); this.seq = 0;
    for (const r of raw ?? []) {
      const t = r as Partial<TeamTask>;
      if (!t || typeof t.id !== "string" || typeof t.subject !== "string") continue;
      const status: TeamTaskStatus = t.status === "in_progress" || t.status === "completed" || t.status === "deleted" ? t.status : "pending";
      const task: TeamTask = {
        id: t.id, subject: t.subject, description: String(t.description ?? ""), status,
        owner: typeof t.owner === "string" ? t.owner : undefined,
        blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
        writeScopes: Array.isArray(t.writeScopes) ? t.writeScopes.map(String) : [],
        revision: Number.isSafeInteger(t.revision) && (t.revision as number) >= 1 ? (t.revision as number) : 1,
        createdBy: typeof t.createdBy === "string" ? t.createdBy : "lead",
        createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
        updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : Date.now(),
      };
      this.tasks.set(task.id, task);
      const n = Number(task.id.replace(/^task-/, ""));
      if (Number.isSafeInteger(n) && n > this.seq) this.seq = n;
    }
  }

  private mustGet(id: string): TeamTask {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`unknown team task: ${id}`);
    return t;
  }
  private incompleteDeps(t: TeamTask): string[] {
    return t.blockedBy.filter((id) => this.tasks.get(id)?.status !== "completed");
  }
  private assertAcyclic(id: string, blockedBy: string[]): void {
    const seen = new Set<string>();
    const stack = [...blockedBy];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === id) throw new Error(`blockedBy would create a dependency cycle at ${id}`);
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(this.tasks.get(cur)?.blockedBy ?? []));
    }
  }
  private validateBlockedBy(blockedBy: string[]): string[] {
    const out = [...new Set(blockedBy.map(String))];
    for (const id of out) {
      const dep = this.tasks.get(id);
      if (!dep) throw new Error(`blockedBy references unknown task: ${id}`);
      if (dep.status === "deleted") throw new Error(`blockedBy references deleted task: ${id}`);
    }
    return out;
  }

  view(t: TeamTask): TeamTaskView {
    const blockedByIncomplete = this.incompleteDeps(t);
    const writeScopeWarnings: string[] = [];
    if (t.status === "in_progress") {
      for (const other of this.tasks.values()) {
        if (other.id === t.id || other.status !== "in_progress") continue;
        if (t.writeScopes.some((s) => other.writeScopes.some((o) => scopesOverlap(s, o)))) writeScopeWarnings.push(`write scopes overlap with ${other.id}`);
      }
    }
    return { ...t, blockedBy: [...t.blockedBy], writeScopes: [...t.writeScopes], ready: t.status === "pending" && blockedByIncomplete.length === 0, blockedByIncomplete, writeScopeWarnings };
  }
  get(id: string): TeamTaskView { return this.view(this.mustGet(id)); }
  list(includeDeleted = false): TeamTaskView[] {
    return [...this.tasks.values()].filter((t) => includeDeleted || t.status !== "deleted").map((t) => this.view(t));
  }

  create(actor: string, input: { subject: string; description?: string; blockedBy?: string[]; writeScopes?: string[] }): TeamTaskView {
    const active = [...this.tasks.values()].filter((t) => t.status !== "deleted").length;
    if (active >= this.maxTasks) throw new Error(`TEAM_TASK_LIMIT: board already holds ${this.maxTasks} active tasks`);
    const subject = String(input.subject ?? "").trim();
    if (!subject) throw new Error("team task subject must not be empty");
    if (subject.length > MAX_SUBJECT) throw new Error(`team task subject exceeds ${MAX_SUBJECT} chars`);
    const description = String(input.description ?? "");
    if (description.length > MAX_DESCRIPTION) throw new Error(`team task description exceeds ${MAX_DESCRIPTION} chars`);
    const task: TeamTask = {
      id: `task-${++this.seq}`, subject, description, status: "pending",
      blockedBy: this.validateBlockedBy(input.blockedBy ?? []),
      writeScopes: (input.writeScopes ?? []).map(normalizeScope),
      revision: 1, createdBy: actor, createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    this.emit(task);
    return this.view(task);
  }

  /** Compare-and-set update. Actions encode the lifecycle transitions; `edit`
   * changes fields. Owner checks: claim/complete/release by owner or lead. */
  update(actor: string, isLead: boolean, input: {
    taskId: string; expectedRevision: number; action: TeamTaskAction;
    owner?: string; subject?: string; description?: string; blockedBy?: string[]; writeScopes?: string[];
  }): TeamTaskView {
    const t = this.mustGet(input.taskId);
    if (t.status === "deleted") throw new Error(`team task ${t.id} is deleted`);
    if (input.expectedRevision !== t.revision) {
      throw new Error(`TEAM_TASK_STALE_REVISION: ${t.id} is at revision ${t.revision}, you based this update on ${input.expectedRevision}; re-read it with team_task_get`);
    }
    const ownOrLead = () => {
      if (!isLead && t.owner !== actor) throw new Error(`team task ${t.id} is owned by ${t.owner ?? "(nobody)"}; only its owner or the lead may do this`);
    };
    switch (input.action) {
      case "claim": {
        if (t.status !== "pending") throw new Error(`cannot claim ${t.id}: status is ${t.status}`);
        const incomplete = this.incompleteDeps(t);
        if (incomplete.length > 0) throw new Error(`cannot claim ${t.id}: blocked by incomplete ${incomplete.join(", ")}`);
        if (t.owner && t.owner !== actor) throw new Error(`cannot claim ${t.id}: assigned to ${t.owner}`);
        t.status = "in_progress"; t.owner = actor; break;
      }
      case "release": ownOrLead(); t.status = "pending"; t.owner = undefined; break;
      case "complete":
        ownOrLead();
        if (t.status === "completed") throw new Error(`${t.id} is already completed`);
        t.status = "completed"; break;
      case "reopen":
        if (t.status !== "completed") throw new Error(`cannot reopen ${t.id}: status is ${t.status}`);
        t.status = "pending"; break;
      case "assign": {
        if (!isLead) throw new Error("only the lead may assign team tasks");
        if (!input.owner) throw new Error("assign requires an owner");
        t.owner = String(input.owner);
        if (t.status === "pending" && this.incompleteDeps(t).length === 0) t.status = "in_progress";
        break;
      }
      case "delete":
        if (!isLead && t.createdBy !== actor) throw new Error("only the lead or the task creator may delete a team task");
        t.status = "deleted"; break;
      case "edit": {
        if (input.subject !== undefined) {
          const subject = String(input.subject).trim();
          if (!subject || subject.length > MAX_SUBJECT) throw new Error("invalid team task subject");
          t.subject = subject;
        }
        if (input.description !== undefined) {
          if (String(input.description).length > MAX_DESCRIPTION) throw new Error(`team task description exceeds ${MAX_DESCRIPTION} chars`);
          t.description = String(input.description);
        }
        if (input.blockedBy !== undefined) {
          t.blockedBy = this.validateBlockedBy(input.blockedBy);
          this.assertAcyclic(t.id, t.blockedBy);
        }
        if (input.writeScopes !== undefined) t.writeScopes = input.writeScopes.map(normalizeScope);
        break;
      }
      default: throw new Error(`unknown team task action: ${String((input as any).action)}`);
    }
    t.revision++;
    t.updatedAt = Date.now();
    this.emit(t);
    return this.view(t);
  }
}

export function renderTeamTask(v: TeamTaskView): string {
  const bits = [`${v.id} [${v.status}]${v.owner ? ` @${v.owner}` : ""} rev=${v.revision}${v.ready ? " READY" : ""}`];
  bits.push(v.subject);
  if (v.description) bits.push(v.description);
  if (v.blockedBy.length > 0) bits.push(`blockedBy: ${v.blockedBy.join(", ")}${v.blockedByIncomplete.length > 0 ? ` (incomplete: ${v.blockedByIncomplete.join(", ")})` : ""}`);
  if (v.writeScopes.length > 0) bits.push(`writeScopes: ${v.writeScopes.join(", ")}`);
  for (const w of v.writeScopeWarnings) bits.push(`⚠ ${w}`);
  return bits.join("\n");
}
