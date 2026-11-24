import {
  realpathSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  accessSync,
  constants,
} from "node:fs";
import { join, relative, isAbsolute, resolve, delimiter, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { run, subscriptionEnv } from "./process.js";
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
  if (r.code !== 0 || r.stopReason) {
    const reason = r.stopReason ?? `exit ${r.code}`;
    const detail = r.stderr.trim().slice(0, 1000);
    throw new Error(
      `Git ${args[0]} failed (${reason})${detail ? `: ${detail}` : ""}`,
    );
  }
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
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
/** Host PATH lookup only: never executes the command, and says nothing about sandbox or native permissions. */
function onHostPath(name: string, env: NodeJS.ProcessEnv) {
  return (
    (env.PATH ?? "")
      .split(delimiter)
      // Relative PATH entries would resolve against an arbitrary cwd.
      .filter((dir) => isAbsolute(dir))
      .some((dir) => {
        try {
          const file = join(dir, name);
          if (!statSync(file).isFile()) return false;
          accessSync(file, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
  );
}
/**
 * Problems with declared worker prerequisites, naming only the declared relative paths and basenames.
 * `source` also checks that each file will reach the snapshot; a snapshot worktree simply lacks ignored files.
 */
export function prerequisiteProblems(
  root: string,
  input: Pick<TaskInput, "requiredFiles" | "requiredCommands">,
  source: boolean,
  env = subscriptionEnv(),
) {
  const problems: string[] = [];
  const realRoot = realpathSync(root);
  if (source) {
    const repo = spawnSync("git", ["rev-parse", "--show-toplevel", "HEAD"], {
      cwd: realRoot,
      encoding: "utf8",
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    if (repo.status !== 0 || repo.stdout.trimEnd().split("\n")[0] !== realRoot)
      return ["Use the root of a Git checkout with an existing commit."];
  }
  const candidates = new Map<string, string>();
  for (const file of input.requiredFiles ?? []) {
    const name = JSON.stringify(file);
    const target = resolve(realRoot, file);
    if (
      isAbsolute(file) ||
      file.split(sep).includes("..") ||
      !inside(realRoot, target) ||
      relative(realRoot, target).split(sep)[0] === ".git"
    ) {
      problems.push(
        "A required file must be a relative path inside cwd outside .git.",
      );
      continue;
    }
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      problems.push(`Required file ${name} does not exist in the checkout.`);
      continue;
    }
    if (!inside(realRoot, real)) {
      problems.push(
        `Required file ${name} resolves outside the checkout through a symlink; copy the input into the repository instead.`,
      );
      continue;
    }
    if (target !== real) {
      problems.push(
        `Required file ${name} uses a symlink or noncanonical path; declare the actual checkout-relative file or directory.`,
      );
      continue;
    }
    if (source) candidates.set(relative(realRoot, target), name);
  }
  if (candidates.size) {
    // One bounded, literal query for every path. It never runs a task-supplied executable.
    const listed = spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "--literal-pathspecs",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...candidates.keys(),
      ],
      {
        cwd: realRoot,
        encoding: "utf8",
        timeout: 3000,
        killSignal: "SIGKILL",
        maxBuffer: 20_000_000,
      },
    );
    if (listed.status !== 0) {
      problems.push(
        "The dispatcher could not check the Git snapshot inputs. Verify the checkout and try again.",
      );
    } else {
      const paths = listed.stdout.split("\0");
      for (const [path, name] of candidates) {
        if (
          !paths.some((entry) => entry === path || entry.startsWith(path + sep))
        )
          problems.push(
            `Required file ${name} is ignored by Git or otherwise absent from the worker snapshot. Supply the needed input as a checkout file or pass a reviewed excerpt.`,
          );
      }
    }
  }
  for (const command of input.requiredCommands ?? [])
    if (!onHostPath(command, env))
      problems.push(
        `Required command ${JSON.stringify(command)} was not found on the dispatcher host PATH; install it or run that step in the originating session.`,
      );
  return problems;
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
    // Sparse partial clones can retain promised blobs outside the worker checkout.
    const tree = await git(root, ["write-tree", "--missing-ok"], env);
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
export async function reviewCheckoutUnchanged(
  worktree: string,
  baseCommit: string,
) {
  try {
    if ((await git(worktree, ["rev-parse", "HEAD"])) !== baseCommit)
      return false;
    const entries = await git(worktree, ["ls-files", "-v"]);
    if (/^(?:S|[a-z]) /m.test(entries)) return false;
    return !(await git(worktree, [
      "status",
      "--porcelain",
      "--ignored",
      "--untracked-files=all",
    ]));
  } catch {
    return false;
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
