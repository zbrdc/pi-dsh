/** Tool-result pruner as persistent session edits (dsh compaction-tool-result-pruner, Pi-shaped).
 *
 * The old pruner rewrote the request through Pi's `context` event. That edit
 * is not stored, so the oldest results flipped from full to pruned one at a
 * time as the window slid, moving the prompt-cache boundary on every request,
 * and the whole message list was serialized each time just to measure it.
 * Planning against projected session entries and writing `context_edit`
 * entries makes the replacement permanent and idempotent: a pruned result is
 * already small on the next pass, and the cache prefix only changes when
 * pressure triggers a pass. */
import { pruneText } from "./core.ts";

/** The slice of Pi's ProjectedSessionEntry the planner reads. */
export interface ProjectedEntry {
  sourceEntry: { id: string; type: string };
  messages: Array<{ role?: string; content?: unknown }>;
}
export interface ContextEdit { targetId: string; content: unknown[] }
export interface PrunePlanOptions {
  /** The newest tool results are the working set and stay untouched. */
  keepRecentResults: number;
  /** A tool-result text longer than this is cut to head and tail. */
  maxResultChars: number;
  /** Store image bytes on disk and return the path, or undefined to keep the image inline. */
  offloadImage: (data: string, mimeType: string | undefined, tag: string) => string | undefined;
}

export const DEFAULT_KEEP_RECENT_RESULTS = 6;
export const DEFAULT_MAX_RESULT_CHARS = 8000;

const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const imageExtension = (mimeType: string | undefined): string => IMAGE_EXT[mimeType ?? ""] ?? "png";

type Block = { type?: string; text?: string; data?: string; mimeType?: string };

function pruneBlocks(content: Block[], role: string, entryId: string, opts: PrunePlanOptions): Block[] | undefined {
  let changed = false;
  const next = content.map((block, i): Block => {
    if (block.type === "image" && typeof block.data === "string") {
      const path = opts.offloadImage(block.data, block.mimeType, `${entryId}-${i}`);
      if (path === undefined) return block;
      changed = true;
      return { type: "text", text: `[image offloaded under context pressure: ${path}; load with read_image]` };
    }
    if (role === "toolResult" && block.type === "text" && typeof block.text === "string" && block.text.length > opts.maxResultChars) {
      changed = true;
      return { ...block, text: pruneText(block.text, opts.maxResultChars) };
    }
    return block;
  });
  return changed ? next : undefined;
}

/** Edits that shrink old, oversized tool results and images; empty when the whole context is still the working set. */
export function planPrune(entries: readonly ProjectedEntry[], opts: PrunePlanOptions): ContextEdit[] {
  const messageEntries = entries.filter((e) => e.sourceEntry.type === "message" && e.messages.length === 1);
  const resultPositions = messageEntries.flatMap((e, i) => (e.messages[0]!.role === "toolResult" ? [i] : []));
  if (resultPositions.length <= opts.keepRecentResults) return [];
  const protectedFrom = resultPositions[resultPositions.length - opts.keepRecentResults]!;
  const edits: ContextEdit[] = [];
  for (const [i, entry] of messageEntries.entries()) {
    if (i >= protectedFrom) break;
    const message = entry.messages[0]!;
    if ((message.role !== "toolResult" && message.role !== "user") || !Array.isArray(message.content)) continue;
    const content = pruneBlocks(message.content as Block[], message.role, entry.sourceEntry.id, opts);
    if (content) edits.push({ targetId: entry.sourceEntry.id, content });
  }
  return edits;
}

/** Characters of text and image payload in the projected context: a cheap pressure estimate when usage is unknown. */
export function contextChars(entries: readonly ProjectedEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    for (const message of entry.messages) {
      if (typeof message.content === "string") { total += message.content.length; continue; }
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Block[]) total += block.text?.length ?? block.data?.length ?? 0;
    }
  }
  return total;
}
