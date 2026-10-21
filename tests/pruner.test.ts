import test from "node:test";
import assert from "node:assert/strict";
import { contextChars, planPrune, type PrunePlanOptions, type ProjectedEntry } from "../src/pruner.ts";

const big = (n: number) => "x".repeat(n);
const result = (id: string, text: string): ProjectedEntry => ({ sourceEntry: { id, type: "message" }, messages: [{ role: "toolResult", content: [{ type: "text", text }] }] });
const user = (id: string, content: unknown): ProjectedEntry => ({ sourceEntry: { id, type: "message" }, messages: [{ role: "user", content }] });
const assistant = (id: string): ProjectedEntry => ({ sourceEntry: { id, type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
const opts = (over: Partial<PrunePlanOptions> = {}): PrunePlanOptions => ({
  keepRecentResults: 2, maxResultChars: 100, offloadImage: (_d, _m, tag) => `/spill/${tag}.png`, ...over,
});

test("old oversized tool results are cut; the newest results are the working set", () => {
  const entries = [result("r1", big(500)), assistant("a1"), result("r2", big(500)), result("r3", big(500)), result("r4", big(500))];
  const edits = planPrune(entries, opts());
  assert.deepEqual(edits.map((e) => e.targetId), ["r1", "r2"]);
  const text = (edits[0]!.content[0] as { text: string }).text;
  assert.ok(text.length <= 100);
  assert.match(text, /middle pruned/);
});

test("nothing is pruned while the whole context is still the working set", () => {
  assert.deepEqual(planPrune([result("r1", big(500)), result("r2", big(500))], opts()), []);
});

test("small old results are left alone", () => {
  const entries = [result("r1", "short"), result("r2", "short"), result("r3", big(500)), result("r4", big(500))];
  assert.deepEqual(planPrune(entries, opts()), []);
});

test("an already pruned result produces no second edit", () => {
  const first = [result("r1", big(500)), result("r2", "s"), result("r3", "s")];
  const [edit] = planPrune(first, opts());
  const projected = [{ ...first[0]!, messages: [{ role: "toolResult", content: edit!.content }] }, first[1]!, first[2]!];
  assert.deepEqual(planPrune(projected, opts()), []);
});

test("old images are offloaded to disk and replaced by a pointer", () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  const entries = [user("u1", [{ type: "text", text: "look" }, image]), result("r1", "s"), result("r2", "s"), result("r3", "s")];
  const [edit] = planPrune(entries, opts());
  assert.equal(edit!.targetId, "u1");
  assert.deepEqual(edit!.content[0], { type: "text", text: "look" });
  assert.match((edit!.content[1] as { text: string }).text, /offloaded under context pressure: \/spill\/u1-1\.png; load with read_image/);
});

test("an image that cannot be offloaded stays inline", () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  const entries = [user("u1", [image]), result("r1", "s"), result("r2", "s"), result("r3", "s")];
  assert.deepEqual(planPrune(entries, opts({ offloadImage: () => undefined })), []);
});

test("user text and string content are never rewritten", () => {
  const entries = [user("u1", big(5000)), user("u2", [{ type: "text", text: big(5000) }]), result("r1", "s"), result("r2", "s"), result("r3", "s")];
  assert.deepEqual(planPrune(entries, opts()), []);
});

test("only message entries with one projected message are candidates", () => {
  const custom: ProjectedEntry = { sourceEntry: { id: "c1", type: "custom_message" }, messages: [{ role: "custom", content: big(5000) }] };
  const empty: ProjectedEntry = { sourceEntry: { id: "e1", type: "message" }, messages: [] };
  assert.deepEqual(planPrune([custom, empty, result("r1", "s"), result("r2", "s"), result("r3", "s")], opts()), []);
});

test("contextChars counts text, string content, and image payloads", () => {
  assert.equal(contextChars([user("u1", "abc"), result("r1", big(10)), user("u2", [{ type: "image", data: "12345" }])]), 18);
});
