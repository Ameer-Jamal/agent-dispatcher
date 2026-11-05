import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { z } from "zod";
import { run, subscriptionEnv } from "./process.js";
import type { Config, Agent } from "./config.js";
import { Store, type Usage } from "./store.js";
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
  return { codex: store.meta("auth:codex") === "true", claude };
}
