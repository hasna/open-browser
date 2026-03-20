import type { BrowserEngine } from "../types/index.js";
import { UseCase } from "../types/index.js";
import { isLightpandaAvailable } from "./lightpanda.js";

// ─── Engine Decision Table ────────────────────────────────────────────────────
//
// lightpanda → fast static tasks (no/minimal JS needed)
// cdp        → low-level DevTools tasks (network, perf, coverage, injection)
// playwright → full automation (forms, SPAs, screenshots, auth, multi-tab)

const ENGINE_MAP: Record<UseCase, BrowserEngine> = {
  [UseCase.SCRAPE]:          "lightpanda",
  [UseCase.EXTRACT_LINKS]:   "lightpanda",
  [UseCase.STATUS_CHECK]:    "lightpanda",
  [UseCase.FORM_FILL]:       "playwright",
  [UseCase.SPA_NAVIGATE]:    "playwright",
  [UseCase.SCREENSHOT]:      "playwright",
  [UseCase.AUTH_FLOW]:       "playwright",
  [UseCase.MULTI_TAB]:       "playwright",
  [UseCase.RECORD_REPLAY]:   "playwright",
  [UseCase.NETWORK_MONITOR]: "cdp",
  [UseCase.HAR_CAPTURE]:     "cdp",
  [UseCase.PERF_PROFILE]:    "cdp",
  [UseCase.SCRIPT_INJECT]:   "cdp",
  [UseCase.COVERAGE]:        "cdp",
};

/**
 * Select the optimal engine for a given use case.
 * If explicit engine is provided, it takes precedence (unless "auto").
 * Falls back to playwright if the preferred engine is not available.
 */
export function selectEngine(
  useCase: UseCase,
  explicit?: BrowserEngine
): BrowserEngine {
  if (explicit && explicit !== "auto") return explicit;

  const preferred = ENGINE_MAP[useCase];

  // Check availability
  if (preferred === "lightpanda" && !isLightpandaAvailable()) {
    // Fall back to playwright for static tasks
    return "playwright";
  }

  return preferred;
}

/**
 * Returns true if the engine is available on this system.
 */
export function isEngineAvailable(engine: BrowserEngine): boolean {
  if (engine === "auto") return true;
  if (engine === "playwright") return true; // always available if installed
  if (engine === "cdp") return true; // available via Playwright CDP session
  if (engine === "lightpanda") return isLightpandaAvailable();
  return false;
}

/**
 * Infer a UseCase from a plain string label (for CLI/MCP convenience).
 */
export function inferUseCase(label: string): UseCase {
  const map: Record<string, UseCase> = {
    scrape: UseCase.SCRAPE,
    extract: UseCase.EXTRACT_LINKS,
    links: UseCase.EXTRACT_LINKS,
    status: UseCase.STATUS_CHECK,
    check: UseCase.STATUS_CHECK,
    form: UseCase.FORM_FILL,
    fill: UseCase.FORM_FILL,
    spa: UseCase.SPA_NAVIGATE,
    navigate: UseCase.SPA_NAVIGATE,
    screenshot: UseCase.SCREENSHOT,
    auth: UseCase.AUTH_FLOW,
    login: UseCase.AUTH_FLOW,
    "multi-tab": UseCase.MULTI_TAB,
    tabs: UseCase.MULTI_TAB,
    network: UseCase.NETWORK_MONITOR,
    har: UseCase.HAR_CAPTURE,
    perf: UseCase.PERF_PROFILE,
    performance: UseCase.PERF_PROFILE,
    inject: UseCase.SCRIPT_INJECT,
    coverage: UseCase.COVERAGE,
    record: UseCase.RECORD_REPLAY,
    replay: UseCase.RECORD_REPLAY,
  };
  return map[label.toLowerCase()] ?? UseCase.SPA_NAVIGATE;
}
