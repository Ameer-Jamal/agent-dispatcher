# Dispatching from Muse through the existing gateway

The separately installed Muse Mac gateway can expose this dispatcher as a downstream MCP server at:

```text
http://TAILSCALE_IP:8765/mcp/agent-dispatcher
```

It uses the gateway's existing bearer authentication and verified local Tailscale bind. No new token or public tunnel is required. Keep tokens in their existing private files; never put them in chat or command-line arguments.

## Flow

1. Muse discusses the actual task and target with the user.
2. Muse submits `dispatch_task` with `goal`, an absolute repository-root `cwd`, optional `files`, `acceptanceChecks`, `taskType`, worker preferences, and a stable lowercase UUID `gateway_request_id`.
3. The gateway returns a pending receipt and opens its existing local Mac approval page. Nothing is dispatched before approval. The user reviews the exact task; Muse must not operate that page itself.
4. After review, Muse reads `gateway_write_status` for the same request UUID. A completed approval receipt contains the accepted dispatcher task ID. It does **not** mean the worker has finished.
5. Muse reads `get_task` with that task ID for execution status, summary and artifact paths. The task runs through the same isolated-worktree queue, routing, quota protection and native permissions as other submissions.

The gateway assigns its own idempotency key. Muse cannot supply a different chat origin or reuse another conversation's key. `get_task`, `list_tasks` and approval-gated `cancel_task` are restricted to the gateway's accepted submissions, including after a gateway restart. Remote task reads cannot acknowledge another chat's notification.

Workers leave patches for review. This endpoint exposes no apply, merge, publish or arbitrary command tool. `usage_status` is read-only and makes no inference calls. There is no automatic completion push into Muse; check sparingly when resuming the task rather than looping model turns while waiting.

## Verification boundary

Synthetic HTTP tests cover approval → one accepted dispatch → owned task read/list → approved cancellation, changed-argument rejection, cross-conversation isolation, forged approval rejection and durable ownership. Live checks inspect authenticated health, schemas and usage status only. No real Muse job was submitted or approved during gateway setup.

Muse still needs to refresh or connect to the new endpoint using its existing gateway client. The installed gateway handoff document contains machine-specific connection details; this repository intentionally does not include them.
