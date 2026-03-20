import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";
import type { Agent } from "../types/index.js";
import { AgentNotFoundError } from "../types/index.js";

export interface RegisterAgentOptions {
  description?: string;
  sessionId?: string;
  projectId?: string;
  workingDir?: string;
}

export function registerAgent(name: string, opts: RegisterAgentOptions = {}): Agent {
  const db = getDatabase();
  const existing = db.query<Agent, string>("SELECT * FROM agents WHERE name = ?").get(name);
  if (existing) {
    // Update last_seen + session info on re-register
    db.prepare(
      "UPDATE agents SET last_seen = datetime('now'), session_id = ?, project_id = ?, working_dir = ? WHERE name = ?"
    ).run(
      (opts.sessionId ?? existing.session_id) ?? null,
      (opts.projectId ?? existing.project_id) ?? null,
      (opts.workingDir ?? existing.working_dir) ?? null,
      name
    );
    return getAgentByName(name)!;
  }
  const id = randomUUID();
  db.prepare(
    "INSERT INTO agents (id, name, description, session_id, project_id, working_dir) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, name, opts.description ?? null, opts.sessionId ?? null, opts.projectId ?? null, opts.workingDir ?? null);
  return getAgent(id);
}

export function heartbeat(agentId: string): void {
  const db = getDatabase();
  const agent = db.query<Agent, string>("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent) throw new AgentNotFoundError(agentId);
  db.prepare("UPDATE agents SET last_seen = datetime('now') WHERE id = ?").run(agentId);
  db.prepare("INSERT INTO heartbeats (id, agent_id, session_id) VALUES (?, ?, ?)").run(
    randomUUID(),
    agentId,
    agent.session_id ?? null
  );
}

export function getAgent(id: string): Agent {
  const db = getDatabase();
  const row = db.query<Agent, string>("SELECT * FROM agents WHERE id = ?").get(id);
  if (!row) throw new AgentNotFoundError(id);
  return row;
}

export function getAgentByName(name: string): Agent | null {
  const db = getDatabase();
  return db.query<Agent, string>("SELECT * FROM agents WHERE name = ?").get(name) ?? null;
}

export function listAgents(projectId?: string): Agent[] {
  const db = getDatabase();
  if (projectId) {
    return db
      .query<Agent, string>("SELECT * FROM agents WHERE project_id = ? ORDER BY last_seen DESC")
      .all(projectId);
  }
  return db.query<Agent, []>("SELECT * FROM agents ORDER BY last_seen DESC").all();
}

export function updateAgent(id: string, data: Partial<Omit<Agent, "id" | "created_at">>): Agent {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name ?? null); }
  if (data.description !== undefined) { fields.push("description = ?"); values.push(data.description ?? null); }
  if (data.session_id !== undefined) { fields.push("session_id = ?"); values.push(data.session_id ?? null); }
  if (data.project_id !== undefined) { fields.push("project_id = ?"); values.push(data.project_id ?? null); }
  if (data.working_dir !== undefined) { fields.push("working_dir = ?"); values.push(data.working_dir ?? null); }
  if (fields.length === 0) return getAgent(id);
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getAgent(id);
}

export function deleteAgent(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
}

export function cleanStaleAgents(thresholdMs: number): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - thresholdMs).toISOString().replace("T", " ").split(".")[0];
  const result = db.prepare(
    "DELETE FROM agents WHERE last_seen < ?"
  ).run(cutoff);
  return result.changes;
}
