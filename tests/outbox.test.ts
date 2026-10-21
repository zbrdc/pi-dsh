import test from "node:test";
import assert from "node:assert/strict";
import { BATCH_CUSTOM_TYPE, Outbox, renderBatch, runInboxCommand } from "../src/outbox.ts";

test("a single notice is delivered under its own type, unchanged", () => {
  const box = new Outbox();
  box.enqueue("pi-dsh/job-complete", "job j1 finished");
  const batch = box.take()!;
  assert.equal(batch.customType, "pi-dsh/job-complete");
  assert.equal(batch.content, "job j1 finished");
  assert.equal(box.size, 0);
});

test("several notices merge into one numbered message, oldest first", () => {
  const box = new Outbox();
  box.enqueue("pi-dsh/job-complete", "job j1 finished");
  box.enqueue("pi-dsh/subagent-complete", "subagent a1 finished");
  const batch = box.take()!;
  assert.equal(batch.customType, BATCH_CUSTOM_TYPE);
  assert.match(batch.content, /^\[pi-dsh\] 2 notices arrived:/);
  assert.ok(batch.content.indexOf("1. job j1") < batch.content.indexOf("2. subagent a1"));
});

test("take() on an empty outbox returns nothing", () => {
  assert.equal(new Outbox().take(), undefined);
});

test("a keyed notice replaces its undelivered predecessor", () => {
  const box = new Outbox();
  box.enqueue("pi-dsh/repeat-reminder", "seen 3 times", "repeat");
  box.enqueue("pi-dsh/job-complete", "job j1 finished");
  box.enqueue("pi-dsh/repeat-reminder", "seen 5 times", "repeat");
  assert.deepEqual(box.items().map((n) => n.content), ["job j1 finished", "seen 5 times"]);
});

test("a batch stops at the character cap but always takes one notice", () => {
  const box = new Outbox(100);
  box.enqueue("k", "a".repeat(60));
  box.enqueue("k", "b".repeat(60));
  box.enqueue("k", "c".repeat(150));
  assert.equal(box.take()!.notices.length, 1);
  assert.equal(box.take()!.notices.length, 1);
  assert.equal(box.take()!.notices.length, 1, "an oversized notice still goes out alone");
  assert.equal(box.size, 0);
});

test("restore keeps valid notices, drops malformed ones, and continues the id sequence", () => {
  const box = new Outbox();
  box.restore([{ id: "n7", kind: "k", content: "kept", at: 1 }, { id: 3 }, "junk", null]);
  assert.deepEqual(box.items().map((n) => n.id), ["n7"]);
  assert.equal(box.enqueue("k", "next").id, "n8");
  box.restore(undefined);
  assert.equal(box.size, 0);
});

test("snapshot is a copy: mutating it does not change the queue", () => {
  const box = new Outbox();
  box.enqueue("k", "x");
  box.snapshot()[0]!.content = "changed";
  assert.equal(box.items()[0]!.content, "x");
});

test("renderBatch of one notice reuses its kind", () => {
  const notice = { id: "n1", kind: "pi-dsh/goal", content: "blocked", at: 0 };
  assert.equal(renderBatch([notice]).customType, "pi-dsh/goal");
});

test("/inbox lists, shows, drops, clears and flushes", () => {
  const box = new Outbox();
  const now = 100_000;
  const a = box.enqueue("pi-dsh/job-complete", "job j1\nfinished", undefined, now - 30_000);
  box.enqueue("pi-dsh/agent-message", "hello from a1", undefined, now - 5_000);

  const list = runInboxCommand(box, "", now);
  assert.match(list.text, /Inbox \(2 waiting/);
  assert.match(list.text, new RegExp(`${a.id} \\[job-complete\\] 30s ago: job j1 finished`));
  assert.equal(list.changed, false);

  assert.equal(runInboxCommand(box, `show ${a.id}`, now).text, "job j1\nfinished");
  assert.match(runInboxCommand(box, "show nope", now).text, /No notice nope/);

  const dropped = runInboxCommand(box, `drop ${a.id}`, now);
  assert.deepEqual([dropped.text, dropped.changed], [`Dropped ${a.id}.`, true]);
  assert.equal(runInboxCommand(box, `drop ${a.id}`, now).changed, false);

  assert.deepEqual(runInboxCommand(box, "flush", now), { text: "Delivering 1 notice now.", changed: false, flush: true });
  assert.deepEqual(runInboxCommand(box, "clear", now), { text: "Cleared 1 notice.", changed: true, flush: false });
  assert.equal(runInboxCommand(box, "flush", now).flush, false);
  assert.match(runInboxCommand(box, "list", now).text, /Inbox empty/);
  assert.match(runInboxCommand(box, "bogus", now).text, /^Usage:/);
});
