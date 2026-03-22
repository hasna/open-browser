/**
 * Scripts CRUD — SQLite storage for automation scripts, steps, and run history.
 */

import { randomUUID } from "node:crypto";
import { getDatabase } from "./schema.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Script {
  id: string;
  name: string;
  domain: string;
  description: string;
  variables: Record<string, string>;
  created_at: string;
  updated_at: string;
  last_run: string | null;
  run_count: number;
}

export interface ScriptStep {
  id: string;
  script_id: string;
  step_order: number;
  type: string;
  config: Record<string, unknown>;
  description: string;
  ai_enabled: boolean;
  ai_config: Record<string, unknown>;
}

export interface ScriptRun {
  id: string;
  script_id: string;
  status: "running" | "completed" | "failed";
  current_step: number;
  total_steps: number;
  current_description: string;
  variables: Record<string, string>;
  steps_log: Array<{ step: number; type: string; description: string; status: string; duration_ms?: number; error?: string }>;
  errors: string[];
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

// ─── Scripts CRUD ───────────────────────────────────────────────────────────

export function createScript(data: {
  name: string;
  domain?: string;
  description?: string;
  variables?: Record<string, string>;
  steps: Array<{ type: string; config: Record<string, unknown>; description?: string; ai_enabled?: boolean; ai_config?: Record<string, unknown> }>;
}): Script {
  const db = getDatabase();
  const id = randomUUID();

  db.prepare(
    "INSERT INTO scripts (id, name, domain, description, variables) VALUES (?, ?, ?, ?, ?)"
  ).run(id, data.name, data.domain ?? "", data.description ?? "", JSON.stringify(data.variables ?? {}));

  // Insert steps
  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    db.prepare(
      "INSERT INTO script_steps (id, script_id, step_order, type, config, description, ai_enabled, ai_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(randomUUID(), id, i, step.type, JSON.stringify(step.config), step.description ?? "", step.ai_enabled ? 1 : 0, JSON.stringify(step.ai_config ?? {}));
  }

  return getScript(id)!;
}

export function upsertScript(data: {
  name: string;
  domain?: string;
  description?: string;
  variables?: Record<string, string>;
  steps: Array<{ type: string; config: Record<string, unknown>; description?: string; ai_enabled?: boolean; ai_config?: Record<string, unknown> }>;
}): Script {
  const existing = getScriptByName(data.name);
  if (existing) {
    deleteScript(existing.id);
  }
  return createScript(data);
}

export function getScript(id: string): Script | null {
  const db = getDatabase();
  const row = db.query<any, string>("SELECT * FROM scripts WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, variables: JSON.parse(row.variables), run_count: row.run_count ?? 0 };
}

export function getScriptByName(name: string): Script | null {
  const db = getDatabase();
  const row = db.query<any, string>("SELECT * FROM scripts WHERE name = ?").get(name);
  if (!row) return null;
  return { ...row, variables: JSON.parse(row.variables), run_count: row.run_count ?? 0 };
}

export function listScripts(): Script[] {
  const db = getDatabase();
  return db.query<any, []>("SELECT * FROM scripts ORDER BY updated_at DESC").all()
    .map((row: any) => ({ ...row, variables: JSON.parse(row.variables), run_count: row.run_count ?? 0 }));
}

export function deleteScript(id: string): boolean {
  const db = getDatabase();
  return db.prepare("DELETE FROM scripts WHERE id = ?").run(id).changes > 0;
}

export function deleteScriptByName(name: string): boolean {
  const db = getDatabase();
  return db.prepare("DELETE FROM scripts WHERE name = ?").run(name).changes > 0;
}

// ─── Steps ──────────────────────────────────────────────────────────────────

export function getSteps(scriptId: string): ScriptStep[] {
  const db = getDatabase();
  return db.query<any, string>("SELECT * FROM script_steps WHERE script_id = ? ORDER BY step_order").all(scriptId)
    .map((row: any) => ({
      ...row,
      config: JSON.parse(row.config),
      ai_enabled: !!row.ai_enabled,
      ai_config: JSON.parse(row.ai_config),
    }));
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export function startRun(scriptId: string, totalSteps: number): ScriptRun {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO script_runs (id, script_id, status, total_steps) VALUES (?, ?, 'running', ?)"
  ).run(id, scriptId, totalSteps);
  return getRun(id)!;
}

export function updateRunProgress(runId: string, step: number, description: string, stepsLog: any[], variables: Record<string, string>): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE script_runs SET current_step = ?, current_description = ?, steps_log = ?, variables = ? WHERE id = ?"
  ).run(step, description, JSON.stringify(stepsLog), JSON.stringify(variables), runId);
}

