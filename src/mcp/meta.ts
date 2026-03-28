// ─── Agent, project, gallery, downloads, integration, and meta tools ─────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  z,
  json,
  err,
  resolveSessionId,
  getSessionPage,
  navigate,
  click,
  typeText,
  scroll,
  waitForSelector,
  getText,
  getLinks,
  takeScreenshot,
  takeSnapshotFn,
  registerAgent,
  heartbeat,
  listAgents,
  ensureProject,
  listProjects,
  listEntries,
  getEntry,
  tagEntry,
  untagEntry,
  favoriteEntry,
  deleteEntry,
  searchEntries,
  getGalleryStats,
  diffImages,
  saveToDownloads,
  listDownloads,
  getDownload,
  deleteDownload,
  cleanStaleDownloads,
  exportToPath,
  persistFile,
  logEvent,
  watchPage,
  getWatchChanges,
  stopWatch,
  fillForm,
  getConsoleLog,
  getPerformanceMetrics,
} from "./helpers.js";

export function register(server: McpServer) {

// ── Agent Tools ───────────────────────────────────────────────────────────────

server.tool(
  "register_agent",
  "Register an agent session. Returns agent_id. Auto-triggers a heartbeat.",
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
  "heartbeat",
  "Update last_seen_at to signal agent is active.",
  { agent_id: z.string() },
  async ({ agent_id }) => {
    try {
      heartbeat(agent_id);
      return json({ ok: true, agent_id, timestamp: new Date().toISOString() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "list_agents",
  "List all registered agents.",
  { project_id: z.string().optional() },
  async ({ project_id }) => {
    try {
      return json({ agents: listAgents(project_id) });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "set_focus",
  "Set active project context for this agent session.",
  { agent_id: z.string(), project_id: z.string().optional() },
  async ({ agent_id, project_id }) => {
    try {
      const { updateAgent: update } = await import("../lib/agents.js");
      update(agent_id, { project_id: project_id ?? undefined });
      return json({ ok: true, agent_id, project_id });
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
          { tool: "browser_diff", description: "Visual diff between two URLs — highlights changes in red" },
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
          { tool: "browser_performance_budget", description: "Check perf against budget thresholds (LCP, FCP, CLS, TTFB)" },
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
          { tool: "browser_record_export", description: "Export recording as Playwright test, Puppeteer script, or JSON" },
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
          { tool: "register_agent", description: "Register an agent session" },
          { tool: "heartbeat", description: "Update agent last_seen_at" },
          { tool: "list_agents", description: "List registered agents" },
          { tool: "set_focus", description: "Set active project context" },
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
        TUI: [
          { tool: "browser_tui_send_keys", description: "Send keystrokes (ctrl+c, arrow_up, tab, enter, etc.)" },
          { tool: "browser_tui_send_text", description: "Type text + optional Enter (most common TUI interaction)" },
          { tool: "browser_tui_resize", description: "Resize terminal cols/rows mid-session" },
          { tool: "browser_tui_get_text", description: "Get terminal text buffer (full or row range)" },
          { tool: "browser_tui_wait_for_text", description: "Wait for text to appear in terminal output" },
          { tool: "browser_tui_get_cursor", description: "Get cursor position (row, col)" },
          { tool: "browser_tui_assert", description: "Assert terminal conditions (text contains, row N contains, cursor at)" },
          { tool: "browser_tui_snapshot", description: "Structured terminal snapshot (rows array, cursor, dimensions)" },
          { tool: "browser_tui_record_start", description: "Start recording terminal as asciicast" },
          { tool: "browser_tui_record_stop", description: "Stop recording, return asciicast v2 JSON" },
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
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const _pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string };
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

// ── v0.0.7: Automation + Cron + AI Task ──────────────────────────────────────

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

} // end register
