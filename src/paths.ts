/** Where pi-dsh keeps its config and state: under Pi's agent directory, which PI_CODING_AGENT_DIR relocates. */
import { homedir } from "node:os";
import { join } from "node:path";

export function agentDir(): string {
  const configured = process.env["PI_CODING_AGENT_DIR"];
  if (!configured) return join(homedir(), ".pi", "agent");
  return configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured;
}

/** A path inside pi-dsh's own state directory, e.g. piDshDir("jobs"). */
export const piDshDir = (...parts: string[]): string => join(agentDir(), "pi-dsh", ...parts);
