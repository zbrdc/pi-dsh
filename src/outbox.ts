/** Durable notice outbox: DSH's agent inbox, shaped for Pi.
 *
 * Completion and warning notices used to go straight to `pi.sendMessage`, which
 * Pi keeps in memory and delivers one message per model request. A burst of
 * finished children therefore cost one request each, and anything still queued
 * when the process died was lost. The outbox holds notices until a delivery
 * boundary drains them into a single message, and the extension snapshots it
 * into the session log so pending notices survive a restart. */

export interface Notice {
  id: string;
  /** Message customType used when this notice is delivered alone. */
  kind: string;
  content: string;
  at: number;
  /** A newer notice with the same key replaces an undelivered older one. */
  key?: string;
}

export interface Batch { customType: string; content: string; notices: Notice[] }

export const BATCH_CUSTOM_TYPE = "pi-dsh/notices";
const DEFAULT_BATCH_CHARS = 24_000;
const PREVIEW_CHARS = 100;

export function renderBatch(notices: Notice[]): Batch {
  if (notices.length === 1) return { customType: notices[0]!.kind, content: notices[0]!.content, notices };
  const body = notices.map((n, i) => `${i + 1}. ${n.content}`).join("\n\n");
  return { customType: BATCH_CUSTOM_TYPE, content: `[pi-dsh] ${notices.length} notices arrived:\n\n${body}`, notices };
}

const isNotice = (v: unknown): v is Notice => {
  const n = v as Partial<Notice> | null;
  return typeof n === "object" && n !== null && typeof n.id === "string" && typeof n.kind === "string"
    && typeof n.content === "string" && typeof n.at === "number" && (n.key === undefined || typeof n.key === "string");
};

export class Outbox {
  private list: Notice[] = [];
  private seq = 0;
  private readonly batchChars: number;

  // Node runs the sources with type stripping, so no constructor parameter properties.
  constructor(batchChars = DEFAULT_BATCH_CHARS) { this.batchChars = batchChars; }

  get size(): number { return this.list.length; }
  items(): readonly Notice[] { return this.list; }
  snapshot(): Notice[] { return this.list.map((n) => ({ ...n })); }

  /** Replace the queue from a persisted snapshot; malformed entries are dropped. */
  restore(data: unknown): void {
    this.list = Array.isArray(data) ? data.filter(isNotice).map((n) => ({ ...n })) : [];
    this.seq = this.list.reduce((max, n) => Math.max(max, Number(/^n(\d+)$/.exec(n.id)?.[1] ?? 0)), this.seq);
  }

  enqueue(kind: string, content: string, key?: string, now = Date.now()): Notice {
    if (key !== undefined) this.list = this.list.filter((n) => n.key !== key);
    const notice: Notice = { id: `n${++this.seq}`, kind, content, at: now, ...(key !== undefined ? { key } : {}) };
    this.list.push(notice);
    return notice;
  }

  remove(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((n) => n.id !== id);
    return this.list.length < before;
  }

  clear(): number {
    const n = this.list.length;
    this.list = [];
    return n;
  }

  /** Remove and render the next batch: oldest first, at least one notice, at most `batchChars` of text. */
  take(): Batch | undefined {
    if (this.list.length === 0) return undefined;
    let used = 0;
    let count = 0;
    for (const n of this.list) {
      if (count > 0 && used + n.content.length > this.batchChars) break;
      used += n.content.length;
      count++;
    }
    return renderBatch(this.list.splice(0, count));
  }
}

export interface InboxResult { text: string; changed: boolean; flush: boolean }

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

/** /inbox [list | show <id> | drop <id> | clear | flush], pure so it can be tested without a session. */
export function runInboxCommand(outbox: Outbox, args: string, now = Date.now()): InboxResult {
  const [verb = "list", id] = args.trim().split(/\s+/);
  const find = () => outbox.items().find((n) => n.id === id);
  switch (verb) {
    case "list": case "": {
      if (outbox.size === 0) return { text: "Inbox empty: no notices waiting for the model.", changed: false, flush: false };
      const rows = outbox.items().map((n) => `${n.id} [${n.kind.replace(/^pi-dsh\//, "")}] ${ago(now - n.at)} ago: ${n.content.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS)}`);
      return { text: `Inbox (${outbox.size} waiting, delivered as one message at the next step):\n${rows.join("\n")}`, changed: false, flush: false };
    }
    case "show": {
      const notice = find();
      return { text: notice ? notice.content : `No notice ${id ?? "(missing id)"}.`, changed: false, flush: false };
    }
    case "drop": {
      const removed = id !== undefined && outbox.remove(id);
      return { text: removed ? `Dropped ${id}.` : `No notice ${id ?? "(missing id)"}.`, changed: removed, flush: false };
    }
    case "clear": {
      const n = outbox.clear();
      return { text: `Cleared ${n} notice${n === 1 ? "" : "s"}.`, changed: n > 0, flush: false };
    }
    case "flush":
      return { text: outbox.size === 0 ? "Inbox empty." : `Delivering ${outbox.size} notice${outbox.size === 1 ? "" : "s"} now.`, changed: false, flush: outbox.size > 0 };
    default:
      return { text: "Usage: /inbox [list | show <id> | drop <id> | clear | flush]", changed: false, flush: false };
  }
}
