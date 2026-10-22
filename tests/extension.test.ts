import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import factory from "../src/index.ts";

function makeHarness(mode: string, hasUI: boolean) {
  const handlers = new Map<string, any[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: Array<[string, unknown]> = [];
  const userMessages: Array<{ content: any; options: any }> = [];
  const widgets = new Map<string, any>();
  const statuses = new Map<string, any>();
  const pi: any = {
    on(event: string, handler: any) { const l = handlers.get(event) ?? []; l.push(handler); handlers.set(event, l); },
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    appendEntry(customType: string, data: unknown) { entries.push([customType, data]); },
    sendMessage() { /* recorded elsewhere when relevant */ },
    sendUserMessage(content: any, options: any) { userMessages.push({ content, options }); },
  };
  factory(pi);
  const ctx: any = {
    cwd: "/tmp", hasUI, mode,
    ui: {
      notify() { if (!hasUI) throw new Error("notify called without UI"); },
      setWidget(key: string, content: any) { widgets.set(key, content); },
      setStatus(key: string, text: any) { statuses.set(key, text); },
    },
    sessionManager: { getSessionId: () => `harness-${mode}`, getBranch: () => [], getSessionFile: () => undefined },
    isIdle: () => true, hasPendingMessages: () => false,
  };
  const emit = async (event: string, payload: any) => {
    let result;
    for (const h of handlers.get(event) ?? []) result = await h(payload, ctx);
    return result;
  };
  return { tools, commands, entries, userMessages, widgets, statuses, ctx, emit };
}

test("before_agent_start publishes control section and context refreshes changed state", async () => {
  const handlers = new Map<string, any[]>();
  const tools = new Map<string, any>();
  const entries: Array<[string, unknown]> = [];
  const pi: any = {
    on(event: string, handler: any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand() { /* unused */ },
    appendEntry(customType: string, data: unknown) { entries.push([customType, data]); },
    sendMessage() { /* reminders are tested in live runs */ },
    sendUserMessage() { /* goal driver is tested in live runs */ },
  };
  factory(pi);
  const ctx: any = {
    cwd: "/tmp",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "extension-test",
      getBranch: () => [],
      getSessionFile: () => undefined,
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  const emit = async (event: string, payload: any) => {
    let result;
    for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
    return result;
  };

  await emit("session_start", { type: "session_start", reason: "startup" });
  await emit("input", { type: "input", text: "work", source: "interactive" });
  await tools.get("create_goal").execute("1", { objective: "Finish the bounded drift fix" }, undefined, undefined, ctx);
  await tools.get("todo_write").execute("2", { todos: [{ content: "Patch structured capture", status: "in_progress" }] }, undefined, undefined, ctx);

  const startEvent: any = { type: "before_agent_start", messageType: "user", prompt: "continue", systemPrompt: "", systemPromptOptions: { sections: {} } };
  await emit("before_agent_start", startEvent);
  assert.match(startEvent.systemPromptOptions.sections.pi_dsh, /Finish the bounded drift fix/);
  assert.match(startEvent.systemPromptOptions.sections.pi_dsh, /Patch structured capture/);

  await tools.get("todo_write").execute("3", { todos: [{ content: "Run the full verification", status: "in_progress" }] }, undefined, undefined, ctx);
  const refreshed = await emit("context", { type: "context", messages: [{ role: "user", content: "continue", timestamp: 1 }] });
  assert.equal(refreshed.messages.length, 2);
  assert.equal(refreshed.messages[1].customType, "pi-dsh/control");
  assert.match(refreshed.messages[1].content[0].text, /Run the full verification/);
  assert.ok(entries.some(([name]) => name === "pi-dsh/goal"));

  await emit("session_compact", { type: "session_compact" });
  const afterCompaction = await emit("context", { type: "context", messages: [{ role: "user", content: "continue after compaction", timestamp: 2 }] });
  assert.equal(afterCompaction.messages.at(-1).customType, "pi-dsh/control");
});

test("widgets + status refresh across todo, goal, and background job", async () => {
  const h = makeHarness("tui", true);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.emit("input", { type: "input", text: "work", source: "interactive" });
  await h.tools.get("create_goal").execute("1", { objective: "Widget goal" }, undefined, undefined, h.ctx);
  await h.tools.get("todo_write").execute("2", { todos: [{ content: "Widget todo", status: "in_progress" }] }, undefined, undefined, h.ctx);
  const panel = () => h.widgets.get("pi-dsh-panel")().render(120).join("\n");
  assert.match(panel(), /Widget goal/);
  assert.match(panel(), /Widget todo/);
  assert.match(h.statuses.get("pi-dsh"), /goal active/);
  const started = await h.tools.get("bash").execute("3", { command: "sleep 30", run_in_background: true }, undefined, undefined, h.ctx);
  assert.match(started.content[0].text, /background job/);
  assert.match(panel(), /Jobs \(1 running\)/);
  const goalRow = h.widgets.get("pi-dsh-panel")().render(120).find((l: string) => l.includes("Widget goal"));
  assert.match(goalRow, /Todos/);
  assert.match(goalRow, /Jobs/);
  const jobId = started.content[0].text.match(/job (\S+)/)[1];
  await h.tools.get("job_kill").execute("4", { job_id: jobId }, undefined, undefined, h.ctx);
  assert.match(panel(), /Jobs \(0 running\)/);
  assert.equal(h.widgets.has("pi-dsh-goal"), false);
  await h.emit("session_shutdown", { type: "session_shutdown" });
});

test("widgets fall back to stacked string arrays outside the TUI", async () => {
  const h = makeHarness("rpc", true);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.emit("input", { type: "input", text: "work", source: "interactive" });
  await h.tools.get("create_goal").execute("1", { objective: "Widget goal" }, undefined, undefined, h.ctx);
  await h.tools.get("todo_write").execute("2", { todos: [{ content: "Widget todo", status: "in_progress" }] }, undefined, undefined, h.ctx);
  assert.match(h.widgets.get("pi-dsh-goal").join("\n"), /Widget goal/);
  assert.match(h.widgets.get("pi-dsh-todo").join("\n"), /Widget todo/);
  assert.equal(h.widgets.get("pi-dsh-jobs"), undefined);
  assert.equal(h.widgets.has("pi-dsh-panel"), false);
  await h.emit("session_shutdown", { type: "session_shutdown" });
});

test("standing rules persist, reach the model without a goal, and survive compaction and restore", async () => {
  const h = makeHarness("tui", true);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  const bad = await h.tools.get("rules_write").execute("1", { rules: ["ok", "  "] }, undefined, undefined, h.ctx);
  assert.equal(bad.isError, true);
  assert.deepEqual(h.entries.filter(([name]) => name === "pi-dsh/rules"), []);

  const ok = await h.tools.get("rules_write").execute("2", { rules: ["Never run reviewer children during a measurement window."] }, undefined, undefined, h.ctx);
  assert.match(ok.content[0].text, /1 active/);
  assert.deepEqual(h.entries.filter(([name]) => name === "pi-dsh/rules").at(-1)?.[1], ["Never run reviewer children during a measurement window."]);

  const inject = () => h.emit("context", { type: "context", messages: [{ role: "user", content: "go", timestamp: 1 }] });
  const first = await inject();
  assert.equal(first.messages.at(-1).customType, "pi-dsh/control");
  assert.match(first.messages.at(-1).content[0].text, /Never run reviewer children/);
  assert.equal(await inject(), undefined, "unchanged control section is not repeated");
  await h.emit("session_compact", { type: "session_compact" });
  assert.match((await inject()).messages.at(-1).content[0].text, /Never run reviewer children/);

  // A fresh session restores the list from the branch entries.
  const restored = makeHarness("tui", true);
  restored.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "pi-dsh/rules", data: ["Commit every green slice."] }];
  await restored.emit("session_start", { type: "session_start", reason: "resume" });
  const control = await restored.emit("context", { type: "context", messages: [{ role: "user", content: "go", timestamp: 1 }] });
  assert.match(control.messages.at(-1).content[0].text, /Commit every green slice/);

  await h.commands.get("rules").handler("clear", h.ctx);
  assert.deepEqual(h.entries.filter(([name]) => name === "pi-dsh/rules").at(-1)?.[1], []);
  await h.emit("session_shutdown", { type: "session_shutdown" });
  await restored.emit("session_shutdown", { type: "session_shutdown" });
});

test("/plan <task> in print mode: no UI calls, task delivered at before_agent_start", async () => {
  const h = makeHarness("print", false);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.commands.get("plan").handler("Design the drift ledger", h.ctx);
  assert.ok(h.entries.some(([name, data]: any) => name === "pi-dsh/plan" && data?.prompt === "Design the drift ledger"));
  assert.equal(h.userMessages.at(-1)?.options?.deliverAs, "followUp");
  const startEvent: any = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "", systemPromptOptions: { sections: {} } };
  const result = await h.emit("before_agent_start", startEvent);
  assert.match(result.message.content, /Plan task \(from \/plan\): Design the drift ledger/);
  // Delivered once: a second turn does not repeat the queued task.
  const again = await h.emit("before_agent_start", { ...startEvent, systemPromptOptions: { sections: {} } });
  assert.doesNotMatch(again.message.content, /Plan task/);
  // Headless exit_plan_mode cannot be approved (no dialog surface exists), so plan mode stays on.
  const exit = await h.tools.get("exit_plan_mode").execute("9", { plan: "# Plan" }, undefined, undefined, h.ctx);
  assert.equal(exit.isError, true);
  assert.match(exit.content[0].text, /no interactive UI/);
  assert.equal((h.entries.filter(([name]: any) => name === "pi-dsh/plan").at(-1)?.[1] as { active?: boolean } | undefined)?.active, true);
});

