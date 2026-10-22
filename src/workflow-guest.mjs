import vm from "node:vm";

/** Workflow script helpers (dsh workflow-ptc guest).
 *
 * Imported by the prelude inside the PTC child, so this stays plain JavaScript:
 * a raw `node` child cannot load TypeScript from an installed package. The
 * combinators follow DSH's discipline. A failed child or an ordinary error in
 * one item becomes `null` for that item; a WorkflowError (a bad argument, a
 * tripped cap) is fatal and ends the script, so a typo cannot hide as `null`. */

/** Prefix the host puts on an error that must end the script instead of nulling one item. */
export const FATAL_MARKER = "[workflow-fatal] ";

export class WorkflowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

const isFatal = (error) => error instanceof WorkflowError;
const invalid = (message) => new WorkflowError(message, "INVALID_ARGUMENT");

/** Helpers for one run. `host` supplies agent/phase/log; `limits` is {maxTotalAgents, maxItemsPerCall}. */
export function createWorkflow(host, limits) {
  let started = 0;

  const assertItemCap = (hook, length) => {
    if (length > limits.maxItemsPerCall) {
      throw new WorkflowError(`${hook} received ${length} items, over the per-call cap (${limits.maxItemsPerCall}); split the work`, "ITEM_CAP");
    }
  };

  const asFunctions = (hook, thunks) => {
    if (!Array.isArray(thunks)) throw invalid(`${hook} requires an array of functions`);
    assertItemCap(hook, thunks.length);
    thunks.forEach((thunk, index) => {
      if (typeof thunk !== "function") throw invalid(`${hook} item ${index} is not a function`);
    });
  };

  /** Per-item containment: fatal errors escape, everything else becomes null. */
  const contained = async (run) => {
    try {
      return await run();
    } catch (error) {
      if (isFatal(error)) throw error;
      return null;
    }
  };

  async function agent(input, options) {
    const spec = typeof input === "string" ? { task: input, ...(options ?? {}) } : input;
    const prompt = spec !== null && typeof spec === "object" ? (spec.task ?? spec.prompt) : undefined;
    if (typeof prompt !== "string" || prompt.trim() === "") throw invalid("agent() needs a non-empty prompt string, or an object with task or prompt");
    if (++started > limits.maxTotalAgents) {
      throw new WorkflowError(`agent() call ${started} is over the per-run cap (${limits.maxTotalAgents}); a loop is probably running away`, "AGENT_CAP");
    }
    try {
      return await host.agent({ ...spec, task: prompt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(FATAL_MARKER)) throw invalid(message.slice(FATAL_MARKER.length));
      throw error;
    }
  }

  async function parallel(thunks) {
    asFunctions("parallel()", thunks);
    return Promise.all(thunks.map((thunk) => contained(thunk)));
  }

  /** Each item runs its own stage chain: no cross-stage barrier. A stage gets (value, original item, index). */
  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw invalid("pipeline() requires an items array");
    assertItemCap("pipeline()", items.length);
    if (stages.length === 0) throw invalid("pipeline() requires at least one stage function");
    stages.forEach((stage, index) => {
      if (typeof stage !== "function") throw invalid(`pipeline() stage ${index} is not a function`);
    });
    return Promise.all(items.map((item, index) => contained(async () => {
      let value = item;
      for (const stage of stages) value = await stage(value, item, index);
      return value;
    })));
  }

  const phase = (title) => {
    if (typeof title !== "string" || title === "") throw invalid("phase() requires a non-empty title string");
    return host.phase(title);
  };
  const log = (message) => {
    if (typeof message !== "string") throw invalid("log() requires a message string");
    return host.log(message);
  };

  return { agent, parallel, pipeline, phase, log };
}

/** Run a workflow script with its hooks in scope.
 *
 * The script's first synchronous stretch, up to its first await, runs under a V8 timeout (dsh syncTimeoutMs): a loop
 * with no await would otherwise hold the process until the run is aborted. Work after an await is bounded by the
 * run's own cancellation, as in DSH. `console` is the child's capturing console, so script logs reach the result. */
export async function runWorkflowScript({ source, meta, args, host, limits, syncTimeoutMs, console }) {
  const scope = { ...createWorkflow(host, limits), meta, args, console };
  // The script is invoked inside the timed evaluation, so the timeout covers its synchronous slice and not just compilation.
  const script = new vm.Script(
    `(async ({ agent, parallel, pipeline, phase, log, meta, args, console }) => {\n${source}\n})(globalThis.__workflowScope)`,
    { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  );
  globalThis.__workflowScope = scope;
  let running;
  try {
    running = script.runInThisContext({ timeout: syncTimeoutMs });
  } catch (error) {
    if (error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new WorkflowError(`the script ran for ${syncTimeoutMs} ms without reaching an await; a loop with no await cannot be stopped from outside`, "SYNC_TIMEOUT");
    }
    throw error;
  } finally {
    delete globalThis.__workflowScope;
  }
  return await running;
}
