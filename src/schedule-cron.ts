/** The five-field Vixie cron dialect of dsh Schedule: parsing, canonical spelling, and day matching. */
import { isoWeekday, civilFromDays, ScheduleInputError } from "./schedule-time.ts";

interface FieldSpec {
  name: string; min: number; max: number;
  /** Highest value kept after folding Sunday 7 onto 0. */
  canonicalMax: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59, canonicalMax: 59 },
  { name: "hour", min: 0, max: 23, canonicalMax: 23 },
  { name: "day-of-month", min: 1, max: 31, canonicalMax: 31 },
  { name: "month", min: 1, max: 12, canonicalMax: 12 },
  { name: "day-of-week", min: 0, max: 7, canonicalMax: 6 },
];

const invalid = (message: string) => new ScheduleInputError("invalid_rule", message);
const invalidElement = (spec: FieldSpec, element: string) =>
  invalid(`cron.expression ${spec.name} field element ${JSON.stringify(element)} must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.`);

function fieldValue(text: string, spec: FieldSpec): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw invalid(`cron.expression ${spec.name} field value ${text} is outside ${spec.min}-${spec.max}.`);
  }
  return value;
}

function fieldStep(text: string, spec: FieldSpec): number {
  const step = Number(text);
  if (!Number.isSafeInteger(step) || step < 1) throw invalid(`cron.expression ${spec.name} field step must be a positive integer.`);
  return step;
}

/** The values one comma-separated element matches. */
function elementValues(element: string, spec: FieldSpec): number[] {
  const values: number[] = [];
  const walk = (start: number, end: number, step: number) => { for (let v = start; v <= end; v += step) values.push(v); };
  if (element === "*") { walk(spec.min, spec.max, 1); return values; }
  if (element.startsWith("*")) {
    const step = /^\*\/(\d+)$/.exec(element)?.[1];
    if (step === undefined) throw invalidElement(spec, element);
    walk(spec.min, spec.max, fieldStep(step, spec));
    return values;
  }
  const groups = /^(?<start>\d+)(?:-(?<end>\d+))?(?:\/(?<step>\d+))?$/.exec(element)?.groups;
  if (groups === undefined) throw invalidElement(spec, element);
  const start = fieldValue(groups["start"] ?? "", spec);
  if (groups["end"] === undefined) {
    if (groups["step"] !== undefined) throw invalidElement(spec, element);
    return [start];
  }
  const end = fieldValue(groups["end"], spec);
  if (start > end) throw invalid(`cron.expression ${spec.name} field range ${start}-${end} is inverted.`);
  walk(start, end, groups["step"] === undefined ? 1 : fieldStep(groups["step"], spec));
  return values;
}

const foldSunday = (value: number, spec: FieldSpec): number => (spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value);

/** Expand one field into its sorted, unique matched values. */
function fieldValues(raw: string, spec: FieldSpec): number[] {
  const matched = new Set<number>();
  for (const element of raw.split(",")) {
    if (element.length === 0) throw invalid(`cron.expression ${spec.name} field must not contain an empty list element.`);
    for (const value of elementValues(element, spec)) matched.add(foldSunday(value, spec));
  }
  return [...matched].sort((a, b) => a - b);
}

/** Shortest equivalent comma-separated spelling of a sorted value set; never starts with `*`. */
function encodeField(values: readonly number[]): string {
  const first = values[0] ?? 0;
  if (values.length === 1) return String(first);
  const last = values[values.length - 1] ?? first;
  const step = (values[1] ?? first) - first;
  if (values.every((v, i) => i === 0 || v - (values[i - 1] ?? v) === step)) return step === 1 ? `${first}-${last}` : `${first}-${last}/${step}`;
  const parts: string[] = [];
  let runStart = first;
  for (let i = 1; i <= values.length; i++) {
    const previous = values[i - 1] ?? first;
    if (i < values.length && (values[i] ?? 0) === previous + 1) continue;
    parts.push(runStart === previous ? String(runStart) : `${runStart}-${previous}`);
    runStart = values[i] ?? runStart;
  }
  return parts.join(",");
}

