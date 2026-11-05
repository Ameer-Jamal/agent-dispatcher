import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configurationProfile } from "../src/isolation.js";
import { run } from "../src/process.js";
test(
  "macOS profile blocks extension reads and writes outside task/runtime directories",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = mkdtempSync(join(homedir(), ".dispatcher-isolation-test-"));
    try {
      const cwd = join(root, "task/worktree"),
        home = join(root, "home");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(home, ".config/opencode"), { recursive: true });
      const config = join(home, ".config/opencode/opencode.json");
      writeFileSync(config, "{}");
      const profile = configurationProfile("opencode", cwd, home);
      const read = await run("/usr/bin/sandbox-exec", [
        "-p",
        profile,
        "/bin/cat",
        config,
      ]);
      assert.notEqual(read.code, 0);
      const outside = join(root, "outside.txt");
      const denied = await run("/usr/bin/sandbox-exec", [
        "-p",
        profile,
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync(process.argv[1],"test")',
        outside,
      ]);
      assert.notEqual(denied.code, 0);
      assert.equal(existsSync(outside), false);
      const inside = join(cwd, "inside.txt");
      const allowed = await run("/usr/bin/sandbox-exec", [
        "-p",
        profile,
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync(process.argv[1],"test")',
        inside,
      ]);
      assert.equal(allowed.code, 0);
      assert.equal(existsSync(inside), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
