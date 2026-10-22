export const FATAL_MARKER: string;
export class WorkflowError extends Error {
  code: string;
  constructor(message: string, code: string);
}
export interface WorkflowHost {
  agent(spec: Record<string, unknown>): Promise<unknown>;
  phase(title: string): Promise<unknown> | unknown;
  log(message: string): Promise<unknown> | unknown;
}
export interface WorkflowGuestLimits { maxTotalAgents: number; maxItemsPerCall: number }
export function createWorkflow(host: WorkflowHost, limits: WorkflowGuestLimits): {
  agent(input: string | Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  parallel(thunks: Array<() => unknown>): Promise<unknown[]>;
  pipeline(items: unknown[], ...stages: Array<(value: any, item: any, index: number) => unknown>): Promise<unknown[]>;
  phase(title: string): unknown;
  log(message: string): unknown;
};
export function runWorkflowScript(options: {
  source: string; meta: unknown; args: unknown; host: WorkflowHost; limits: WorkflowGuestLimits; syncTimeoutMs: number; console: unknown;
}): Promise<unknown>;
