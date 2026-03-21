#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createSession, closeSession, getSession, listSessions, getSessionPage, getSessionByName, renameSession } from "../lib/session.js";
import { navigate, click, type as typeText, fill, scroll, hover, selectOption, checkBox, uploadFile, goBack, goForward, reload, waitForSelector, pressKey, clickText, fillForm, waitForText, watchPage, getWatchChanges, stopWatch } from "../lib/actions.js";
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
import { persistFile } from "../lib/files-integration.js";
import { listRecordings, getRecording } from "../db/recordings.js";
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
  },
  async ({ engine, use_case, project_id, agent_id, start_url, headless, viewport_width, viewport_height }) => {
    try {
      const { session } = await createSession({
        engine: engine as BrowserEngine,
        useCase: use_case as UseCase | undefined,
        projectId: project_id,
        agentId: agent_id,
        startUrl: start_url,
        headless,
        viewport: { width: viewport_width, height: viewport_height },
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
  "Navigate to a URL in the session",
  { session_id: z.string(), url: z.string(), timeout: z.number().optional().default(30000) },
  async ({ session_id, url, timeout }) => {
    try {
      const page = getSessionPage(session_id);
      await navigate(page, url, timeout);
      return json({ url, title: await getTitle(page), current_url: await getUrl(page) });
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
  "Click an element matching the selector",
  { session_id: z.string(), selector: z.string(), button: z.enum(["left", "right", "middle"]).optional(), timeout: z.number().optional() },
  async ({ session_id, selector, button, timeout }) => {
    try {
      const page = getSessionPage(session_id);
      await click(page, selector, { button, timeout });
      return json({ clicked: selector });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_type",
  "Type text into an element",
  { session_id: z.string(), selector: z.string(), text: z.string(), clear: z.boolean().optional().default(false), delay: z.number().optional() },
  async ({ session_id, selector, text, clear, delay }) => {
    try {
      const page = getSessionPage(session_id);
      await typeText(page, selector, text, { clear, delay });
      return json({ typed: text, selector });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_hover",
  "Hover over an element",
  { session_id: z.string(), selector: z.string() },
  async ({ session_id, selector }) => {
    try {
      const page = getSessionPage(session_id);
      await hover(page, selector);
      return json({ hovered: selector });
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
  "Select a dropdown option",
  { session_id: z.string(), selector: z.string(), value: z.string() },
  async ({ session_id, selector, value }) => {
    try {
      const page = getSessionPage(session_id);
      const selected = await selectOption(page, selector, value);
      return json({ selected });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_check",
  "Check or uncheck a checkbox",
  { session_id: z.string(), selector: z.string(), checked: z.boolean() },
  async ({ session_id, selector, checked }) => {
    try {
      const page = getSessionPage(session_id);
      await checkBox(page, selector, checked);
      return json({ checked, selector });
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
  "Get an accessibility (ARIA) snapshot of the page",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const page = getSessionPage(session_id);
      return json({ snapshot: await getAriaSnapshot(page) });
    } catch (e) { return err(e); }
  }
);

// ── Capture Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_screenshot",
  "Take a screenshot of the page or an element",
  {
    session_id: z.string(),
    selector: z.string().optional(),
    full_page: z.boolean().optional().default(false),
    format: z.enum(["png", "jpeg", "webp"]).optional().default("webp"),
    quality: z.number().optional(),
    max_width: z.number().optional().default(1280),
    compress: z.boolean().optional().default(true),
    thumbnail: z.boolean().optional().default(true),
  },
  async ({ session_id, selector, full_page, format, quality, max_width, compress, thumbnail }) => {
    try {
      const page = getSessionPage(session_id);
      const result = await takeScreenshot(page, { selector, fullPage: full_page, format, quality, maxWidth: max_width, compress, thumbnail });
      // Auto-save to downloads folder
      try {
        const buf = Buffer.from(result.base64, "base64");
        const filename = result.path.split("/").pop() ?? `screenshot.${format ?? "webp"}`;
        const dl = saveToDownloads(buf, filename, { sessionId: session_id, type: "screenshot", sourceUrl: page.url() });
        (result as any).download_id = dl.id;
      } catch { /* non-fatal */ }
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

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
