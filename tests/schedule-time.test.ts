import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY_MS, ScheduleInputError, canonicalizeTimeZone, civilFromDays, daysFromCivil, formatClockTime, futureInstant, isoWeekday,
  localInstant, parseAtInput, parseClockTime, wallOf, zoneOffsetMs,
} from "../src/schedule-time.ts";

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
/** The wall time of a local date and clock, as the rules code builds it. */
const wall = (date: string, time: string) => Date.parse(`${date}T${time}Z`);
const code = (expected: string) => (error: unknown) => error instanceof ScheduleInputError && error.code === expected;

test("civil dates round-trip through day counts, across leap rules and the year 0001", () => {
  for (const [year, month, day] of [[1970, 1, 1], [2000, 2, 29], [2100, 3, 1], [1, 1, 1], [9999, 12, 31], [0, 12, 31], [1600, 2, 29]] as const) {
    const days = daysFromCivil({ year, month, day });
    assert.deepEqual(civilFromDays(days), { year, month, day });
    if (year >= 100 && year <= 9999) assert.equal(days * DAY_MS, Date.UTC(year, month - 1, day), `${year}-${month}-${day}`);
  }
  assert.equal(daysFromCivil({ year: 1970, month: 1, day: 1 }), 0);
});

test("ISO weekdays: Monday 1 through Sunday 7", () => {
  assert.equal(isoWeekday(daysFromCivil({ year: 1970, month: 1, day: 1 })), 4); // Thursday
  assert.equal(isoWeekday(daysFromCivil({ year: 2026, month: 9, day: 14 })), 1); // Monday
  assert.equal(isoWeekday(daysFromCivil({ year: 2026, month: 11, day: 1 })), 7); // Sunday
  assert.equal(isoWeekday(daysFromCivil({ year: 1969, month: 12, day: 31 })), 3);
});

test("zone names are validated and aliases are canonicalized by the runtime", () => {
  assert.equal(canonicalizeTimeZone("UTC"), "UTC");
  assert.equal(canonicalizeTimeZone("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(canonicalizeTimeZone("US/Eastern"), "America/New_York");
  for (const bad of ["", " UTC", "CST", "+08:00", "Unknown/Zone", "Etc"]) {
    assert.throws(() => canonicalizeTimeZone(bad), code("invalid_time_zone"), JSON.stringify(bad));
  }
});

test("offsets follow the zone, including a historical offset with seconds", () => {
  assert.equal(zoneOffsetMs(Date.parse("2026-07-01T00:00:00Z"), "America/New_York"), -4 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.parse("2026-12-01T00:00:00Z"), "America/New_York"), -5 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.parse("2026-01-01T00:00:00Z"), "Australia/Lord_Howe"), 11 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.parse("2026-07-01T00:00:00Z"), "Australia/Lord_Howe"), 10.5 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.parse("1867-10-17T12:00:00Z"), "America/Anchorage"), 14 * 3_600_000 + 24_000, "Russian-era offset, with seconds");
  assert.equal(zoneOffsetMs(Date.parse("1867-10-21T00:00:00Z"), "America/Anchorage"), -(9 * 3_600_000 + 59 * 60_000 + 36_000), "after the 1867 transfer");
  assert.equal(zoneOffsetMs(Date.parse("0001-01-01T00:00:00Z"), "Etc/GMT+1"), -3_600_000);
});

test("a wall time resolves to its instant; a gap has none and an overlap takes the earlier", () => {
  assert.equal(iso(localInstant(wall("2026-03-08", "02:30:00"), "America/New_York")), undefined, "spring-forward gap");
  assert.equal(iso(localInstant(wall("2026-03-08", "03:30:00"), "America/New_York")), "2026-03-08T07:30:00.000Z");
  assert.equal(iso(localInstant(wall("2026-11-01", "01:30:00"), "America/New_York")), "2026-11-01T05:30:00.000Z", "fall-back overlap, first pass");
  assert.equal(iso(localInstant(wall("2026-11-01", "02:30:00"), "America/New_York")), "2026-11-01T07:30:00.000Z");
  assert.equal(iso(localInstant(wall("2026-09-16", "23:00:00"), "UTC")), "2026-09-16T23:00:00.000Z");
});

