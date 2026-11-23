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

`requiredAccess` is optional. Declare `connected_tools`, `external_credentials`, or `interactive_approval` if required to complete the worker task. The dispatcher rejects those requests before queueing. The originating session can handle that prerequisite and dispatch the independent local work. Headless workers cannot relay an interactive permission request, and commands can still be denied at runtime.

`get_task` accepts `taskId`, optional `acknowledge` and `origin`. Terminal statuses are `completed`, `failed`, `blocked`, `cancelled`, `interrupted` and `expired`; a Snooze file signal or channel notification means a result is ready, not that it succeeded. Receipt acknowledgement requires the matching origin, supplied automatically for a bound Claude channel. It returns compact state, routing reason, summary, session and artifact paths. Read artifacts only as needed. `list_tasks` accepts `limit` (1–100, default 20). `cancel_task` accepts `taskId`. `usage_status` reads cached usage and service health without inference or polling an agent. `workerHealthy` reports dispatcher service liveness; `providers` reports each worker's `ready` flag and `auth` state (`remote-verified`, `local-only`, `rejected`, `unavailable` or `disabled`), with a sanitized login `action` when sign-in is needed. `subscriptionAuthenticated` is retained and is false while a rejection is recorded. CLI `status` and `doctor` include the same `providers` field.

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
