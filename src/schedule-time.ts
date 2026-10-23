/** Calendar and time-zone arithmetic for scheduled reminders (dsh packages/schedule/schedule/src/domain.ts).
 *
 * DSH does this with the Temporal polyfill; pi-dsh has no runtime dependencies, so the same rules are built
 * on Intl. A "wall" value is a local date and time written as milliseconds since 1970-01-01T00:00 with the
 * zone left out; a "day" is a count of days since 1970-01-01 on the proleptic Gregorian calendar. */

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const MIN_INSTANT_MS = Date.parse("0001-01-01T00:00:00.000Z");
export const MAX_INSTANT_MS = Date.parse("9999-12-31T23:59:59.999Z");

export type ScheduleErrorCode =
  | "invalid_prompt" | "invalid_selector" | "invalid_rule" | "invalid_time_zone"
  | "not_future" | "time_out_of_range" | "frequency_too_high";

/** A model-supplied rule or request that cannot become a reminder. */
export class ScheduleInputError extends Error {
  readonly code: ScheduleErrorCode;
  // Node runs the sources with type stripping, so no constructor parameter properties.
  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = "ScheduleInputError";
    this.code = code;
  }
}

/** Stored reminder data that breaks an invariant. */
export class ScheduleLogError extends Error {
  readonly code = "corrupt_schedule_log" as const;
  constructor(message: string) {
    super(message);
    this.name = "ScheduleLogError";
  }
}

export interface CivilDate { year: number; month: number; day: number }

/** Days since 1970-01-01 of a proleptic Gregorian date (astronomical years, so 1 BC is year 0). */
export function daysFromCivil({ year, month, day }: CivilDate): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

export function civilFromDays(days: number): CivilDate {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shifted = Math.floor((5 * dayOfYear + 2) / 153);
  const month = shifted < 10 ? shifted + 3 : shifted - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day: dayOfYear - Math.floor((153 * shifted + 2) / 5) + 1 };
}

/** ISO weekday of a day count: Monday 1 through Sunday 7. */
export const isoWeekday = (days: number): number => (((days + 3) % 7) + 7) % 7 + 1;
export const utcDay = (epochMs: number): number => Math.floor(epochMs / DAY_MS);
export const instantIso = (epochMs: number): string => new Date(epochMs).toISOString();

/** First day of the month after the one holding `days`. */
export function firstOfNextMonth(days: number): number {
  const { year, month } = civilFromDays(days);
  return daysFromCivil(month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 });
}

/** First day of the month holding `days`. */
export function firstOfMonth(days: number): number {
  const { year, month } = civilFromDays(days);
  return daysFromCivil({ year, month, day: 1 });
}

// ---- Time zones ----

const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;
const ZONE_MESSAGE = "time_zone must be UTC or a valid IANA Area/Location name.";

/** Validate one time-zone selector and return the runtime's canonical name for it. */
export function canonicalizeTimeZone(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || (value !== "UTC" && !IANA_ZONE.test(value))) {
    throw new ScheduleInputError("invalid_time_zone", ZONE_MESSAGE);
  }
  let canonical: string;
  try { canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new ScheduleInputError("invalid_time_zone", ZONE_MESSAGE); }
  if (canonical !== "UTC" && !IANA_ZONE.test(canonical)) throw new ScheduleInputError("invalid_time_zone", "time_zone must resolve to UTC or an IANA Area/Location name.");
  return canonical;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", era: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The zone's offset from UTC in effect at an instant, including a historical offset with seconds. */
export function zoneOffsetMs(epochMs: number, zone: string): number {
  if (zone === "UTC") return 0;
  const fields: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(epochMs)) fields[part.type] = part.value;
  const year = fields["era"] === "BC" ? 1 - Number(fields["year"]) : Number(fields["year"]);
  const day = daysFromCivil({ year, month: Number(fields["month"]), day: Number(fields["day"]) });
  const seconds = (Number(fields["hour"]) % 24) * 3600 + Number(fields["minute"]) * 60 + Number(fields["second"]);
  return day * DAY_MS + seconds * 1000 - Math.floor(epochMs / 1000) * 1000;
}

const OFFSET_SAMPLE_STEP_MS = 6 * HOUR_MS;
const offsetCache = new Map<string, number[]>();

/** Offsets the zone uses within a day and a half either side of a wall day: every offset an instant of that wall day can carry. */
function offsetsNear(zone: string, wallDay: number): number[] {
  if (zone === "UTC") return [0];
  const key = `${zone}|${wallDay}`;
  const cached = offsetCache.get(key);
  if (cached !== undefined) return cached;
  const found = new Set<number>();
  const first = wallDay * DAY_MS - 30 * HOUR_MS;
  for (let at = first; at <= first + DAY_MS + 60 * HOUR_MS; at += OFFSET_SAMPLE_STEP_MS) found.add(zoneOffsetMs(at, zone));
  if (offsetCache.size > 4096) offsetCache.clear();
  const offsets = [...found];
  offsetCache.set(key, offsets);
  return offsets;
}

/** The instant a wall time happens in a zone: the earlier one in a DST overlap, and none inside a gap. */
export function localInstant(wall: number, zone: string): number | undefined {
  const offsets = offsetsNear(zone, Math.floor(wall / DAY_MS));
  let earliest: number | undefined;
  for (const offset of offsets) {
    const instant = wall - offset;
    // With one offset in range nothing changes there, so the instant needs no check.
    if (offsets.length > 1 && zoneOffsetMs(instant, zone) !== offset) continue;
    if (earliest === undefined || instant < earliest) earliest = instant;
  }
  return earliest;
}

