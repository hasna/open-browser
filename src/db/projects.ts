import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";
import type { Project } from "../types/index.js";
import { ProjectNotFoundError } from "../types/index.js";

export function createProject(data: Omit<Project, "id" | "created_at">): Project {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO projects (id, name, path, description) VALUES (?, ?, ?, ?)"
  ).run(id, data.name, data.path, data.description ?? null);
  return getProject(id);
}

export function ensureProject(name: string, path: string, description?: string): Project {
  const db = getDatabase();
  const existing = db
    .query<Project, string>("SELECT * FROM projects WHERE name = ?")
    .get(name);
  if (existing) return existing;
  return createProject({ name, path, description });
}

export function getProject(id: string): Project {
  const db = getDatabase();
  const row = db.query<Project, string>("SELECT * FROM projects WHERE id = ?").get(id);
  if (!row) throw new ProjectNotFoundError(id);
  return row;
}

export function getProjectByName(name: string): Project | null {
  const db = getDatabase();
  return db.query<Project, string>("SELECT * FROM projects WHERE name = ?").get(name) ?? null;
}

export function listProjects(): Project[] {
  const db = getDatabase();
  return db.query<Project, []>("SELECT * FROM projects ORDER BY created_at DESC").all();
}

export function updateProject(id: string, data: Partial<Omit<Project, "id" | "created_at">>): Project {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (data.path !== undefined) { fields.push("path = ?"); values.push(data.path); }
  if (data.description !== undefined) { fields.push("description = ?"); values.push(data.description ?? null); }
  if (fields.length === 0) return getProject(id);
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getProject(id);
}

export function deleteProject(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}
