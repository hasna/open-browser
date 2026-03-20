// ─── Engine Types ────────────────────────────────────────────────────────────

export type BrowserEngine = "playwright" | "cdp" | "lightpanda" | "auto";

export enum UseCase {
  SCRAPE = "scrape",
  EXTRACT_LINKS = "extract_links",
  STATUS_CHECK = "status_check",
  FORM_FILL = "form_fill",
  SPA_NAVIGATE = "spa_navigate",
  SCREENSHOT = "screenshot",
  AUTH_FLOW = "auth_flow",
  MULTI_TAB = "multi_tab",
  NETWORK_MONITOR = "network_monitor",
  HAR_CAPTURE = "har_capture",
  PERF_PROFILE = "perf_profile",
  SCRIPT_INJECT = "script_inject",
  COVERAGE = "coverage",
  RECORD_REPLAY = "record_replay",
}

// ─── Core Entities ───────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  description?: string;
  created_at: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  session_id?: string;
  project_id?: string;
  working_dir?: string;
  last_seen: string;
  created_at: string;
}

export interface Heartbeat {
  id: string;
  agent_id: string;
  session_id?: string;
  timestamp: string;
}

// ─── Session ─────────────────────────────────────────────────────────────────

export type SessionStatus = "active" | "closed" | "error";

export interface Session {
  id: string;
  engine: BrowserEngine;
  project_id?: string;
  agent_id?: string;
  start_url?: string;
  status: SessionStatus;
  created_at: string;
  closed_at?: string;
}

export interface SessionOptions {
  engine?: BrowserEngine;
  useCase?: UseCase;
  projectId?: string;
  agentId?: string;
  startUrl?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

export interface Snapshot {
  id: string;
  session_id: string;
  url: string;
  title?: string;
  html?: string;
  screenshot_path?: string;
  timestamp: string;
}

// ─── Network ─────────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface NetworkRequest {
  id: string;
  session_id: string;
  method: string;
  url: string;
  status_code?: number;
  request_headers?: string;
  response_headers?: string;
  request_body?: string;
  body_size?: number;
  duration_ms?: number;
  resource_type?: string;
  timestamp: string;
}

export interface HAREntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    postData?: { text: string };
  };
  response: {
    status: number;
    statusText: string;
    headers: Array<{ name: string; value: string }>;
    content: { size: number; mimeType: string; text?: string };
  };
  timings: { send: number; wait: number; receive: number };
}

export interface HAR {
  log: {
    version: string;
    creator: { name: string; version: string };
    entries: HAREntry[];
  };
}

export interface InterceptRule {
  pattern: string;
  action: "block" | "modify" | "log";
  response?: { status: number; body: string; headers?: Record<string, string> };
}

// ─── Console ─────────────────────────────────────────────────────────────────

export type ConsoleLevel = "log" | "warn" | "error" | "debug" | "info";

export interface ConsoleMessage {
  id: string;
  session_id: string;
  level: ConsoleLevel;
  message: string;
  source?: string;
  line_number?: number;
  timestamp: string;
}

// ─── Performance ─────────────────────────────────────────────────────────────

export interface PerformanceMetrics {
  fcp?: number;
  lcp?: number;
  cls?: number;
  ttfb?: number;
  dom_interactive?: number;
  dom_complete?: number;
  load_event?: number;
  js_heap_size_used?: number;
  js_heap_size_total?: number;
}

