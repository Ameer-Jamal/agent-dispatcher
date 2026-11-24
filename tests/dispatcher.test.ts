import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fixture, eventually } from "./helpers.js";
import {
  submit,
  runTask,
  reconcileDelivery,
  cancel,
  tick,
  acknowledge,
  finish,
  ACK_GRACE_MS,
} from "../src/dispatcher.js";
import { identity } from "../src/process.js";
import { workerCommand, parseOutcome } from "../src/adapters.js";
import { subscriptionEnv } from "../src/process.js";
import { randomUUID } from "node:crypto";
test("preflight rejects required access before queueing a worker", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        submit(f.store, f.config, {
          ...f.input,
          requiredAccess: [
            "connected_tools",
            "external_credentials",
            "interactive_approval",
          ],
        }),
      /before queueing.*connected tools.*authorized account access.*specific permission request/,
    );
    assert.equal(f.store.all().length, 0);
    assert.equal(submit(f.store, f.config, f.input).status, "queued");
  } finally {
    f.cleanup();
  }
});
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
test("exit-zero worker requires explicit completion evidence", () => {
  const claude = (result: string) =>
    parseOutcome("claude", {
      code: 0,
      stdout: JSON.stringify({ result }),
      stderr: "",
    });
  const blocked = "I couldn't fix this: the sandbox denied GitHub and npm.";
  assert.equal(claude(blocked).kind, "permission");
  assert.equal(
    claude(`${blocked}\nDISPATCHER_STATUS: blocked_permission`).kind,
    "permission",
  );
  assert.equal(claude("Unable to finish the required checks.").kind, "failure");
  assert.equal(
    claude("Some checks ran.\nDISPATCHER_STATUS: incomplete").kind,
    "failure",
  );
  const completed = claude(
    "Reviewed permission handling.\nDISPATCHER_STATUS: completed",
  );
  assert.equal(completed.kind, "success");
  assert.equal(completed.summary, "Reviewed permission handling.");
});
test("a recovered native tool denial does not discard completion evidence", () => {
  const completed =
    "Retried the read at the correct path.\nDISPATCHER_STATUS: completed";
  const parse = (result: string, code = 0, is_error = false) =>
    parseOutcome("claude", {
      code,
      stdout: JSON.stringify({
        result,
        is_error,
        permission_denials: [{ tool_name: "Read" }],
      }),
      stderr: "",
    });
  assert.equal(parse(completed).kind, "success");
  assert.equal(parse(completed).nativePermission, true);
  assert.equal(parse(completed, 1).kind, "permission");
  assert.equal(parse(completed, 0, true).kind, "permission");
  assert.equal(
    parse("Required check unfinished.\nDISPATCHER_STATUS: incomplete").kind,
    "permission",
  );
  assert.equal(
    parse(
      "I couldn't finish the check: permission denied.\nDISPATCHER_STATUS: completed",
    ).kind,
    "permission",
  );
});
test("only an unchanged, unpinned review can retry a native tool denial once", async () => {
  for (const { mode, prefer, attempts, status } of [
    { mode: "review-permission", attempts: 2, status: "completed" },
    { mode: "review-permission-twice", attempts: 2, status: "blocked" },
    { mode: "review-permission-dirty", attempts: 1, status: "blocked" },
    {
      mode: "review-permission",
      prefer: "claude" as const,
      attempts: 1,
      status: "blocked",
    },
  ]) {
    const f = fixture(mode);
    try {
      const task = submit(f.store, f.config, {
        ...f.input,
        goal: "Review tracked.txt",
        taskType: "review",
        prefer,
      });
      f.store.update(task.id, { status: "running" });
      await runTask(f.store, f.config, task.id);
      const done = f.store.get(task.id);
      assert.equal(done.attempts, attempts, mode);
      assert.equal(done.status, status, mode);
      const first = JSON.parse(
        readFileSync(join(done.artifactDir!, "attempt-1.json"), "utf8"),
      );
      assert.equal(first.outcome.nativePermission, true);
      if (mode === "review-permission-dirty")
        assert.match(
          readFileSync(join(done.artifactDir!, "changes.patch"), "utf8"),
          /partial/,
        );
    } finally {
      f.cleanup();
    }
  }
});
test("Codex wake waits for the acknowledgement grace and is suppressed after acknowledgement", async () => {
  const f = fixture();
  try {
    const origin = { client: "codex" as const, sessionId: randomUUID() };
    const task = submit(f.store, f.config, { ...f.input, origin });
    f.store.update(task.id, { status: "running" });
    await runTask(f.store, f.config, task.id);
    const path = join(f.state, "tasks", task.id, "result.json");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).status, "completed");
    await reconcileDelivery(f.store, f.config);
    assert.equal(scheduled(f.root), 0);
    assert.equal(f.store.get(task.id).delivery, "pending");
    assert.throws(
      () =>
        acknowledge(f.store, task.id, { ...origin, sessionId: randomUUID() }),
      /matching/,
    );
    assert.equal(
      acknowledge(f.store, task.id, origin).delivery,
      "acknowledged",
    );
    pastGrace(f, task.id);
    await reconcileDelivery(f.store, f.config);
    assert.equal(scheduled(f.root), 0);
    assert.equal(f.store.get(task.id).delivery, "acknowledged");
  } finally {
    f.cleanup();
  }
});
test("an unacknowledged terminal result gets exactly one wake after the grace", async () => {
  const f = fixture();
  try {
    const origin = { client: "codex" as const, sessionId: randomUUID() };
    const task = submit(f.store, f.config, { ...f.input, origin });
    finish(f.store, task.id, { status: "failed" });
    pastGrace(f, task.id);
    await reconcileDelivery(f.store, f.config);
    const spec = JSON.parse(
      readFileSync(join(f.root, "schedule.json"), "utf8"),
    );
    assert.equal(spec.thread_id, origin.sessionId);
    assert.equal(spec.delay_seconds, 0);
    assert.equal(spec.kind, "file");
    assert.equal(JSON.parse(readFileSync(spec.path, "utf8")).status, "failed");
    assert.equal(f.store.get(task.id).snoozeJobId, "snooze-fixture");
    await reconcileDelivery(f.store, f.config);
    await reconcileDelivery(f.store, f.config);
    assert.equal(f.store.get(task.id).delivery, "queued");
    assert.equal(scheduled(f.root), 1);
  } finally {
    f.cleanup();
  }
});
test("legacy job registered before the grace still reconciles without a second wake", async () => {
  const f = fixture();
  try {
    const origin = { client: "codex" as const, sessionId: randomUUID() };
    const task = submit(f.store, f.config, { ...f.input, origin });
    f.store.update(task.id, { snoozeJobId: "snooze-fixture" });
    f.store.update(task.id, { status: "completed" });
    await reconcileDelivery(f.store, f.config);
    assert.equal(f.store.get(task.id).delivery, "queued");
    assert.equal(scheduled(f.root), 0);
  } finally {
    f.cleanup();
  }
});
test("acknowledgement during async registration or reconciliation is never reopened", async () => {
  const f = fixture();
  try {
    const slow = join(f.root, "slow-snooze");
    const started = join(f.root, "started");
    writeFileSync(
      slow,
      `#!/bin/sh\necho "$@" >> "${started}"\nsleep 1\nexec "${f.mock}" "$@"\n`,
      { mode: 0o700 },
    );
    const config = { ...f.config, snooze: { command: slow, args: [] } };
    const origin = { client: "codex" as const, sessionId: randomUUID() };
    const a = submit(f.store, config, { ...f.input, origin });
    finish(f.store, a.id, { status: "completed" });
    pastGrace(f, a.id);
    const registering = reconcileDelivery(f.store, config);
    await eventually(() => f.store.get(a.id).delivery === "sending");
    acknowledge(f.store, a.id, origin);
    await registering;
    assert.equal(f.store.get(a.id).delivery, "acknowledged");
    assert.equal(f.store.get(a.id).snoozeJobId, "snooze-fixture");
    assert.match(readFileSync(started, "utf8"), /^cancel snooze-fixture$/m);
    await reconcileDelivery(f.store, config);
    assert.equal(f.store.get(a.id).delivery, "acknowledged");
    assert.equal(scheduled(f.root), 1);

    const b = submit(f.store, config, {
      ...f.input,
      idempotencyKey: "legacy",
      origin,
    });
    f.store.update(b.id, { snoozeJobId: "snooze-fixture" });
    finish(f.store, b.id, { status: "completed" });
    const reconciling = reconcileDelivery(f.store, config);
    await eventually(() => readFileSync(started, "utf8").includes("events"));
    acknowledge(f.store, b.id, origin);
    await reconciling;
    assert.equal(f.store.get(b.id).delivery, "acknowledged");
    assert.equal(scheduled(f.root), 1);
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

test("pre-taskType idempotency records survive a configuration upgrade", () => {
  const f = fixture();
  try {
    const task = submit(f.store, f.config, f.input);
    const old = JSON.parse(JSON.stringify(task));
    delete old.input.taskType;
    f.store.db
      .prepare("UPDATE tasks SET data=? WHERE id=?")
      .run(JSON.stringify(old), task.id);
    assert.equal(submit(f.store, f.config, f.input).id, task.id);
  } finally {
    f.cleanup();
  }
});

const pastGrace = (f: ReturnType<typeof fixture>, id: string) =>
  f.store.update(id, { finishedAt: Date.now() - ACK_GRACE_MS - 1000 });
const backdate = (f: ReturnType<typeof fixture>, id: string, seconds: number) =>
  f.store.update(id, { createdAt: Date.now() - seconds * 1000 });
const scheduled = (root: string) =>
  existsSync(join(root, "calls.jsonl"))
    ? readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter((line) => JSON.parse(line)[0] === "add").length
    : 0;
test("queued task expires behind a live runner with single, idempotent result and delivery", async () => {
  const f = fixture();
  try {
    const live = submit(f.store, f.config, f.input);
    f.store.update(live.id, {
      status: "running",
      runnerPid: process.pid,
      runnerIdentity: identity(process.pid),
    });
    const origin = { client: "codex" as const, sessionId: randomUUID() };
    const late = submit(f.store, f.config, {
      ...f.input,
      idempotencyKey: "late",
      taskType: "investigation",
      deadlineSeconds: 60,
      origin,
    });
    backdate(f, late.id, 61);
    await tick(f.store, f.config);
    const done = f.store.get(late.id);
    assert.equal(done.status, "expired");
    assert.equal(done.attempts, 0);
    assert.equal(done.runnerPid, undefined);
    assert.match(done.error!, /No work was attempted/);
    assert.equal(done.snoozeJobId, undefined);
    assert.equal(f.store.get(live.id).status, "running");
    const path = join(f.state, "tasks", late.id, "result.json");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).status, "expired");
    await tick(f.store, f.config);
    assert.equal(cancel(f.store, late.id).status, "expired");
    assert.equal(
      finish(f.store, late.id, { status: "completed" }).status,
      "expired",
    );
    pastGrace(f, late.id);
    await tick(f.store, f.config);
    await tick(f.store, f.config);
    assert.equal(scheduled(f.root), 1);
    const spec = JSON.parse(
      readFileSync(join(f.root, "schedule.json"), "utf8"),
    );
    assert.equal(spec.path, path);
    assert.match(spec.title, /result ready/);
    assert.match(spec.instruction, /not that the task succeeded/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).status, "expired");
    assert.equal(
      submit(f.store, f.config, {
        ...f.input,
        idempotencyKey: "late",
        taskType: "investigation",
        deadlineSeconds: 60,
        origin,
      }).id,
      late.id,
    );
  } finally {
    f.cleanup();
  }
});
test("tasks without deadlineSeconds keep unbounded queue wait and old idempotency", async () => {
  const f = fixture();
  try {
    const live = submit(f.store, f.config, f.input);
    f.store.update(live.id, {
      status: "running",
      runnerPid: process.pid,
      runnerIdentity: identity(process.pid),
    });
    const waiting = submit(f.store, f.config, {
      ...f.input,
      idempotencyKey: "waiting",
    });
    assert.equal("deadlineSeconds" in waiting.input, false);
    backdate(f, waiting.id, 86400 * 2);
    await tick(f.store, { ...f.config, snooze: undefined });
    assert.equal(f.store.get(waiting.id).status, "queued");
    assert.equal(
      submit(f.store, f.config, { ...f.input, idempotencyKey: "waiting" }).id,
      waiting.id,
    );
  } finally {
    f.cleanup();
  }
});
test("running attempt is clamped to the remaining deadline and keeps artifacts", async () => {
  const f = fixture("slow");
  try {
    const task = submit(f.store, f.config, { ...f.input, deadlineSeconds: 60 });
    backdate(f, task.id, 55);
    f.store.update(task.id, { status: "running" });
    const started = Date.now();
    await runTask(f.store, f.config, task.id);
    assert.ok(Date.now() - started < 15000);
    const done = f.store.get(task.id);
    assert.equal(done.status, "expired");
    assert.equal(done.attempts, 1);
    assert.match(done.summary!, /during attempt 1/);
    const attempt = JSON.parse(
      readFileSync(join(done.artifactDir!, "attempt-1.json"), "utf8"),
    );
    assert.equal(attempt.stopReason, "timeout");
    assert.equal(existsSync(join(done.artifactDir!, "changes.patch")), true);
    assert.equal(
      JSON.parse(
        readFileSync(join(f.state, "tasks", task.id, "result.json"), "utf8"),
      ).status,
      "expired",
    );
  } finally {
    f.cleanup();
  }
});
test("service stops a runner that overruns its deadline through the cancellation path", async () => {
  const f = fixture();
  const runner = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const task = submit(f.store, f.config, { ...f.input, deadlineSeconds: 60 });
    backdate(f, task.id, 121);
    f.store.update(task.id, {
      status: "running",
      runnerPid: runner.pid,
      runnerIdentity: identity(runner.pid!),
    });
    const exited = new Promise((r) => runner.once("exit", r));
    await tick(f.store, { ...f.config, snooze: undefined });
    assert.equal(f.store.get(task.id).status, "expired");
    await exited;
  } finally {
    runner.kill("SIGKILL");
    f.cleanup();
  }
});
