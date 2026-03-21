import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";
import type { GalleryEntry, GalleryStats } from "../types/index.js";

// ─── Raw DB row ───────────────────────────────────────────────────────────────

interface RawGalleryEntry {
  id: string;
  session_id: string | null;
  project_id: string | null;
  url: string | null;
  title: string | null;
  path: string;
  thumbnail_path: string | null;
  format: string | null;
  width: number | null;
  height: number | null;
  original_size_bytes: number | null;
  compressed_size_bytes: number | null;
  compression_ratio: number | null;
  tags: string;
  notes: string | null;
  is_favorite: number;
  created_at: string;
}

function deserialize(row: RawGalleryEntry): GalleryEntry {
  return {
    id: row.id,
    session_id: row.session_id ?? undefined,
    project_id: row.project_id ?? undefined,
    url: row.url ?? undefined,
    title: row.title ?? undefined,
    path: row.path,
    thumbnail_path: row.thumbnail_path ?? undefined,
    format: row.format ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    original_size_bytes: row.original_size_bytes ?? undefined,
    compressed_size_bytes: row.compressed_size_bytes ?? undefined,
    compression_ratio: row.compression_ratio ?? undefined,
    tags: JSON.parse(row.tags) as string[],
    notes: row.notes ?? undefined,
    is_favorite: row.is_favorite === 1,
    created_at: row.created_at,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function createEntry(data: Omit<GalleryEntry, "id" | "created_at">): GalleryEntry {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO gallery_entries
      (id, session_id, project_id, url, title, path, thumbnail_path, format,
       width, height, original_size_bytes, compressed_size_bytes, compression_ratio,
       tags, notes, is_favorite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.session_id ?? null,
    data.project_id ?? null,
    data.url ?? null,
    data.title ?? null,
    data.path,
    data.thumbnail_path ?? null,
    data.format ?? null,
    data.width ?? null,
    data.height ?? null,
    data.original_size_bytes ?? null,
    data.compressed_size_bytes ?? null,
    data.compression_ratio ?? null,
    JSON.stringify(data.tags ?? []),
    data.notes ?? null,
    data.is_favorite ? 1 : 0
  );
  return getEntry(id)!;
}

export function getEntry(id: string): GalleryEntry | null {
  const db = getDatabase();
  const row = db.query<RawGalleryEntry, string>("SELECT * FROM gallery_entries WHERE id = ?").get(id);
  return row ? deserialize(row) : null;
}

export interface GalleryFilter {
  projectId?: string;
  sessionId?: string;
  tag?: string;
  isFavorite?: boolean;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export function listEntries(filter?: GalleryFilter): GalleryEntry[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (filter?.projectId) { conditions.push("project_id = ?"); values.push(filter.projectId); }
  if (filter?.sessionId) { conditions.push("session_id = ?"); values.push(filter.sessionId); }
  if (filter?.isFavorite !== undefined) { conditions.push("is_favorite = ?"); values.push(filter.isFavorite ? 1 : 0); }
  if (filter?.dateFrom) { conditions.push("created_at >= ?"); values.push(filter.dateFrom); }
  if (filter?.dateTo) { conditions.push("created_at <= ?"); values.push(filter.dateTo); }
  if (filter?.tag) { conditions.push("tags LIKE ?"); values.push(`%"${filter.tag}"%`); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter?.limit ?? 50;
  const offset = filter?.offset ?? 0;

  const rows = db.query<RawGalleryEntry, (string | number)[]>(
    `SELECT * FROM gallery_entries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...values, limit, offset);

  return rows.map(deserialize);
}

export function updateEntry(
  id: string,
  data: { notes?: string; is_favorite?: boolean; tags?: string[] }
): GalleryEntry | null {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (data.notes !== undefined) { fields.push("notes = ?"); values.push(data.notes); }
  if (data.is_favorite !== undefined) { fields.push("is_favorite = ?"); values.push(data.is_favorite ? 1 : 0); }
  if (data.tags !== undefined) { fields.push("tags = ?"); values.push(JSON.stringify(data.tags)); }

  if (fields.length === 0) return getEntry(id);
  values.push(id);
  db.prepare(`UPDATE gallery_entries SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getEntry(id);
}

export function deleteEntry(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM gallery_entries WHERE id = ?").run(id);
}

export function tagEntry(id: string, tag: string): GalleryEntry | null {
  const entry = getEntry(id);
  if (!entry) return null;
  const tags = entry.tags.includes(tag) ? entry.tags : [...entry.tags, tag];
  return updateEntry(id, { tags });
}

export function untagEntry(id: string, tag: string): GalleryEntry | null {
  const entry = getEntry(id);
  if (!entry) return null;
  return updateEntry(id, { tags: entry.tags.filter((t) => t !== tag) });
}

export function favoriteEntry(id: string, value: boolean): GalleryEntry | null {
  return updateEntry(id, { is_favorite: value });
}

export function searchEntries(q: string, limit = 20): GalleryEntry[] {
  const db = getDatabase();
  const like = `%${q}%`;
  const rows = db.query<RawGalleryEntry, string[]>(`
    SELECT * FROM gallery_entries
    WHERE url LIKE ? OR title LIKE ? OR notes LIKE ? OR tags LIKE ?
    ORDER BY created_at DESC LIMIT ${limit}
  `).all(like, like, like, like);
  return rows.map(deserialize);
}

export function getGalleryStats(projectId?: string): GalleryStats {
  const db = getDatabase();
  const where = projectId ? "WHERE project_id = ?" : "";
  const params: string[] = projectId ? [projectId] : [];

  const total = (db.query<{ count: number }, string[]>(
    `SELECT COUNT(*) as count FROM gallery_entries ${where}`
  ).get(...params))?.count ?? 0;

  const totalSize = (db.query<{ total: number }, string[]>(
    `SELECT COALESCE(SUM(compressed_size_bytes), 0) as total FROM gallery_entries ${where}`
  ).get(...params))?.total ?? 0;

  const favorites = (db.query<{ count: number }, string[]>(
    `SELECT COUNT(*) as count FROM gallery_entries ${where ? where + " AND" : "WHERE"} is_favorite = 1`
  ).get(...(projectId ? [projectId] : [])))?.count ?? 0;

  const formatRows = db.query<{ format: string | null; count: number }, string[]>(
    `SELECT format, COUNT(*) as count FROM gallery_entries ${where} GROUP BY format`
  ).all(...params);

  const by_format: Record<string, number> = {};
  for (const row of formatRows) {
    by_format[row.format ?? "unknown"] = row.count;
  }

  return { total, total_size_bytes: totalSize, favorites, by_format };
}
