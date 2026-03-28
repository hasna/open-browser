import type { BrowserEngine } from "../types/index.js";
import { UseCase } from "../types/index.js";
import { isLightpandaAvailable } from "./lightpanda.js";
import { isBunWebViewAvailable } from "./bun-webview.js";
import { isTuiAvailable } from "./tui.js";

// ─── Engine Decision Table ────────────────────────────────────────────────────
//
// bun        → native zero-dep (WKWebView/Chrome), fastest for basic tasks
// lightpanda → fast static tasks (no/minimal JS needed), fallback when no bun
// cdp        → low-level DevTools tasks (network, perf, coverage, injection)
// playwright → full automation (forms, SPAs, auth, multi-tab, file upload)

const ENGINE_MAP: Record<UseCase, BrowserEngine> = {
  // Tasks where Bun.WebView is ideal (fast, zero-dep, built-in stealth)
  [UseCase.SCRAPE]:          "bun",
  [UseCase.EXTRACT_LINKS]:   "bun",
  [UseCase.STATUS_CHECK]:    "bun",
  [UseCase.SCREENSHOT]:      "bun",
  [UseCase.SPA_NAVIGATE]:    "bun",
  // Tasks requiring full Playwright capabilities
  [UseCase.FORM_FILL]:       "playwright",
  [UseCase.AUTH_FLOW]:       "playwright",
  [UseCase.MULTI_TAB]:       "playwright",
  [UseCase.RECORD_REPLAY]:   "playwright",
  // TUI testing via ttyd + Playwright
  [UseCase.TERMINAL_TEST]:   "tui",
  // CDP for low-level DevTools
  [UseCase.NETWORK_MONITOR]: "cdp",
  [UseCase.HAR_CAPTURE]:     "cdp",
  [UseCase.PERF_PROFILE]:    "cdp",
  [UseCase.SCRIPT_INJECT]:   "cdp",
  [UseCase.COVERAGE]:        "cdp",
};

/**
 * Select the optimal engine for a given use case.
 * Priority: bun (if available) > lightpanda > playwright
 * Explicit engine always wins unless "auto".
 */
export function selectEngine(
  useCase: UseCase,
  explicit?: BrowserEngine
): BrowserEngine {
  if (explicit && explicit !== "auto") return explicit;

  const preferred = ENGINE_MAP[useCase];

  // Bun engine: use when available (canary+), fastest for read-only tasks
  if (preferred === "bun") {
    if (isBunWebViewAvailable()) return "bun";
    // Bun not available — fall back to lightpanda for static, playwright for interactive
    if (useCase === UseCase.SCRAPE || useCase === UseCase.EXTRACT_LINKS || useCase === UseCase.STATUS_CHECK) {
      return isLightpandaAvailable() ? "lightpanda" : "playwright";
    }
    return "playwright";
  }

  // Lightpanda fallback check
  if (preferred === "lightpanda" && !isLightpandaAvailable()) {
    return "playwright";
  }

  return preferred;
}

/**
 * Returns true if the engine is available on this system.
 */
export function isEngineAvailable(engine: BrowserEngine): boolean {
  if (engine === "auto") return true;
  if (engine === "bun") return isBunWebViewAvailable();
  if (engine === "playwright") return true;
  if (engine === "cdp") return true;
  if (engine === "lightpanda") return isLightpandaAvailable();
  if (engine === "tui") return isTuiAvailable();
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
    terminal: UseCase.TERMINAL_TEST,
    tui: UseCase.TERMINAL_TEST,
  };
  return map[label.toLowerCase()] ?? UseCase.SPA_NAVIGATE;
}
