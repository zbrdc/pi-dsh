# pi-dsh

DeepSeek Harness (DSH) agent controls reimplemented for [Pi](https://pi.dev/) as one Pi package: goals, todos, plan mode, unified jobs, terminals, subagents, workflow, programmatic tool calls, guards, spill/pruning, and filesystem policy.

Pi-dsh is a semantic reimplementation for Pi APIs, not a line-by-line source port and not the DeepSeek Harness application itself. It is designed to be the single owner of those control surfaces in a Pi profile, so avoid running other extensions that simultaneously own todos, goals, jobs, subagents, or the `bash` tool.

> The project is called **pi-dsh**, but its npm package is **`pi-dsh-tools`** because the unscoped npm name `pi-dsh` is already used by an unrelated DSH provider extension.

## What it provides

| Area | Surface | Source package in dsh |
|---|---|---|
| Tasks | `todo_write`, `/plan`, `exit_plan_mode` | tool-todo, plan-mode |
| Goals | `create_goal`, `get_goal`, `update_goal`, `/goal`, round driver with reviewer audit gate | goal, goal-round-driver, tool-goal |
| Guards | repeat-call reminders (3/5/8), bash timeout cap, read-before-edit + stale-version FS policy, `read_image` | guard/*, fs-observation-policy, tool-fs |
| Context | spill to file + locator, tool-result pruner at compaction pressure | spill-policy, compaction-tool-result-pruner |
| Jobs | `job_output/list/kill`, owned `bash` (background promotion, bwrap sandbox + escalation approval), durable output files, completion wakes with caps | jobs, tool-jobs, tool-bash, sandbox-policy |
| Terminals | `terminal_open/send/read/list/close/signal/resize`, `bash_persistent`, `pwsh(_persistent)` when a binary exists | terminal, tool-terminal, tool-bash-persistent |
| Subagents | `subagent`, `subagent_fork` (explicit completed-turn seed), `send_message`, `interrupt_agent`, `list_agents`, required structured output, capacity 8/tree; teams: `spawn_teammate`, `wait_agent`, `team_task_*` | subagent, spawn/fork, experimental tool-agent-team |
| PTC | `run_code` with schema-typed SDK, 10-way sub-call scheduler, image results; Node (per-call/persistent REPL retaining declarations), Python, and mossbed backends | ptc-runtime(-node), ptc-runtime-python, dsh-tools PTC mode |
| Workflow | `workflow` (`agent`/`parallel`/`pipeline`/`phase`/`log`), background as a job | workflow-ptc, tool-workflow |

State (todos, plan, goal, subagent catalog, team tasks) persists as session custom entries and restores on the active branch. A standing `pi_dsh` system-prompt section carries the cross-tool operating rules plus a bounded snapshot of the current goal and unfinished todos; mid-run state changes are surfaced once as a hidden control refresh so they survive long turns and compaction boundaries. Job snapshots and output persist under `~/.pi/agent/pi-dsh/jobs/`; durable bash jobs write output/exit files under `<workspace>/.pi-dsh/jobs/`, keep running detached across a pi exit, and reconcile on restore (an exit file proves completion; missing evidence fails the job honestly). PTY sessions remain process-local.

Subagent children run through the pi SDK with no user-extension discovery, but they do load pi-dsh's inline child policy: the same read-before-edit/stale-version blocks, repeat-call reminders, spill, and old-tool-result pruning. Their system prompt includes the delegated-subagent contract, exact structured-output instruction when required, and a warning that inherited references to unavailable parent tools do not apply. Fork seeds only the parent's completed-turn prefix. Schema-led runs pass the exact output schema to `structured_output`; generic capture preserves sibling verdict fields beside an evidence object.

PTC backends: Node (default) runs model code in a child process, optionally under bubblewrap; Python (`backend: "python"`) runs statements in CPython (assign `result`, call `tools.<name>(dict)`); Mossbed (`backend: "mossbed"`) runs JS in the tardigrade sandbox. On every backend `tools.*` re-enters pi through `ctx.executeTool` (for mossbed, through a per-run loopback bridge granted to the guest by name only — the URL and token stay operator-side; results over ~900 KB exceed the net budget and must be narrowed). Persistent Node mode (`persistentPtc`) retains top-level declarations across calls; redeclarating a `const` fails.

Sandbox: `sandboxMode` is the standing mode for `bash` and Node `run_code` — `read-only` (root read-only), `workspace-write`, or `danger-full-access` (default, matching stock pi). A call may request a wider mode per call with `sandbox_permissions` plus a `justification`; widening requires interactive approval and is denied headless. Restricted modes require bubblewrap and fail loud without it.

PTY sessions use node-pty when `@lydell/node-pty` loads (resize and TUI input work), else util-linux `script` (no resize).

## Install

Install from npm after the first release is published:

```sh
pi install npm:pi-dsh-tools
```

Install from GitHub:

```sh
pi install git:github.com/zbrdc/pi-dsh
```

Install a local checkout:

```sh
pi install /path/to/pi-dsh
```

Restart Pi after installing or updating the package. Extension code runs locally with your user's permissions unless sandboxing is configured, so review the security notes below before enabling it in a trusted profile.

### Requirements

- Pi 1.3 or newer (developed and tested against Pi 1.3.0).
- Node.js 22.19 or newer for repository development and tests.
- Linux is the tested platform. Other Unix-like systems may work with reduced sandbox/PTY behavior; Windows is untested.
- Optional: bubblewrap for restricted sandbox modes, Python 3 for the Python `run_code` backend, Mossbed/tardigrade for the Mossbed backend, and util-linux `script` when the optional node-pty dependency is unavailable.

## Configuration

Optional config at `~/.pi/agent/pi-dsh.json` (defaults shown). A starter file is included as `pi-dsh.example.json`:

```json
{
  "allowParallelInProgress": true,
  "spillMaxInlineTokens": 12500,
  "pruneThresholdChars": 400000,
  "ptcOnly": false,
  "persistentPtc": false,
  "maxActiveSubagents": 8,
  "goalBlockedThreshold": 3,
  "sandboxMode": "danger-full-access",
  "maxParallelSubCalls": 10,
  "completionDelivery": "wakeup",
  "maxConsecutiveWakes": null
}
```

Set `ptcOnly: true` and disable pi codemode to make `run_code` the single transport (direct tools stay callable inside programs; model-only orchestrators stay declared). With codemode on, both transports are available.

Mossbed: set `MOSSBED_BIN` / `TARDIGRADE_BIN` or install at `~/.local/bin/mossbed` (see your tardigrade-runner installation). Ceilings stay operator-side in mossbed env vars; they are never tool arguments.

## Security

The default `sandboxMode` is `danger-full-access`, which matches stock Pi and means commands run with the current user's permissions. Set `sandboxMode` to `workspace-write` or `read-only` for bubblewrap confinement. Sandbox widening requires a model-supplied justification and interactive approval; it is denied without a UI.

Mossbed isolates pure JS/WASM compute, but its optional bridge intentionally lets guest code invoke host tools through Pi's normal tool pipeline. Treat Mossbed programs that use the bridge as tool-using agent code, not as fully untrusted isolated code.

## Known limits

- Foreign-tool deadlines cannot be hard-enforced from an extension; the timeout policy caps bash input and covers pi-dsh and nested calls via abort signals.
- Persistent PTC declarations in a `return`-style evaluation do not outlive that call (write declarations without `return` to keep them).
- `/plan <message>` follow-up is interactive-mode behavior; in `-p` print mode, activate with `/plan` in an existing session.
- External subagent providers (Claude Code, Codex, ACP) and `list_subagent_models` are not ported yet.
- `pwsh` tools register only when a pwsh binary exists.

## Development

```sh
npm install
npm run check
npm run pack:dry
```

`npm run check` runs TypeScript checking and the maintained Node test suite. Mossbed-specific tests skip when no mossbed binary is available; Python-specific tests require `python3`.

## License

MIT. See [LICENSE](LICENSE).
