# Contributing

Use Node 22.13+ or 24. Keep the public repository generic: no personal paths, accounts, credentials, session IDs, private task inputs, databases or logs.

```sh
npm ci
npm run check
npm run package:check
npm audit
```

Tests use temporary Git repositories, mock CLIs, isolated state and MCP transports. Never require live provider credentials or send notifications to real chats in routine tests. Live smoke tests require `--live` and a specific authenticated subscription; record what was actually verified and what was blocked.

Preserve deterministic routing, subscription authentication checks, Codex reserve defaults, original Git indexes and user edits. Waiting never calls a model. Unknown execution/delivery outcomes must not be automatically retried. Keep worker MCP disabled and native permission controls enabled. Add behavior tests for routing, durability, snapshots and notification changes.

## Release

Update package version and changelog, run all checks, and test a clean package installation. `package:check` builds a tarball in a temporary directory, checks its contents, installs it into another temporary directory, smoke-tests the CLI, and writes a SHA-256 checksum beside the temporary tarball. Publish only the reviewed exact commit after CI passes. Tag early releases as prereleases; registry publishing and GitHub pushes are explicit actions, never an installation side effect.
