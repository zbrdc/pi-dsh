import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runShellJob } from "../src/terminal.ts";
import type { SandboxMode } from "../src/core.ts";

const needsBwrap = { skip: !existsSync("/usr/bin/bwrap") && "bubblewrap unavailable" };

async function sandboxed(mode: SandboxMode, cwd: string, command: string): Promise<{ output: string; exitCode: number | null }> {
  let output = "";
  const { exitCode } = await runShellJob({ command, cwd, signal: new AbortController().signal, append: (t) => { output += t; }, sandboxMode: mode });
  return { output: output.trim(), exitCode };
}

/** The behaviour under test is how /tmp is treated, so these workspaces live in /tmp itself and are removed afterwards. */
async function inTmpWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync("/tmp/pi-dsh-sandbox-ws-");
  try { await run(workspace); } finally { rmSync(workspace, { recursive: true, force: true }); }
}

test("the sandbox's /tmp is private, not the host's", needsBwrap, async () => {
  const probe = `/tmp/pi-dsh-sandbox-probe-${process.pid}`;
  writeFileSync(probe, "host");
  try {
    await inTmpWorkspace(async (workspace) => {
      const seen = await sandboxed("read-only", workspace, `test -e ${probe} && echo visible || echo hidden`);
      assert.equal(seen.output, "hidden", "a host /tmp file leaked into the sandbox");
      const scratch = await sandboxed("read-only", workspace, "echo inside > /tmp/sandbox-only && cat /tmp/sandbox-only");
      assert.equal(scratch.output, "inside", "the private /tmp should be writable");
      assert.equal(existsSync("/tmp/sandbox-only"), false, "a write to the sandbox's /tmp reached the host");
    });
  } finally { rmSync(probe, { force: true }); }
});

test("the sandbox's /proc belongs to its own pid namespace", needsBwrap, async () => {
  await inTmpWorkspace(async (workspace) => {
    const r = await sandboxed("read-only", workspace, "ls /proc | grep -c '^[0-9]'");
    assert.ok(Number(r.output) < 30, `the sandbox sees ${r.output} processes; /proc is the host's`);
  });
});

test("a workspace under /tmp stays usable: readable when read-only, writable when workspace-write", needsBwrap, async () => {
  await inTmpWorkspace(async (workspace) => {
    writeFileSync(join(workspace, "in.txt"), "hello");
    const readable = await sandboxed("read-only", workspace, "cat in.txt");
    assert.equal(readable.output, "hello");
    const blocked = await sandboxed("read-only", workspace, "echo no > out.txt");
    assert.notEqual(blocked.exitCode, 0);
    assert.equal(existsSync(join(workspace, "out.txt")), false);
    const writable = await sandboxed("workspace-write", workspace, "echo yes > out.txt");
    assert.equal(writable.exitCode, 0);
    assert.equal(readFileSync(join(workspace, "out.txt"), "utf8").trim(), "yes");
  });
});

test("a workspace outside /tmp behaves the same", needsBwrap, async () => {
  const workspace = mkdtempSync(join(process.env["TMPDIR"] && !process.env["TMPDIR"].startsWith("/tmp") ? process.env["TMPDIR"] : process.cwd(), "sandbox-ws-"));
  try {
    writeFileSync(join(workspace, "in.txt"), "hello");
    assert.equal((await sandboxed("read-only", workspace, "cat in.txt")).output, "hello");
    assert.equal((await sandboxed("workspace-write", workspace, "echo yes > out.txt")).exitCode, 0);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