export interface CoverageEntry {
  url: string;
  text: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface CoverageResult {
  js: CoverageEntry[];
  css: CoverageEntry[];
  totalBytes: number;
  usedBytes: number;
  unusedPercent: number;
}

// ─── Recording ───────────────────────────────────────────────────────────────

export type RecordingStepType =
  | "navigate"
  | "click"
  | "type"
  | "scroll"
  | "hover"
  | "select"
  | "check"
  | "upload"
  | "wait"
  | "evaluate";

export interface RecordingStep {
  type: RecordingStepType;
  selector?: string;
  value?: string;
  url?: string;
  x?: number;
  y?: number;
  timestamp: number;
}

export interface Recording {
  id: string;
  name: string;
  project_id?: string;
  start_url?: string;
  steps: RecordingStep[];
  created_at: string;
}

export interface ReplayResult {
  recording_id: string;
  success: boolean;
  steps_executed: number;
  steps_failed: number;
  errors: string[];
  duration_ms: number;
}

// ─── Crawl ───────────────────────────────────────────────────────────────────

export interface CrawledPage {
  url: string;
  title?: string;
  status_code?: number;
  links: string[];
  depth: number;
  error?: string;
}

export interface CrawlResult {
  id: string;
  project_id?: string;
  start_url: string;
  depth: number;
  pages: CrawledPage[];
  total_links: number;
  errors: string[];
  created_at: string;
}

export interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  sameDomain?: boolean;
  filter?: (url: string) => boolean;
  projectId?: string;
  engine?: BrowserEngine;
}

// ─── Extraction ──────────────────────────────────────────────────────────────

export interface ExtractOptions {
  selector?: string;
  format?: "text" | "html" | "links" | "table" | "structured";
  schema?: Record<string, string>;
}

export interface ExtractResult {
  text?: string;
  html?: string;
  links?: string[];
  table?: string[][];
  structured?: Record<string, string | string[]>;
}

// ─── Screenshot ──────────────────────────────────────────────────────────────

export interface ScreenshotOptions {
  selector?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  path?: string;
}

export interface ScreenshotResult {
  path: string;
  base64: string;
  url?: string;
  width: number;
  height: number;
  size_bytes: number;
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

export interface PDFOptions {
  path?: string;
  format?: "A4" | "Letter" | "A3" | "A5";
  landscape?: boolean;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  printBackground?: boolean;
}

export interface PDFResult {
  path: string;
  base64: string;
  size_bytes: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface BrowserConfig {
  default_engine: BrowserEngine;
  headless: boolean;
  viewport: { width: number; height: number };
  data_dir: string;
  screenshots_dir: string;
  pdfs_dir: string;
  har_dir: string;
  lightpanda_binary?: string;
  chrome_executable?: string;
}

// ─── Error Classes ───────────────────────────────────────────────────────────

export class BrowserError extends Error {
  constructor(
    message: string,
    public readonly code: string = "BROWSER_ERROR",
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "BrowserError";
  }
}

export class SessionNotFoundError extends BrowserError {
  constructor(id: string) {
    super(`Session not found: ${id}`, "SESSION_NOT_FOUND", false);
    this.name = "SessionNotFoundError";
  }
}

export class EngineNotAvailableError extends BrowserError {
  constructor(engine: BrowserEngine, reason?: string) {
    super(
      `Engine '${engine}' is not available${reason ? `: ${reason}` : ""}`,
      "ENGINE_NOT_AVAILABLE",
      false
    );
    this.name = "EngineNotAvailableError";
  }
}

export class NavigationError extends BrowserError {
  constructor(url: string, reason?: string) {
    super(
      `Navigation to '${url}' failed${reason ? `: ${reason}` : ""}`,
      "NAVIGATION_ERROR",
      true
    );
    this.name = "NavigationError";
  }
}

export class ElementNotFoundError extends BrowserError {
  constructor(selector: string) {
    super(`Element not found: ${selector}`, "ELEMENT_NOT_FOUND", false);
    this.name = "ElementNotFoundError";
  }
}

export class RecordingNotFoundError extends BrowserError {
  constructor(id: string) {
    super(`Recording not found: ${id}`, "RECORDING_NOT_FOUND", false);
    this.name = "RecordingNotFoundError";
  }
}

export class AgentNotFoundError extends BrowserError {
  constructor(id: string) {
    super(`Agent not found: ${id}`, "AGENT_NOT_FOUND", false);
    this.name = "AgentNotFoundError";
  }
}

export class ProjectNotFoundError extends BrowserError {
  constructor(id: string) {
    super(`Project not found: ${id}`, "PROJECT_NOT_FOUND", false);
    this.name = "ProjectNotFoundError";
  }
}
