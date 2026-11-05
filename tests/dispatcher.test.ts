import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fixture, eventually } from "./helpers.js";
import {
  submit,
  runTask,
  registerSnooze,
  reconcileDelivery,
  cancel,
  tick,
  acknowledge,
} from "../src/dispatcher.js";
import { workerCommand, parseOutcome } from "../src/adapters.js";
import { subscriptionEnv } from "../src/process.js";
import { randomUUID } from "node:crypto";
test("idempotency survives restart and rejects a different payload", () => {
  const f = fixture();
  try {
    const task = submit(f.store, f.config, f.input);
    assert.equal(submit(f.store, f.config, f.input).id, task.id);
    assert.throws(
      () => submit(f.store, f.config, { ...f.input, goal: "different" }),
      /different task/,
    );
  } finally {
    f.cleanup();
  }
});
test("Claude worker completion returns patch, evidence and session without modifying source", async () => {
  const f = fixture();
  try {
    const task = submit(f.store, f.config, f.input);
    f.store.update(task.id, { status: "running" });
    await runTask(f.store, f.config, task.id);
    const done = f.store.get(task.id);
    assert.equal(done.status, "completed");
    assert.equal(done.agent, "claude");
    assert.equal(done.attempts, 1);
    assert.equal(done.workerSessionId, "00000000-0000-4000-8000-000000000002");
    assert.match(
      readFileSync(join(done.artifactDir!, "changes.patch"), "utf8"),
      /worker output/,
    );
    assert.equal(existsSync(join(f.repo, "worker.txt")), false);
    assert.equal(f.store.usage("claude")?.lastTaskTokens, 9);
  } finally {
    f.cleanup();
  }
});
test("quota failure permits one measured-budget fallback to Codex", async () => {
  const f = fixture("quota");
  try {
    const task = submit(f.store, f.config, f.input);
    f.store.update(task.id, { status: "running" });
    await runTask(f.store, f.config, task.id);
    const done = f.store.get(task.id);
    assert.equal(done.status, "completed");
    assert.equal(done.agent, "codex");
    assert.equal(done.attempts, 2);
    assert.ok(f.store.usage("claude")!.blockedUntil! > Date.now());
  } finally {
    f.cleanup();
  }
});
test("permission denials surface as blocked without fallback", async () => {
  const f = fixture("permission");
  try {
    const task = submit(f.store, f.config, f.input);
    f.store.update(task.id, { status: "running" });
    await runTask(f.store, f.config, task.id);
    assert.equal(f.store.get(task.id).status, "blocked");
    assert.equal(f.store.get(task.id).attempts, 1);
  } finally {
    f.cleanup();
  }
});
test("Snooze registration is single-shot, watches terminal artifact, and distinguishes queue from acknowledgement", async () => {
  const f = fixture();
  try {
    const origin = { client: "codex" as const, sessionId: randomUUID() };
    const task = submit(f.store, f.config, { ...f.input, origin });
    await registerSnooze(f.store, f.config, task);
    await registerSnooze(f.store, f.config, f.store.get(task.id));
    const spec = JSON.parse(
      readFileSync(join(f.root, "schedule.json"), "utf8"),
    );
    assert.equal(spec.thread_id, origin.sessionId);
    assert.equal(spec.delay_seconds, 0);
    assert.equal(spec.kind, "file");
    assert.equal(existsSync(spec.path), false);
    f.store.update(task.id, { status: "running" });
    await runTask(f.store, f.config, task.id);
    assert.equal(f.store.get(task.id).agent, "claude");
    await reconcileDelivery(f.store, f.config);
    assert.equal(f.store.get(task.id).delivery, "queued");
    assert.throws(
      () =>
        acknowledge(f.store, task.id, { ...origin, sessionId: randomUUID() }),
      /matching/,
    );
    assert.equal(
      acknowledge(f.store, task.id, origin).delivery,
      "acknowledged",
    );
  } finally {
    f.cleanup();
  }
});
test("restart marks missing runner interrupted; cancelled queued work never launches", async () => {
  const f = fixture();
  try {
    const a = submit(f.store, f.config, f.input);
    f.store.update(a.id, {
      status: "running",
      runnerPid: 999999,
      runnerIdentity: "absent",
    });
    const b = submit(f.store, f.config, { ...f.input, idempotencyKey: "b" });
    cancel(f.store, b.id);
    await tick(f.store, { ...f.config, snooze: undefined });
    assert.equal(f.store.get(a.id).status, "interrupted");
    assert.equal(f.store.get(b.id).status, "cancelled");
    assert.equal(existsSync(join(f.state, "tasks", a.id, "result.json")), true);
  } finally {
    f.cleanup();
  }
});
test("worker arguments disable recursive MCP and preserve subscription authentication", () => {
  const f = fixture();
  try {
    const c = workerCommand("codex", f.input, f.config, randomUUID());
    assert.ok(c.args.includes("--ignore-user-config"));
    assert.ok(c.args.includes('forced_login_method="chatgpt"'));
    const a = workerCommand("claude", f.input, f.config, randomUUID());
    assert.ok(a.args.includes("--strict-mcp-config"));
    assert.ok(!a.args.includes("--bare"));
    assert.ok(!a.args.includes("--dangerously-skip-permissions"));
    assert.equal(subscriptionEnv().AGENT_DISPATCHER_WORKER, "1");
    assert.equal(subscriptionEnv().OPENAI_API_KEY, undefined);
  } finally {
    f.cleanup();
  }
});
test("malformed output cannot be mistaken for success; output limit is not retryable", () => {
  assert.equal(
    parseOutcome("claude", { code: 0, stdout: "not json", stderr: "" }).kind,
    "failure",
  );
  assert.equal(
    parseOutcome("codex", {
      code: 1,
      stdout: "",
      stderr: "rate limit",
      stopReason: "output_limit",
    }).kind,
    "failure",
  );
});
test("durable service can cancel a live isolated runner", async () => {
  const f = fixture("slow");
  let service: ReturnType<typeof spawn> | undefined;
  try {
    const task = submit(f.store, f.config, f.input);
    service = spawn(
      process.execPath,
      ["dist/src/cli.js", "--state", f.state, "worker"],
      { stdio: "ignore" },
    );
    await eventually(() => !!f.store.get(task.id).workerPid);
    cancel(f.store, task.id);
    await eventually(() => f.store.get(task.id).status === "cancelled");
    await eventually(() => {
      const t = f.store.get(task.id);
      try {
        if (!t.runnerPid) return true;
        process.kill(t.runnerPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(
      existsSync(join(f.state, "tasks", task.id, "result.json")),
      true,
    );
  } finally {
    service?.kill("SIGTERM");
    if (service)
      await new Promise<void>((r) => {
        if (service!.exitCode !== null) r();
        else service!.once("exit", () => r());
      });
    f.cleanup();
  }
});

test("idle scheduler monitoring performs no model or account CLI calls", async () => {
  const f = fixture();
  try {
    await tick(f.store, f.config);
    await tick(f.store, f.config);
    assert.equal(existsSync(join(f.root, "calls.jsonl")), false);
  } finally {
    f.cleanup();
  }
});
test("explicit preference never falls back after a quota error", async () => {
  const f = fixture("quota");
  try {
    const task = submit(f.store, f.config, { ...f.input, prefer: "claude" });
    f.store.update(task.id, { status: "running" });
    await runTask(f.store, f.config, task.id);
    assert.equal(f.store.get(task.id).status, "failed");
    assert.equal(f.store.get(task.id).attempts, 1);
  } finally {
    f.cleanup();
  }
});
