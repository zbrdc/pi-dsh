/** Session reminders: management plus the timer that delivers them (dsh schedule index.ts + runtime.ts, Pi-shaped).
 *
 * DSH runs one Host timer over every session's tasks and restores a cold session to deliver. pi-dsh has no Host, so
 * the process running a session arms the timer for that session's tasks only; what came due while nothing ran is
 * delivered on the next start, as the latest occurrence of each rule. Delivery hands a framed message to `deliver`
 * (the session's notice outbox) and then commits the new target and receipt, in that order, as DSH does. */
import { randomBytes } from "node:crypto";
import { instantIso, ScheduleInputError } from "./schedule-time.ts";
import {
  applyScheduleUpdate, createScheduleRecord, isRecurringRecord, renderRecurringReminderBatchFraming, renderReminderFraming,
  resolveRecurringOccurrence, type OneShotRecord, type RecurringRecord, type ScheduleCreateRequest, type ScheduleRecord, type ScheduleUpdate,
} from "./schedule.ts";
import {
  DEFAULT_RETENTION, ScheduleStore, historyPage, readAllTasks, scheduleFile, withDelivery,
  type HistoryPage, type Retention, type ScheduleTask,
} from "./schedule-store.ts";

/** A parked process may sleep through a timer, so the next deadline is rechecked at least this often. */
export const HEARTBEAT_MS = 30_000;

