import type { Agent } from "../types/index.js";
import { registerAgent as dbRegisterAgent, heartbeat as dbHeartbeat, getAgent, getAgentByName, listAgents, updateAgent, deleteAgent, cleanStaleAgents, type RegisterAgentOptions } from "../db/agents.js";

export { getAgent, getAgentByName, listAgents, updateAgent, deleteAgent, cleanStaleAgents };
export type { RegisterAgentOptions };

export function registerAgent(name: string, opts: RegisterAgentOptions = {}): Agent {
  return dbRegisterAgent(name, opts);
}

export function heartbeat(agentId: string): void {
  dbHeartbeat(agentId);
}

export function isAgentStale(agent: Agent, thresholdMs = 5 * 60 * 1000): boolean {
  const lastSeen = new Date(agent.last_seen).getTime();
  return Date.now() - lastSeen > thresholdMs;
}

export function getActiveAgents(thresholdMs = 5 * 60 * 1000): Agent[] {
  return listAgents().filter((a) => !isAgentStale(a, thresholdMs));
}
