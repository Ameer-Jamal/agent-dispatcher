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

export const Agent = z.enum([
  "codex",
  "claude",
  "cursor",
  "antigravity",
  "opencode",
]);
export type Agent = z.infer<typeof Agent>;
export const agents = Agent.options;
export const TaskType = z.enum([
  "implementation",
  "investigation",
  "review",
  "maintenance",
]);
const workerConfig = (
  command: string,
  pool: string,
  enabled: boolean,
  model?: string,
) =>
  z
    .object({
      command: z.string().default(command),
      model: model ? z.string().default(model) : z.string().optional(),
      pool: z.string().default(pool),
      enabled: z.boolean().default(enabled),
    })
    .prefault({});
export const configSchema = z.object({
  muse: z
    .object({
      enabled: z.boolean().default(false),
      transport: z.enum(["gadget-cli", "muse-client"]).default("gadget-cli"),
      credentialsDirectory: z.string().min(1).optional(),
      command: z.string().min(1).default("musegadget"),
      args: z.array(z.string()).default(["send-user-msg"]),
      waitSeconds: z.number().int().min(1).max(60).default(30),
    })
    .prefault({}),
  reservePercent: z.number().min(0).max(100).default(30),
  usageMaxAgeSeconds: z.number().int().min(60).default(180),
  timeoutSeconds: z.number().int().min(10).max(14400).default(1800),
  maxOutputBytes: z.number().int().min(1024).max(50_000_000).default(2_000_000),
  allowedRoots: z.array(z.string()).default([]),
  agents: z
    .object({
      codex: workerConfig("codex", "chatgpt-primary", true),
      claude: workerConfig("claude", "claude-primary", true),
      cursor: workerConfig("agent", "cursor-primary", false, "auto"),
      antigravity: workerConfig(
        "agy",
        "antigravity-primary",
        false,
        "Gemini 3.8 Flash (High)",
      ),
      opencode: workerConfig(
        "opencode",
        "opencode-go-primary",
        false,
        "opencode-go/minimax-m3",
      ),
    })
    .prefault({}),
  routing: z
    .object({
      implementation: z
        .array(Agent)
        .min(1)
        .default(["claude", "cursor", "antigravity", "opencode", "codex"]),
      investigation: z
        .array(Agent)
        .min(1)
        .default(["claude", "antigravity", "cursor", "opencode", "codex"]),
      review: z
        .array(Agent)
        .min(1)
        .default(["antigravity", "claude", "cursor", "opencode", "codex"]),
      maintenance: z
        .array(Agent)
        .min(1)
        .default(["opencode", "claude", "antigravity", "cursor", "codex"]),
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
  client: z.enum(["codex", "claude"]),
  sessionId: z.string().uuid(),
});
export const taskSchema = z
  .object({
    goal: z.string().min(1).max(24000),
    cwd: z.string().min(1),
    files: z.array(z.string().min(1)).max(100).default([]),
    acceptanceChecks: z.array(z.string().min(1)).max(30).default([]),
    taskType: TaskType.default("implementation").describe(
      "Use maintenance for routine test updates, mechanical renames, formatting, dependency updates and small bounded fixes (OpenCode first). Use implementation for substantial features/complex fixes (Claude first), investigation for broad debugging/research, and review for independent review. Choose by the actual work, not by whether it edits code.",
    ),
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
