#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const _pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string };

import { createSession, closeSession, getSession, listSessions, getSessionPage, getSessionByName, renameSession, setSessionPage, getTokenBudget, getSessionBunView, isBunSession, getActiveSessionForAgent, getDefaultSession, countActiveSessions, isAutoGallery } from "../lib/session.js";
import { navigate, click, type as typeText, fill, scroll, hover, selectOption, checkBox, uploadFile, goBack, goForward, reload, waitForSelector, pressKey, clickText, fillForm, waitForText, watchPage, getWatchChanges, stopWatch, clickRef, typeRef, fillRef, selectRef, checkRef, hoverRef } from "../lib/actions.js";
import { getText, getHTML, getLinks, getTitle, getUrl, extract, extractStructured, extractTable, getAriaSnapshot, findElements, elementExists, getPageInfo } from "../lib/extractor.js";
import { takeScreenshot, generatePDF } from "../lib/screenshot.js";
import { enableNetworkLogging, addInterceptRule, clearInterceptRules, startHAR } from "../lib/network.js";
import { getPerformanceMetrics, startCoverage } from "../lib/performance.js";
import { enableConsoleCapture } from "../lib/console.js";
import { getCookies, setCookie, clearCookies, getLocalStorage, setLocalStorage, getSessionStorage, setSessionStorage } from "../lib/storage.js";
import { startRecording, stopRecording, replayRecording, recordStep } from "../lib/recorder.js";
import { crawl } from "../lib/crawler.js";
import { registerAgent, heartbeat, listAgents, getAgent } from "../lib/agents.js";
import { ensureProject, listProjects, getProjectByName } from "../db/projects.js";
import { getNetworkLog } from "../db/network-log.js";
import { getConsoleLog } from "../db/console-log.js";
import { listEntries, getEntry, tagEntry, untagEntry, favoriteEntry, deleteEntry, searchEntries, getGalleryStats } from "../db/gallery.js";
import { saveToDownloads, listDownloads, getDownload, deleteDownload, cleanStaleDownloads, exportToPath } from "../lib/downloads.js";
import { diffImages } from "../lib/gallery-diff.js";
import { takeSnapshot as takeSnapshotFn, diffSnapshots, getLastSnapshot, setLastSnapshot } from "../lib/snapshot.js";
import { persistFile } from "../lib/files-integration.js";
import { listRecordings, getRecording } from "../db/recordings.js";
import { logEvent, getTimeline } from "../db/timeline.js";
import { newTab, listTabs, switchTab, closeTab } from "../lib/tabs.js";
import { getDialogs, handleDialog } from "../lib/dialogs.js";
import { saveProfile, loadProfile, applyProfile, listProfiles as listProfilesFn, deleteProfile } from "../lib/profiles.js";
import { UseCase, BrowserError } from "../types/index.js";
import type { BrowserEngine } from "../types/index.js";

// ─── Active state ─────────────────────────────────────────────────────────────

const networkLogCleanup = new Map<string, () => void>();
const consoleCaptureCleanup = new Map<string, () => void>();
const harCaptures = new Map<string, ReturnType<typeof startHAR>>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof BrowserError ? e.code : "ERROR";
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg, code }) }],
    isError: true as const,
  };
}

/** Like err() but attempts to capture a screenshot for context. */
async function errWithScreenshot(e: unknown, sessionId?: string) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof BrowserError ? e.code : "ERROR";
  let screenshot_path: string | undefined;
  if (sessionId) {
    try {
      const sid = resolveSessionId(sessionId);
      const page = getSessionPage(sid);
      const result = await takeScreenshot(page, { maxWidth: 800, quality: 50, track: false, thumbnail: false });
      screenshot_path = result.path;
    } catch {}
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg, code, error_screenshot: screenshot_path }) }],
    isError: true as const,
  };
}

/** Resolve session_id: use explicit value, or auto-select the single active session. */
function resolveSessionId(sessionId?: string): string {
  if (sessionId) return sessionId;
  const def = getDefaultSession();
  if (def) return def.session.id;
  const count = countActiveSessions();
  if (count === 0) throw new BrowserError("No active sessions. Create one with browser_session_create first.", "NO_SESSION");
  throw new BrowserError(`${count} active sessions — specify session_id to choose one.`, "AMBIGUOUS_SESSION");
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "@hasna/browser",
  version: "0.0.1",
});

