import {
  realpathSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { run } from "./process.js";
import { privateDir, type Config, type TaskInput } from "./config.js";
async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  input?: string,
) {
  const r = await run(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, env, input, timeoutMs: 60000, maxBytes: 20_000_000 },
  );
  if (r.code !== 0 || r.stopReason)
    throw new Error(`Git ${args[0]} failed: ${r.stderr.slice(0, 1000)}`);
  return r.stdout.trim();
}
export function validateCwd(input: TaskInput, config: Config) {
  const cwd = realpathSync(input.cwd);
  if (!config.allowedRoots.length)
    throw new Error(
      "Configure at least one allowedRoots directory before dispatch",
    );
  if (
    !config.allowedRoots.some((root) => {
      const rel = relative(realpathSync(root), cwd);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    })
  )
    throw new Error("Working directory outside configured allowed roots");
  for (const file of input.files) {
    if (isAbsolute(file) || relative(cwd, join(cwd, file)).startsWith(".."))
      throw new Error(
        "Relevant files must be relative paths within the working directory",
      );
  }
  return cwd;
}
export async function snapshot(state: string, id: string, input: TaskInput) {
  const root = await git(input.cwd, ["rev-parse", "--show-toplevel"]);
  if (root !== realpathSync(input.cwd))
    throw new Error("Dispatch cwd must be the Git repository root");
  if (
    (await git(root, ["ls-files", "--stage"]))
      .split("\n")
      .some((l) => l.startsWith("160000 "))
  )
    throw new Error("Submodule repositories are not supported in v1");
  const artifacts = privateDir(join(state, "tasks", id));
  const temp = mkdtempSync(join(artifacts, "index-"));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(temp, "index"),
    GIT_AUTHOR_NAME: "Agent Dispatcher",
    GIT_AUTHOR_EMAIL: "dispatcher@localhost",
    GIT_COMMITTER_NAME: "Agent Dispatcher",
    GIT_COMMITTER_EMAIL: "dispatcher@localhost",
  };
  let baseCommit: string;
  try {
    await git(root, ["read-tree", "HEAD"], env);
    await git(root, ["add", "-A", "--", "."], env);
    const tree = await git(root, ["write-tree"], env);
    const head = await git(root, ["rev-parse", "HEAD"]);
    baseCommit = await git(
      root,
      ["commit-tree", tree, "-p", head],
      env,
      "Agent dispatcher input snapshot\n",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const worktree = join(artifacts, "worktree");
  await git(root, ["worktree", "add", "--detach", worktree, baseCommit]);
  const manifest = {
    source: root,
    baseCommit,
    createdAt: Date.now(),
    note: "Includes tracked and non-ignored untracked files; original index untouched",
  };
  writeFileSync(
    join(artifacts, "snapshot.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  return { worktree, baseCommit, artifactDir: artifacts };
}
export async function capturePatch(
  worktree: string,
  baseCommit: string,
  artifacts: string,
) {
  const temp = mkdtempSync(join(artifacts, "result-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
  try {
    await git(worktree, ["read-tree", baseCommit], env);
    await git(worktree, ["add", "-A", "--", "."], env);
    const r = await run(
      "git",
      ["diff", "--cached", "--binary", "--full-index", baseCommit, "--"],
      { cwd: worktree, env, timeoutMs: 60000, maxBytes: 20_000_000 },
    );
    if (r.code || r.stopReason)
      throw new Error("Patch capture failed or exceeded 20 MB");
    writeFileSync(join(artifacts, "changes.patch"), r.stdout, { mode: 0o600 });
    writeFileSync(
      join(artifacts, "changed-files.txt"),
      await git(
        worktree,
        ["diff", "--cached", "--name-only", baseCommit, "--"],
        env,
      ),
      { mode: 0o600 },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
export async function applyPatch(task: {
  input: TaskInput;
  artifactDir?: string;
  status: string;
}) {
  if (task.status !== "completed" || !task.artifactDir)
    throw new Error(
      "Only completed task patches can be applied after coordinator review",
    );
  const patch = readFileSync(join(task.artifactDir, "changes.patch"), "utf8");
  if (!patch) return "No changes";
  await git(
    task.input.cwd,
    ["apply", "--check", "--binary", "-"],
    undefined,
    patch,
  );
  await git(task.input.cwd, ["apply", "--binary", "-"], undefined, patch);
  return "Applied reviewed patch to working tree; index unchanged";
}
