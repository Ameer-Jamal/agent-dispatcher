# Changelog

## 0.1.0-alpha.2 — Unreleased

- Add an opt-in personal Muse request POC using the official paired Gadget CLI, with dedicated side chats, durable receipts, and no automatic replay.

- Add Cursor, Antigravity and OpenCode Go worker adapters, with explicit enable/disable controls.
- Add task-specific configurable routing while preserving the Codex reserve.
- Read Antigravity model-group quotas without inference; reject Cursor cached logins without accessible models.
- Pin OpenCode to its Go provider and isolate worker extensions/permissions.
- Preserve working directory identity through `PWD`; classify native permission denials as blocked.
- Verify live Antigravity/OpenCode Go execution and extend regression coverage.

## 0.1.0-alpha.1

- Local durable MCP dispatcher for Codex and Claude Code subscription workers.
- Deterministic routing, Codex allowance reserve, quota cooldowns and one controlled fallback.
- Dirty-checkout snapshots, isolated worktrees, incremental patches and retained attempt evidence.
- Snooze completion integration and session-bound Claude development channel.
- macOS service lifecycle, configuration-preserving setup and MCP registration.
- Isolated routing, recovery, worktree, process and MCP integration tests.
