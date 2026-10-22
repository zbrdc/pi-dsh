import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalFailure, claudeArgs, codexArgs, createExternalProvider, externalToolName, permissionOutcome, scrubbedEnv, type ExternalConfig } from "../src/external.ts";
import type { SandboxMode } from "../src/core.ts";

const FAKE = new URL("./support/fake-agents.mjs", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "pi-dsh-external-"));
// bubblewrap mounts a fresh tmpfs over /tmp, which would hide a /tmp workspace.
const sandboxable = existsSync("/usr/bin/bwrap") && !scratch.startsWith("/tmp/");
const needsSandbox = { skip: !sandboxable && "bubblewrap unavailable or scratch is under /tmp" };

let seq = 0;
/** Run one task through a provider backed by the fake product; returns the answer or the failure, plus what the product saw. */
async function runFake(kind: "claude-code" | "codex" | "acp", fake: "claude" | "codex" | "acp", opts: {
  cfg?: ExternalConfig; mode?: SandboxMode; fakeEnv?: Record<string, string>; task?: string; cwd?: string; signal?: AbortSignal;
  onActivity?: (name: string, detail: string) => void;
} = {}) {
  const record = join(scratch, `record-${++seq}.jsonl`);
  const cfg: ExternalConfig = { command: process.execPath, args: [FAKE, fake], ...opts.cfg, env: { FAKE_RECORD: record, ...opts.fakeEnv, ...opts.cfg?.env } };
  const provider = createExternalProvider(kind, cfg, { mode: opts.mode ?? "danger-full-access" });
  const controller = new AbortController();
  const settled = await provider.run({ task: opts.task ?? "do the thing", cwd: opts.cwd ?? scratch, signal: opts.signal ?? controller.signal, onActivity: opts.onActivity ?? (() => undefined) })
    .then((answer) => ({ answer, failure: undefined as ExternalFailure | undefined, error: undefined as Error | undefined }),
      (error: any) => ({ answer: undefined, failure: error instanceof ExternalFailure ? error : undefined, error: error as Error }));
  const seen = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { ...settled, seen, first: seen[0] };
}

test("tool names come from the provider name", () => {
  assert.equal(externalToolName("claude-code"), "subagent_claude_code");
  assert.equal(externalToolName("My ACP agent"), "subagent_my_acp_agent");
});

