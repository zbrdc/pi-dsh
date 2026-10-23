/** `/schedule`: the user's view of reminders, pure so it can be tested without a session (dsh keeps this in its Automation page). */
import type { ScheduleRecord } from "./schedule.ts";
import type { ScheduleService } from "./schedule-service.ts";
import type { ScheduleTask } from "./schedule-store.ts";

export interface ScheduleCommandResult { text: string; changed: boolean }

const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The rule in words, as the model supplied it. */
export function describeRule(record: ScheduleRecord): string {
  switch (record.kind) {
    case "after": return `once, ${record.afterSeconds}s after creation`;
    case "at": return "once";
    case "every": return `every ${record.everySeconds}s`;
    case "daily": return `daily at ${record.time} ${record.timeZone}`;
    case "weekly": return `${record.weekdays.map((d) => WEEKDAYS[d]).join(",")} at ${record.time} ${record.timeZone}`;
    case "cron": return `cron "${record.expression}" ${record.timeZone}`;
  }
}

function relative(ms: number): string {
  const seconds = Math.round(Math.abs(ms) / 1000);
  const span = seconds < 90 ? `${seconds}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : seconds < 129_600 ? `${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 86_400)}d`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

function row(task: ScheduleTask, now: number, withSession: boolean): string {
  const { record } = task;
  const next = task.status === "active" ? `next ${record.scheduledAt} (${relative(Date.parse(record.scheduledAt) - now)})` : `ended ${task.lastDelivery?.deliveredAt ?? record.scheduledAt}`;
  const session = withSession ? ` [session ${task.sessionId}]` : "";
  return `${record.id} ${task.status}${session} — ${record.title}: ${describeRule(record)}; ${next}`;
}

function show(task: ScheduleTask, now: number): string {
  const { record } = task;
  return [
    row(task, now, false), `prompt: ${record.prompt}`,
    task.lastDelivery === undefined ? "never delivered" : `last delivery: occurrence ${task.lastDelivery.scheduledAt}, delivered ${task.lastDelivery.deliveredAt}`,
  ].join("\n");
}

function history(service: ScheduleService, id: string, before: string | undefined): string {
  const page = service.history(id, 20, before);
  if ("code" in page) return page.code === "schedule_not_found" ? `No reminder ${id}.` : `No delivery ${before} in the history of ${id}.`;
  if (page.records.length === 0) return `${id} has no saved deliveries.`;
  const lines = page.records.map((r) => `${r.deliveredAt} — occurrence ${r.scheduledAt}${r.prompt === undefined ? "" : `: ${r.prompt.replace(/\s+/g, " ").slice(0, 100)}`}`);
  if (page.nextBefore !== undefined) lines.push(`older: /schedule history ${id} ${page.nextBefore}`);
  if (page.earlierRecordsPruned) lines.push(`(older deliveries were pruned: keeping ${page.retention.records} records or ${page.retention.days} days)`);
  return lines.join("\n");
}

const USAGE = "Usage: /schedule [list | all | show <id> | history <id> [before] | delete <id>]";

/** /schedule [list | all | show <id> | history <id> [before] | delete <id>] */
export function runScheduleCommand(service: ScheduleService, args: string, now = Date.now()): ScheduleCommandResult {
  const [verb = "list", id, before] = args.trim().split(/\s+/);
  const unchanged = (text: string): ScheduleCommandResult => ({ text, changed: false });
  const find = () => service.tasks().find((t) => t.record.id === id);
  switch (verb) {
    case "": case "list": {
      const tasks = service.tasks();
      return unchanged(tasks.length === 0 ? "No reminders in this session." : [`Reminders (${tasks.length}):`, ...tasks.map((t) => row(t, now, false))].join("\n"));
    }
    case "all": {
      const tasks = service.allSessions();
      return unchanged(tasks.length === 0 ? "No reminders in any session." : [`Reminders in all sessions (${tasks.length}); only this session's fire here:`, ...tasks.map((t) => row(t, now, true))].join("\n"));
    }
    case "show": {
      const task = find();
      return unchanged(task === undefined ? `No reminder ${id ?? "(missing id)"}.` : show(task, now));
    }
    case "history":
      return unchanged(id === undefined ? USAGE : history(service, id, before));
    case "delete": {
      if (id === undefined) return unchanged(USAGE);
      const outcome = service.remove(id);
      return { text: outcome.deleted ? `Deleted ${id}. A reminder already queued is not retracted.` : `No reminder ${id}.`, changed: outcome.deleted };
    }
    default:
      return unchanged(USAGE);
  }
}
