/** Reminder records of dsh Schedule: creation, strict decoding, in-place updates, model framing.
 *
 * Six rules: `after` and `at` fire once, `every` is a fixed interval, `daily`, `weekly` and `cron` follow a wall
 * clock in an explicit IANA zone. Every target is a committed UTC instant; zone data is read when a target is
 * computed, never when a stored record is read back. */
import { isDeepStrictEqual } from "node:util";
import {
  MAX_INSTANT_MS, MIN_INSTANT_MS, ScheduleInputError, ScheduleLogError, canonicalizeTimeZone, formatClockTime, futureInstant,
  instantIso, parseAtInput, parseClockTime, type AtInput,
} from "./schedule-time.ts";
import { canonicalizeCronExpression, parseCronExpression } from "./schedule-cron.ts";
import {
  everyDay, nextCronTarget, nextMatchingTarget, resolveCronOccurrence, resolveEveryOccurrence, resolveWallClockOccurrence,
  weekdayMatcher, type Occurrence,
} from "./schedule-occurrence.ts";

export const MIN_EVERY_INTERVAL_SECONDS = 60;
export const MAX_TITLE_LENGTH = 120;
export const REQUIRED_TITLE_MESSAGE = "title is required and must be non-empty after trimming.";

interface Base { readonly id: string; readonly title: string; readonly prompt: string; readonly scheduledAt: string }
export interface AfterRecord extends Base { readonly kind: "after"; readonly afterSeconds: number }
export interface AtRecord extends Base { readonly kind: "at" }
export interface EveryRecord extends Base { readonly kind: "every"; readonly everySeconds: number }
export interface DailyRecord extends Base { readonly kind: "daily"; readonly time: string; readonly timeZone: string }
export interface WeeklyRecord extends Base { readonly kind: "weekly"; readonly time: string; readonly timeZone: string; readonly weekdays: readonly number[] }
export interface CronRecord extends Base { readonly kind: "cron"; readonly expression: string; readonly timeZone: string }
export type OneShotRecord = AfterRecord | AtRecord;
export type RecurringRecord = EveryRecord | DailyRecord | WeeklyRecord | CronRecord;
export type ScheduleRecord = OneShotRecord | RecurringRecord;

export interface DailyInput { time: string; time_zone: string }
export interface WeeklyInput extends DailyInput { weekdays: number[] }
export interface CronInput { expression: string; time_zone: string }

export interface ScheduleCreateRequest {
  prompt: string; title: string;
  after_seconds?: number; at?: AtInput; every_seconds?: number; daily?: DailyInput; weekly?: WeeklyInput; cron?: CronInput;
}

/** Timing-only edit; its kind may differ from the stored record's kind. */
export type TimingChange =
  | { kind: "at"; at: AtInput } | { kind: "every"; every_seconds: number }
  | { kind: "daily"; daily: DailyInput } | { kind: "weekly"; weekly: WeeklyInput } | { kind: "cron"; cron: CronInput };

export interface ScheduleUpdate { title?: string; prompt?: string; change?: TimingChange }

export type ScheduleView = ScheduleRecord & { readonly state: "scheduled" | "overdue"; readonly deliveryMode: "host" };

const invalid = (message: string) => new ScheduleInputError("invalid_rule", message);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => key in value);

export const isRecurringRecord = (record: ScheduleRecord): record is RecurringRecord =>
  record.kind === "every" || record.kind === "daily" || record.kind === "weekly" || record.kind === "cron";

// ---- Titles and prompts ----

/** The trimmed title a creation supplies; one is never derived from the prompt. */
export function scheduleTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim().length === 0) throw new ScheduleInputError("invalid_prompt", REQUIRED_TITLE_MESSAGE);
  if (title.trim().length > MAX_TITLE_LENGTH) throw new ScheduleInputError("invalid_prompt", `title must be at most ${MAX_TITLE_LENGTH} characters.`);
  return title.trim();
}

