import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parse, modify, applyEdits, type ParseError } from "jsonc-parser";
import { coordinatorInstructions } from "./coordinator.js";
import { entry } from "./dispatcher.js";

const start = "<!-- agent-dispatcher:managed:start -->";
const end = "<!-- agent-dispatcher:managed:end -->";
function save(path: string, before: string, after: string) {
  if (before === after) return;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.${Date.now()}.bak`);
  writeFileSync(path, after, { mode: 0o600 });
}
function managedPolicy(path: string, remove: boolean) {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const first = before.indexOf(start),
    last = before.indexOf(end);
  if (first < 0 !== last < 0 || (first >= 0 && last < first))
    throw new Error(`Malformed managed policy: ${path}`);
  const block = `${start}\n${coordinatorInstructions}\n${end}`;
  const after =
    first >= 0
      ? before.slice(0, first) +
        (remove ? "" : block) +
        before.slice(last + end.length)
      : remove
        ? before
        : before +
          (before.endsWith("\n") || !before ? "" : "\n") +
          block +
          "\n";
  save(path, before, after);
}
function edit(path: string, keys: string[], value: unknown, remove: boolean) {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
  const errors: ParseError[] = [];
  const data = parse(before, errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== "object" || Array.isArray(data))
    throw new Error(`Invalid configuration: ${path}`);
  const old = keys.reduce((v, key) => v?.[key], data);
  // Preserve custom entries; uninstall only removes the exact generated value.
  if (
    remove ? JSON.stringify(old) !== JSON.stringify(value) : old !== undefined
  )
    return;
  const after = applyEdits(
    before,
    modify(before, keys, remove ? undefined : value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
  save(path, before, after);
}
// Hook commands run in a shell in native clients; quote each argument separately.
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function installClientPolicies(
  state: string,
  remove = false,
  home = homedir(),
) {
  const policies = [
    existsSync(join(home, ".codex/AGENTS.override.md"))
      ? ".codex/AGENTS.override.md"
      : ".codex/AGENTS.md",
    ".claude/CLAUDE.md",
    ".gemini/AGENTS.md",
    ".config/opencode/AGENTS.md",
  ].map((p) => join(home, p));
  for (const path of policies) managedPolicy(path, remove);
  const mcp = {
    command: process.execPath,
    args: [entry, "--state", state, "serve"],
  };
  for (const path of [
    ".cursor/mcp.json",
    ".gemini/config/mcp_config.json",
    ".gemini/antigravity-cli/mcp_config.json",
  ])
    edit(join(home, path), ["mcpServers", "agent-dispatcher"], mcp, remove);
  const openCode = join(
    home,
    ".config/opencode",
    existsSync(join(home, ".config/opencode/opencode.jsonc"))
      ? "opencode.jsonc"
      : "opencode.json",
  );
  edit(
    openCode,
    ["mcp", "servers", "agent-dispatcher"],
    { type: "local", command: [process.execPath, ...mcp.args] },
    remove,
  );
  const hook = (client: string) =>
    [process.execPath, entry, "--state", state, "session-context", client]
      .map(quote)
      .join(" ");
  // Add/remove only our own hook; keep every unrelated matcher and hook.
  for (const [relative, event, value] of [
    [
      ".claude/settings.json",
      "SessionStart",
      {
        matcher: "startup|resume|clear|compact|fork",
        hooks: [{ type: "command", command: hook("claude"), timeout: 5 }],
      },
    ],
    [".cursor/hooks.json", "sessionStart", { command: hook("cursor") }],
  ] as const) {
    const path = join(home, relative);
    if (remove && !existsSync(path)) continue;
    const before = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
    const errors: ParseError[] = [];
    const data = parse(before, errors);
    if (errors.length) throw new Error(`Invalid hook configuration: ${path}`);
    const hooks: unknown[] = data.hooks?.[event] ?? [];
    if (!Array.isArray(hooks)) throw new Error(`Invalid hooks: ${path}`);
    const matching = (v: unknown) =>
      JSON.stringify(v) === JSON.stringify(value);
    const next = remove
      ? hooks.filter((v) => !matching(v))
      : hooks.some(matching)
        ? hooks
        : [...hooks, value];
    let after = applyEdits(
      before,
      modify(before, ["hooks", event], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
    if (relative.includes("cursor") && data.version === undefined && !remove)
      after = applyEdits(
        after,
        modify(after, ["version"], 1, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      );
    save(path, before, after);
  }
  return {
    policies,
    cursor:
      "Global sessionStart context hook; existing conversations need a new session. No guaranteed compaction reinjection.",
    recovery:
      "Claude SessionStart injects policy and session inbox on startup/resume/compact. Other clients recover once using recover_tasks.",
    delivery:
      "Codex: Snooze with actual origin. Claude: channel launcher. Other clients: durable inbox, no push.",
  };
}
