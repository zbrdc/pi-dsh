// Stand-ins for the real agent products, scripted by environment variables so the
// provider code can be tested without a model, a network or an account.
//   node fake-agents.mjs claude|codex|acp
//
//   FAKE_RECORD      file that receives {args, stdin, cwd, env} as JSON
//   FAKE_MODE        ok (default) | no-result | max-turns | empty | crash | turn-failed | hang | ignore-term
//   FAKE_ANSWER      the final answer text
//   FAKE_PID_FILE    file that receives this process id
//   FAKE_STDERR      text written to stderr (to prove it never reaches the model)
//   FAKE_PROBE_FILE  acp: path the agent tries to write while it handles a prompt
//   FAKE_PERMISSION  acp: 1 to ask permission before answering
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const kind = process.argv[2];
const mode = process.env.FAKE_MODE ?? "ok";
const answer = process.env.FAKE_ANSWER ?? "the answer";
const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (process.env.FAKE_STDERR) process.stderr.write(`${process.env.FAKE_STDERR}\n`);
if (mode === "ignore-term") process.on("SIGTERM", () => undefined);

function record(extra) {
  if (!process.env.FAKE_RECORD) return;
  const env = {};
  for (const name of Object.keys(process.env)) if (/^(FAKE_|PATH$|HOME$)/.test(name) || /TOKEN|KEY/.test(name)) env[name] = process.env[name];
  // Best effort: under a sandbox the record file may be outside the writable paths.
  try { appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ kind, args: process.argv.slice(3), cwd: process.cwd(), env, ...extra })}\n`); } catch { /* not writable */ }
}
const hang = () => setInterval(() => undefined, 1000);

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function claude() {
  const stdin = await readStdin();
  record({ stdin });
  emit({ type: "system", subtype: "init" });
  if (mode === "crash") process.exit(3);
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/work/a.txt" } }] } });
  if (mode === "hang" || mode === "ignore-term") { hang(); return; }
  if (mode === "no-result") return;
  if (mode === "max-turns") { emit({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many turns, secret path /private"] }); return; }
  emit({ type: "result", subtype: "success", is_error: false, result: mode === "empty" ? "  " : answer, num_turns: 1 });
}

async function codex() {
  const stdin = await readStdin();
  record({ stdin });
  const args = process.argv.slice(3);
  const outputFile = args[args.indexOf("-o") + 1];
  emit({ type: "thread.started", thread_id: "t1" });
  emit({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls -la" } });
  if (mode === "crash") process.exit(3);
  if (mode === "hang" || mode === "ignore-term") { hang(); return; }
  if (mode === "turn-failed") { emit({ type: "turn.failed", error: { message: "secret detail" } }); process.exit(1); }
  if (mode !== "no-result" && mode !== "empty") writeFileSync(outputFile, answer);
  emit({ type: "item.completed", item: { id: "i2", type: "agent_message", text: mode === "no-result" ? "from the event stream" : mode === "empty" ? "" : answer } });
  emit({ type: "turn.completed", usage: {} });
}

function acp() {
  let sessionId = "s-1";
  const send = (object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...object })}\n`);
  const reply = (id, result) => send({ id, result });
  const update = (content) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: content } } } });
  let outgoing = 100;
  const waiting = new Map();
  let cancelled = false;
  const finishPrompt = (id, stopReason) => reply(id, { stopReason });
  async function prompt(id, params) {
    record({ stdin: JSON.stringify(params.prompt) });
    if (process.env.FAKE_PROBE_FILE) {
      try { writeFileSync(process.env.FAKE_PROBE_FILE, "probe"); update("probe: wrote;"); } catch (error) { update(`probe: ${error.code};`); }
    }
    if (process.env.FAKE_PERMISSION === "1") {
      const requestId = outgoing++;
      const decided = new Promise((resolve) => waiting.set(requestId, resolve));
      send({ id: requestId, method: "session/request_permission", params: { sessionId, toolCall: { title: "run" }, options: [{ optionId: "no", name: "No", kind: "reject_once" }, { optionId: "yes", name: "Yes", kind: "allow_once" }] } });
      const outcome = await decided;
      update(`permission: ${JSON.stringify(outcome)};`);
    }
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Listing files", kind: "execute" } } });
    if (mode === "hang") { const timer = hang(); const check = setInterval(() => { if (cancelled) { clearInterval(check); clearInterval(timer); finishPrompt(id, "cancelled"); } }, 20); return; }
    if (mode === "ignore-term") { hang(); return; }
    update(mode === "empty" ? "" : answer);
    finishPrompt(id, mode === "max-tokens" ? "max_tokens" : "end_turn");
  }
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        record({ stdin: JSON.stringify(message.params) });
        if (mode === "crash") process.exit(4);
        reply(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      } else if (message.method === "session/new") {
        try { appendFileSync(process.env.FAKE_RECORD ?? "/dev/null", `${JSON.stringify({ kind, newSession: message.params })}\n`); } catch { /* not writable */ }
        if (mode === "no-session") reply(message.id, {}); else reply(message.id, { sessionId });
      } else if (message.method === "session/prompt") void prompt(message.id, message.params);
      else if (message.method === "session/cancel") cancelled = true;
      else if (message.id !== undefined && message.method === undefined && waiting.has(message.id)) waiting.get(message.id)(message.result?.outcome);
      else if (message.method === "fs/read_text_file") send({ id: message.id, error: { code: -32601, message: "no" } });
    }
  });
  process.stdin.on("end", () => { if (mode !== "ignore-term" && mode !== "hang") process.exit(0); });
}

if (kind === "claude") await claude();
else if (kind === "codex") await codex();
else acp();
