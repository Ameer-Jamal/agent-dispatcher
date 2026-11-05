import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/process.js";
import { fixture } from "./helpers.js";
test("registration is idempotent, preserves other MCP entries, and unregister removes only this installation", async () => {
  const f = fixture();
  try {
    const home = join(f.root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const codex = join(home, ".codex/config.toml"),
      claude = join(home, ".claude.json");
    const original =
      'model = "fixture-model"\n\n[mcp_servers.other]\ncommand = "other-tool"\n';
    writeFileSync(codex, original);
    writeFileSync(
      claude,
      JSON.stringify({
        custom: "preserve",
        mcpServers: { other: { command: "other-tool" } },
      }),
    );
    const invoke = (command: string) =>
      run(process.execPath, ["dist/src/cli.js", "--state", f.state, command], {
        env: { ...process.env, HOME: home },
      });
    assert.equal((await invoke("register")).code, 0);
    assert.equal((await invoke("register")).code, 0);
    assert.equal(
      readFileSync(codex, "utf8").match(/\[mcp_servers.agent-dispatcher\]/g)
        ?.length,
      1,
    );
    assert.ok(JSON.parse(readFileSync(claude, "utf8")).mcpServers.other);
    const result = await invoke("unregister");
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).removed, ["codex", "claude"]);
    assert.equal(readFileSync(codex, "utf8").trim(), original.trim());
    assert.equal(JSON.parse(readFileSync(claude, "utf8")).custom, "preserve");
  } finally {
    f.cleanup();
  }
});
test("setup preserves custom routing defaults and merges allowed roots", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.state, "config.json"),
      JSON.stringify({ ...f.config, reservePercent: 45 }),
    );
    const result = await run(process.execPath, [
      "dist/src/cli.js",
      "--state",
      f.state,
      "setup",
      "--root",
      f.root,
    ]);
    assert.equal(result.code, 0);
    const saved = JSON.parse(
      readFileSync(join(f.state, "config.json"), "utf8"),
    );
    assert.equal(saved.reservePercent, 45);
    assert.deepEqual(saved.allowedRoots, [f.repo, f.root]);
  } finally {
    f.cleanup();
  }
});
