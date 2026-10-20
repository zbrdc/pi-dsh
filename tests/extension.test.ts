import test from "node:test";
import assert from "node:assert/strict";
import factory from "../src/index.ts";

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