test("ambient credentials are scrubbed and ordinary variables kept", () => {
  const env = scrubbedEnv({ PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "k", GITHUB_TOKEN: "t", DB_PASSWORD: "p", MY_SECRET: "s", LANG: "C" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
});

test("the config picks the product by name or type, and rejects the rest", () => {
  assert.throws(() => createExternalProvider("nope", {}, { mode: "read-only" }), /type must be one of/);
  assert.throws(() => createExternalProvider("acp", {}, { mode: "read-only" }), /needs "command"/);
  assert.equal(createExternalProvider("review", { type: "codex" }, { mode: "read-only" }).product, "Codex");
});

// ---- Claude Code ----

test("claude: the task goes in on stdin and the final result comes back", async () => {
  const activity: string[] = [];
  const r = await runFake("claude-code", "claude", { task: "review src", onActivity: (n, d) => activity.push(`${n}:${d}`) });
  assert.equal(r.answer, "the answer", r.error?.message);
  assert.equal(r.first.stdin, "review src");
  assert.equal(r.first.cwd, scratch);
  for (const flag of ["-p", "--no-session-persistence", "--verbose", "--disallowed-tools", "AskUserQuestion"]) assert.ok(r.first.args.includes(flag), flag);
  assert.deepEqual(r.first.args.slice(r.first.args.indexOf("--output-format"), r.first.args.indexOf("--output-format") + 2), ["--output-format", "stream-json"]);
  assert.equal(r.first.args[r.first.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.deepEqual(activity, ['Read:{"file_path":"/work/a.txt"}']);
});

test("claude: ambient credentials never reach the product, configured ones do", async () => {
  process.env.FAKE_AMBIENT_TOKEN = "leak-me";
  try {
    const r = await runFake("claude-code", "claude", { cfg: { env: { FAKE_EXPLICIT_KEY: "given" } } });
    assert.equal(r.first.env.FAKE_AMBIENT_TOKEN, undefined);
    assert.equal(r.first.env.FAKE_EXPLICIT_KEY, "given");
    assert.ok(r.first.env.PATH);
  } finally { delete process.env.FAKE_AMBIENT_TOKEN; }
});

test("claude: the standing sandbox mode limits it to an allowlist of file tools, with no MCP servers or skills", () => {
  const argsFor = (mode: SandboxMode, cfg: ExternalConfig = {}) => claudeArgs(cfg, mode);
  const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  const readOnly = argsFor("read-only");
  assert.equal(valueOf(readOnly, "--tools"), "Read,Grep,Glob");
  assert.ok(readOnly.includes("--strict-mcp-config") && readOnly.includes("--disable-slash-commands"));
  const workspace = argsFor("workspace-write");
  assert.equal(valueOf(workspace, "--tools"), "Read,Grep,Glob,Edit,Write,NotebookEdit");
  assert.equal(valueOf(workspace, "--permission-mode"), "acceptEdits", "edits are denied under dontAsk");
  assert.equal(valueOf(argsFor("read-only"), "--permission-mode"), "dontAsk");
  assert.equal(valueOf(argsFor("danger-full-access"), "--permission-mode"), "dontAsk");
  assert.equal(valueOf(argsFor("workspace-write", { permissionMode: "dontAsk" }), "--permission-mode"), "dontAsk", "an explicit setting wins");
  assert.ok(!workspace.includes("Bash"));
  const open = argsFor("danger-full-access");
  assert.ok(!open.includes("--tools") && !open.includes("--strict-mcp-config"), "full access keeps the product's own tools and settings");
  assert.ok(!open.includes("--restricted"), "--restricted hides the file tools from the model");
  assert.deepEqual(argsFor("danger-full-access", { permissionMode: "plan" }).slice(-3), ["--disallowed-tools", "AskUserQuestion", "ExitPlanMode"]);
});

test("claude: a permission mode wider than the sandbox is refused before anything runs", async () => {
  assert.throws(() => claudeArgs({ permissionMode: "bypassPermissions" }, "workspace-write"), (e: any) => e instanceof ExternalFailure && /needs sandboxMode danger-full-access/.test(e.diagnostic));
  assert.throws(() => claudeArgs({ permissionMode: "acceptEdits" }, "read-only"), /needs sandboxMode workspace-write/);
  assert.throws(() => claudeArgs({ permissionMode: "auto" }, "workspace-write"), /needs sandboxMode danger-full-access/);
  assert.throws(() => claudeArgs({ permissionMode: "yolo" }, "danger-full-access"), /unknown permissionMode/);
  const r = await runFake("claude-code", "claude", { cfg: { permissionMode: "bypassPermissions" }, mode: "read-only" });
  assert.match(r.failure?.diagnostic ?? "", /stage: configuration/);
  assert.equal(r.seen.length, 0, "the product started anyway");
});

test("claude: model is passed through only when configured", async () => {
  const withModel = await runFake("claude-code", "claude", { cfg: { model: "opus" } });
  assert.equal(withModel.first.args[withModel.first.args.indexOf("--model") + 1], "opus");
  const without = await runFake("claude-code", "claude");
  assert.ok(!without.first.args.includes("--model"));
});

for (const [mode, category] of [["max-turns", "limit"], ["empty", "invalid-result"], ["no-result", "process"]] as const) {
  test(`claude: ${mode} fails with only safe facts (${category})`, async () => {
    const r = await runFake("claude-code", "claude", { fakeEnv: { FAKE_MODE: mode, FAKE_STDERR: "PRIVATE-STDERR-DETAIL" }, cfg: {} });
    const expected = mode === "no-result" ? "invalid-result" : category;
    assert.equal(r.failure?.diagnostic, `Product subagent failure (product: Claude Code; stage: run; category: ${expected}; exit code: 0)`);
    assert.doesNotMatch(r.failure?.message ?? "", /PRIVATE|secret|\/private/);
  });
}

test("claude: a crash reports the exit status", async () => {
  const r = await runFake("claude-code", "claude", { fakeEnv: { FAKE_MODE: "crash" } });
  assert.equal(r.failure?.diagnostic, "Product subagent failure (product: Claude Code; stage: run; category: process; exit code: 3)");
});

test("claude: a missing executable is reported as unavailable", async () => {
  const provider = createExternalProvider("claude-code", { command: "/nonexistent/claude-binary" }, { mode: "danger-full-access" });
  await assert.rejects(() => provider.run({ task: "x", cwd: scratch, signal: new AbortController().signal, onActivity: () => undefined }),
    (e: any) => e instanceof ExternalFailure && /stage: process; category: unavailable/.test(e.diagnostic));
});

test("claude: an abort stops the product and its process", async () => {
  const pidFile = join(scratch, "claude-hang.pid");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  const r = await runFake("claude-code", "claude", { fakeEnv: { FAKE_MODE: "hang", FAKE_PID_FILE: pidFile }, signal: controller.signal });
  assert.match(r.error?.message ?? "", /aborted/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the product is still running");
});

test("claude: a product that ignores SIGTERM is killed after the grace period", async () => {
  const pidFile = join(scratch, "claude-stubborn.pid");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  const r = await runFake("claude-code", "claude", { cfg: { graceMs: 400 }, fakeEnv: { FAKE_MODE: "ignore-term", FAKE_PID_FILE: pidFile }, signal: controller.signal });
  assert.match(r.error?.message ?? "", /aborted/);
  assert.ok(Date.now() - started >= 600, "killed before the grace period");
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), /ESRCH/);
});

// ---- Codex ----

test("codex: the standing sandbox mode becomes its own --sandbox, and the final message comes from the output file", async () => {
  const r = await runFake("codex", "codex", { mode: "workspace-write", task: "fix the bug" });
  assert.equal(r.answer, "the answer", r.error?.message);
  assert.equal(r.first.stdin, "fix the bug");
  const args: string[] = r.first.args;
  for (const flag of ["exec", "--json", "--ephemeral", "--skip-git-repo-check"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(args[args.indexOf("-C") + 1], scratch);
});

test("codex: the final agent message is the answer when the output file is empty", async () => {
  const r = await runFake("codex", "codex", { fakeEnv: { FAKE_MODE: "no-result" } });
  assert.equal(r.answer, "from the event stream");
});

test("codex: permissions that widen the sandbox are refused", () => {
  assert.throws(() => codexArgs({ permission: "approve-for-me" }, "read-only", "/w", "/o"), /needs sandboxMode workspace-write/);
  assert.throws(() => codexArgs({ permission: "dangerously-bypass-approvals-and-sandbox" }, "workspace-write", "/w", "/o"), /needs sandboxMode danger-full-access/);
  assert.throws(() => codexArgs({ permission: "whatever" }, "read-only", "/w", "/o"), /unknown permission/);
  const approve = codexArgs({ permission: "approve-for-me" }, "workspace-write", "/w", "/o");
  assert.ok(approve.includes("--approve-for-me") && !approve.includes("--sandbox"));
  assert.ok(codexArgs({ permission: "dangerously-bypass-approvals-and-sandbox" }, "danger-full-access", "/w", "/o").includes("--dangerously-bypass-approvals-and-sandbox"));
});

for (const [mode, expected] of [["turn-failed", "category: product-error; exit code: 1"], ["crash", "category: process; exit code: 3"], ["empty", "category: invalid-result; exit code: 0"]] as const) {
  test(`codex: ${mode} fails with only safe facts`, async () => {
    const r = await runFake("codex", "codex", { fakeEnv: { FAKE_MODE: mode, FAKE_STDERR: "PRIVATE-STDERR-DETAIL" } });
    assert.equal(r.failure?.diagnostic, `Product subagent failure (product: Codex; stage: run; ${expected})`);
    assert.doesNotMatch(r.failure?.message ?? "", /PRIVATE|secret/);
  });
}

test("codex: tool use shows up as activity", async () => {
  const activity: string[] = [];
  await runFake("codex", "codex", { onActivity: (n, d) => activity.push(`${n}:${d}`) });
  assert.deepEqual(activity, ["shell:ls -la"]);
});

// ---- ACP ----

test("acp: initialize, new session, prompt, and the streamed chunks become the answer", async () => {
  const activity: string[] = [];
  const r = await runFake("acp", "acp", { task: "summarise", onActivity: (n, d) => activity.push(`${n}:${d}`) });
  assert.equal(r.answer, "the answer", r.error?.message);
  const init = JSON.parse(r.seen.find((s) => s.stdin?.includes("protocolVersion"))!.stdin);
  assert.deepEqual(init, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const session = r.seen.find((s) => s.newSession)!.newSession;
  assert.deepEqual(session, { cwd: scratch, mcpServers: [] });
  assert.deepEqual(JSON.parse(r.seen.find((s) => s.stdin?.includes('"type":"text"'))!.stdin), [{ type: "text", text: "summarise" }]);
  assert.deepEqual(activity, ["execute:Listing files"]);
});

test("acp: permission prompts are rejected by default and approved only when configured", async () => {
  const rejected = await runFake("acp", "acp", { fakeEnv: { FAKE_PERMISSION: "1" } });
  assert.match(rejected.answer ?? "", /permission: \{"outcome":"cancelled"\}/);
  const allowed = await runFake("acp", "acp", { fakeEnv: { FAKE_PERMISSION: "1" }, cfg: { permission: "allow" } });
  assert.match(allowed.answer ?? "", /permission: \{"outcome":"selected","optionId":"yes"\}/);
  assert.deepEqual(permissionOutcome("allow", [{ optionId: "a", kind: "allow_always" }]), { outcome: "selected", optionId: "a" });
  assert.deepEqual(permissionOutcome("allow", [{ optionId: "r", kind: "reject_once" }]), { outcome: "cancelled" });
});

for (const [mode, expected] of [["max-tokens", "stage: prompt; category: limit"], ["empty", "stage: prompt; category: invalid-result"], ["no-session", "stage: new-session; category: invalid-result"]] as const) {
  test(`acp: ${mode} is a safe-fact failure`, async () => {
    const r = await runFake("acp", "acp", { fakeEnv: { FAKE_MODE: mode } });
    assert.equal(r.failure?.diagnostic, `Product subagent failure (product: ACP agent; ${expected})`);
  });
}

test("acp: an agent that dies during initialize is a process failure with its exit status", async () => {
  const r = await runFake("acp", "acp", { fakeEnv: { FAKE_MODE: "crash" } });
  assert.match(r.failure?.diagnostic ?? "", /stage: initialize; category: process; exit code: 4/);
});

test("acp: an abort sends session/cancel and stops the agent", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  const pidFile = join(scratch, "acp-hang.pid");
  const r = await runFake("acp", "acp", { fakeEnv: { FAKE_MODE: "hang", FAKE_PID_FILE: pidFile }, signal: controller.signal });
  assert.match(r.error?.message ?? "", /aborted/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), /ESRCH/);
});

test("acp: with no sandbox mode the agent can write the workspace", async () => {
  const probe = join(scratch, "acp-free.txt");
  const r = await runFake("acp", "acp", { fakeEnv: { FAKE_PROBE_FILE: probe } });
  assert.match(r.answer ?? "", /probe: wrote/);
  assert.equal(readFileSync(probe, "utf8"), "probe");
});

test("acp: a read-only sandbox confines the agent, a workspace-write one lets it write the workspace", needsSandbox, async () => {
  const workspace = mkdtempSync(join(scratch, "ws-"));
  const probe = join(workspace, "acp-probe.txt");
  const readOnly = await runFake("acp", "acp", { mode: "read-only", cwd: workspace, fakeEnv: { FAKE_PROBE_FILE: probe } });
  assert.match(readOnly.answer ?? "", /probe: EROFS|probe: EACCES/, readOnly.error?.message);
  assert.equal(existsSync(probe), false);
  const writable = await runFake("acp", "acp", { mode: "workspace-write", cwd: workspace, fakeEnv: { FAKE_PROBE_FILE: probe } });
  assert.match(writable.answer ?? "", /probe: wrote/, writable.error?.message);
  assert.equal(readFileSync(probe, "utf8"), "probe");
});

test("acp: writablePaths opens exactly the named extra directory under the sandbox", needsSandbox, async () => {
  const workspace = mkdtempSync(join(scratch, "ws-"));
  const state = mkdtempSync(join(scratch, "state-"));
  const inState = join(state, "agent-state.txt");
  const allowed = await runFake("acp", "acp", { mode: "read-only", cwd: workspace, cfg: { writablePaths: [state] }, fakeEnv: { FAKE_PROBE_FILE: inState } });
  assert.match(allowed.answer ?? "", /probe: wrote/, allowed.error?.message);
  assert.equal(readFileSync(inState, "utf8"), "probe");
});

test("acp: an unusable sandbox runner fails closed", async () => {
  const provider = createExternalProvider("acp", { command: process.execPath, args: [FAKE, "acp"] }, { mode: "read-only", runner: ["/nonexistent/runner"] });
  await assert.rejects(() => provider.run({ task: "x", cwd: scratch, signal: new AbortController().signal, onActivity: () => undefined }),
    (e: any) => e instanceof ExternalFailure && /category: sandbox-unavailable/.test(e.diagnostic));
});

test("acp: writablePaths expands ~ and creates a missing directory", needsSandbox, async () => {
  const home = mkdtempSync(join(scratch, "home-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { acpArgv } = await import("../src/external.ts");
    const argv = acpArgv({ command: "agent", writablePaths: ["~/.state/agent"] }, { mode: "read-only" }, scratch);
    const bound = join(homedir(), ".state/agent");
    assert.ok(existsSync(bound), "the state directory was not created");
    assert.ok(argv.join(" ").includes(`--bind ${bound} ${bound}`));
  } finally { process.env.HOME = savedHome; }
});
