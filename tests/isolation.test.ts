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
import {
  configurationProfile,
  prepareDevelopmentCaches,
} from "../src/isolation.js";
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

test("dependency installation and lifecycle checks work with private caches", async () => {
  const root = mkdtempSync(join(homedir(), ".dispatcher-development-test-"));
  try {
    const artifact = join(root, "task"),
      cwd = join(artifact, "worktree");
    mkdirSync(cwd, { recursive: true });
    const pkg = {
      name: "dispatcher-offline-fixture",
      version: "1.0.0",
      scripts: {
        postinstall:
          "node -e \"require('fs').writeFileSync('installed.txt','ok')\"",
        test: "node -e \"require('assert').equal(require('fs').readFileSync('installed.txt','utf8'),'ok')\"",
      },
    };
    writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg));
    writeFileSync(
      join(cwd, "package-lock.json"),
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        lockfileVersion: 3,
        packages: {
          "": { name: pkg.name, version: pkg.version, hasInstallScript: true },
        },
      }),
    );
    const env = { ...process.env, ...prepareDevelopmentCaches(artifact) };
    delete env.NPM_CONFIG_CACHE;
    for (const args of [
      ["ci", "--offline", "--no-audit", "--no-fund"],
      ["test"],
    ]) {
      const command =
        process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "npm";
      const argv =
        process.platform === "darwin"
          ? ["-p", configurationProfile("opencode", cwd), "npm", ...args]
          : args;
      const result = await run(command, argv, { cwd, env, timeoutMs: 30000 });
      assert.equal(result.code, 0, result.stderr + result.stdout);
    }
    assert.equal(existsSync(join(cwd, "installed.txt")), true);
    assert.ok(env.npm_config_cache);
    assert.ok(env.npm_config_cache.startsWith(artifact));
    assert.equal(existsSync(join(env.npm_config_cache, "_logs")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