/** Values one uniform walk from a field's minimum produces, folded as a parsed field folds. */
function starWalk(spec: FieldSpec, step: number): number[] {
  const walked = new Set<number>();
  for (let v = spec.min; v <= spec.max; v += step) walked.add(foldSunday(v, spec));
  return [...walked].sort((a, b) => a - b);
}

/** Canonical spelling of a field that started with `*`: the bare star, else the widest star-step walk plus any remaining values. */
function encodeStarField(values: readonly number[], spec: FieldSpec): string {
  if (values.length === spec.canonicalMax - spec.min + 1) return "*";
  const present = new Set(values);
  let bestStep = 1;
  let bestWalk: number[] = [];
  for (let step = 1; step <= spec.max - spec.min + 1; step++) {
    const walk = starWalk(spec, step);
    if (walk.length > bestWalk.length && walk.every((v) => present.has(v))) { bestStep = step; bestWalk = walk; }
  }
  const walked = new Set(bestWalk);
  const remaining = values.filter((v) => !walked.has(v));
  return remaining.length === 0 ? `*/${bestStep}` : `*/${bestStep},${encodeField(remaining)}`;
}

export interface ParsedCron {
  /** Canonical expression, as stored. */
  expression: string;
  minutes: readonly number[]; hours: readonly number[]; daysOfMonth: readonly number[]; months: readonly number[];
  /** Sunday 0 through Saturday 6. */
  daysOfWeek: readonly number[];
  /** Whether the field text starts with `*` (Vixie DOM_STAR / DOW_STAR). */
  dayOfMonthStar: boolean; dayOfWeekStar: boolean;
}

/** Parse and canonicalize one strict five-field cron expression. */
export function parseCronExpression(expression: unknown): ParsedCron {
  if (typeof expression !== "string" || expression.length === 0 || expression.trim() !== expression) throw invalid("cron.expression must be a non-empty trimmed string.");
  const texts = expression.split(/\s+/);
  if (texts.length !== 5) throw invalid("cron.expression must contain exactly five whitespace-separated fields: minute hour day-of-month month day-of-week.");
  const fields = texts.map((text, index) => {
    const spec = FIELDS[index] as FieldSpec;
    const values = fieldValues(text, spec);
    const star = text.startsWith("*");
    return { values, star, canonical: star ? encodeStarField(values, spec) : encodeField(values) };
  });
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [typeof fields[number], typeof fields[number], typeof fields[number], typeof fields[number], typeof fields[number]];
  return {
    expression: fields.map((f) => f.canonical).join(" "),
    minutes: minute.values, hours: hour.values, daysOfMonth: dayOfMonth.values, months: month.values, daysOfWeek: dayOfWeek.values,
    dayOfMonthStar: dayOfMonth.star, dayOfWeekStar: dayOfWeek.star,
  };
}

export const canonicalizeCronExpression = (expression: string): string => parseCronExpression(expression).expression;

/** Local times of day a rule fires, ascending, as milliseconds into the day. */
export function cronTimes(parsed: ParsedCron): number[] {
  const times: number[] = [];
  for (const hour of parsed.hours) for (const minute of parsed.minutes) times.push((hour * 60 + minute) * 60_000);
  return times;
}

/** Whether a day matches under Vixie rules: with a star in either day field both must match, otherwise either may. */
export function cronDayMatcher(parsed: ParsedCron): (day: number) => boolean {
  const months = new Set(parsed.months);
  const daysOfMonth = new Set(parsed.daysOfMonth);
  const daysOfWeek = new Set(parsed.daysOfWeek);
  const bothRestricted = !parsed.dayOfMonthStar && !parsed.dayOfWeekStar;
  return (day) => {
    const { month, day: dayOfMonth } = civilFromDays(day);
    if (!months.has(month)) return false;
    const byMonthDay = daysOfMonth.has(dayOfMonth);
    const byWeekday = daysOfWeek.has(isoWeekday(day) % 7);
    return bothRestricted ? byMonthDay || byWeekday : byMonthDay && byWeekday;
  };
}
