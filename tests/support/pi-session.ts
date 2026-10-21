/** Real Pi runtime for integration tests: the SDK session loads the pi-dsh
 * extension and talks to pi-ai's scripted faux provider, so event ordering,
 * queues, aborts, and the settle boundary are Pi's own, not a fake's.
 *
 * Importing this module redirects HOME to a scratch directory; node --test runs
 * each test file in its own process, so the override never leaks. */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-dsh-it-"));
process.env.HOME = home;
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
const sdk = await import("@earendil-works/pi-coding-agent");
const { default: piDsh } = await import("../../src/index.ts");

export { fauxAssistantMessage, fauxText, fauxToolCall };
export const scratchHome = home;

export async function createFauxModelRuntime() {
  const faux = fauxProvider();
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("faux", "test-key");
  return { faux, modelRuntime };
}

export interface HarnessOptions { cwd?: string }

/** Session with the pi-dsh extension loaded and no other resources. */
export async function createHarness(options: HarnessOptions = {}) {
  const { faux, modelRuntime } = await createFauxModelRuntime();
  const cwd = options.cwd ?? mkdtempSync(join(home, "ws-"));
  const agentDir = join(home, ".pi", "agent");
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [piDsh as any],
  });
  await loader.reload();
  const { session } = await sdk.createAgentSession({
    cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime,
    resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd),
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  const events: any[] = [];
  session.subscribe((event: any) => { events.push(event); });
  const goalEntries = () => session.sessionManager.getBranch()
    .filter((e: any) => e.type === "custom" && e.customType === "pi-dsh/goal")
    .map((e: any) => e.data);
  return {
    session, faux, cwd, events,
    /** The latest persisted goal state, or undefined when none exists. */
    goal: () => goalEntries().at(-1) as any,
    /** Resolve once the faux provider has served `count` requests. */
    async waitForCalls(count: number, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (faux.state.callCount < count) {
        if (Date.now() > deadline) throw new Error(`faux provider served ${faux.state.callCount}/${count} requests`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    /** Resolve once the session is idle and the provider has been quiet for `quietMs`. */
    async settled(quietMs = 200, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      let last = -1;
      let quietSince = Date.now();
      while (Date.now() < deadline) {
        const calls = faux.state.callCount;
        if (calls !== last || !session.isIdle) { last = calls; quietSince = Date.now(); }
        else if (Date.now() - quietSince >= quietMs) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("session did not settle");
    },
    dispose: () => session.dispose(),
  };
}

/** Faux response that holds the request open until the run is aborted. */
export function blockUntilAborted() {
  return (_context: unknown, options: { signal?: AbortSignal } | undefined) => new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    const aborted = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
    if (options?.signal?.aborted) aborted();
    else options?.signal?.addEventListener("abort", aborted, { once: true });
  });
}
