// ─── Session lifecycle + tab tools ───────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  z,
  json,
  err,
  resolveSessionId,
  createSession,
  closeSession,
  getSession,
  listSessions,
  getSessionPage,
  getSessionByName,
  renameSession,
  setSessionPage,
  getTokenBudget,
  getActiveSessionForAgent,
  networkLogCleanup,
  consoleCaptureCleanup,
  harCaptures,
  logEvent,
  getTimeline,
  getNetworkLog,
  getConsoleLog,
  listEntries,
  newTab,
  listTabs,
  switchTab,
  closeTab,
  navigate,
} from "./helpers.js";
import type { BrowserEngine } from "./helpers.js";

export function register(server: McpServer) {

// ── Session Tools ─────────────────────────────────────────────────────────────

server.tool(
  "browser_session_create",
  `Create a new browser session. Returns a session object with an id you must pass to other tools.

ENGINES:
- "auto" (default): picks the best engine for your use case automatically
- "playwright": full browser automation — forms, SPAs, auth flows, multi-tab
- "cdp": Chrome DevTools Protocol — network monitoring, perf profiling, script injection
- "lightpanda": fast headless for static pages
- "bun": native Bun.WebView — fastest for screenshots and scraping
- "tui": terminal UI testing — launches a CLI/TUI app (Ink, Blessed, Bubbletea, etc.) via ttyd and connects Playwright to it. Pass the shell command as start_url (e.g. "htop", "bun run app.tsx"). All browser tools (screenshot, click, type, wait) work on the terminal. Use tui_theme to control dark/light appearance.

TIPS:
- If agent_id is set and already has an active session, returns the existing one (use force_new to override)
- If session_id is omitted on other tools, the single active session is auto-selected
- Use cdp_url to attach to an already-running Chrome instance
- For TUI sessions: start_url is the shell command to run, NOT a URL`,
  {
    engine: z.enum(["playwright", "cdp", "lightpanda", "bun", "tui", "auto"]).optional().default("auto")
      .describe("Browser engine. Use 'tui' for terminal/CLI app testing — pass the command as start_url"),
    use_case: z.string().optional()
      .describe("Hint for auto engine selection: scrape, screenshot, form, auth, network, har, perf, terminal, tui"),
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
    start_url: z.string().optional()
      .describe("URL to navigate to, OR for engine='tui': the shell command to run (e.g. 'htop', 'bun run app.tsx')"),
    headless: z.boolean().optional().default(true),
    viewport_width: z.number().optional().default(1280),
    viewport_height: z.number().optional().default(720),
    stealth: z.boolean().optional().default(false),
    auto_gallery: z.boolean().optional().default(false),
    storage_state: z.string().optional().describe("Name of saved storage state to load (restores cookies/auth from previous session)"),
    force_new: z.boolean().optional().default(false).describe("Force create a new session even if agent already has one"),
    tags: z.array(z.string()).optional(),
    cdp_url: z.string().optional().describe("Connect to existing Chrome via CDP (e.g. http://localhost:9222). Start Chrome with --remote-debugging-port=9222"),
    tui_theme: z.enum(["dark", "light", "system"]).optional().default("system")
      .describe("TUI engine only: terminal color theme. 'system' auto-detects OS dark/light mode. Choose 'light' for light backgrounds or 'dark' for dark backgrounds."),
    tui_font_size: z.number().optional().default(14)
      .describe("TUI engine only: terminal font size in pixels (default: 14). Larger = more readable screenshots, smaller = more content visible."),
  },
  async ({ engine, use_case, project_id, agent_id, start_url, headless, viewport_width, viewport_height, stealth, auto_gallery, storage_state, force_new, tags, cdp_url, tui_theme, tui_font_size }) => {
    try {
      // Auto-reuse: if agent already has an active session, return it
      if (agent_id && !force_new) {
        const existing = getActiveSessionForAgent(agent_id);
        if (existing) return json({ session: existing.session, reused: true });
      }
      const { session } = await createSession({
        engine: engine as BrowserEngine,
        useCase: use_case as import("../types/index.js").UseCase | undefined,
        projectId: project_id,
        agentId: agent_id,
        startUrl: start_url,
        headless,
        viewport: { width: viewport_width, height: viewport_height },
        stealth,
        autoGallery: auto_gallery,
        storageState: storage_state,
        cdpUrl: cdp_url,
        tuiTheme: tui_theme as "dark" | "light" | "system" | undefined,
        tuiFontSize: tui_font_size,
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

} // end register
