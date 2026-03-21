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

export async function runScript(
  script: LoginScript,
  page: Page,
  overrides: Record<string, string> = {}
): Promise<ScriptRunResult> {
  const t0 = Date.now();
  const vars: Record<string, string> = { ...script.variables, ...overrides };
  const errors: string[] = [];
  let executed = 0;
  let failed = 0;

  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i];
    executed++;

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
    } catch (err) {
      failed++;
      const msg = `Step ${i + 1} (${step.type}/${step.action ?? step.connector ?? ""}): ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      // Don't stop on error — continue with remaining steps unless it's critical
      if (step.type === "browser" && step.action === "navigate") break; // navigation failure is fatal
    }
  }

  return {
    success: failed === 0,
    steps_executed: executed,
    steps_failed: failed,
    variables: vars,
    errors,
    duration_ms: Date.now() - t0,
  };
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
  const format = step.format ?? "json";

  let result: { stdout: string; stderr: string; exitCode: number; success: boolean };

  try {
    const { runConnectorCommand } = await import("@hasna/connectors");
    result = await runConnectorCommand(connectorName, [...args, "-f", format], step.timeout ?? 30000);
  } catch {
    // Fallback: try CLI directly
    const { execSync } = await import("node:child_process");
    try {
      const stdout = execSync(`connect-${connectorName} ${args.join(" ")} -f ${format}`, { timeout: step.timeout ?? 30000, encoding: "utf8" });
      result = { stdout, stderr: "", exitCode: 0, success: true };
    } catch (e: any) {
      result = { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, exitCode: 1, success: false };
    }
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

function runExtractStep(step: ScriptStep, vars: Record<string, string>): void {
  const saveTo = step.save_as ?? "extracted";

  if (step.pattern) {
    // Regex extraction from last_output or a specific variable
    const source = step.check ? (vars[step.check] ?? "") : (vars["last_output"] ?? "");
    const regex = new RegExp(step.pattern);
    const match = regex.exec(source);
    if (match) {
      vars[saveTo] = match[1] ?? match[0];
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

// ─── Helper: create the usestable login script ──────────────────────────────

export function createUsestableScript(email: string): LoginScript {
  return {
    name: "usestable",
    domain: "dashboard.usestable.com",
    description: "Login to Stable via magic link (email → Gmail → click link)",
    variables: { email },
    steps: [
      { type: "browser", action: "navigate", url: "https://dashboard.usestable.com/login", description: "Go to login page" },
      { type: "browser", action: "type", selector: "input", value: "{{email}}", description: "Enter email" },
      { type: "browser", action: "click_text", text: "Continue", description: "Click Continue" },
      { type: "wait", seconds: 1, description: "Wait for login options" },
      { type: "browser", action: "click_text", text: "Send login link", description: "Request magic link" },
      { type: "wait", seconds: 5, description: "Wait for email delivery" },
      {
        type: "connector", connector: "gmail",
        args: ["search", "from:authenticate.usestable.com newer_than:5m", "-n", "1"],
        description: "Search Gmail for magic link email",
      },
      {
        type: "extract", pattern: "id:\\s*([a-f0-9]+)", save_as: "email_id",
        description: "Extract email ID from search results",
      },
      {
        type: "connector", connector: "gmail",
        args: ["messages", "read", "{{email_id}}", "--body", "--html"],
        save_as: "email_body",
        description: "Read the magic link email",
      },
      {
        type: "extract", pattern: "href='(https://dashboard\\.usestable\\.com/login\\?[^']+)'",
        check: "email_body", save_as: "magic_link",
        description: "Extract magic link URL from email HTML",
      },
      { type: "browser", action: "navigate", url: "{{magic_link}}", description: "Open magic link" },
      { type: "wait", seconds: 2, description: "Wait for page to load" },
      { type: "browser", action: "type", selector: "input", value: "{{email}}", description: "Re-enter email" },
      { type: "browser", action: "click_text", text: "Login", description: "Click Login" },
      { type: "browser", action: "wait_for_navigation", timeout: 15000, description: "Wait for redirect to dashboard" },
      { type: "save_state", name: "usestable", description: "Save auth state" },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
