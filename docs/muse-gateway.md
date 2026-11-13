# Dispatching from Muse through a Mac gateway

A separately installed Muse Mac gateway can expose this dispatcher at `http://TAILSCALE_IP:8765/mcp/agent-dispatcher`. The gateway uses its own bearer authentication and Tailscale binding. Gateway implementation, credentials and machine-specific connection details are not included in this package. Keep tokens in private files, never chat or command arguments.

## Task flow

1. Muse collects the goal, target repository, relevant files and acceptance criteria. It retrieves Jira or other external context through its own tools, because dispatcher workers have no MCP access.
2. Muse calls `dispatch_task` with the task and a stable gateway request UUID. The gateway owns dispatcher origin/idempotency scope.
3. Gateway deployment determines whether the action executes directly or requires a separate approval. Direct mode does not require a local review page. If approval mode is configured, follow its explicit review workflow; do not claim a task has started before it is accepted.
4. An accepted receipt supplies a task ID. Acceptance is not worker completion. Use the deployment's bounded `wait_task` or a supported background client wait instead of repeated model polling.
5. Muse reads the task summary and artifacts, reviews the incremental patch and acceptance evidence, then uses scoped `finish_task` when the deployment provides it. Applying acceptable work is separate from committing/pushing; publishing requires the user's authorization.
6. If further work is needed, Muse can dispatch another bounded task with the relevant prior evidence. Preserve conflicts and never replay uncertain actions automatically.

Gateway-owned reads, waits, cancellation and finishing must remain scoped to tasks accepted through that gateway. Muse cannot forge a Codex/Claude origin, borrow another conversation's idempotency key or acknowledge another chat's result. Do not expose the local unscoped recovery tool directly to remote clients; use the gateway's scoped task listing for recovery.

## Operational limits

- The Mac, gateway, Tailscale connection, native account authentication and dispatcher worker must remain available.
- A direct-mode gateway does not grant unrestricted worker permissions. Denials remain blocked results; remote worker approval/resume is not implemented.
- `usage_status` is read-only and invokes no inference. Some subscriptions report unknown remaining allowance.
- A configured wait is not unsolicited completion push. Automatic wake-up of a closed Muse conversation is not guaranteed.
- The gateway is not a general-purpose Mac command runner. See [workflows and boundaries](workflows.md).

## Verification boundary

The configured Mac gateway has synthetic coverage for action modes, durable idempotency, ownership, waits and conflict-preserving finishing. Authenticated live checks verify exposed schemas/status and server instructions without submitting real actions. This does not establish that a remote Muse runtime has refreshed its connector, installed persistent instructions or can wake automatically. Verify those properties in the actual client deployment.
