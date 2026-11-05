import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import {
  snapshot,
  capturePatch,
  applyPatch,
  validateCwd,
} from "../src/worktree.js";
test("snapshot preserves dirty checkout/index; incremental patch excludes input edits", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "tracked.txt"), "staged\n");
    f.git("add", "tracked.txt");
    writeFileSync(join(f.repo, "tracked.txt"), "unstaged\n");
    writeFileSync(join(f.repo, "untracked.txt"), "existing input\n");
    const indexBefore = f.git("diff", "--cached");
    const statusBefore = f.git("status", "--porcelain");
    const tree = await snapshot(f.state, "snapshot", f.input);
    assert.equal(
      readFileSync(join(tree.worktree, "tracked.txt"), "utf8"),
      "unstaged\n",
    );
    assert.equal(
      readFileSync(join(tree.worktree, "untracked.txt"), "utf8"),
      "existing input\n",
    );
    assert.equal(f.git("diff", "--cached"), indexBefore);
    assert.equal(f.git("status", "--porcelain"), statusBefore);
    writeFileSync(join(tree.worktree, "worker.txt"), "new work\n");
    await capturePatch(tree.worktree, tree.baseCommit, tree.artifactDir);
    const patch = readFileSync(join(tree.artifactDir, "changes.patch"), "utf8");
    assert.match(patch, /worker.txt/);
    assert.doesNotMatch(patch, /untracked.txt|tracked.txt/);
    await applyPatch({
      input: f.input,
      artifactDir: tree.artifactDir,
      status: "completed",
    });
    assert.equal(f.read("worker.txt"), "new work\n");
    assert.equal(f.git("diff", "--cached"), indexBefore);
  } finally {
    f.cleanup();
  }
});
test("conflicting source edits are preserved", async () => {
  const f = fixture();
  try {
    const tree = await snapshot(f.state, "conflict", f.input);
    writeFileSync(join(tree.worktree, "tracked.txt"), "worker change\n");
    await capturePatch(tree.worktree, tree.baseCommit, tree.artifactDir);
    writeFileSync(join(f.repo, "tracked.txt"), "user change\n");
    await assert.rejects(
      applyPatch({
        input: f.input,
        artifactDir: tree.artifactDir,
        status: "completed",
      }),
    );
    assert.equal(f.read("tracked.txt"), "user change\n");
  } finally {
    f.cleanup();
  }
});
test("allowed roots and relative file boundaries are enforced", () => {
  const f = fixture();
  try {
    assert.equal(validateCwd(f.input, f.config), f.repo);
    assert.throws(
      () => validateCwd({ ...f.input, cwd: f.root }, f.config),
      /outside/,
    );
    assert.throws(
      () => validateCwd({ ...f.input, files: ["../private"] }, f.config),
      /relative paths/,
    );
    assert.throws(
      () => validateCwd(f.input, { ...f.config, allowedRoots: [] }),
      /allowedRoots/,
    );
    assert.equal(existsSync(join(f.repo, "worker.txt")), false);
  } finally {
    f.cleanup();
  }
});
