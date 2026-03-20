import { execSync, spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserError, EngineNotAvailableError } from "../types/index.js";

const DEFAULT_LIGHTPANDA_PORT = 9222;
const LIGHTPANDA_BINARY = process.env["LIGHTPANDA_BINARY"] ?? "lightpanda";

export function isLightpandaAvailable(): boolean {
  try {
    execSync(`which ${LIGHTPANDA_BINARY}`, { stdio: "ignore" });
    return true;
  } catch {
    // Try common install paths
    const paths = [
      "/usr/local/bin/lightpanda",
      "/usr/bin/lightpanda",
      `${process.env["HOME"]}/.browser/bin/lightpanda`,
    ];
    return paths.some((p) => {
      try {
        execSync(`test -x ${p}`, { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
  }
}

export function getLightpandaBinaryPath(): string {
  if (process.env["LIGHTPANDA_BINARY"]) return process.env["LIGHTPANDA_BINARY"];
  const paths = [
    "lightpanda",
    "/usr/local/bin/lightpanda",
    "/usr/bin/lightpanda",
    `${process.env["HOME"]}/.browser/bin/lightpanda`,
  ];
  for (const p of paths) {
    try {
      execSync(`which ${p}`, { stdio: "ignore" });
      return p;
    } catch {
      try {
        execSync(`test -x ${p}`, { stdio: "ignore" });
        return p;
      } catch {
        continue;
      }
    }
  }
  throw new EngineNotAvailableError("lightpanda", "binary not found. Run: browser install-browser --engine lightpanda");
}

export interface LightpandaProcess {
  process: ChildProcess;
  port: number;
  wsUrl: string;
}

let _lpProcess: LightpandaProcess | null = null;

export async function launchLightpanda(port?: number): Promise<LightpandaProcess> {
  if (_lpProcess) return _lpProcess;

  if (!isLightpandaAvailable()) {
    throw new EngineNotAvailableError(
      "lightpanda",
      "binary not found. Run: browser install-browser --engine lightpanda"
    );
  }

  const usePort = port ?? DEFAULT_LIGHTPANDA_PORT;
  const binary = getLightpandaBinaryPath();

  const proc = spawn(binary, ["--cdp-host", "127.0.0.1", "--cdp-port", String(usePort)], {
    stdio: "ignore",
    detached: false,
  });

  // Wait for it to start
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new BrowserError("Lightpanda startup timeout", "LIGHTPANDA_TIMEOUT")), 5000);
    const check = setInterval(async () => {
      try {
        const resp = await fetch(`http://127.0.0.1:${usePort}/json/version`);
        if (resp.ok) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      } catch {
        // Not ready yet
      }
    }, 100);

    proc.on("error", (err) => {
      clearInterval(check);
      clearTimeout(timeout);
      reject(new BrowserError(`Lightpanda failed to start: ${err.message}`, "LIGHTPANDA_ERROR"));
    });
  });

  _lpProcess = {
    process: proc,
    port: usePort,
    wsUrl: `ws://127.0.0.1:${usePort}`,
  };

  return _lpProcess;
}

export async function connectLightpanda(port?: number): Promise<Browser> {
  const lp = await launchLightpanda(port);
  try {
    // Get the WebSocket debugger URL
    const resp = await fetch(`http://127.0.0.1:${lp.port}/json/version`);
    const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
    const wsUrl = info.webSocketDebuggerUrl ?? `ws://127.0.0.1:${lp.port}`;
    return await chromium.connectOverCDP(wsUrl);
  } catch (err) {
    throw new BrowserError(
      `Failed to connect to Lightpanda: ${err instanceof Error ? err.message : String(err)}`,
      "LIGHTPANDA_CONNECT_FAILED"
    );
  }
}

export function stopLightpanda(): void {
  if (_lpProcess) {
    _lpProcess.process.kill();
    _lpProcess = null;
  }
}

// ─── LightpandaPage — simplified page wrapper for common ops ─────────────────

export class LightpandaPage {
  constructor(private page: Page) {}

  static async create(port?: number): Promise<LightpandaPage> {
    const browser = await connectLightpanda(port);
    const context = await browser.newContext();
    const page = await context.newPage();
    return new LightpandaPage(page);
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async getContent(): Promise<string> {
    return this.page.content();
  }

  async getTitle(): Promise<string> {
    return this.page.title();
  }

  async getLinks(): Promise<string[]> {
    return this.page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) => h.startsWith("http"))
    );
  }

  async getText(selector?: string): Promise<string> {
    if (selector) {
      const el = await this.page.$(selector);
      return el ? (await el.textContent()) ?? "" : "";
    }
    return this.page.evaluate(() => document.body.innerText ?? "");
  }

  get rawPage(): Page {
    return this.page;
  }

  async close(): Promise<void> {
    await this.page.context().close();
  }
}
