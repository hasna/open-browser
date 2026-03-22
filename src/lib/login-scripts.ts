/**
 * Login scripts — multi-step workflows that combine browser actions + connector calls.
 * Supports variable interpolation, regex extraction, conditions, and state saving.
 *
 * Usage: save a script once, replay with `browser login-script <name>`
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../db/schema.js";
import type { Page } from "playwright";

// ─── Types ──────────────────────────────────────────────────────────────────

export type StepType = "browser" | "connector" | "extract" | "wait" | "condition" | "save_state";

export interface ScriptStep {
  type: StepType;
  description?: string;

  // browser steps
  action?: "navigate" | "type" | "click" | "click_text" | "wait_for_navigation" | "wait_for_text" | "snapshot";
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  timeout?: number;

  // connector steps
  connector?: string;
  args?: string[];
  format?: string;

  // extract steps
  pattern?: string;      // regex pattern
  json_path?: string;    // simple JSON path like "output.id"
  save_as?: string;      // variable name to save result into

  // wait steps
  seconds?: number;

  // condition steps
  check?: string;        // variable to check
  equals?: string;
  contains?: string;
  skip_to?: number;      // step index to skip to if condition fails

  // save_state steps
  name?: string;
}

export interface LoginScript {
  name: string;
  domain: string;
  description?: string;
  variables: Record<string, string>;  // default variable values
  steps: ScriptStep[];
  created_at: string;
  updated_at: string;
}

export interface ScriptRunResult {
  success: boolean;
  steps_executed: number;
  steps_failed: number;
  variables: Record<string, string>;
  errors: string[];
  duration_ms: number;
}

// ─── Async job tracking ─────────────────────────────────────────────────────

export interface ScriptJob {
  id: string;
  script_name: string;
  status: "running" | "completed" | "failed";
  current_step: number;
  total_steps: number;
  current_step_description: string;
  steps_log: Array<{ step: number; type: string; description: string; status: "ok" | "failed" | "running"; duration_ms?: number; error?: string }>;
  result?: ScriptRunResult;
  started_at: string;
}

const activeJobs = new Map<string, ScriptJob>();

export function getJob(jobId: string): ScriptJob | null {
  return activeJobs.get(jobId) ?? null;
}

export function listJobs(): ScriptJob[] {
  return Array.from(activeJobs.values());
}

// ─── Script storage (JSON files in ~/.browser/scripts/) ─────────────────────

function getScriptsDir(): string {
  const dir = join(getDataDir(), "scripts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveScript(script: LoginScript): string {
  const dir = getScriptsDir();
  const path = join(dir, `${script.name}.json`);
  script.updated_at = new Date().toISOString();
  if (!script.created_at) script.created_at = script.updated_at;
  writeFileSync(path, JSON.stringify(script, null, 2));
  return path;
}

export function loadScript(name: string): LoginScript | null {
  const path = join(getScriptsDir(), `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function listScripts(): Array<{ name: string; domain: string; description?: string; steps: number }> {
  const dir = getScriptsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try {
        const script = JSON.parse(readFileSync(join(dir, f), "utf8")) as LoginScript;
        return { name: script.name, domain: script.domain, description: script.description, steps: script.steps.length };
      } catch { return null; }
    })
    .filter(Boolean) as any[];
}

export function deleteScript(name: string): boolean {
  const path = join(getScriptsDir(), `${name}.json`);
  if (!existsSync(path)) return false;
  const { unlinkSync } = require("node:fs");
  unlinkSync(path);
  return true;
}

// ─── Variable interpolation ─────────────────────────────────────────────────

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
    return vars[key] ?? match;
  });
}

// ─── Script runner ──────────────────────────────────────────────────────────

function stepDescription(step: ScriptStep): string {
  return step.description ?? `${step.type}${step.action ? `:${step.action}` : ""}${step.connector ? `:${step.connector}` : ""}`;
}

export async function runScript(
  script: LoginScript,
  page: Page,
  overrides: Record<string, string> = {},
  jobId?: string
): Promise<ScriptRunResult> {
  const t0 = Date.now();
  const vars: Record<string, string> = { ...script.variables, ...overrides };
  const errors: string[] = [];
  let executed = 0;
  let failed = 0;

  // Create or get job for progress tracking
  const job: ScriptJob = jobId && activeJobs.has(jobId)
    ? activeJobs.get(jobId)!
    : {
        id: jobId ?? randomUUID(),
        script_name: script.name,
        status: "running",
        current_step: 0,
        total_steps: script.steps.length,
        current_step_description: "Starting...",
        steps_log: [],
        started_at: new Date().toISOString(),
      };
  activeJobs.set(job.id, job);

  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i];
    const desc = stepDescription(step);
    executed++;

    // Update job progress
    job.current_step = i + 1;
    job.current_step_description = desc;
    job.steps_log.push({ step: i + 1, type: step.type, description: desc, status: "running" });

    const stepStart = Date.now();

    try {
      switch (step.type) {
        case "browser":
          await runBrowserStep(step, page, vars);
          break;

        case "connector":
          await runConnectorStep(step, vars);
          break;

        case "extract":
          runExtractStep(step, vars);
          break;

        case "wait":
          await new Promise(r => setTimeout(r, (step.seconds ?? 3) * 1000));
          break;

        case "condition": {
          const checkVal = vars[step.check ?? ""];
          let conditionMet = true;
          if (step.equals !== undefined) conditionMet = checkVal === interpolate(step.equals, vars);
          if (step.contains !== undefined) conditionMet = checkVal?.includes(interpolate(step.contains, vars)) ?? false;
          if (!conditionMet && step.skip_to !== undefined) {
            i = step.skip_to - 1; // -1 because loop will i++
          }
          break;
        }

        case "save_state": {
          const stateName = interpolate(step.name ?? script.name, vars);
          try {
            const { saveStateFromPage } = await import("./storage-state.js");
            const path = await saveStateFromPage(page, stateName);
            vars["saved_state_path"] = path;
          } catch {}
          break;
        }
      }

      // Mark step as done
      const logEntry = job.steps_log[job.steps_log.length - 1];
      logEntry.status = "ok";
      logEntry.duration_ms = Date.now() - stepStart;

    } catch (err) {
      failed++;
      const msg = `Step ${i + 1} (${step.type}/${step.action ?? step.connector ?? ""}): ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);

      const logEntry = job.steps_log[job.steps_log.length - 1];
      logEntry.status = "failed";
      logEntry.error = err instanceof Error ? err.message : String(err);
      logEntry.duration_ms = Date.now() - stepStart;

      if (step.type === "browser" && step.action === "navigate") break;
    }
  }

  const result: ScriptRunResult = {
    success: failed === 0,
    steps_executed: executed,
    steps_failed: failed,
    variables: vars,
    errors,
    duration_ms: Date.now() - t0,
  };

  job.status = failed === 0 ? "completed" : "failed";
  job.result = result;

  return result;
}

/**
 * Run a script asynchronously — returns immediately with a job ID.
 * Poll with getJob(jobId) for progress.
 */
