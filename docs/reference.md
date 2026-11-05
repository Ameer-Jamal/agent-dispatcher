# Configuration and interfaces

Default state: `~/.local/share/agent-dispatcher`. Override with `AGENT_DISPATCHER_STATE` or `--state ABS_PATH`. Local `config.json` is owner-only. Use absolute executable paths when launchd PATH differs from your terminal.

See [example configuration](../examples/config.json). `setup --root PATH` adds allowed roots without deleting existing roots. An empty root list blocks dispatch. `agents.AGENT.pool` labels the actual account allowance pool, not a separate budget per model. V1 supports one account per agent; these labels prepare additional adapters without inventing independent allowances.

Configuration:

| Field                   | Default          | Purpose                                          |
| ----------------------- | ---------------- | ------------------------------------------------ |
| `reservePercent`        | 30               | Minimum Codex headroom for automatic workers     |
| `usageMaxAgeSeconds`    | 180              | Maximum age for automatic Codex eligibility      |
| `timeoutSeconds`        | 1800             | Per-attempt worker deadline, maximum 14400       |
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

`files` and `acceptanceChecks` default to empty arrays. `taskType` accepts `implementation` (default), `investigation`, `review` or `maintenance`. `prefer` accepts `codex`, `claude`, `cursor`, `antigravity` or `opencode` and represents an explicit override. `model` requires `prefer`. `capabilityReason` explains an automatic Codex capability advantage; it does not bypass reserve checks. Omit `origin` only for inbox-only tasks. The Claude launcher supplies its bound origin automatically and rejects mismatches. Codex callers supply the exact originating chat UUID.

`get_task` accepts `taskId`, optional `acknowledge` and `origin`. Receipt acknowledgement requires the matching origin, supplied automatically for a bound Claude channel. It returns compact state, routing reason, summary, session and artifact paths. Read artifacts only as needed. `list_tasks` accepts `limit` (1–100, default 20). `cancel_task` accepts `taskId`. `usage_status` reads cached usage and service health without inference or polling an agent.

## CLI

`dispatch FILE.json` uses the same task schema. `get`, `status`, `cancel`, `apply`, `doctor`, `enable`, `disable`, `register`, `unregister`, `worker`, `serve`, `claude` and `service` are described by `--help`.

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
