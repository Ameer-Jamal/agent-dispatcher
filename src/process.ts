import { spawn, execFileSync } from "node:child_process";
export function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, AGENT_DISPATCHER_WORKER: "1" };
  for (const key of Object.keys(env)) {
    if (
      /^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_ACCESS_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_API_KEY|GEMINI_API_KEY|GEMINI_BASE_URL|CURSOR_API_KEY|CURSOR_AUTH_TOKEN|AGY_ADC_AUTH|AGY_LLM_GATEWAY_)/.test(
        key,
      )
    )
      delete (env as NodeJS.ProcessEnv)[key];
  }
  delete (env as NodeJS.ProcessEnv).CLAUDECODE;
  for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_API_KEY",
    "CURSOR_CONFIG_DIR",
    "ANTIGRAVITY_GEMINI_DIR",
  ])
    delete (env as NodeJS.ProcessEnv)[key];
  return env;
}
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  stopReason?: string;
}
export function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxBytes?: number;
    input?: string;
    signal?: AbortSignal;
    onSpawn?: (pid: number) => void;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      bytes = 0,
      stopReason: string | undefined,
      settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...(options.env ?? process.env),
        ...(options.cwd ? { PWD: options.cwd } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* exited */
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* exited */
        }
      }, 1000);
      killTimer.unref();
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 15000);
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const data = (kind: "stdout" | "stderr", chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 2_000_000)) {
        stop("output_limit");
        return;
      }
      if (kind === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", (c: Buffer) => data("stdout", c));
    child.stderr.on("data", (c: Buffer) => data("stderr", c));
    if (child.pid) options.onSpawn?.(child.pid);
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr, stopReason });
    };
    child.on("error", (e) => {
      stderr += e.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}
export function identity(pid: number): string | undefined {
  try {
    return (
      execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}
export function sameProcess(pid?: number, birth?: string) {
  return !!pid && !!birth && identity(pid) === birth;
}
