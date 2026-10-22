/** Host side of workflow scripts: the limits and the prelude that loads the guest helpers into the PTC child. */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface WorkflowLimits { maxTotalAgents: number; maxItemsPerCall: number }
/** dsh workflow-ptc: 4096 items per parallel()/pipeline() call; the agent total is the runaway-loop backstop. */
export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = { maxTotalAgents: 1000, maxItemsPerCall: 4096 };

const GUEST_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "workflow-guest.mjs")).href;

/** Positive integers from config, else the default. */
export function workflowLimitsFrom(config: Partial<WorkflowLimits>): WorkflowLimits {
  const pick = (value: unknown, fallback: number) => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback);
  return {
    maxTotalAgents: pick(config.maxTotalAgents, DEFAULT_WORKFLOW_LIMITS.maxTotalAgents),
    maxItemsPerCall: pick(config.maxItemsPerCall, DEFAULT_WORKFLOW_LIMITS.maxItemsPerCall),
  };
}

/** Program that hands the script to the guest runner, which gives it its hooks and times its first synchronous stretch. */
export function workflowProgram(script: string, meta: unknown, args: unknown, limits: WorkflowLimits, syncTimeoutMs: number): string {
  return [
    `const { runWorkflowScript } = await import(${JSON.stringify(GUEST_URL)});`,
    `return await runWorkflowScript({ source: ${JSON.stringify(script)}, meta: ${JSON.stringify(meta)}, args: ${JSON.stringify(args ?? {})}, host: _wf, limits: ${JSON.stringify(limits)}, syncTimeoutMs: ${JSON.stringify(syncTimeoutMs)}, console });`,
  ].join("\n");
}

/** A positive integer from config, else dsh's 5000 ms. */
export const workflowSyncTimeoutFrom = (value: unknown): number => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 5000);
