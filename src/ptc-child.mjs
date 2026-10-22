// PTC child process (dsh ptc-runtime-node bootstrap analogue).
// Host sends {type:"run", runId, code, namespaces, prelude, persistent}.
// Binding calls go back as {type:"call", runId, callId, fn, args}; host replies
// {type:"call-result", callId, ok, value|error}. Completion: {type:"done", runId, ok, value, logs, error?}.
import vm from "node:vm";

class OutputLimitError extends Error {
  constructor() { super("program output exceeded the configured limit"); this.name = "OutputLimitError"; }
}

const pending = new Map();
let callSeq = 0;
let context = null;

function callHost(fn, args) {
  const callId = ++callSeq;
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    process.send({ type: "call", callId, fn, args });
  });
}

function makeNamespaces(namespaces) {
  const out = {};
  for (const [ns, fns] of Object.entries(namespaces)) {
    out[ns] = {};
    for (const fn of fns) out[ns][fn] = (args) => callHost(`${ns}.${fn}`, [args]);
  }
  return out;
}

const DECL_RE = /(^|[;\n])\s*(let|const|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const hasTopLevelAwait = (code) => /(^|[^.A-Za-z0-9_$])await\s/.test(code);

/** Persistent evaluation with declaration retention:
 * sync code runs directly in the context (V8 keeps let/const);
 * await code is rewritten so top-level declarations land on the context global. */
async function runPersistent(context, code) {
  if (!hasTopLevelAwait(code)) {
    // A top-level return needs a function body; it can still read persisted lexicals.
    if (/(^|[;\n])\s*return\s/.test(code)) return vm.runInContext(`(function () { ${code} })()`, context);
    return vm.runInContext(code, context);
  }
  const kinds = context.__lexicalKinds;
  const declared = new Map();
  for (const m of code.matchAll(DECL_RE)) declared.set(m[3], m[2]);
  for (const [name, kind] of declared) {
    if (kinds[name] && kind !== "var" && kind !== "function") {
      throw new SyntaxError(`Identifier '${name}' has already been declared`);
    }
  }
  const rewritten = code.replace(DECL_RE, (m, pre, kind, name, offset, whole) => {
    if (kind === "function") return `${pre}${name} = function ${name}`;
    if (kind === "class") return `${pre}${name} = class ${name}`;
    const next = whole.slice(offset + m.length).trimStart()[0];
    // The original "= initializer" text stays; only insert one when there is none.
    return next === "=" ? `${pre}${name}` : `${pre}${name} = undefined;`;
  });
  for (const [name, kind] of declared) kinds[name] = kind;
  return vm.runInContext(`(async () => { ${rewritten} })()`, context);
}

process.on("message", async (msg) => {
  if (msg.type === "call-result") {
    const p = pending.get(msg.callId);
    if (!p) return;
    pending.delete(msg.callId);
    if (msg.ok) p.resolve(msg.value);
    else { const e = new Error(msg.error); e.name = "ToolCallError"; p.reject(e); }
    return;
  }
  if (msg.type !== "run") return;
  const logs = [];
  const maxOutputBytes = Number.isSafeInteger(msg.maxOutputBytes) && msg.maxOutputBytes > 0 ? msg.maxOutputBytes : Infinity;
  let outputBytes = 2; // the empty logs array: []
  let overflowed = false;
  // Exceeding the cap stops retention at once, so a runaway loop cannot grow the heap; the throw ends a program that does not catch it.
  const record = (text) => {
    if (overflowed) throw new OutputLimitError();
    const cost = Buffer.byteLength(JSON.stringify(text)) + (logs.length > 0 ? 1 : 0);
    if (outputBytes + cost > maxOutputBytes) { overflowed = true; throw new OutputLimitError(); }
    outputBytes += cost;
    logs.push(text);
    // Streamed as well, so a program stopped by a timeout or abort still reports what it logged.
    process.send({ type: "log", runId: msg.runId, text });
  };
  const fakeConsole = {
    log: (...a) => record(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
    error: (...a) => record(a.map(String).join(" ")),
    warn: (...a) => record(a.map(String).join(" ")),
  };
  const ns = makeNamespaces(msg.namespaces ?? {});
  const outputLimit = () => process.send({
    type: "done", runId: msg.runId, ok: false, errorKind: "output-limit", logs,
    error: `outer output exceeded ${maxOutputBytes} bytes`,
  });
  try {
    let value;
    if (msg.persistent) {
      if (!context) context = vm.createContext({ console: fakeConsole, setTimeout, clearTimeout, __lexicalKinds: {}, ...ns });
      Object.assign(context, ns);
      context.console = fakeConsole;
      value = await runPersistent(context, `${msg.prelude ?? ""}\n${msg.code}`);
    } else {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const names = Object.keys(ns);
      const fn = new AsyncFunction("console", ...names, `${msg.prelude ?? ""}\n${msg.code}`);
      value = await fn(fakeConsole, ...names.map((n) => ns[n]));
    }
    if (overflowed) { outputLimit(); return; }
    const valueBytes = value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value) ?? "null");
    if (outputBytes + valueBytes > maxOutputBytes) { outputLimit(); return; }
    process.send({ type: "done", runId: msg.runId, ok: true, value: value === undefined ? null : value, logs, valueWasUndefined: value === undefined });
  } catch (err) {
    if (overflowed || err instanceof OutputLimitError) { outputLimit(); return; }
    process.send({ type: "done", runId: msg.runId, ok: false, error: err instanceof Error ? err.message : String(err), logs });
  }
});
