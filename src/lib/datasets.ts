/**
 * Dataset management — save, refresh, export extracted data.
 */

import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/schema.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../db/schema.js";

export interface Dataset {
  id: string;
  name: string;
  source_url: string | null;
  source_type: string;
  data: any[];
  schema: Record<string, string> | null;
  row_count: number;
  last_refresh: string | null;
  created_at: string;
  updated_at: string;
}

export function saveDataset(data: { name: string; sourceUrl?: string; sourceType?: string; rows: any[]; schema?: Record<string, string> }): Dataset {
  const db = getDatabase();
  const id = randomUUID();
  const existing = db.query<{ id: string }, string>("SELECT id FROM datasets WHERE name = ?").get(data.name);
  if (existing) {
    db.prepare(
      "UPDATE datasets SET data = ?, row_count = ?, source_url = ?, schema = ?, last_refresh = datetime('now'), updated_at = datetime('now') WHERE name = ?"
    ).run(JSON.stringify(data.rows), data.rows.length, data.sourceUrl ?? null, data.schema ? JSON.stringify(data.schema) : null, data.name);
    return getDataset(existing.id)!;
  }
  db.prepare(
    "INSERT INTO datasets (id, name, source_url, source_type, data, row_count, schema) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, data.name, data.sourceUrl ?? null, data.sourceType ?? "page", JSON.stringify(data.rows), data.rows.length, data.schema ? JSON.stringify(data.schema) : null);
  return getDataset(id)!;
}

export function getDataset(id: string): Dataset | null {
  const db = getDatabase();
  const row = db.query<any, string>("SELECT * FROM datasets WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data), schema: row.schema ? JSON.parse(row.schema) : null };
}

export function getDatasetByName(name: string): Dataset | null {
  const db = getDatabase();
  const row = db.query<any, string>("SELECT * FROM datasets WHERE name = ?").get(name);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data), schema: row.schema ? JSON.parse(row.schema) : null };
}

export function listDatasets(): Array<Omit<Dataset, "data"> & { data: string }> {
  const db = getDatabase();
  return db.query<any, []>("SELECT id, name, source_url, source_type, row_count, last_refresh, created_at, updated_at FROM datasets ORDER BY updated_at DESC").all()
    .map((row: any) => ({ ...row, data: `${row.row_count} rows`, schema: null }));
}

export function deleteDataset(name: string): boolean {
  const db = getDatabase();
  return db.prepare("DELETE FROM datasets WHERE name = ?").run(name).changes > 0;
}

export function exportDataset(name: string, format: "json" | "csv"): { path: string; size: number } {
  const dataset = getDatasetByName(name);
  if (!dataset) throw new Error(`Dataset '${name}' not found`);

  const dir = join(getDataDir(), "exports");
  mkdirSync(dir, { recursive: true });

  const filename = `${name}.${format}`;
  const path = join(dir, filename);

  if (format === "csv") {
    const rows = dataset.data;
    if (rows.length === 0) { writeFileSync(path, ""); return { path, size: 0 }; }
    const headers = Object.keys(rows[0]);
    const csvLines = [headers.join(",")];
    for (const row of rows) {
      csvLines.push(headers.map(h => {
        const val = String(row[h] ?? "");
        return val.includes(",") || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(","));
    }
    const content = csvLines.join("\n");
    writeFileSync(path, content);
    return { path, size: content.length };
  } else {
    const content = JSON.stringify(dataset.data, null, 2);
    writeFileSync(path, content);
    return { path, size: content.length };
  }
}
