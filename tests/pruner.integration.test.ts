import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, fauxAssistantMessage, fauxToolCall } from "./support/pi-session.ts";

const FLOOD = "head -c 20000 /dev/zero | tr '\\0' 'a'";
const flood = () => fauxAssistantMessage([fauxToolCall("bash", { command: FLOOD })]);
/** Pressure forced on: any reported usage percent and the character fallback both pass. */
const PRESSURE = { pruneAtContextPercent: 0, pruneThresholdChars: 1000 };

const toolResultLengths = (messages: any[]) => messages
  .filter((m) => m.role === "toolResult")
  .map((m) => m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("").length);

/** Faux step that records the tool-result sizes the model is shown, then answers. */
function recordResults(into: { sizes?: number[] }, answer = "done") {
  return (context: { messages: any[] }) => {
    into.sizes = toolResultLengths(context.messages);
    return fauxAssistantMessage(answer);
  };
}

const edits = (h: Awaited<ReturnType<typeof createHarness>>) =>
  (h.session.sessionManager.getBranch() as any[]).filter((e) => e.type === "context_edit");

test("under pressure, results older than the newest six become stored edits", async (t) => {
  const h = await createHarness({ config: PRESSURE });
  t.after(() => h.dispose());
  const shown: { sizes?: number[] } = {};
  h.faux.setResponses([...Array.from({ length: 9 }, flood), recordResults(shown)]);
  await h.session.prompt("flood the context");
  await h.settled();
  assert.equal(edits(h).length, 3, "expected one edit per result that aged out of the working set");
  assert.equal(shown.sizes?.length, 9);
  assert.ok(shown.sizes!.slice(0, 3).every((n) => n <= 8000), `old results still large: ${shown.sizes}`);
  assert.ok(shown.sizes!.slice(3).every((n) => n >= 15_000), `recent results were cut: ${shown.sizes}`);
});

test("a second pass does not edit what is already pruned", async (t) => {
  const h = await createHarness({ config: PRESSURE });
  t.after(() => h.dispose());
  h.faux.setResponses([...Array.from({ length: 9 }, flood), fauxAssistantMessage("done")]);
  await h.session.prompt("flood the context");
  await h.settled();
  const before = edits(h).map((e) => e.targetId);
  h.faux.setResponses([flood(), fauxAssistantMessage("done again")]);
  await h.session.prompt("one more");
  await h.settled();
  const after = edits(h).map((e) => e.targetId);
  assert.equal(after.length, before.length + 1, "only the newly aged-out result should be edited");
  assert.deepEqual(after.slice(0, before.length), before);
});

test("edits are stored in the session, so a restarted session still sees pruned results", async (t) => {
  const first = await createHarness({ config: PRESSURE });
  first.faux.setResponses([...Array.from({ length: 9 }, flood), fauxAssistantMessage("done")]);
  await first.session.prompt("flood the context");
  await first.settled();
  const carried = first.entries();
  const cwd = first.cwd;
  first.dispose();

  const second = await createHarness({ cwd, entries: carried, config: { pruneAtContextPercent: 100, pruneThresholdChars: 100_000_000 } });
  t.after(() => second.dispose());
  const shown: { sizes?: number[] } = {};
  second.faux.setResponses([recordResults(shown)]);
  await second.session.prompt("continue");
  assert.ok(shown.sizes!.slice(0, 3).every((n) => n <= 8000), `restart lost the edits: ${shown.sizes}`);
});

test("without pressure nothing is edited", async (t) => {
  const h = await createHarness({ config: { pruneAtContextPercent: 100, pruneThresholdChars: 100_000_000 } });
  t.after(() => h.dispose());
  const shown: { sizes?: number[] } = {};
  h.faux.setResponses([...Array.from({ length: 9 }, flood), recordResults(shown)]);
  await h.session.prompt("flood the context");
  await h.settled();
  assert.equal(edits(h).length, 0);
  assert.ok(shown.sizes!.every((n) => n >= 15_000));
});
