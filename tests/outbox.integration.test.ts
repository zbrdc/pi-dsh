import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, fauxAssistantMessage, fauxToolCall } from "./support/pi-session.ts";

const BATCH = "pi-dsh/notices";
const startJobs = (seconds: number, count = 3) => Array.from({ length: count }, (_, i) =>
  fauxToolCall("bash", { command: `sleep ${seconds}`, description: `job ${i + 1}`, run_in_background: true }));
const jobMentions = (text: string) => text.match(/background job/g)?.length ?? 0;

/** Faux step that records the custom messages the model is shown, then answers. */
function recordContext(into: { seen?: string[] }, answer = "noted") {
  return (context: { messages: any[] }) => {
    into.seen = context.messages
      .filter((m) => m.role === "user" && JSON.stringify(m.content).includes("[pi-dsh]"))
      .map((m) => JSON.stringify(m.content));
    return fauxAssistantMessage(answer);
  };
}

test("a burst of notices during a run reaches the model as one message", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const shown: { seen?: string[] } = {};
  h.faux.setResponses([
    // Three background jobs end while the foreground command is still running.
    fauxAssistantMessage([...startJobs(0.1), fauxToolCall("bash", { command: "sleep 0.8" })]),
    recordContext(shown),
  ]);
  await h.session.prompt("start three jobs");
  await h.settled();
  assert.equal(h.faux.state.callCount, 2, "each notice cost its own request");
  const batches = h.customMessages(BATCH);
  assert.equal(batches.length, 1);
  assert.equal(jobMentions(batches[0]!), 3);
  assert.equal(shown.seen?.length, 1);
  assert.deepEqual(h.outbox(), []);
});

test("a burst while idle wakes the model once", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const shown: { seen?: string[] } = {};
  h.faux.setResponses([fauxAssistantMessage(startJobs(0.3)), fauxAssistantMessage("jobs started"), recordContext(shown)]);
  await h.session.prompt("start three jobs");
  await h.waitForCalls(3, 10_000);
  await h.settled();
  assert.equal(h.faux.state.callCount, 3, "each notice woke the model separately");
  assert.equal(jobMentions(h.customMessages(BATCH)[0] ?? ""), 3);
  assert.deepEqual(h.outbox(), []);
});

test("quiet delivery keeps notices for the next prompt", async (t) => {
  const h = await createHarness({ config: { completionDelivery: "quiet" } });
  t.after(() => h.dispose());
  const shown: { seen?: string[] } = {};
  h.faux.setResponses([fauxAssistantMessage(startJobs(0.2)), fauxAssistantMessage("jobs started"), recordContext(shown)]);
  await h.session.prompt("start three jobs");
  await h.until(() => h.outbox().length === 3);
  await h.settled(400);
  assert.equal(h.faux.state.callCount, 2, "quiet delivery woke the model");

  await h.session.prompt("what happened?");
  assert.equal(h.faux.state.callCount, 3);
  assert.equal(jobMentions(shown.seen?.join("") ?? ""), 3);
  assert.deepEqual(h.outbox(), []);
});

test("pending notices survive a restart and arrive with the first prompt", async (t) => {
  const first = await createHarness({ config: { completionDelivery: "quiet" } });
  first.faux.setResponses([fauxAssistantMessage(startJobs(0.2)), fauxAssistantMessage("jobs started")]);
  await first.session.prompt("start three jobs");
  await first.until(() => first.outbox().length === 3);
  const carried = first.entries();
  const cwd = first.cwd;
  first.dispose();

  const second = await createHarness({ cwd, entries: carried });
  t.after(() => second.dispose());
  assert.equal(second.faux.state.callCount, 0, "restoring woke the model");
  const shown: { seen?: string[] } = {};
  second.faux.setResponses([recordContext(shown)]);
  await second.session.prompt("continue");
  assert.equal(jobMentions(shown.seen?.join("") ?? ""), 3);
  assert.deepEqual(second.outbox(), []);
});

test("an aborted run does not wake itself, and its notices reach the next prompt", async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const shown: { seen?: string[] } = {};
  h.faux.setResponses([
    fauxAssistantMessage([...startJobs(0.1), fauxToolCall("bash", { command: "sleep 30" })]),
    fauxAssistantMessage("must not be requested after the abort"),
  ]);
  const run = h.session.prompt("start three jobs");
  await h.until(() => h.outbox().length === 3);
  await h.session.abort();
  await run;
  await h.settled(400);
  assert.equal(h.faux.state.callCount, 1, "the abort was followed by a model request");

  h.faux.setResponses([recordContext(shown)]);
  await h.session.prompt("what happened?");
  assert.equal(jobMentions(shown.seen?.join("") ?? ""), 3, "notices were lost with the aborted run");
});

test("/inbox drop removes a waiting notice before the model sees it", async (t) => {
  const h = await createHarness({ config: { completionDelivery: "quiet" } });
  t.after(() => h.dispose());
  const shown: { seen?: string[] } = {};
  h.faux.setResponses([fauxAssistantMessage(startJobs(0.2)), fauxAssistantMessage("jobs started"), recordContext(shown)]);
  await h.session.prompt("start three jobs");
  await h.until(() => h.outbox().length === 3);
  await h.session.prompt(`/inbox drop ${h.outbox()[0].id}`);
  assert.equal(h.outbox().length, 2);

  await h.session.prompt("what happened?");
  assert.equal(jobMentions(shown.seen?.join("") ?? ""), 2);
});
