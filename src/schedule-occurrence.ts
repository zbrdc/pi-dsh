/** Latest-only recurrence arithmetic for scheduled reminders (dsh domain.ts resolve*Occurrence / next*Target).
 *
 * A recurring rule never replays what it missed: a decision picks the one latest occurrence due at the decision
 * time and the first target after it. The committed `scheduledAt` stays due even if current zone data would
 * place the rule before it, and a rule with no representable later target ends as inactive. */
import {
  DAY_MS, MAX_INSTANT_MS, MIN_INSTANT_MS, ScheduleLogError, civilFromDays, firstOfMonth, firstOfNextMonth, instantIso,
  isoWeekday, localInstant, utcDay, wallOf,
} from "./schedule-time.ts";
import { cronDayMatcher, cronTimes, parseCronExpression, type ParsedCron } from "./schedule-cron.ts";

export interface Occurrence {
  /** Latest occurrence due at the decision time. */
  occurrenceAt: string;
  /** First target after the decision; absent once no later instant is representable. */
  nextScheduledAt?: string;
}

/** The 400-year Gregorian cycle repeats leap years and weekdays, so a rule with no match inside it never matches. */
const SEARCH_HORIZON_DAYS = 146_097;
const LAST_DAY = utcDay(MAX_INSTANT_MS) + 1;
const MAX_BACK_DAYS = 800;

type DayMatch = (day: number) => boolean;
export const everyDay: DayMatch = () => true;
export const weekdayMatcher = (weekdays: readonly number[]): DayMatch => {
  const selected = new Set(weekdays);
  return (day) => selected.has(isoWeekday(day));
};

/** First actual occurrence after `now` and, when given, on a local day after `afterDay`. */
export function nextMatchingTarget(timeOfDayMs: number, zone: string, now: number, matches: DayMatch, afterDay?: number): string | undefined {
  let day = wallOf(now, zone).day;
  if (afterDay !== undefined && day <= afterDay) day = afterDay + 1;
  for (; day <= LAST_DAY; day++) {
    if (!matches(day)) continue;
    const target = localInstant(day * DAY_MS + timeOfDayMs, zone);
    if (target === undefined) continue; // a gap skips the day
    if (target > MAX_INSTANT_MS) return undefined;
    if (target >= MIN_INSTANT_MS && target > now) return instantIso(target);
  }
  return undefined;
}

/** Latest actual occurrence at or before the decision, never earlier than the committed target. */
function latestDueOccurrence(zone: string, matches: DayMatch, timeOfDayMs: number, decision: number, savedTarget: number): number {
  // Offsets stay under a day, but a date-line rollback can put the due local day after the UTC decision day.
  let day = utcDay(decision) + 1;
  for (let steps = 0; steps < MAX_BACK_DAYS; steps++, day--) {
    if (!matches(day)) continue;
    const candidate = localInstant(day * DAY_MS + timeOfDayMs, zone);
    if (candidate === undefined || candidate > decision) continue;
    return Math.max(candidate, savedTarget);
  }
  return savedTarget;
}

/** A wall-clock decision is only defined at a representable four-digit-year instant. */
function checkDecision(kind: string, decision: number, savedTarget: number): void {
  if (!Number.isSafeInteger(decision) || decision < MIN_INSTANT_MS || decision > MAX_INSTANT_MS) {
    throw new ScheduleLogError(`${kind} acceptedAt must be a representable four-digit-year instant`);
  }
  if (decision < savedTarget) throw new ScheduleLogError(`${kind} dispatch cannot precede the active scheduledAt`);
}

const withNext = (occurrenceAt: string, nextScheduledAt: string | undefined): Occurrence =>
  nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt };

