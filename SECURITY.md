# Security policy

Security fixes target the latest 0.1.x prerelease. This local alpha is not a multi-user or remote service.

A connected MCP client can queue agent work as your OS user inside configured roots. Connect only trusted clients. Worktrees separate code changes, but are not a security boundary. Native agent sandboxes and permission policies remain responsible for command/file access. Local Git operations disable hooks and fsmonitor; repository-configured Git filters can still execute during snapshot creation. Only dispatch trusted repositories.

The dispatcher removes API billing credentials/provider environment overrides from worker environments and verifies subscription authentication. It does not enable paid overage, purchase credits, consume earned reset credits or change subscriptions. Existing account extra-usage settings remain effective; disable them in your provider accounts before unattended use. Reserve checks are periodic and cannot guarantee a monetary or token cap.

Tasks, summaries and logs can contain sensitive source data. State/artifacts are owner-only but unencrypted. Input snapshots include non-ignored untracked files; ignore secrets before dispatching. Agent output and repository content are untrusted data and cannot expand task authorization. Codex/Claude workers receive empty MCP configuration. Cursor/Antigravity/OpenCode use macOS extension-file isolation, and OpenCode enforces Go-only provider and MCP/plugin policies. No worker uses a permission bypass; accidental recursion is blocked, not adversarial code trying to impersonate another client.

Cancellation can stop future local processing, but cannot retract work already done, inference already billed or queued chat messages. Provider-side operations cannot be rolled back by deleting a task. Uncertain delivery is never blindly retried.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Ameer-Jamal/agent-dispatcher/security/advisories/new). Include affected versions, a minimal reproduction and expected impact. Do not publish credentials, task logs or exploit details in a public issue.
