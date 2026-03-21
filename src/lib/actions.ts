import type { Page } from "playwright";
import { BrowserError, ElementNotFoundError, NavigationError } from "../types/index.js";
import { getRefLocator } from "./snapshot.js";

export interface ClickOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  delay?: number;
  timeout?: number;
}

export interface TypeOptions {
  delay?: number;
  clear?: boolean;
  timeout?: number;
}

export interface WaitOptions {
  state?: "attached" | "detached" | "visible" | "hidden";
  timeout?: number;
}

export async function click(page: Page, selector: string, opts?: ClickOptions): Promise<void> {
  try {
    await page.click(selector, {
      button: opts?.button ?? "left",
      clickCount: opts?.clickCount ?? 1,
      delay: opts?.delay,
      timeout: opts?.timeout ?? 10000,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      throw new ElementNotFoundError(selector);
    }
    throw new BrowserError(`Click failed on '${selector}': ${err instanceof Error ? err.message : String(err)}`, "CLICK_FAILED");
  }
}

export async function type(page: Page, selector: string, text: string, opts?: TypeOptions): Promise<void> {
  try {
    if (opts?.clear) {
      await page.fill(selector, "", { timeout: opts?.timeout ?? 10000 });
    }
    await page.type(selector, text, { delay: opts?.delay, timeout: opts?.timeout ?? 10000 });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      throw new ElementNotFoundError(selector);
    }
    throw new BrowserError(`Type failed on '${selector}': ${err instanceof Error ? err.message : String(err)}`, "TYPE_FAILED");
  }
}