export function runScriptAsync(
  script: LoginScript,
  page: Page,
  overrides: Record<string, string> = {}
): string {
  const jobId = randomUUID();
  const job: ScriptJob = {
    id: jobId,
    script_name: script.name,
    status: "running",
    current_step: 0,
    total_steps: script.steps.length,
    current_step_description: "Starting...",
    steps_log: [],
    started_at: new Date().toISOString(),
  };
  activeJobs.set(jobId, job);

  // Fire and forget — runs in background
  runScript(script, page, overrides, jobId).catch((err) => {
    job.status = "failed";
    job.current_step_description = `Fatal error: ${err instanceof Error ? err.message : String(err)}`;
  });

  return jobId;
}

// ─── Step runners ───────────────────────────────────────────────────────────

async function runBrowserStep(step: ScriptStep, page: Page, vars: Record<string, string>): Promise<void> {
  const action = step.action;
  if (!action) throw new Error("Browser step missing action");

  switch (action) {
    case "navigate": {
      const url = interpolate(step.url ?? "", vars);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: step.timeout ?? 30000 });
      await new Promise(r => setTimeout(r, 1000));
      vars["current_url"] = page.url();
      vars["current_title"] = await page.title();
      break;
    }
    case "type": {
      const selector = interpolate(step.selector ?? "input", vars);
      const value = interpolate(step.value ?? step.text ?? "", vars);
      await page.fill(selector, value);
      break;
    }
    case "click": {
      const selector = interpolate(step.selector ?? "", vars);
      await page.click(selector, { timeout: step.timeout ?? 10000 });
      await new Promise(r => setTimeout(r, 500));
      break;
    }
    case "click_text": {
      const text = interpolate(step.text ?? "", vars);
      await page.getByText(text, { exact: false }).first().click({ timeout: step.timeout ?? 10000 });
      await new Promise(r => setTimeout(r, 500));
      break;
    }
    case "wait_for_navigation": {
      try {
        await page.waitForNavigation({ timeout: step.timeout ?? 15000 });
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
      vars["current_url"] = page.url();
      break;
    }
    case "wait_for_text": {
      const text = interpolate(step.text ?? "", vars);
      await page.waitForSelector(`text=${text}`, { timeout: step.timeout ?? 10000 });
      break;
    }
    case "snapshot": {
      vars["page_text"] = await page.evaluate(() => document.body?.textContent?.trim() ?? "");
      break;
    }
  }
}

