import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentDir, piDshDir } from "../src/paths.ts";

const withAgentDir = (value: string | undefined, run: () => void) => {
  const saved = process.env["PI_CODING_AGENT_DIR"];
  if (value === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = value;
  try { run(); } finally { if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = saved; }
};

test("pi-dsh keeps its files under Pi's agent directory", () => {
  withAgentDir(undefined, () => assert.equal(agentDir(), join(homedir(), ".pi", "agent")));
  withAgentDir("/srv/pi-agent", () => {
    assert.equal(agentDir(), "/srv/pi-agent");
    assert.equal(piDshDir("jobs"), "/srv/pi-agent/pi-dsh/jobs");
  });
  withAgentDir("~/custom-agent", () => assert.equal(agentDir(), join(homedir(), "custom-agent")));
});
