import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";
import type { CrawlResult, CrawledPage } from "../types/index.js";

interface RawCrawlResult {
  id: string;
  project_id: string | null;
  start_url: string;
  depth: number;
  pages: string;
  links: string;
  errors: string;
  created_at: string;
}

function deserialize(row: RawCrawlResult): CrawlResult {
  const pages = JSON.parse(row.pages) as CrawledPage[];
  return {
    id: row.id,
    project_id: row.project_id ?? undefined,
    start_url: row.start_url,
    depth: row.depth,
    pages,
    total_links: pages.reduce((acc, p) => acc + p.links.length, 0),
    errors: JSON.parse(row.errors) as string[],
    created_at: row.created_at,
  };
}

export function createCrawlResult(data: Omit<CrawlResult, "id" | "created_at" | "total_links">): CrawlResult {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO crawl_results (id, project_id, start_url, depth, pages, links, errors) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    data.project_id ?? null,
    data.start_url,
    data.depth,
    JSON.stringify(data.pages),
    JSON.stringify(data.pages.flatMap((p) => p.links)),
    JSON.stringify(data.errors)
  );
  return getCrawlResult(id)!;
}

export function getCrawlResult(id: string): CrawlResult | null {
  const db = getDatabase();
  const row = db.query<RawCrawlResult, string>("SELECT * FROM crawl_results WHERE id = ?").get(id);
  return row ? deserialize(row) : null;
}

export function listCrawlResults(projectId?: string): CrawlResult[] {
  const db = getDatabase();
  const rows = projectId
    ? db.query<RawCrawlResult, string>("SELECT * FROM crawl_results WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
    : db.query<RawCrawlResult, []>("SELECT * FROM crawl_results ORDER BY created_at DESC").all();
  return rows.map(deserialize);
}

export function deleteCrawlResult(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM crawl_results WHERE id = ?").run(id);
}
