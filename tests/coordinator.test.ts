import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { fixture } from "./helpers.js";
import {
  recoverTasks,
  sessionContext,
  coordinatorInstructions,
} from "../src/coordinator.js";
import { installClientPolicies } from "../src/client-policy.js";

test("recovery survives reconnection, filters before limiting, and never replays or acknowledges", () => {
  const f = fixture();
  try {
    const origin = { client: "claude" as const, sessionId: randomUUID() };
    const own = f.store.create({ ...f.input, origin });
    f.store.update(own.id, { status: "interrupted", delivery: "unknown" });
    for (let i = 0; i < 23; i++)
      f.store.create({
        ...f.input,
        origin: { ...origin, sessionId: randomUUID() },
        idempotencyKey: `other-${i}`,
      });
    const result = recoverTasks(f.store, { origin, limit: 1 });
    assert.equal(result.total, 1);
    assert.equal(result.tasks[0]?.id, own.id);
    assert.equal(f.store.get(own.id).delivery, "unknown");
    assert.equal(f.store.get(own.id).attempts, 0);
    const context = sessionContext(f.state, {
      session_id: origin.sessionId,
      cwd: f.repo,
    });
    assert.match(JSON.stringify(context), new RegExp(own.id));
    f.store.update(own.id, { delivery: "acknowledged" });
    assert.equal(recoverTasks(f.store, { origin }).total, 0);
    assert.throws(() => recoverTasks(f.store, {}), /requires/);
    assert.equal(recoverTasks(f.store, { cwd: f.root }).total, 0);
  } finally {
    f.cleanup();
  }
});

test("native policies preserve content, JSONC comments, MCP entries and hooks across install/uninstall", () => {
  const f = fixture();
  try {
    const home = join(f.root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".config/opencode"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const policy = join(home, ".codex/AGENTS.md");
    writeFileSync(policy, "Existing user instructions\n");
    const config = join(home, ".config/opencode/opencode.jsonc");
    writeFileSync(
      config,
      '{\n// keep comment\n"mcp":{"servers":{"other":{"type":"local","command":["other"]}}},\n}\n',
    );
    const settings = join(home, ".claude/settings.json");
    const other = {
      matcher: "startup",
      hooks: [{ type: "command", command: "other-hook" }],
    };
    writeFileSync(
      settings,
      JSON.stringify({ hooks: { SessionStart: [other] } }),
    );
    installClientPolicies(f.state, false, home);
    const first = readFileSync(policy, "utf8");
    installClientPolicies(f.state, false, home);
    assert.equal(readFileSync(policy, "utf8"), first);
    assert.match(first, /without being asked/);
    assert.equal(
      parse(readFileSync(settings, "utf8")).hooks.SessionStart.length,
      2,
    );
    assert.match(readFileSync(config, "utf8"), /keep comment/);
    assert.ok(parse(readFileSync(config, "utf8")).mcp.servers.other);
    assert.ok(
      parse(readFileSync(config, "utf8")).mcp.servers["agent-dispatcher"],
    );
    installClientPolicies(f.state, true, home);
    assert.equal(
      readFileSync(policy, "utf8").trim(),
      "Existing user instructions",
    );
    assert.deepEqual(parse(readFileSync(settings, "utf8")).hooks.SessionStart, [
      other,
    ]);
    assert.equal(
      parse(readFileSync(config, "utf8")).mcp.servers["agent-dispatcher"],
      undefined,
    );
    assert.ok(parse(readFileSync(config, "utf8")).mcp.servers.other);
    assert.match(coordinatorInstructions, /30%/);
  } finally {
    f.cleanup();
  }
});

test("startup context stays bounded even with many large saved goals", () => {
  const f = fixture();
  try {
    const sessionId = randomUUID();
    for (let i = 0; i < 25; i++)
      f.store.create({
        ...f.input,
        goal: "x".repeat(24000),
        origin: { client: "claude", sessionId },
        idempotencyKey: `large-${i}`,
      });
    const context = sessionContext(f.state, {
      session_id: sessionId,
      cwd: f.repo,
    });
    assert.ok(JSON.stringify(context).length < 10000);
    assert.match(JSON.stringify(context), /Agent Dispatcher/);
    assert.equal(
      recoverTasks(f.store, {
        origin: { client: "claude", sessionId },
        limit: 1,
      }).tasks[0]?.goal.length,
      300,
    );
  } finally {
    f.cleanup();
  }
});
