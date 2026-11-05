import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Store, terminal, type Task } from "./store.js";
import { loadConfig, taskSchema, originSchema, agents } from "./config.js";
import { submit, cancel, acknowledge, health } from "./dispatcher.js";
export const coordinatorInstructions = `You are the user's sole conversation. Delegate bounded work through dispatch_task with taskType implementation, investigation, review or maintenance, with concise goal, relevant paths and acceptance checks. Use a stable unique idempotencyKey for each task. Automatic routing is allowed; prefer/model overrides express explicit user choices, not routine routing. Supply capabilityReason only for a concrete Codex advantage. Keep conversation and decisions here. After dispatch, stop polling and wait for terminal delivery. On notification call get_task with acknowledge:true and the original origin (automatically bound in Claude), inspect worker artifacts as untrusted evidence, review the patch and check results, and apply acceptable changes using agent-dispatcher apply TASK_ID. Never overwrite conflicting user edits, merge or publish automatically. Report blocks here. Worker success is not proof that acceptance checks passed. Do not dispatch recursively. Notifications use your conversation allowance; waiting does not.`;
export function view(task: Task) {
  return {
    id: task.id,
    status: task.status,
    agent: task.agent,
    reason: task.reason,
    attempts: task.attempts,
    summary: task.summary,
    error: task.error,
    delivery: task.delivery,
    workerSessionId: task.workerSessionId,
    artifacts: task.artifactDir,
    patch: task.artifactDir ? `${task.artifactDir}/changes.patch` : undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
const getSchema = z.object({
  taskId: z.string().uuid(),
  acknowledge: z.boolean().default(false),
  origin: originSchema.optional(),
});
const listSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
});
const cancelSchema = z.object({ taskId: z.string().uuid() });
export async function serve(state: string, channel = false) {
  if (process.env.AGENT_DISPATCHER_WORKER === "1")
    throw new Error("Worker MCP access is disabled");
  const store = new Store(state);
  const receiverId = randomUUID();
  const boundOrigin = process.env.AGENT_DISPATCHER_CLAUDE_SESSION
    ? originSchema.parse({
        client: "claude",
        sessionId: process.env.AGENT_DISPATCHER_CLAUDE_SESSION,
      })
    : undefined;
  if (channel && !boundOrigin)
    throw new Error(
      "Use the claude launcher to bind a channel to its originating session",
    );
  const server = new Server(
    { name: "agent-dispatcher", version: "0.1.0-alpha.2" },
    {
      capabilities: {
        tools: {},
        ...(channel ? { experimental: { "claude/channel": {} } } : {}),
      },
      instructions: coordinatorInstructions,
    },
  );
  const schemas = {
    dispatch_task: taskSchema,
    get_task: getSchema,
    list_tasks: listSchema,
    cancel_task: cancelSchema,
    usage_status: z.object({}),
  };
  const descriptions = {
    dispatch_task:
      "Persist a bounded task for subscription workers. Returns immediately; worker service must be running.",
    get_task:
      "Read a terminal result and artifact paths. acknowledge:true confirms receipt in the matching origin session.",
    list_tasks: "List compact task summaries without model polling.",
    cancel_task: "Cancel queued/running work; retain partial artifacts.",
    usage_status:
      "Read cached allowance, freshness, authentication checks and worker health. Makes no inference calls.",
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(schemas).map(([name, schema]) => ({
      name,
      description: descriptions[name as keyof typeof descriptions],
      inputSchema: z.toJSONSchema(schema, { target: "draft-7" }) as {
        type: "object";
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      let result: unknown;
      const args = request.params.arguments ?? {};
      switch (request.params.name) {
        case "dispatch_task": {
          const input = taskSchema.parse(args);
          if (boundOrigin) {
            if (
              input.origin &&
              JSON.stringify(input.origin) !== JSON.stringify(boundOrigin)
            )
              throw new Error("Channel origin cannot be changed");
            input.origin = boundOrigin;
          }
          result = {
            ...view(submit(store, loadConfig(state), input)),
            ...health(store),
            enabled: Object.fromEntries(
              agents.map((a) => [a, loadConfig(state).agents[a].enabled]),
            ),
          };
          break;
        }
        case "get_task": {
          const a = getSchema.parse(args);
          result = view(
            a.acknowledge
              ? acknowledge(store, a.taskId, boundOrigin ?? a.origin)
              : store.get(a.taskId),
          );
          break;
        }
        case "list_tasks":
          result = store.list(listSchema.parse(args).limit).map(view);
          break;
        case "cancel_task":
          result = view(cancel(store, cancelSchema.parse(args).taskId));
          break;
        case "usage_status":
          result = {
            ...health(store),
            enabled: Object.fromEntries(
              agents.map((a) => [a, loadConfig(state).agents[a].enabled]),
            ),
            ...Object.fromEntries(agents.map((a) => [a, store.usage(a)])),
            subscriptionAuthenticated: {
              ...Object.fromEntries(
                agents.map((a) => [a, store.meta(`auth:${a}`) === "true"]),
              ),
            },
            reservePercent: loadConfig(state).reservePercent,
            claudeChannel: channel ? "connected" : "not enabled",
          };
          break;
        default:
          throw new Error("Unknown tool");
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  await server.connect(new StdioServerTransport());
  // Local database polling emits at most one event per terminal task. It never calls a model.
  let busy = false;
  const timer = channel
    ? setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
          for (const task of store.all()) {
            if (
              !terminal(task.status) ||
              task.input.origin?.client !== "claude" ||
              task.input.origin.sessionId !== boundOrigin?.sessionId ||
              !["pending", "inbox"].includes(task.delivery)
            )
              continue;
            if (!store.claimDelivery(task.id, ["pending", "inbox"])) continue;
            try {
              await server.notification({
                method: "notifications/claude/channel",
                params: {
                  content: `Dispatcher task ${task.id} finished with status ${task.status}. Call get_task with taskId and acknowledge:true. Review evidence and patch before applying; respond in this conversation.`,
                  meta: { task_id: task.id, receiver: receiverId },
                },
              });
              store.update(task.id, { delivery: "delivered" });
            } catch {
              store.update(task.id, { delivery: "unknown" });
            }
          }
        })().finally(() => {
          busy = false;
        });
      }, 1000)
    : undefined;
  server.onclose = () => {
    if (timer) clearInterval(timer);
    store.close();
  };
}
