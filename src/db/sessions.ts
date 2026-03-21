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
  db.prepare(
    "INSERT INTO sessions (id, engine, project_id, agent_id, start_url, name) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, data.engine, data.projectId ?? null, data.agentId ?? null, data.startUrl ?? null, data.name ?? null);
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
  return updateSessionStatus(id, "closed");
}

export function deleteSession(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}
