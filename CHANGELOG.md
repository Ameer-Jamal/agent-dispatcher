# Changelog

## 0.1.0-alpha.2 — Unreleased

- Grant Antigravity native file reads and writes within each isolated worker checkout so headless reviews do not fail on `read_file`.
- Persist definitive Codex sign-in rejections (expired/invalid refresh token, 401 unauthorized) separately from transient errors; local login status cannot clear them, a fresh successful remote check can. Worker auth failures invalidate readiness and return a sanitized login action.
- Report provider readiness separately from dispatcher service liveness in `usage_status`, `status` and `doctor`.
- Allow OpenCode development commands unattended inside its OS write sandbox and give package managers private task-local caches.
- Verify offline dependency installation, lifecycle scripts and tests through a real OpenCode Go worker.

- Explicitly route routine test work, mechanical edits, dependency updates and bounded fixes through the OpenCode-first maintenance category.

- Support direct paired Muse chat on Mac through `muse-client`, with credential ownership locking and no browser dependency.

- Add an opt-in personal Muse request POC using the official paired Gadget CLI, with dedicated side chats, durable receipts, and no automatic replay.
- Install persistent native coordinator policies and MCP registration across five clients.
- Add bounded durable session/workspace recovery and Claude lifecycle context injection.
- Add a native subscription coordinator behavior smoke test; preserve worker recursion limits.

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
