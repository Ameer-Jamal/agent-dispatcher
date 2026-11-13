// Opt-in: two small Claude Enterprise subscription coordinator requests; workers are synthetic.
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Store, terminal } from "../dist/src/store.js";
import { configSchema } from "../dist/src/config.js";
import { subscriptionEnv, run } from "../dist/src/process.js";
if (!process.argv.includes("--live"))
  throw new Error(
    "Use --live: spends two bounded Claude subscription requests; no API billing.",
  );
const root = realpathSync(
  mkdtempSync(join(tmpdir(), "dispatcher-coordinator-")),
);
const repo = join(root, "repo"),
  state = join(root, "state");
execFileSync("git", ["init", "-q", repo]);
for (let i = 0; i < 5; i++)
  writeFileSync(
    join(repo, `module${i}.js`),
    `export const timeout = ${i * 100};\nexport const retry = ${i};\n`,
  );
execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.name=Smoke",
  "-c",
  "user.email=smoke@localhost",
  "add",
  ".",
]);
execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.name=Smoke",
  "-c",
  "user.email=smoke@localhost",
  "commit",
  "-qm",
  "fixture",
]);
const mock = join(root, "mock-claude");
writeFileSync(
  mock,
  `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='auth')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));else{process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({result:'Synthetic investigation complete: all five fixture modules compared; no changes required.',session_id:'${randomUUID()}'})));}\n`,
  { mode: 0o700 },
);
const store = new Store(state);
const config = configSchema.parse({
  allowedRoots: [repo],
  agents: {
    claude: { command: mock },
    codex: { enabled: false },
    cursor: { enabled: false },
    antigravity: { enabled: false },
    opencode: { enabled: false },
  },
});
writeFileSync(join(state, "config.json"), JSON.stringify(config));
const sessionId = randomUUID(),
  entry = resolve("dist/src/cli.js"),
  mcp = join(root, "mcp.json");
writeFileSync(
  mcp,
  JSON.stringify({
    mcpServers: {
      "agent-dispatcher": {
        command: process.execPath,
        args: [entry, "--state", state, "serve"],
        env: { AGENT_DISPATCHER_CLAUDE_SESSION: sessionId },
      },
    },
  }),
);
const env = subscriptionEnv();
delete env.AGENT_DISPATCHER_WORKER;
const auth = await run("claude", ["auth", "status", "--json"], { env });
if (
  !JSON.parse(auth.stdout).loggedIn ||
  JSON.parse(auth.stdout).authMethod !== "claude.ai"
)
  throw new Error("Native subscription authentication required");
const worker = spawn(process.execPath, [entry, "--state", state, "worker"], {
  env,
  stdio: "ignore",
});
try {
  const common = [
    "-p",
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--mcp-config",
    mcp,
    "--debug-file",
    join(root, "debug.log"),
    "--max-turns",
    "6",
    "--allowedTools",
    "Read,mcp__agent-dispatcher__dispatch_task,mcp__agent-dispatcher__recover_tasks,mcp__agent-dispatcher__get_task,mcp__agent-dispatcher__usage_status",
  ];
  const first = await run(
    "claude",
    [
      ...common,
      "--session-id",
      sessionId,
      "Implement a shared validated timeout/retry configuration API for these five modules. Preserve existing exports, reject negative/non-finite values, define zero-timeout behavior, add capped exponential backoff with deterministic jitter injection, migrate each module, and add meaningful node:test coverage for boundary values and backward compatibility. Run the tests and report the result.",
    ],
    { cwd: repo, env, timeoutMs: 90000 },
  );
  writeFileSync(join(root, "first.json"), first.stdout);
  if (first.code)
    throw new Error(`Coordinator failed: ${first.stderr.slice(0, 300)}`);
  const task = store.all()[0];
  if (!task || task.input.prefer || task.input.origin?.sessionId !== sessionId)
    throw new Error(
      `Ordinary request did not automatically dispatch with the correct origin/default routing; inspect ${root}/first.json`,
    );
  const deadline = Date.now() + 30000;
  while (!terminal(store.get(task.id).status) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  if (store.get(task.id).status !== "completed")
    throw new Error("Synthetic worker did not complete");
  const resumed = await run(
    "claude",
    [
      ...common,
      "--resume",
      sessionId,
      "Continue with any outstanding work for this conversation and report the result.",
    ],
    { cwd: repo, env, timeoutMs: 90000 },
  );
  writeFileSync(join(root, "resumed.json"), resumed.stdout);
  if (resumed.code)
    throw new Error(`Resume failed: ${resumed.stderr.slice(0, 300)}`);
  if (store.all().length !== 1) throw new Error("Resume duplicated work");
  if (store.get(task.id).delivery !== "acknowledged")
    throw new Error("Resumed coordinator did not retrieve/acknowledge result");
  console.log(
    JSON.stringify(
      {
        passed: true,
        root,
        taskId: task.id,
        automaticRouting: store.get(task.id).agent,
        originBound: true,
        resumedReceipt: store.get(task.id).delivery,
        coordinator: "native Claude subscription",
        worker: "synthetic",
      },
      null,
      2,
    ),
  );
} finally {
  worker.kill("SIGTERM");
  store.close();
}
