#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stateDir, initialize, loadConfig, Agent, agents } from "./config.js";
import { Store } from "./store.js";
import { serve, view } from "./mcp.js";
import { worker, runTask, submit, cancel, health } from "./dispatcher.js";
import { availability, refreshUsage } from "./usage.js";
import { applyPatch } from "./worktree.js";
import {
  setup,
  setAgentEnabled,
  registerClients,
  unregisterClients,
  service,
  launchClaude,
} from "./setup.js";
const help = `agent-dispatcher 0.1.0-alpha.2\nUsage: agent-dispatcher [--state ABS_PATH] COMMAND\n\nsetup [--root ABS_PATH]  Initialize private config; detect Snooze; preserve defaults\nregister                 Register MCP in Codex/Claude, preserving existing entries\nunregister               Remove matching MCP entries; retain state\nenable|disable AGENT     Control worker eligibility; preserve other settings\ndoctor                   Check subscription authentication and allowance (no inference)\nserve [--channel]        Serve stdio MCP; channels require the Claude launcher\nworker [--once]          Run the durable single-worker scheduler\nservice install|start|stop|uninstall\nclaude [--resume UUID]   Launch Claude Code with completion delivery enabled\ndispatch TASK.json       Queue a task (cwd must be an allowed Git root)\nstatus                   Show health, cached usage and recent task summaries\nget TASK_ID              Read saved task including input and artifacts\ncancel TASK_ID           Stop a task and retain partial work\napply TASK_ID            Apply a completed patch AFTER coordinator review\nusage-set AGENT.json     Save a manual estimated allowance/cooldown\n--help | --version\n`;
async function main() {
  const raw = process.argv.slice(2);
  const stateIndex = raw.indexOf("--state");
  let state = stateDir();
  if (stateIndex >= 0) {
    if (!raw[stateIndex + 1]) throw new Error("--state requires a path");
    state = resolve(raw[stateIndex + 1]!);
    raw.splice(stateIndex, 2);
  }
  const command = raw.shift();
  if (!command || command === "--help" || command === "-h") {
    console.log(help);
    return;
  }
  if (command === "--version") {
    console.log("0.1.0-alpha.2");
    return;
  }
  if (command === "setup") {
    const { values } = parseArgs({
      args: raw,
      options: { root: { type: "string", multiple: true } },
      strict: true,
    });
    console.log(
      JSON.stringify(
        await setup(
          state,
          (values.root ?? []).map((p) => resolve(p)),
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "unregister") {
    console.log(JSON.stringify(unregisterClients(state), null, 2));
    return;
  }
  if (command === "enable" || command === "disable") {
    const agent = Agent.parse(raw[0]);
    console.log(
      JSON.stringify(
        setAgentEnabled(state, agent, command === "enable"),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "register") {
    console.log(JSON.stringify(registerClients(state), null, 2));
    return;
  }
  if (command === "service") {
    const action = raw[0];
    if (!["install", "start", "stop", "uninstall"].includes(action ?? ""))
      throw new Error("Specify service install|start|stop|uninstall");
    console.log(
      JSON.stringify(
        await service(
          state,
          action as "install" | "start" | "stop" | "uninstall",
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "claude") {
    process.exitCode = await launchClaude(state, loadConfig(state), raw);
    return;
  }
  if (command === "serve") {
    await serve(state, raw.includes("--channel"));
    return;
  }
  if (command === "worker") {
    await worker(state, raw.includes("--once"));
    return;
  }
  initialize(state);
  const store = new Store(state);
  const config = loadConfig(state);
  try {
    let result: unknown;
    switch (command) {
      case "doctor":
        await refreshUsage(store, config);
        result = {
          ...health(store),
          enabled: Object.fromEntries(
            agents.map((a) => [a, config.agents[a].enabled]),
          ),
          subscriptions: await availability(config, store),
          ...Object.fromEntries(agents.map((a) => [a, store.usage(a)])),
          allowedRoots: config.allowedRoots,
          snooze: !!config.snooze,
          delivery: {
            codex: "Snooze required; doctor does not send messages",
            claude:
              "Use claude launcher; custom channel preview must be enabled",
          },
        };
        break;
      case "dispatch":
        result = view(
          submit(store, config, JSON.parse(readFileSync(raw[0] ?? "", "utf8"))),
        );
        break;
      case "get":
        result = store.get(raw[0] ?? "");
        break;
      case "cancel":
        result = cancel(store, raw[0] ?? "");
        break;
      case "apply":
        result = await applyPatch(store.get(raw[0] ?? ""));
        break;
      case "status":
        result = {
          ...health(store),
          enabled: Object.fromEntries(
            agents.map((a) => [a, config.agents[a].enabled]),
          ),
          ...Object.fromEntries(agents.map((a) => [a, store.usage(a)])),
          tasks: store.list(20).map(view),
        };
        break;
      case "run-task":
        await runTask(store, config, raw[0] ?? "");
        return;
      case "usage-set": {
        const { z } = await import("zod");
        const data = z
          .object({
            agent: Agent,
            remainingPercent: z.number().min(0).max(100).optional(),
            resetsAt: z.number().optional(),
            blockedUntil: z.number().optional(),
            note: z.string().max(1000).optional(),
          })
          .parse(JSON.parse(readFileSync(raw[0] ?? "", "utf8")));
        store.setUsage({
          ...data,
          pool: config.agents[data.agent].pool,
          quality: "estimated",
          observedAt: Date.now(),
        });
        result = store.usage(data.agent);
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}
main().catch((e) => {
  console.error(
    `agent-dispatcher: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exitCode = 1;
});
