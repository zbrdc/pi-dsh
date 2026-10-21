# Changelog

All notable changes to pi-dsh will be documented in this file.

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
