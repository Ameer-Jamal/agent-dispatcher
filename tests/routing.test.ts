import { test } from "node:test";
import assert from "node:assert/strict";
import { configSchema, taskSchema } from "../src/config.js";
import { route } from "../src/routing.js";
import { parseLimits } from "../src/usage.js";
import type { Usage } from "../src/store.js";
const config = configSchema.parse({});
const input = taskSchema.parse({
  goal: "Fix a bug",
  cwd: "/repo",
  idempotencyKey: "x",
});
const measured = (remainingPercent: number, age = 0): Usage => ({
  agent: "codex",
  pool: "chatgpt-primary",
  quality: "measured",
  observedAt: Date.now() - age,
  remainingPercent,
});
test("default substantial execution uses Claude and preserves Codex", () =>
  assert.equal(
    route(input, config, {}, { codex: true, claude: true }).agent,
    "claude",
  ));
test("reserve, missing, estimated and stale allowance block automatic Codex", () => {
  for (const u of [
    undefined,
    measured(30),
    measured(20),
    measured(90, 200000),
    { ...measured(90), quality: "estimated" as const },
  ])
    assert.throws(
      () => route(input, config, { codex: u }, { codex: true, claude: false }),
      /No eligible/,
    );
});
test("explicit override can use reserve, but cannot bypass authentication", () => {
  assert.equal(
    route(
      { ...input, prefer: "codex" },
      config,
      {},
      { codex: true, claude: true },
    ).agent,
    "codex",
  );
  assert.throws(
    () =>
      route(
        { ...input, prefer: "codex" },
        config,
        {},
        { codex: false, claude: true },
      ),
    /unavailable/,
  );
});
test("capability advantage and fallback require measured reserve headroom", () => {
  assert.equal(
    route(
      { ...input, capabilityReason: "Specialist requirement" },
      config,
      { codex: measured(60) },
      { codex: true, claude: true },
    ).agent,
    "codex",
  );
  assert.equal(
    route(
      { ...input, capabilityReason: "Specialist requirement" },
      config,
      { codex: measured(10) },
      { codex: true, claude: true },
    ).agent,
    "claude",
  );
  assert.equal(
    route(
      input,
      config,
      { codex: measured(60) },
      { codex: true, claude: false },
    ).agent,
    "codex",
  );
});
test("quota cooldown blocks dispatch even when quota percentage is unknown", () => {
  const claude: Usage = {
    agent: "claude",
    pool: "claude-primary",
    quality: "unknown",
    observedAt: Date.now(),
    blockedUntil: Date.now() + 60000,
  };
  assert.throws(
    () => route(input, config, { claude }, { codex: false, claude: true }),
    /No eligible/,
  );
});
test("minimum headroom across primary and secondary pools governs reserve", () => {
  const u = parseLimits(
    {
      rateLimitsByLimitId: {
        a: { primary: { usedPercent: 20, resetsAt: 100 } },
        b: { secondary: { usedPercent: 85, resetsAt: 200 } },
      },
    },
    "p",
  );
  assert.equal(u.remainingPercent, 15);
  assert.equal(u.resetsAt, 200000);
  assert.throws(() => parseLimits({}, "p"), /no measured/);
});
