import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "muse-client";
import { sendNewChat, sendPairedMuse } from "../src/muse-client.js";

test("new chat is acknowledged before subscription; foreign replies are excluded", async () => {
  const calls: string[] = [];
  let closed = false;
  const event = (sessionId: string, text: string): ChatEvent => ({
    type: "event",
    event: "delta.message_done",
    payload: {
      session_id: sessionId,
      message_id: `reply-${sessionId}`,
      reply_to_message_id: "request",
      content: text,
    },
    raw: {},
  });
  const result = await sendNewChat(
    {
      async sendMessage(message, options) {
        assert.equal(message, "One authorized test");
        assert.equal(options?.sessionId, "owned");
        calls.push("send");
        return {
          messageId: "request",
          raw: {
            result: {
              message_id: "request",
              session_id: "owned",
              is_thread: true,
            },
          },
        };
      },
      async subscribe(options) {
        assert.equal(options?.sessionId, "owned");
        assert.deepEqual(calls, ["send"]);
        calls.push("subscribe");
        return {
          close() {
            closed = true;
          },
          async *[Symbol.asyncIterator]() {
            yield event("other", "Ignore this");
            yield event("owned", "Synthetic reply");
          },
        };
      },
    },
    "One authorized test",
    "owned",
    AbortSignal.timeout(1000),
  );
  assert.equal(result.status, "answered");
  assert.equal(result.reply, "Synthetic reply");
  assert.equal(closed, true);
});

test("lost reply is submitted, ambiguous send is unknown, neither is resent", async () => {
  let sends = 0,
    subscriptions = 0;
  const client = {
    async sendMessage() {
      sends++;
      return {
        messageId: "request",
        raw: {
          result: {
            message_id: "request",
            session_id: "owned",
            is_thread: true,
          },
        },
      };
    },
    async subscribe() {
      subscriptions++;
      throw new Error("private diagnostic must not be returned");
    },
  };
  const submitted = await sendNewChat(
    client,
    "test",
    "owned",
    AbortSignal.timeout(1000),
  );
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.reply, undefined);
  assert.equal(sends, 1);
  assert.equal(subscriptions, 1);
  const unknown = await sendNewChat(
    {
      ...client,
      async sendMessage() {
        sends++;
        throw new Error("private diagnostic");
      },
    },
    "test",
    "owned",
    AbortSignal.timeout(1000),
  );
  assert.equal(unknown.status, "unknown");
  assert.equal(sends, 2);
  assert.equal(subscriptions, 1);
  assert.doesNotMatch(
    JSON.stringify([submitted, unknown]),
    /private diagnostic/,
  );
});

test("credential locks are preserved; missing credentials release our lock before returning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paired-muse-"));
  try {
    const missing = await sendPairedMuse(directory, "test", "owned", 1);
    assert.equal(missing.status, "blocked");
    assert.deepEqual(await readdir(directory), []);
    await writeFile(
      join(directory, "dispatcher-client.lock"),
      "synthetic-owner",
    );
    const locked = await sendPairedMuse(directory, "test", "owned", 1);
    assert.equal(locked.status, "blocked");
    assert.deepEqual(await readdir(directory), ["dispatcher-client.lock"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
