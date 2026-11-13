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
const development = args.includes("--development");
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
if (development) {
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  const pkg = {
    name: "dispatcher-development-smoke",
    version: "1.0.0",
    scripts: {
      postinstall:
        "node -e \"require('fs').writeFileSync('installed.txt','ok')\"",
      test: "node -e \"require('assert').equal(require('fs').readFileSync('installed.txt','utf8'),'ok');require('fs').writeFileSync('tests-passed.txt','ok')\"",
    },
  };
  writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
  writeFileSync(
    join(repo, "package-lock.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      packages: {
        "": { name: pkg.name, version: pkg.version, hasInstallScript: true },
      },
    }),
  );
}
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
    goal: development
      ? "This is an explicitly authorized bounded offline dependency-installation smoke test. Run npm ci --offline --no-audit --no-fund and npm test in this checkout. The root postinstall script writes installed.txt, and the test checks it and writes tests-passed.txt. Do not edit package.json or the lockfile or bypass scripts. Verify both files contain ok. Only after those commands succeed, create dispatcher-smoke.txt containing exactly ok followed by one newline. Return a short summary of commands and exit results. Do no other work."
      : "Create dispatcher-smoke.txt containing exactly ok followed by one newline. Verify its content by reading it. Do no other work. Return one sentence reporting the result.",
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
    if (development) {
      for (const file of ["installed.txt", "tests-passed.txt"]) {
        if (readFileSync(join(result.worktree, file), "utf8") !== "ok")
          throw new Error(`Missing verified lifecycle marker: ${file}`);
      }
      evidence.dependencyInstallAndTestsVerified = true;
    }
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (result.status !== "completed") process.exitCode = 1;
} finally {
  store.close();
}
