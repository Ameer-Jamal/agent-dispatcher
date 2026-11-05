import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { z } from "zod";

export const Agent = z.enum(["codex", "claude"]);
export type Agent = z.infer<typeof Agent>;
export const configSchema = z.object({
  reservePercent: z.number().min(0).max(100).default(30),
  usageMaxAgeSeconds: z.number().int().min(60).default(180),
  timeoutSeconds: z.number().int().min(10).max(14400).default(1800),
  maxOutputBytes: z.number().int().min(1024).max(50_000_000).default(2_000_000),
  allowedRoots: z.array(z.string()).default([]),
  agents: z
    .object({
      codex: z
        .object({
          command: z.string().default("codex"),
          model: z.string().optional(),
          pool: z.string().default("chatgpt-primary"),
        })
        .prefault({}),
      claude: z
        .object({
          command: z.string().default("claude"),
          model: z.string().optional(),
          pool: z.string().default("claude-primary"),
        })
        .prefault({}),
    })
    .prefault({}),
  snooze: z
    .object({
      command: z.string(),
      args: z.array(z.string()).default([]),
      state: z.string().optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof configSchema>;
export function stateDir() {
  return resolve(
    process.env.AGENT_DISPATCHER_STATE ??
      join(homedir(), ".local/share/agent-dispatcher"),
  );
}
export function privateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
export function loadConfig(state = stateDir()): Config {
  const path = join(state, "config.json");
  return configSchema.parse(
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {},
  );
}
export function initialize(state = stateDir()) {
  privateDir(state);
  const path = join(state, "config.json");
  if (!existsSync(path))
    writeFileSync(
      path,
      JSON.stringify(configSchema.parse({}), null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  return path;
}
export const originSchema = z.object({
  client: Agent,
  sessionId: z.string().uuid(),
});
export const taskSchema = z
  .object({
    goal: z.string().min(1).max(24000),
    cwd: z.string().min(1),
    files: z.array(z.string().min(1)).max(100).default([]),
    acceptanceChecks: z.array(z.string().min(1)).max(30).default([]),
    prefer: Agent.optional(),
    model: z.string().min(1).max(200).optional(),
    capabilityReason: z.string().min(1).max(1000).optional(),
    origin: originSchema.optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .refine((input) => !input.model || !!input.prefer, {
    message: "model requires an explicit prefer agent",
    path: ["model"],
  });
export type TaskInput = z.infer<typeof taskSchema>;
