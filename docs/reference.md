# Configuration and interfaces

Default state: `~/.local/share/agent-dispatcher`. Override with `AGENT_DISPATCHER_STATE` or `--state ABS_PATH`. Local `config.json` is owner-only. Use absolute executable paths when launchd PATH differs from your terminal.

See [example configuration](../examples/config.json). `setup --root PATH` adds allowed roots without deleting existing roots. An empty root list blocks dispatch. `agents.AGENT.pool` labels the actual account allowance pool, not a separate budget per model. V1 supports one account per agent; these labels prepare additional adapters without inventing independent allowances.

Configuration:

| Field                   | Default          | Purpose                                          |
| ----------------------- | ---------------- | ------------------------------------------------ |
| `reservePercent`        | 30               | Minimum Codex headroom for automatic workers     |
| `usageMaxAgeSeconds`    | 180              | Maximum age for automatic Codex eligibility      |
| `timeoutSeconds`        | 1800             | Per-attempt worker timeout, maximum 14400        |
| `maxOutputBytes`        | 2000000          | Combined stdout/stderr cap per attempt           |
| `allowedRoots`          | []               | Allowed parent directories of Git checkout roots |
| `agents.codex.command`  | codex            | Codex executable                                 |
| `agents.claude.command` | claude           | Claude executable                                |
| `agents.AGENT.model`    | CLI default      | Optional model pinned to an agent                |
| `agents.AGENT.pool`     | provider-primary | Account allowance pool label                     |
| `snooze.command`        | absent           | Snooze executable, often its virtualenv Python   |
| `snooze.args`           | []               | Prefix such as `-m snooze_mcp`; exclude `serve`  |
| `snooze.state`          | Snooze default   | Existing Snooze state directory                  |

## MCP tools

The optional personal Muse destination adds `muse_status`, `send_muse_request`
(`message`, `idempotencyKey`), and `get_muse_request` (`requestId`). It is disabled
by default. See [Muse setup and receipt semantics](muse.md), including the
paired Linux Gadget requirement and `muse.command`, `muse.args`,
`muse.waitSeconds`, and `muse.enabled` configuration fields.

`dispatch_task` accepts:

```json
{
  "goal": "Fix the failing parser case and run the existing parser tests",
  "cwd": "/absolute/path/to/repository",
  "files": ["src/parser.ts"],
  "acceptanceChecks": ["Existing parser tests pass"],
  "idempotencyKey": "parser-fix-001",
  "origin": {
    "client": "codex",
    "sessionId": "00000000-0000-4000-8000-000000000001"
  }
}
```

`files` and `acceptanceChecks` default to empty arrays. `taskType` accepts `implementation` (default), `investigation`, `review` or `maintenance`. `prefer` accepts `codex`, `claude`, `cursor`, `antigravity` or `opencode` and represents an explicit override. `model` requires `prefer`. `capabilityReason` explains an automatic Codex capability advantage; it does not bypass reserve checks. `deadlineSeconds` (60–86400, optional) is an end-to-end bound measured from submission that covers queue wait and every attempt. A task still queued at its deadline becomes terminal `expired` without launching a worker (its Codex delivery follows the same acknowledgement grace as any terminal result); a running attempt's timeout is clamped to the remaining time and ends `expired` with attempt artifacts and patch retained. If a runner overruns its deadline by more than 60 seconds the service marks it `expired` and stops it through the cancellation path. Omitting `deadlineSeconds` keeps the previous behavior: unbounded queue wait and the per-attempt `timeoutSeconds`. The coordinator policy asks coordinators to set 600 for investigation and review tasks. Omit `origin` only for inbox-only tasks. The Claude launcher supplies its bound origin automatically and rejects mismatches. Codex callers supply the exact originating chat UUID.

Codex delivery: the terminal `result.json` and the inbox entry are written immediately. The dispatcher then waits a fixed 45-second acknowledgement grace and registers a Snooze wake only if the result is still unacknowledged, so a chat that already read the result with `get_task` and `acknowledge:true` is not woken again. Registration is attempted at most once and never replayed when its outcome is uncertain. If acknowledgement lands while registration is in flight, the acknowledged state is kept and the new Snooze job is cancelled best-effort. Once Snooze has queued a wake into Codex it cannot be retracted, so a late acknowledgement can still be followed by a stale wake. Tasks that already hold a Snooze job ID from earlier versions keep that job and are reconciled as before. Generic Snooze jobs are unaffected.

`requiredAccess` is optional. Declare `connected_tools`, `external_credentials`, `interactive_approval`, `live_device` (attached hardware or a running simulator or app), `signed_in_cli`, `network_fetch`, `host_file`, or `host_process` if required to complete the worker task. These are coordinator-only: the dispatcher rejects them before queueing with an action for the originating session, which can handle that prerequisite and dispatch the independent local work. Headless workers cannot relay an interactive permission request, and commands can still be denied at runtime. Use the host-only types for checks that cannot be satisfied offline in the checkout. For dependencies, verify the locked version and pass just the required source excerpt or reviewed files.

### Worker prerequisites

`requiredFiles` (up to 50) and `requiredCommands` (up to 20) are optional. Omitting them, or passing empty arrays, keeps the previous behavior and idempotency.

