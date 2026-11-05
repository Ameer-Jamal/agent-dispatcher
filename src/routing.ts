import type { Agent, Config, TaskInput } from "./config.js";
import type { Usage } from "./store.js";
export function route(
  input: TaskInput,
  config: Config,
  usage: Partial<Record<Agent, Usage>>,
  available: Partial<Record<Agent, boolean>>,
  excluded: Agent[] = [],
): { agent: Agent; reason: string } {
  const now = Date.now();
  const taskType = input.taskType ?? "implementation";
  const eligible = (agent: Agent) =>
    config.agents[agent].enabled &&
    available[agent] &&
    !excluded.includes(agent) &&
    !(
      usage[agent]?.quality === "measured" &&
      usage[agent]?.remainingPercent === 0
    ) &&
    !(usage[agent]?.blockedUntil && usage[agent]!.blockedUntil! > now);
  const codexSafe = () => {
    const u = usage.codex;
    return (
      u?.quality === "measured" &&
      now - u.observedAt <= config.usageMaxAgeSeconds * 1000 &&
      u.remainingPercent !== undefined &&
      u.remainingPercent > config.reservePercent
    );
  };
  if (input.prefer) {
    if (!eligible(input.prefer))
      throw new Error(
        `Requested ${input.prefer} unavailable; check subscription login or quota cooldown`,
      );
    return {
      agent: input.prefer,
      reason: "Explicit agent override (reserve override permitted)",
    };
  }
  if (input.capabilityReason && eligible("codex") && codexSafe())
    return {
      agent: "codex",
      reason: `Capability advantage: ${input.capabilityReason}`,
    };
  for (const agent of config.routing[taskType]) {
    if (agent === "codex" && !codexSafe()) continue;
    if (!eligible(agent)) continue;
    return {
      agent,
      reason: `${taskType} preference: ${agent}; Codex conversation reserve protected`,
    };
  }
  throw new Error(
    "No eligible subscription worker: Codex reserve/unknown allowance or worker authentication prevents dispatch",
  );
}