/** Drive one goal round to the point where the model is about to start its turn. */
async function requestRound(h: ReturnType<typeof makeHarness>, objective = "ship the fix") {
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.commands.get("goal").handler(objective, h.ctx);
  const boundary = await h.emit("agent_before_settle", { type: "agent_before_settle", outcome: "completed", continue: false, entries: [] });
  const draft = boundary.entries.at(-1);
  assert.equal(draft.customType, "pi-dsh/goal-round");
  return { draft, message: { role: "custom", customType: draft.customType, content: draft.content, display: true, details: draft.details, timestamp: 0 } };
}
const lastGoal = (h: ReturnType<typeof makeHarness>) => h.entries.filter(([name]) => name === "pi-dsh/goal").at(-1)?.[1] as any;
const withdrawals = (h: ReturnType<typeof makeHarness>) => h.entries.filter(([name]) => name === "pi-dsh/goal-withdrawn").map(([, data]) => data as any);

test("a goal round carries the identity it was requested under and counts when its turn starts", async () => {
  const h = makeHarness("tui", true);
  const { draft, message } = await requestRound(h);
  assert.deepEqual({ ...draft.details, goalId: typeof draft.details.goalId }, { goalId: "string", revision: 1, round: 1 });
  assert.equal(lastGoal(h).roundsStarted, 0, "the round counted before its turn started");
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
  assert.equal(lastGoal(h).roundsStarted, 1);
  assert.deepEqual(withdrawals(h), []);
  const context = await h.emit("context", { type: "context", messages: [message] });
  assert.equal(context?.messages?.[0]?.content ?? message.content, message.content, "a live round prompt was rewritten");
});

