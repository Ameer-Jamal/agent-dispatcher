# Working on Agent Dispatcher

- Preserve one originating conversation, subscription-only authentication checks, deterministic routing and the Codex reserve.
- Keep the worker independent from MCP connections. Waiting and monitoring must never invoke a model.
- Never automatically replay uncertain execution or delivery. Persist intent before external effects and preserve evidence.
- Use isolated worktrees and temporary indexes; preserve staged/unstaged user changes. Do not merge or publish automatically.
- Keep worker MCP empty, native permission controls enabled, and subprocess arguments shell-free.
- Keep machine paths, credentials, account/chat IDs, state, task logs and artifacts out of source/package artifacts.
- Run `npm run check`, `npm run package:check`, `npm audit`, and `git diff --check` before sharing changes. Tests must use mocks and temporary state; live subscription smoke tests must be explicitly identified and bounded.
- Document limitations honestly: Claude account limits are unknown unless observed; notification acceptance is not model acknowledgement; reserves are best effort.