async function runConnectorStep(step: ScriptStep, vars: Record<string, string>): Promise<void> {
  const connectorName = step.connector;
  if (!connectorName) throw new Error("Connector step missing connector name");

  // Interpolate args
  const args = (step.args ?? []).map(a => interpolate(a, vars));

  let result: { stdout: string; stderr: string; exitCode: number; success: boolean };

  // Use Bun.spawn for reliable CLI execution (inherits PATH, no shell escaping issues)
  try {
    const bin = `connect-${connectorName}`;
    const proc = Bun.spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: process.env.HOME ?? "" },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    result = { stdout, stderr, exitCode, success: exitCode === 0 };
  } catch (e: any) {
    result = { stdout: "", stderr: e.message ?? String(e), exitCode: 1, success: false };
  }

  // Store result in variables
  vars["last_output"] = result.stdout;
  vars["last_success"] = String(result.success);
  vars["last_exit_code"] = String(result.exitCode);

  // Try to parse as JSON and extract fields
  try {
    const parsed = JSON.parse(result.stdout);
    if (typeof parsed === "object" && parsed !== null) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" || typeof v === "number") {
          vars[`last.${k}`] = String(v);
        }
      }
    }
  } catch {
    // Not JSON — store raw output
  }

  if (step.save_as) {
    vars[step.save_as] = result.stdout;
  }
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function runExtractStep(step: ScriptStep, vars: Record<string, string>): void {
  const saveTo = step.save_as ?? "extracted";

  if (step.pattern) {
    // Regex extraction from last_output or a specific variable
    const source = step.check ? (vars[step.check] ?? "") : (vars["last_output"] ?? "");
    const regex = new RegExp(step.pattern);
    const match = regex.exec(source);
    if (match) {
      // Decode HTML entities (common when extracting from email HTML bodies)
      vars[saveTo] = decodeHtmlEntities(match[1] ?? match[0]);
    }
  }

  if (step.json_path) {
    // Simple dot-notation JSON path
    const source = vars["last_output"] ?? "{}";
    try {
      let obj: any = JSON.parse(source);
      for (const key of step.json_path.split(".")) {
        obj = obj?.[key];
      }
      if (obj !== undefined) vars[saveTo] = String(obj);
    } catch {}
  }
}

// ─── Create script from JSON file or inline JSON ────────────────────────────

export function createScriptFromJSON(jsonStr: string): LoginScript {
  const parsed = JSON.parse(jsonStr);
  if (!parsed.name) throw new Error("Script must have a 'name' field");
  if (!parsed.domain) throw new Error("Script must have a 'domain' field");
  if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error("Script must have a non-empty 'steps' array");
  }
  return {
    name: parsed.name,
    domain: parsed.domain,
    description: parsed.description ?? "",
    variables: parsed.variables ?? {},
    steps: parsed.steps,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function createScriptFromFile(filePath: string): LoginScript {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return createScriptFromJSON(readFileSync(filePath, "utf8"));
}
