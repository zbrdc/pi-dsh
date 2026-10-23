/** Model-facing `schedule_create`, `schedule_list`, `schedule_update` and `schedule_delete` (dsh packages/schedule/tool-schedule).
 *
 * Every call acts on the calling session's reminders. A delegated child never sees these tools: children load only
 * pi-dsh's inline child policy, and external agent products have no route back into the parent's tool registry. */
import { Type } from "typebox";
import { ScheduleInputError } from "./schedule-time.ts";
import {
  MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, scheduleView, type ScheduleCreateRequest, type ScheduleUpdate, type TimingChange,
} from "./schedule.ts";
import type { ScheduleService } from "./schedule-service.ts";

export interface ScheduleToolApi {
  schedule: ScheduleService;
  remember(ctx: unknown): void;
  /** IANA zone to suggest when the user names a clock time without one. */
  zone: string;
}

const text = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }], details: {} });
const failure = (code: string, message: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ code, message }) }], details: {}, isError: true as const });

/** Run one tool body; input errors keep their stable code, anything else reports its message. */
function guarded(body: () => unknown) {
  try { return text(body()); }
  catch (error) {
    if (error instanceof ScheduleInputError) return failure(error.code, error.message);
    return failure("internal_error", error instanceof Error ? error.message : "The schedule operation failed.");
  }
}

const ZONE_HINT = "UTC or IANA Area/Location, for example Asia/Shanghai.";
const strict = { additionalProperties: false } as const;

const atParam = Type.Union([
  Type.String(),
  Type.Object({ date: Type.String(), time: Type.String(), time_zone: Type.String() }, strict),
], { description: "Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone." });
const everyParam = Type.Number({ description: `Fixed-rate interval in whole seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}, aligned to the creation time; changing it with schedule_update re-aligns it to the save time.` });
const dailyParam = Type.Object({
  time: Type.String({ description: "HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00." }),
  time_zone: Type.String({ description: ZONE_HINT }),
}, { ...strict, description: "Every day at a local time." });
const weeklyParam = Type.Object({
  time: Type.String({ description: "HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00." }),
  time_zone: Type.String({ description: ZONE_HINT }),
  weekdays: Type.Array(Type.Integer(), { description: "ISO weekdays, Monday 1 through Sunday 7, without repetitions." }),
}, { ...strict, description: "On the given weekdays at a local time." });
const cronParam = Type.Object({
  expression: Type.String({ description: 'minute hour day-of-month month day-of-week, for example "*/15 9-17 * * 1-5". When both day fields are restricted, a date matches if either one matches.' }),
  time_zone: Type.String({ description: ZONE_HINT }),
}, { ...strict, description: "Five-field Vixie cron expression in a time zone." });

const titleDescription = `Concise task name in the user's language, at most ${MAX_TITLE_LENGTH} characters. Name only the core action and subject; keep essential target identifiers such as PR numbers and branch names. `
  + "Do not include execution frequency (e.g. daily, hourly), scheduled dates/times, time zones, task status, or configuration and execution details, even when embedded in the requested or existing title. "
  + "Do not append parenthetical notes. Put scheduling information in the timing parameters and execution instructions in prompt.";

const CREATE_KEYS = ["prompt", "title", "after_seconds", "at", "every_seconds", "daily", "weekly", "cron"];
const UPDATE_KEYS = ["id", "title", "prompt", "at", "every_seconds", "daily", "weekly", "cron"];
const wrongSelectors = (what: string, list: string) => new ScheduleInputError("invalid_selector", `${what} accepts ${list}.`);

/** The one timing replacement an update carries, or undefined when it keeps the committed target. */
function timingChange(p: Record<string, any>): TimingChange | undefined {
  if (p.at !== undefined) return { kind: "at", at: p.at };
  if (p.every_seconds !== undefined) return { kind: "every", every_seconds: p.every_seconds };
  if (p.daily !== undefined) return { kind: "daily", daily: p.daily };
  if (p.weekly !== undefined) return { kind: "weekly", weekly: p.weekly };
  if (p.cron !== undefined) return { kind: "cron", cron: p.cron };
  return undefined;
}

