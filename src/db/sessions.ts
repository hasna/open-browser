import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";
import type { Session, SessionStatus, BrowserEngine } from "../types/index.js";
import { SessionNotFoundError } from "../types/index.js";

export interface CreateSessionData {
  engine: BrowserEngine;
  projectId?: string;
  agentId?: string;
  startUrl?: string;
  name?: string;
}

export function createSession(data: CreateSessionData): Session {
  const db = getDatabase();
  const id = randomUUID();

  // Auto-register agent if agent_id is provided but doesn't exist (prevents FK failure)
  if (data.agentId) {
    const exists = db.query<{ id: string }, string>("SELECT id FROM agents WHERE id = ?").get(data.agentId);
    if (!exists) {
      db.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(data.agentId, data.agentId);
    }
  }

  // If a name is requested but already taken, fall back to name-{short_id}
  let name = data.name ?? null;
  if (name) {
    const existing = db.query<{ id: string }, string>("SELECT id FROM sessions WHERE name = ?").get(name);
    if (existing) {
      name = `${name}-${id.slice(0, 6)}`;
    }
  }

  db.prepare(
    "INSERT INTO sessions (id, engine, project_id, agent_id, start_url, name) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, data.engine, data.projectId ?? null, data.agentId ?? null, data.startUrl ?? null, name);
  return getSession(id);
}

export function getSessionByName(name: string): Session | null {
  const db = getDatabase();
  return db.query<Session, string>("SELECT * FROM sessions WHERE name = ?").get(name) ?? null;
}

export function renameSession(id: string, name: string): Session {
  const db = getDatabase();
  db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
  return getSession(id);
}

export function getSession(id: string): Session {
  const db = getDatabase();
  const row = db.query<Session, string>("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!row) throw new SessionNotFoundError(id);
  return row;
}

export function listSessions(filter?: { status?: SessionStatus; projectId?: string }): Session[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: string[] = [];
  if (filter?.status) { conditions.push("status = ?"); values.push(filter.status); }
  if (filter?.projectId) { conditions.push("project_id = ?"); values.push(filter.projectId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.query<Session, string[]>(`SELECT * FROM sessions ${where} ORDER BY created_at DESC`).all(...values);
}

export function updateSessionStatus(id: string, status: SessionStatus): Session {
  const db = getDatabase();
  const closedAt = status === "closed" || status === "error" ? "datetime('now')" : "NULL";
  db.prepare(
    `UPDATE sessions SET status = ?, closed_at = ${closedAt === "NULL" ? "NULL" : "(datetime('now'))"} WHERE id = ?`
  ).run(status, id);
  return getSession(id);
}

export function closeSession(id: string): Session {
  const db = getDatabase();
  db.prepare("UPDATE sessions SET locked_by = NULL, locked_at = NULL WHERE id = ?").run(id);
  return updateSessionStatus(id, "closed");
}

export function lockSession(id: string, agentId: string): Session {
  const db = getDatabase();
  const session = getSession(id);
  if (session.status !== "active") throw new SessionNotFoundError(id);
  const row = db.query<{ locked_by: string | null }, string>("SELECT locked_by FROM sessions WHERE id = ?").get(id);
  if (row?.locked_by && row.locked_by !== agentId) {
    throw new Error(`Session locked by agent ${row.locked_by}`);
  }
  db.prepare("UPDATE sessions SET locked_by = ?, locked_at = datetime('now') WHERE id = ?").run(agentId, id);
  return getSession(id);
}

export function unlockSession(id: string, agentId?: string): Session {
  const db = getDatabase();
  if (agentId) {
    const row = db.query<{ locked_by: string | null }, string>("SELECT locked_by FROM sessions WHERE id = ?").get(id);
    if (row?.locked_by && row.locked_by !== agentId) {
      throw new Error(`Session locked by agent ${row.locked_by}, not ${agentId}`);
    }
  }
  db.prepare("UPDATE sessions SET locked_by = NULL, locked_at = NULL WHERE id = ?").run(id);
  return getSession(id);
}

export function isSessionLocked(id: string): { locked: boolean; locked_by?: string; locked_at?: string } {
  const db = getDatabase();
  const row = db.query<{ locked_by: string | null; locked_at: string | null }, string>("SELECT locked_by, locked_at FROM sessions WHERE id = ?").get(id);
  if (!row) throw new SessionNotFoundError(id);
  return { locked: !!row.locked_by, locked_by: row.locked_by ?? undefined, locked_at: row.locked_at ?? undefined };
}

export function transferSession(id: string, toAgentId: string): Session {
  const db = getDatabase();
  db.prepare("UPDATE sessions SET agent_id = ?, locked_by = ?, locked_at = datetime('now') WHERE id = ?").run(toAgentId, toAgentId, id);
  return getSession(id);
}

export function getActiveSessionForAgent(agentId: string): Session | null {
  const db = getDatabase();
  return db.query<Session, string>("SELECT * FROM sessions WHERE agent_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(agentId) ?? null;
}

export function getDefaultActiveSession(): Session | null {
  const db = getDatabase();
  const rows = db.query<Session, []>("SELECT * FROM sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 2").all();
  return rows.length === 1 ? rows[0] : null;
}

export function countActiveSessions(): number {
  const db = getDatabase();
  const row = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM sessions WHERE status = 'active'").get();
  return row?.count ?? 0;
}

export function deleteSession(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function addSessionTag(id: string, tag: string): string[] {
  const db = getDatabase();
  db.prepare("INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)").run(id, tag);
  return getSessionTags(id);
}

export function removeSessionTag(id: string, tag: string): string[] {
  const db = getDatabase();
  db.prepare("DELETE FROM session_tags WHERE session_id = ? AND tag = ?").run(id, tag);
  return getSessionTags(id);
}

export function getSessionTags(id: string): string[] {
  const db = getDatabase();
  return db.query<{ tag: string }, string>("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag").all(id).map(r => r.tag);
}

export function listSessionsByTag(tag: string): Session[] {
  const db = getDatabase();
  return db.query<Session, string>(
    "SELECT s.* FROM sessions s JOIN session_tags t ON s.id = t.session_id WHERE t.tag = ? ORDER BY s.created_at DESC"
  ).all(tag);
}