export interface ScheduleClock {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const systemClock: ScheduleClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => { const handle = setTimeout(run, ms); handle.unref(); return handle; },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ScheduleDeps {
  /** Directory holding one JSON file per session. */
  dir: string;
  /** Queue one framed reminder for the model. A `key` replaces an undelivered notice with the same key. Throws if it cannot. */
  deliver(text: string, key?: string): void;
  warn(message: string): void;
  /** Called after the task set changed. */
  changed?(): void;
  retention?: Retention;
  clock?: ScheduleClock;
}

export type UpdateOutcome =
  | { id: string; updated: boolean; record: ScheduleRecord }
  | { id: string; updated: false; code: "schedule_not_found" | "schedule_ended" };
export type DeleteOutcome = { id: string; deleted: true } | { id: string; deleted: false; code: "schedule_not_found" };

const newId = (): string => `schedule-${randomBytes(8).toString("hex")}`;
const newMessageId = (): string => `msg-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

export class ScheduleService {
  private readonly deps: ScheduleDeps;
  private readonly clock: ScheduleClock;
  private readonly retention: Retention;
  private store: ScheduleStore | undefined;
  private sessionId: string | undefined;
  private timer: unknown;
  /** Tasks whose last delivery failed; they wait for a management change or the next attach instead of retrying every beat. */
  private failed = new Set<string>();

  constructor(deps: ScheduleDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? systemClock;
    this.retention = deps.retention ?? DEFAULT_RETENTION;
  }

  now(): number { return this.clock.now(); }

  /** Open the session's tasks and arm the timer; anything already due is delivered now. */
  attach(sessionId: string): void {
    this.detach();
    this.sessionId = sessionId;
    this.store = new ScheduleStore(scheduleFile(this.deps.dir, sessionId));
    if (this.store.loadError !== undefined) this.deps.warn(`schedule: ${this.store.loadError}; reminders for this session are paused until the file is fixed.`);
    else this.drive();
  }

  detach(): void {
    this.stopTimer();
    this.store = undefined;
    this.sessionId = undefined;
    this.failed.clear();
  }

  /** Why management is unavailable, or the open store. */
  private open(): ScheduleStore {
    if (this.store === undefined || this.sessionId === undefined) throw new Error("No session is open for reminders.");
    if (this.store.loadError !== undefined) throw new Error(`The reminder file is unreadable (${this.store.loadError}); fix or remove it.`);
    return this.store;
  }

  private changedAndDrive(): void {
    this.failed.clear();
    this.deps.changed?.();
    this.drive();
  }

  create(request: ScheduleCreateRequest): ScheduleRecord {
    const store = this.open();
    const record = createScheduleRecord(newId(), request, this.clock.now());
    store.put({ sessionId: this.sessionId as string, record, status: "active", deliveryHistory: { records: [], earlierRecordsPruned: false } });
    this.changedAndDrive();
    return record;
  }

  /** The session's active reminders in creation order. */
  list(): ScheduleRecord[] {
    return this.store === undefined ? [] : this.store.all().filter((t) => t.status === "active").map((t) => t.record);
  }

  /** Active and inactive tasks of this session, soonest first. */
  tasks(): ScheduleTask[] {
    return (this.store?.all() ?? []).sort((a, b) => a.record.scheduledAt.localeCompare(b.record.scheduledAt) || a.record.id.localeCompare(b.record.id));
  }

  /** Tasks of every session, for read-only listing. */
  allSessions(): ScheduleTask[] {
    return readAllTasks(this.deps.dir).sort((a, b) => a.record.scheduledAt.localeCompare(b.record.scheduledAt) || a.record.id.localeCompare(b.record.id));
  }

  update(id: string, update: ScheduleUpdate): UpdateOutcome {
    const store = this.open();
    const task = store.get(id);
    if (task === undefined) return { id, updated: false, code: "schedule_not_found" };
    if (task.status === "inactive") return { id, updated: false, code: "schedule_ended" };
    const { updated, record } = applyScheduleUpdate(task.record, update, this.clock.now());
    if (updated) {
      store.put({ ...task, record });
      this.changedAndDrive();
    }
    return { id, updated, record };
  }

  remove(id: string): DeleteOutcome {
    const removed = this.open().remove(id);
    if (!removed) return { id, deleted: false, code: "schedule_not_found" };
    this.changedAndDrive();
    return { id, deleted: true };
  }

  history(id: string, limit: number, before?: string): HistoryPage | { id: string; code: "schedule_not_found" } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ScheduleInputError("invalid_rule", "Delivery history limit must be a safe integer from 1 through 100.");
    const task = this.open().get(id);
    return task === undefined ? { id, code: "schedule_not_found" } : historyPage(task, limit, this.retention, before);
  }

  // ---- Delivery ----

  private stopTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Deliver what is due, then sleep until the next target or the next heartbeat. */
  drive(): void {
    this.stopTimer();
    const store = this.store;
    if (store === undefined || store.loadError !== undefined) return;
    const now = this.clock.now();
    const due = store.all().filter((t) => t.status === "active" && !this.failed.has(t.record.id) && Date.parse(t.record.scheduledAt) <= now);
    for (const task of due.filter((t) => !isRecurringRecord(t.record))) this.deliverOneShot(store, task, now);
    const recurring = due.filter((t) => isRecurringRecord(t.record));
    if (recurring.length > 0) this.deliverRecurring(store, recurring, now);
    this.arm(store);
  }

  private arm(store: ScheduleStore): void {
    const next = store.all().filter((t) => t.status === "active" && !this.failed.has(t.record.id))
      .reduce<number | undefined>((soonest, t) => Math.min(soonest ?? Infinity, Date.parse(t.record.scheduledAt)), undefined);
    if (next === undefined) return;
    const wait = Math.max(0, Math.min(next - this.clock.now(), HEARTBEAT_MS));
    this.timer = this.clock.setTimer(() => { this.timer = undefined; this.drive(); }, wait);
  }

  private fail(tasks: ScheduleTask[], error: unknown): void {
    for (const task of tasks) this.failed.add(task.record.id);
    this.deps.warn(`schedule: reminders ${JSON.stringify(tasks.map((t) => t.record.id))} were not delivered: ${error instanceof Error ? error.message : String(error)}`);
  }

  private deliverOneShot(store: ScheduleStore, task: ScheduleTask, now: number): void {
    try {
      this.deps.deliver(renderReminderFraming(task.record as OneShotRecord));
      const receipt = { scheduledAt: task.record.scheduledAt, deliveredAt: instantIso(now), messageId: newMessageId() };
      store.put({ ...task, status: "inactive", ...withDelivery(task, receipt, this.retention) });
      this.deps.changed?.();
    } catch (error) { this.fail([task], error); }
  }

  /** Every recurring task due now shares one message with its latest occurrence; each advances on its own. */
  private deliverRecurring(store: ScheduleStore, tasks: ScheduleTask[], now: number): void {
    const resolved: { task: ScheduleTask; occurrenceAt: string; nextScheduledAt?: string }[] = [];
    for (const task of tasks) {
      try { resolved.push({ task, ...resolveRecurringOccurrence(task.record as RecurringRecord, now) }); }
      catch (error) { this.fail([task], error); }
    }
    if (resolved.length === 0) return;
    try {
      const text = renderRecurringReminderBatchFraming(resolved.map((r) => ({ record: r.task.record as RecurringRecord, occurrenceAt: r.occurrenceAt })));
      // A newer occurrence of a lone task supersedes an undelivered older one; a batch of several has no single owner.
      this.deps.deliver(text, resolved.length === 1 ? `schedule:${resolved[0]?.task.record.id}` : undefined);
      const deliveredAt = instantIso(now);
      const messageId = newMessageId();
      store.put(...resolved.map(({ task, occurrenceAt, nextScheduledAt }) => ({
        ...task,
        record: { ...task.record, scheduledAt: nextScheduledAt ?? occurrenceAt } as ScheduleRecord,
        status: nextScheduledAt === undefined ? "inactive" as const : "active" as const,
        ...withDelivery(task, { scheduledAt: occurrenceAt, deliveredAt, messageId }, this.retention),
      })));
      this.deps.changed?.();
    } catch (error) { this.fail(resolved.map((r) => r.task), error); }
  }
}