function checkUpdateArgs(p: Record<string, any>): void {
  const selectors = ["at", "every_seconds", "daily", "weekly", "cron"].filter((key) => p[key] !== undefined).length;
  if (Object.keys(p).some((key) => !UPDATE_KEYS.includes(key)) || selectors > 1) throw wrongSelectors("schedule_update", "at most one of at, every_seconds, daily, weekly, or cron");
  if (typeof p.id !== "string" || p.id.length === 0 || p.id.trim() !== p.id) throw new ScheduleInputError("invalid_rule", "schedule_update id must be non-empty without surrounding whitespace.");
  if (selectors === 0 && p.title === undefined && p.prompt === undefined) throw new ScheduleInputError("invalid_selector", "schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.");
}

export function registerScheduleTools(pi: any, api: ScheduleToolApi): void {
  const { schedule } = api;
  pi.registerTool({
    name: "schedule_create", label: "Schedule create",
    description: "Create a reminder in the current session that delivers prompt when it becomes due. Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. "
      + "Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. After downtime, a recurring reminder delivers only its latest missed occurrence, "
      + `and a reminder only fires while pi runs this session. Delivery can repeat after a crash. When the user gives no time zone, use ${api.zone}.`,
    promptSnippet: "Create a timed or recurring reminder for this session",
    parameters: Type.Object({
      prompt: Type.String({ description: "Reminder content to present when the target becomes due." }),
      title: Type.String({ description: titleDescription }),
      after_seconds: Type.Optional(Type.Number({ description: "Delay in whole seconds." })),
      every_seconds: Type.Optional(everyParam), daily: Type.Optional(dailyParam), weekly: Type.Optional(weeklyParam),
      cron: Type.Optional(cronParam), at: Type.Optional(atParam),
    }),
    async execute(_id: string, p: Record<string, any>, _s: unknown, _u: unknown, ctx: unknown) {
      api.remember(ctx);
      return guarded(() => {
        if (Object.keys(p).some((key) => !CREATE_KEYS.includes(key))) throw wrongSelectors("schedule_create", "exactly one of after_seconds, at, every_seconds, daily, weekly, or cron");
        return scheduleView(schedule.create(p as unknown as ScheduleCreateRequest), schedule.now());
      });
    },
  });
  pi.registerTool({
    name: "schedule_list", label: "Schedule list",
    description: "List the active reminders in the current session.",
    promptSnippet: "List this session's active reminders",
    parameters: Type.Object({}),
    async execute(_id: string, _p: unknown, _s: unknown, _u: unknown, ctx: unknown) {
      api.remember(ctx);
      return guarded(() => schedule.list().map((record) => scheduleView(record, schedule.now())));
    },
  });
  pi.registerTool({
    name: "schedule_delete", label: "Schedule delete",
    description: "Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.",
    promptSnippet: "Delete a reminder by id",
    parameters: Type.Object({ id: Type.String({ description: "Exact schedule id." }) }),
    async execute(_id: string, p: { id: string }, _s: unknown, _u: unknown, ctx: unknown) {
      api.remember(ctx);
      return guarded(() => {
        if (typeof p.id !== "string" || p.id.length === 0 || p.id.trim() !== p.id) throw new ScheduleInputError("invalid_rule", "schedule_delete id must be non-empty without surrounding whitespace.");
        return schedule.remove(p.id);
      });
    },
  });
  pi.registerTool({
    name: "schedule_update", label: "Schedule update",
    description: "Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; omitted fields keep their stored values. To change a relative delay, create a new reminder.",
    promptSnippet: "Change a reminder's name, instruction, or timing",
    parameters: Type.Object({
      id: Type.String({ description: "Schedule id returned by schedule_list." }),
      title: Type.Optional(Type.String({ description: "New task name; follow the schedule_create title rules." })),
      prompt: Type.Optional(Type.String({ description: "New reminder content." })),
      every_seconds: Type.Optional(everyParam), daily: Type.Optional(dailyParam), weekly: Type.Optional(weeklyParam),
      cron: Type.Optional(cronParam), at: Type.Optional(atParam),
    }),
    async execute(_id: string, p: Record<string, any>, _s: unknown, _u: unknown, ctx: unknown) {
      api.remember(ctx);
      return guarded(() => {
        checkUpdateArgs(p);
        const update: ScheduleUpdate = { ...(p.title === undefined ? {} : { title: p.title }), ...(p.prompt === undefined ? {} : { prompt: p.prompt }) };
        const change = timingChange(p);
        const outcome = schedule.update(p.id, change === undefined ? update : { ...update, change });
        return "record" in outcome ? scheduleView(outcome.record, schedule.now()) : outcome;
      });
    },
  });
}
