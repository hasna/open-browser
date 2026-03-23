/**
 * Storage-state persistence — save/load browser auth state (cookies, localStorage, sessionStorage).
 * Uses Playwright's native storageState() API for full fidelity.
 */

import { mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Page, BrowserContext } from "playwright";

import { getDataDir } from "../db/schema.js";

const STATES_DIR = join(getDataDir(), "states");

function ensureDir() {
  mkdirSync(STATES_DIR, { recursive: true });
}

function statePath(name: string): string {
  return join(STATES_DIR, `${name}.json`);
}

export async function saveState(context: BrowserContext, name: string): Promise<string> {
  ensureDir();
  const path = statePath(name);
  const state = await context.storageState({ path });
  return path;
}

export async function saveStateFromPage(page: Page, name: string): Promise<string> {
  return saveState(page.context(), name);
}

export function loadStatePath(name: string): string | null {
  const path = statePath(name);
  return existsSync(path) ? path : null;
}

export function listStates(): Array<{ name: string; path: string; modified: string }> {
  ensureDir();
  return readdirSync(STATES_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const path = join(STATES_DIR, f);
      const stat = Bun.file(path);
      return {
        name: f.replace(".json", ""),
        path,
        modified: new Date(stat.lastModified).toISOString(),
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export function deleteState(name: string): boolean {
  const path = statePath(name);
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}
