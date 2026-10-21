# Changelog

All notable changes to pi-dsh will be documented in this file.

## Unreleased

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