export async function fill(page: Page, selector: string, value: string, timeout = 10000): Promise<void> {
  try {
    await page.fill(selector, value, { timeout });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function scroll(
  page: Page,
  direction: "up" | "down" | "left" | "right" = "down",
  amount = 300
): Promise<void> {
  const x = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const y = direction === "up" ? -amount : direction === "down" ? amount : 0;
  await page.evaluate(({ x, y }) => window.scrollBy(x, y), { x, y });
}

export async function scrollTo(page: Page, selector: string): Promise<void> {
  try {
    await page.locator(selector).scrollIntoViewIfNeeded();
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function hover(page: Page, selector: string, timeout = 10000): Promise<void> {
  try {
    await page.hover(selector, { timeout });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function selectOption(
  page: Page,
  selector: string,
  value: string,
  timeout = 10000
): Promise<string[]> {
  try {
    return await page.selectOption(selector, value, { timeout });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function checkBox(
  page: Page,
  selector: string,
  checked: boolean,
  timeout = 10000
): Promise<void> {
  try {
    if (checked) {
      await page.check(selector, { timeout });
    } else {
      await page.uncheck(selector, { timeout });
    }
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function uploadFile(
  page: Page,
  selector: string,
  filePaths: string | string[],
  timeout = 10000
): Promise<void> {
  try {
    await page.setInputFiles(selector, filePaths, { timeout });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function goBack(page: Page, timeout = 10000): Promise<void> {
  try {
    await page.goBack({ timeout, waitUntil: "domcontentloaded" });
  } catch (err) {
    throw new NavigationError("back", err instanceof Error ? err.message : String(err));
  }
}

export async function goForward(page: Page, timeout = 10000): Promise<void> {
  try {
    await page.goForward({ timeout, waitUntil: "domcontentloaded" });
  } catch (err) {
    throw new NavigationError("forward", err instanceof Error ? err.message : String(err));
  }
}

export async function reload(page: Page, timeout = 10000): Promise<void> {
  try {
    await page.reload({ timeout, waitUntil: "domcontentloaded" });
  } catch (err) {
    throw new NavigationError("reload", err instanceof Error ? err.message : String(err));
  }
}

export async function navigate(page: Page, url: string, timeout = 30000): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch (err) {
    throw new NavigationError(url, err instanceof Error ? err.message : String(err));
  }
}

export async function waitForSelector(page: Page, selector: string, opts?: WaitOptions): Promise<void> {
  try {
    await page.waitForSelector(selector, {
      state: opts?.state ?? "visible",
      timeout: opts?.timeout ?? 10000,
    });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function waitForNavigation(page: Page, timeout = 30000): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout });
  } catch (err) {
    throw new NavigationError("navigation", err instanceof Error ? err.message : String(err));
  }
}

export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

export interface RetryOptions {
  retries?: number;
  delay?: number;
  retryOn?: string[];
}

const RETRYABLE_ERRORS = ["Timeout", "timeout", "navigation", "net::ERR", "Target closed"];

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const retries = opts?.retries ?? 2;
  const delay = opts?.delay ?? 300;
  const retryOn = opts?.retryOn ?? RETRYABLE_ERRORS;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const shouldRetry = retryOn.some((pattern) => msg.includes(pattern));
      // Never retry on element-not-found — it's deterministic
      if (!shouldRetry || err instanceof ElementNotFoundError) throw err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── QoL: click by text content ──────────────────────────────────────────────

export async function clickText(
  page: Page,
  text: string,
  opts?: { exact?: boolean; timeout?: number; retries?: number }
): Promise<void> {
  await withRetry(async () => {
    try {
      await page.getByText(text, { exact: opts?.exact ?? false }).first().click({ timeout: opts?.timeout ?? 10000 });
    } catch (err) {
      throw new BrowserError(
        `clickText: could not find or click text "${text}": ${err instanceof Error ? err.message : String(err)}`,
        "CLICK_TEXT_FAILED"
      );
    }
  }, { retries: opts?.retries ?? 1 });
}

// ─── QoL: one-shot form fill ──────────────────────────────────────────────────

import type { FormFillResult } from "../types/index.js";

export async function fillForm(
  page: Page,
  fields: Record<string, string | boolean>,
  submitSelector?: string
): Promise<FormFillResult> {
  let filled = 0;
  const errors: string[] = [];

  for (const [selector, value] of Object.entries(fields)) {
    try {
      const el = await page.$(selector);
      if (!el) { errors.push(`${selector}: element not found`); continue; }

      const tagName = await el.evaluate((e) => (e as HTMLElement).tagName.toLowerCase());
      const inputType = await el.evaluate((e) => (e as HTMLInputElement).type?.toLowerCase() ?? "text");

      if (tagName === "select") {
        await page.selectOption(selector, String(value));
      } else if (tagName === "input" && (inputType === "checkbox" || inputType === "radio")) {
        const checked = Boolean(value);
        if (checked) {
          await page.check(selector);
        } else {
          await page.uncheck(selector);
        }
      } else {
        await page.fill(selector, String(value));
      }
      filled++;
    } catch (err) {
      errors.push(`${selector}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (submitSelector) {
    try {
      await page.click(submitSelector);
    } catch (err) {
      errors.push(`submit(${submitSelector}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { filled, errors, fields_attempted: Object.keys(fields).length };
}

// ─── QoL: wait for text ───────────────────────────────────────────────────────

export async function waitForText(
  page: Page,
  text: string,
  opts?: { timeout?: number; exact?: boolean }
): Promise<void> {
  const timeout = opts?.timeout ?? 10000;
  try {
    await page.getByText(text, { exact: opts?.exact ?? false }).first().waitFor({ state: "visible", timeout });
  } catch (err) {
    throw new ElementNotFoundError(`text:"${text}"`);
  }
}

// ─── QoL: watch page for DOM changes ─────────────────────────────────────────

export interface WatchHandle {
  id: string;
  stop: () => void;
}

const activeWatches = new Map<string, { interval: ReturnType<typeof setInterval>; changes: string[] }>();

export function watchPage(
  page: Page,
  opts?: { selector?: string; intervalMs?: number; maxChanges?: number }
): WatchHandle {
  const id = `watch-${Date.now()}`;
  const changes: string[] = [];
  const intervalMs = opts?.intervalMs ?? 500;
  const maxChanges = opts?.maxChanges ?? 50;

  const interval = setInterval(async () => {
    if (changes.length >= maxChanges) return;
    try {
      const change = await page.evaluate((sel) => {
        const el = sel ? document.querySelector(sel) : document.body;
        return el ? `${new Date().toISOString()}:${el.textContent?.slice(0, 100)}` : null;
      }, opts?.selector ?? null);
      if (change && (changes.length === 0 || changes[changes.length - 1] !== change)) {
        changes.push(change);
      }
    } catch {
      // Page might be navigating
    }
  }, intervalMs);

  activeWatches.set(id, { interval, changes });

  return {
    id,
    stop: () => {
      clearInterval(interval);
      activeWatches.delete(id);
    },
  };
}

export function getWatchChanges(watchId: string): string[] {
  return activeWatches.get(watchId)?.changes ?? [];
}

export function stopWatch(watchId: string): void {
  const w = activeWatches.get(watchId);
  if (w) {
    clearInterval(w.interval);
    activeWatches.delete(watchId);
  }
}

// ─── Ref-based actions ────────────────────────────────────────────────────────

export async function clickRef(
  page: Page,
  sessionId: string,
  ref: string,
  opts?: { timeout?: number }
): Promise<void> {
  try {
    const locator = getRefLocator(page, sessionId, ref);
    await locator.click({ timeout: opts?.timeout ?? 10000 });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Ref ")) throw new ElementNotFoundError(ref);
    if (err instanceof Error && err.message.includes("No snapshot")) throw new BrowserError(err.message, "NO_SNAPSHOT");
    throw new BrowserError(`clickRef ${ref} failed: ${err instanceof Error ? err.message : String(err)}`, "CLICK_REF_FAILED");
  }
}

export async function typeRef(
  page: Page,
  sessionId: string,
  ref: string,
  text: string,
  opts?: { delay?: number; clear?: boolean; timeout?: number }
): Promise<void> {
  try {
    const locator = getRefLocator(page, sessionId, ref);
    if (opts?.clear) await locator.fill("", { timeout: opts.timeout ?? 10000 });
    await locator.pressSequentially(text, { delay: opts?.delay, timeout: opts?.timeout ?? 10000 });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Ref ")) throw new ElementNotFoundError(ref);
    throw new BrowserError(`typeRef ${ref} failed: ${err instanceof Error ? err.message : String(err)}`, "TYPE_REF_FAILED");
  }
}

export async function fillRef(
  page: Page,
  sessionId: string,
  ref: string,
  value: string,
  timeout = 10000
): Promise<void> {
  try {
    const locator = getRefLocator(page, sessionId, ref);
    await locator.fill(value, { timeout });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Ref ")) throw new ElementNotFoundError(ref);
    throw new BrowserError(`fillRef ${ref} failed: ${err instanceof Error ? err.message : String(err)}`, "FILL_REF_FAILED");
  }
}

export async function selectRef(
  page: Page,
  sessionId: string,
  ref: string,
  value: string,
  timeout = 10000
): Promise<string[]> {
  try {
    const locator = getRefLocator(page, sessionId, ref);
    return await locator.selectOption(value, { timeout });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Ref ")) throw new ElementNotFoundError(ref);
    throw new BrowserError(`selectRef ${ref} failed: ${err instanceof Error ? err.message : String(err)}`, "SELECT_REF_FAILED");
  }
}

export async function checkRef(
  page: Page,
  sessionId: string,
  ref: string,
  checked: boolean,
  timeout = 10000
): Promise<void> {
  try {
    const locator = getRefLocator(page, sessionId, ref);
    if (checked) await locator.check({ timeout });
    else await locator.uncheck({ timeout });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Ref ")) throw new ElementNotFoundError(ref);
    throw new BrowserError(`checkRef ${ref} failed: ${err instanceof Error ? err.message : String(err)}`, "CHECK_REF_FAILED");
  }
}

export async function hoverRef(
  page: Page,
  sessionId: string,
  ref: string,
  timeout = 10000
): Promise<void> {
  try {
    const locator = getRefLocator(page, sessionId, ref);
    await locator.hover({ timeout });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Ref ")) throw new ElementNotFoundError(ref);
    throw new BrowserError(`hoverRef ${ref} failed: ${err instanceof Error ? err.message : String(err)}`, "HOVER_REF_FAILED");
  }
}
