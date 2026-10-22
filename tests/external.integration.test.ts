import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, fauxAssistantMessage, fauxToolCall, scratchHome } from "./support/pi-session.ts";
import { makeRepo } from "./support/git-repo.ts";

const FAKE = new URL("./support/fake-agents.mjs", import.meta.url).pathname;
let seq = 0;

/** pi-dsh.json that routes claude-code to the fake product. */
function fakeClaude(env: Record<string, string> = {}) {
  const record = join(scratchHome, `ext-record-${++seq}.jsonl`);
  const config = { externalSubagents: { "claude-code": { command: process.execPath, args: [FAKE, "claude"], env: { FAKE_RECORD: record, ...env } } } };
  const records = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { config, records };
}

/** Faux step that records the pi-dsh notices the model is shown, then answers. */
function recordNotices(into: { seen?: string }) {
  return (context: { messages: any[] }) => {
    into.seen = context.messages.filter((m) => JSON.stringify(m.content).includes("[pi-dsh]") || JSON.stringify(m.content).includes("finished [status")).map((m) => JSON.stringify(m.content)).join("\n");
    return fauxAssistantMessage("noted");
  };
}

const toolResults = (h: Awaited<ReturnType<typeof createHarness>>, tool: string) =>
  h.events.filter((e) => e.type === "tool_execution_end" && e.toolName === tool).map((e) => ({ isError: e.isError === true, text: JSON.stringify(e.result) }));

test("an external subagent runs the task and its answer arrives as a completion notice", async (t) => {
  const fake = fakeClaude();
  const h = await createHarness({ config: fake.config });
  t.after(() => h.dispose());
  const shown: { seen?: string } = {};
  h.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("subagent_claude_code", { task: "review the parser", label: "review" })]),
    fauxAssistantMessage("started"), recordNotices(shown),
  ]);
  await h.session.prompt("delegate it");
  await h.waitForCalls(3, 10_000);
  await h.settled();
  assert.match(toolResults(h, "subagent_claude_code")[0]!.text, /started Claude Code subagent ext-claude-code-/);
  assert.match(shown.seen ?? "", /claude-code: review, depth 1\) finished \[status: completed\]/);
  assert.match(shown.seen ?? "", /the answer/);
  assert.equal(fake.records()[0].stdin, "review the parser");
});

test("the tool exists only for a configured provider", async (t) => {
  const none = await createHarness();
  t.after(() => none.dispose());
  assert.ok(!none.session.getActiveToolNames().some((n) => n.startsWith("subagent_claude") || n === "subagent_codex"));
  const some = await createHarness({ config: fakeClaude().config });
  t.after(() => some.dispose());
  assert.ok(some.session.getActiveToolNames().includes("subagent_claude_code"));
});

test("a failed run reports the safe diagnostic and nothing the product printed", async (t) => {
  const fake = fakeClaude({ FAKE_MODE: "crash", FAKE_STDERR: "PRIVATE-STDERR-DETAIL" });
  const h = await createHarness({ config: fake.config });
  t.after(() => h.dispose());
  const shown: { seen?: string } = {};
  h.faux.setResponses([fauxAssistantMessage([fauxToolCall("subagent_claude_code", { task: "x" })]), fauxAssistantMessage("started"), recordNotices(shown)]);
  await h.session.prompt("delegate it");
  await h.waitForCalls(3, 10_000);
  await h.settled();
  assert.match(shown.seen ?? "", /\[status: failed\]/);
  assert.match(shown.seen ?? "", /Product subagent failure \(product: Claude Code; stage: run; category: process; exit code: 3\)/);
  assert.doesNotMatch(shown.seen ?? "", /PRIVATE/);
});

test("an external subagent takes no follow-up message and interrupt stops it", async (t) => {
  const fake = fakeClaude({ FAKE_MODE: "hang" });
  const h = await createHarness({ config: fake.config });
  t.after(() => h.dispose());
  h.faux.setResponses([fauxAssistantMessage([fauxToolCall("subagent_claude_code", { task: "wait" })]), fauxAssistantMessage("started")]);
  await h.session.prompt("delegate it");
  await h.settled();
  const id = toolResults(h, "subagent_claude_code")[0]!.text.match(/(ext-claude-code-[0-9a-f-]+)/)![1]!;

  h.faux.setResponses([fauxAssistantMessage([fauxToolCall("send_message", { agent_id: id, message: "more" })]), fauxAssistantMessage("rejected")]);
  await h.session.prompt("send it a message");
  await h.settled();
  assert.match(toolResults(h, "send_message")[0]!.text, /does not accept follow-up messages/);

  h.faux.setResponses([fauxAssistantMessage([fauxToolCall("interrupt_agent", { agent_id: id })]), fauxAssistantMessage("interrupted"), fauxAssistantMessage("noted")]);
  await h.session.prompt("stop it");
  await h.settled(500);
  assert.equal(toolResults(h, "interrupt_agent")[0]!.isError, false, toolResults(h, "interrupt_agent")[0]!.text);

  h.faux.setResponses([fauxAssistantMessage([fauxToolCall("agent_status", { agent_id: id })]), fauxAssistantMessage("seen")]);
  await h.session.prompt("how is it");
  await h.settled();
  assert.match(toolResults(h, "agent_status")[0]!.text, /killed|interrupted/);
});

test("isolation=worktree runs the product in its own checkout and removes it when nothing changed", async (t) => {
  const { repo, root } = makeRepo();
  const fake = fakeClaude();
  const h = await createHarness({ config: fake.config, cwd: repo });
  t.after(() => h.dispose());
  h.faux.setResponses([fauxAssistantMessage([fauxToolCall("subagent_claude_code", { task: "look around", isolation: "worktree" })]), fauxAssistantMessage("started"), fauxAssistantMessage("noted")]);
  await h.session.prompt("delegate it");
  await h.waitForCalls(3, 10_000);
  await h.settled();
  const ran = fake.records()[0];
  assert.match(ran.cwd, /pi-dsh\/worktrees\//, "the product ran in the main checkout");
  assert.match(ran.stdin, /look around/);
  assert.equal(existsSync(ran.cwd), false, "an untouched worktree was kept");
  void root;
});

test("a misconfigured provider is reported at startup and gets no tool", async (t) => {
  const h = await createHarness({ config: { externalSubagents: { "claude-code": { command: process.execPath }, broken: { type: "gemini" } } } });
  t.after(() => h.dispose());
  assert.ok(h.session.getActiveToolNames().includes("subagent_claude_code"));
  assert.ok(!h.session.getActiveToolNames().includes("subagent_broken"));
  h.faux.setResponses([fauxAssistantMessage("hello")]);
  await h.session.prompt("hi");
  await h.settled();
  assert.match(h.customMessages("pi-dsh/notice").join("\n"), /externalSubagents\.broken: type must be one of/);
});
