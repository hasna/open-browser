import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BrowserError } from "../types/index.js";

export interface PlaywrightLaunchOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  executablePath?: string;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export async function launchPlaywright(options?: PlaywrightLaunchOptions): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: options?.headless ?? true,
      executablePath: options?.executablePath,
    });
  } catch (err) {
    throw new BrowserError(
      `Failed to launch Playwright browser: ${err instanceof Error ? err.message : String(err)}`,
      "PLAYWRIGHT_LAUNCH_FAILED",
      true
    );
  }
}

export async function getPage(
  browser: Browser,
  options?: PlaywrightLaunchOptions
): Promise<Page> {
  const context = await browser.newContext({
    viewport: options?.viewport ?? DEFAULT_VIEWPORT,
    userAgent: options?.userAgent,
    locale: options?.locale,
  });
  return context.newPage();
}

export async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // Ignore close errors
  }
}

export async function closePage(page: Page): Promise<void> {
  try {
    await page.context().close();
  } catch {
    // Ignore close errors
  }
}

// ─── Browser Pool ─────────────────────────────────────────────────────────────

interface PoolEntry {
  browser: Browser;
  inUse: boolean;
  createdAt: number;
}

export class BrowserPool {
  private pool: PoolEntry[] = [];
  private readonly maxSize: number;
  private readonly options?: PlaywrightLaunchOptions;

  constructor(maxSize = 3, options?: PlaywrightLaunchOptions) {
    this.maxSize = maxSize;
    this.options = options;
  }

  async acquire(): Promise<Browser> {
    const available = this.pool.find((e) => !e.inUse);
    if (available) {
      available.inUse = true;
      return available.browser;
    }

    if (this.pool.length < this.maxSize) {
      const browser = await launchPlaywright(this.options);
      this.pool.push({ browser, inUse: true, createdAt: Date.now() });
      return browser;
    }

    // Wait for one to become available
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const free = this.pool.find((e) => !e.inUse);
        if (free) {
          clearInterval(interval);
          free.inUse = true;
          resolve(free.browser);
        }
      }, 100);
    });
  }

  release(browser: Browser): void {
    const entry = this.pool.find((e) => e.browser === browser);
    if (entry) entry.inUse = false;
  }

  async destroyAll(): Promise<void> {
    await Promise.all(this.pool.map((e) => e.browser.close().catch(() => {})));
    this.pool = [];
  }

  get size(): number {
    return this.pool.length;
  }

  get available(): number {
    return this.pool.filter((e) => !e.inUse).length;
  }
}
