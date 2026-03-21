import type { Browser, Page } from "playwright";
import type { Session, SessionOptions, SessionStatus } from "../types/index.js";
import { BrowserEngine, UseCase } from "../types/index.js";
import { SessionNotFoundError, BrowserError } from "../types/index.js";
import { createSession as dbCreateSession, getSession as dbGetSession, listSessions as dbListSessions, closeSession as dbCloseSession, updateSessionStatus, getSessionByName as dbGetSessionByName, renameSession as dbRenameSession } from "../db/sessions.js";
import { launchPlaywright, getPage as getPlaywrightPage, closeBrowser as closePlaywrightBrowser } from "../engines/playwright.js";
import { connectLightpanda } from "../engines/lightpanda.js";
import { selectEngine } from "../engines/selector.js";
import { enableNetworkLogging } from "./network.js";
import { enableConsoleCapture } from "./console.js";
import { applyStealthPatches } from "./stealth.js";
import { setupDialogHandler } from "./dialogs.js";

// ─── In-memory handle store ───────────────────────────────────────────────────

interface SessionHandle {
  browser: Browser;
  page: Page;
  engine: BrowserEngine;
  cleanups: Array<() => void>;
  tokenBudget: { total: number; used: number };
}

const handles = new Map<string, SessionHandle>();

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CreateSessionResult {
  session: Session;
  page: Page;
}

export async function createSession(opts: SessionOptions = {}): Promise<CreateSessionResult> {
  const engine = opts.engine === "auto" || !opts.engine
    ? selectEngine(opts.useCase ?? UseCase.SPA_NAVIGATE, opts.engine)
    : opts.engine;

  const resolvedEngine: BrowserEngine = engine === "auto" ? "playwright" : engine;

  let browser: Browser;
  let page: Page;

  if (resolvedEngine === "lightpanda") {
    browser = await connectLightpanda();
    const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 720 } });
    page = await context.newPage();
  } else {
    // playwright or cdp both use Playwright under the hood
    browser = await launchPlaywright({
      headless: opts.headless ?? true,
      viewport: opts.viewport,
      userAgent: opts.userAgent,
    });
    page = await getPlaywrightPage(browser, {
      viewport: opts.viewport,
      userAgent: opts.userAgent,
    });
  }

  const session = dbCreateSession({
    engine: resolvedEngine,
    projectId: opts.projectId,
    agentId: opts.agentId,
    startUrl: opts.startUrl,
    name: opts.name ?? (opts.startUrl ? new URL(opts.startUrl).hostname : undefined),
  });

  // Apply stealth patches if requested (before any navigation)
  if (opts.stealth) {
    try { await applyStealthPatches(page); } catch {}
  }

  // Auto-attach network + console logging
  const cleanups: Array<() => void> = [];
  if (opts.captureNetwork !== false) {
    try { cleanups.push(enableNetworkLogging(page, session.id)); } catch {}
  }
  if (opts.captureConsole !== false) {
    try { cleanups.push(enableConsoleCapture(page, session.id)); } catch {}
  }

  // Auto-attach dialog handler
  try { cleanups.push(setupDialogHandler(page, session.id)); } catch {}

  handles.set(session.id, { browser, page, engine: resolvedEngine, cleanups, tokenBudget: { total: 0, used: 0 } });

  if (opts.startUrl) {
    try {
      await page.goto(opts.startUrl, { waitUntil: "domcontentloaded" });
    } catch {
      // Non-fatal: session still created
    }
  }

  return { session, page };
}

export function getSessionPage(sessionId: string): Page {
  const handle = handles.get(sessionId);
  if (!handle) throw new SessionNotFoundError(sessionId);
  // Health check: verify the page is still usable (catches stale sessions after MCP recycle)
  try {
    handle.page.url(); // throws if browser/context is closed
  } catch {
    handles.delete(sessionId);
    throw new SessionNotFoundError(sessionId);
  }
  return handle.page;
}

export function getSessionBrowser(sessionId: string): Browser {
  const handle = handles.get(sessionId);
  if (!handle) throw new SessionNotFoundError(sessionId);
  return handle.browser;
}

export function getSessionEngine(sessionId: string): BrowserEngine {
  const handle = handles.get(sessionId);
  if (!handle) throw new SessionNotFoundError(sessionId);
  return handle.engine;
}

export function hasActiveHandle(sessionId: string): boolean {
  return handles.has(sessionId);
}

export function setSessionPage(sessionId: string, page: Page): void {
  const handle = handles.get(sessionId);
  if (!handle) throw new SessionNotFoundError(sessionId);
  handle.page = page;
}

export async function closeSession(sessionId: string): Promise<Session> {
  const handle = handles.get(sessionId);
  if (handle) {
    // Run cleanup functions (network/console listeners)
    for (const cleanup of handle.cleanups) {
      try { cleanup(); } catch {}
    }
    try {
      await handle.page.context().close();
    } catch {}
    try {
      await closePlaywrightBrowser(handle.browser);
    } catch {}
    handles.delete(sessionId);
  }
  return dbCloseSession(sessionId);
}

export function getSession(sessionId: string): Session {
  return dbGetSession(sessionId);
}

export function listSessions(filter?: { status?: SessionStatus; projectId?: string }): Session[] {
  return dbListSessions(filter);
}

export function getActiveSessions(): Session[] {
  return dbListSessions({ status: "active" });
}

export async function closeAllSessions(): Promise<void> {
  for (const [id] of handles) {
    await closeSession(id).catch(() => {});
  }
}

export function getSessionByName(name: string) {
  return dbGetSessionByName(name);
}

export function renameSession(id: string, name: string) {
  return dbRenameSession(id, name);
}

export function getTokenBudget(sessionId: string): { total: number; used: number } | null {
  const handle = handles.get(sessionId);
  return handle ? handle.tokenBudget : null;
}
