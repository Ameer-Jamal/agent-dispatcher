import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { configSchema, taskSchema } from "../src/config.js";
import { route } from "../src/routing.js";
import { workerCommand, parseOutcome } from "../src/adapters.js";
import { parseAntigravityUsage } from "../src/usage.js";
import { configurationProfile } from "../src/isolation.js";
const input = taskSchema.parse({
  goal: "Small maintenance change",
  cwd: "/repo",
  idempotencyKey: "new-agent",
});
const config = configSchema.parse({
  agents: {
    cursor: { enabled: true },
    antigravity: { enabled: true },
    opencode: { enabled: true },
  },
});
const available = {
  codex: true,
  claude: true,
  cursor: true,
  antigravity: true,
  opencode: true,
};
test("existing configurations keep additional workers disabled until enabled", () => {
  const old = configSchema.parse({ agents: { claude: { command: "claude" } } });
  for (const agent of ["cursor", "antigravity", "opencode"] as const)
    assert.equal(old.agents[agent].enabled, false);
  assert.equal(old.agents.claude.enabled, true);
  assert.equal(old.reservePercent, 30);
});
test("task-specific deterministic preferences distribute appropriate work without model calls", () => {
  assert.equal(route(input, config, {}, available).agent, "claude");
  assert.equal(
    route({ ...input, taskType: "maintenance" }, config, {}, available).agent,
    "opencode",
  );
  assert.equal(
    route({ ...input, taskType: "review" }, config, {}, available).agent,
    "antigravity",
  );
  assert.equal(
    route(input, config, {}, { ...available, claude: false }).agent,
    "cursor",
  );
  assert.equal(
    route(
      { ...input, taskType: "review" },
      config,
      {
        antigravity: {
          agent: "antigravity",
          pool: "p",
          quality: "unknown",
          observedAt: Date.now(),
          blockedUntil: Date.now() + 10000,
        },
      },
      available,
    ).agent,
    "claude",
  );
});
test("disabled workers cannot be forced by an explicit preference", () => {
  assert.throws(
    () =>
      route(
        { ...input, prefer: "cursor" },
        configSchema.parse({}),
        {},
        available,
      ),
    /unavailable/,
  );
});
test("OpenCode cannot use an OpenAI or console provider even through a model override", () => {
  assert.throws(
    () =>
      workerCommand(
        "opencode",
        { ...input, prefer: "opencode", model: "openai/gpt-5.4" },
        config,
        randomUUID(),
      ),
    /opencode-go/,
  );
  const command = workerCommand("opencode", input, config, randomUUID());
  assert.ok(command.args.includes("opencode-go/minimax-m3"));
  assert.ok(command.args.includes("--standalone"));
  assert.ok(!command.args.includes("--auto"));
});
test("Cursor and Antigravity preserve native permissions and enable native sandboxing", () => {
  const cursor = workerCommand("cursor", input, config, randomUUID());
  assert.ok(cursor.args.includes("--sandbox"));
  assert.ok(!cursor.args.includes("--force"));
  assert.ok(!cursor.args.includes("--approve-mcps"));
  const agy = workerCommand("antigravity", input, config, randomUUID());
  assert.ok(agy.args.includes("--sandbox"));
  assert.ok(!agy.args.includes("--dangerously-skip-permissions"));
  const settings = JSON.parse(agy.args[agy.args.indexOf("--settings") + 1]!);
  assert.equal(settings.useG1Credits, false);
  assert.equal(settings.modelProvider, "");
});
test("native result formats preserve worker sessions, summaries and usage", () => {
  assert.deepEqual(
    parseOutcome("cursor", {
      code: 0,
      stdout: JSON.stringify({
        type: "result",
        session_id: "cursor-session",
        result: "Done",
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      stderr: "",
    }),
    {
      sessionId: "cursor-session",
      summary: "Done",
      tokens: 7,
      kind: "success",
    },
  );
  const agy = parseOutcome("antigravity", {
    code: 0,
    stdout: JSON.stringify({
      status: "SUCCESS",
      conversation_id: "agy-session",
      response: "Done",
      usage: { total_tokens: 9 },
    }),
    stderr: "",
  });
  assert.equal(agy.sessionId, "agy-session");
  assert.equal(agy.tokens, 9);
  assert.equal(agy.kind, "success");
  const oc = parseOutcome("opencode", {
    code: 0,
    stdout: [
      { type: "text", sessionID: "ses_fixture", part: { text: "Done" } },
      {
        type: "step_finish",
        sessionID: "ses_fixture",
        part: { tokens: { input: 3, output: 4 }, reason: "stop" },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
    stderr: "",
  });
  assert.equal(oc.sessionId, "ses_fixture");
  assert.equal(oc.summary, "Done");
  assert.equal(oc.tokens, 7);
  assert.equal(oc.kind, "success");
});
test("nonzero native JSON quota errors qualify for controlled fallback", () => {
  const outcome = parseOutcome("opencode", {
    code: 1,
    stdout: JSON.stringify({
      type: "error",
      error: { message: "Usage limit reached" },
    }),
    stderr: "",
  });
  assert.equal(outcome.kind, "quota");
});
function quota() {
  return {
    status: "SUCCESS",
    num_turns: 0,
    usage: { total_tokens: 0 },
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-5h",
                window: "5h",
                remaining_fraction: 0.9,
                reset_time: "2026-11-06T00:00:00Z",
              },
              {
                id: "gemini-weekly",
                window: "weekly",
                remaining_fraction: 0.7,
                reset_time: "2026-11-12T00:00:00Z",
              },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              {
                id: "3p-5h",
                window: "5h",
                remaining_fraction: 1,
                reset_time: "2026-11-06T00:00:00Z",
              },
            ],
          },
        ],
      },
    },
  };
}
test("Antigravity quota parsing keeps model-group pools separate and uses zero-turn probes", () => {
  const measured = parseAntigravityUsage(quota(), "google", "Gemini Flash");
  assert.equal(measured.remainingPercent, 70);
  assert.equal(measured.windows?.length, 3);
  assert.equal(
    parseAntigravityUsage(quota(), "google", "Claude Sonnet").remainingPercent,
    100,
  );
  assert.throws(() =>
    parseAntigravityUsage({ ...quota(), num_turns: 1 }, "google"),
  );
  assert.throws(() =>
    parseAntigravityUsage(
      { ...quota(), usage: { total_tokens: 10 } },
      "google",
    ),
  );
});
test("worker configuration profiles hide global and project MCP/plugin definitions", () => {
  const cursor = configurationProfile("cursor", "/work", "/home/fixture");
  assert.match(cursor, /\.cursor\/mcp.json/);
  assert.match(cursor, /deny file-write/);
  const agy = configurationProfile("antigravity", "/work", "/home/fixture");
  assert.match(agy, /\.gemini\/config/);
  assert.match(agy, /\.agents\/hooks.json/);
  const oc = configurationProfile("opencode", "/work", "/home/fixture");
  assert.match(oc, /opencode.jsonc/);
});