export function schedulePrompt(prompt: unknown): string {
  if (typeof prompt !== "string" || prompt.trim().length === 0) throw new ScheduleInputError("invalid_prompt", "prompt must be non-empty after trimming.");
  return prompt.trim();
}

// ---- Selectors ----

function parseWallClock(input: unknown, selector: "daily" | "weekly", keys: readonly string[]): { time: string; timeZone: string; fields: Record<string, unknown> } {
  if (!isRecord(input) || !hasExactKeys(input, keys) || typeof input["time"] !== "string") {
    throw invalid(`${selector} must contain exactly ${keys.join(", ")}, with time HH:mm:ss and optional 1-3 fractional digits.`);
  }
  if (typeof input["time_zone"] !== "string") throw new ScheduleInputError("invalid_time_zone", "time_zone must be a string.");
  return { time: formatClockTime(parseClockTime(input["time"], selector)), timeZone: canonicalizeTimeZone(input["time_zone"]), fields: input };
}

export function parseDailyInput(daily: unknown): { time: string; timeZone: string } {
  const { time, timeZone } = parseWallClock(daily, "daily", ["time", "time_zone"]);
  return { time, timeZone };
}

/** ISO weekdays, Monday 1 through Sunday 7, without repeats, ascending. */
export function normalizeWeekdays(weekdays: unknown): number[] {
  if (!Array.isArray(weekdays) || weekdays.length === 0) throw invalid("weekly.weekdays must be a non-empty array of ISO weekday numbers.");
  const unique = new Set<number>();
  for (const weekday of weekdays as unknown[]) {
    if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw invalid("Each weekly.weekdays entry must be an integer from 1 (Monday) through 7 (Sunday).");
    if (unique.has(weekday)) throw invalid(`weekly.weekdays must not repeat weekday ${weekday}.`);
    unique.add(weekday);
  }
  return [...unique].sort((a, b) => a - b);
}

export function parseWeeklyInput(weekly: unknown): { time: string; timeZone: string; weekdays: number[] } {
  const { time, timeZone, fields } = parseWallClock(weekly, "weekly", ["time", "time_zone", "weekdays"]);
  return { time, timeZone, weekdays: normalizeWeekdays(fields["weekdays"]) };
}

export function parseCronInput(cron: unknown): { expression: string; timeZone: string } {
  if (!isRecord(cron) || !hasExactKeys(cron, ["expression", "time_zone"]) || typeof cron["expression"] !== "string") {
    throw invalid("cron must contain exactly expression and time_zone, with a five-field cron expression.");
  }
  if (typeof cron["time_zone"] !== "string") throw new ScheduleInputError("invalid_time_zone", "time_zone must be a string.");
  return { expression: canonicalizeCronExpression(cron["expression"]), timeZone: canonicalizeTimeZone(cron["time_zone"]) };
}

// ---- Creation ----

type Head = { id: string; title: string; prompt: string };

function requireWallClockNow(kind: string, now: number): void {
  if (!Number.isSafeInteger(now) || now < MIN_INSTANT_MS || now > MAX_INSTANT_MS) {
    throw new ScheduleInputError("time_out_of_range", `${kind} creation time must be a representable four-digit-year UTC instant.`);
  }
}

const noFutureOccurrence = (kind: string) => new ScheduleInputError("time_out_of_range", `No future ${kind} occurrence is representable as a four-digit-year UTC instant.`);

function buildAfter(head: Head, seconds: unknown, now: number): AfterRecord {
  if (!Number.isSafeInteger(seconds) || (seconds as number) <= 0) throw invalid("after_seconds must be a positive safe integer.");
  return { ...head, kind: "after", afterSeconds: seconds as number, scheduledAt: futureInstant(now + (seconds as number) * 1000, now) };
}

function buildEvery(head: Head, seconds: unknown, now: number): EveryRecord {
  if (!Number.isSafeInteger(seconds)) throw invalid("every_seconds must be a safe integer.");
  if ((seconds as number) < MIN_EVERY_INTERVAL_SECONDS) throw new ScheduleInputError("frequency_too_high", `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`);
  return { ...head, kind: "every", everySeconds: seconds as number, scheduledAt: futureInstant(now + (seconds as number) * 1000, now) };
}