- `requiredFiles` are checkout-relative files or directories. Before queueing, each must exist under `cwd`, must not be absolute, contain an escaping `..`, live under `.git`, or use a symlink or noncanonical path, and must be tracked or untracked-but-not-ignored so it reaches the worker snapshot. Ignored inputs (such as a local `.env`) and empty directories are rejected because the snapshot omits them. One bounded `git ls-files` call checks all declared paths with hooks and fsmonitor disabled.
- `requiredCommands` are bare executable basenames (letters, digits, `.`, `_`, `+`, `-`; no paths, spaces or arguments). The dispatcher only looks each one up as an executable regular file in absolute directories on the host `PATH` of the dispatcher process; it never runs it. A command found there is host availability only, not a promise that the worker's OS sandbox, network policy or native tool permissions will allow it.
- After the snapshot is created and before any worker starts, the runner re-checks both lists against the snapshot worktree and the service's own `PATH`, which can differ from the submitting session's. Drift ends the task `failed` with "no worker was started" and the missing names; resubmit with a new `idempotencyKey` once restored. Resubmitting an accepted `idempotencyKey` returns the existing task even if its prerequisites later drifted.
- Rejections name only the declared relative paths and basenames. There is no user-configured probe: the dispatcher does not run task-supplied commands, scripts, version checks or network checks as preflight, and does not widen any sandbox.

### Permission handoff

A genuine runtime permission block still ends with the existing `blocked` status, error text and every attempt artifact, so existing clients are unaffected. It additionally carries `needsInput` in `get_task`, `list_tasks` and `result.json`:

```json
{
  "kind": "permission",
  "source": "native_denial",
  "scopes": ["host"],
  "action": "review_denied_operation",
  "instruction": "…fixed text…",
  "attempt": 1,
  "attemptArtifact": "attempt-1.json"
}
```

- `source` is `native_denial` only when the provider's own output recorded a denied tool use (Claude `permission_denials`, Antigravity `denied_actions`, OpenCode tool permission errors); then `action` is `review_denied_operation`. Otherwise (a worker's own report or a generic sandbox error) it is `worker_report` with `action: inspect_attempt`, telling the coordinator to inspect the attempt artifact and ask the user only if a specific user action remains.
- `scopes` are coarse categories derived from the denied tool's name only: `workspace` (file tools), `host` (shell/command tools), `network` (web tools), `provider` (MCP, plugin or provider policy) or `unknown`. Tool input is never read for classification.
- Every field comes from a closed set or fixed text. Command bodies, absolute host paths, credentials and worker output never flow through `needsInput`; `attemptArtifact` is a file name inside the task's artifact directory. Read the artifact itself only as untrusted evidence.
- The dispatcher never approves, retries or replays the denied operation. Existing behavior is preserved: the single read-only review retry, a worker that recovered from a denial and confirmed completion stays `completed` without `needsInput` (`permissionDenialsObserved` remains true), deadlines and the Codex acknowledgement grace are unchanged. The Claude channel notification and the Codex Snooze instruction mention the handoff when present; channel `meta` adds `needs_input` and `needs_input_action`. Sign-in failures keep their login action and carry no `needsInput`.

`get_task` accepts `taskId`, optional `acknowledge` and `origin`. Terminal statuses are `completed`, `failed`, `blocked`, `cancelled`, `interrupted` and `expired`; a Snooze file signal or channel notification means a result is ready, not that it succeeded. Receipt acknowledgement requires the matching origin, supplied automatically for a bound Claude channel. It returns compact state, routing reason, summary, session and artifact paths. A true `permissionDenialsObserved` means the provider reported a denial at some point. A worker that completed after recovering from a denial can still return `completed`; the coordinating chat must verify the requested checks before accepting the result and can inspect the denial in the private attempt artifact. Read artifacts only as needed. `list_tasks` accepts `limit` (1–100, default 20). `cancel_task` accepts `taskId`. `usage_status` reads cached usage and service health without inference or polling an agent. `workerHealthy` reports dispatcher service liveness; `providers` reports each worker's `ready` flag and `auth` state (`remote-verified`, `local-only`, `rejected`, `unavailable` or `disabled`), with a sanitized login `action` when sign-in is needed. `subscriptionAuthenticated` is retained and is false while a rejection is recorded. CLI `status` and `doctor` include the same `providers` field.

## CLI

`recover_tasks` accepts an actual `origin` or exact `cwd`, plus optional `limit` (1–100, default 20). It returns active and unacknowledged work without relaunching or acknowledging it. Session filtering happens before limiting. Workspace discovery can include other conversations; inspect ownership before acting. `recover ABS_CWD` provides the same lookup through the CLI. See [native coordinator policy](coordinator-policy.md).

`dispatch FILE.json` uses the same task schema. `get`, `status`, `cancel`, `apply`, `doctor`, `enable`, `disable`, `register`, `unregister`, `worker`, `serve`, `claude` and `service` are described by `--help`.

`muse-status`, `muse-send REQUEST.json`, and `muse-get REQUEST_UUID` use the
separate personal Muse destination. They do not create coding-worker tasks.

`usage-set FILE.json` stores an **estimated**, never measured, observation:

```json
{
  "agent": "claude",
  "remainingPercent": 65,
  "note": "Manually checked account dashboard"
}
```

`resetsAt` and `blockedUntil` are Unix **milliseconds**. Clear a manual cooldown by setting `blockedUntil: 0`. A manual Codex estimate does not unlock automatic Codex dispatch; use a measured observation or explicit preference.

`get` returns the full local task record, including its goal. MCP tools return compact views. Task artifacts include `snapshot.json`, `attempt-N.json`, `changes.patch`, `changed-files.txt`, and terminal `result.json`.