// ── Session Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_session_create",
  "Create a new browser session. If agent_id is set and already has an active session, returns the existing one (use force_new to override). If session_id is omitted on other tools, the single active session is auto-selected. Use cdp_url to attach to an already-running Chrome instance.",
  {
    engine: z.enum(["playwright", "cdp", "lightpanda", "bun", "auto"]).optional().default("auto"),
    use_case: z.string().optional(),
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
    start_url: z.string().optional(),
    headless: z.boolean().optional().default(true),
    viewport_width: z.number().optional().default(1280),
    viewport_height: z.number().optional().default(720),
    stealth: z.boolean().optional().default(false),
    auto_gallery: z.boolean().optional().default(false),
    storage_state: z.string().optional().describe("Name of saved storage state to load (restores cookies/auth from previous session)"),
    force_new: z.boolean().optional().default(false).describe("Force create a new session even if agent already has one"),
    tags: z.array(z.string()).optional(),
    cdp_url: z.string().optional().describe("Connect to existing Chrome via CDP (e.g. http://localhost:9222). Start Chrome with --remote-debugging-port=9222"),
  },
  async ({ engine, use_case, project_id, agent_id, start_url, headless, viewport_width, viewport_height, stealth, auto_gallery, storage_state, force_new, tags, cdp_url }) => {
    try {
      // Auto-reuse: if agent already has an active session, return it
      if (agent_id && !force_new) {
        const existing = getActiveSessionForAgent(agent_id);
        if (existing) return json({ session: existing.session, reused: true });
      }
      const { session } = await createSession({
        engine: engine as BrowserEngine,
        useCase: use_case as UseCase | undefined,
        projectId: project_id,
        agentId: agent_id,
        startUrl: start_url,
        headless,
        viewport: { width: viewport_width, height: viewport_height },
        stealth,
        autoGallery: auto_gallery,
        storageState: storage_state,
        cdpUrl: cdp_url,
      });
      // Apply tags if provided
      if (tags?.length) {
        const { addSessionTag } = await import("../db/sessions.js");
        for (const tag of tags) addSessionTag(session.id, tag);
      }
      logEvent(session.id, "session_created", { engine: session.engine });
      return json({ session, reused: false });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_list",
  "List all browser sessions. Optionally filter by tag.",
  { status: z.enum(["active", "closed", "error"]).optional(), project_id: z.string().optional(), tag: z.string().optional() },
  async ({ status, project_id, tag }) => {
    try {
      if (tag) {
        const { listSessionsByTag } = await import("../db/sessions.js");
        return json({ sessions: listSessionsByTag(tag) });
      }
      return json({ sessions: listSessions({ status, projectId: project_id }) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_close",
  "Close a browser session",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const session = await closeSession(sid);
      networkLogCleanup.get(sid)?.();
      consoleCaptureCleanup.get(sid)?.();
      networkLogCleanup.delete(sid);
      consoleCaptureCleanup.delete(sid);
      harCaptures.delete(sid);
      return json({ session });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_fork",
  "Fork a session: create a new session with the same auth state (cookies, storage) and URL as an existing one. Like git branch for browser sessions.",
  { source_session_id: z.string(), name: z.string().optional() },
  async ({ source_session_id, name }) => {
    try {
      const sourcePage = getSessionPage(source_session_id);
      const sourceUrl = sourcePage.url();

      // Save source state to a temp name
      const tempName = `_fork_${Date.now()}`;
      const { saveStateFromPage } = await import("../lib/storage-state.js");
      await saveStateFromPage(sourcePage, tempName);

      // Create new session with that state
      const { session, page } = await createSession({
        storageState: tempName,
        startUrl: sourceUrl,
        name: name ?? `fork-of-${source_session_id.slice(0, 8)}`,
      });

      // Clean up temp state
      const { deleteState } = await import("../lib/storage-state.js");
      deleteState(tempName);

      return json({ forked_session: session, source_url: sourceUrl });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_timeline",
  "Get chronological action log for a session",
  { session_id: z.string().optional(), limit: z.number().optional().default(50) },
  async ({ session_id, limit }) => {
    try {
      const sid = resolveSessionId(session_id);
      const events = getTimeline(sid, limit);
      return json({ events, count: events.length });
    } catch (e) { return err(e); }
  }
);

// ── Navigation Tools ──────────────────────────────────────────────────────────

server.tool(
  "browser_navigate",
  "Navigate to a URL. Auto-detects redirects, auto-names session, returns compact refs + thumbnail.",
  {
    session_id: z.string().optional(),
    url: z.string(),
    timeout: z.number().optional().default(30000),
    auto_snapshot: z.boolean().optional().default(true),
    auto_thumbnail: z.boolean().optional().default(true),
  },
  async ({ session_id, url, timeout, auto_snapshot, auto_thumbnail }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      // Bun.WebView fast path — sequential to avoid concurrent evaluate() errors
      if (isBunSession(sid)) {
        const bunView = getSessionBunView(sid)!;
        await bunView.goto(url, { timeout });
        // Extra settle time for page JS to finish (Bun.WebView evaluate is not re-entrant)
        await new Promise(r => setTimeout(r, 500));
      } else {
        await navigate(page, url, timeout);
      }
      // Use property access for Bun (no evaluate call), page.title()/url() for Playwright
      const title = await getTitle(page);
      const current_url = await getUrl(page);

      // Redirect detection
      const redirected = current_url !== url && current_url !== url + "/" && url !== current_url.replace(/\/$/, "");
      let redirect_type: string | undefined;
      if (redirected) {
        try {
          const reqHost = new URL(url).hostname;
          const resHost = new URL(current_url).hostname;
          const reqPath = new URL(url).pathname;
          const resPath = new URL(current_url).pathname;
          if (reqHost !== resHost) redirect_type = "canonical";
          else if (resPath.match(/\/[a-z]{2}-[a-z]{2}\//)) redirect_type = "geo";
          else if (current_url.includes("login") || current_url.includes("signin")) redirect_type = "auth";
          else redirect_type = "unknown";
        } catch {}
      }

      // Auto-name session if it has no name
      try {
        const session = getSession(sid);
        if (!session.name) {
          const hostname = new URL(current_url).hostname;
          renameSession(sid, hostname);
        }
      } catch {}

      const result: Record<string, unknown> = {
        url,
        title,
        current_url,
        redirected,
        ...(redirect_type ? { redirect_type } : {}),
      };

      // For Bun.WebView: thumbnail and snapshot must be sequential (no concurrent evaluate())
      // For Playwright: they can run in parallel (but we keep sequential for simplicity)

      // Auto-thumbnail (small, token-efficient)
      if (auto_thumbnail) {
        try {
          const ss = await takeScreenshot(page, { maxWidth: 400, quality: 60, track: false, thumbnail: false });
          result.thumbnail_base64 = ss.base64.length > 50000 ? "" : ss.base64;
        } catch {}
      }

      // Auto-gallery: save screenshot to gallery on every navigation
      if (isAutoGallery(sid)) {
        try {
          const ss = await takeScreenshot(page, { maxWidth: 1280, quality: 70, thumbnail: true });
          const { createEntry } = await import("../db/gallery.js");
          createEntry({ session_id: sid, url: current_url, title, path: ss.path, thumbnail_path: ss.thumbnail_path, format: "webp", width: ss.width, height: ss.height, original_size_bytes: ss.original_size_bytes, compressed_size_bytes: ss.compressed_size_bytes, compression_ratio: ss.compression_ratio, tags: [], is_favorite: false });
        } catch {}
      }

      // Short settle for Bun before snapshot evaluate calls
      if (isBunSession(sid) && auto_snapshot) {
        await new Promise(r => setTimeout(r, 200));
      }

      // Auto-snapshot with compact refs (≤30 elements)
      if (auto_snapshot) {
        try {
          const snap = await takeSnapshotFn(page, sid);
          setLastSnapshot(sid, snap);
          const refEntries = Object.entries(snap.refs).slice(0, 30);
          result.snapshot_refs = refEntries
            .map(([ref, info]) => `${info.role}:${info.name.slice(0, 50)} [${ref}]`)
            .join(", ");
          result.interactive_count = snap.interactive_count;
          result.has_errors = getConsoleLog(sid, "error").length > 0;
        } catch {}
      }

      logEvent(sid, "navigate", { url, title, current_url });
      return json(result);
    } catch (e) { return errWithScreenshot(e, session_id); }
  }
);

server.tool(
  "browser_back",
  "Navigate back in browser history",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await goBack(page);
      return json({ url: page.url() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_forward",
  "Navigate forward in browser history",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await goForward(page);
      return json({ url: page.url() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_reload",
  "Reload the current page",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await reload(page);
      return json({ url: page.url() });
    } catch (e) { return err(e); }
  }
);

// ── Interaction Tools ─────────────────────────────────────────────────────────

server.tool(
  "browser_click",
  "Click an element by ref (from snapshot) or CSS selector. Prefer ref for reliability. Self-healing auto-tries fallback selectors if element not found.",
  { session_id: z.string().optional(), selector: z.string().optional(), ref: z.string().optional(), button: z.enum(["left", "right", "middle"]).optional(), timeout: z.number().optional(), self_heal: z.boolean().optional().default(true).describe("Auto-try fallback selectors if element not found") },
  async ({ session_id, selector, ref, button, timeout, self_heal }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      if (ref) {
        await clickRef(page, sid, ref, { timeout });
        logEvent(sid, "click", { selector: ref, method: "ref" });
        return json({ clicked: ref, method: "ref" });
      }
      if (!selector) return err(new Error("Either ref or selector is required"));
      const healInfo = await click(page, selector, { button, timeout, selfHeal: self_heal });
      logEvent(sid, "click", { selector, method: healInfo.healed ? "healed" : "selector" });
      if (healInfo.healed) {
        return json({ clicked: selector, method: "healed", heal_method: healInfo.method, attempts: healInfo.attempts });
      }
      return json({ clicked: selector, method: "selector" });
    } catch (e) { return errWithScreenshot(e, session_id); }
  }
);

server.tool(
  "browser_type",
  "Type text into an element by ref or selector. Prefer ref. Self-healing auto-tries fallback selectors if element not found.",
  { session_id: z.string().optional(), selector: z.string().optional(), ref: z.string().optional(), text: z.string(), clear: z.boolean().optional().default(false), delay: z.number().optional(), self_heal: z.boolean().optional().default(true).describe("Auto-try fallback selectors if element not found") },
  async ({ session_id, selector, ref, text, clear, delay, self_heal }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      if (ref) {
        await typeRef(page, sid, ref, text, { clear, delay });
        logEvent(sid, "type", { selector: ref, text: text.slice(0, 100) });
        return json({ typed: text, ref, method: "ref" });
      }
      if (!selector) return err(new Error("Either ref or selector is required"));
      const healInfo = await typeText(page, selector, text, { clear, delay, selfHeal: self_heal });
      logEvent(sid, "type", { selector, text: text.slice(0, 100), method: healInfo.healed ? "healed" : "selector" });
      if (healInfo.healed) {
        return json({ typed: text, selector, method: "healed", heal_method: healInfo.method, attempts: healInfo.attempts });
      }
      return json({ typed: text, selector, method: "selector" });
    } catch (e) { return errWithScreenshot(e, session_id); }
  }
);

server.tool(
  "browser_hover",
  "Hover over an element by ref or selector",
  { session_id: z.string().optional(), selector: z.string().optional(), ref: z.string().optional() },
  async ({ session_id, selector, ref }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      if (ref) { await hoverRef(page, sid, ref); return json({ hovered: ref, method: "ref" }); }
      if (!selector) return err(new Error("Either ref or selector is required"));
      await hover(page, selector);
      return json({ hovered: selector, method: "selector" });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_scroll",
  "Scroll the page",
  { session_id: z.string().optional(), direction: z.enum(["up", "down", "left", "right"]).optional().default("down"), amount: z.number().optional().default(300) },
  async ({ session_id, direction, amount }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await scroll(page, direction, amount);
      return json({ scrolled: direction, amount });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_select",
  "Select a dropdown option by ref or selector",
  { session_id: z.string().optional(), selector: z.string().optional(), ref: z.string().optional(), value: z.string() },
  async ({ session_id, selector, ref, value }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      if (ref) { const selected = await selectRef(page, sid, ref, value); return json({ selected, method: "ref" }); }
      if (!selector) return err(new Error("Either ref or selector is required"));
      const selected = await selectOption(page, selector, value);
      return json({ selected, method: "selector" });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_toggle",
  "Check or uncheck a checkbox by ref or selector",
  { session_id: z.string().optional(), selector: z.string().optional(), ref: z.string().optional(), checked: z.boolean() },
  async ({ session_id, selector, ref, checked }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      if (ref) { await checkRef(page, sid, ref, checked); return json({ checked, ref, method: "ref" }); }
      if (!selector) return err(new Error("Either ref or selector is required"));
      await checkBox(page, selector, checked);
      return json({ checked, selector, method: "selector" });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_upload",
  "Upload a file to an input element",
  { session_id: z.string().optional(), selector: z.string(), file_path: z.string() },
  async ({ session_id, selector, file_path }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await uploadFile(page, selector, file_path);
      return json({ uploaded: file_path, selector });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_press_key",
  "Press a keyboard key",
  { session_id: z.string().optional(), key: z.string() },
  async ({ session_id, key }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await pressKey(page, key);
      return json({ pressed: key });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_wait",
  "Wait for a selector to appear",
  { session_id: z.string().optional(), selector: z.string(), state: z.enum(["attached", "detached", "visible", "hidden"]).optional(), timeout: z.number().optional() },
  async ({ session_id, selector, state, timeout }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await waitForSelector(page, selector, { state, timeout });
      return json({ ready: selector });
    } catch (e) { return err(e); }
  }
);

// ── Extraction Tools ──────────────────────────────────────────────────────────

server.tool(
  "browser_get_text",
  "Get text content from the page or a selector. Sanitizes prompt injection by default.",
  { session_id: z.string().optional(), selector: z.string().optional(), sanitize: z.boolean().optional().default(true).describe("Strip prompt injection patterns from text (default: true)") },
  async ({ session_id, selector, sanitize }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const text = await getText(page, selector);
      if (sanitize) {
        const { sanitizeText } = await import("../lib/sanitize.js");
        const sanitized = sanitizeText(text);
        return json({ text: sanitized.text, stripped: sanitized.stripped, warnings: sanitized.warnings });
      }
      return json({ text });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_get_html",
  "Get HTML content from the page or a selector. Sanitizes prompt injection by default.",
  { session_id: z.string().optional(), selector: z.string().optional(), sanitize: z.boolean().optional().default(true).describe("Strip prompt injection patterns and hidden elements from HTML (default: true)") },
  async ({ session_id, selector, sanitize }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const html = await getHTML(page, selector);
      if (sanitize) {
        const { sanitizeHTML } = await import("../lib/sanitize.js");
        const sanitized = sanitizeHTML(html);
        return json({ html: sanitized.text, stripped: sanitized.stripped, warnings: sanitized.warnings });
      }
      return json({ html });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_get_links",
  "Get all links from the current page",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const links = await getLinks(page);
      return json({ links, count: links.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_extract",
  "Extract content from the page in a specified format. Sanitizes prompt injection by default.",
  {
    session_id: z.string().optional(),
    format: z.enum(["text", "html", "links", "table", "structured"]).optional().default("text"),
    selector: z.string().optional(),
    schema: z.record(z.string()).optional(),
    sanitize: z.boolean().optional().default(true).describe("Strip prompt injection patterns from extracted content (default: true)"),
  },
  async ({ session_id, format, selector, schema, sanitize }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const result = await extract(page, { format, selector, schema });
      if (sanitize) {
        const { sanitizeText, sanitizeHTML } = await import("../lib/sanitize.js");
        if (result.text) {
          const s = sanitizeText(result.text);
          result.text = s.text;
          (result as any).stripped = s.stripped;
          (result as any).warnings = s.warnings;
        }
        if (result.html) {
          const s = sanitizeHTML(result.html);
          result.html = s.text;
          (result as any).stripped = s.stripped;
          (result as any).warnings = s.warnings;
        }
      }
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_find",
  "Find elements matching a selector and return their text",
  { session_id: z.string().optional(), selector: z.string() },
  async ({ session_id, selector }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const elements = await findElements(page, selector);
      const texts = await Promise.all(elements.map((el) => el.textContent()));
      return json({ count: elements.length, texts });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_snapshot",
  "Get accessibility snapshot with element refs (@e0, @e1...). Use compact=true (default) for token-efficient output. Use refs in browser_click, browser_type, etc. Sanitizes prompt injection by default.",
  {
    session_id: z.string().optional(),
    compact: z.boolean().optional().default(true),
    max_refs: z.number().optional().default(50),
    full_tree: z.boolean().optional().default(false),
    sanitize: z.boolean().optional().default(true).describe("Strip prompt injection patterns from snapshot text (default: true)"),
  },
  async ({ session_id, compact, max_refs, full_tree, sanitize }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const result = await takeSnapshotFn(page, sid);
      setLastSnapshot(sid, result);

      // Apply sanitization to tree text
      let injection_warnings: string[] | undefined;
      if (sanitize) {
        const { sanitizeText } = await import("../lib/sanitize.js");
        const sanitized = sanitizeText(result.tree);
        if (sanitized.stripped > 0) {
          injection_warnings = sanitized.warnings;
          result.tree = sanitized.text;
        }
      }

      // Limit refs to max_refs
      const refEntries = Object.entries(result.refs).slice(0, max_refs);
      const limitedRefs = Object.fromEntries(refEntries);
      const truncated = Object.keys(result.refs).length > max_refs;

      if (compact && !full_tree) {
        // Compact: return refs as a single concise line per element
        const compactRefs = refEntries
          .map(([ref, info]) => `${info.role}:${info.name.slice(0, 60)} [${ref}]${info.checked !== undefined ? ` checked=${info.checked}` : ""}${!info.enabled ? " disabled" : ""}`)
          .join("\n");
        return json({
          snapshot_compact: compactRefs,
          interactive_count: result.interactive_count,
          shown_count: refEntries.length,
          truncated,
          refs: limitedRefs,
          ...(injection_warnings ? { injection_warnings } : {}),
        });
      }

      // Full tree mode — truncate to 5000 chars
      const tree = full_tree ? result.tree : result.tree.slice(0, 5000) + (result.tree.length > 5000 ? "\n... (truncated — use full_tree=true for complete)" : "");
      return json({ snapshot: tree, refs: limitedRefs, interactive_count: result.interactive_count, truncated, ...(injection_warnings ? { injection_warnings } : {}) });
    } catch (e) { return err(e); }
  }
);

// ── Capture Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_screenshot",
  "Take a screenshot. Use selector to capture a specific element/section instead of the full page. Use detail='high' for AI-readable full image, 'low' for fast thumbnail. Use annotate=true to overlay numbered labels on interactive elements.",
  {
    session_id: z.string().optional(),
    selector: z.string().optional().describe("CSS selector to screenshot a specific section (e.g. '#main', '.header', 'form')"),
    full_page: z.boolean().optional().default(false),
    format: z.enum(["png", "jpeg", "webp"]).optional().default("webp"),
    quality: z.number().optional().default(60),
    max_width: z.number().optional().default(800),
    compress: z.boolean().optional().default(true),
    thumbnail: z.boolean().optional().default(true),
    annotate: z.boolean().optional().default(false),
    detail: z.enum(["low", "high"]).optional().default("low").describe("'low' = thumbnail only (fast, saves tokens). 'high' = full readable image in base64 (larger but AI can read text)."),
  },
  async ({ session_id, selector, full_page, format, quality, max_width, compress, thumbnail, annotate, detail }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);

      // Annotated screenshot path
      if (annotate && !selector && !full_page) {
        const { annotateScreenshot } = await import("../lib/annotate.js");
        const annotated = await annotateScreenshot(page, sid);
        const base64 = annotated.buffer.toString("base64");
        return json({
          base64: base64.length > 50000 ? undefined : base64,
          base64_truncated: base64.length > 50000,
          size_bytes: annotated.buffer.length,
          annotations: annotated.annotations,
          label_to_ref: annotated.labelToRef,
          annotation_count: annotated.annotations.length,
        });
      }

      // detail=high: use larger image for AI readability (1280px, quality 75)
      const effectiveMaxWidth = detail === "high" ? 1280 : max_width;
      const effectiveQuality = detail === "high" ? 75 : quality;

      const result = await takeScreenshot(page, { selector, fullPage: full_page, format, quality: effectiveQuality, maxWidth: effectiveMaxWidth, compress, thumbnail });
      // Populate URL
      result.url = page.url();
      // Auto-save to downloads folder
      try {
        const buf = Buffer.from(result.base64, "base64");
        const filename = result.path.split("/").pop() ?? `screenshot.${format ?? "webp"}`;
        const dl = saveToDownloads(buf, filename, { sessionId: sid, type: "screenshot", sourceUrl: page.url() });
        (result as any).download_id = dl.id;
      } catch { /* non-fatal */ }
      // Token estimate before truncation
      (result as any).estimated_tokens = Math.ceil(result.base64.length / 4);
      // Smart base64 truncation — detail=high skips truncation so AI can read the image
      if (detail !== "high" && result.base64.length > 40000) {
        (result as any).base64_truncated = true;
        (result as any).full_image_path = result.path;
        result.base64 = result.thumbnail_base64 ?? "";
      }
      logEvent(sid, "screenshot", { path: result.path, detail, selector });
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_pdf",
  "Generate a PDF of the current page",
  {
    session_id: z.string().optional(),
    format: z.enum(["A4", "Letter", "A3", "A5"]).optional().default("A4"),
    landscape: z.boolean().optional().default(false),
    print_background: z.boolean().optional().default(true),
  },
  async ({ session_id, format, landscape, print_background }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const result = await generatePDF(page, { format, landscape, printBackground: print_background });
      // Auto-save to downloads
      try {
        const buf = Buffer.from(result.base64, "base64");
        const filename = result.path.split("/").pop() ?? "document.pdf";
        const dl = saveToDownloads(buf, filename, { sessionId: sid, type: "pdf", sourceUrl: page.url() });
        (result as any).download_id = dl.id;
      } catch { /* non-fatal */ }
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── Evaluate ──────────────────────────────────────────────────────────────────

server.tool(
  "browser_evaluate",
  "Execute JavaScript in the page context",
  { session_id: z.string().optional(), script: z.string() },
  async ({ session_id, script }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const result = await page.evaluate(script);
      return json({ result });
    } catch (e) { return errWithScreenshot(e, session_id); }
  }
);

// ── Storage Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_cookies_get",
  "Get cookies from the current session",
  { session_id: z.string().optional(), name: z.string().optional(), domain: z.string().optional() },
  async ({ session_id, name, domain }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      return json({ cookies: await getCookies(page, { name, domain }) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_cookies_set",
  "Set a cookie in the current session",
  {
    session_id: z.string().optional(),
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional().default("/"),
    expires: z.number().optional(),
    http_only: z.boolean().optional().default(false),
    secure: z.boolean().optional().default(false),
  },
  async ({ session_id, name, value, domain, path, expires, http_only, secure }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await setCookie(page, {
        name, value,
        domain: domain ?? new URL(page.url()).hostname,
        path: path ?? "/",
        expires: expires ?? -1,
        httpOnly: http_only,
        secure,
        sameSite: "Lax",
      });
      return json({ set: name });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_cookies_clear",
  "Clear cookies from the current session",
  { session_id: z.string().optional(), name: z.string().optional(), domain: z.string().optional() },
  async ({ session_id, name, domain }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await clearCookies(page, name || domain ? { name, domain } : undefined);
      return json({ cleared: true });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_storage_get",
  "Get localStorage or sessionStorage values",
  { session_id: z.string().optional(), key: z.string().optional(), storage_type: z.enum(["local", "session"]).optional().default("local") },
  async ({ session_id, key, storage_type }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const value = storage_type === "session"
        ? await getSessionStorage(page, key)
        : await getLocalStorage(page, key);
      return json({ value });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_storage_set",
  "Set a localStorage or sessionStorage value",
  { session_id: z.string().optional(), key: z.string(), value: z.string(), storage_type: z.enum(["local", "session"]).optional().default("local") },
  async ({ session_id, key, value, storage_type }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      if (storage_type === "session") {
        await setSessionStorage(page, key, value);
      } else {
        await setLocalStorage(page, key, value);
      }
      return json({ set: key });
    } catch (e) { return err(e); }
  }
);

// ── Network Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_network_log",
  "Get captured network requests for a session",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      // Start logging if not already
      if (!networkLogCleanup.has(sid)) {
        const page = getSessionPage(sid);
        const cleanup = enableNetworkLogging(page, sid);
        networkLogCleanup.set(sid, cleanup);
      }
      const log = getNetworkLog(sid);
      return json({ requests: log, count: log.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_network_intercept",
  "Add a network interception rule",
  {
    session_id: z.string().optional(),
    pattern: z.string(),
    action: z.enum(["block", "modify", "log"]),
    response_status: z.number().optional(),
    response_body: z.string().optional(),
  },
  async ({ session_id, pattern, action, response_status, response_body }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await addInterceptRule(page, {
        pattern,
        action,
        response: response_status != null && response_body != null
          ? { status: response_status, body: response_body }
          : undefined,
      });
      return json({ intercepting: pattern, action });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_har_start",
  "Start HAR capture for a session",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const capture = startHAR(page);
      harCaptures.set(sid, capture);
      return json({ started: true });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_har_stop",
  "Stop HAR capture and return the HAR data",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const capture = harCaptures.get(sid);
      if (!capture) return err(new Error("No active HAR capture for this session"));
      const har = capture.stop();
      harCaptures.delete(sid);
      // Auto-save HAR to downloads
      let download_id: string | undefined;
      try {
        const harBuf = Buffer.from(JSON.stringify(har, null, 2));
        const dl = saveToDownloads(harBuf, `capture-${Date.now()}.har`, { sessionId: sid, type: "har" });
        download_id = dl.id;
      } catch { /* non-fatal */ }
      return json({ har, entry_count: har.log.entries.length, download_id });
    } catch (e) { return err(e); }
  }
);

// ── Response Intercept Tools ──────────────────────────────────────────────────

server.tool(
  "browser_intercept_response",
  "Intercept and modify API responses for testing. Mock data, simulate errors, add latency.",
  {
    session_id: z.string().optional(),
    url_pattern: z.string().describe("URL pattern to intercept (e.g. '**/api/users*')"),
    action: z.enum(["mock", "delay", "error"]).describe("What to do with matched requests"),
    mock_body: z.string().optional().describe("Response body for mock action"),
    mock_content_type: z.string().optional().default("application/json"),
    status_code: z.number().optional().default(200).describe("HTTP status code (for mock/error)"),
    delay_ms: z.number().optional().default(3000).describe("Delay in ms (for delay action)"),
  },
  async ({ session_id, url_pattern, action, mock_body, mock_content_type, status_code, delay_ms }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);

      await page.route(url_pattern, async (route) => {
        if (action === "mock") {
          await route.fulfill({
            status: status_code,
            contentType: mock_content_type,
            body: mock_body ?? "{}",
          });
        } else if (action === "error") {
          await route.fulfill({
            status: status_code ?? 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Intercepted error", status: status_code }),
          });
        } else if (action === "delay") {
          await new Promise(r => setTimeout(r, delay_ms));
          await route.continue();
        }
      });

      logEvent(sid, "intercept_set", { url_pattern, action, status_code });
      return json({ intercepted: true, url_pattern, action });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_intercept_clear",
  "Remove all response intercepts from a session",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await page.unrouteAll({ behavior: "ignoreErrors" });
      return json({ cleared: true });
    } catch (e) { return err(e); }
  }
);

// ── Performance Tools ─────────────────────────────────────────────────────────

server.tool(
  "browser_performance",
  "Get performance metrics for the current page",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const metrics = await getPerformanceMetrics(page);
      return json({ metrics });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_detect_env",
  "Detect if the current page is running in production, development, staging, or local environment. Analyzes URL, meta tags, source maps, analytics SDKs, and more.",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { detectEnvironment } = await import("../lib/env-detector.js");
      const result = await detectEnvironment(page);
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_performance_deep",
  "Deep performance analysis: Web Vitals, resource breakdown by type, largest resources, third-party scripts with categories, DOM complexity, memory usage.",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { getDeepPerformance } = await import("../lib/deep-performance.js");
      const result = await getDeepPerformance(page);
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── Accessibility Tools ───────────────────────────────────────────────────────

server.tool(
  "browser_accessibility_audit",
  "Run accessibility audit on the page. Injects axe-core and returns violations grouped by severity (critical, serious, moderate, minor).",
  { session_id: z.string().optional(), selector: z.string().optional().describe("Scope audit to a specific element") },
  async ({ session_id, selector }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);

      // Inject axe-core
      await page.evaluate(`
        if (!window.axe) {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
          document.head.appendChild(script);
          await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = reject;
          });
        }
      `);

      // Small wait for axe to initialize
      await new Promise(r => setTimeout(r, 500));

      // Run audit
      const results = await page.evaluate((sel) => {
        const opts: any = {};
        if (sel) opts.include = [sel];
        return (window as any).axe.run(opts.include ? { include: [sel] } : document).then((r: any) => ({
          violations: r.violations.map((v: any) => ({
            id: v.id,
            impact: v.impact,
            description: v.description,
            help: v.help,
            helpUrl: v.helpUrl,
            nodes_count: v.nodes.length,
            selectors: v.nodes.slice(0, 3).map((n: any) => n.target?.[0] ?? ""),
          })),
          passes: r.passes.length,
          violations_count: r.violations.length,
          incomplete: r.incomplete.length,
        }));
      }, selector);

      // Group by impact
      const byImpact: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      for (const v of (results as any).violations) {
        byImpact[v.impact] = (byImpact[v.impact] || 0) + 1;
      }

      return json({ ...results, by_impact: byImpact, score: Math.max(0, 100 - (results as any).violations_count * 5) });
    } catch (e) { return err(e); }
  }
);

// ── Console Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_console_log",
  "Get captured console messages for a session",
  { session_id: z.string().optional(), level: z.enum(["log", "warn", "error", "debug", "info"]).optional() },
  async ({ session_id, level }) => {
    try {
      const sid = resolveSessionId(session_id);
      if (!consoleCaptureCleanup.has(sid)) {
        const page = getSessionPage(sid);
        const cleanup = enableConsoleCapture(page, sid);
        consoleCaptureCleanup.set(sid, cleanup);
      }
      const messages = getConsoleLog(sid, level as import("../types/index.js").ConsoleLevel | undefined);
      return json({ messages, count: messages.length });
    } catch (e) { return err(e); }
  }
);

// ── Recording Tools ───────────────────────────────────────────────────────────

server.tool(
  "browser_record_start",
  "Start recording actions in a session",
  { session_id: z.string().optional(), name: z.string(), project_id: z.string().optional() },
  async ({ session_id, name }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const recording = startRecording(sid, name, page.url());
      return json({ recording_id: recording.id, name: recording.name });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_record_step",
  "Manually add a step to an active recording",
  {
    recording_id: z.string(),
    type: z.enum(["navigate", "click", "type", "scroll", "hover", "select", "check", "evaluate"]),
    selector: z.string().optional(),
    value: z.string().optional(),
    url: z.string().optional(),
  },
  async ({ recording_id, type, selector, value, url }) => {
    try {
      recordStep(recording_id, { type, selector, value, url });
      return json({ recorded: type });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_record_stop",
  "Stop recording and save the recording",
  { recording_id: z.string() },
  async ({ recording_id }) => {
    try {
      const recording = stopRecording(recording_id);
      return json({ recording, steps: recording.steps.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_record_replay",
  "Replay a recorded sequence in a session",
  { session_id: z.string().optional(), recording_id: z.string() },
  async ({ session_id, recording_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const result = await replayRecording(recording_id, page);
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_recordings_list",
  "List all recordings",
  { project_id: z.string().optional() },
  async ({ project_id }) => {
    try {
      return json({ recordings: listRecordings(project_id) });
    } catch (e) { return err(e); }
  }
);

// ── Workflow Tools ─────────────────────────────────────────────────────────

server.tool(
  "browser_workflow_save",
  "Save a recording as a reusable workflow with self-healing replay",
  { recording_id: z.string(), name: z.string(), description: z.string().optional() },
  async ({ recording_id, name, description }) => {
    try {
      const { saveWorkflowFromRecording } = await import("../lib/workflows.js");
      return json(saveWorkflowFromRecording(recording_id, name, description));
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_workflow_list",
  "List all saved workflows",
  {},
  async () => {
    try {
      const { listWorkflows } = await import("../lib/workflows.js");
      const workflows = listWorkflows();
      return json({ workflows: workflows.map(w => ({ ...w, steps: `${w.steps.length} steps` })), count: workflows.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_workflow_run",
  "Run a saved workflow with self-healing. If selectors changed, auto-adapts and reports what was healed.",
  { session_id: z.string().optional(), name: z.string() },
  async ({ session_id, name }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { getWorkflowByName, runWorkflow } = await import("../lib/workflows.js");
      const workflow = getWorkflowByName(name);
      if (!workflow) return err(new Error(`Workflow '${name}' not found`));
      const result = await runWorkflow(workflow, page);
      logEvent(sid, "workflow_run", { name, ...result });
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_workflow_delete",
  "Delete a saved workflow",
  { name: z.string() },
  async ({ name }) => {
    try {
      const { deleteWorkflow } = await import("../lib/workflows.js");
      return json({ deleted: deleteWorkflow(name) });
    } catch (e) { return err(e); }
  }
);

// ── Crawl Tools ───────────────────────────────────────────────────────────────

server.tool(
  "browser_crawl",
  "Crawl a URL recursively and return discovered pages",
  {
    url: z.string(),
    max_depth: z.number().optional().default(2),
    max_pages: z.number().optional().default(50),
    same_domain: z.boolean().optional().default(true),
    project_id: z.string().optional(),
    engine: z.enum(["playwright", "cdp", "lightpanda", "bun", "auto"]).optional().default("auto"),
  },
  async ({ url, max_depth, max_pages, same_domain, project_id, engine }) => {
    try {
      const result = await crawl(url, {
        maxDepth: max_depth,
        maxPages: max_pages,
        sameDomain: same_domain,
        projectId: project_id,
        engine: engine as BrowserEngine,
      });
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── Agent Tools ───────────────────────────────────────────────────────────────

server.tool(
  "browser_register_agent",
  "Register an agent with the browser service",
  {
    name: z.string(),
    description: z.string().optional(),
    session_id: z.string().optional().optional(),
    project_id: z.string().optional(),
    working_dir: z.string().optional(),
  },
  async ({ name, description, session_id, project_id, working_dir }) => {
    try {
      const agent = registerAgent(name, { description, sessionId: session_id, projectId: project_id, workingDir: working_dir });
      return json({ agent });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_heartbeat",
  "Send a heartbeat for an agent",
  { agent_id: z.string() },
  async ({ agent_id }) => {
    try {
      heartbeat(agent_id);
      return json({ ok: true, agent_id, timestamp: new Date().toISOString() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_agent_list",
  "List registered agents",
  { project_id: z.string().optional() },
  async ({ project_id }) => {
    try {
      return json({ agents: listAgents(project_id) });
    } catch (e) { return err(e); }
  }
);

// ── Project Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_project_create",
  "Create or ensure a project exists",
  { name: z.string(), path: z.string(), description: z.string().optional() },
  async ({ name, path, description }) => {
    try {
      const project = ensureProject(name, path, description);
      return json({ project });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_project_list",
  "List all registered projects",
  {},
  async () => {
    try {
      return json({ projects: listProjects() });
    } catch (e) { return err(e); }
  }
);

// ── Combined: scroll + screenshot ─────────────────────────────────────────────

server.tool(
  "browser_scroll_and_screenshot",
  "Scroll the page and take a screenshot in one call. Saves 3 separate tool calls.",
  { session_id: z.string().optional(), direction: z.enum(["up", "down", "left", "right"]).optional().default("down"), amount: z.number().optional().default(500), wait_ms: z.number().optional().default(300) },
  async ({ session_id, direction, amount, wait_ms }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await scroll(page, direction, amount);
      await new Promise((r) => setTimeout(r, wait_ms));
      const result = await takeScreenshot(page, { maxWidth: 1280, track: true });
      result.url = page.url();
      if (result.base64.length > 50000) {
        (result as any).base64_truncated = true;
        (result as any).full_image_path = result.path;
        result.base64 = result.thumbnail_base64 ?? "";
      }
      return json({ scrolled: { direction, amount }, screenshot: result });
    } catch (e) { return err(e); }
  }
);

// ── Wait for navigation ───────────────────────────────────────────────────────

server.tool(
  "browser_wait_for_navigation",
  "Wait for URL change after a click or action. Returns the new URL and title.",
  { session_id: z.string().optional(), timeout: z.number().optional().default(30000), url_pattern: z.string().optional() },
  async ({ session_id, timeout, url_pattern }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const start = Date.now();
      if (url_pattern) {
        await page.waitForURL(url_pattern, { timeout });
      } else {
        await page.waitForLoadState("domcontentloaded", { timeout });
      }
      return json({ url: page.url(), title: await getTitle(page), elapsed_ms: Date.now() - start });
    } catch (e) { return err(e); }
  }
);

// ── Session naming ────────────────────────────────────────────────────────────

server.tool(
  "browser_session_get_by_name",
  "Get a session by its name",
  { name: z.string() },
  async ({ name }) => {
    try {
      const session = getSessionByName(name);
      if (!session) return err(new Error(`Session not found with name: ${name}`));
      return json({ session });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_rename",
  "Rename a browser session",
  { session_id: z.string().optional(), name: z.string() },
  async ({ session_id, name }) => {
    try {
      const sid = resolveSessionId(session_id);
      return json({ session: renameSession(sid, name) });
    } catch (e) { return err(e); }
  }
);

// ── Session Lock/Claim ────────────────────────────────────────────────────────

server.tool(
  "browser_session_lock",
  "Lock a session so only the specified agent can use it",
  { session_id: z.string().optional(), agent_id: z.string() },
  async ({ session_id, agent_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const { lockSession } = await import("../db/sessions.js");
      return json({ session: lockSession(sid, agent_id) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_unlock",
  "Unlock a session",
  { session_id: z.string().optional(), agent_id: z.string().optional() },
  async ({ session_id, agent_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const { unlockSession } = await import("../db/sessions.js");
      return json({ session: unlockSession(sid, agent_id) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_transfer",
  "Transfer session ownership to another agent",
  { session_id: z.string().optional(), to_agent_id: z.string() },
  async ({ session_id, to_agent_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const { transferSession } = await import("../db/sessions.js");
      return json({ session: transferSession(sid, to_agent_id) });
    } catch (e) { return err(e); }
  }
);

// ── Session Tagging ──────────────────────────────────────────────────────────

server.tool(
  "browser_session_tag",
  "Add a tag to a session for categorization (e.g. qa, scraping, monitoring)",
  { session_id: z.string().optional(), tag: z.string() },
  async ({ session_id, tag }) => {
    try {
      const sid = resolveSessionId(session_id);
      const { addSessionTag } = await import("../db/sessions.js");
      return json({ tags: addSessionTag(sid, tag) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_untag",
  "Remove a tag from a session",
  { session_id: z.string().optional(), tag: z.string() },
  async ({ session_id, tag }) => {
    try {
      const sid = resolveSessionId(session_id);
      const { removeSessionTag } = await import("../db/sessions.js");
      return json({ tags: removeSessionTag(sid, tag) });
    } catch (e) { return err(e); }
  }
);

// ── Storage State Tools ───────────────────────────────────────────────────────

server.tool(
  "browser_session_save_state",
  "Save current session's auth state (cookies, localStorage) for reuse. Use after login to avoid re-authenticating.",
  { session_id: z.string().optional(), name: z.string().describe("Name for this state (e.g. 'github', 'gmail')") },
  async ({ session_id, name }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { saveStateFromPage } = await import("../lib/storage-state.js");
      const path = await saveStateFromPage(page, name);
      return json({ saved: true, name, path });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_list_states",
  "List all saved storage states (auth snapshots)",
  {},
  async () => {
    try {
      const { listStates } = await import("../lib/storage-state.js");
      const states = listStates();
      return json({ states, count: states.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_delete_state",
  "Delete a saved storage state",
  { name: z.string() },
  async ({ name }) => {
    try {
      const { deleteState } = await import("../lib/storage-state.js");
      return json({ deleted: deleteState(name), name });
    } catch (e) { return err(e); }
  }
);

// ── Auth Flow Tools ──────────────────────────────────────────────────────────

server.tool(
  "browser_auth_record",
  "Start recording a login flow. Navigate to the login page, perform the login, then call browser_auth_stop to save.",
  { session_id: z.string().optional(), name: z.string().describe("Name for this auth flow (e.g. 'github', 'gmail')"), start_url: z.string().optional().describe("Login page URL") },
  async ({ session_id, name, start_url }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      if (start_url) await navigate(page, start_url);
      const recording = startRecording(sid, `auth-${name}`, page.url());
      return json({ recording_id: recording.id, name, message: "Recording started. Perform login, then call browser_auth_stop." });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_auth_stop",
  "Stop recording a login flow and save as a reusable auth flow with storage state.",
  { session_id: z.string().optional(), name: z.string(), recording_id: z.string() },
  async ({ session_id, name, recording_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const recording = stopRecording(recording_id);
      // Save storage state
      const { saveStateFromPage } = await import("../lib/storage-state.js");
      const statePath = await saveStateFromPage(page, name);
      // Extract domain
      let domain = "";
      try { domain = new URL(page.url()).hostname; } catch {}
      // Save auth flow
      const { saveAuthFlow } = await import("../lib/auth-flow.js");
      const flow = saveAuthFlow({ name, domain, recordingId: recording.id, storageStatePath: statePath });
      return json({ flow, recording_steps: recording.steps.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_auth_replay",
  "Manually replay a saved auth flow for a domain",
  { session_id: z.string().optional(), name: z.string().describe("Auth flow name to replay") },
  async ({ session_id, name }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { getAuthFlowByName, tryReplayAuth } = await import("../lib/auth-flow.js");
      const flow = getAuthFlowByName(name);
      if (!flow) return err(new Error(`Auth flow '${name}' not found`));
      const result = await tryReplayAuth(page, flow.domain);
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_auth_list",
  "List all saved auth flows",
  {},
  async () => {
    try {
      const { listAuthFlows } = await import("../lib/auth-flow.js");
      return json({ flows: listAuthFlows() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_auth_delete",
  "Delete a saved auth flow",
  { name: z.string() },
  async ({ name }) => {
    try {
      const { deleteAuthFlow } = await import("../lib/auth-flow.js");
      return json({ deleted: deleteAuthFlow(name) });
    } catch (e) { return err(e); }
  }
);

// ── QoL: click by text ────────────────────────────────────────────────────────

server.tool(
  "browser_click_text",
  "Click an element by its visible text content",
  { session_id: z.string().optional(), text: z.string(), exact: z.boolean().optional().default(false), timeout: z.number().optional() },
  async ({ session_id, text, exact, timeout }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      await clickText(page, text, { exact, timeout });
      return json({ clicked: text });
    } catch (e) { return err(e); }
  }
);

// ── QoL: fill form ────────────────────────────────────────────────────────────

server.tool(
  "browser_fill_form",
  "Fill multiple form fields in one call. Fields map: { selector: value }. Handles text, checkboxes, selects. Self-healing auto-tries fallback selectors per field.",
  {
    session_id: z.string().optional(),
    fields: z.record(z.union([z.string(), z.boolean()])),
    submit_selector: z.string().optional(),
    self_heal: z.boolean().optional().default(true).describe("Auto-try fallback selectors if element not found"),
  },
  async ({ session_id, fields, submit_selector, self_heal }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const result = await fillForm(page, fields, submit_selector, self_heal);
      return json(result);
    } catch (e) { return errWithScreenshot(e, session_id); }
  }
);

// ── Vision fallback ──────────────────────────────────────────────────────────

server.tool(
  "browser_find_visual",
  "Find an element using AI vision when selectors and a11y refs fail. Useful for canvas, images, custom widgets. Takes a screenshot and asks a vision model to locate the element.",
  {
    session_id: z.string().optional(),
    description: z.string().describe("Natural language description of the element to find (e.g. 'the blue Submit button', 'the search icon in the top right')"),
    click: z.boolean().optional().default(false).describe("Click the element after finding it"),
    model: z.string().optional().describe("Vision model to use (default: claude-sonnet-4-5-20250929)"),
  },
  async ({ session_id, description, click: doClick, model }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      if (doClick) {
        const { clickByVision } = await import("../lib/vision-fallback.js");
        const result = await clickByVision(page, description, { model });
        logEvent(sid, "vision_click", { query: description, ...result });
        return json(result);
      } else {
        const { findElementByVision } = await import("../lib/vision-fallback.js");
        const result = await findElementByVision(page, description, { model });
        logEvent(sid, "vision_find", { query: description, ...result });
        return json(result);
      }
    } catch (e) { return err(e); }
  }
);

// ── Wait for network idle ─────────────────────────────────────────────────────

server.tool(
  "browser_wait_for_idle",
  "Wait until no network requests are in-flight for a specified duration. Essential for SPAs that load data after navigation.",
  {
    session_id: z.string().optional(),
    idle_time: z.number().optional().default(2000).describe("How long (ms) network must be idle to consider page loaded"),
    timeout: z.number().optional().default(30000).describe("Max wait time (ms) before giving up"),
  },
  async ({ session_id, idle_time, timeout }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);

      const t0 = Date.now();
      let lastActivity = Date.now();
      let pending = 0;

      const onRequest = () => { pending++; lastActivity = Date.now(); };
      const onResponse = () => { pending = Math.max(0, pending - 1); if (pending === 0) lastActivity = Date.now(); };
      const onFailed = () => { pending = Math.max(0, pending - 1); if (pending === 0) lastActivity = Date.now(); };

      page.on("request", onRequest);
      page.on("response", onResponse);
      page.on("requestfailed", onFailed);

      try {
        await new Promise<void>((resolve, reject) => {
          const check = () => {
            const now = Date.now();
            if (now - t0 > timeout) {
              reject(new Error(`Timeout after ${timeout}ms (${pending} requests still pending)`));
              return;
            }
            if (pending === 0 && now - lastActivity >= idle_time) {
              resolve();
              return;
            }
            setTimeout(check, 100);
          };
          check();
        });
      } finally {
        page.removeListener("request", onRequest);
        page.removeListener("response", onResponse);
        page.removeListener("requestfailed", onFailed);
      }

      const waited_ms = Date.now() - t0;
      return json({ idle: true, waited_ms, pending_requests: 0 });
    } catch (e) { return err(e); }
  }
);

// ── QoL: wait for text ────────────────────────────────────────────────────────

server.tool(
  "browser_wait_for_text",
  "Wait until specific text appears on the page",
  { session_id: z.string().optional(), text: z.string(), timeout: z.number().optional().default(10000), exact: z.boolean().optional().default(false) },
  async ({ session_id, text, timeout, exact }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const start = Date.now();
      await waitForText(page, text, { timeout, exact });
      return json({ found: true, elapsed_ms: Date.now() - start });
    } catch (e) { return err(e); }
  }
);

// ── QoL: element exists ───────────────────────────────────────────────────────

server.tool(
  "browser_element_exists",
  "Check if a selector exists on the page (no throw, returns boolean)",
  { session_id: z.string().optional(), selector: z.string(), check_visible: z.boolean().optional().default(false) },
  async ({ session_id, selector, check_visible }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      return json(await elementExists(page, selector, { visible: check_visible }));
    } catch (e) { return err(e); }
  }
);

// ── QoL: page info ────────────────────────────────────────────────────────────

server.tool(
  "browser_get_page_info",
  "Get a full page summary in one call: url, title, meta tags, link/image/form counts, text length",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const info = await getPageInfo(page);
      // Enrich with console error status if logging is active
      const errors = getConsoleLog(sid, "error");
      info.has_console_errors = errors.length > 0;
      return json(info);
    } catch (e) { return err(e); }
  }
);

// ── QoL: has errors ───────────────────────────────────────────────────────────

server.tool(
  "browser_has_errors",
  "Quick check: does the session have any console errors?",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const errors = getConsoleLog(sid, "error");
      return json({ has_errors: errors.length > 0, error_count: errors.length, errors });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_clear_errors",
  "Clear console error log for a session",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const { clearConsoleLog } = await import("../db/console-log.js");
      clearConsoleLog(sid);
      return json({ cleared: true });
    } catch (e) { return err(e); }
  }
);

// ── Watch ─────────────────────────────────────────────────────────────────────

const activeWatchHandles = new Map<string, ReturnType<typeof watchPage>>();

server.tool(
  "browser_watch_start",
  "Start watching a page for DOM changes",
  { session_id: z.string().optional(), selector: z.string().optional(), interval_ms: z.number().optional().default(500), max_changes: z.number().optional().default(50) },
  async ({ session_id, selector, interval_ms, max_changes }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const handle = watchPage(page, { selector, intervalMs: interval_ms, maxChanges: max_changes });
      activeWatchHandles.set(handle.id, handle);
      return json({ watch_id: handle.id });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_watch_get_changes",
  "Get DOM changes captured by a watch",
  { watch_id: z.string() },
  async ({ watch_id }) => {
    try {
      const changes = getWatchChanges(watch_id);
      return json({ changes, count: changes.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_watch_stop",
  "Stop a DOM change watcher",
  { watch_id: z.string() },
  async ({ watch_id }) => {
    try {
      stopWatch(watch_id);
      activeWatchHandles.delete(watch_id);
      return json({ stopped: true });
    } catch (e) { return err(e); }
  }
);

// ── Gallery ───────────────────────────────────────────────────────────────────

server.tool(
  "browser_gallery_list",
  "List screenshot gallery entries with optional filters",
  {
    project_id: z.string().optional(),
    session_id: z.string().optional().optional(),
    tag: z.string().optional(),
    is_favorite: z.boolean().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    limit: z.number().optional().default(50),
    offset: z.number().optional().default(0),
  },
  async ({ project_id, session_id, tag, is_favorite, date_from, date_to, limit, offset }) => {
    try {
      const entries = listEntries({ projectId: project_id, sessionId: session_id, tag, isFavorite: is_favorite, dateFrom: date_from, dateTo: date_to, limit, offset });
      return json({ entries, count: entries.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_gallery_get",
  "Get a gallery entry by id, including thumbnail base64",
  { id: z.string() },
  async ({ id }) => {
    try {
      const entry = getEntry(id);
      if (!entry) return err(new Error(`Gallery entry not found: ${id}`));
      // Read thumbnail base64 if path exists
      let thumbnail_base64: string | undefined;
      if (entry.thumbnail_path) {
        try { thumbnail_base64 = Buffer.from(await Bun.file(entry.thumbnail_path).arrayBuffer()).toString("base64"); } catch {}
      }
      return json({ entry, thumbnail_base64 });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_gallery_tag",
  "Add a tag to a gallery entry",
  { id: z.string(), tag: z.string() },
  async ({ id, tag }) => {
    try {
      return json({ entry: tagEntry(id, tag) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_gallery_untag",
  "Remove a tag from a gallery entry",
  { id: z.string(), tag: z.string() },
  async ({ id, tag }) => {
    try {
      return json({ entry: untagEntry(id, tag) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_gallery_favorite",
  "Mark or unmark a gallery entry as favorite",
  { id: z.string(), favorited: z.boolean() },
  async ({ id, favorited }) => {
    try {
      return json({ entry: favoriteEntry(id, favorited) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_gallery_delete",
  "Delete a gallery entry",
  { id: z.string() },
  async ({ id }) => {
    try {
      deleteEntry(id);
      return json({ deleted: id });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_gallery_search",
  "Search gallery entries by url, title, notes, or tags",
  { q: z.string(), limit: z.number().optional().default(20) },
  async ({ q, limit }) => {
    try {
      return json({ entries: searchEntries(q, limit) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_gallery_stats",
  "Get gallery statistics: total, size, favorites, by-format breakdown",
  { project_id: z.string().optional() },
  async ({ project_id }) => {
    try {
      return json(getGalleryStats(project_id));
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_gallery_diff",
  "Pixel-diff two gallery screenshots. Returns diff image base64 + changed pixel count.",
  { id1: z.string(), id2: z.string() },
  async ({ id1, id2 }) => {
    try {
      const e1 = getEntry(id1);
      const e2 = getEntry(id2);
      if (!e1) return err(new Error(`Gallery entry not found: ${id1}`));
      if (!e2) return err(new Error(`Gallery entry not found: ${id2}`));
      const result = await diffImages(e1.path, e2.path);
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── Downloads ─────────────────────────────────────────────────────────────────

server.tool(
  "browser_downloads_list",
  "List all files in the downloads folder",
  { session_id: z.string().optional().optional() },
  async ({ session_id }) => {
    try {
      return json({ downloads: listDownloads(session_id), count: listDownloads(session_id).length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_downloads_get",
  "Get a downloaded file by id, returning base64 content and metadata",
  { id: z.string(), session_id: z.string().optional().optional() },
  async ({ id, session_id }) => {
    try {
      const file = getDownload(id, session_id);
      if (!file) return err(new Error(`Download not found: ${id}`));
      const base64 = Buffer.from(await Bun.file(file.path).arrayBuffer()).toString("base64");
      return json({ file, base64 });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_downloads_delete",
  "Delete a downloaded file by id",
  { id: z.string(), session_id: z.string().optional().optional() },
  async ({ id, session_id }) => {
    try {
      const deleted = deleteDownload(id, session_id);
      return json({ deleted });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_downloads_clean",
  "Delete all downloaded files older than N days (default 7)",
  { older_than_days: z.number().optional().default(7) },
  async ({ older_than_days }) => {
    try {
      return json({ deleted_count: cleanStaleDownloads(older_than_days) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_downloads_export",
  "Copy a downloaded file to a target path",
  { id: z.string(), target_path: z.string(), session_id: z.string().optional().optional() },
  async ({ id, target_path, session_id }) => {
    try {
      const finalPath = exportToPath(id, target_path, session_id);
      return json({ path: finalPath });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_persist_file",
  "Persist a file permanently via open-files SDK (or local fallback)",
  { download_id: z.string().optional(), path: z.string().optional(), project_id: z.string().optional(), tags: z.array(z.string()).optional() },
  async ({ download_id, path: filePath, project_id, tags }) => {
    try {
      let localPath = filePath;
      if (download_id) {
        const file = getDownload(download_id);
        if (!file) return err(new Error(`Download not found: ${download_id}`));
        localPath = file.path;
      }
      if (!localPath) return err(new Error("Either download_id or path is required"));
      const result = await persistFile(localPath, { projectId: project_id, tags });
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── Snapshot Diff ────────────────────────────────────────────────────────────

server.tool(
  "browser_snapshot_diff",
  "Take a new accessibility snapshot and diff it against the last snapshot for this session. Shows added/removed/modified interactive elements.",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const before = getLastSnapshot(sid);
      const after = await takeSnapshotFn(page, sid);
      setLastSnapshot(sid, after);

      if (!before) {
        return json({
          message: "No previous snapshot — returning current snapshot only.",
          snapshot: after.tree,
          refs: after.refs,
          interactive_count: after.interactive_count,
        });
      }

      const diff = diffSnapshots(before, after);
      return json({
        diff,
        added_count: diff.added.length,
        removed_count: diff.removed.length,
        modified_count: diff.modified.length,
        url_changed: diff.url_changed,
        title_changed: diff.title_changed,
        current_interactive_count: after.interactive_count,
      });
    } catch (e) { return err(e); }
  }
);

// ── Session Stats ───────────────────────────────────────────────────────────

server.tool(
  "browser_session_stats",
  "Get session info and estimated token usage (based on network log, console log, and gallery entry sizes).",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const session = getSession(sid);
      const networkLog = getNetworkLog(sid);
      const consoleLog = getConsoleLog(sid);
      const galleryEntries = listEntries({ sessionId: sid, limit: 1000 });

      // Estimate token usage from data sizes (rough: 1 token ~ 4 chars)
      let totalChars = 0;
      for (const req of networkLog) {
        totalChars += (req.url?.length ?? 0)
          + (req.request_headers?.length ?? 0)
          + (req.response_headers?.length ?? 0)
          + (req.request_body?.length ?? 0);
      }
      for (const msg of consoleLog) {
        totalChars += (msg.message?.length ?? 0) + (msg.source?.length ?? 0);
      }
      for (const entry of galleryEntries) {
        totalChars += (entry.url?.length ?? 0)
          + (entry.title?.length ?? 0)
          + (entry.notes?.length ?? 0)
          + (entry.tags?.join(",").length ?? 0);
      }

      const estimatedTokens = Math.ceil(totalChars / 4);
      const tokenBudget = getTokenBudget(sid);

      return json({
        session,
        network_request_count: networkLog.length,
        console_message_count: consoleLog.length,
        gallery_entry_count: galleryEntries.length,
        estimated_tokens_used: estimatedTokens,
        token_budget: tokenBudget,
        data_size_chars: totalChars,
      });
    } catch (e) { return err(e); }
  }
);

// ── Tab Tools ─────────────────────────────────────────────────────────────────

server.tool(
  "browser_tab_new",
  "Open a new tab in the session's browser context, optionally navigating to a URL",
  { session_id: z.string().optional(), url: z.string().optional() },
  async ({ session_id, url }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const tab = await newTab(page, url);
      return json(tab);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_tab_list",
  "List all open tabs in the session's browser context",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const tabs = await listTabs(page);
      return json({ tabs, count: tabs.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_tab_switch",
  "Switch to a different tab by index. Updates the session's active page.",
  { session_id: z.string().optional(), tab_id: z.number() },
  async ({ session_id, tab_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const result = await switchTab(page, tab_id);
      setSessionPage(sid, result.page);
      return json(result.tab);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_tab_close",
  "Close a tab by index. Cannot close the last tab.",
  { session_id: z.string().optional(), tab_id: z.number() },
  async ({ session_id, tab_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      // Get context reference before closing (in case the active page is the one being closed)
      const context = page.context();
      const result = await closeTab(page, tab_id);
      const remainingPages = context.pages();
      const newActivePage = remainingPages[result.active_tab.index];
      if (newActivePage) {
        setSessionPage(sid, newActivePage);
      }
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── Dialog Tools ──────────────────────────────────────────────────────────────

server.tool(
  "browser_handle_dialog",
  "Accept or dismiss a pending dialog (alert, confirm, prompt). Handles the oldest pending dialog.",
  { session_id: z.string().optional(), action: z.enum(["accept", "dismiss"]), prompt_text: z.string().optional() },
  async ({ session_id, action, prompt_text }) => {
    try {
      const sid = resolveSessionId(session_id);
      const result = await handleDialog(sid, action, prompt_text);
      if (!result.handled) return err(new Error("No pending dialogs for this session"));
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_get_dialogs",
  "Get all pending dialogs for a session",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const dialogs = getDialogs(sid);
      return json({ dialogs, count: dialogs.length });
    } catch (e) { return err(e); }
  }
);

// ── Profile Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_profile_save",
  "Save cookies + localStorage from the current session as a named profile",
  { session_id: z.string().optional(), name: z.string() },
  async ({ session_id, name }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const info = await saveProfile(page, name);
      return json(info);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_profile_load",
  "Load a saved profile and apply cookies + localStorage to the current session",
  { session_id: z.string().optional().optional(), name: z.string() },
  async ({ session_id, name }) => {
    try {
      const profileData = loadProfile(name);
      if (session_id) {
        const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
        const applied = await applyProfile(page, profileData);
        return json({ ...applied, profile: name });
      }
      return json({ profile: name, cookies: profileData.cookies.length, storage_keys: Object.keys(profileData.localStorage).length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_profile_list",
  "List all saved browser profiles",
  {},
  async () => {
    try {
      return json({ profiles: listProfilesFn() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_profile_delete",
  "Delete a saved browser profile",
  { name: z.string() },
  async ({ name }) => {
    try {
      const deleted = deleteProfile(name);
      if (!deleted) return err(new Error(`Profile not found: ${name}`));
      return json({ deleted: name });
    } catch (e) { return err(e); }
  }
);

// ── Scripts (browser + connector + AI workflows, SQLite-backed) ──────────────

server.tool(
  "browser_script_run",
  "Run a saved script asynchronously. Returns run_id immediately — poll with browser_script_status for step-by-step progress. Scripts combine browser actions + connector calls + AI reasoning. Works with any engine (Bun.WebView, Playwright, CDP).",
  {
    name: z.string().describe("Script name"),
    session_id: z.string().optional(),
    engine: z.enum(["playwright", "cdp", "lightpanda", "bun", "auto"]).optional().default("auto"),
    variables: z.record(z.string()).optional().describe("Override script variables"),
  },
  async ({ name, session_id, engine, variables }) => {
    try {
      const { getScriptByName, migrateJsonScripts, getSteps } = await import("../db/scripts.js");
      const { executeScript } = await import("../lib/script-engine.js");

      // Auto-migrate JSON scripts on first use
      migrateJsonScripts();

      const script = getScriptByName(name);
      if (!script) return err(new Error(`Script '${name}' not found. Use browser_script_list to see available scripts.`));

      let sid: string;
      let page: import("playwright").Page;
      if (session_id) {
        sid = resolveSessionId(session_id);
        page = getSessionPage(sid);
      } else {
        const result = await createSession({ engine: (engine ?? "auto") as BrowserEngine, headless: true });
        sid = result.session.id;
        page = result.page;
      }

      const steps = getSteps(script.id);
      const runId = executeScript(script.id, page, variables ?? {});
      return json({ run_id: runId, session_id: sid, script: name, total_steps: steps.length, message: "Script running. Poll with browser_script_status." });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_script_status",
  "Check progress of a running script. Shows current step, step-by-step log with durations, and final result when complete.",
  { run_id: z.string() },
  async ({ run_id }) => {
    try {
      const { getRun } = await import("../db/scripts.js");
      const run = getRun(run_id);
      if (!run) return err(new Error(`Run '${run_id}' not found`));
      return json({
        status: run.status,
        progress: `${run.current_step}/${run.total_steps}`,
        current_step: run.current_description,
        steps_log: run.steps_log,
        errors: run.errors.length > 0 ? run.errors : undefined,
        duration_ms: run.duration_ms,
        completed: run.completed_at,
      });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_script_list",
  "List all saved scripts",
  {},
  async () => {
    try {
      const { listScripts, migrateJsonScripts } = await import("../db/scripts.js");
      migrateJsonScripts();
      const scripts = listScripts();
      return json({ scripts: scripts.map(s => ({ name: s.name, domain: s.domain, description: s.description, run_count: s.run_count, last_run: s.last_run })), count: scripts.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_script_save",
  "Save a script. Steps are stored in SQLite. Each step has a type (browser/connector/extract/wait/condition/save_state), config, and optional AI config for intelligent fallbacks.",
  {
    name: z.string(),
    domain: z.string().optional().default(""),
    description: z.string().optional().default(""),
    variables: z.record(z.string()).optional().default({}),
    steps: z.array(z.object({
      type: z.enum(["browser", "connector", "extract", "wait", "condition", "save_state"]),
      config: z.record(z.unknown()).default({}),
      description: z.string().optional().default(""),
      ai_enabled: z.boolean().optional().default(false),
      ai_config: z.record(z.unknown()).optional().default({}),
    })),
  },
  async ({ name, domain, description, variables, steps }) => {
    try {
      const { upsertScript, getSteps } = await import("../db/scripts.js");
      const script = upsertScript({ name, domain, description, variables, steps });
      const savedSteps = getSteps(script.id);
      return json({ id: script.id, name: script.name, steps: savedSteps.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_script_delete",
  "Delete a saved script",
  { name: z.string() },
  async ({ name }) => {
    try {
      const { deleteScriptByName } = await import("../db/scripts.js");
      return json({ deleted: deleteScriptByName(name) });
    } catch (e) { return err(e); }
  }
);

// ── Data Extraction Tools ────────────────────────────────────────────────────

server.tool(
  "browser_detect_apis",
  "Scan network traffic for JSON API endpoints. Returns discovered endpoints with methods, status codes, and URLs.",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const { detectAPIs } = await import("../lib/api-detector.js");
      const apis = detectAPIs(sid);
      return json({ apis, count: apis.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_extract_structured",
  "Extract structured data from page: tables, lists, JSON-LD, Open Graph, meta tags, and repeated elements (cards/items).",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { extractStructuredData } = await import("../lib/structured-extract.js");
      const data = await extractStructuredData(page);
      return json({
        tables: data.tables.length,
        lists: data.lists.length,
        json_ld: data.jsonLd.length,
        open_graph: Object.keys(data.openGraph).length,
        meta_tags: Object.keys(data.metaTags).length,
        repeated_elements: data.repeatedElements.length,
        data,
      });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_dataset_save",
  "Save extracted data as a named dataset for later use",
  { name: z.string(), data: z.array(z.record(z.unknown())), source_url: z.string().optional() },
  async ({ name, data, source_url }) => {
    try {
      const { saveDataset } = await import("../lib/datasets.js");
      const dataset = saveDataset({ name, rows: data, sourceUrl: source_url });
      return json({ id: dataset.id, name: dataset.name, row_count: dataset.row_count });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_dataset_list",
  "List all saved datasets",
  {},
  async () => {
    try {
      const { listDatasets } = await import("../lib/datasets.js");
      return json({ datasets: listDatasets() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_dataset_export",
  "Export a dataset as JSON or CSV file",
  { name: z.string(), format: z.enum(["json", "csv"]).optional().default("json") },
  async ({ name, format }) => {
    try {
      const { exportDataset } = await import("../lib/datasets.js");
      return json(exportDataset(name, format));
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_dataset_delete",
  "Delete a saved dataset",
  { name: z.string() },
  async ({ name }) => {
    try {
      const { deleteDataset } = await import("../lib/datasets.js");
      return json({ deleted: deleteDataset(name) });
    } catch (e) { return err(e); }
  }
);

// ── Meta: browser_help ────────────────────────────────────────────────────────

server.tool(
  "browser_help",
  "Show all available browser tools grouped by category with one-line descriptions",
  {},
  async () => {
    try {
      const groups: Record<string, Array<{ tool: string; description: string }>> = {
        Navigation: [
          { tool: "browser_navigate", description: "Navigate to a URL" },
          { tool: "browser_back", description: "Navigate back in history" },
          { tool: "browser_forward", description: "Navigate forward in history" },
          { tool: "browser_reload", description: "Reload the current page" },
          { tool: "browser_wait_for_navigation", description: "Wait for URL change after action" },
          { tool: "browser_wait_for_idle", description: "Wait for network idle (no pending requests)" },
        ],
        Interaction: [
          { tool: "browser_click", description: "Click element by ref or selector" },
          { tool: "browser_click_text", description: "Click element by visible text" },
          { tool: "browser_type", description: "Type text into an element" },
          { tool: "browser_hover", description: "Hover over an element" },
          { tool: "browser_scroll", description: "Scroll the page" },
          { tool: "browser_select", description: "Select a dropdown option" },
          { tool: "browser_toggle", description: "Check/uncheck a checkbox" },
          { tool: "browser_upload", description: "Upload a file to an input" },
          { tool: "browser_press_key", description: "Press a keyboard key" },
          { tool: "browser_wait", description: "Wait for a selector to appear" },
          { tool: "browser_wait_for_text", description: "Wait for text to appear" },
          { tool: "browser_fill_form", description: "Fill multiple form fields at once" },
          { tool: "browser_find_visual", description: "Find element using AI vision (for canvas, images, custom widgets)" },
          { tool: "browser_handle_dialog", description: "Accept or dismiss a dialog" },
        ],
        Extraction: [
          { tool: "browser_get_text", description: "Get text content from page/selector" },
          { tool: "browser_get_html", description: "Get HTML content from page/selector" },
          { tool: "browser_get_links", description: "Get all links on the page" },
          { tool: "browser_get_page_info", description: "Full page summary in one call" },
          { tool: "browser_extract", description: "Extract content in various formats" },
          { tool: "browser_find", description: "Find elements by selector" },
          { tool: "browser_element_exists", description: "Check if a selector exists" },
          { tool: "browser_snapshot", description: "Get accessibility snapshot with refs" },
          { tool: "browser_evaluate", description: "Execute JavaScript in page context" },
        ],
        Capture: [
          { tool: "browser_screenshot", description: "Take a screenshot (PNG/JPEG/WebP, annotate=true for labels)" },
          { tool: "browser_pdf", description: "Generate a PDF of the page" },
          { tool: "browser_scroll_and_screenshot", description: "Scroll then screenshot in one call" },
          { tool: "browser_scroll_to_element", description: "Scroll element into view + screenshot" },
        ],
        Storage: [
          { tool: "browser_cookies_get", description: "Get cookies" },
          { tool: "browser_cookies_set", description: "Set a cookie" },
          { tool: "browser_cookies_clear", description: "Clear cookies" },
          { tool: "browser_storage_get", description: "Get localStorage/sessionStorage" },
          { tool: "browser_storage_set", description: "Set localStorage/sessionStorage" },
          { tool: "browser_profile_save", description: "Save cookies + localStorage as profile" },
          { tool: "browser_profile_load", description: "Load and apply a saved profile" },
          { tool: "browser_profile_list", description: "List saved profiles" },
          { tool: "browser_profile_delete", description: "Delete a saved profile" },
          { tool: "browser_session_save_state", description: "Save auth state (Playwright storageState) for reuse" },
          { tool: "browser_session_list_states", description: "List saved storage states" },
          { tool: "browser_session_delete_state", description: "Delete a saved storage state" },
        ],
        Network: [
          { tool: "browser_network_log", description: "Get captured network requests" },
          { tool: "browser_network_intercept", description: "Add a network interception rule" },
          { tool: "browser_har_start", description: "Start HAR capture" },
          { tool: "browser_har_stop", description: "Stop HAR capture and get data" },
          { tool: "browser_intercept_response", description: "Mock/delay/error API responses for testing" },
          { tool: "browser_intercept_clear", description: "Remove all response intercepts" },
        ],
        Performance: [
          { tool: "browser_performance", description: "Get performance metrics" },
        ],
        Console: [
          { tool: "browser_console_log", description: "Get console messages" },
          { tool: "browser_has_errors", description: "Check for console errors" },
          { tool: "browser_clear_errors", description: "Clear console error log" },
          { tool: "browser_get_dialogs", description: "Get pending dialogs" },
        ],
        Recording: [
          { tool: "browser_record_start", description: "Start recording actions" },
          { tool: "browser_record_step", description: "Add a step to recording" },
          { tool: "browser_record_stop", description: "Stop and save recording" },
          { tool: "browser_record_replay", description: "Replay a recorded sequence" },
          { tool: "browser_recordings_list", description: "List all recordings" },
        ],
        Auth: [
          { tool: "browser_auth_record", description: "Start recording a login flow" },
          { tool: "browser_auth_stop", description: "Stop recording and save auth flow" },
          { tool: "browser_auth_replay", description: "Replay a saved auth flow" },
          { tool: "browser_auth_list", description: "List all saved auth flows" },
          { tool: "browser_auth_delete", description: "Delete a saved auth flow" },
        ],
        Workflows: [
          { tool: "browser_workflow_save", description: "Save a recording as a reusable workflow" },
          { tool: "browser_workflow_list", description: "List all saved workflows" },
          { tool: "browser_workflow_run", description: "Run a workflow with self-healing replay" },
          { tool: "browser_workflow_delete", description: "Delete a saved workflow" },
        ],
        Data: [
          { tool: "browser_extract_structured", description: "Extract tables, lists, JSON-LD, Open Graph, meta tags, repeated elements" },
          { tool: "browser_detect_apis", description: "Scan network traffic for JSON API endpoints" },
          { tool: "browser_dataset_save", description: "Save extracted data as a named dataset" },
          { tool: "browser_dataset_list", description: "List all saved datasets" },
          { tool: "browser_dataset_export", description: "Export dataset as JSON or CSV" },
          { tool: "browser_dataset_delete", description: "Delete a saved dataset" },
        ],
        Crawl: [
          { tool: "browser_crawl", description: "Crawl a URL recursively" },
        ],
        Agent: [
          { tool: "browser_register_agent", description: "Register an agent" },
          { tool: "browser_heartbeat", description: "Send agent heartbeat" },
          { tool: "browser_agent_list", description: "List registered agents" },
        ],
        Project: [
          { tool: "browser_project_create", description: "Create or ensure a project" },
          { tool: "browser_project_list", description: "List all projects" },
        ],
        Gallery: [
          { tool: "browser_gallery_list", description: "List screenshot gallery entries" },
          { tool: "browser_gallery_get", description: "Get a gallery entry by id" },
          { tool: "browser_gallery_tag", description: "Add a tag to gallery entry" },
          { tool: "browser_gallery_untag", description: "Remove a tag from gallery entry" },
          { tool: "browser_gallery_favorite", description: "Mark/unmark as favorite" },
          { tool: "browser_gallery_delete", description: "Delete a gallery entry" },
          { tool: "browser_gallery_search", description: "Search gallery entries" },
          { tool: "browser_gallery_stats", description: "Get gallery statistics" },
          { tool: "browser_gallery_diff", description: "Pixel-diff two screenshots" },
        ],
        Downloads: [
          { tool: "browser_downloads_list", description: "List downloaded files" },
          { tool: "browser_downloads_get", description: "Get a download by id" },
          { tool: "browser_downloads_delete", description: "Delete a download" },
          { tool: "browser_downloads_clean", description: "Clean old downloads" },
          { tool: "browser_downloads_export", description: "Copy download to a path" },
          { tool: "browser_persist_file", description: "Persist file permanently" },
        ],
        Session: [
          { tool: "browser_session_create", description: "Create a new browser session" },
          { tool: "browser_session_list", description: "List all sessions" },
          { tool: "browser_session_close", description: "Close a session" },
          { tool: "browser_session_get_by_name", description: "Get session by name" },
          { tool: "browser_session_rename", description: "Rename a session" },
          { tool: "browser_session_lock", description: "Lock a session for an agent" },
          { tool: "browser_session_unlock", description: "Unlock a session" },
          { tool: "browser_session_transfer", description: "Transfer session to another agent" },
          { tool: "browser_session_tag", description: "Add a tag to a session" },
          { tool: "browser_session_untag", description: "Remove a tag from a session" },
          { tool: "browser_session_stats", description: "Get session stats and token usage" },
          { tool: "browser_session_timeline", description: "Get chronological action log" },
          { tool: "browser_session_fork", description: "Fork a session (same auth state + URL)" },
          { tool: "browser_tab_new", description: "Open a new tab" },
          { tool: "browser_tab_list", description: "List all open tabs" },
          { tool: "browser_tab_switch", description: "Switch to a tab by index" },
          { tool: "browser_tab_close", description: "Close a tab by index" },
        ],
        Meta: [
          { tool: "browser_check", description: "RECOMMENDED: One-call page summary with diagnostics" },
          { tool: "browser_version", description: "Show running binary version and tool count" },
          { tool: "browser_help", description: "Show this help (all tools)" },
          { tool: "browser_detect_env", description: "Detect environment (prod/dev/staging/local)" },
          { tool: "browser_performance_deep", description: "Deep performance: resources, third-party, DOM, memory" },
          { tool: "browser_accessibility_audit", description: "Run axe-core accessibility audit with severity breakdown" },
          { tool: "browser_snapshot_diff", description: "Diff current snapshot vs previous" },
          { tool: "browser_watch_start", description: "Watch page for DOM changes" },
          { tool: "browser_watch_get_changes", description: "Get captured DOM changes" },
          { tool: "browser_watch_stop", description: "Stop DOM watcher" },
          { tool: "browser_parallel", description: "Execute actions across multiple sessions in parallel" },
        ],
      };

      const totalTools = Object.values(groups).reduce((sum, g) => sum + g.length, 0);

      return json({ groups, total_tools: totalTools });
    } catch (e) { return err(e); }
  }
);

// ── browser_version ───────────────────────────────────────────────────────────

server.tool(
  "browser_version",
  "Get the running browser MCP version, tool count, and environment info. Use this to verify which binary is active.",
  {},
  async () => {
    try {
      const { getDataDir } = await import("../db/schema.js");
      const toolCount = Object.keys((server as any)._registeredTools ?? {}).length;
      return json({
        version: _pkg.version,
        mcp_tools_count: toolCount,
        bun_version: Bun.version,
        data_dir: getDataDir(),
        node_env: process.env["NODE_ENV"] ?? "production",
      });
    } catch (e) { return err(e); }
  }
);

// ── browser_scroll_to_element ─────────────────────────────────────────────────

server.tool(
  "browser_scroll_to_element",
  "Scroll an element into view (by ref or selector) then optionally take a screenshot of it. Replaces scroll + wait + screenshot pattern.",
  {
    session_id: z.string().optional(),
    selector: z.string().optional(),
    ref: z.string().optional(),
    screenshot: z.boolean().optional().default(true),
    wait_ms: z.number().optional().default(200),
  },
  async ({ session_id, selector, ref, screenshot: doScreenshot, wait_ms }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      let locator;
      if (ref) {
        const { getRefLocator } = await import("../lib/snapshot.js");
        locator = getRefLocator(page, sid, ref);
      } else if (selector) {
        locator = page.locator(selector).first();
      } else {
        return err(new Error("Either ref or selector is required"));
      }

      await locator.scrollIntoViewIfNeeded();
      await new Promise((r) => setTimeout(r, wait_ms));

      const result: Record<string, unknown> = { scrolled: ref ?? selector };

      if (doScreenshot) {
        try {
          const ss = await takeScreenshot(page, { selector: selector, track: false });
          ss.url = page.url();
          if (ss.base64.length > 50000) {
            (ss as any).base64_truncated = true;
            ss.base64 = ss.thumbnail_base64 ?? "";
          }
          result.screenshot = ss;
        } catch {}
      }

      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── browser_check (renamed from browser_page_check) ───────────────────────────

server.tool(
  "browser_check",
  "RECOMMENDED FIRST CALL: one-shot page summary — url, title, errors, performance, thumbnail, refs. Replaces 4+ separate tool calls.",
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const info = await getPageInfo(page);
      const errors = getConsoleLog(sid, "error");
      info.has_console_errors = errors.length > 0;
      let perf = {};
      try { perf = await getPerformanceMetrics(page); } catch {}
      let thumbnail_base64 = "";
      try {
        const ss = await takeScreenshot(page, { maxWidth: 400, quality: 60, track: false, thumbnail: false });
        thumbnail_base64 = ss.base64.length > 50000 ? "" : ss.base64;
      } catch {}
      let snapshot_refs = "";
      let interactive_count = 0;
      try {
        const snap = await takeSnapshotFn(page, sid);
        setLastSnapshot(sid, snap);
        interactive_count = snap.interactive_count;
        snapshot_refs = Object.entries(snap.refs).slice(0, 30)
          .map(([ref, i]) => `${i.role}:${i.name.slice(0, 50)} [${ref}]`)
          .join(", ");
      } catch {}
      return json({ ...info, error_count: errors.length, performance: perf, thumbnail_base64, snapshot_refs, interactive_count });
    } catch (e) { return err(e); }
  }
);

// ── open-* Integration Tools ──────────────────────────────────────────────────

// browser_secrets_login
server.tool(
  "browser_secrets_login",
  "Login to a service using credentials from open-secrets vault or ~/.secrets. One call replaces 10+ tool calls.",
  { session_id: z.string().optional(), service: z.string(), login_url: z.string().optional(), save_profile: z.boolean().optional().default(true) },
  async ({ session_id, service, login_url, save_profile }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { getCredentials, loginWithCredentials } = await import("../lib/auth.js");
      const creds = await getCredentials(service);
      if (!creds) return err(new Error(`No credentials found for '${service}'. Add them: secrets set ${service}_email yourlogin && secrets set ${service}_password yourpass`));
      const result = await loginWithCredentials(page as any, creds, {
        loginUrl: login_url,
        saveProfile: save_profile ? service : undefined,
      });
      return json(result);
    } catch (e) { return err(e); }
  }
);

// browser_remember
server.tool(
  "browser_remember",
  "Store page facts in open-mementos for future recall. Agents skip re-scraping on repeat visits.",
  { session_id: z.string().optional(), facts: z.record(z.unknown()), tags: z.array(z.string()).optional() },
  async ({ session_id, facts, tags }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { rememberPage } = await import("../lib/page-memory.js");
      const url = page.url();
      await rememberPage(url, facts, tags);
      return json({ remembered: true, url, facts_count: Object.keys(facts).length });
    } catch (e) { return err(e); }
  }
);

// browser_recall
server.tool(
  "browser_recall",
  "Retrieve cached page facts from open-mementos. Returns null if not cached or expired.",
  { url: z.string(), max_age_hours: z.number().optional().default(24) },
  async ({ url, max_age_hours }) => {
    try {
      const { recallPage } = await import("../lib/page-memory.js");
      const memory = await recallPage(url, max_age_hours);
      return json({ found: !!memory, memory });
    } catch (e) { return err(e); }
  }
);

// browser_session_announce
server.tool(
  "browser_session_announce",
  "Announce to other agents via open-conversations what this session is browsing.",
  { session_id: z.string().optional(), message: z.string().optional() },
  async ({ session_id, message }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { announceNavigation } = await import("../lib/coordination.js");
      const url = page.url();
      await announceNavigation(url, sid);
      return json({ announced: true, url, message });
    } catch (e) { return err(e); }
  }
);

// browser_check_navigation
server.tool(
  "browser_check_navigation",
  "Check if another agent is already scraping this URL. Prevents duplicate work across agents.",
  { url: z.string() },
  async ({ url }) => {
    try {
      const { checkDuplicate } = await import("../lib/coordination.js");
      return json(await checkDuplicate(url));
    } catch (e) { return err(e); }
  }
);

// browser_task_queue
server.tool(
  "browser_task_queue",
  "Queue a browser task in open-todos for agents to pick up.",
  { title: z.string(), description: z.string(), url: z.string().optional(), priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium") },
  async ({ title, description, url, priority }) => {
    try {
      const { queueBrowserTask } = await import("../lib/task-queue.js");
      return json(await queueBrowserTask({ title, description, url, priority }));
    } catch (e) { return err(e); }
  }
);

// browser_task_list
server.tool(
  "browser_task_list",
  "List pending browser tasks from open-todos.",
  { status: z.enum(["pending", "in_progress"]).optional() },
  async ({ status }) => {
    try {
      const { getBrowserTasks } = await import("../lib/task-queue.js");
      const tasks = await getBrowserTasks(status);
      return json({ tasks, count: tasks.length });
    } catch (e) { return err(e); }
  }
);

// browser_task_complete
server.tool(
  "browser_task_complete",
  "Mark a browser task as completed with extracted result data.",
  { task_id: z.string(), result: z.record(z.unknown()) },
  async ({ task_id, result }) => {
    try {
      const { completeBrowserTask } = await import("../lib/task-queue.js");
      await completeBrowserTask(task_id, result);
      return json({ completed: task_id });
    } catch (e) { return err(e); }
  }
);

// browser_skill_run
server.tool(
  "browser_skill_run",
  "Run a pre-built browser skill (login, extract-pricing, extract-nav-links, monitor-price, get-metadata). One call replaces 5–15 tool calls.",
  { session_id: z.string().optional(), skill: z.string(), params: z.record(z.unknown()).optional().default({}) },
  async ({ session_id, skill, params }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { runBrowserSkill } = await import("../lib/skills-runner.js");
      return json(await runBrowserSkill(skill, params, page as any));
    } catch (e) { return err(e); }
  }
);

// browser_skill_list
server.tool(
  "browser_skill_list",
  "List available browser skills.",
  {},
  async () => {
    try {
      const { listBuiltInSkills } = await import("../lib/skills-runner.js");
      return json({ skills: listBuiltInSkills() });
    } catch (e) { return err(e); }
  }
);

// browser_batch — execute multiple actions server-side, return final snapshot
server.tool(
  "browser_batch",
  "Execute multiple browser actions in one call. Returns final snapshot. Eliminates 80% of round trips for multi-step flows.",
  {
    session_id: z.string().optional(),
    actions: z.array(z.object({
      tool: z.string(),
      args: z.record(z.unknown()).optional().default({}),
    })),
  },
  async ({ session_id, actions }) => {
    try {
      const results: Array<{ tool: string; success: boolean; result?: unknown; error?: string }> = [];
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const t0 = Date.now();

      for (const action of actions) {
        try {
          const toolName = action.tool.replace(/^browser_/, "");
          const args = { session_id: sid, ...(action.args as Record<string, unknown>) } as any;

          switch (toolName) {
            case "navigate":
              await navigate(page, (action.args as any).url as string);
              results.push({ tool: action.tool, success: true, result: { url: page.url() } });
              break;
            case "click":
              if (args.ref) { const { clickRef } = await import("../lib/actions.js"); await clickRef(page as any, sid, args.ref as string); }
              else if (args.selector) await page.click(args.selector as string);
              results.push({ tool: action.tool, success: true });
              break;
            case "type":
              if (args.ref && args.text) { const { typeRef } = await import("../lib/actions.js"); await typeRef(page as any, sid, args.ref as string, args.text as string); }
              else if (args.selector && args.text) await page.fill(args.selector as string, args.text as string);
              results.push({ tool: action.tool, success: true });
              break;
            case "fill_form":
              if (args.fields) { const { fillForm } = await import("../lib/actions.js"); const r = await fillForm(page as any, args.fields as any); results.push({ tool: action.tool, success: true, result: r }); }
              break;
            case "scroll":
              await scroll(page, ((args.direction as string) ?? "down") as "up" | "down" | "left" | "right", (args.amount as number) ?? 300);
              results.push({ tool: action.tool, success: true });
              break;
            case "wait":
              if (args.selector) await waitForSelector(page, args.selector as string, { timeout: args.timeout as number });
              else await new Promise(r => setTimeout(r, (args.ms as number) ?? 500));
              results.push({ tool: action.tool, success: true });
              break;
            case "evaluate":
              const evalResult = await page.evaluate(args.script as string);
              results.push({ tool: action.tool, success: true, result: evalResult });
              break;
            case "screenshot":
              const ss = await takeScreenshot(page, { maxWidth: 1280, track: false });
              results.push({ tool: action.tool, success: true, result: { path: ss.path, size_bytes: ss.size_bytes } });
              break;
            default:
              results.push({ tool: action.tool, success: false, error: `Unknown batch action: ${toolName}` });
          }
        } catch (e) {
          results.push({ tool: action.tool, success: false, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Get final snapshot
      let final_snapshot: Record<string, unknown> = {};
      try {
        const snap = await takeSnapshotFn(page, sid);
        final_snapshot = {
          refs: Object.fromEntries(Object.entries(snap.refs).slice(0, 20)),
          interactive_count: snap.interactive_count,
        };
      } catch {}

      return json({
        results,
        succeeded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        final_url: page.url(),
        final_snapshot,
        elapsed_ms: Date.now() - t0,
      });
    } catch (e) { return err(e); }
  }
);

// browser_parallel — execute actions across DIFFERENT sessions concurrently
server.tool(
  "browser_parallel",
  "Execute actions across multiple sessions in parallel. Each action targets a different session. Returns results array.",
  {
    actions: z.array(z.object({
      session_id: z.string().describe("Target session ID"),
      tool: z.string().describe("Tool name (e.g. browser_navigate, browser_screenshot, browser_click)"),
      args: z.record(z.unknown()).optional().default({}),
    })),
    timeout: z.number().optional().default(30000).describe("Timeout per action in ms"),
  },
  async ({ actions, timeout }) => {
    try {
      const t0 = Date.now();

      const promises = actions.map(async (action, index) => {
        try {
          const sid = action.session_id;
          const page = getSessionPage(sid);
          const args = action.args as Record<string, unknown>;
          const toolName = action.tool.replace(/^browser_/, "");

          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
          );

          const actionPromise = (async () => {
            switch (toolName) {
              case "navigate": {
                await navigate(page, args.url as string);
                const title = await page.title();
                return { url: page.url(), title };
              }
              case "screenshot": {
                const result = await takeScreenshot(page, {
                  maxWidth: (args.max_width as number) ?? 800,
                  quality: (args.quality as number) ?? 60,
                });
                return { path: result.path, size_bytes: result.size_bytes };
              }
              case "click": {
                if (args.selector) await click(page, args.selector as string);
                return { clicked: args.selector };
              }
              case "type": {
                if (args.selector && args.text) await typeText(page, args.selector as string, args.text as string);
                return { typed: args.text };
              }
              case "get_text": {
                const text = await getText(page);
                return { text: text.slice(0, 1000), length: text.length };
              }
              case "get_links": {
                const links = await getLinks(page);
                return { links, count: links.length };
              }
              case "snapshot": {
                const snap = await takeSnapshotFn(page, sid);
                return { interactive_count: snap.interactive_count, refs_count: Object.keys(snap.refs).length };
              }
              case "evaluate": {
                const result = await page.evaluate(args.expression as string);
                return { result };
              }
              default:
                return { error: `Unknown tool: ${action.tool}` };
            }
          })();

          const result = await Promise.race([actionPromise, timeoutPromise]);
          return { index, session_id: sid, tool: action.tool, success: true, result };
        } catch (e) {
          return { index, session_id: action.session_id, tool: action.tool, success: false, error: e instanceof Error ? e.message : String(e) };
        }
      });

      const results = await Promise.all(promises);
      const duration_ms = Date.now() - t0;
      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      return json({ results, duration_ms, succeeded, failed, total: actions.length });
    } catch (e) { return err(e); }
  }
);

// browser_pool_status
server.tool(
  "browser_pool_status",
  "Get status of the pre-warmed browser session pool.",
  {},
  async () => {
    try {
      return json({ message: "Session pool not yet implemented in this version. Coming in v0.0.6+", ready: 0, total: 0 });
    } catch (e) { return err(e); }
  }
);

// ── v0.0.7: Automation + Cron + AI Task + Assert ─────────────────────────────

server.tool(
  "browser_cron_create",
  "Schedule a browser task to run automatically. Uses Bun.cron. Example: '0 9 * * 1' = Monday 9am.",
  { schedule: z.string(), url: z.string().optional(), skill: z.string().optional(), extract: z.record(z.string()).optional(), name: z.string().optional() },
  async ({ schedule, url, skill, extract, name }) => {
    try {
      const { createCronJob } = await import("../lib/cron-manager.js");
      return json(createCronJob(schedule, { url, skill, extract }, name));
    } catch (e) { return err(e); }
  }
);

server.tool("browser_cron_list", "List scheduled browser cron jobs.", {},
  async () => { try { const { listCronJobs } = await import("../lib/cron-manager.js"); return json({ jobs: listCronJobs() }); } catch (e) { return err(e); } }
);

server.tool("browser_cron_delete", "Delete a cron job.", { id: z.string() },
  async ({ id }) => { try { const { deleteCronJob } = await import("../lib/cron-manager.js"); return json({ deleted: deleteCronJob(id) }); } catch (e) { return err(e); } }
);

server.tool("browser_cron_run_now", "Manually trigger a cron job.", { id: z.string() },
  async ({ id }) => { try { const { runCronJobNow } = await import("../lib/cron-manager.js"); return json(await runCronJobNow(id)); } catch (e) { return err(e); } }
);

server.tool("browser_cron_enable", "Enable/disable a cron job.", { id: z.string(), enabled: z.boolean() },
  async ({ id, enabled }) => { try { const { enableCronJob } = await import("../lib/cron-manager.js"); return json(enableCronJob(id, enabled)); } catch (e) { return err(e); } }
);

server.tool(
  "browser_watch_url",
  "Monitor a URL for content changes on a schedule. Stores change events.",
  { url: z.string(), schedule: z.string().optional().default("*/5 * * * *"), selector: z.string().optional(), name: z.string().optional() },
  async ({ url, schedule, selector, name }) => {
    try {
      const { createWatchJob } = await import("../lib/url-watcher.js");
      return json(createWatchJob(url, schedule, { name, selector }));
    } catch (e) { return err(e); }
  }
);

server.tool("browser_watch_list", "List URL watchers.", {},
  async () => { try { const { listWatchJobs } = await import("../lib/url-watcher.js"); return json({ watches: listWatchJobs() }); } catch (e) { return err(e); } }
);

server.tool("browser_watch_events", "Get change events from a watcher.", { watch_id: z.string(), limit: z.number().optional().default(20) },
  async ({ watch_id, limit }) => { try { const { getWatchEvents } = await import("../lib/url-watcher.js"); return json({ events: getWatchEvents(watch_id, limit) }); } catch (e) { return err(e); } }
);

server.tool("browser_watch_delete", "Delete a URL watcher.", { watch_id: z.string() },
  async ({ watch_id }) => { try { const { deleteWatchJob } = await import("../lib/url-watcher.js"); return json({ deleted: deleteWatchJob(watch_id) }); } catch (e) { return err(e); } }
);

server.tool(
  "browser_task",
  "Execute a natural language browser task autonomously using Claude Haiku. Returns result + steps taken.",
  { session_id: z.string().optional(), task: z.string(), max_steps: z.number().optional().default(10), model: z.string().optional() },
  async ({ session_id, task, max_steps, model }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { executeBrowserTask } = await import("../lib/ai-task.js");
      return json(await executeBrowserTask(page as any, task, { maxSteps: max_steps, model, sessionId: sid }));
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_assert",
  "Assert page conditions in one call. Conditions: 'url contains X', 'text:\"Y\" is visible', 'element:\"#id\" exists', 'count:\"a\" > 10', 'title contains Z'. Chain with AND.",
  { session_id: z.string().optional(), condition: z.string() },
  async ({ session_id, condition }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const checks: Array<{ assertion: string; result: boolean }> = [];
      let passed = true;

      for (const part of condition.split(/\s+AND\s+/i)) {
        const trimmed = part.trim();
        let result = false;
        try {
          if (/^url\s+contains\s+/i.test(trimmed)) {
            result = page.url().includes(trimmed.replace(/^url\s+contains\s+/i, "").replace(/^["']|["']$/g, ""));
          } else if (/^title\s+contains\s+/i.test(trimmed)) {
            const needle = trimmed.replace(/^title\s+contains\s+/i, "").replace(/^["']|["']$/g, "");
            result = (await getTitle(page)).toLowerCase().includes(needle.toLowerCase());
          } else if (/^text:["'](.+)["']/i.test(trimmed)) {
            const text = trimmed.match(/^text:["'](.+)["']/i)?.[1] ?? "";
            result = await page.evaluate(`document.body?.textContent?.includes(${JSON.stringify(text)}) ?? false`) as boolean;
          } else if (/^element:["'](.+)["']/i.test(trimmed)) {
            const sel = trimmed.match(/^element:["'](.+)["']/i)?.[1] ?? "";
            result = await page.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`) as boolean;
          } else if (/^count:["'](.+)["']\s*([><=!]+)\s*(\d+)/i.test(trimmed)) {
            const [, sel, op, n] = trimmed.match(/^count:["'](.+)["']\s*([><=!]+)\s*(\d+)/i)!;
            const count = await page.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`) as number;
            const num = parseInt(n);
            result = op === ">" ? count > num : op === ">=" ? count >= num : op === "<" ? count < num : op === "<=" ? count <= num : count === num;
          } else {
            result = !!(await page.evaluate(trimmed));
          }
        } catch { result = false; }
        checks.push({ assertion: trimmed, result });
        if (!result) passed = false;
      }
      return json({ passed, checks, condition });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_profile_auto_refresh",
  "Schedule automatic cookie refresh to keep a profile session alive.",
  { name: z.string(), refresh_url: z.string(), schedule: z.string().optional().default("0 */6 * * *") },
  async ({ name, refresh_url, schedule }) => {
    try {
      const { createCronJob } = await import("../lib/cron-manager.js");
      const job = createCronJob(schedule, { url: refresh_url }, `profile-refresh:${name}`);
      return json({ scheduled: true, profile: name, schedule, job_id: job.id });
    } catch (e) { return err(e); }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

// Log version to stderr on startup so debugging is instant
const _startupToolCount = Object.keys((server as any)._registeredTools ?? {}).length;
console.error(`@hasna/browser v${_pkg.version} — ${_startupToolCount} tools | data: ${(await import("../db/schema.js")).getDataDir()}`);

const transport = new StdioServerTransport();
await server.connect(transport);
