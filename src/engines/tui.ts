import { execSync, spawn, type ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { BrowserError } from "../types/index.js";
import { launchPlaywright, getPage as getPlaywrightPage } from "./playwright.js";

// ─── TUI Engine ─────────────────────────────────────────────────────────────
// Launches a terminal app via ttyd (terminal-in-browser), then connects
// Playwright to the ttyd web UI. This gives full screenshot, click, and
// keystroke support for any TUI app (Ink, Blessed, Bubbletea, etc.).

const DEFAULT_TTYD_PORT_START = 7780;
let nextPort = DEFAULT_TTYD_PORT_START;

export type TuiTheme = "dark" | "light" | "system";

export interface TuiSession {
  ttydProcess: ChildProcess;
  port: number;
  browser: Browser;
  page: Page;
  theme: TuiTheme;
}

// xterm.js theme presets
const THEMES = {
  dark: {
    background: "#1e1e1e",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: "#264f78",
    black: "#1e1e1e",
    red: "#f44747",
    green: "#6a9955",
    yellow: "#d7ba7d",
    blue: "#569cd6",
    magenta: "#c586c0",
    cyan: "#4ec9b0",
    white: "#d4d4d4",
    brightBlack: "#808080",
    brightRed: "#f44747",
    brightGreen: "#6a9955",
    brightYellow: "#d7ba7d",
    brightBlue: "#569cd6",
    brightMagenta: "#c586c0",
    brightCyan: "#4ec9b0",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#1e1e1e",
    cursor: "#1e1e1e",
    selectionBackground: "#add6ff",
    black: "#1e1e1e",
    red: "#cd3131",
    green: "#008000",
    yellow: "#795e26",
    blue: "#0451a5",
    magenta: "#af00db",
    cyan: "#0598bc",
    white: "#d4d4d4",
    brightBlack: "#808080",
    brightRed: "#cd3131",
    brightGreen: "#008000",
    brightYellow: "#795e26",
    brightBlue: "#0451a5",
    brightMagenta: "#af00db",
    brightCyan: "#0598bc",
    brightWhite: "#ffffff",
  },
};

/**
 * Check if ttyd is installed on this system.
 */
export function isTuiAvailable(): boolean {
  try {
    execSync("which ttyd", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an available port starting from the given port.
 */
async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  for (let i = 0; i < 100; i++) {
    try {
      const resp = await fetch(`http://localhost:${port}`);
      // Port is in use, try next
      port++;
    } catch {
      // Connection refused = port is free
      return port;
    }
  }
  throw new BrowserError("No available port found for ttyd", "TUI_PORT_EXHAUSTED");
}

/**
 * Wait for ttyd to be ready by polling the HTTP endpoint.
 */
async function waitForTtyd(port: number, timeoutMs: number = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://localhost:${port}`);
      if (resp.ok || resp.status === 200) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new BrowserError(`ttyd did not start within ${timeoutMs}ms`, "TUI_TIMEOUT");
}

/**
 * Launch a terminal app via ttyd and connect Playwright to it.
 *
 * @param command - The shell command to run (e.g. "htop", "npm start", "python app.py")
 * @param options - Viewport and headless options
 * @returns TuiSession with Playwright page connected to the ttyd web UI
 */
export async function launchTui(
  command: string,
  options: {
    headless?: boolean;
    viewport?: { width: number; height: number };
    theme?: TuiTheme;
    fontSize?: number;
  } = {}
): Promise<TuiSession> {
  if (!isTuiAvailable()) {
    throw new BrowserError(
      "ttyd not found — install with: brew install ttyd",
      "TUI_NOT_AVAILABLE"
    );
  }

  const port = await findAvailablePort(nextPort);
  nextPort = port + 1;

  // Launch ttyd with the command
  // --writable allows sending keystrokes
  // --port sets the port
  const ttydProcess = spawn(
    "ttyd",
    ["--writable", "--port", String(port), "/bin/sh", "-c", command],
    {
      stdio: "ignore",
      detached: false,
    }
  );

  // Handle ttyd process errors
  ttydProcess.on("error", (err) => {
    console.error(`[tui] ttyd process error: ${err.message}`);
  });

  try {
    // Wait for ttyd to be ready
    await waitForTtyd(port);

    // Launch Playwright and navigate to ttyd
    const viewport = options.viewport ?? { width: 1280, height: 720 };
    const browser = await launchPlaywright({
      headless: options.headless ?? true,
      viewport,
    });
    const page = await getPlaywrightPage(browser, { viewport });

    await page.goto(`http://localhost:${port}`, {
      waitUntil: "domcontentloaded",
    });

    // Wait for the terminal to render (xterm.js initialization)
    await page.waitForSelector(".xterm-screen", { timeout: 10_000 });

    // Apply theme — resolve "system" by checking macOS appearance (not the browser, which defaults to dark in headless)
    let resolvedTheme: "dark" | "light" = "dark";
    const requestedTheme = options.theme ?? "system";
    if (requestedTheme === "light") {
      resolvedTheme = "light";
    } else if (requestedTheme === "dark") {
      resolvedTheme = "dark";
    } else {
      // "system" — detect actual OS preference
      try {
        const result = execSync("defaults read -g AppleInterfaceStyle 2>/dev/null", { encoding: "utf8" }).trim();
        resolvedTheme = result === "Dark" ? "dark" : "light";
      } catch {
        // Command fails when system is in light mode (key doesn't exist)
        resolvedTheme = "light";
      }
    }

    // Apply xterm.js theme via the terminal API
    const themeColors = THEMES[resolvedTheme];
    await page.evaluate((theme) => {
      const term = (window as any).term ?? (window as any).terminal;
      if (term?.options) {
        term.options.theme = theme;
      }
      // Also set the page background to match
      document.body.style.backgroundColor = theme.background;
      const container = document.getElementById("terminal-container");
      if (container) container.style.backgroundColor = theme.background;
      // Update xterm viewport background
      const viewport = document.querySelector(".xterm-viewport") as HTMLElement;
      if (viewport) viewport.style.backgroundColor = theme.background;
    }, themeColors);

    // Apply font size if specified
    if (options.fontSize) {
      await page.evaluate((size: number) => {
        const term = (window as any).term ?? (window as any).terminal;
        if (term?.options) term.options.fontSize = size;
      }, options.fontSize);
    }

    return { ttydProcess, port, browser, page, theme: resolvedTheme };
  } catch (err) {
    // Cleanup on failure
    ttydProcess.kill();
    throw err;
  }
}

/**
 * Send keystrokes to the TUI app via the Playwright page.
 * Types into the terminal's xterm.js input.
 */
export async function sendKeys(page: Page, keys: string): Promise<void> {
  // Focus the terminal area and type
  const terminal = await page.$(".xterm-helper-textarea");
  if (terminal) {
    await terminal.type(keys);
  } else {
    // Fallback: type on the page directly
    await page.keyboard.type(keys);
  }
}

/**
 * Send a special key (Enter, Escape, ArrowUp, etc.) to the TUI.
 */
export async function sendSpecialKey(page: Page, key: string): Promise<void> {
  const terminal = await page.$(".xterm-helper-textarea");
  if (terminal) {
    await terminal.press(key);
  } else {
    await page.keyboard.press(key);
  }
}

/**
 * Get the visible text content from the terminal.
 * Works with both canvas-based and DOM-based xterm.js renderers.
 */
export async function getTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // ttyd exposes the xterm Terminal instance on the global scope
    const term = (window as any).term ?? (window as any).terminal;
    if (term?.buffer?.active) {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join("\n").trimEnd();
    }
    // Fallback: try DOM-based rows
    const rows = document.querySelectorAll(".xterm-rows > div");
    if (rows.length > 0) {
      return Array.from(rows)
        .map((row) => row.textContent ?? "")
        .join("\n")
        .trimEnd();
    }
    return "";
  });
}

/**
 * Wait for specific text to appear in the terminal output.
 */
export async function waitForTerminalText(
  page: Page,
  text: string,
  timeoutMs: number = 30_000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await getTerminalText(page);
    if (content.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Close TUI session — kill ttyd and close Playwright.
 */
export async function closeTui(session: TuiSession): Promise<void> {
  try {
    await session.page.close();
  } catch {}
  try {
    await session.browser.close();
  } catch {}
  try {
    session.ttydProcess.kill("SIGTERM");
  } catch {}
}
