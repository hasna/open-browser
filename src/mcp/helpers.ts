// ─── Shared helpers, state, and re-exports for MCP tool modules ──────────────

export { z } from "zod";
export { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Re-export session management
export {
  createSession,
  closeSession,
  getSession,
  listSessions,
  getSessionPage,
  getSessionByName,
  renameSession,
  setSessionPage,
  getTokenBudget,
  getSessionBunView,
  isBunSession,
  getActiveSessionForAgent,
  getDefaultSession,
  countActiveSessions,
  isAutoGallery,
} from "../lib/session.js";

// Re-export actions
export {
  navigate,
  click,
  type as typeText,
  fill,
  scroll,
  hover,
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
  watchPage,
  getWatchChanges,
  stopWatch,
  clickRef,
  typeRef,
  fillRef,
  selectRef,
  checkRef,
  hoverRef,
} from "../lib/actions.js";

// Re-export extractors
export {
  getText,
  getHTML,
  getLinks,
  getTitle,
  getUrl,
  extract,
  extractStructured,
  extractTable,
  getAriaSnapshot,
  findElements,
  elementExists,
  getPageInfo,
} from "../lib/extractor.js";

// Re-export screenshot/pdf
export { takeScreenshot, generatePDF } from "../lib/screenshot.js";

// Re-export network
export { enableNetworkLogging, addInterceptRule, clearInterceptRules, startHAR } from "../lib/network.js";

// Re-export performance
export { getPerformanceMetrics, startCoverage } from "../lib/performance.js";

// Re-export console
export { enableConsoleCapture } from "../lib/console.js";

// Re-export storage
export {
  getCookies,
  setCookie,
  clearCookies,
  getLocalStorage,
  setLocalStorage,
  getSessionStorage,
  setSessionStorage,
} from "../lib/storage.js";

// Re-export recorder
export { startRecording, stopRecording, replayRecording, recordStep } from "../lib/recorder.js";

// Re-export crawler
export { crawl } from "../lib/crawler.js";

// Re-export agents
export { registerAgent, heartbeat, listAgents, getAgent } from "../lib/agents.js";

// Re-export projects DB
export { ensureProject, listProjects, getProjectByName } from "../db/projects.js";

// Re-export DB layer
export { getNetworkLog } from "../db/network-log.js";
export { getConsoleLog } from "../db/console-log.js";
export {
  listEntries,
  getEntry,
  tagEntry,
  untagEntry,
  favoriteEntry,
  deleteEntry,
  searchEntries,
  getGalleryStats,
} from "../db/gallery.js";

// Re-export downloads
export { saveToDownloads, listDownloads, getDownload, deleteDownload, cleanStaleDownloads, exportToPath } from "../lib/downloads.js";

// Re-export gallery diff
export { diffImages } from "../lib/gallery-diff.js";

// Re-export snapshot
export { takeSnapshot as takeSnapshotFn, diffSnapshots, getLastSnapshot, setLastSnapshot } from "../lib/snapshot.js";

// Re-export files integration
export { persistFile } from "../lib/files-integration.js";

// Re-export recordings DB
export { listRecordings, getRecording } from "../db/recordings.js";

// Re-export timeline
export { logEvent, getTimeline } from "../db/timeline.js";

// Re-export tabs
export { newTab, listTabs, switchTab, closeTab } from "../lib/tabs.js";

// Re-export dialogs
export { getDialogs, handleDialog } from "../lib/dialogs.js";

// Re-export profiles
export {
  saveProfile,
  loadProfile,
  applyProfile,
  listProfiles as listProfilesFn,
  deleteProfile,
} from "../lib/profiles.js";

// Re-export types
export { UseCase, BrowserError } from "../types/index.js";
export type { BrowserEngine } from "../types/index.js";

// Local imports for use in this file's helper functions
import { BrowserError as _BrowserError } from "../types/index.js";
import { getSessionPage as _getSessionPage, getDefaultSession as _getDefaultSession, countActiveSessions as _countActiveSessions } from "../lib/session.js";
import { takeScreenshot as _takeScreenshot } from "../lib/screenshot.js";
import { startHAR as _startHAR } from "../lib/network.js";

// ─── Shared state ────────────────────────────────────────────────────────────

export const networkLogCleanup = new Map<string, () => void>();
export const consoleCaptureCleanup = new Map<string, () => void>();
export const harCaptures = new Map<string, ReturnType<typeof _startHAR>>();

// ─── Helper functions ────────────────────────────────────────────────────────

export function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof _BrowserError ? e.code : "ERROR";
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg, code }) }],
    isError: true as const,
  };
}

/** Like err() but attempts to capture a screenshot for context. */
export async function errWithScreenshot(e: unknown, sessionId?: string) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof _BrowserError ? e.code : "ERROR";
  let screenshot_path: string | undefined;
  if (sessionId) {
    try {
      const sid = resolveSessionId(sessionId);
      const page = _getSessionPage(sid);
      const result = await _takeScreenshot(page, { maxWidth: 800, quality: 50, track: false, thumbnail: false });
      screenshot_path = result.path;
    } catch {}
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg, code, error_screenshot: screenshot_path }) }],
    isError: true as const,
  };
}

/** Resolve session_id: use explicit value, or auto-select the single active session. */
export function resolveSessionId(sessionId?: string): string {
  if (sessionId) return sessionId;
  const def = _getDefaultSession();
  if (def) return def.session.id;
  const count = _countActiveSessions();
  if (count === 0) throw new _BrowserError("No active sessions. Create one with browser_session_create first.", "NO_SESSION");
  throw new _BrowserError(`${count} active sessions — specify session_id to choose one.`, "AMBIGUOUS_SESSION");
}
