/**
 * browser_cron_create — native Bun.cron scheduler for browser tasks.
 * Stores jobs in SQLite, registers with Bun.cron on startup.
 */

import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/schema.js";

// ─── Schema migration 3 (lazy init) ──────────────────────────────────────────

function ensureCronTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id          TEXT PRIMARY KEY,
      name        TEXT,
      schedule    TEXT NOT NULL,
      task_json   TEXT NOT NULL,
      last_run    TEXT,
      next_run    TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      run_count   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cron_events (
      id         TEXT PRIMARY KEY,
      job_id     TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      success    INTEGER,
      result     TEXT,
      error      TEXT
    );
  `);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BrowserCronTask {
  url?: string;
  skill?: string;
  extract?: Record<string, string>;
  actions?: Array<{ tool: string; args?: Record<string, unknown> }>;
  notify_on_change?: boolean;
}

export interface CronJob {
  id: string;
  name?: string;
  schedule: string;
  task: BrowserCronTask;
  last_run?: string;
  next_run?: string;
  enabled: boolean;
  run_count: number;
  created_at: string;
}

export interface CronEvent {
  id: string;
  job_id: string;
  started_at: string;
  ended_at?: string;
  success?: boolean;
  result?: unknown;
  error?: string;
}

// Active Bun.cron handles
const activeHandles = new Map<string, { stop: () => void }>();

// ─── Core operations ──────────────────────────────────────────────────────────

export function createCronJob(
  schedule: string,
  task: BrowserCronTask,
  name?: string
): CronJob {
  ensureCronTable();
  const db = getDatabase();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO cron_jobs (id, name, schedule, task_json, enabled)
    VALUES (?, ?, ?, ?, 1)
  `).run(id, name ?? null, schedule, JSON.stringify(task));

  const job = getCronJob(id)!;
  registerCronJob(job);
  return job;
}

export function getCronJob(id: string): CronJob | null {
  ensureCronTable();
  const db = getDatabase();
  const row = db.query<any, string>("SELECT * FROM cron_jobs WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, task: JSON.parse(row.task_json), enabled: row.enabled === 1 };
}

export function listCronJobs(): CronJob[] {
  ensureCronTable();
  const db = getDatabase();
  const rows = db.query<any, []>("SELECT * FROM cron_jobs ORDER BY created_at DESC").all();
  return rows.map(r => ({ ...r, task: JSON.parse(r.task_json), enabled: r.enabled === 1 }));
}

export function deleteCronJob(id: string): boolean {
  ensureCronTable();
  const db = getDatabase();
  unregisterCronJob(id);
  const result = db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  return result.changes > 0;
}

export function enableCronJob(id: string, enabled: boolean): CronJob | null {
  ensureCronTable();
  const db = getDatabase();
  db.prepare("UPDATE cron_jobs SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  const job = getCronJob(id);
  if (job) {
    if (enabled) registerCronJob(job);
    else unregisterCronJob(id);
  }
  return job;
}

export async function runCronJobNow(id: string): Promise<CronEvent> {
  const job = getCronJob(id);
  if (!job) throw new Error(`Cron job not found: ${id}`);
  return executeCronJob(job);
}

export function getCronEvents(jobId: string, limit = 10): CronEvent[] {
  ensureCronTable();
  const db = getDatabase();
  const rows = db.query<any, [string, number]>(
    "SELECT * FROM cron_events WHERE job_id = ? ORDER BY started_at DESC LIMIT ?"
  ).all(jobId, limit);
  return rows.map(r => ({ ...r, success: r.success === 1, result: r.result ? JSON.parse(r.result) : undefined }));
}

/** Remove cron_events older than the retention period (default 7 days). */
export function pruneCronEvents(retentionDays = 7): number {
  ensureCronTable();
  const db = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = db.prepare("DELETE FROM cron_events WHERE started_at < ?").run(cutoff);
  return result.changes;
}

// ─── Execution ────────────────────────────────────────────────────────────────

async function executeCronJob(job: CronJob): Promise<CronEvent> {
  ensureCronTable();
  const db = getDatabase();
  const eventId = randomUUID();
  const startedAt = new Date().toISOString();

  db.prepare("INSERT INTO cron_events (id, job_id, started_at) VALUES (?, ?, ?)").run(eventId, job.id, startedAt);

  try {
    const { createSession, closeSession } = await import("./session.js");
    const { session, page } = await createSession({
      engine: "auto",
      headless: true,
      startUrl: job.task.url,
    });

    let result: unknown = {};

    if (job.task.skill) {
      const { runBrowserSkill } = await import("./skills-runner.js");
      result = await runBrowserSkill(job.task.skill, {}, page as any);
    } else if (job.task.extract && job.task.url) {
      const { extractStructured } = await import("./extractor.js");
      result = await extractStructured(page, job.task.extract);
    } else if (job.task.actions) {
      for (const action of job.task.actions) {
        // Simple action execution
        if (action.tool === "navigate" && action.args?.url) {
          await page.goto(action.args.url as string, { waitUntil: "domcontentloaded" } as any);
        }
      }
    }

    await closeSession(session.id);

    const endedAt = new Date().toISOString();
    db.prepare("UPDATE cron_events SET ended_at = ?, success = 1, result = ? WHERE id = ?")
      .run(endedAt, JSON.stringify(result), eventId);
    db.prepare("UPDATE cron_jobs SET last_run = ?, run_count = run_count + 1 WHERE id = ?")
      .run(endedAt, job.id);

    return { id: eventId, job_id: job.id, started_at: startedAt, ended_at: endedAt, success: true, result };
  } catch (err) {
    const endedAt = new Date().toISOString();
    const error = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE cron_events SET ended_at = ?, success = 0, error = ? WHERE id = ?")
      .run(endedAt, error, eventId);
    return { id: eventId, job_id: job.id, started_at: startedAt, ended_at: endedAt, success: false, error };
  }
}

// ─── Bun.cron registration ───────────────────────────────────────────────────

function registerCronJob(job: CronJob): void {
  if (!job.enabled) return;
  const BunCron = (globalThis as any).Bun?.cron;
  if (!BunCron) return; // Bun.cron not available in stable yet

  try {
    unregisterCronJob(job.id); // Remove existing if any
    const handle = BunCron(job.schedule, async () => {
      await executeCronJob(job).catch(console.error);
    });
    if (handle && typeof handle.stop === "function") {
      activeHandles.set(job.id, handle);
    }
  } catch (err) {
    console.error(`[cron] Failed to register job ${job.id}:`, err);
  }
}

function unregisterCronJob(id: string): void {
  const handle = activeHandles.get(id);
  if (handle) { try { handle.stop(); } catch {} activeHandles.delete(id); }
}

export function loadCronJobsOnStartup(): void {
  try {
    // Prune old events to prevent unbounded DB growth
    const pruned = pruneCronEvents();
    if (pruned > 0) console.error(`[browser] Pruned ${pruned} old cron event(s)`);

    const jobs = listCronJobs();
    for (const job of jobs) {
      if (job.enabled) registerCronJob(job);
    }
    if (jobs.length > 0) {
      console.error(`[browser] Loaded ${jobs.length} cron job(s)`);
    }
  } catch {}
}
