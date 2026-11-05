# Agent support and routing

The originating conversation remains in Codex or Claude Code. All five adapters can work behind those coordinators; the three new adapters do not add automatic push delivery into Cursor, Antigravity or OpenCode conversations.

| Worker      | Authentication/billing                                                      | Usage evidence                                               | Default model           | Status at verification                       |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------- | -------------------------------------------- |
| Codex       | ChatGPT account                                                             | Measured allowance windows                                   | CLI default             | Live worker passed                           |
| Claude Code | Existing claude.ai Enterprise login                                         | Unknown remaining allowance; observed tokens/quota errors    | CLI default             | Live worker passed                           |
| Cursor      | Account login plus accessible models; API-key environment removed           | Unknown plan/allowance                                       | auto                    | Cached login had no models; disabled locally |
| Antigravity | Google account; API/ADC/gateway environment removed; extra credits disabled | Measured Gemini and Claude/GPT group windows                 | Gemini 3.8 Flash (High) | Live worker passed                           |
| OpenCode    | Saved Go credential; only opencode-go provider allowed                      | Unknown remaining Go allowance; observed tokens/quota errors | opencode-go/minimax-m3  | Live worker passed                           |

OpenCode's saved OpenAI connection is deliberately excluded. Antigravity's Claude/GPT quota belongs to Antigravity's subscription pool rather than the standalone Claude/Codex account pools. Never count multiple tools connected to one account as independent allowance.

## Configurable defaults

| Task type      | Preference order                             |
| -------------- | -------------------------------------------- |
| implementation | Claude, Cursor, Antigravity, OpenCode, Codex |
| investigation  | Claude, Antigravity, Cursor, OpenCode, Codex |
| review         | Antigravity, Claude, Cursor, OpenCode, Codex |
| maintenance    | OpenCode, Claude, Antigravity, Cursor, Codex |

These are provisional capability preferences, not benchmark claims or a goal to consume all subscriptions. Authentication, enabled status, quota cooldown and measured exhaustion filter the list. Automatic Codex launches still require fresh headroom above the reserve. Explicit preferences pin the agent and do not bypass disabled status or exhausted quotas.

New adapters are disabled when loading old configuration. Enable only the workers you intend to use. Model overrides require an explicit agent preference, and OpenCode overrides must remain under `opencode-go/`. Failed or uncertain execution is not replayed automatically; the existing one-fallback limit remains.

Additional workers require macOS configuration isolation and current supported CLI features. OpenCode requires V2 2.2.3+ for policy controls. Installed variants were Cursor 2026.01.28-fd13201, Antigravity 1.4.12 and OpenCode 2.2.5. Read CLI diagnostics before updating; the dispatcher does not silently upgrade your other tools.

## Muse

The local Muse gateway exposes read-only tools; it is not a headless Muse worker or task-launch API. This change leaves that gateway and its allowlists unchanged. No Muse subscription adapter is claimed. A documented launch/result interface would be needed before adding one.

See the [verification record](verification.md) for live versus fixture coverage.
