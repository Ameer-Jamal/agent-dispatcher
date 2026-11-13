# Agent Dispatcher

[![CI](https://github.com/Ameer-Jamal/agent-dispatcher/actions/workflows/ci.yml/badge.svg)](https://github.com/Ameer-Jamal/agent-dispatcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![Minimal dispatch switchboard connecting one input to five geometric worker nodes, with queue blocks and a mint-and-amber capacity bar on charcoal.](docs/assets/agent-dispatcher-banner.png)

Keep one conversation. Send bounded work to a suitable subscription-backed coding agent, then bring its evidence and changes back to the original chat.

**Local alpha · macOS · Node.js 22.13+ · Codex, Claude Code, Cursor, Antigravity and OpenCode Go workers**

The dispatcher favors Claude for implementation, OpenCode Go for maintenance and Antigravity for reviews, while protecting a configurable 30% Codex allowance reserve. These are configurable starting preferences, not learned quality rankings. The queue, process monitoring and completion checks run in ordinary code; they do not spend model turns polling.

## Install

```sh
npm ci
npm run check
npm run package:check
npm link
agent-dispatcher setup --root /absolute/path/to/your/projects
agent-dispatcher doctor
agent-dispatcher register
agent-dispatcher service install
```

`setup` preserves existing settings and detects Snooze from the local Codex configuration when present. `register` adds MCP entries to Codex and Claude Code, backs up changed files, and preserves existing entries. Reconnect clients after registering. The MCP server supplies coordinator instructions; an inspectable copy is saved in the private state directory.

Sign in through `codex login` and `claude auth login`. `doctor` checks authentication and reads available Codex allowance; it does not run inference. Claude must report `authMethod: claude.ai`. API keys, API helper authentication and third-party billing routes are not accepted as subscription workers.

**Account billing:** the dispatcher never purchases credits, enables overage or switches to API billing. Existing provider-side extra-usage settings are outside its control. Disable extra usage/automatic reload in your provider accounts before unattended use. A reserve is a launch policy and periodic stop signal, not a guaranteed spend cap: usage observations can lag and one request can cross it.

## One conversation

In Codex, ask for work normally. The coordinator can dispatch a bounded task and wait for Snooze to notify the same chat. Snooze must be configured and its worker running for automatic Codex delivery. A task can still complete when notification delivery is unavailable; its result remains in the dispatcher inbox.

For Claude Code, start a channel-enabled session:

```sh
agent-dispatcher claude
# Reconnect later to the exact originating session:
agent-dispatcher claude --resume SESSION_UUID
```

The launcher enables a **custom development channel**, currently a Claude Code research preview. This is a channel-loading option, not a permission-bypass option. Ordinary Claude MCP registration supports submitting and reading tasks, but cannot itself push completion messages into an existing chat. Other Claude apps are outside v1.

Workers return a patch, their summary, check evidence and session ID. The originating agent reviews them, applies acceptable changes with `agent-dispatcher apply TASK_ID`, and responds where you started. There is no automatic merge or publication. `completed` means the worker reported success; the coordinator still verifies acceptance criteria.

## Personal Muse requests (POC)

An optional [Muse destination](docs/muse.md) sends explicit requests through a paired Mac `muse-client` connection or Meta's Linux Gadget CLI. It is disabled by default and separate from
coding workers. MCP adds `muse_status`, `send_muse_request`, and
`get_muse_request`; CLI adds `muse-status`, `muse-send`, and `muse-get`.
A reply does not prove reminder scheduling or phone notification delivery.
A live phone test arrived about one to two minutes late; timing is best effort.

## Additional workers

Existing configurations keep new workers disabled until you enable them:

```sh
agent-dispatcher enable antigravity
agent-dispatcher enable opencode
agent-dispatcher doctor
# After signing in and confirming accessible models:
agent-dispatcher enable cursor
# Disable a worker at any time:
agent-dispatcher disable cursor
```

Authentication and quota checks still run before launch. OpenCode is restricted to the `opencode-go/` provider, so it cannot consume the ChatGPT allowance or silently use console/API billing. The default maintenance model is `opencode-go/minimax-m3`; choose another Go model in private configuration if needed. Antigravity defaults to `Gemini 3.8 Flash (High)` and explicitly disables AI-credit overage for worker runs. Both defaults were present in the installed CLIs when verified.

Cursor requires a usable account, not merely a cached login: the dispatcher also checks `agent models`. Its adapter remains unavailable when the CLI returns no models. Worker permission controls remain enabled; `--force`, `--auto` and permission-bypass flags are not used to make tests pass.

Automatic completion delivery still targets Codex chats through Snooze and Claude Code through the channel launcher. The three additional agents are **workers**, not new conversation frontends. See [agent support and routing](docs/agents.md).

## Routing

- `taskType` chooses a configurable preference list: implementation/investigation prefer Claude; reviews prefer Antigravity; maintenance prefers OpenCode Go. Disabled, unauthenticated and exhausted workers are excluded. Cursor participates when enabled and accessible; Codex remains the protected final fallback.
- Codex requires fresh measured allowance above the reserve for automatic selection. A concrete capability advantage can select it ahead of Claude; it can also serve as an availability fallback.
- An explicit `prefer` overrides the reserve, but never disabled status, authentication, a known exhausted quota or a quota cooldown. A model override requires an explicit agent preference to avoid sending vendor-specific model names to another vendor.
- All reported Codex allowance windows contribute to the minimum remaining headroom. Unknown, stale or manually estimated Codex usage cannot authorize automatic Codex work.
- Automatic Codex workers are checked at most once per minute and stopped when a measured reserve threshold is reached. Your interactive conversation itself is not capped by this service.
- A classified quota/availability failure permits one fallback. Explicit worker preferences are pinned. Other failures are returned for assessment.
- Claude remaining allowance is marked unknown unless manually estimated. Observed quota failures impose a measured reset cooldown, or a conservative 30-minute cooldown when no reset is known. Subscription price is not treated as a usage measurement.

## Operations

```sh
agent-dispatcher status
agent-dispatcher get TASK_ID
agent-dispatcher cancel TASK_ID
agent-dispatcher service stop
agent-dispatcher service start
agent-dispatcher service uninstall
npm unlink -g @ameer-jamal/agent-dispatcher
```

Uninstalling the service retains configuration, results and MCP entries. Use `unregister` to remove only dispatcher entries that point at this installation. Keep the installation directory while a service or MCP entry references its built executable.

Each dispatch must target an allowed **Git repository root with an existing HEAD**. V1 rejects submodule repositories. Input snapshots include tracked changes and non-ignored untracked files, preserving the original index. Keep secrets ignored. Workers run in retained isolated worktrees, under the CLI's native permission controls. Permission denial returns a block.

See [configuration and tools](docs/reference.md), [architecture](docs/architecture.md), [troubleshooting](docs/troubleshooting.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md).
