// ─── Navigation + interaction tools ──────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  z,
  json,
  err,
  errWithScreenshot,
  resolveSessionId,
  getSessionPage,
  getSession,
  renameSession,
  isBunSession,
  getSessionBunView,
  isAutoGallery,
  navigate,
  click,
  typeText,
  hover,
  scroll,
  selectOption,
  checkBox,
  uploadFile,
  goBack,
  goForward,
  reload,
  waitForSelector,
  pressKey,
  clickText,
  fillForm,
  waitForText,
  clickRef,
  typeRef,
  hoverRef,
  selectRef,
  checkRef,
  getTitle,
  getUrl,
  getConsoleLog,
  takeScreenshot,
  takeSnapshotFn,
  setLastSnapshot,
  logEvent,
} from "./helpers.js";

export function register(server: McpServer) {

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

// ── Dialog Tools ──────────────────────────────────────────────────────────────

server.tool(
  "browser_handle_dialog",
  "Accept or dismiss a pending dialog (alert, confirm, prompt). Handles the oldest pending dialog.",
  { session_id: z.string().optional(), action: z.enum(["accept", "dismiss"]), prompt_text: z.string().optional() },
  async ({ session_id, action, prompt_text }) => {
    try {
      const sid = resolveSessionId(session_id);
      const { handleDialog } = await import("../lib/dialogs.js");
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
      const { getDialogs } = await import("../lib/dialogs.js");
      const dialogs = getDialogs(sid);
      return json({ dialogs, count: dialogs.length });
    } catch (e) { return err(e); }
  }
);

} // end register
