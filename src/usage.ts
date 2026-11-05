import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { run, subscriptionEnv } from "./process.js";
import type { Config, Agent } from "./config.js";
import { Store, type Usage } from "./store.js";
import { agents } from "./config.js";
import { isolateCommand } from "./isolation.js";
const bucket = z.object({
  primary: z
    .object({
      usedPercent: z.number().min(0).max(100),
      windowDurationMins: z.number().nullable().optional(),
      resetsAt: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  secondary: z
    .object({
      usedPercent: z.number().min(0).max(100),
      windowDurationMins: z.number().nullable().optional(),
      resetsAt: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export function parseLimits(value: unknown, pool: string): Usage {
  const parsed = z
    .object({
      rateLimits: bucket.optional(),
      rateLimitsByLimitId: z.record(z.string(), bucket).optional(),
    })
    .parse(value);
  const buckets =
    parsed.rateLimitsByLimitId && Object.keys(parsed.rateLimitsByLimitId).length
      ? Object.entries(parsed.rateLimitsByLimitId)
      : parsed.rateLimits
        ? [["default", parsed.rateLimits] as const]
        : [];
  const windows = buckets
    .flatMap(([id, b]) => [
      b.primary ? { ...b.primary, id, kind: "primary" } : undefined,
      b.secondary ? { ...b.secondary, id, kind: "secondary" } : undefined,
    ])
    .filter((v): v is NonNullable<typeof v> => !!v);
  if (!windows.length)
    throw new Error("Rate limit response contains no measured windows");
  const limiting = windows.reduce((a, b) =>
    a.usedPercent > b.usedPercent ? a : b,
  );
  return {
    agent: "codex",
    pool,
    quality: "measured",
    observedAt: Date.now(),
    remainingPercent: Math.max(0, 100 - limiting.usedPercent),
    resetsAt: limiting.resetsAt ? limiting.resetsAt * 1000 : undefined,
    note: "Minimum headroom across all reported allowance windows",
    windows: windows.map((w) => ({
      id: w.id,
      kind: w.kind,
      windowMinutes: w.windowDurationMins,
      remainingPercent: Math.max(0, 100 - w.usedPercent),
      resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined,
    })),
  };
}
export async function codexAccount(
  config: Config,
): Promise<{ subscription: boolean; limits: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.agents.codex.command,
      ["app-server", "--listen", "stdio://"],
      {
        env: subscriptionEnv(),
        cwd: homedir(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    let methodPending = "starting";
    let buffer = "",
      bytes = 0,
      seq = 0,
      finished = false;
    const requests = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const finish = (
      e?: Error,
      result?: { subscription: boolean; limits: unknown },
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* exited */
      }
      if (e) reject(e);
      else resolve(result!);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(`Codex account inspection timed out at ${methodPending}`),
        ),
      30000,
    );
    const rpc = (method: string, params: unknown = {}) =>
      new Promise<unknown>((resolve, reject) => {
        methodPending = method;
        const id = ++seq;
        requests.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        finish(new Error("Account inspection output limit"));
        return;
      }
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const msg = JSON.parse(line);
          const pending = requests.get(msg.id);
          if (pending) {
            requests.delete(msg.id);
            if (msg.error) pending.reject(new Error(String(msg.error.message)));
            else pending.resolve(msg.result);
          }
        } catch {
          /* ignore diagnostic lines */
        }
      }
    });
    child.stderr.resume();
    child.on("error", (e) => finish(e));
    child.on("close", () => {
      if (!finished) finish(new Error("Codex account process exited"));
    });
    void (async () => {
      try {
        await rpc("initialize", {
          clientInfo: { name: "agent_dispatcher", version: "0.1.0" },
          capabilities: {},
        });
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        const account = (await rpc("account/read", {
          refreshToken: false,
        })) as { account?: { type?: string } | null };
        const subscription = account.account?.type === "chatgpt";
        const limits = subscription
          ? await rpc("account/rateLimits/read").catch(() => undefined)
          : undefined;
        finish(undefined, { subscription, limits });
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}
export async function refreshUsage(
  store: Store,
  config: Config,
  force = false,
) {
  const previous = store.usage("codex");
  // A forced post-task refresh still respects the one-minute ceiling.
  if (!force && previous && Date.now() - previous.observedAt < 60000) return;
  const last = Number(store.meta("usageAttempt") ?? 0);
  if (Date.now() - last < 60000) return;
  store.setMeta("usageAttempt", String(Date.now()));
  let authVerified = false;
  try {
    const result = await codexAccount(config);
    authVerified = result.subscription;
    store.setMeta("auth:codex", String(result.subscription));
    if (!result.subscription)
      throw new Error("Codex is not authenticated with ChatGPT");
    store.setUsage({
      ...store.usage("codex"),
      ...parseLimits(result.limits, config.agents.codex.pool),
    });
  } catch (e) {
    if (!authVerified) store.setMeta("auth:codex", "false");
    store.setUsage({
      agent: "codex",
      pool: config.agents.codex.pool,
      quality: "unknown",
      observedAt: Date.now(),
      note: String(e),
    });
  }
}
export async function availability(
  config: Config,
  store: Store,
): Promise<Record<Agent, boolean>> {
  const result = await run(
    config.agents.claude.command,
    ["auth", "status", "--json"],
    { env: subscriptionEnv(), cwd: homedir() },
  );
  let claude = false;
  try {
    const auth = JSON.parse(result.stdout);
    claude =
      result.code === 0 &&
      auth.loggedIn === true &&
      auth.authMethod === "claude.ai";
  } catch {
    /* unavailable */
  }
  store.setMeta("auth:claude", String(claude));
  if (!store.usage("claude"))
    store.setUsage({
      agent: "claude",
      pool: config.agents.claude.pool,
      quality: "unknown",
      observedAt: Date.now(),
      note: "No supported remaining-allowance API; subscription authentication checked separately",
    });
  if (store.meta("auth:codex") !== "true") {
    const local = await run(config.agents.codex.command, ["login", "status"], {
      env: subscriptionEnv(),
      cwd: homedir(),
    });
    store.setMeta(
      "auth:codex",
      String(
        local.code === 0 &&
          /logged in using chatgpt/i.test(local.stdout + local.stderr),
      ),
    );
  }
  const available: Record<Agent, boolean> = {
    codex: store.meta("auth:codex") === "true",
    claude,
    cursor: false,
    antigravity: false,
    opencode: false,
  };
  await Promise.all(
    agents
      .filter((a) => !["codex", "claude"].includes(a))
      .map(async (agent) => {
        if (!config.agents[agent].enabled) {
          store.setMeta(`auth:${agent}`, "false");
          return;
        }
        const last = Number(store.meta(`authAttempt:${agent}`) ?? 0);
        if (Date.now() - last < 60000) {
          available[agent] = store.meta(`auth:${agent}`) === "true";
          return;
        }
        store.setMeta(`authAttempt:${agent}`, String(Date.now()));
        try {
          if (process.platform !== "darwin")
            throw new Error(
              "Additional worker configuration isolation requires macOS",
            );
          if (agent === "antigravity") {
            const native = isolateCommand(
              agent,
              config.agents[agent].command,
              [
                "-p",
                "/usage",
                "--output-format",
                "json",
                "--print-timeout",
                "15s",
                "--settings",
                '{"modelProvider":"","useG1Credits":false}',
              ],
              homedir(),
            );
            const result = await run(native.command, native.args, {
              cwd: homedir(),
              env: subscriptionEnv(),
              timeoutMs: 20000,
            });
            if (result.code || result.stopReason)
              throw new Error("Antigravity subscription quota probe failed");
            const u = parseAntigravityUsage(
              JSON.parse(result.stdout),
              config.agents[agent].pool,
              config.agents[agent].model,
            );
            store.setUsage({ ...store.usage(agent), ...u });
            available[agent] = true;
          } else if (agent === "cursor") {
            const result = await run(config.agents[agent].command, ["status"], {
              cwd: homedir(),
              env: { ...subscriptionEnv(), NO_OPEN_BROWSER: "1" },
            });
            const text = stripVTControlCharacters(
              result.stdout + result.stderr,
            );
            available[agent] =
              result.code === 0 &&
              !/not logged in|api.?key/i.test(text) &&
              /logged in|login successful/i.test(text);
            if (!available[agent])
              throw new Error("Cursor account login is unavailable");
            const models = await run(config.agents[agent].command, ["models"], {
              cwd: homedir(),
              env: { ...subscriptionEnv(), NO_OPEN_BROWSER: "1" },
            });
            if (
              models.code ||
              models.stopReason ||
              /no models available|authentication required|not logged in/i.test(
                models.stdout + models.stderr,
              )
            )
              throw new Error(
                "Cursor CLI has no accessible models; run agent login and verify agent models",
              );
            if (!store.usage(agent))
              store.setUsage({
                agent,
                pool: config.agents[agent].pool,
                quality: "unknown",
                observedAt: Date.now(),
                note: "Account login verified; remaining Cursor allowance and plan tier are not exposed by this CLI",
              });
          } else if (agent === "opencode") {
            const version = await run(
              config.agents[agent].command,
              ["--version"],
              { cwd: homedir(), env: subscriptionEnv() },
            );
            if (version.code || !supportsOpenCodePolicy(version.stdout))
              throw new Error(
                "OpenCode V2 2.2.3+ is required for worker policies",
              );
            if (!config.agents.opencode.model?.startsWith("opencode-go/"))
              throw new Error(
                "OpenCode must be pinned to the Go subscription provider",
              );
            const result = await run(
              config.agents[agent].command,
              ["auth", "list", "--format", "json"],
              { cwd: homedir(), env: subscriptionEnv() },
            );
            const auth = z
              .array(
                z.object({
                  id: z.string(),
                  connections: z.array(
                    z.object({
                      type: z.string(),
                      method: z.string().optional(),
                    }),
                  ),
                }),
              )
              .parse(JSON.parse(result.stdout));
            available[agent] =
              result.code === 0 &&
              auth.some(
                (p) =>
                  p.id === "opencode-go" &&
                  p.connections.some((c) => c.type === "credential"),
              );
            if (!available[agent])
              throw new Error("OpenCode Go credential not configured");
            if (!store.usage(agent))
              store.setUsage({
                agent,
                pool: config.agents[agent].pool,
                quality: "unknown",
                observedAt: Date.now(),
                note: "Go credential verified; Go allowance is not exposed by this CLI. Other providers are prohibited for dispatcher workers.",
              });
          }
          store.setMeta(`auth:${agent}`, String(available[agent]));
        } catch (e) {
          available[agent] = false;
          store.setMeta(`auth:${agent}`, "false");
          store.setUsage({
            agent,
            pool: config.agents[agent].pool,
            quality: "unknown",
            observedAt: Date.now(),
            note: String(e),
          });
        }
      }),
  );
  return Object.fromEntries(
    agents.map((a) => [a, config.agents[a].enabled && available[a]]),
  ) as Record<Agent, boolean>;
}

export function parseAntigravityUsage(
  value: unknown,
  pool: string,
  model = "Gemini",
): Usage {
  const fraction = z.object({
    id: z.string(),
    window: z.string(),
    remaining_fraction: z.number().min(0).max(1),
    reset_time: z.string(),
  });
  const response = z
    .object({
      status: z.literal("SUCCESS"),
      num_turns: z.literal(0),
      usage: z.object({ total_tokens: z.literal(0) }),
      command: z.object({
        name: z.literal("usage"),
        data: z.object({
          groups: z.array(
            z.object({ name: z.string(), buckets: z.array(fraction) }),
          ),
        }),
      }),
    })
    .parse(value);
  const windows = response.command.data.groups.flatMap((group) =>
    group.buckets.map((b) => ({
      id: b.id,
      kind: b.window,
      group: group.name,
      windowMinutes:
        b.window === "5h" ? 300 : b.window === "weekly" ? 10080 : undefined,
      remainingPercent: b.remaining_fraction * 100,
      resetsAt: Date.parse(b.reset_time),
    })),
  );
  const thirdParty = /claude|gpt|opus|sonnet/i.test(model);
  const applicable = windows.filter((w) =>
    thirdParty ? /claude|gpt/i.test(w.group) : /gemini/i.test(w.group),
  );
  if (
    !applicable.length ||
    applicable.some((w) => !Number.isFinite(w.resetsAt))
  )
    throw new Error(
      "No valid Antigravity quota windows for the configured model group",
    );
  const limiting = applicable.reduce((a, b) =>
    a.remainingPercent < b.remainingPercent ? a : b,
  );
  return {
    agent: "antigravity",
    pool,
    quality: "measured",
    observedAt: Date.now(),
    remainingPercent: limiting.remainingPercent,
    resetsAt: limiting.resetsAt,
    windows,
    note: `Measured ${thirdParty ? "Claude/GPT" : "Gemini"} group headroom; /usage used zero turns and zero tokens`,
  };
}

export function supportsOpenCodePolicy(version: string) {
  const match = version.match(/(?:v)?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major === 2 && (minor! > 2 || (minor === 2 && patch! >= 3));
}