function buildDaily(head: Head, input: unknown, now: number): DailyRecord {
  const { time, timeZone } = parseDailyInput(input);
  requireWallClockNow("Daily", now);
  const scheduledAt = nextMatchingTarget(parseClockTime(time, "daily"), timeZone, now, everyDay);
  if (scheduledAt === undefined) throw noFutureOccurrence("daily");
  return { ...head, kind: "daily", time, timeZone, scheduledAt };
}

function buildWeekly(head: Head, input: unknown, now: number): WeeklyRecord {
  const { time, timeZone, weekdays } = parseWeeklyInput(input);
  requireWallClockNow("Weekly", now);
  const scheduledAt = nextMatchingTarget(parseClockTime(time, "weekly"), timeZone, now, weekdayMatcher(weekdays));
  if (scheduledAt === undefined) throw noFutureOccurrence("weekly");
  return { ...head, kind: "weekly", time, timeZone, weekdays, scheduledAt };
}

function buildCron(head: Head, input: unknown, now: number): CronRecord {
  const { expression, timeZone } = parseCronInput(input);
  requireWallClockNow("Cron", now);
  const scheduledAt = nextCronTarget(parseCronExpression(expression), timeZone, now);
  if (scheduledAt === undefined) throw noFutureOccurrence("cron");
  return { ...head, kind: "cron", expression, timeZone, scheduledAt };
}

const SELECTORS = ["after_seconds", "at", "every_seconds", "daily", "weekly", "cron"] as const;

/** Build a record from a creation request; the request names exactly one timing selector. */
export function createScheduleRecord(id: string, request: ScheduleCreateRequest, now: number): ScheduleRecord {
  const chosen = SELECTORS.filter((key) => request[key] !== undefined);
  const selector = chosen[0];
  if (chosen.length !== 1 || selector === undefined) throw new ScheduleInputError("invalid_selector", "Exactly one reminder selector is required.");
  const head: Head = { id, prompt: schedulePrompt(request.prompt), title: scheduleTitle(request.title) };
  switch (selector) {
    case "after_seconds": return buildAfter(head, request.after_seconds, now);
    case "at": return { ...head, kind: "at", scheduledAt: futureInstant(parseAtInput(request.at), now) };
    case "every_seconds": return buildEvery(head, request.every_seconds, now);
    case "daily": return buildDaily(head, request.daily, now);
    case "weekly": return buildWeekly(head, request.weekly, now);
    case "cron": return buildCron(head, request.cron, now);
  }
}

// ---- Updates ----

const CHANGE_SELECTOR = { at: "at", every: "every_seconds", daily: "daily", weekly: "weekly", cron: "cron" } as const;

function validateChange(value: unknown): TimingChange {
  const selector = isRecord(value) ? CHANGE_SELECTOR[value["kind"] as keyof typeof CHANGE_SELECTOR] : undefined;
  if (!isRecord(value) || selector === undefined || Object.keys(value).length !== 2 || !(selector in value)) {
    throw invalid("Timing change must contain exactly kind and its matching timing selector.");
  }
  return value as unknown as TimingChange;
}

