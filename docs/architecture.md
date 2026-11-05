# Architecture

A stdio MCP process is a lightweight client of the local SQLite store. A separate LaunchAgent runs the scheduler. Each claimed job runs in a detached task runner so a client disconnect does not interrupt it. Only one runner/worker is allowed globally.

Task states are `queued → running → completed|failed|blocked|cancelled|interrupted`. SQLite stores input, routing, attempts, worker session IDs, process identities and artifact paths. Idempotency keys are unique across the state directory; reusing a key with a different input is an error.

The runner verifies subscription authentication, obtains cached/fresh Codex allowance, chooses a worker, snapshots the source checkout with a temporary Git index, and creates a detached worktree. Git hooks and fsmonitor are disabled for dispatcher Git operations. Worker tools use native sandbox/permission settings. Worker MCP configuration is empty and the worker environment rejects recursive dispatcher calls. This is an accidental-recursion guard, not an adversarial security boundary.

Each attempt produces bounded stdout/stderr evidence. A second attempt is allowed only after a known quota or availability failure, uses another eligible agent, and continues in the same isolated worktree. Unknown outcomes are never automatically repeated. Snapshot-relative binary patches include worker-created files while excluding pre-existing input edits. The dispatcher does not run arbitrary acceptance-check strings as host shell commands; they are requirements for the worker and coordinator.

## Durability and delivery

A terminal result is persisted in SQLite and written with atomic rename to `tasks/ID/result.json`. Recovery recreates a missing terminal file from SQLite. Snooze watches that file; its continuation names the task rather than embedding logs or full conversation history.

Delivery states are independent of execution: `pending`, `inbox`, `sending`, `queued`, `delivered`, `acknowledged`, `failed`, `unknown`. Snooze schedule acceptance does not mean a chat was notified. The scheduler inspects Snooze events to distinguish queued delivery; only a matching originating session can acknowledge receipt through `get_task`.

A Claude MCP channel instance is bound to the session UUID used by the launcher. It emits only that session's completion events. A task is marked `sending` before the notification crosses the process boundary; successful notification writes `delivered`. Transport acceptance does not prove the model read it; `acknowledged` does. Uncertain sends are not automatically repeated. Closed sessions retain pending results; resume the exact session with the launcher. Read an uncertain result explicitly with `get_task` rather than blindly resending it.

Process identity includes PID and OS start time. Recovery marks absent runners interrupted, retains artifacts and does not replay them. A live orphan worker prevents another worker from starting, including when its runner has died. Service shutdown does not intentionally kill active task runners. Cancellation signals the verified runner, which terminates its isolated worker process group and captures available changes.

## Usage and limits

Allowance observations are separate from agent/account pool names. Codex account inspection uses `initialize`, `account/read`, and `account/rateLimits/read`; no inference request is made. A global one-minute observation throttle includes pre/post-task checks and active reserve monitoring. Failed observations become unknown. The smallest headroom across reported windows governs automatic launch eligibility.

The reserve is best effort; account state can change between checks, and a single inference can consume more than expected. No per-task subscription token cap is promised. Claude has no integrated supported remaining-allowance endpoint in v1. Provider-side billing settings still apply.

## Retention

Artifacts and worktrees are retained for review and recovery. Before deleting an old task directory, remove its worktree using `git worktree remove /absolute/task/worktree` from the source repository. Never delete active task directories. SQLite and artifact directories are owner-only but not encrypted. There is no remote HTTP API or dashboard.
