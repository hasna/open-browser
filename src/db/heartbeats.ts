import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";
import type { Heartbeat } from "../types/index.js";

export function recordHeartbeat(agentId: string, sessionId?: string): Heartbeat {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO heartbeats (id, agent_id, session_id) VALUES (?, ?, ?)"
  ).run(id, agentId, sessionId ?? null);
  db.prepare("UPDATE agents SET last_seen = datetime('now') WHERE id = ?").run(agentId);
  return getLastHeartbeat(agentId)!;
}

export function getLastHeartbeat(agentId: string): Heartbeat | null {
  const db = getDatabase();
  return db
    .query<Heartbeat, string>(
      "SELECT * FROM heartbeats WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 1"
    )
    .get(agentId) ?? null;
}

export function listHeartbeats(agentId: string, limit = 50): Heartbeat[] {
  const db = getDatabase();
  return db
    .query<Heartbeat, [string, number]>(
      "SELECT * FROM heartbeats WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?"
    )
    .all(agentId, limit);
}

export function cleanOldHeartbeats(olderThanMs: number): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString().replace("T", " ").split(".")[0];
  const result = db.prepare("DELETE FROM heartbeats WHERE timestamp < ?").run(cutoff);
  return result.changes;
}
