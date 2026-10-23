/** Durable reminder tasks of one session, and their saved delivery history (dsh schedule storage.ts, delivery-history.ts).
 *
 * DSH keeps every task in one Host-wide table. pi-dsh has no Host process, so each session owns one JSON file and
 * only the process running that session writes it; other sessions' files are read for listing and never changed. */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ScheduleLogError } from "./schedule-time.ts";
import { decodeScheduleRecord, type ScheduleRecord } from "./schedule.ts";

export interface DeliveryReceipt {
  /** The occurrence this delivery was for. */
  scheduledAt: string;
  /** When the reminder entered the session's inbox. */
  deliveredAt: string;
  /** Identity shared by tasks delivered in one recurring batch. */
  messageId: string;
}
export interface DeliveryRecord extends DeliveryReceipt { prompt?: string }
export interface DeliveryHistory {
  /** Oldest first. */
  records: DeliveryRecord[];
  /** True once an append removed older records. */
  earlierRecordsPruned: boolean;
}
export interface Retention { days: number; records: number }
export const DEFAULT_RETENTION: Retention = { days: 30, records: 200 };

export interface ScheduleTask {
  sessionId: string;
  record: ScheduleRecord;
  status: "active" | "inactive";
  lastDelivery?: DeliveryReceipt;
  deliveryHistory: DeliveryHistory;
}

const DAY_MS = 86_400_000;

/** The task with one real delivery appended to its history, pruned to the retention window and record cap. */
export function withDelivery(task: ScheduleTask, receipt: DeliveryReceipt, retention: Retention): Pick<ScheduleTask, "lastDelivery" | "deliveryHistory"> {
  const appended = [...task.deliveryHistory.records, { ...receipt, prompt: task.record.prompt }];
  const floor = Date.parse(receipt.deliveredAt) - retention.days * DAY_MS;
  const kept = appended.filter((r) => Date.parse(r.deliveredAt) >= floor).slice(-retention.records);
  return { lastDelivery: receipt, deliveryHistory: { records: kept, earlierRecordsPruned: task.deliveryHistory.earlierRecordsPruned || kept.length !== appended.length } };
}

export type HistoryPage =
  | { id: string; records: DeliveryRecord[]; earlierRecordsPruned: boolean; retention: Retention; nextBefore?: string }
  | { id: string; code: "delivery_cursor_not_found" };

/** One newest-first page in append order, so it does not depend on wall-clock ordering. */
export function historyPage(task: ScheduleTask, limit: number, retention: Retention, before?: string): HistoryPage {
  const all = task.deliveryHistory.records;
  const end = before === undefined ? all.length : all.findIndex((r) => r.messageId === before);
  if (end === -1) return { id: task.record.id, code: "delivery_cursor_not_found" };
  const start = Math.max(0, end - limit);
  const records = all.slice(start, end).reverse();
  const oldest = records.at(-1);
  return {
    id: task.record.id, records, earlierRecordsPruned: task.deliveryHistory.earlierRecordsPruned, retention: { ...retention },
    ...(oldest !== undefined && start > 0 ? { nextBefore: oldest.messageId } : {}),
  };
}

const corrupt = (message: string) => new ScheduleLogError(message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function decodeReceipt(value: unknown): DeliveryReceipt {
  if (!isObject(value) || typeof value["scheduledAt"] !== "string" || typeof value["deliveredAt"] !== "string" || typeof value["messageId"] !== "string") {
    throw corrupt("delivery receipt must carry scheduledAt, deliveredAt and messageId");
  }
  return value as unknown as DeliveryReceipt;
}

function decodeHistory(value: unknown): DeliveryHistory {
  if (!isObject(value) || !Array.isArray(value["records"]) || typeof value["earlierRecordsPruned"] !== "boolean") throw corrupt("deliveryHistory must hold records and earlierRecordsPruned");
  const records = value["records"].map((r) => ({ ...decodeReceipt(r), ...(typeof (r as DeliveryRecord).prompt === "string" ? { prompt: (r as DeliveryRecord).prompt } : {}) }));
  if (new Set(records.map((r) => r.messageId)).size !== records.length) throw corrupt("deliveryHistory must not repeat a messageId");
  return { records, earlierRecordsPruned: value["earlierRecordsPruned"] };
}

function decodeTask(value: unknown): ScheduleTask {
  if (!isObject(value) || typeof value["sessionId"] !== "string") throw corrupt("task must be an object with a sessionId");
  if (value["status"] !== "active" && value["status"] !== "inactive") throw corrupt("task status must be active or inactive");
  const record = decodeScheduleRecord(value["record"]);
  const last = value["lastDelivery"];
  return {
    sessionId: value["sessionId"], record, status: value["status"], deliveryHistory: decodeHistory(value["deliveryHistory"]),
    ...(last === undefined ? {} : { lastDelivery: decodeReceipt(last) }),
  };
}

/** Parse a session file; any invalid task rejects the whole file, as a DSH domain open does. */
export function decodeTaskFile(text: string): ScheduleTask[] {
  const data: unknown = JSON.parse(text);
  if (!isObject(data) || data["version"] !== 1 || !Array.isArray(data["tasks"])) throw corrupt("schedule file must be {version: 1, tasks: [...]}");
  const tasks = data["tasks"].map(decodeTask);
  if (new Set(tasks.map((t) => t.record.id)).size !== tasks.length) throw corrupt("schedule file must not repeat a task id");
  return tasks;
}

const safeName = (sessionId: string): string => sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
export const scheduleFile = (dir: string, sessionId: string): string => join(dir, `${safeName(sessionId)}.json`);

/** Tasks of every session in the directory, for read-only listing; unreadable files are skipped. */
export function readAllTasks(dir: string): ScheduleTask[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const tasks: ScheduleTask[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try { tasks.push(...decodeTaskFile(readFileSync(join(dir, name), "utf8"))); } catch { /* skipped */ }
  }
  return tasks;
}

/** One session's tasks, held in memory and rewritten whole on each change. */
export class ScheduleStore {
  private readonly file: string;
  private rows = new Map<string, ScheduleTask>();
  /** Why the file could not be read; while set, nothing is written, so a damaged file is never overwritten. */
  readonly loadError: string | undefined;

  constructor(file: string) {
    this.file = file;
    let error: string | undefined;
    try { for (const task of decodeTaskFile(readFileSync(file, "utf8"))) this.rows.set(task.record.id, task); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") error = e instanceof Error ? e.message : String(e); }
    this.loadError = error;
  }

  all(): ScheduleTask[] { return [...this.rows.values()]; }
  get(id: string): ScheduleTask | undefined { return this.rows.get(id); }

  private write(): void {
    if (this.loadError !== undefined) throw new Error(`schedule file ${this.file} is unreadable (${this.loadError}); fix or remove it`);
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, tasks: this.all() }), "utf8");
    renameSync(temporary, this.file);
  }

  /** Store tasks in one write; memory changes only if the write succeeds. */
  put(...tasks: ScheduleTask[]): void {
    const before = new Map(this.rows);
    for (const task of tasks) this.rows.set(task.record.id, task);
    try { this.write(); } catch (error) { this.rows = before; throw error; }
  }

  remove(id: string): boolean {
    if (!this.rows.has(id)) return false;
    const before = new Map(this.rows);
    this.rows.delete(id);
    try { this.write(); } catch (error) { this.rows = before; throw error; }
    return true;
  }
}