export function resolveEveryOccurrence(record: { everySeconds: number; scheduledAt: string }, decision: number): Occurrence {
  const target = Date.parse(record.scheduledAt);
  const interval = record.everySeconds * 1000;
  checkDecision("every", decision, target);
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new ScheduleLogError("every interval milliseconds must be a positive safe integer");
  const occurrence = target + Math.floor((decision - target) / interval) * interval;
  const next = occurrence + interval;
  return withNext(instantIso(occurrence), next > MAX_INSTANT_MS ? undefined : instantIso(next));
}

/** Daily and weekly share one walk: the day set is every day, or the chosen weekdays. */
export function resolveWallClockOccurrence(
  rule: { timeOfDayMs: number; zone: string; matches: DayMatch; scheduledAt: string; kind: string },
  decision: number,
): Occurrence {
  const savedTarget = Date.parse(rule.scheduledAt);
  checkDecision(rule.kind, decision, savedTarget);
  const occurrence = latestDueOccurrence(rule.zone, rule.matches, rule.timeOfDayMs, decision, savedTarget);
  const next = nextMatchingTarget(rule.timeOfDayMs, rule.zone, decision, rule.matches, wallOf(occurrence, rule.zone).day);
  return withNext(instantIso(occurrence), next);
}

/** First strictly future cron occurrence, searching at most one 400-year cycle ahead. */
export function nextCronTarget(parsed: ParsedCron, zone: string, floor: number): string | undefined {
  const times = cronTimes(parsed);
  const matches = cronDayMatcher(parsed);
  const months = new Set(parsed.months);
  const start = wallOf(floor, zone);
  const lastDay = Math.min(start.day + SEARCH_HORIZON_DAYS, LAST_DAY);
  for (let day = start.day; day <= lastDay;) {
    if (!months.has(civilFromDays(day).month)) { day = firstOfNextMonth(day); continue; }
    if (matches(day)) {
      for (const time of times) {
        if (day === start.day && time < start.timeOfDayMs) continue;
        const target = localInstant(day * DAY_MS + time, zone);
        if (target === undefined) continue;
        if (target > MAX_INSTANT_MS) return undefined;
        if (target >= MIN_INSTANT_MS && target > floor) return instantIso(target);
      }
    }
    day++;
  }
  return undefined;
}

/** Latest cron occurrence at or before the decision; the committed target when none is representable. */
function latestCronOccurrence(parsed: ParsedCron, zone: string, decision: number, savedTarget: number): number {
  const times = cronTimes(parsed);
  const matches = cronDayMatcher(parsed);
  const months = new Set(parsed.months);
  let day = utcDay(decision) + 1;
  // The floor is an instant, so the earliest day the walk may reach is the one holding it on the rule's own clock.
  const lowest = Math.max(day - SEARCH_HORIZON_DAYS, wallOf(MIN_INSTANT_MS, zone).day);
  while (day >= lowest) {
    if (!months.has(civilFromDays(day).month)) { day = firstOfMonth(day) - 1; continue; }
    if (matches(day)) {
      // One conversion of the day's earliest time says whether the whole day lies beyond the decision.
      const earliest = times.reduce<number | undefined>((found, time) => found ?? localInstant(day * DAY_MS + time, zone), undefined);
      if (earliest !== undefined && earliest > decision) { day--; continue; }
      for (let i = times.length - 1; i >= 0; i--) {
        const candidate = localInstant(day * DAY_MS + (times[i] ?? 0), zone);
        if (candidate === undefined || candidate > decision || candidate < MIN_INSTANT_MS) continue;
        return Math.max(candidate, savedTarget);
      }
    }
    day--;
  }
  return savedTarget;
}

export function resolveCronOccurrence(record: { expression: string; timeZone: string; scheduledAt: string }, decision: number): Occurrence {
  const savedTarget = Date.parse(record.scheduledAt);
  checkDecision("cron", decision, savedTarget);
  const parsed = parseCronExpression(record.expression);
  const occurrence = latestCronOccurrence(parsed, record.timeZone, decision, savedTarget);
  return withNext(instantIso(occurrence), nextCronTarget(parsed, record.timeZone, decision));
}
