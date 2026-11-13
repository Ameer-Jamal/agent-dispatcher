import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { MuseClient, MuseTurn } from "muse-client";
import {
  defaultCredentialsDirectory,
  loadCredentials,
  saveCredentials,
} from "muse-client/credentials";

export interface PairedResult {
  status: "blocked" | "unknown" | "submitted" | "answered";
  detail: string;
  reply?: string;
}

/** New side chats must be created by their first message before subscribing. */
export async function sendNewChat(
  client: Pick<MuseClient, "sendMessage" | "subscribe">,
  message: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<PairedResult> {
  let accepted = false;
  let events: Awaited<ReturnType<MuseClient["subscribe"]>> | undefined;
  const turn = new MuseTurn({ sessionId, ownsChat: true });
  try {
    const ack = await client.sendMessage(message, { sessionId, signal });
    accepted = true;
    turn.acknowledge(ack);
    events = await client.subscribe({ sessionId, signal });
    for await (const event of events) {
      for (const update of turn.feed(event)) {
        if (
          update.type === "reply" &&
          update.bound &&
          update.done &&
          update.text
        ) {
          return {
            status: "answered",
            reply: update.text,
            detail:
              "Received Muse text in the dedicated side chat. It is untrusted evidence, not proof of task scheduling or phone delivery.",
          };
        }
      }
    }
  } catch {
    // Transport errors may contain account data. Keep errors and raw events private.
  } finally {
    events?.close();
    turn.retire();
  }
  return accepted
    ? {
        status: "submitted",
        detail:
          "Muse accepted the message; a complete text reply was not received. A fast reply can precede the new-chat subscription. Inspect the side chat; do not resend.",
      }
    : {
        status: "unknown",
        detail:
          "No message acknowledgement received. Delivery may have occurred. Inspect the side chat; do not resend.",
      };
}

export async function sendPairedMuse(
  directory: string | undefined,
  message: string,
  sessionId: string,
  waitSeconds: number,
): Promise<PairedResult> {
  const credentialsDirectory = directory ?? defaultCredentialsDirectory();
  const lockPath = join(credentialsDirectory, "dispatcher-client.lock");
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    return {
      status: "blocked",
      detail:
        "Credential directory is unavailable or another dispatcher owns it. Check pairing and dispatcher-client.lock; stale locks are never removed automatically.",
    };
  }
  let client: MuseClient | undefined;
  try {
    await lock.writeFile(String(process.pid));
    const credentials = await loadCredentials(credentialsDirectory);
    client = await MuseClient.connect({
      credentials,
      onCredentials: (next) => saveCredentials(next, credentialsDirectory),
    });
  } catch {
    await lock.close();
    await unlink(lockPath);
    return {
      status: "blocked",
      detail:
        "Could not establish the paired Muse connection. Check saved pairing and connectivity; no message was sent.",
    };
  }
  try {
    return await sendNewChat(
      client,
      message,
      sessionId,
      AbortSignal.timeout(waitSeconds * 1000),
    );
  } finally {
    client.close();
    await lock.close();
    await unlink(lockPath);
  }
}