/** The day and time of day an instant has on a zone's wall clock. */
export function wallOf(epochMs: number, zone: string): { day: number; timeOfDayMs: number } {
  const wall = epochMs + zoneOffsetMs(epochMs, zone);
  const day = Math.floor(wall / DAY_MS);
  return { day, timeOfDayMs: wall - day * DAY_MS };
}

// ---- Clock times ----

const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/;

/** `HH:mm:ss` with optional one to three fractional digits, as milliseconds into the day. */
export function parseClockTime(value: unknown, selector: string): number {
  if (typeof value !== "string" || !CLOCK_TIME.test(value)) {
    throw new ScheduleInputError("invalid_rule", `${selector}.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.`);
  }
  const [clock = "", fraction = ""] = value.split(".");
  const [hours = 0, minutes = 0, seconds = 0] = clock.split(":").map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(fraction.padEnd(3, "0"));
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** Milliseconds into the day as the stored `HH:mm:ss.SSS`. */
export function formatClockTime(ms: number): string {
  return `${pad(Math.floor(ms / HOUR_MS), 2)}:${pad(Math.floor(ms / 60_000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)}.${pad(ms % 1000, 3)}`;
}

// ---- Absolute `at` input ----

export interface LocalAtInput { date: string; time: string; time_zone: string }
export type AtInput = string | LocalAtInput;

interface CalendarParts { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number }

const OFFSET_INSTANT = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?(?<zone>Z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/;
const LOCAL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/;
const LOCAL_TIME = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?$/;

const group = (groups: Record<string, string | undefined>, name: string): number => Number(groups[name]);
const millis = (fraction: string | undefined): number => (fraction === undefined ? 0 : Number(fraction.padEnd(3, "0")));
const badAt = (message: string) => new ScheduleInputError("invalid_rule", message);

/** The wall time of exact calendar fields, rejecting any that would roll over. */
function calendarWall(parts: CalendarParts, message: string): number {
  const value = new Date(0);
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  value.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  const same = value.getUTCFullYear() === parts.year && value.getUTCMonth() + 1 === parts.month && value.getUTCDate() === parts.day
    && value.getUTCHours() === parts.hour && value.getUTCMinutes() === parts.minute && value.getUTCSeconds() === parts.second;
  if (parts.year === 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59 || !same) throw badAt(message);
  return value.getTime();
}

function partsOf(date: Record<string, string | undefined>, time: Record<string, string | undefined>): CalendarParts {
  return {
    year: group(date, "year"), month: group(date, "month"), day: group(date, "day"),
    hour: group(time, "hour"), minute: group(time, "minute"), second: group(time, "second"), millisecond: millis(time["fraction"]),
  };
}

function parseOffsetInstant(value: string): number {
  const groups = OFFSET_INSTANT.exec(value)?.groups;
  if (groups === undefined) throw badAt("at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.");
  const wall = calendarWall(partsOf(groups, groups), "The at value must be a real ISO calendar date and time.");
  if (groups["zone"] === "Z") return wall;
  const hours = group(groups, "offsetHour");
  const minutes = group(groups, "offsetMinute");
  if (hours > 23 || minutes > 59 || (groups["sign"] === "-" && hours === 0 && minutes === 0)) throw badAt("The at numeric offset is invalid.");
  return wall - (groups["sign"] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000;
}

function parseLocalAt(value: Record<string, unknown>): number {
  const keys = Object.keys(value);
  if (keys.length !== 3 || !["date", "time", "time_zone"].every((key) => keys.includes(key))) throw badAt("Local at must contain exactly date, time, and time_zone.");
  if (typeof value["date"] !== "string" || typeof value["time"] !== "string") throw badAt("Local at date and time must be strings.");
  if (typeof value["time_zone"] !== "string") throw new ScheduleInputError("invalid_time_zone", "time_zone must be a string.");
  const date = LOCAL_DATE.exec(value["date"])?.groups;
  const time = LOCAL_TIME.exec(value["time"])?.groups;
  if (date === undefined || time === undefined) throw badAt("Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.");
  const zone = canonicalizeTimeZone(value["time_zone"]);
  const instant = localInstant(calendarWall(partsOf(date, time), "The local at value must be a real ISO calendar date and time."), zone);
  if (instant === undefined) throw badAt("The local at time does not exist in the selected time zone.");
  return instant;
}

/** An absolute selector as epoch milliseconds; it need not be in the future. */
export function parseAtInput(at: unknown): number {
  if (typeof at === "string") return parseOffsetInstant(at);
  if (typeof at === "object" && at !== null && !Array.isArray(at)) return parseLocalAt(at as Record<string, unknown>);
  throw badAt("at must be an explicit-offset string or local calendar object.");
}

/** A representable four-digit-year instant strictly after `now`, as a canonical UTC string. */
export function futureInstant(epoch: number, now: number): string {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(epoch) || epoch < MIN_INSTANT_MS || epoch > MAX_INSTANT_MS) {
    throw new ScheduleInputError("time_out_of_range", "The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.");
  }
  if (epoch <= now) throw new ScheduleInputError("not_future", "The scheduled time must be strictly in the future.");
  return instantIso(epoch);
}
