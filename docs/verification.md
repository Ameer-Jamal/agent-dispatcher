# Verification record

Verified locally on macOS with Node 22:

- TypeScript checking, ESLint, Prettier, isolated behavioral tests and production build.
- Fixture-based worker execution and completion delivery in both directions, including a session-bound MCP channel.
- Temporary Git repositories covering staged/unstaged/untracked input, snapshot-relative patches, conflicts and original-index preservation.
- Routing/reserve checks, quota fallback, explicit preference pinning, process timeout/output bounds, cancellation, missing-runner recovery and idle monitoring without agent calls.
- Clean tarball installation, installed CLI version/help smoke checks, package-content inspection and SHA-256 generation.
- A bounded **live Codex subscription** worker created one file in an isolated fixture checkout; its exact contents were independently verified.
- A bounded **live Claude subscription** worker also created the fixture file; its exact contents were independently verified.
- Bounded **live Antigravity and OpenCode Go** workers created the same fixture file; exact contents were independently verified.
- Antigravity account probes returned grouped five-hour/weekly quota with zero inference turns and tokens.
- Live Codex account reads returned separate five-hour and weekly allowance measurements.

Not verified live:

- Cursor execution: the CLI reported a cached login, but no models were available and headless authentication failed. The adapter is implemented and tested with fixtures; automatic use remains disabled.

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

## Unattended OpenCode development commands

The OpenCode Go development smoke test ran `npm ci --offline --no-audit --no-fund`, executed the fixture's root postinstall lifecycle script, then ran `npm test` without approval prompts. The coordinator independently verified the install, test and completion markers in the isolated checkout. This is a zero-dependency offline fixture: it proves command/lifecycle execution and task-local cache writes, not registry downloads or every project's toolchain.

```sh
node scripts/live-smoke.mjs --live --agent opencode --development
```

A routine integration test exercises the same npm install lifecycle and checks under the worker OS profile on macOS (ordinary process execution on Linux). Existing isolation tests continue to verify that extension configuration reads and writes outside task/runtime directories are denied. The local suite contains 55 tests. Live checks consume the selected subscription; routine tests do not invoke models.
