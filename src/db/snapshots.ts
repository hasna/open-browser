import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";
import type { Snapshot } from "../types/index.js";

export function createSnapshot(data: Omit<Snapshot, "id" | "timestamp">): Snapshot {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO snapshots (id, session_id, url, title, html, screenshot_path) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, data.session_id, data.url, data.title ?? null, data.html ?? null, data.screenshot_path ?? null);
  return getSnapshot(id)!;
}

export function getSnapshot(id: string): Snapshot | null {
  const db = getDatabase();
  return db.query<Snapshot, string>("SELECT * FROM snapshots WHERE id = ?").get(id) ?? null;
}

export function listSnapshots(sessionId: string): Snapshot[] {
  const db = getDatabase();
  return db
    .query<Snapshot, string>("SELECT * FROM snapshots WHERE session_id = ? ORDER BY timestamp DESC")
    .all(sessionId);
}

export function deleteSnapshot(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM snapshots WHERE id = ?").run(id);
}

export function deleteSnapshotsBySession(sessionId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM snapshots WHERE session_id = ?").run(sessionId);
}
