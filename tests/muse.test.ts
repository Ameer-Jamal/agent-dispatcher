import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseRequests, museStatus } from "../src/muse.js";
import { configSchema } from "../src/config.js";

function fixture(code = 0, extra = "") {
  const state = mkdtempSync(join(tmpdir(), "muse-fixture-"));
  const script = join(state, "fake.cjs");
  const marker = join(state, "calls.jsonl");
  writeFileSync(
    script,
    `const fs = require('node:fs');
    let input=''; process.stdin.on('data', x => input += x);
    process.stdin.on('end', () => {
      fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({args: process.argv.slice(2), input})+'\\n');
      ${extra}
      process.stdout.write('Synthetic Muse reply'); process.exit(${code});
    });`,
  );
  const config = configSchema.parse({
    muse: {
      enabled: true,
      command: process.execPath,
      args: [script],
      waitSeconds: 1,
    },
  });
  const store = new MuseRequests(state);
  return {
    state,
    store,
    config,
    marker,
    cleanup() {
      store.close();
      rmSync(state, { recursive: true, force: true });
    },
  };
}

test("Muse is disabled by default; status does not claim a verified connection", async () => {
  const f = fixture();
  try {
    const config = configSchema.parse({});
    assert.equal(museStatus(config).enabled, false);
    assert.equal(museStatus(config).connectionVerified, false);
    const receipt = await f.store.send(config, {
      message: "test",
      idempotencyKey: "disabled",
    });
    assert.equal(receipt.status, "blocked");
    assert.throws(() => readFileSync(f.marker));
  } finally {
    f.cleanup();
  }
});

test("message uses stdin, stable dedicated side chat, private storage and no shell", async () => {
  const f = fixture();
  try {
    const message =
      "Remind me at 17:00 America/Phoenix; $(echo nope) `echo nope`\n--help";
    const receipt = await f.store.send(f.config, {
      message,
      idempotencyKey: "once",
    });
    assert.equal(receipt.status, "answered");
    assert.equal(receipt.reminderVerified, false);
    assert.equal(receipt.reply, "Synthetic Muse reply");
    const call = JSON.parse(readFileSync(f.marker, "utf8"));
    assert.equal(call.input, message);
    assert.deepEqual(call.args, [
      "--session-id",
      receipt.sessionId,
      "--wait",
      "1",
      "-",
    ]);
    assert.equal(statSync(join(f.state, "muse.sqlite")).mode & 0o777, 0o600);
    assert.deepEqual(f.store.get(receipt.id), receipt);
  } finally {
    f.cleanup();
  }
});

test("concurrent submissions and restarts never resend an idempotency key", async () => {
  const f = fixture();
  try {
    const input = { message: "One test", idempotencyKey: "deduplicate" };
    const [a, b] = await Promise.all([
      f.store.send(f.config, input),
      f.store.send(f.config, input),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(b.status, "unknown");
    const other = new MuseRequests(f.state);
    try {
      assert.equal((await other.send(f.config, input)).id, a.id);
    } finally {
      other.close();
    }
    assert.equal(readFileSync(f.marker, "utf8").trim().split("\n").length, 1);
    await assert.rejects(
      f.store.send(f.config, { ...input, message: "Different" }),
      /different Muse request/,
    );
  } finally {
    f.cleanup();
  }
});

for (const [code, status] of [
  [3, "submitted"],
  [1, "unknown"],
] as const) {
  test(`transport exit ${code} yields ${status} without replay`, async () => {
    const f = fixture(code);
    try {
      const input = { message: "One test", idempotencyKey: "exit" };
      const receipt = await f.store.send(f.config, input);
      assert.equal(receipt.status, status);
      assert.equal(receipt.reminderVerified, false);
      await f.store.send(f.config, input);
      assert.equal(readFileSync(f.marker, "utf8").trim().split("\n").length, 1);
    } finally {
      f.cleanup();
    }
  });
}

test("missing executable is blocked; oversized output stays uncertain", async () => {
  const f = fixture(0, "fs.writeSync(1, 'x'.repeat(150000));");
  try {
    const receipt = await f.store.send(
      {
        ...f.config,
        muse: { ...f.config.muse, command: join(f.state, "absent") },
      },
      { message: "test", idempotencyKey: "absent" },
    );
    assert.equal(receipt.status, "blocked");
    const overflow = await f.store.send(f.config, {
      message: "test",
      idempotencyKey: "overflow",
    });
    assert.equal(overflow.status, "unknown");
    assert.equal(overflow.reply, undefined);
  } finally {
    f.cleanup();
  }
});
