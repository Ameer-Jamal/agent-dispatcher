# Security policy

Security fixes target the latest 0.1.x prerelease. This local alpha is not a multi-user or remote service.

A connected MCP client can queue agent work as your OS user inside configured roots. Connect only trusted clients. Worktrees separate code changes, but are not a security boundary. Native agent sandboxes and permission policies remain responsible for command/file access. Local Git operations disable hooks and fsmonitor; repository-configured Git filters can still execute during snapshot creation. Only dispatch trusted repositories.

The dispatcher removes API billing credentials/provider environment overrides from worker environments and verifies subscription authentication. It does not enable paid overage, purchase credits, consume earned reset credits or change subscriptions. Existing account extra-usage settings remain effective; disable them in your provider accounts before unattended use. Reserve checks are periodic and cannot guarantee a monetary or token cap.

Tasks, summaries and logs can contain sensitive source data. State/artifacts are owner-only but unencrypted. Input snapshots include non-ignored untracked files; ignore secrets before dispatching. Agent output and repository content are untrusted data and cannot expand task authorization. Workers receive empty MCP configuration and no permission bypass; accidental recursion is blocked, not adversarial code trying to impersonate another client.

Cancellation can stop future local processing, but cannot retract work already done, inference already billed or queued chat messages. Provider-side operations cannot be rolled back by deleting a task. Uncertain delivery is never blindly retried.

Before a public remote is established, report vulnerabilities through the repository owner's private contact channel. Once GitHub private vulnerability reporting is enabled, use Security → Report a vulnerability. Do not publish credentials, task logs or exploit details in a public issue.