test("half-hour and whole-day transitions resolve like the zone database says", () => {
  assert.equal(iso(localInstant(wall("2026-10-04", "02:15:00"), "Australia/Lord_Howe")), undefined, "Lord Howe gap");
  assert.equal(iso(localInstant(wall("2026-04-05", "01:45:00"), "Australia/Lord_Howe")), "2026-04-04T14:45:00.000Z", "Lord Howe overlap, earlier");
  assert.equal(iso(localInstant(wall("2011-12-30", "12:00:00"), "Pacific/Apia")), undefined, "Apia skipped 30 December 2011");
  assert.equal(iso(localInstant(wall("2011-12-29", "12:00:00"), "Pacific/Apia")), "2011-12-29T22:00:00.000Z");
  assert.equal(iso(localInstant(wall("2011-12-31", "12:00:00"), "Pacific/Apia")), "2011-12-30T22:00:00.000Z");
});

test("the wall clock of an instant, in any zone", () => {
  const at = wallOf(Date.parse("2026-01-01T11:00:00Z"), "Pacific/Kiritimati");
  assert.equal(at.day, daysFromCivil({ year: 2026, month: 1, day: 2 }));
  assert.equal(at.timeOfDayMs, 1 * 3_600_000);
});

test("clock times parse strictly and print as HH:mm:ss.SSS", () => {
  assert.equal(parseClockTime("23:00:00", "daily"), 23 * 3_600_000);
  assert.equal(parseClockTime("00:00:00.1", "daily"), 100);
  assert.equal(formatClockTime(parseClockTime("23:00:00.12", "daily")), "23:00:00.120");
  assert.equal(formatClockTime(parseClockTime("09:30:15.123", "weekly")), "09:30:15.123");
  for (const bad of ["23:00", "3:00:00", "24:00:00", "23:60:00", "23:59:60", "23:00:00.", "23:00:00.1234", "23:00:00Z", " 23:00:00", "", 7, null]) {
    assert.throws(() => parseClockTime(bad, "daily"), code("invalid_rule"), JSON.stringify(bad));
  }
});

test("an `at` value is an exact offset instant or an explicit local time", () => {
  assert.equal(iso(parseAtInput("2099-01-01T09:00:00+08:00")), "2099-01-01T01:00:00.000Z");
  assert.equal(iso(parseAtInput("2026-09-16T02:30:00.321Z")), "2026-09-16T02:30:00.321Z");
  assert.equal(iso(parseAtInput({ date: "2026-09-16", time: "10:30:00.321", time_zone: "Asia/Shanghai" })), "2026-09-16T02:30:00.321Z");
  assert.equal(iso(parseAtInput({ date: "2026-11-01", time: "01:30:00", time_zone: "America/New_York" })), "2026-11-01T05:30:00.000Z", "overlap takes the earlier instant");
  const invalid: [unknown, string][] = [
    ["2026-09-16T02:30:00", "invalid_rule"], ["2026-02-30T00:00:00Z", "invalid_rule"], ["2026-09-16T24:00:00Z", "invalid_rule"],
    ["2026-09-16T00:00:00-00:00", "invalid_rule"], ["2026-09-16T00:00:00+24:00", "invalid_rule"], ["0000-01-01T00:00:00Z", "invalid_rule"],
    [{ date: "2027-03-14", time: "02:30:00", time_zone: "America/New_York" }, "invalid_rule"],
    [{ date: "2026-09-16", time: "12:00:00", time_zone: "Invalid/Zone" }, "invalid_time_zone"],
    [{ date: "2026-09-16", time: "12:00:00", time_zone: "UTC", extra: true }, "invalid_rule"],
    [{ date: "2026-09-16", time: "12:00:00" }, "invalid_rule"], [7, "invalid_rule"], [null, "invalid_rule"], [[], "invalid_rule"],
  ];
  for (const [input, expected] of invalid) assert.throws(() => parseAtInput(input), code(expected), JSON.stringify(input));
  assert.throws(() => parseAtInput({ date: "2011-12-30", time: "12:00:00", time_zone: "Pacific/Apia" }), /does not exist/);
});

test("a target must be future and inside the four-digit years", () => {
  const now = Date.parse("2026-09-16T00:00:00Z");
  assert.equal(futureInstant(now + 1, now), "2026-09-16T00:00:00.001Z");
  assert.throws(() => futureInstant(now, now), code("not_future"));
  assert.throws(() => futureInstant(now - 1, now), code("not_future"));
  assert.throws(() => futureInstant(Date.parse("+010000-01-01T00:00:00Z"), now), code("time_out_of_range"));
  assert.throws(() => futureInstant(Number.NaN, now), code("time_out_of_range"));
  assert.throws(() => futureInstant(now + 1, Number.NaN), code("time_out_of_range"));
});