test("OpenCode tool permission denials cannot be reported as completed work", () => {
  const result = parseOutcome("opencode", {
    code: 0,
    stdout: [
      {
        type: "tool_use",
        part: { state: { status: "error", error: "Permission denied: edit" } },
      },
      { type: "text", part: { text: "Blocked by permissions" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
    stderr: "",
  });
  assert.equal(result.kind, "permission");
});

test(
  "Cursor cached login without models is unavailable on the first probe",
  { skip: process.platform !== "darwin" },
  async () => {
    const { fixture } = await import("./helpers.js");
    const { availability } = await import("../src/usage.js");
    const f = fixture();
    try {
      f.config.agents.cursor = {
        ...f.config.agents.cursor,
        enabled: true,
        command: f.mock,
      };
      const result = await availability(f.config, f.store);
      assert.equal(result.cursor, false);
      assert.equal(f.store.meta("auth:cursor"), "false");
      assert.match(f.store.usage("cursor")?.note ?? "", /no accessible models/);
    } finally {
      f.cleanup();
    }
  },
);

test("OpenCode policy compatibility excludes pre-policy releases and unknown major versions", async () => {
  const { supportsOpenCodePolicy } = await import("../src/usage.js");
  assert.equal(supportsOpenCodePolicy("opencode v2.2.5"), true);
  assert.equal(supportsOpenCodePolicy("2.2.3"), true);
  assert.equal(supportsOpenCodePolicy("2.2.2"), false);
  assert.equal(supportsOpenCodePolicy("1.2.5"), false);
  assert.equal(supportsOpenCodePolicy("3.0.0"), false);
});
