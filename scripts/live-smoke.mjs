import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { configSchema } from "../dist/src/config.js";
import { Store } from "../dist/src/store.js";
import { submit, runTask } from "../dist/src/dispatcher.js";
const args = process.argv.slice(2);
const agent = args[args.indexOf("--agent") + 1];
if (
  !args.includes("--live") ||
  !["codex", "claude", "cursor", "antigravity", "opencode"].includes(agent)
) {
  throw new Error(
    "Explicit opt-in required: node scripts/live-smoke.mjs --live --agent codex|claude|cursor|antigravity|opencode",
  );
}
const root = realpathSync(mkdtempSync(join(tmpdir(), "dispatcher-live-")));
const repo = join(root, "repo");
execFileSync("git", ["init", "-q", repo]);
const git = (...args) =>
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Smoke Fixture",
    "-c",
    "user.email=smoke@localhost",
    ...args,
  ]);
writeFileSync(
  join(repo, "README.md"),
  "# Temporary dispatcher smoke fixture\n",
);
git("add", ".");
git("commit", "-qm", "fixture");
const store = new Store(join(root, "state"));
const config = configSchema.parse({
  allowedRoots: [repo],
  timeoutSeconds: 90,
  agents: { [agent]: { enabled: true } },
});
try {
  const task = submit(store, config, {
    goal: "Create dispatcher-smoke.txt containing exactly ok followed by one newline. Verify its content by reading it. Do no other work. Return one sentence reporting the result.",
    cwd: repo,
    prefer: agent,
    idempotencyKey: "bounded-live-smoke",
    files: [],
    acceptanceChecks: [
      "dispatcher-smoke.txt contains exactly ok followed by one newline",
    ],
  });
  store.update(task.id, { status: "running" });
  await runTask(store, config, task.id);
  const result = store.get(task.id);
  const evidence = {
    agent,
    status: result.status,
    summary: result.summary,
    error: result.error,
    artifacts: result.artifactDir,
    root,
  };
  if (result.status === "completed") {
    const content = readFileSync(
      join(result.worktree, "dispatcher-smoke.txt"),
      "utf8",
    );
    if (content !== "ok\n")
      throw new Error(
        "Worker reported success but content failed verification",
      );
    evidence.contentVerified = true;
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (result.status !== "completed") process.exitCode = 1;
} finally {
  store.close();
}