/** The record a timing change asks for, or `current` when its normalized rule equals the stored one (no re-anchor). */
function changedTiming(current: ScheduleRecord, head: Head, change: TimingChange, now: number): ScheduleRecord {
  const rebuilt = (request: Omit<ScheduleCreateRequest, "prompt" | "title">) => createScheduleRecord(current.id, { prompt: head.prompt, title: head.title, ...request }, now);
  switch (change.kind) {
    case "at":
      if ((current.kind === "after" || current.kind === "at") && parseAtInput(change.at) === Date.parse(current.scheduledAt)) return current;
      return rebuilt({ at: change.at });
    case "every":
      return current.kind === "every" && change.every_seconds === current.everySeconds ? current : rebuilt({ every_seconds: change.every_seconds });
    case "daily": {
      const next = current.kind === "daily" ? parseDailyInput(change.daily) : undefined;
      return next !== undefined && current.kind === "daily" && next.time === current.time && next.timeZone === canonicalizeTimeZone(current.timeZone) ? current : rebuilt({ daily: change.daily });
    }
    case "weekly": {
      const next = current.kind === "weekly" ? parseWeeklyInput(change.weekly) : undefined;
      const same = next !== undefined && current.kind === "weekly" && next.time === current.time
        && next.timeZone === canonicalizeTimeZone(current.timeZone) && isDeepStrictEqual(next.weekdays, [...current.weekdays]);
      return same ? current : rebuilt({ weekly: change.weekly });
    }
    case "cron": {
      const next = current.kind === "cron" ? parseCronInput(change.cron) : undefined;
      const same = next !== undefined && current.kind === "cron" && next.expression === canonicalizeCronExpression(current.expression)
        && next.timeZone === canonicalizeTimeZone(current.timeZone);
      return same ? current : rebuilt({ cron: change.cron });
    }
  }
}

/** Apply a name, instruction and timing edit. A name or instruction alone never moves the committed target. */
export function applyScheduleUpdate(current: ScheduleRecord, update: ScheduleUpdate, now: number): { updated: boolean; record: ScheduleRecord } {
  const head: Head = {
    id: current.id,
    title: update.title === undefined ? current.title : scheduleTitle(update.title),
    prompt: update.prompt === undefined ? current.prompt : schedulePrompt(update.prompt),
  };
  const timed = update.change === undefined ? current : changedTiming(current, head, validateChange(update.change), now);
  const record = timed === current && (head.title !== current.title || head.prompt !== current.prompt)
    ? { ...current, title: head.title, prompt: head.prompt } as ScheduleRecord
    : timed;
  return { updated: record !== current, record };
}

// ---- Occurrences ----

/** The latest due occurrence of a recurring record and its next target. */
export function resolveRecurringOccurrence(record: RecurringRecord, decision: number): Occurrence {
  switch (record.kind) {
    case "every": return resolveEveryOccurrence(record, decision);
    case "cron": return resolveCronOccurrence(record, decision);
    case "daily": return resolveWallClockOccurrence({ kind: "daily", timeOfDayMs: parseClockTime(record.time, "daily"), zone: record.timeZone, matches: everyDay, scheduledAt: record.scheduledAt }, decision);
    case "weekly": return resolveWallClockOccurrence({ kind: "weekly", timeOfDayMs: parseClockTime(record.time, "weekly"), zone: record.timeZone, matches: weekdayMatcher(normalizeWeekdays(record.weekdays)), scheduledAt: record.scheduledAt }, decision);
  }
}

// ---- Strict decoding of stored records ----

const STORED_KEYS: Record<string, readonly string[]> = {
  after: ["id", "kind", "title", "prompt", "afterSeconds", "scheduledAt"],
  at: ["id", "kind", "title", "prompt", "scheduledAt"],
  every: ["id", "kind", "title", "prompt", "everySeconds", "scheduledAt"],
  daily: ["id", "kind", "title", "prompt", "time", "timeZone", "scheduledAt"],
  weekly: ["id", "kind", "title", "prompt", "time", "timeZone", "weekdays", "scheduledAt"],
  cron: ["id", "kind", "title", "prompt", "expression", "timeZone", "scheduledAt"],
};
const STORED_INSTANT = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const corrupt = (message: string) => new ScheduleLogError(message);

function decodeText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw corrupt(`${name} must be a non-empty trimmed string`);
  return value;
}

function decodeInstant(value: unknown): string {
  if (typeof value !== "string" || !STORED_INSTANT.test(value) || instantIso(Date.parse(value)) !== value) throw corrupt("scheduledAt must be a canonical four-digit-year RFC 3339 UTC instant");
  return value;
}

