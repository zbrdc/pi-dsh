# Changelog

All notable changes to pi-dsh will be documented in this file.

## Unreleased

- External subagents: `externalSubagents` in `pi-dsh.json` adds `subagent_claude_code`, `subagent_codex`, and ACP tools that run a task as one unattended session of the installed product and return its final answer or a fixed-shape failure line (dsh subagent-claude-code, subagent-codex, subagent-acp). The product's environment is scrubbed of ambient credentials, stderr never reaches the model, and access is capped by the standing `sandboxMode`: Codex takes it as `--sandbox`, Claude Code gets an allowlist of file tools with no MCP servers or skills and `acceptEdits` under `workspace-write`, a wider setting is refused, and an ACP agent runs under bubblewrap with `writablePaths`. Run against the real Claude Code CLI (GLM via a Z.ai plan) and a real `opencode acp`; Codex only against the real binary with a local stand-in model server.
- **Sandbox fix:** `bwrapArgs` mounted `/proc`, `/dev` and `/tmp` before the read-only root bind, so the host root covered them. The sandbox saw the host's `/proc` under a new pid namespace (programs built on Bun segfaulted at startup) and its `/tmp` was not private. The root now goes first, the workspace is bound after `/tmp` so a workspace under `/tmp` stays visible, and the sandbox gets a fresh `/proc` and a private writable `/tmp`. Anything that relied on seeing host `/tmp` files from inside a `read-only` or `workspace-write` sandbox no longer can.
- Paths: pi-dsh's config and state follow `PI_CODING_AGENT_DIR` like Pi does; they were fixed to `~/.pi/agent`.
- Goals: each round prompt carries its goal id, revision and round, and at the next turn start it must still own the goal (not cleared, replaced, paused, edited, or already counted, and no message from you waiting) or it is withdrawn: the round is not counted and the model sees a stand-down notice instead of the stale prompt, also after a restart (dsh goal-round-driver fence). Goal ids are now unique per goal.
- PTC: a program stopped by a timeout, an abort, or a limit gets SIGTERM and then SIGKILL after `ptcGraceMs` (3000), and the logs it had already written come back with the failure instead of being lost. Applies to the Node and Python backends.
- Workflow: a script's first synchronous stretch, up to its first await, runs under `workflowSyncTimeoutMs` (5000, as in DSH), so a loop with no await ends the run with a clear error instead of holding the process until you abort.
- Subagents: the `subagentModels` allowlist now has tests and one shared check; it gates every explicit model choice (presets and workflow agents included) and never gates inheriting the parent's model.
- **Breaking:** `exit_plan_mode` no longer approves itself when there is no UI (print/json mode). Plan mode stays on, the tool reports that nobody can review the plan, and the model presents it as its reply; `/plan off` leaves plan mode. Interactive sessions are unchanged.
- Workflow: `pipeline` now sends each item through its own stage chain, so a slow item no longer holds up the others at a stage barrier, and a stage receives `(value, originalItem, index)`. `parallel` and `pipeline` used to turn every error into `null`; a bad argument, a non-function item, an unknown preset or model, a call over the item cap, or a tripped agent cap now ends the script, and only a failed child or an ordinary error inside one item is `null`. New caps `workflowMaxItemsPerCall` (4096) and `workflowMaxAgents` (1000). A script that ends early interrupts the children it started. The script runs under the standing `sandboxMode`; it used to run unconfined whatever the mode.
- PTC: the Python backend now runs under the same bubblewrap profile as Node. Before, `run_code` with `backend: "python"` ignored `sandboxMode`, so the model could pick it to leave a read-only sandbox. Node and Python programs are bounded by `ptcMaxOutputBytes`, `ptcMaxPendingCalls`, and `ptcMaxMessageBytes` (the DSH defaults), a crash reports its exit status and stderr tail, and the child's stdout is drained.
- Jobs: cancelling a shell job sends SIGTERM and kills the process group only after `jobKillGraceMs` (default 3000), so `git`, `docker`, and similar commands can release locks. A killed job records the reason, shown in `job_list`, `job_output`, and the completion notice.
- Ledger: every area in `dsh-compat.json` now lists its known `gaps`, and a test requires the field, so a "ported" area states what it lacks.
- API: `createPiDsh({ childModelRuntime })` is exported for hosts that own a model runtime and want subagents to share it; the default export is unchanged.

## 0.3.0 - 2026-10-21