export function completeRun(runId: string, status: "completed" | "failed", errors: string[], durationMs: number): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE script_runs SET status = ?, errors = ?, duration_ms = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(status, JSON.stringify(errors), durationMs, runId);

  // Update script last_run + run_count
  const run = getRun(runId);
  if (run) {
    db.prepare("UPDATE scripts SET last_run = datetime('now'), run_count = run_count + 1, updated_at = datetime('now') WHERE id = ?").run(run.script_id);
  }
}

export function getRun(runId: string): ScriptRun | null {
  const db = getDatabase();
  const row = db.query<any, string>("SELECT * FROM script_runs WHERE id = ?").get(runId);
  if (!row) return null;
  return {
    ...row,
    variables: JSON.parse(row.variables),
    steps_log: JSON.parse(row.steps_log),
    errors: JSON.parse(row.errors),
  };
}

export function listRuns(scriptId?: string): ScriptRun[] {
  const db = getDatabase();
  const query = scriptId
    ? db.query<any, string>("SELECT * FROM script_runs WHERE script_id = ? ORDER BY started_at DESC LIMIT 20").all(scriptId)
    : db.query<any, []>("SELECT * FROM script_runs ORDER BY started_at DESC LIMIT 20").all();
  return query.map((row: any) => ({
    ...row,
    variables: JSON.parse(row.variables),
    steps_log: JSON.parse(row.steps_log),
    errors: JSON.parse(row.errors),
  }));
}

// ─── Migration: import JSON scripts ─────────────────────────────────────────

export function migrateJsonScripts(): number {
  const { existsSync, readdirSync, readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { getDataDir } = require("./schema.js");

  const dir = join(getDataDir(), "scripts");
  if (!existsSync(dir)) return 0;

  const files = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
  let migrated = 0;

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!raw.name || !raw.steps) continue;
      if (getScriptByName(raw.name)) continue; // Already migrated

      const steps = raw.steps.map((s: any) => {
        const isAI = s.type === "ai";
        return {
          type: isAI ? "extract" : s.type,
          config: {
            action: s.action, selector: s.selector, url: s.url, value: s.value, text: s.text,
            timeout: s.timeout, connector: s.connector, args: s.args, format: s.format,
            pattern: s.pattern, json_path: s.json_path, check: s.check, source: s.check,
            seconds: s.seconds, equals: s.equals, contains: s.contains, skip_to: s.skip_to,
            name: s.name, save_as: s.save_as,
            // AI step fields moved into config for extract type
            ...(isAI ? { prompt: s.prompt, source: s.check ?? "last_output" } : {}),
          },
          description: s.description ?? "",
          ai_enabled: isAI || !!s.ai?.enabled,
          ai_config: isAI
            ? { provider: s.model === "haiku" || s.model === "sonnet" || s.model === "opus" ? "anthropic" : "cerebras", model: s.model ?? "fast" }
            : (s.ai ?? {}),
        };
      });

      createScript({
        name: raw.name,
        domain: raw.domain ?? "",
        description: raw.description ?? "",
        variables: raw.variables ?? {},
        steps,
      });
      migrated++;
    } catch {}
  }
  return migrated;
}