for (const [name, change, reason] of [
  ["cleared", async (h: ReturnType<typeof makeHarness>) => { await h.commands.get("goal").handler("clear", h.ctx); }, /cleared/],
  ["replaced", async (h: ReturnType<typeof makeHarness>) => { await h.commands.get("goal").handler("a different objective", h.ctx); }, /replaced/],
  ["paused", async (h: ReturnType<typeof makeHarness>) => { await h.commands.get("goal").handler("pause", h.ctx); }, /changed/],
  ["paused and resumed", async (h: ReturnType<typeof makeHarness>) => { await h.commands.get("goal").handler("pause", h.ctx); await h.commands.get("goal").handler("resume", h.ctx); }, /changed/],
] as const) {
  test(`a goal round requested before the goal was ${name} is withdrawn instead of started`, async () => {
    const h = makeHarness("tui", true);
    const { message } = await requestRound(h);
    await change(h);
    await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    assert.equal(withdrawals(h).length, 1);
    assert.match(withdrawals(h)[0].reason, reason);
    assert.notEqual(lastGoal(h)?.roundsStarted, 1, "a withdrawn round was counted");
    const context = await h.emit("context", { type: "context", messages: [message] });
    assert.match(context.messages[0].content[0].text, /^<goal_round_withdrawn>/);
    assert.doesNotMatch(JSON.stringify(context.messages[0]), /Continue working toward the objective/);
    // The stale round must not be mistaken for a round that never started.
    await h.emit("agent_settled", { type: "agent_settled", aborted: false });
    assert.notEqual(lastGoal(h)?.status, "blocked");
  });
}

test("a goal round is withdrawn when a message from the user is already waiting", async () => {
  const h = makeHarness("tui", true);
  const { message } = await requestRound(h);
  h.ctx.hasPendingMessages = () => true;
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
  assert.match(withdrawals(h)[0].reason, /waiting/);
  const context = await h.emit("context", { type: "context", messages: [message] });
  assert.match(context.messages[0].content[0].text, /^<goal_round_withdrawn>/);
});

test("a withdrawn round stays withdrawn after a restart", async () => {
  const first = makeHarness("tui", true);
  const { message } = await requestRound(first);
  await first.commands.get("goal").handler("clear", first.ctx);
  await first.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
  const stored = first.entries.map(([customType, data]) => ({ type: "custom", customType, data }));

  const restarted = makeHarness("tui", true);
  restarted.ctx.sessionManager.getBranch = () => stored;
  await restarted.emit("session_start", { type: "session_start", reason: "resume" });
  const context = await restarted.emit("context", { type: "context", messages: [message] });
  assert.match(context.messages[0].content[0].text, /^<goal_round_withdrawn>/);
});

