/**
 * Script execution engine — runs automation scripts with native AI integration.
 *
 * AI is not a separate step type — it's a capability woven into every step:
 * - Browser steps: AI self-heals when selectors fail (vision + LLM)
 * - Connector steps: AI parses responses when ai_enabled
 * - Extract steps: always AI-powered (prompt-based, no regex)
 */

import type { Page } from "playwright";
import { getSteps, startRun, updateRunProgress, completeRun, getRun, type ScriptStep, type ScriptRun } from "../db/scripts.js";
import { infer } from "./ai-inference.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RunResult {
  run_id: string;
  success: boolean;
  steps_executed: number;
  steps_failed: number;
  errors: string[];
  duration_ms: number;
  variables: Record<string, string>;
}

type StepLog = { step: number; type: string; description: string; status: "ok" | "failed" | "running"; duration_ms?: number; error?: string };

// ─── Variable interpolation ─────────────────────────────────────────────────

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function interpolateConfig(config: Record<string, unknown>, vars: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string") result[k] = interpolate(v, vars);
    else if (Array.isArray(v)) result[k] = v.map(item => typeof item === "string" ? interpolate(item, vars) : item);
    else result[k] = v;
  }
  return result;
}

// ─── Async execution ────────────────────────────────────────────────────────

/**
 * Run a script asynchronously. Returns run_id immediately.
 * Poll with getRun(run_id) for progress.
 */
export function executeScript(
  scriptId: string,
  page: Page,
  overrides: Record<string, string> = {}
): string {
  const steps = getSteps(scriptId);
  const run = startRun(scriptId, steps.length);

  // Fire and forget
  _runSteps(run.id, scriptId, steps, page, overrides).catch((err) => {
    completeRun(run.id, "failed", [err instanceof Error ? err.message : String(err)], 0);
  });

  return run.id;
}

/**
 * Run a script synchronously. Returns full result.
 */
export async function executeScriptSync(
  scriptId: string,
  page: Page,
  overrides: Record<string, string> = {}
): Promise<RunResult> {
  const steps = getSteps(scriptId);
  const run = startRun(scriptId, steps.length);
  return _runSteps(run.id, scriptId, steps, page, overrides);
}

// ─── Core execution loop ────────────────────────────────────────────────────

