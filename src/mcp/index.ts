#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createSession, closeSession, getSession, listSessions, getSessionPage, getSessionByName, renameSession, setSessionPage, getTokenBudget } from "../lib/session.js";
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

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "@hasna/browser",
  version: "0.0.1",
});

// ── Session Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_session_create",
  "Create a new browser session with the specified engine",
  {
    engine: z.enum(["playwright", "cdp", "lightpanda", "auto"]).optional().default("auto"),
    use_case: z.string().optional(),
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
    start_url: z.string().optional(),
    headless: z.boolean().optional().default(true),
    viewport_width: z.number().optional().default(1280),
    viewport_height: z.number().optional().default(720),
    stealth: z.boolean().optional().default(false),
  },
  async ({ engine, use_case, project_id, agent_id, start_url, headless, viewport_width, viewport_height, stealth }) => {
    try {
      const { session } = await createSession({
        engine: engine as BrowserEngine,
        useCase: use_case as UseCase | undefined,
        projectId: project_id,
        agentId: agent_id,
        startUrl: start_url,
        headless,
        viewport: { width: viewport_width, height: viewport_height },
        stealth,
      });
      return json({ session });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_list",
  "List all browser sessions",
  { status: z.enum(["active", "closed", "error"]).optional(), project_id: z.string().optional() },
  async ({ status, project_id }) => {
    try {
      return json({ sessions: listSessions({ status, projectId: project_id }) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_session_close",
  "Close a browser session",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const session = await closeSession(session_id);
      networkLogCleanup.get(session_id)?.();
      consoleCaptureCleanup.get(session_id)?.();
      networkLogCleanup.delete(session_id);
      consoleCaptureCleanup.delete(session_id);
      harCaptures.delete(session_id);
      return json({ session });
    } catch (e) { return err(e); }
  }
);

// ── Navigation Tools ──────────────────────────────────────────────────────────

server.tool(
  "browser_navigate",
  "Navigate to a URL. Returns title + thumbnail + accessibility snapshot preview with refs.",
  { session_id: z.string(), url: z.string(), timeout: z.number().optional().default(30000), auto_snapshot: z.boolean().optional().default(true), auto_thumbnail: z.boolean().optional().default(true) },
  async ({ session_id, url, timeout, auto_snapshot, auto_thumbnail }) => {
    try {
      const page = getSessionPage(session_id);
      await navigate(page, url, timeout);
      const title = await getTitle(page);
      const current_url = await getUrl(page);

      const result: Record<string, unknown> = { url, title, current_url };

      // Auto-thumbnail
      if (auto_thumbnail) {
        try {
          const ss = await takeScreenshot(page, { maxWidth: 400, quality: 60, track: false, thumbnail: false });
          result.thumbnail_base64 = ss.base64.length > 50000 ? "" : ss.base64;
        } catch {}
      }

      // Auto-snapshot with refs
      if (auto_snapshot) {
        try {
          const snap = await takeSnapshotFn(page, session_id);
          result.snapshot_preview = snap.tree.slice(0, 3000);
          result.interactive_count = snap.interactive_count;
          result.has_errors = getConsoleLog(session_id, "error").length > 0;
        } catch {}
      }

      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_back",
  "Navigate back in browser history",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      await goBack(page);
      return json({ url: page.url() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_forward",
  "Navigate forward in browser history",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      await goForward(page);
      return json({ url: page.url() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_reload",
  "Reload the current page",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      await reload(page);
      return json({ url: page.url() });
    } catch (e) { return err(e); }
  }
);

// ── Interaction Tools ─────────────────────────────────────────────────────────

server.tool(
  "browser_click",
  "Click an element by ref (from snapshot) or CSS selector. Prefer ref for reliability.",
  { session_id: z.string(), selector: z.string().optional(), ref: z.string().optional(), button: z.enum(["left", "right", "middle"]).optional(), timeout: z.number().optional() },
  async ({ session_id, selector, ref, button, timeout }) => {
    try {
      const page = getSessionPage(session_id);
      if (ref) {
        await clickRef(page, session_id, ref, { timeout });
        return json({ clicked: ref, method: "ref" });
      }
      if (!selector) return err(new Error("Either ref or selector is required"));
      await click(page, selector, { button, timeout });
      return json({ clicked: selector, method: "selector" });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_type",
  "Type text into an element by ref or selector. Prefer ref.",
  { session_id: z.string(), selector: z.string().optional(), ref: z.string().optional(), text: z.string(), clear: z.boolean().optional().default(false), delay: z.number().optional() },
  async ({ session_id, selector, ref, text, clear, delay }) => {
    try {
      const page = getSessionPage(session_id);
      if (ref) {
        await typeRef(page, session_id, ref, text, { clear, delay });
        return json({ typed: text, ref, method: "ref" });
      }
      if (!selector) return err(new Error("Either ref or selector is required"));
      await typeText(page, selector, text, { clear, delay });
      return json({ typed: text, selector, method: "selector" });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_hover",
  "Hover over an element by ref or selector",
  { session_id: z.string(), selector: z.string().optional(), ref: z.string().optional() },
  async ({ session_id, selector, ref }) => {
    try {
      const page = getSessionPage(session_id);
      if (ref) { await hoverRef(page, session_id, ref); return json({ hovered: ref, method: "ref" }); }
      if (!selector) return err(new Error("Either ref or selector is required"));
      await hover(page, selector);
      return json({ hovered: selector, method: "selector" });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_scroll",
  "Scroll the page",
  { session_id: z.string(), direction: z.enum(["up", "down", "left", "right"]).optional().default("down"), amount: z.number().optional().default(300) },
  async ({ session_id, direction, amount }) => {
    try {
      const page = getSessionPage(session_id);
      await scroll(page, direction, amount);
      return json({ scrolled: direction, amount });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_select",
  "Select a dropdown option by ref or selector",
  { session_id: z.string(), selector: z.string().optional(), ref: z.string().optional(), value: z.string() },
  async ({ session_id, selector, ref, value }) => {
    try {
      const page = getSessionPage(session_id);
      if (ref) { const selected = await selectRef(page, session_id, ref, value); return json({ selected, method: "ref" }); }
      if (!selector) return err(new Error("Either ref or selector is required"));
      const selected = await selectOption(page, selector, value);
      return json({ selected, method: "selector" });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_check",
  "Check or uncheck a checkbox by ref or selector",
  { session_id: z.string(), selector: z.string().optional(), ref: z.string().optional(), checked: z.boolean() },
  async ({ session_id, selector, ref, checked }) => {
    try {
      const page = getSessionPage(session_id);
      if (ref) { await checkRef(page, session_id, ref, checked); return json({ checked, ref, method: "ref" }); }
      if (!selector) return err(new Error("Either ref or selector is required"));
      await checkBox(page, selector, checked);
      return json({ checked, selector, method: "selector" });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_upload",
  "Upload a file to an input element",
  { session_id: z.string(), selector: z.string(), file_path: z.string() },
  async ({ session_id, selector, file_path }) => {
    try {
      const page = getSessionPage(session_id);
      await uploadFile(page, selector, file_path);
      return json({ uploaded: file_path, selector });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_press_key",
  "Press a keyboard key",
  { session_id: z.string(), key: z.string() },
  async ({ session_id, key }) => {
    try {
      const page = getSessionPage(session_id);
      await pressKey(page, key);
      return json({ pressed: key });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_wait",
  "Wait for a selector to appear",
  { session_id: z.string(), selector: z.string(), state: z.enum(["attached", "detached", "visible", "hidden"]).optional(), timeout: z.number().optional() },
  async ({ session_id, selector, state, timeout }) => {
    try {
      const page = getSessionPage(session_id);
      await waitForSelector(page, selector, { state, timeout });
      return json({ ready: selector });
    } catch (e) { return err(e); }
  }
);

// ── Extraction Tools ──────────────────────────────────────────────────────────

server.tool(
  "browser_get_text",
  "Get text content from the page or a selector",
  { session_id: z.string(), selector: z.string().optional() },
  async ({ session_id, selector }) => {
    try {
      const page = getSessionPage(session_id);
      return json({ text: await getText(page, selector) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_get_html",
  "Get HTML content from the page or a selector",
  { session_id: z.string(), selector: z.string().optional() },
  async ({ session_id, selector }) => {
    try {
      const page = getSessionPage(session_id);
      return json({ html: await getHTML(page, selector) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_get_links",
  "Get all links from the current page",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      const links = await getLinks(page);
      return json({ links, count: links.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_extract",
  "Extract content from the page in a specified format",
  {
    session_id: z.string(),
    format: z.enum(["text", "html", "links", "table", "structured"]).optional().default("text"),
    selector: z.string().optional(),
    schema: z.record(z.string()).optional(),
  },
  async ({ session_id, format, selector, schema }) => {
    try {
      const page = getSessionPage(session_id);
      const result = await extract(page, { format, selector, schema });
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_find",
  "Find elements matching a selector and return their text",
  { session_id: z.string(), selector: z.string() },
  async ({ session_id, selector }) => {
    try {
      const page = getSessionPage(session_id);
      const elements = await findElements(page, selector);
      const texts = await Promise.all(elements.map((el) => el.textContent()));
      return json({ count: elements.length, texts });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_snapshot",
  "Get a structured accessibility snapshot with element refs (@e0, @e1...). Use refs in browser_click, browser_type, etc.",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      const result = await takeSnapshotFn(page, session_id);
      // Cache for snapshot diff
      setLastSnapshot(session_id, result);
      return json({ snapshot: result.tree, refs: result.refs, interactive_count: result.interactive_count });
    } catch (e) { return err(e); }
  }
);

// ── Capture Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_screenshot",
  "Take a screenshot. Use annotate=true to overlay numbered labels on interactive elements for visual+ref workflows.",
  {
    session_id: z.string(),
    selector: z.string().optional(),
    full_page: z.boolean().optional().default(false),
    format: z.enum(["png", "jpeg", "webp"]).optional().default("webp"),
    quality: z.number().optional(),
    max_width: z.number().optional().default(1280),
    compress: z.boolean().optional().default(true),
    thumbnail: z.boolean().optional().default(true),
    annotate: z.boolean().optional().default(false),
  },
  async ({ session_id, selector, full_page, format, quality, max_width, compress, thumbnail, annotate }) => {
    try {
      const page = getSessionPage(session_id);

      // Annotated screenshot path
      if (annotate && !selector && !full_page) {
        const { annotateScreenshot } = await import("../lib/annotate.js");
        const annotated = await annotateScreenshot(page, session_id);
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

      const result = await takeScreenshot(page, { selector, fullPage: full_page, format, quality, maxWidth: max_width, compress, thumbnail });
      // Populate URL
      result.url = page.url();
      // Auto-save to downloads folder
      try {
        const buf = Buffer.from(result.base64, "base64");
        const filename = result.path.split("/").pop() ?? `screenshot.${format ?? "webp"}`;
        const dl = saveToDownloads(buf, filename, { sessionId: session_id, type: "screenshot", sourceUrl: page.url() });
        (result as any).download_id = dl.id;
      } catch { /* non-fatal */ }
      // Smart base64 truncation: if > 50KB chars, return thumbnail only
      if (result.base64.length > 50000) {
        (result as any).base64_truncated = true;
        (result as any).full_image_path = result.path;
        result.base64 = result.thumbnail_base64 ?? "";
      }
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_pdf",
  "Generate a PDF of the current page",
  {
    session_id: z.string(),
    format: z.enum(["A4", "Letter", "A3", "A5"]).optional().default("A4"),
    landscape: z.boolean().optional().default(false),
    print_background: z.boolean().optional().default(true),
  },
  async ({ session_id, format, landscape, print_background }) => {
    try {
      const page = getSessionPage(session_id);
      const result = await generatePDF(page, { format, landscape, printBackground: print_background });
      // Auto-save to downloads
      try {
        const buf = Buffer.from(result.base64, "base64");
        const filename = result.path.split("/").pop() ?? "document.pdf";
        const dl = saveToDownloads(buf, filename, { sessionId: session_id, type: "pdf", sourceUrl: page.url() });
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
  { session_id: z.string(), script: z.string() },
  async ({ session_id, script }) => {
    try {
      const page = getSessionPage(session_id);
      const result = await page.evaluate(script);
      return json({ result });
    } catch (e) { return err(e); }
  }
);

// ── Storage Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_cookies_get",
  "Get cookies from the current session",
  { session_id: z.string(), name: z.string().optional(), domain: z.string().optional() },
  async ({ session_id, name, domain }) => {
    try {
      const page = getSessionPage(session_id);
      return json({ cookies: await getCookies(page, { name, domain }) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_cookies_set",
  "Set a cookie in the current session",
  {
    session_id: z.string(),
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
      const page = getSessionPage(session_id);
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
  { session_id: z.string(), name: z.string().optional(), domain: z.string().optional() },
  async ({ session_id, name, domain }) => {
    try {
      const page = getSessionPage(session_id);
      await clearCookies(page, name || domain ? { name, domain } : undefined);
      return json({ cleared: true });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_storage_get",
  "Get localStorage or sessionStorage values",
  { session_id: z.string(), key: z.string().optional(), storage_type: z.enum(["local", "session"]).optional().default("local") },
  async ({ session_id, key, storage_type }) => {
    try {
      const page = getSessionPage(session_id);
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
  { session_id: z.string(), key: z.string(), value: z.string(), storage_type: z.enum(["local", "session"]).optional().default("local") },
  async ({ session_id, key, value, storage_type }) => {
    try {
      const page = getSessionPage(session_id);
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
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      // Start logging if not already
      if (!networkLogCleanup.has(session_id)) {
        const page = getSessionPage(session_id);
        const cleanup = enableNetworkLogging(page, session_id);
        networkLogCleanup.set(session_id, cleanup);
      }
      const log = getNetworkLog(session_id);
      return json({ requests: log, count: log.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_network_intercept",
  "Add a network interception rule",
  {
    session_id: z.string(),
    pattern: z.string(),
    action: z.enum(["block", "modify", "log"]),
    response_status: z.number().optional(),
    response_body: z.string().optional(),
  },
  async ({ session_id, pattern, action, response_status, response_body }) => {
    try {
      const page = getSessionPage(session_id);
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
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      const capture = startHAR(page);
      harCaptures.set(session_id, capture);
      return json({ started: true });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_har_stop",
  "Stop HAR capture and return the HAR data",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const capture = harCaptures.get(session_id);
      if (!capture) return err(new Error("No active HAR capture for this session"));
      const har = capture.stop();
      harCaptures.delete(session_id);
      // Auto-save HAR to downloads
      let download_id: string | undefined;
      try {
        const harBuf = Buffer.from(JSON.stringify(har, null, 2));
        const dl = saveToDownloads(harBuf, `capture-${Date.now()}.har`, { sessionId: session_id, type: "har" });
        download_id = dl.id;
      } catch { /* non-fatal */ }
      return json({ har, entry_count: har.log.entries.length, download_id });
    } catch (e) { return err(e); }
  }
);

// ── Performance Tools ─────────────────────────────────────────────────────────

server.tool(
  "browser_performance",
  "Get performance metrics for the current page",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      const metrics = await getPerformanceMetrics(page);
      return json({ metrics });
    } catch (e) { return err(e); }
  }
);

// ── Console Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_console_log",
  "Get captured console messages for a session",
  { session_id: z.string(), level: z.enum(["log", "warn", "error", "debug", "info"]).optional() },
  async ({ session_id, level }) => {
    try {
      if (!consoleCaptureCleanup.has(session_id)) {
        const page = getSessionPage(session_id);
        const cleanup = enableConsoleCapture(page, session_id);
        consoleCaptureCleanup.set(session_id, cleanup);
      }
      const messages = getConsoleLog(session_id, level as import("../types/index.js").ConsoleLevel | undefined);
      return json({ messages, count: messages.length });
    } catch (e) { return err(e); }
  }
);

// ── Recording Tools ───────────────────────────────────────────────────────────

server.tool(
  "browser_record_start",
  "Start recording actions in a session",
  { session_id: z.string(), name: z.string(), project_id: z.string().optional() },
  async ({ session_id, name }) => {
    try {
      const page = getSessionPage(session_id);
      const recording = startRecording(session_id, name, page.url());
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
  { session_id: z.string(), recording_id: z.string() },
  async ({ session_id, recording_id }) => {
    try {
      const page = getSessionPage(session_id);
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
    engine: z.enum(["playwright", "cdp", "lightpanda", "auto"]).optional().default("auto"),
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
    session_id: z.string().optional(),
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
  { session_id: z.string(), direction: z.enum(["up", "down", "left", "right"]).optional().default("down"), amount: z.number().optional().default(500), wait_ms: z.number().optional().default(300) },
  async ({ session_id, direction, amount, wait_ms }) => {
    try {
      const page = getSessionPage(session_id);
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
  { session_id: z.string(), timeout: z.number().optional().default(30000), url_pattern: z.string().optional() },
  async ({ session_id, timeout, url_pattern }) => {
    try {
      const page = getSessionPage(session_id);
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
  { session_id: z.string(), name: z.string() },
  async ({ session_id, name }) => {
    try {
      return json({ session: renameSession(session_id, name) });
    } catch (e) { return err(e); }
  }
);

// ── QoL: click by text ────────────────────────────────────────────────────────

server.tool(
  "browser_click_text",
  "Click an element by its visible text content",
  { session_id: z.string(), text: z.string(), exact: z.boolean().optional().default(false), timeout: z.number().optional() },
  async ({ session_id, text, exact, timeout }) => {
    try {
      const page = getSessionPage(session_id);
      await clickText(page, text, { exact, timeout });
      return json({ clicked: text });
    } catch (e) { return err(e); }
  }
);

// ── QoL: fill form ────────────────────────────────────────────────────────────

server.tool(
  "browser_fill_form",
  "Fill multiple form fields in one call. Fields map: { selector: value }. Handles text, checkboxes, selects.",
  {
    session_id: z.string(),
    fields: z.record(z.union([z.string(), z.boolean()])),
    submit_selector: z.string().optional(),
  },
  async ({ session_id, fields, submit_selector }) => {
    try {
      const page = getSessionPage(session_id);
      const result = await fillForm(page, fields, submit_selector);
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── QoL: wait for text ────────────────────────────────────────────────────────

server.tool(
  "browser_wait_for_text",
  "Wait until specific text appears on the page",
  { session_id: z.string(), text: z.string(), timeout: z.number().optional().default(10000), exact: z.boolean().optional().default(false) },
  async ({ session_id, text, timeout, exact }) => {
    try {
      const page = getSessionPage(session_id);
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
  { session_id: z.string(), selector: z.string(), check_visible: z.boolean().optional().default(false) },
  async ({ session_id, selector, check_visible }) => {
    try {
      const page = getSessionPage(session_id);
      return json(await elementExists(page, selector, { visible: check_visible }));
    } catch (e) { return err(e); }
  }
);

// ── QoL: page info ────────────────────────────────────────────────────────────

server.tool(
  "browser_get_page_info",
  "Get a full page summary in one call: url, title, meta tags, link/image/form counts, text length",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      const info = await getPageInfo(page);
      // Enrich with console error status if logging is active
      const errors = getConsoleLog(session_id, "error");
      info.has_console_errors = errors.length > 0;
      return json(info);
    } catch (e) { return err(e); }
  }
);

// ── QoL: has errors ───────────────────────────────────────────────────────────

server.tool(
  "browser_has_errors",
  "Quick check: does the session have any console errors?",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const errors = getConsoleLog(session_id, "error");
      return json({ has_errors: errors.length > 0, error_count: errors.length, errors });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_clear_errors",
  "Clear console error log for a session",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const { clearConsoleLog } = await import("../db/console-log.js");
      clearConsoleLog(session_id);
      return json({ cleared: true });
    } catch (e) { return err(e); }
  }
);

// ── Watch ─────────────────────────────────────────────────────────────────────

const activeWatchHandles = new Map<string, ReturnType<typeof watchPage>>();

server.tool(
  "browser_watch_start",
  "Start watching a page for DOM changes",
  { session_id: z.string(), selector: z.string().optional(), interval_ms: z.number().optional().default(500), max_changes: z.number().optional().default(50) },
  async ({ session_id, selector, interval_ms, max_changes }) => {
    try {
      const page = getSessionPage(session_id);
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

// ── Meta: browser_page_check ──────────────────────────────────────────────────

server.tool(
  "browser_page_check",
  "One-call page summary: page info + console errors + performance metrics + thumbnail + accessibility snapshot preview. Replaces 4-5 separate tool calls.",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);

      // Page info
      const info = await getPageInfo(page);

      // Console errors
      const errors = getConsoleLog(session_id, "error");
      info.has_console_errors = errors.length > 0;

      // Performance
      let perf = {};
      try { perf = await getPerformanceMetrics(page); } catch {}

      // Thumbnail screenshot
      let thumbnail_base64 = "";
      try {
        const ss = await takeScreenshot(page, { maxWidth: 400, quality: 60, track: false, thumbnail: false });
        thumbnail_base64 = ss.base64;
      } catch {}

      // Snapshot preview
      let snapshot_preview = "";
      let interactive_count = 0;
      try {
        const snap = await takeSnapshotFn(page, session_id);
        snapshot_preview = snap.tree.slice(0, 2000);
        interactive_count = snap.interactive_count;
      } catch {}

      return json({
        ...info,
        error_count: errors.length,
        performance: perf,
        thumbnail_base64: thumbnail_base64.length > 50000 ? "" : thumbnail_base64,
        snapshot_preview,
        interactive_count,
      });
    } catch (e) { return err(e); }
  }
);

// ── Gallery ───────────────────────────────────────────────────────────────────

server.tool(
  "browser_gallery_list",
  "List screenshot gallery entries with optional filters",
  {
    project_id: z.string().optional(),
    session_id: z.string().optional(),
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
  { session_id: z.string().optional() },
  async ({ session_id }) => {
    try {
      return json({ downloads: listDownloads(session_id), count: listDownloads(session_id).length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_downloads_get",
  "Get a downloaded file by id, returning base64 content and metadata",
  { id: z.string(), session_id: z.string().optional() },
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
  { id: z.string(), session_id: z.string().optional() },
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
  { id: z.string(), target_path: z.string(), session_id: z.string().optional() },
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
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      const before = getLastSnapshot(session_id);
      const after = await takeSnapshotFn(page, session_id);
      setLastSnapshot(session_id, after);

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
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const session = getSession(session_id);
      const networkLog = getNetworkLog(session_id);
      const consoleLog = getConsoleLog(session_id);
      const galleryEntries = listEntries({ sessionId: session_id, limit: 1000 });

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
      const tokenBudget = getTokenBudget(session_id);

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
  { session_id: z.string(), url: z.string().optional() },
  async ({ session_id, url }) => {
    try {
      const page = getSessionPage(session_id);
      const tab = await newTab(page, url);
      return json(tab);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_tab_list",
  "List all open tabs in the session's browser context",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      const tabs = await listTabs(page);
      return json({ tabs, count: tabs.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_tab_switch",
  "Switch to a different tab by index. Updates the session's active page.",
  { session_id: z.string(), tab_id: z.number() },
  async ({ session_id, tab_id }) => {
    try {
      const page = getSessionPage(session_id);
      const result = await switchTab(page, tab_id);
      setSessionPage(session_id, result.page);
      return json(result.tab);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_tab_close",
  "Close a tab by index. Cannot close the last tab.",
  { session_id: z.string(), tab_id: z.number() },
  async ({ session_id, tab_id }) => {
    try {
      const page = getSessionPage(session_id);
      // Get context reference before closing (in case the active page is the one being closed)
      const context = page.context();
      const result = await closeTab(page, tab_id);
      const remainingPages = context.pages();
      const newActivePage = remainingPages[result.active_tab.index];
      if (newActivePage) {
        setSessionPage(session_id, newActivePage);
      }
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── Dialog Tools ──────────────────────────────────────────────────────────────

server.tool(
  "browser_handle_dialog",
  "Accept or dismiss a pending dialog (alert, confirm, prompt). Handles the oldest pending dialog.",
  { session_id: z.string(), action: z.enum(["accept", "dismiss"]), prompt_text: z.string().optional() },
  async ({ session_id, action, prompt_text }) => {
    try {
      const result = await handleDialog(session_id, action, prompt_text);
      if (!result.handled) return err(new Error("No pending dialogs for this session"));
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_get_dialogs",
  "Get all pending dialogs for a session",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const dialogs = getDialogs(session_id);
      return json({ dialogs, count: dialogs.length });
    } catch (e) { return err(e); }
  }
);

// ── Profile Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_profile_save",
  "Save cookies + localStorage from the current session as a named profile",
  { session_id: z.string(), name: z.string() },
  async ({ session_id, name }) => {
    try {
      const page = getSessionPage(session_id);
      const info = await saveProfile(page, name);
      return json(info);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_profile_load",
  "Load a saved profile and apply cookies + localStorage to the current session",
  { session_id: z.string().optional(), name: z.string() },
  async ({ session_id, name }) => {
    try {
      const profileData = loadProfile(name);
      if (session_id) {
        const page = getSessionPage(session_id);
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
        ],
        Interaction: [
          { tool: "browser_click", description: "Click element by ref or selector" },
          { tool: "browser_click_text", description: "Click element by visible text" },
          { tool: "browser_type", description: "Type text into an element" },
          { tool: "browser_hover", description: "Hover over an element" },
          { tool: "browser_scroll", description: "Scroll the page" },
          { tool: "browser_select", description: "Select a dropdown option" },
          { tool: "browser_check", description: "Check/uncheck a checkbox" },
          { tool: "browser_upload", description: "Upload a file to an input" },
          { tool: "browser_press_key", description: "Press a keyboard key" },
          { tool: "browser_wait", description: "Wait for a selector to appear" },
          { tool: "browser_wait_for_text", description: "Wait for text to appear" },
          { tool: "browser_fill_form", description: "Fill multiple form fields at once" },
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
          { tool: "browser_screenshot", description: "Take a screenshot (PNG/JPEG/WebP)" },
          { tool: "browser_pdf", description: "Generate a PDF of the page" },
          { tool: "browser_scroll_and_screenshot", description: "Scroll then screenshot in one call" },
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
        ],
        Network: [
          { tool: "browser_network_log", description: "Get captured network requests" },
          { tool: "browser_network_intercept", description: "Add a network interception rule" },
          { tool: "browser_har_start", description: "Start HAR capture" },
          { tool: "browser_har_stop", description: "Stop HAR capture and get data" },
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
          { tool: "browser_session_stats", description: "Get session stats and token usage" },
          { tool: "browser_tab_new", description: "Open a new tab" },
          { tool: "browser_tab_list", description: "List all open tabs" },
          { tool: "browser_tab_switch", description: "Switch to a tab by index" },
          { tool: "browser_tab_close", description: "Close a tab by index" },
        ],
        Meta: [
          { tool: "browser_page_check", description: "One-call page summary with diagnostics" },
          { tool: "browser_help", description: "Show this help (all tools)" },
          { tool: "browser_snapshot_diff", description: "Diff current snapshot vs previous" },
          { tool: "browser_watch_start", description: "Watch page for DOM changes" },
          { tool: "browser_watch_get_changes", description: "Get captured DOM changes" },
          { tool: "browser_watch_stop", description: "Stop DOM watcher" },
        ],
      };

      const totalTools = Object.values(groups).reduce((sum, g) => sum + g.length, 0);

      return json({ groups, total_tools: totalTools });
    } catch (e) { return err(e); }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