test("tool_call caps timeout-shaped inputs on foreign tools", async () => {
  const h = makeHarness("tui", true);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  const event: any = { type: "tool_call", toolCallId: "c1", toolName: "web_fetch", input: { url: "x", timeout_ms: 9_999_999 } };
  await h.emit("tool_call", event);
  assert.equal(event.input.timeout_ms, 600_000);
});

test("dsh-compat manifest matches registered tools and commands", async () => {
  const h = makeHarness("tui", true);
  const manifest = JSON.parse(readFileSync(new URL("../dsh-compat.json", import.meta.url), "utf8"));
  assert.match(manifest.dsh.commit, /^[0-9a-f]{40}$/);
  for (const area of manifest.areas) {
    if (area.status === "not-ported" || area.status === "not-applicable") continue;
    for (const tool of area.piTools ?? []) assert.ok(h.tools.has(tool), `${area.area}: tool ${tool} registered`);
    for (const cmd of area.piCommands ?? []) assert.ok(h.commands.has(cmd), `${area.area}: command /${cmd} registered`);
  }
});

test("dsh-compat ledger lists known gaps for every area, and an unported area names at least one", () => {
  const manifest = JSON.parse(readFileSync(new URL("../dsh-compat.json", import.meta.url), "utf8"));
  for (const area of manifest.areas) {
    assert.ok(Array.isArray(area.gaps), `${area.area}: gaps must be an array (empty when there are none)`);
    for (const gap of area.gaps) assert.ok(typeof gap === "string" && gap.trim() !== "", `${area.area}: gap entries are non-empty strings`);
    if (area.status === "not-ported" || area.status === "partial") assert.ok(area.gaps.length > 0, `${area.area} is ${area.status} but lists no gap`);
  }
});

test("subagent v2 surface: model/preset/schema params, status and model tools, CAS team tools", async () => {
  const h = makeHarness("tui", true);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  for (const name of ["list_subagent_models", "agent_status", "subagent", "spawn_teammate", "wait_agent"]) assert.ok(h.tools.has(name), name);
  const delegateSchema = JSON.stringify(h.tools.get("subagent").parameters);
  for (const field of ["model", "thinking_level", "preset", "timeout_ms", "output_schema", "require_structured"]) assert.ok(delegateSchema.includes(`"${field}"`), field);
  const listSchema = JSON.stringify(h.tools.get("list_agents").parameters);
  assert.ok(listSchema.includes('"scope"'));
  // Team board CAS through the real tools.
  const created = await h.tools.get("team_task_create").execute("1", { subject: "Ship v2", writeScopes: ["src"] }, undefined, undefined, h.ctx);
  assert.match(created.content[0].text, /rev=1/);
  const taskId = created.content[0].text.match(/^(task-\d+)/)[1];
  const stale = await h.tools.get("team_task_update").execute("2", { task_id: taskId, revision: 99, action: "claim" }, undefined, undefined, h.ctx);
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /TEAM_TASK_STALE_REVISION/);
  const assigned = await h.tools.get("team_task_update").execute("3", { task_id: taskId, revision: 1, action: "assign", owner: "rev" }, undefined, undefined, h.ctx);
  assert.match(assigned.content[0].text, /@rev/);
  assert.match(assigned.content[0].text, /in_progress/);
  // wait_agent without a target reports noProgress when nothing runs.
  const noProgress = await h.tools.get("wait_agent").execute("4", {}, undefined, undefined, h.ctx);
  assert.match(noProgress.content[0].text, /noProgress/);
  // Unknown model route fails before any child starts.
  const badModel = await h.tools.get("subagent").execute("5", { task: "x", model: "nope/missing" }, undefined, undefined, h.ctx);
  assert.equal(badModel.isError, true);
  assert.match(badModel.content[0].text, /unknown subagent model route/);
});

test("delegation tools expose worktree isolation and pass it through to the manager", async () => {
  const h = makeHarness("tui", true);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  for (const name of ["subagent", "subagent_fork", "spawn_teammate"]) {
    assert.ok(JSON.stringify(h.tools.get(name).parameters).includes('"isolation"'), name);
  }
  // /tmp is not a git repository, so a request that reaches the manager is refused with the isolation error.
  for (const [name, args] of [["subagent", { task: "x" }], ["spawn_teammate", { name: "iso", task: "x" }]] as const) {
    const res = await h.tools.get(name).execute("1", { ...args, isolation: "worktree" }, undefined, undefined, h.ctx);
    assert.equal(res.isError, true, name);
    assert.match(res.content[0].text, /needs a git repository/, name);
  }
});
