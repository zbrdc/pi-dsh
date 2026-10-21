/** Foreground bash for subagent children under a restrictive sandbox mode.
 * Pi's stock bash cannot run under bubblewrap, so without this tool a child
 * would escape a `read-only` or `workspace-write` standing mode that confines
 * the parent. Same runner and fail-closed probe as the parent's bash. */
import { Type } from "typebox";
import { fuseSignal, type SandboxMode } from "./core.ts";
import { runShellJob } from "./terminal.ts";

export interface ChildSandbox { mode: SandboxMode; runner?: string[] }

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
/** Keep the newest output when a command is chattier than this. */
const MAX_CAPTURE_CHARS = 1_000_000;

export const isRestrictive = (sandbox: ChildSandbox | undefined): sandbox is ChildSandbox =>
  sandbox !== undefined && sandbox.mode !== "danger-full-access";

export function createSandboxedBash(sandbox: ChildSandbox) {
  return {
    name: "bash", label: `Bash (${sandbox.mode})`,
    description: `Run a Bash command in a fresh shell confined by the ${sandbox.mode} sandbox (root read-only${sandbox.mode === "workspace-write" ? ", workspace writable" : ""}). State does not persist between calls. Fails closed when the sandbox runner is unavailable.`,
    promptSnippet: "Run a bash command (sandboxed)",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    async execute(_id: string, p: { command: string; timeout?: number }, signal: AbortSignal | undefined, _update: unknown, ctx: { cwd: string }) {
      const timeoutS = Math.min(Math.max(1, p.timeout ?? DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S);
      const fused = fuseSignal(signal, timeoutS * 1000);
      let output = "";
      const append = (chunk: string) => { output = (output + chunk).slice(-MAX_CAPTURE_CHARS); };
      const { exitCode } = await runShellJob({
        command: p.command, cwd: ctx.cwd, signal: fused as AbortSignal, append,
        sandboxMode: sandbox.mode, sandboxRunner: sandbox.runner,
      });
      if (signal?.aborted) throw new Error(`${output}\n[command aborted]`.trim());
      if (fused?.aborted) throw new Error(`${output}\n[command timed out after ${timeoutS}s]`.trim());
      // Pi's stock bash reports a non-zero exit as a failed tool result.
      if (exitCode !== 0) throw new Error(`${output}\n[exit code: ${exitCode}]`.trim());
      return { content: [{ type: "text" as const, text: output || "(no output)" }], details: {} };
    },
  };
}
