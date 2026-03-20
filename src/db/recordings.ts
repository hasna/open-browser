import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";
import type { Recording, RecordingStep } from "../types/index.js";
import { RecordingNotFoundError } from "../types/index.js";

interface RawRecording {
  id: string;
  name: string;
  project_id: string | null;
  start_url: string | null;
  steps: string;
  created_at: string;
}

function deserialize(row: RawRecording): Recording {
  return {
    ...row,
    project_id: row.project_id ?? undefined,
    start_url: row.start_url ?? undefined,
    steps: JSON.parse(row.steps) as RecordingStep[],
  };
}

export function createRecording(data: Omit<Recording, "id" | "created_at">): Recording {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO recordings (id, name, project_id, start_url, steps) VALUES (?, ?, ?, ?, ?)"
  ).run(id, data.name, data.project_id ?? null, data.start_url ?? null, JSON.stringify(data.steps ?? []));
  return getRecording(id);
}

export function getRecording(id: string): Recording {
  const db = getDatabase();
  const row = db.query<RawRecording, string>("SELECT * FROM recordings WHERE id = ?").get(id);
  if (!row) throw new RecordingNotFoundError(id);
  return deserialize(row);
}

export function listRecordings(projectId?: string): Recording[] {
  const db = getDatabase();
  const rows = projectId
    ? db.query<RawRecording, string>("SELECT * FROM recordings WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
    : db.query<RawRecording, []>("SELECT * FROM recordings ORDER BY created_at DESC").all();
  return rows.map(deserialize);
}

export function updateRecording(id: string, data: { name?: string; steps?: RecordingStep[]; start_url?: string }): Recording {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (data.steps !== undefined) { fields.push("steps = ?"); values.push(JSON.stringify(data.steps)); }
  if (data.start_url !== undefined) { fields.push("start_url = ?"); values.push(data.start_url ?? null); }
  if (fields.length === 0) return getRecording(id);
  values.push(id);
  db.prepare(`UPDATE recordings SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getRecording(id);
}

export function deleteRecording(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM recordings WHERE id = ?").run(id);
}
