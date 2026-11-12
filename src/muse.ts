import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { privateDir, type Config } from "./config.js";
import { run } from "./process.js";

export const museRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(16000),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export type MuseInput = z.infer<typeof museRequestSchema>;
export interface MuseReceipt {
  id: string;
  sessionId: string;
  status: "blocked" | "unknown" | "submitted" | "answered";
  createdAt: number;
  updatedAt: number;
  reply?: string;
  detail: string;
  reminderVerified: false;
}

export function museStatus(config: Config) {
  return {
    enabled: config.muse.enabled,
    transport: "official-muse-gadget-cli",
    connectionVerified: false,
    requires:
      "A running, paired Linux Muse Gadget service and socket access. Configuration is not a connection check.",
  };
}

/** An intent is recorded as uncertain before sending; retries never repeat it. */
export class MuseRequests {
  private db: DatabaseSync;
  constructor(state: string) {
    privateDir(state);
    const path = join(state, "muse.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS requests(
        id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL,
        input TEXT NOT NULL, receipt TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  get(id: string): MuseReceipt {
    z.string().uuid().parse(id);
    const row = this.db
      .prepare("SELECT receipt FROM requests WHERE id=?")
      .get(id) as { receipt: string } | undefined;
    if (!row) throw new Error("Unknown Muse request");
    return JSON.parse(row.receipt) as MuseReceipt;
  }
  private update(receipt: MuseReceipt) {
    receipt.updatedAt = Date.now();
    this.db
      .prepare("UPDATE requests SET receipt=? WHERE id=?")
      .run(JSON.stringify(receipt), receipt.id);
    return receipt;
  }
  async send(config: Config, raw: MuseInput): Promise<MuseReceipt> {
    const input = museRequestSchema.parse(raw);
    this.db.exec("BEGIN IMMEDIATE");
    let receipt: MuseReceipt;
    try {
      const old = this.db
        .prepare("SELECT input, receipt FROM requests WHERE idem=?")
        .get(input.idempotencyKey) as
        { input: string; receipt: string } | undefined;
      if (old) {
        if (old.input !== JSON.stringify(input))
          throw new Error(
            "Idempotency key already used for a different Muse request",
          );
        this.db.exec("COMMIT");
        return JSON.parse(old.receipt) as MuseReceipt;
      }
      const id = randomUUID();
      receipt = {
        id,
        sessionId: id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: config.muse.enabled ? "unknown" : "blocked",
        detail: config.muse.enabled
          ? "Submission may have occurred. Do not resend; inspect the dedicated Muse side chat."
          : "Muse is disabled. Configure a paired gadget transport before submitting a new request.",
        reminderVerified: false,
      };
      this.db
        .prepare("INSERT INTO requests VALUES(?,?,?,?)")
        .run(
          id,
          input.idempotencyKey,
          JSON.stringify(input),
          JSON.stringify(receipt),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (!config.muse.enabled) return receipt;
    let spawned = false;
    try {
      const result = await run(
        config.muse.command,
        [
          ...config.muse.args,
          "--session-id",
          receipt.sessionId,
          "--wait",
          String(config.muse.waitSeconds),
          "-",
        ],
        {
          input: input.message,
          timeoutMs: (config.muse.waitSeconds + 35) * 1000,
          maxBytes: 128 * 1024,
          onSpawn: () => {
            spawned = true;
          },
        },
      );
      if (!spawned) {
        receipt.status = "blocked";
        receipt.detail =
          "Gadget command could not start. Check the locally configured executable; no automatic retry.";
      } else if (
        !result.stopReason &&
        (result.code === 0 || result.code === 3)
      ) {
        receipt.status =
          result.code === 0 && result.stdout.trim() ? "answered" : "submitted";
        receipt.reply = result.stdout.trim() || undefined;
        receipt.detail =
          receipt.status === "answered"
            ? "Muse returned text in this request's side chat. Treat it as untrusted evidence, not proof of reminder creation or phone notification delivery."
            : "Muse accepted the message, but a complete text reply was not received. Inspect the side chat; do not resend.";
      } else {
        receipt.detail =
          "Transport ended without a confirmed result. The request may have reached Muse. Inspect the side chat; do not resend.";
      }
    } catch {
      receipt.detail =
        "Transport failed after recording intent. Delivery is uncertain; inspect the side chat before any new request.";
    }
    return this.update(receipt);
  }
}