- Goal driver: rounds are admitted at Pi's `agent_before_settle` boundary as a continuation of the running run, replacing the settled-time synthetic user message. Escape now stops the loop (an aborted round pauses the goal; an aborted human turn disarms it), `/goal pause` aborts the live turn, an errored run disarms the goal, and a round that never starts blocks it instead of staying half-counted. Human authority no longer carries from the starting prompt into later rounds.
- Subagents: children honor the standing `sandboxMode` (a confined foreground `bash` under `read-only`/`workspace-write`, fail-closed like the parent's); previously `read-only` did not constrain children. `structured_output` ends a child run with `terminate: true` instead of a 200 ms poll plus abort; a mixed tool batch closes at the turn boundary.
- Tests: integration suites run the extension inside a real Pi session against pi-ai's scripted faux provider (`tests/goal.integration.test.ts`, `tests/subagent.integration.test.ts`).
- Notices: job, subagent, agent-message, goal, and tool-timeout notices go through a durable outbox instead of one in-memory `sendMessage` each. Waiting notices are drained at `turn_end` / `agent_before_settle` as a single message (a burst of finished children costs one model request, not one each), an idle session is woken once per burst (`noticeCoalesceMs`, default 100), and quiet delivery, the wake cap, an aborted run, and a restart leave them queued until the next prompt. `/inbox` lists, shows, drops, clears, or flushes them, and the status line counts them.
- Bash: Escape now kills a foreground `bash` command; it used to wait for the command to finish, up to the 600 s cap.
- Subagents: `isolation: "worktree"` on `subagent`, `subagent_fork`, and `spawn_teammate` runs the child in its own git worktree and branch (started from HEAD). A worktree the child left untouched is removed when it settles; one with work is kept and the completion notice leads with its path, branch, change counts, and the review/merge/discard commands. A cold-resumed child gets its worktree back. Nothing is merged automatically. Under `workspace-write` the child can edit its worktree but cannot commit (the repository's `.git` stays read-only in the sandbox).
- Pruner: old oversized tool results and images are now shrunk by stored `context_edit` entries written at `turn_end` once Pi reports the context past `pruneAtContextPercent` (default 60; `pruneThresholdChars` is the fallback estimate while usage is unknown). Edits are permanent and idempotent, so they survive a restart and the prompt prefix changes only when a pass runs. The previous pruner rewrote the request through the `context` event on every call, so the oldest results flipped from full to pruned one by one as the window slid, and it serialized the whole message list each time to measure it. The `context` handler now only injects the control section.

- Standing rules: `rules_write` (whole-list replace, max 20 × 400 chars) and `/rules` persist durable user instructions as session entries and carry them in the control section, so they survive compaction by extractive compactors such as pi-vcc. A pi-dsh addition with no DSH tool equivalent.
- UI: goal, todos, jobs, and agents/terminals/team now share one side-by-side panel widget in the TUI (columns sized to content, wrapping into rows on narrow terminals) instead of four stacked widgets, leaving more room for output. RPC mode keeps the stacked string widgets. Declares `@earendil-works/pi-tui` as a peer dependency.
- Subagents in depth, modeled on DSH `dsh-subagent` + experimental agent-team:
  - Delegation depth budget (`maxSubagentDepth`, default 1): below the cap, children receive scoped `subagent`/`subagent_fork`/`send_message`/`interrupt_agent`/`list_agents` tools; direct parents receive completion steers.
  - Adjacent messaging both directions with sender framing and messageIds (child → parent/`lead`, parent → descendants, teammate → teammate); non-adjacent sends are rejected.
  - Per-child model routes (`model`, `list_subagent_models`, `subagentModels` allowlist), `thinking_level`, spawn presets (`subagentPresets`), `timeout_ms`/`subagentTimeoutMs` deadlines with stop reasons, and schema-led delegation from plain `subagent` (`output_schema`).
  - Descriptor-persisted catalog: settled results replay via `wait_agent` after restart and `send_message` cold-resumes from the saved child session.
  - `agent_status` (liveness, turns, tool calls, activity, latest text) and `list_agents` descendants scope. Workflow `agent()` queues through tree capacity and accepts model/preset/timeout options.
  - Teams reworked: permanent names with failed-provisioning records, fork teammates, and a durable CAS task board (`blockedBy` readiness, `writeScopes` overlap warnings, claim/release/assign lifecycle) exposed to teammates themselves. `wait_agent` can wait for the next team change.
  - Breaking: `team_task_update` now requires `action` + `revision` (compare-and-set) instead of free-form status/owner writes; `send_message`/`interrupt_agent`/`wait_agent` take `agent_id` (child id or teammate name).

## 0.2.0 - 2026-10-20

- Rich UI: goal, todo, jobs, and agents/terminals/team widgets plus a combined status line, refreshed on every state change; `/dsh` dashboard and `/todos`, `/jobs`, `/agents`, `/terminals` views with kill/close actions.
- Tool deadlines: timeout-shaped inputs capped on all tools, fused `AbortSignal` deadlines for nested PTC calls (`toolTimeoutMs` / `defaultToolTimeoutMs`), and a top-level watchdog that aborts and stamps `TOOL_TIMEOUT`.
- Durable terminals: `terminal_open` with `durable: true` (or `durableTerminals` config) runs in detached tmux, survives a Pi exit, and reattaches on restore. All terminals persist transcripts; dead ones restore as readable exited stubs.
- `/plan <task>` works in print/json mode: the task persists with plan state and is injected into the next turn; command feedback no longer assumes a UI.
- Drift tracking: `dsh-compat.json` pins the ported DSH commit (0.2.1-rc.2) per area; `npm run check:drift` lists upstream commits touching mapped packages since the pin.
- Sandbox: cached functional probe of the bubblewrap runner (fails closed) and `sandboxRunnerCommand` for a custom bwrap-compatible runner.

## 0.1.0 - Unreleased

Initial public release.

- DSH-style goals, todos, plan mode, repeat-call guards, spill, and tool-result pruning.
- Unified durable background jobs, job-aware bash, PTY terminals, and persistent shells.
- Parent-owned spawn/fork subagents, team tasks, structured results, and workflow fan-out.
- Programmatic tool calling through Node, Python, and Mossbed `run_code` backends.
- Bubblewrap sandbox modes with interactive escalation approval.
- Standing system-prompt task controls and child-session safety policies.

The npm package is named `pi-dsh-tools` because the unscoped npm name `pi-dsh`
is already used by an unrelated DeepSeek Harness provider extension.
