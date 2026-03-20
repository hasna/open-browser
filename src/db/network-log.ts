import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";
import type { NetworkRequest } from "../types/index.js";

export function logRequest(data: Omit<NetworkRequest, "id" | "timestamp">): NetworkRequest {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO network_log (id, session_id, method, url, status_code, request_headers,
     response_headers, request_body, body_size, duration_ms, resource_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.session_id,
    data.method,
    data.url,
    data.status_code ?? null,
    data.request_headers ?? null,
    data.response_headers ?? null,
    data.request_body ?? null,
    data.body_size ?? null,
    data.duration_ms ?? null,
    data.resource_type ?? null
  );
  return getNetworkRequest(id)!;
}

export function getNetworkRequest(id: string): NetworkRequest | null {
  const db = getDatabase();
  return db.query<NetworkRequest, string>("SELECT * FROM network_log WHERE id = ?").get(id) ?? null;
}

export function getNetworkLog(sessionId: string): NetworkRequest[] {
  const db = getDatabase();
  return db
    .query<NetworkRequest, string>("SELECT * FROM network_log WHERE session_id = ? ORDER BY timestamp ASC")
    .all(sessionId);
}

export function clearNetworkLog(sessionId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM network_log WHERE session_id = ?").run(sessionId);
}

export function deleteNetworkRequest(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM network_log WHERE id = ?").run(id);
}