/** Re-parse with the input parsers and turn their rejection into a stored-data error. */
function rederive<T>(read: () => T): T {
  try { return read(); } catch (error) { throw corrupt(error instanceof Error ? error.message : String(error)); }
}

function checkKindFields(kind: string, value: Record<string, unknown>): void {
  switch (kind) {
    case "after":
      if (!Number.isSafeInteger(value["afterSeconds"]) || (value["afterSeconds"] as number) <= 0) throw corrupt("afterSeconds must be a positive safe integer");
      return;
    case "every":
      if (!Number.isSafeInteger(value["everySeconds"]) || (value["everySeconds"] as number) < MIN_EVERY_INTERVAL_SECONDS) throw corrupt(`everySeconds must be a safe integer of at least ${MIN_EVERY_INTERVAL_SECONDS}`);
      return;
    case "daily": case "weekly": {
      const time = rederive(() => formatClockTime(parseClockTime(value["time"], kind)));
      if (value["time"] !== time) throw corrupt(`${kind} time must be normalized to HH:mm:ss.SSS`);
      rederive(() => canonicalizeTimeZone(value["timeZone"] as string));
      if (kind === "weekly" && !isDeepStrictEqual(value["weekdays"], rederive(() => normalizeWeekdays(value["weekdays"])))) throw corrupt("weekly weekdays must be normalized to unique ascending ISO weekday numbers");
      return;
    }
    case "cron":
      rederive(() => canonicalizeTimeZone(value["timeZone"] as string));
      if (value["expression"] !== rederive(() => canonicalizeCronExpression(value["expression"] as string))) throw corrupt("cron expression must be canonical");
  }
}

/** A stored record, or ScheduleLogError when it breaks an invariant; its committed target is kept as written. */
export function decodeScheduleRecord(value: unknown): ScheduleRecord {
  if (!isRecord(value)) throw corrupt("schedule record must be an object");
  const kind = value["kind"];
  const keys = typeof kind === "string" ? STORED_KEYS[kind] : undefined;
  if (keys === undefined || typeof kind !== "string") throw corrupt("schedule kind must be after, at, every, daily, weekly, or cron");
  if (!hasExactKeys(value, keys)) throw corrupt(`${kind} schedule must contain exactly ${keys.join(", ")}`);
  decodeText(value["id"], "id");
  decodeText(value["prompt"], "prompt");
  const title = decodeText(value["title"], "title");
  if (title.length > MAX_TITLE_LENGTH) throw corrupt(`title must be at most ${MAX_TITLE_LENGTH} characters`);
  decodeInstant(value["scheduledAt"]);
  checkKindFields(kind, value);
  return value as unknown as ScheduleRecord;
}

// ---- Model-facing views and framing ----

export const scheduleView = (record: ScheduleRecord, now: number): ScheduleView =>
  ({ ...record, state: now >= Date.parse(record.scheduledAt) ? "overdue" : "scheduled", deliveryMode: "host" });

const SCHEDULED_MESSAGE_FRAMING = "This is a scheduled message from the user";

export function renderReminderFraming(record: OneShotRecord): string {
  return [
    "[SCHEDULE REMINDER]", SCHEDULED_MESSAGE_FRAMING,
    `schedule_id_json: ${JSON.stringify(record.id)}`, `occurrence_at: ${record.scheduledAt}`, `reminder_prompt_json: ${JSON.stringify(record.prompt)}`,
  ].join("\n");
}

export function renderRecurringReminderBatchFraming(reminders: readonly { record: RecurringRecord; occurrenceAt: string }[]): string {
  const payload = reminders.map(({ record, occurrenceAt }) => ({ schedule_id: record.id, occurrence_at: occurrenceAt, reminder_prompt: record.prompt }));
  return ["[SCHEDULE REMINDER BATCH]", SCHEDULED_MESSAGE_FRAMING, `reminders_json: ${JSON.stringify(payload)}`].join("\n");
}
