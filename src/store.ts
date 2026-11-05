import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { privateDir, type Agent, type TaskInput } from "./config.js";
export type Status =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted";
export type Delivery =
  | "pending"
  | "inbox"
  | "sending"
  | "queued"
  | "delivered"
  | "acknowledged"
  | "failed"
  | "unknown";
export interface Task {
  id: string;
  input: TaskInput;
  status: Status;
  createdAt: number;
  updatedAt: number;
  agent?: Agent;
  reason?: string;
  attempts: number;
  runnerPid?: number;
  runnerIdentity?: string;
  workerSessionId?: string;
  workerPid?: number;
  workerIdentity?: string;
  worktree?: string;
  baseCommit?: string;
  artifactDir?: string;
  summary?: string;
  error?: string;
  delivery: Delivery;
  snoozeJobId?: string;
}
export interface Usage {
  agent: Agent;
  pool: string;
  quality: "measured" | "estimated" | "unknown";
  observedAt: number;
  remainingPercent?: number;
  resetsAt?: number;
  blockedUntil?: number;
  note?: string;
  lastTaskTokens?: number;
  windows?: {
    id: string;
    kind: string;
    windowMinutes?: number | null;
    remainingPercent: number;
    resetsAt?: number;
  }[];
}
export class Store {
  db: DatabaseSync;
  constructor(public state: string) {
    privateDir(state);
    const path = join(state, "dispatcher.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(agent TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  create(input: TaskInput): Task {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT data FROM tasks WHERE idem=?")
        .get(input.idempotencyKey) as { data: string } | undefined;
      if (old) {
        const task = JSON.parse(old.data) as Task;
        if (JSON.stringify(task.input) !== JSON.stringify(input))
          throw new Error(
            "Idempotency key already belongs to a different task",
          );
        this.db.exec("COMMIT");
        return task;
      }
      const now = Date.now();
      const task: Task = {
        id: randomUUID(),
        input,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        delivery: input.origin ? "pending" : "inbox",
      };
      this.db
        .prepare("INSERT INTO tasks VALUES(?,?,?)")
        .run(task.id, input.idempotencyKey, JSON.stringify(task));
      this.db.exec("COMMIT");
      return task;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get(id: string): Task {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id) as
      { data: string } | undefined;
    if (!row) throw new Error("Task not found");
    return JSON.parse(row.data);
  }
  list(limit = 50): Task[] {
    return (
      this.db
        .prepare("SELECT data FROM tasks ORDER BY rowid DESC LIMIT ?")
        .all(limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  all(): Task[] {
    return (
      this.db.prepare("SELECT data FROM tasks ORDER BY rowid").all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  update(id: string, patch: Partial<Task>): Task {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = { ...this.get(id), ...patch, updatedAt: Date.now() };
      this.db
        .prepare("UPDATE tasks SET data=? WHERE id=?")
        .run(JSON.stringify(task), id);
      this.db.exec("COMMIT");
      return task;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  claimDelivery(id: string, allowed: Delivery[]): Task | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.get(id);
      if (!allowed.includes(task.delivery)) {
        this.db.exec("COMMIT");
        return undefined;
      }
      task.delivery = "sending";
      task.updatedAt = Date.now();
      this.db
        .prepare("UPDATE tasks SET data=? WHERE id=?")
        .run(JSON.stringify(task), id);
      this.db.exec("COMMIT");
      return task;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  usage(agent: Agent): Usage | undefined {
    const row = this.db
      .prepare("SELECT data FROM usage WHERE agent=?")
      .get(agent) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  setUsage(u: Usage) {
    this.db
      .prepare("INSERT OR REPLACE INTO usage VALUES(?,?)")
      .run(u.agent, JSON.stringify(u));
  }
  meta(key: string) {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta VALUES(?,?)").run(key, value);
  }
  close() {
    this.db.close();
  }
}
export const terminal = (s: Status) => !["queued", "running"].includes(s);