async function _runSteps(
  runId: string,
  scriptId: string,
  steps: ScriptStep[],
  page: Page,
  overrides: Record<string, string>
): Promise<RunResult> {
  const t0 = Date.now();

  // Load script variables + overrides
  const { getScript } = await import("../db/scripts.js");
  const script = getScript(scriptId);
  const vars: Record<string, string> = { ...(script?.variables ?? {}), ...overrides };
  const errors: string[] = [];
  const stepsLog: StepLog[] = [];
  let executed = 0;
  let failed = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const cfg = interpolateConfig(step.config, vars);
    const desc = step.description || `${step.type}`;
    executed++;

    // Update progress in DB
    stepsLog.push({ step: i + 1, type: step.type, description: desc, status: "running" });
    updateRunProgress(runId, i + 1, desc, stepsLog, vars);

    const stepStart = Date.now();

    try {
      switch (step.type) {
        case "browser":
          await execBrowser(cfg, step, page, vars);
          break;
        case "connector":
          await execConnector(cfg, step, vars);
          break;
        case "extract":
          await execExtract(cfg, step, vars);
          break;
        case "wait":
          await new Promise(r => setTimeout(r, ((cfg.seconds as number) ?? 3) * 1000));
          break;
        case "condition":
          i = execCondition(cfg, vars, i);
          break;
        case "save_state":
          await execSaveState(cfg, page, vars);
          break;
      }

      stepsLog[stepsLog.length - 1].status = "ok";
      stepsLog[stepsLog.length - 1].duration_ms = Date.now() - stepStart;
    } catch (err) {
      failed++;
      const msg = `Step ${i + 1} (${step.type}): ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      stepsLog[stepsLog.length - 1].status = "failed";
      stepsLog[stepsLog.length - 1].error = err instanceof Error ? err.message : String(err);
      stepsLog[stepsLog.length - 1].duration_ms = Date.now() - stepStart;

      // Fatal: stop on navigate failure
      if (step.type === "browser" && cfg.action === "navigate") break;
    }

    // Persist progress after each step
    updateRunProgress(runId, i + 1, desc, stepsLog, vars);
  }

  const durationMs = Date.now() - t0;
  const status = failed === 0 ? "completed" : "failed";
  completeRun(runId, status, errors, durationMs);

  return { run_id: runId, success: failed === 0, steps_executed: executed, steps_failed: failed, errors, duration_ms: durationMs, variables: vars };
}

// ─── Step executors ─────────────────────────────────────────────────────────

async function execBrowser(cfg: Record<string, unknown>, step: ScriptStep, page: Page, vars: Record<string, string>): Promise<void> {
  const action = cfg.action as string;

  switch (action) {
    case "navigate":
      await page.goto(cfg.url as string, { waitUntil: "domcontentloaded", timeout: (cfg.timeout as number) ?? 30000 });
      await new Promise(r => setTimeout(r, 1000));
      vars["current_url"] = page.url();
      vars["current_title"] = await page.title();
      break;

    case "type": {
      const selector = cfg.selector as string ?? "input";
      const value = cfg.value as string ?? cfg.text as string ?? "";
      try {
        await page.fill(selector, value);
      } catch (origErr) {
        if (step.ai_enabled) {
          // AI self-heal: use vision to find the input
          const healed = await aiSelfHeal(page, `input field for typing "${value}"`, step);
          if (healed) { await page.mouse.click(healed.x, healed.y); await page.keyboard.type(value); }
          else throw origErr;
        } else {
          // Try basic self-healing
          const { healSelector } = await import("./self-heal.js");
          const result = await healSelector(page, selector);
          if (result.found && result.locator) await result.locator.fill(value);
          else throw origErr;
        }
      }
      break;
    }

    case "click": {
      const selector = cfg.selector as string;
      try {
        await page.click(selector, { timeout: (cfg.timeout as number) ?? 10000 });
      } catch (origErr) {
        if (step.ai_enabled) {
          const healed = await aiSelfHeal(page, `clickable element matching "${selector}"`, step);
          if (healed) await page.mouse.click(healed.x, healed.y);
          else throw origErr;
        } else {
          const { healSelector } = await import("./self-heal.js");
          const result = await healSelector(page, selector);
          if (result.found && result.locator) await result.locator.click();
          else throw origErr;
        }
      }
      await new Promise(r => setTimeout(r, 500));
      break;
    }

    case "click_text": {
      const text = cfg.text as string;
      try {
        await page.getByText(text, { exact: false }).first().click({ timeout: (cfg.timeout as number) ?? 10000 });
      } catch (origErr) {
        if (step.ai_enabled) {
          const healed = await aiSelfHeal(page, `button or link with text "${text}"`, step);
          if (healed) await page.mouse.click(healed.x, healed.y);
          else throw origErr;
        } else throw origErr;
      }
      await new Promise(r => setTimeout(r, 500));
      break;
    }

    case "wait_for_navigation":
      try { await page.waitForNavigation({ timeout: (cfg.timeout as number) ?? 15000 }); } catch {}
      await new Promise(r => setTimeout(r, 1000));
      vars["current_url"] = page.url();
      break;

    case "wait_for_text": {
      const text = cfg.text as string;
      await page.waitForSelector(`text=${text}`, { timeout: (cfg.timeout as number) ?? 10000 });
      break;
    }

    case "snapshot":
      vars["page_text"] = await page.evaluate(() => document.body?.textContent?.trim() ?? "");
      break;
  }
}

async function execConnector(cfg: Record<string, unknown>, step: ScriptStep, vars: Record<string, string>): Promise<void> {
  const connector = cfg.connector as string;
  if (!connector) throw new Error("Connector step missing 'connector' in config");

  const args = (cfg.args as string[]) ?? [];

  // Run via Bun.spawn
  const proc = Bun.spawn([`connect-${connector}`, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: process.env.HOME ?? "" },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && !stdout) throw new Error(`Connector ${connector} failed: ${stderr.slice(0, 200)}`);

  const raw = stdout || stderr;
  vars["last_output"] = raw;

  // AI-powered response parsing
  if (step.ai_enabled && step.ai_config?.prompt) {
    const aiPrompt = interpolate(step.ai_config.prompt as string, { ...vars, last_output: raw });
    const provider = (step.ai_config.provider as string) ?? "cerebras";
    const model = (step.ai_config.model as string) ?? "fast";
    const parsed = await infer(aiPrompt, { provider: provider as any, model });
    const saveTo = (cfg.save_as as string) ?? "last_output";
    vars[saveTo] = parsed.trim();
  } else if (cfg.save_as) {
    vars[cfg.save_as as string] = raw;
  }
}

async function execExtract(cfg: Record<string, unknown>, step: ScriptStep, vars: Record<string, string>): Promise<void> {
  const saveTo = (cfg.save_as as string) ?? "extracted";

  // AI-powered extraction (default for extract steps)
  if (step.ai_enabled || cfg.prompt) {
    const source = cfg.source ? vars[cfg.source as string] ?? "" : vars["last_output"] ?? "";
    const prompt = interpolate((cfg.prompt as string) ?? `Extract the key information from this text:\n\n${source}`, { ...vars, source });
    const provider = (step.ai_config?.provider as string) ?? "cerebras";
    const model = (step.ai_config?.model as string) ?? "fast";
    const result = await infer(prompt, { provider: provider as any, model });
    vars[saveTo] = result.trim();
    vars["last_output"] = result.trim();
    return;
  }

  // Regex fallback (for backward compat)
  if (cfg.pattern) {
    const source = cfg.source ? (vars[cfg.source as string] ?? "") : (vars["last_output"] ?? "");
    const match = new RegExp(cfg.pattern as string).exec(source);
    if (match) {
      vars[saveTo] = decodeHtmlEntities(match[1] ?? match[0]);
    }
  }
}

function execCondition(cfg: Record<string, unknown>, vars: Record<string, string>, i: number): number {
  const checkVal = vars[cfg.check as string ?? ""];
  let met = true;
  if (cfg.equals !== undefined) met = checkVal === interpolate(cfg.equals as string, vars);
  if (cfg.contains !== undefined) met = checkVal?.includes(interpolate(cfg.contains as string, vars)) ?? false;
  if (!met && cfg.skip_to !== undefined) return (cfg.skip_to as number) - 1;
  return i;
}

async function execSaveState(cfg: Record<string, unknown>, page: Page, vars: Record<string, string>): Promise<void> {
  const name = interpolate((cfg.name as string) ?? "default", vars);
  try {
    const { saveStateFromPage } = await import("./storage-state.js");
    vars["saved_state_path"] = await saveStateFromPage(page, name);
  } catch {}
}

// ─── AI helpers ─────────────────────────────────────────────────────────────

async function aiSelfHeal(page: Page, description: string, step: ScriptStep): Promise<{ x: number; y: number } | null> {
  try {
    const { findElementByVision } = await import("./vision-fallback.js");
    const provider = (step.ai_config?.provider as string) ?? undefined;
    const model = (step.ai_config?.model as string) ?? undefined;
    const result = await findElementByVision(page, description, { model: model ?? provider });
    if (result.found) return { x: result.x, y: result.y };
  } catch {}
  return null;
}

function decodeHtmlEntities(str: string): string {
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}
