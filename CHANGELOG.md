# Changelog

All notable changes to pi-dsh will be documented in this file.

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
