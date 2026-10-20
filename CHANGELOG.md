# Changelog

All notable changes to pi-dsh will be documented in this file.

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
