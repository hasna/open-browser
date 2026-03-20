#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createSession, closeSession, getSession, listSessions, getSessionPage } from "../lib/session.js";
import { navigate, click, type as typeText, fill, scroll, hover, selectOption, checkBox, uploadFile, goBack, goForward, reload, waitForSelector, pressKey } from "../lib/actions.js";
import { getText, getHTML, getLinks, getTitle, getUrl, extract, extractStructured, extractTable, getAriaSnapshot, findElements } from "../lib/extractor.js";
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
    format: z.enum(["png", "jpeg", "webp"]).optional().default("png"),
    quality: z.number().optional(),
  },
  async ({ session_id, selector, full_page, format, quality }) => {
    try {
      const page = getSessionPage(session_id);
      const result = await takeScreenshot(page, { selector, fullPage: full_page, format, quality });
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
      return json({ har, entry_count: har.log.entries.length });
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

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
