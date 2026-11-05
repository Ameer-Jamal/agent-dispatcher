import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { privateDir, type Agent } from "./config.js";

// Keep account/keychain authentication intact while hiding native extensions from workers.
// Native CLI permission/sandbox controls are layered inside this configuration-only profile.
export function configurationProfile(
  agent: Agent,
  cwd: string,
  home = homedir(),
) {
  const paths =
    agent === "cursor"
      ? [
          join(home, ".cursor/mcp.json"),
          join(home, ".cursor/hooks.json"),
          join(home, ".cursor/plugins"),
          join(cwd, ".cursor/mcp.json"),
          join(cwd, ".cursor/hooks.json"),
          join(cwd, ".cursor/plugins"),
        ]
      : agent === "antigravity"
        ? [
            join(home, ".gemini/config"),
            join(home, ".gemini/antigravity-cli/mcp_config.json"),
            join(cwd, ".agents/mcp_config.json"),
            join(cwd, ".agents/hooks.json"),
            join(cwd, ".agents/plugins"),
          ]
        : agent === "opencode"
          ? [
              join(home, ".config/opencode/opencode.json"),
              join(home, ".config/opencode/opencode.jsonc"),
              join(home, ".config/opencode/plugins"),
              join(cwd, ".opencode"),
              join(cwd, "opencode.json"),
              join(cwd, "opencode.jsonc"),
            ]
          : [];
  const writable =
    agent === "opencode"
      ? `(deny file-write* (require-not (require-any ${[dirname(cwd), tmpdir(), "/private/tmp", "/dev", join(home, ".local/share/opencode"), join(home, ".local/state/opencode"), join(home, ".cache/opencode"), join(home, "Library/Caches/opencode")].map((p) => `(subpath ${JSON.stringify(p)})`).join(" ")})))\n`
      : "";
  return `(version 1)\n(allow default)\n${writable}${agent === "cursor" ? `(deny file-write* (literal ${JSON.stringify(join(cwd, ".cursor/cli.json"))}))\n` : ""}${paths.map((p) => `(deny file-read-data (subpath ${JSON.stringify(p)}))`).join("\n")}\n`;
}
export function isolateCommand(
  agent: Agent,
  command: string,
  args: string[],
  cwd: string,
) {
  if (agent === "codex" || agent === "claude") return { command, args };
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    throw new Error(
      `${agent} worker configuration isolation requires macOS sandbox-exec`,
    );
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", configurationProfile(agent, cwd), command, ...args],
  };
}
export function prepareCursorSettings(artifactDir: string, cwd: string) {
  const path = join(
    privateDir(join(artifactDir, "cursor-config")),
    "cli-config.json",
  );
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      editor: { vimMode: false },
      approvalMode: "allowlist",
      permissions: {
        allow: [
          `Read(${cwd}/**)`,
          `Write(${cwd}/**)`,
          ...["git", "npm", "node", "python3", "ls", "cat", "pwd"].map(
            (c) => `Shell(${c})`,
          ),
        ],
        deny: [
          "Shell(git:push*)",
          "Shell(git:commit*)",
          "Shell(git:merge*)",
          "Shell(agent-dispatcher)",
          "Shell(codex)",
          "Shell(claude)",
          "Shell(agy)",
          "Shell(opencode)",
        ],
      },
      sandbox: { mode: "enabled", networkAccess: "allowlist" },
      attribution: {
        attributeCommitsToAgent: false,
        attributePRsToAgent: false,
      },
    }),
    { mode: 0o600 },
  );
  return path;
}
