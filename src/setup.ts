import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { run } from "./process.js";
import { entry } from "./dispatcher.js";
import { coordinatorInstructions } from "./mcp.js";
import { initialize, loadConfig, configSchema, type Config } from "./config.js";
const label = "com.ameer-jamal.agent-dispatcher";
const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function launchAgent(state: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath, entry, "--state", state, "worker"].map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>StandardOutPath</key><string>${xml(join(state, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(join(state, "service-error.log"))}</string></dict></plist>\n`;
}
export async function service(
  state: string,
  action: "install" | "stop" | "start" | "uninstall",
) {
  if (process.platform !== "darwin")
    throw new Error(
      "LaunchAgent management requires macOS; run worker under your service manager",
    );
  const target = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
  const domain = `gui/${process.getuid!()}`;
  if (action === "stop" || action === "uninstall") {
    await run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
    if (action === "uninstall") rmSync(target, { force: true });
    return { action, stateRetained: true };
  }
  if (action === "install") {
    initialize(state);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) copyFileSync(target, `${target}.${Date.now()}.bak`);
    writeFileSync(target, launchAgent(state), { mode: 0o600 });
    await run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
    const r = await run("/bin/launchctl", ["bootstrap", domain, target]);
    if (r.code) throw new Error(`LaunchAgent bootstrap failed: ${r.stderr}`);
  } else {
    if (!existsSync(target))
      throw new Error("Install the service before starting it");
    const loaded = await run("/bin/launchctl", ["bootstrap", domain, target]);
    if (loaded.code) {
      const r = await run("/bin/launchctl", [
        "kickstart",
        `${domain}/${label}`,
      ]);
      if (r.code) throw new Error(r.stderr || loaded.stderr);
    }
  }
  return { action, plist: target };
}
function backup(path: string) {
  if (existsSync(path)) copyFileSync(path, `${path}.${Date.now()}.bak`);
}
export async function setup(state: string, roots: string[]) {
  initialize(state);
  let config = loadConfig(state);
  if (roots.length)
    config = {
      ...config,
      allowedRoots: [...new Set([...config.allowedRoots, ...roots])],
    };
  if (!config.snooze) {
    const code =
      "import tomllib,json,pathlib; p=pathlib.Path.home()/'.codex/config.toml'; s=tomllib.loads(p.read_text()).get('mcp_servers',{}).get('snooze',{}); print(json.dumps({'command':s.get('command'),'args':s.get('args',[]),'state':s.get('env',{}).get('SNOOZE_STATE')}))";
    const r = await run("python3", ["-c", code]);
    try {
      const s = JSON.parse(r.stdout);
      if (s.command) {
        if (s.args.at(-1) === "serve") s.args.pop();
        config = { ...config, snooze: s };
      }
    } catch {
      /* optional integration */
    }
  }
  const path = join(state, "config.json");
  backup(path);
  writeFileSync(
    path,
    JSON.stringify(configSchema.parse(config), null, 2) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(join(state, "COORDINATOR.md"), coordinatorInstructions + "\n", {
    mode: 0o600,
  });
  return {
    config: path,
    instructions: join(state, "COORDINATOR.md"),
    allowedRoots: config.allowedRoots,
    snooze: config.snooze ? "detected" : "not configured",
    next: "Run register, doctor and service install. Claude completion push requires the claude launcher.",
  };
}
export function registerClients(state: string) {
  const codexPath = join(homedir(), ".codex/config.toml");
  mkdirSync(dirname(codexPath), { recursive: true });
  let text = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
  if (!/^\[mcp_servers\.agent-dispatcher\]/m.test(text)) {
    backup(codexPath);
    text += `\n[mcp_servers.agent-dispatcher]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([entry, "--state", state, "serve"])}\n`;
    writeFileSync(codexPath, text, { mode: 0o600 });
  }
  const claudePath = join(homedir(), ".claude.json");
  const claude = existsSync(claudePath)
    ? JSON.parse(readFileSync(claudePath, "utf8"))
    : {};
  claude.mcpServers ??= {};
  if (!claude.mcpServers["agent-dispatcher"]) {
    backup(claudePath);
    claude.mcpServers["agent-dispatcher"] = {
      type: "stdio",
      command: process.execPath,
      args: [entry, "--state", state, "serve"],
    };
    writeFileSync(claudePath, JSON.stringify(claude, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  return {
    codex: codexPath,
    claude: claudePath,
    note: "Existing entries preserved. Reconnect clients. Coordinator instructions are supplied by the MCP server.",
  };
}
export function unregisterClients(state: string) {
  const removed: string[] = [];
  const codexPath = join(homedir(), ".codex/config.toml");
  if (existsSync(codexPath)) {
    const text = readFileSync(codexPath, "utf8");
    const block = text.match(
      /^\[mcp_servers\.agent-dispatcher\][\s\S]*?(?=^\[|$(?![\s\S]))/m,
    )?.[0];
    if (
      block?.includes(`command = ${JSON.stringify(process.execPath)}`) &&
      block.includes(
        `args = ${JSON.stringify([entry, "--state", state, "serve"])}`,
      )
    ) {
      backup(codexPath);
      writeFileSync(codexPath, text.replace(block, ""), { mode: 0o600 });
      removed.push("codex");
    }
  }
  const claudePath = join(homedir(), ".claude.json");
  if (existsSync(claudePath)) {
    const config = JSON.parse(readFileSync(claudePath, "utf8"));
    const item = config.mcpServers?.["agent-dispatcher"];
    if (
      item?.command === process.execPath &&
      JSON.stringify(item.args) ===
        JSON.stringify([entry, "--state", state, "serve"])
    ) {
      delete config.mcpServers["agent-dispatcher"];
      backup(claudePath);
      writeFileSync(claudePath, JSON.stringify(config, null, 2) + "\n", {
        mode: 0o600,
      });
      removed.push("claude");
    }
  }
  return {
    removed,
    stateRetained: true,
    note: "Custom or nonmatching entries retained",
  };
}
export async function launchClaude(
  state: string,
  config: Config,
  args: string[],
) {
  const resume = args.indexOf("--resume");
  const sessionId = resume >= 0 ? args[resume + 1] : randomUUID();
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId))
    throw new Error("Resume requires an exact session UUID");
  if (
    args.includes("--session-id") ||
    args.includes("--continue") ||
    args.includes("-c")
  )
    throw new Error("Use --resume UUID to reconnect the exact channel session");
  const path = join(state, `claude-channel-${sessionId}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        "agent-dispatcher": {
          command: process.execPath,
          args: [entry, "--state", state, "serve", "--channel"],
          env: { AGENT_DISPATCHER_CLAUDE_SESSION: sessionId },
        },
      },
    }),
    { mode: 0o600 },
  );
  const extra = resume >= 0 ? [] : ["--session-id", sessionId];
  const child = spawn(
    config.agents.claude.command,
    [
      ...args,
      ...extra,
      "--mcp-config",
      path,
      "--dangerously-load-development-channels",
      "server:agent-dispatcher",
    ],
    { stdio: "inherit" },
  );
  return new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
