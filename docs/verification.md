# Verification record

Verified locally on macOS with Node 22:

- TypeScript checking, ESLint, Prettier, isolated behavioral tests and production build.
- Fixture-based worker execution and completion delivery in both directions, including a session-bound MCP channel.
- Temporary Git repositories covering staged/unstaged/untracked input, snapshot-relative patches, conflicts and original-index preservation.
- Routing/reserve checks, quota fallback, explicit preference pinning, process timeout/output bounds, cancellation, missing-runner recovery and idle monitoring without agent calls.
- Clean tarball installation, installed CLI version/help smoke checks, package-content inspection and SHA-256 generation.
- A bounded **live Codex subscription** worker created one file in an isolated fixture checkout; its exact contents were independently verified.
- Live Codex account reads returned separate five-hour and weekly allowance measurements.

Not verified live:

- Claude execution: the installed CLI reported no authenticated account during setup. Its adapter and channel are covered by mock integration tests; a real Claude session is still required.
- End-to-end delivery into an actual interactive Codex/Claude chat. Mock transport/Snooze tests cover the contracts, but queue acceptance is not proof of model receipt.
- GitHub-hosted CI, Linux runtime and Node 24: configured in the CI matrix, not represented as executed locally.

Routine tests never use real models or queue notifications to real chats. For another explicit bounded live worker check:

```sh
npm run build
node scripts/live-smoke.mjs --live --agent codex
# After signing in with the Claude subscription:
node scripts/live-smoke.mjs --live --agent claude
```

The live script retains private temporary artifacts for inspection. It does not register notifications, merge or publish anything. It consumes the selected subscription's normal allowance. Provider-side extra-usage settings still govern billing.
