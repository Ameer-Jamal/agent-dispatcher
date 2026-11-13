import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { fixture, eventually } from "./helpers.js";
import { finish, runTask } from "../src/dispatcher.js";
test("MCP exposes coding and opt-in Muse tools; task submission does not launch inference", async () => {
  const f = fixture();
  const client = new Client({ name: "fixture", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["dist/src/cli.js", "--state", f.state, "serve"],
        stderr: "ignore",
      }),
    );
    const listing = await client.listTools();
    assert.equal(listing.tools.length, 9);
    const muse = await client.callTool({ name: "muse_status", arguments: {} });
    assert.match(JSON.stringify(muse.content), /connectionVerified/);
    const r = await client.callTool({
      name: "dispatch_task",
      arguments: f.input,
    });
    assert.equal(r.isError, undefined);
    assert.equal(f.store.all().length, 1);
    assert.equal(f.store.all()[0]?.status, "queued");
    const recovered = await client.callTool({
      name: "recover_tasks",
      arguments: { cwd: f.repo },
    });
    assert.match(JSON.stringify(recovered), new RegExp(f.store.all()[0]!.id));
    const unscoped = await client.callTool({
      name: "recover_tasks",
      arguments: {},
    });
    assert.equal(unscoped.isError, true);
    const status = await client.callTool({
      name: "usage_status",
      arguments: {},
    });
    assert.ok(status.content);
  } finally {
    await client.close();
    f.cleanup();
  }
});
test("Claude channel pushes to the originating connection once, then receipt is acknowledged", async () => {
  const f = fixture();
  const sessionId = randomUUID();
  const client = new Client({ name: "fixture", version: "1" });
  const events: string[] = [];
  client.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({
        content: z.string(),
        meta: z.record(z.string(), z.string()).optional(),
      }),
    }),
    async (n) => {
      events.push(n.params.content);
    },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["dist/src/cli.js", "--state", f.state, "serve", "--channel"],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (v): v is [string, string] => typeof v[1] === "string",
            ),
          ),
          AGENT_DISPATCHER_CLAUDE_SESSION: sessionId,
        },
        stderr: "ignore",
      }),
    );
    await client.callTool({
      name: "dispatch_task",
      arguments: { ...f.input, prefer: "codex" },
    });
    const task = f.store.all()[0]!;
    assert.equal(task.input.origin?.sessionId, sessionId);
    f.store.update(task.id, { status: "running" });
    await runTask(f.store, f.config, task.id);
    assert.equal(f.store.get(task.id).agent, "codex");
    await eventually(() => events.length === 1);
    assert.match(events[0]!, new RegExp(task.id));
    assert.equal(f.store.get(task.id).delivery, "delivered");
    await client.callTool({
      name: "get_task",
      arguments: { taskId: task.id, acknowledge: true },
    });
    assert.equal(f.store.get(task.id).delivery, "acknowledged");
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(events.length, 1);
  } finally {
    await client.close();
    f.cleanup();
  }
});
test("a disconnected Claude session retains its result for the exact-session reconnect", async () => {
  const f = fixture();
  try {
    const task = f.store.create({
      ...f.input,
      origin: { client: "claude", sessionId: randomUUID() },
    });
    finish(f.store, task.id, { status: "completed", summary: "retained" });
    assert.equal(f.store.get(task.id).delivery, "pending");
    assert.equal(f.store.get(task.id).summary, "retained");
  } finally {
    f.cleanup();
  }
});
