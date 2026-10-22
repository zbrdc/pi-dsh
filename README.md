# pi-dsh

DeepSeek Harness (DSH) agent controls reimplemented for [Pi](https://pi.dev/) as one Pi package: goals, todos, plan mode, unified jobs, terminals, subagents, workflow, programmatic tool calls, guards, spill/pruning, and filesystem policy.

Pi-dsh is a semantic reimplementation for Pi APIs, not a line-by-line source port and not the DeepSeek Harness application itself. It is designed to be the single owner of those control surfaces in a Pi profile, so avoid running other extensions that simultaneously own todos, goals, jobs, subagents, or the `bash` tool.

> The project is called **pi-dsh**, but its npm package is **`pi-dsh-tools`** because the unscoped npm name `pi-dsh` is already used by an unrelated DSH provider extension.

## What it provides

| Area | Surface | Source package in dsh |
|---|---|---|
| Tasks | `todo_write`, `/plan`, `exit_plan_mode` | tool-todo, plan-mode |
| Goals | `create_goal`, `get_goal`, `update_goal`, `/goal`, round driver (continues at Pi's settle boundary; abort pauses) with reviewer audit gate | goal, goal-round-driver, tool-goal |
| Inbox | completion and warning notices wait in a durable outbox (session entries), then reach the model as one coalesced message at the next step boundary, or as one wake-up when idle; `/inbox` (list, show, drop, clear, flush) | agent-loop inbox (closest) |
| Standing rules | `rules_write`, `/rules` — durable user instructions re-injected after every compaction (pi-dsh addition) | agent-instructions (closest) |
| Guards | repeat-call reminders (3/5/8), timeout input caps on all tools, per-tool deadlines (`toolTimeoutMs`): fused signals for nested calls, top-level watchdog → `TOOL_TIMEOUT`; read-before-edit + stale-version FS policy, `read_image` | guard/*, fs-observation-policy, tool-fs |
| Context | spill to file + locator; tool-result pruner that stores `context_edit` entries once the context passes `pruneAtContextPercent` (older oversized results cut to head and tail, images moved to disk; the newest six results stay whole) | spill-policy, compaction-tool-result-pruner |
| Jobs | `job_output/list/kill`, owned `bash` (background promotion, bwrap sandbox + escalation approval), durable output files, completion wakes with caps, SIGTERM-then-SIGKILL cancellation that records why | jobs, tool-jobs, tool-bash, sandbox-policy |
| Terminals | `terminal_open/send/read/list/close/signal/resize`, `bash_persistent`, `pwsh(_persistent)` when a binary exists; `durable: true` runs in detached tmux and reattaches after a Pi restart | terminal, tool-terminal, tool-bash-persistent |
| UI | widgets for goal, todos, jobs, agents/terminals/team + combined status line; `/dsh` dashboard, `/todos`, `/jobs` (kill), `/agents`, `/terminals` (close) | client/ui-goal, ui-jobs, ui-subagent, ui-plan |
| Subagents | `subagent`, `subagent_fork` (explicit completed-turn seed) with per-child `model`, `thinking_level`, `preset`, `timeout_ms`, `output_schema`; `send_message` (adjacent, both directions, messageIds), `interrupt_agent`, `list_agents` (children/descendants), `agent_status`, `list_subagent_models`; capacity 8/tree, depth cap (`maxSubagentDepth`), cold resume after restart, `isolation: "worktree"` (own git checkout and branch; an untouched one is removed when the child settles, otherwise the completion notice says how to review, merge, or discard it); teams: `spawn_teammate`, `wait_agent` (settle or next team change), CAS `team_task_*` board visible to teammates | subagent, spawn/fork, tool-subagent(-control), experimental agent-team |
| PTC | `run_code` with schema-typed SDK, 10-way sub-call scheduler, image results; Node (per-call/persistent REPL retaining declarations), Python, and mossbed backends | ptc-runtime(-node), ptc-runtime-python, dsh-tools PTC mode |
| Workflow | `workflow` (`agent`/`parallel`/`pipeline`/`phase`/`log`), background as a job | workflow-ptc, tool-workflow |

State (todos, plan, goal, subagent catalog, team tasks) persists as session custom entries and restores on the active branch. A standing `pi_dsh` system-prompt section carries the cross-tool operating rules plus a bounded snapshot of the current goal and unfinished todos; mid-run state changes are surfaced once as a hidden control refresh so they survive long turns and compaction boundaries. Job snapshots and output persist under `~/.pi/agent/pi-dsh/jobs/`; durable bash jobs write output/exit files under `<workspace>/.pi-dsh/jobs/`, keep running detached across a pi exit, and reconcile on restore (an exit file proves completion; missing evidence fails the job honestly). Terminal metadata and transcripts persist under `~/.pi/agent/pi-dsh/terminals/`: durable (tmux) terminals reattach live on restore, while non-durable PTYs restore as exited stubs whose transcripts stay readable — a dead shell's state cannot be resurrected.

Subagent children run through the pi SDK with no user-extension discovery, but they do load pi-dsh's inline child policy: the same read-before-edit/stale-version blocks, repeat-call reminders, spill, and old-tool-result pruning. Their system prompt includes the delegated-subagent contract, exact structured-output instruction when required, and a warning that inherited references to unavailable parent tools do not apply. Fork seeds only the parent's completed-turn prefix. Schema-led runs pass the exact output schema to `structured_output`; generic capture preserves sibling verdict fields beside an evidence object.

Subagents in depth: capacity is 8 live activations across the whole session tree (starts reject with `ACTIVATION_LIMIT_REACHED`; workflow `parallel()` queues through the same capacity instead of failing). Delegation depth is capped by `maxSubagentDepth` (default 1, as in DSH): below the cap, children receive their own scoped `subagent`/`subagent_fork`/`send_message`/`interrupt_agent`/`list_agents` tools, so raise the cap (e.g. 2–3) for hierarchical delegation. Messaging is adjacent — a child can reach its direct parent (or `"lead"`), its direct children, or any teammate — framed with sender attribution and a messageId, returning acceptance only. Each activation records a descriptor (parent, depth, role, model route, thinking level, preset, tools, session file, stored result) in the session catalog: after a Pi restart, settled children replay their stored result through `wait_agent` and cold-resume from their session file on `send_message`. `agent_status` reports liveness, elapsed time, turns, tool calls, recent activity, and latest text; `subagentTimeoutMs` or per-call `timeout_ms` aborts a child at its deadline (`stopReason: timeout`). Models are selected per child by `provider/modelId` route (discover via `list_subagent_models`; restrict with `subagentModels`), and `subagentPresets` in config define reusable spawn compositions (prompt append, builtin tool subset, model, thinking level) chosen per call with `preset`.

Teams (DSH experimental agent-team shape): `spawn_teammate` creates a permanently named teammate (fresh or forked; failed provisioning keeps the name as a `failed` roster entry). Teammates share the workspace and receive the same team tools as the lead, scoped to their identity: peer `send_message` by name, roster via `list_agents`, and the durable task board. Board tasks are versioned snapshots updated compare-and-set (`TEAM_TASK_STALE_REVISION` on a stale write), claimable only when their `blockedBy` dependencies are complete, with advisory `writeScopes` overlap warnings between in-progress tasks. `wait_agent` with no target waits for the next team change instead of polling. Only the lead spawns or interrupts teammates.

PTC backends: Node (default) runs model code in a child process, optionally under bubblewrap; Python (`backend: "python"`) runs statements in CPython (assign `result`, call `tools.<name>(dict)`); Mossbed (`backend: "mossbed"`) runs JS in the tardigrade sandbox. On every backend `tools.*` re-enters pi through `ctx.executeTool` (for mossbed, through a per-run loopback bridge granted to the guest by name only — the URL and token stay operator-side; results over ~900 KB exceed the net budget and must be narrowed). Persistent Node mode (`persistentPtc`) retains top-level declarations across calls; redeclarating a `const` fails. Programs are bounded as in DSH: combined logs plus return value may not exceed `ptcMaxOutputBytes` (64 MiB; the run fails with `output-limit` and a persistent process is dropped), no more than `ptcMaxPendingCalls` (128) binding calls may be in flight, and their arguments may not exceed `ptcMaxMessageBytes`. A crashed child reports its exit status and stderr tail. The Python backend runs under the same bubblewrap profile as Node, so the standing `sandboxMode` applies whichever backend is chosen.

Workflow scripts run under the standing `sandboxMode` and never get an escalation. `pipeline` sends each item through its own stage chain with no barrier between stages, and a stage receives `(value, originalItem, index)`. A failed child or an ordinary error inside one item makes that item `null`; a bad argument, an unknown preset or model, a call over `workflowMaxItemsPerCall` (4096), or an agent total over `workflowMaxAgents` (1000) ends the script with an error. A script that ends early (an error or Escape) interrupts the children it started.

Sandbox: `sandboxMode` is the standing mode for `bash`, Node `run_code`, and subagent children's `bash` — `read-only` (root read-only), `workspace-write`, or `danger-full-access` (default, matching stock pi). A call may request a wider mode per call with `sandbox_permissions` plus a `justification`; widening requires interactive approval and is denied headless. Restricted modes require bubblewrap (or a custom bwrap-compatible runner via `sandboxRunnerCommand`), are functionally probed once, and fail closed without a usable runner. DSH's SSH and Windows-ACL sandboxes are not applicable here: pi-dsh has no SSH transport to confine, and it is Linux-only (see `dsh-compat.json`).

Tool deadlines (DSH timeout-policy): set `toolTimeoutMs` per tool (and/or `defaultToolTimeoutMs`) in milliseconds. Nested calls through `run_code` get a real fused `AbortSignal` deadline. Top-level model-issued calls are watched: on deadline the turn is aborted (`toolTimeoutAction: "abort"`, default) or only announced (`"notify"`), and the result is stamped `TOOL_TIMEOUT` either way. Timeout-shaped inputs (`timeout`, `timeout_ms`, …) are capped at 600 s on every tool regardless. Tools with no configured limit are otherwise untouched.

PTY sessions use node-pty when `@lydell/node-pty` loads (resize and TUI input work), else util-linux `script` (no resize). Durable terminals use tmux (`resize-window`, `send-keys`, `pipe-pane` transcript).

UI: DSH ships web panels; a Pi extension can draw a footer status and string widgets. Pi-dsh uses those — goal, todos, jobs, and agents/terminals/team shown side by side in one panel (stacking only when the terminal is too narrow), refreshed on every state change — plus `/dsh` for a full dashboard. Set `uiWidgets: false` to disable.

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
- Optional: bubblewrap for restricted sandbox modes, tmux for durable terminals, Python 3 for the Python `run_code` backend, Mossbed/tardigrade for the Mossbed backend, and util-linux `script` when the optional node-pty dependency is unavailable.

## Configuration

Optional config at `~/.pi/agent/pi-dsh.json` (under `$PI_CODING_AGENT_DIR` when that is set) (defaults shown). A starter file is included as `pi-dsh.example.json`:

```json
{
  "allowParallelInProgress": true,
  "spillMaxInlineTokens": 12500,
  "pruneAtContextPercent": 60,
  "pruneThresholdChars": 400000,
  "ptcOnly": false,
  "persistentPtc": false,
  "maxActiveSubagents": 8,
  "goalBlockedThreshold": 3,
  "sandboxMode": "danger-full-access",
  "sandboxRunnerCommand": null,
  "maxParallelSubCalls": 10,
  "completionDelivery": "wakeup",
  "maxConsecutiveWakes": null,
  "noticeCoalesceMs": 100,
  "uiWidgets": true,
  "toolTimeoutMs": null,
  "defaultToolTimeoutMs": null,
  "toolTimeoutAction": "abort",
  "durableTerminals": false,
  "maxSubagentDepth": 1,
  "subagentTimeoutMs": null,
  "subagentModels": null,
  "subagentPresets": null,
  "maxTeamMembers": 16,
  "maxTeamTasks": 256,
  "jobKillGraceMs": 3000,
  "ptcGraceMs": 3000,
  "ptcMaxOutputBytes": 67108864,
  "ptcMaxPendingCalls": 128,
  "ptcMaxMessageBytes": 134217728,
  "workflowMaxAgents": 1000,
  "workflowMaxItemsPerCall": 4096,
  "workflowSyncTimeoutMs": 5000,
  "externalSubagents": null
}
```

### External subagents

`externalSubagents` delegates a task to another agent product. Each entry adds a `subagent_<name>` tool, and nothing is registered until you configure one, because these products run on their own account and credits:

```json
{
  "externalSubagents": {
    "claude-code": { "model": "sonnet", "permissionMode": "dontAsk" },
    "codex": { "permission": "never", "env": { "OPENAI_API_KEY": "..." } },
    "opencode": { "type": "acp", "command": "opencode", "args": ["acp"], "permission": "reject", "writablePaths": ["~/.local/share/opencode"] }
  }
}
```

A run is one unattended session in the workspace (as in DSH): the task goes in, and the final answer or a fixed-shape failure line such as `Product subagent failure (product: Codex; stage: run; category: process; exit code: 3)` comes back as a completion notice. Reasoning, tool traffic and stderr stay out of the session, the run accepts no follow-up input and cannot be resumed after a restart, and `agent_status`, `wait_agent`, `interrupt_agent`, `timeout_ms` and `isolation: "worktree"` work as for any child. Ambient variables whose names contain `KEY`, `PASSWORD`, `SECRET` or `TOKEN` are removed from the product's environment; put an API key in the entry's `env`, or log the product in beforehand.

Choosing a provider never widens access. Codex receives the standing `sandboxMode` as its own `--sandbox`. Under `read-only` and `workspace-write`, Claude Code is limited to file tools (`Read`, `Grep`, `Glob`, plus `Edit`, `Write` and `NotebookEdit` under `workspace-write`) with no command tools, no MCP servers and no skills, and `workspace-write` defaults its `permissionMode` to `acceptEdits` because `dontAsk` denies edits; under `danger-full-access` it runs with your own Claude Code settings, MCP servers and hooks. A setting wider than the sandbox (`bypassPermissions`, `auto`, `acceptEdits`, Codex `approve-for-me` or `dangerously-bypass-approvals-and-sandbox`) is refused before the product starts. An ACP agent has no sandbox of its own, so it runs under bubblewrap; list the directories it keeps state in under `writablePaths` (`~` expands, missing directories are created). ACP `permission` answers only the permission requests the agent chooses to make, so an agent that edits without asking is held back by the sandbox, not by `permission: "reject"`. Claude Code was exercised end to end against the real CLI (2.1.306) driven by GLM through a Z.ai plan, and the ACP path against a real `opencode acp`; Codex was exercised against the real binary with a local stand-in model server. Run one real task per product on your own account before relying on it.

Set `ptcOnly: true` and disable pi codemode to make `run_code` the single transport (direct tools stay callable inside programs; model-only orchestrators stay declared). With codemode on, both transports are available.

Mossbed: set `MOSSBED_BIN` / `TARDIGRADE_BIN` or install at `~/.local/bin/mossbed` (see your tardigrade-runner installation). Ceilings stay operator-side in mossbed env vars; they are never tool arguments.

## Security

The default `sandboxMode` is `danger-full-access`, which matches stock Pi and means commands run with the current user's permissions. Set `sandboxMode` to `workspace-write` or `read-only` for bubblewrap confinement. Sandbox widening requires a model-supplied justification and interactive approval; it is denied without a UI.

Mossbed isolates pure JS/WASM compute, but its optional bridge intentionally lets guest code invoke host tools through Pi's normal tool pipeline. Treat Mossbed programs that use the bridge as tool-using agent code, not as fully untrusted isolated code.

## Known limits

- Deadlines are cooperative, exactly as in DSH (its timeout-policy cannot hard-stop a tool that ignores `exec.signal` either). The remaining Pi-specific gap: an extension cannot swap the abort signal of a single model-issued foreign call, so a top-level watchdog abort ends the turn rather than only that call. Nested `run_code` calls do get per-call deadline signals.
- Non-durable PTY shells die with the Pi process; only their transcripts survive. Use `terminal_open` with `durable: true` (tmux) for terminals that must outlive Pi.
- In print/json mode there is no dialog surface: sandbox widening is denied and `exit_plan_mode` cannot be approved, so plan mode stays on, the model presents the plan as its reply, and the user leaves with `/plan off`. `/plan <task>` itself works — the task is persisted and injected into the next turn. Print mode also exits when the parent turn ends, so fire-and-forget subagents are aborted at shutdown unless the parent collects them with `wait_agent` (or runs them through `workflow`) before finishing; completion notices need a live (interactive) session.
- UI is status + text widgets and notify dashboards, not DSH's web panels. Pi's extension API has no richer persistent panel surface.
- Sandbox is bubblewrap(-compatible) only on Linux; DSH's Landlock fallback runner, SSH sandbox (no SSH transport exists here), and Windows ACL runner are not ported.
- Persistent PTC declarations in a `return`-style evaluation do not outlive that call (write declarations without `return` to keep them).
- External subagent providers (Claude Code, Codex, ACP) are opt-in through `externalSubagents` and have only been run against the real products on a small set of tasks; see External subagents. Pi children honor the standing `sandboxMode` through a confined foreground bash (no owned background jobs or per-call escalation inside children; under `danger-full-access` it is stock Pi bash), presets are pi-dsh config objects rather than full Pi profiles, and `interrupt_agent` waits for the turn to settle instead of returning on acceptance. Children share the workspace unless started with `isolation: "worktree"`; the board's write-scope warnings are advisory, as in DSH.
- `pwsh` tools register only when a pwsh binary exists.

## Development

```sh
npm install
npm run check
npm run pack:dry
```

`npm run check` runs TypeScript checking and the maintained Node test suite. Mossbed-specific tests skip when no mossbed binary is available; Python-specific tests require `python3`; the durable-terminal test skips without tmux.

Parity with DSH is tracked in `dsh-compat.json`, which pins the DSH commit this reimplementation was last reviewed against and records per-area status (`ported` / `partial` / `not-ported` / `not-applicable`). DSH is a developer preview with breaking changes, so re-check before each release:

```sh
npm run check:drift -- /path/to/deepseek-harness
```

The script verifies every mapped upstream package still exists and lists commits since the pin that touch mapped packages — that list is the porting review queue. After reviewing (and porting what applies), bump the pin with `--update-pin` and commit the manifest with the changes. A test also asserts every tool/command named in the manifest is actually registered.

## License

MIT. See [LICENSE](LICENSE).
