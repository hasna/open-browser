/**
 * Bun.WebView engine adapter — native zero-dep browser using WKWebView (macOS)
 * or Chrome CDP (Windows/Linux). Available in Bun canary; stable in ~v1.4.0.
 *
 * Usage: import { isBunWebViewAvailable, BunWebViewSession } from './bun-webview.js'
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getDataDir } from "../db/schema.js";

// ─── Availability check ───────────────────────────────────────────────────────

export function isBunWebViewAvailable(): boolean {
  return typeof (globalThis as any).Bun !== "undefined" &&
         typeof (globalThis as any).Bun.WebView !== "undefined";
}

// ─── Profile directory helper ────────────────────────────────────────────────

function getProfileDir(profileName: string): string {
  const base = getDataDir();
  const dir = join(base, "profiles", profileName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── BunWebView type shim (not typed in stable Bun) ──────────────────────────

interface NativeBunWebView {
  navigate(url: string): Promise<void>;
  evaluate(expr: string): Promise<unknown>;
  screenshot(): Promise<Uint8Array>;
  click(selector: string, opts?: { button?: "left" | "right" | "middle" }): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, opts?: { modifiers?: string[] }): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  scrollTo(selector: string, opts?: unknown): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  url: string;
  title: string;
  loading: boolean;
  onNavigated: ((url: string) => void) | null;
  onNavigationFailed: ((error: Error) => void) | null;
  [Symbol.asyncDispose]: () => Promise<void>;
}

// ─── BunWebViewSession — Playwright-compatible wrapper ───────────────────────

export interface BunWebViewOptions {
  width?: number;
  height?: number;
  profile?: string;          // if set: persistent dataStore at ~/.hasna/browser/profiles/{profile}/
  headless?: boolean;        // always headless in current implementation
  userAgent?: string;
  onConsole?: (type: string, ...args: unknown[]) => void;
}

export class BunWebViewSession {
  private view: NativeBunWebView;
  private _sessionId?: string;
  private _eventListeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(opts: BunWebViewOptions = {}) {
    if (!isBunWebViewAvailable()) {
      throw new Error(
        "Bun.WebView is not available. Install Bun canary: bun upgrade --canary"
      );
    }

    const BunWebView = (globalThis as any).Bun.WebView;
    const constructorOpts: Record<string, unknown> = {
      width: opts.width ?? 1280,
      height: opts.height ?? 720,
    };

    if (opts.profile) {
      constructorOpts.dataStore = { directory: getProfileDir(opts.profile) };
    } else {
      constructorOpts.dataStore = "ephemeral";
    }

    if (opts.onConsole) {
      constructorOpts.console = opts.onConsole;
    }

    this.view = new BunWebView(constructorOpts) as NativeBunWebView;

    // Wire navigation events to our listener system
    this.view.onNavigated = (url: string) => {
      this._emit("navigated", url);
    };
    this.view.onNavigationFailed = (error: Error) => {
      this._emit("navigationfailed", error);
    };
  }

  // ─── Core navigation ──────────────────────────────────────────────────────

  async goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void> {
    await this.view.navigate(url);
    // Short settle time for JS to execute after navigation
    await new Promise(r => setTimeout(r, 200));
  }

  async goBack(): Promise<void> { await this.view.goBack(); }
  async goForward(): Promise<void> { await this.view.goForward(); }
  async reload(): Promise<void> { await this.view.reload(); }

  // ─── JS execution ─────────────────────────────────────────────────────────

  async evaluate<T = unknown>(fnOrExpr: string | ((...args: unknown[]) => unknown), ...args: unknown[]): Promise<T> {
    let expr: string;
    if (typeof fnOrExpr === "function") {
      // Serialize function + args like Playwright does
      const serializedArgs = args.map(a => JSON.stringify(a)).join(", ");
      expr = `(${fnOrExpr.toString()})(${serializedArgs})`;
    } else {
      expr = fnOrExpr;
    }
    return this.view.evaluate(expr) as Promise<T>;
  }

  // ─── Screenshot → Buffer for sharp pipeline ───────────────────────────────

  async screenshot(opts?: { path?: string; type?: string; fullPage?: boolean; quality?: number }): Promise<Buffer> {
    const uint8 = await this.view.screenshot();
    return Buffer.from(uint8);
  }

  // ─── Interactions ─────────────────────────────────────────────────────────

  async click(selector: string, opts?: { button?: "left" | "right" | "middle"; timeout?: number }): Promise<void> {
    await this.view.click(selector, opts ? { button: opts.button } : undefined);
  }

  async type(selector: string, text: string, opts?: { delay?: number }): Promise<void> {
    // Focus the element first, then type
    try {
      await this.view.click(selector);
    } catch { /* ignore focus errors */ }
    await this.view.type(text);
  }

  async fill(selector: string, value: string): Promise<void> {
    // Clear and fill via evaluate, then type
    await this.view.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) { el.value = ''; el.dispatchEvent(new Event('input')); }
      })()
    `);
    await this.type(selector, value);
  }

  async press(key: string, opts?: { modifiers?: string[] }): Promise<void> {
    await this.view.press(key, opts);
  }

  async scroll(direction: string, amount: number): Promise<void> {
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    await this.view.scroll(dx, dy);
  }

  async scrollIntoView(selector: string): Promise<void> {
    await this.view.scrollTo(selector);
  }

  async hover(selector: string): Promise<void> {
    // Bun.WebView doesn't have hover yet — scroll into view as fallback
    try { await this.view.scrollTo(selector); } catch {}
  }

  async resize(width: number, height: number): Promise<void> {
    await this.view.resize(width, height);
  }

  // ─── DOM querying (via evaluate) ──────────────────────────────────────────

  async $(selector: string): Promise<{ textContent(): Promise<string | null> } | null> {
    const exists = await this.view.evaluate(
      `!!document.querySelector(${JSON.stringify(selector)})`
    ) as boolean;
    if (!exists) return null;
    return {
      textContent: async () => this.view.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`
      ) as Promise<string | null>,
    };
  }

  async $$(selector: string): Promise<Array<{ textContent(): Promise<string | null> }>> {
    const count = await this.view.evaluate(
      `document.querySelectorAll(${JSON.stringify(selector)}).length`
    ) as number;
    return Array.from({ length: count }, (_, i) => ({
      textContent: async () => this.view.evaluate(
        `document.querySelectorAll(${JSON.stringify(selector)})[${i}]?.textContent ?? null`
      ) as Promise<string | null>,
    }));
  }

  async inputValue(selector: string): Promise<string> {
    return this.view.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.value ?? ''`
    ) as Promise<string>;
  }

  async isChecked(selector: string): Promise<boolean> {
    return this.view.evaluate(
      `!!(document.querySelector(${JSON.stringify(selector)})?.checked)`
    ) as Promise<boolean>;
  }

  async isVisible(selector: string): Promise<boolean> {
    return this.view.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0;
      })()
    `) as Promise<boolean>;
  }

  async isEnabled(selector: string): Promise<boolean> {
    return this.view.evaluate(
      `!(document.querySelector(${JSON.stringify(selector)})?.disabled)`
    ) as Promise<boolean>;
  }

  async selectOption(selector: string, value: string): Promise<string[]> {
    await this.view.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('change'));
        }
      })()
    `);
    return [value];
  }

  async check(selector: string): Promise<void> {
    await this.view.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change')); }
      })()
    `);
  }

  async uncheck(selector: string): Promise<void> {
    await this.view.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el && el.checked) { el.checked = false; el.dispatchEvent(new Event('change')); }
      })()
    `);
  }

  async setInputFiles(selector: string, files: string | string[]): Promise<void> {
    throw new Error("File upload not supported in Bun.WebView engine. Use engine: 'playwright' instead.");
  }

  // ─── Playwright-compatible locator API (minimal) ─────────────────────────

  getByRole(role: string, opts?: { name?: string | RegExp }): any {
    const name = opts?.name?.toString() ?? "";
    const selector = name
      ? `[role="${role}"][aria-label*="${name}"], ${role}[aria-label*="${name}"]`
      : `[role="${role}"], ${role}`;
    return {
      click: (clickOpts?: any) => this.click(selector, clickOpts),
      fill: (value: string) => this.fill(selector, value),
      check: () => this.check(selector),
      uncheck: () => this.uncheck(selector),
      isVisible: () => this.isVisible(selector),
      textContent: () => this.view.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`),
      inputValue: () => this.inputValue(selector),
      first: () => ({
        click: (clickOpts?: any) => this.click(selector, clickOpts),
        fill: (value: string) => this.fill(selector, value),
        textContent: () => this.view.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`),
        isVisible: () => this.isVisible(selector),
        hover: () => this.hover(selector),
        boundingBox: async () => null, // Bun.WebView doesn't expose bounding boxes yet
        scrollIntoViewIfNeeded: () => this.scrollIntoView(selector),
        evaluate: (fn: (el: Element) => unknown) => this.view.evaluate(
          `(${fn.toString()})(document.querySelector(${JSON.stringify(selector)}))`
        ),
        waitFor: (opts?: { state?: string; timeout?: number }) => {
          // Wait for element to be visible
          return new Promise<void>((resolve, reject) => {
            const timeout = opts?.timeout ?? 10000;
            const start = Date.now();
            const check = async () => {
              const visible = await this.isVisible(selector);
              if (visible) return resolve();
              if (Date.now() - start > timeout) return reject(new Error(`Timeout waiting for ${selector}`));
              setTimeout(check, 100);
            };
            check();
          });
        },
      }),
      count: async () => {
        const count = await this.view.evaluate(
          `document.querySelectorAll(${JSON.stringify(selector)}).length`
        ) as number;
        return count;
      },
      nth: (n: number) => ({
        click: (clickOpts?: any) => this.click(selector, clickOpts),
        textContent: () => this.view.evaluate(
          `document.querySelectorAll(${JSON.stringify(selector)})[${n}]?.textContent ?? null`
        ),
        isVisible: () => this.isVisible(selector),
      }),
    };
  }

  getByText(text: string, opts?: { exact?: boolean }): any {
    const selector = opts?.exact
      ? `*:is(button, a, span, div, p, h1, h2, h3, h4, label)`
      : "*";
    return {
      first: () => ({
        click: async (clickOpts?: any) => {
          await this.view.evaluate(`
            (() => {
              const text = ${JSON.stringify(text)};
              const all = document.querySelectorAll('*');
              for (const el of all) {
                if (el.children.length === 0 && el.textContent?.trim() === text) {
                  el.click(); return;
                }
              }
              for (const el of all) {
                if (el.textContent?.includes(text)) { el.click(); return; }
              }
            })()
          `);
        },
        waitFor: (waitOpts?: { state?: string; timeout?: number }) => {
          const timeout = waitOpts?.timeout ?? 10000;
          return new Promise<void>((resolve, reject) => {
            const start = Date.now();
            const check = async () => {
              const found = await this.view.evaluate(
                `document.body?.textContent?.includes(${JSON.stringify(text)})`
              ) as boolean;
              if (found) return resolve();
              if (Date.now() - start > timeout) return reject(new Error(`Timeout: text "${text}" not found`));
              setTimeout(check, 100);
            };
            check();
          });
        },
      }),
    };
  }

  locator(selector: string): any {
    return {
      click: (opts?: any) => this.click(selector, opts),
      fill: (value: string) => this.fill(selector, value),
      scrollIntoViewIfNeeded: () => this.scrollIntoView(selector),
      first: () => this.getByRole("*").first(),
      evaluate: (fn: (el: Element) => unknown) => this.view.evaluate(
        `(${fn.toString()})(document.querySelector(${JSON.stringify(selector)}))`
      ),
      waitFor: (opts?: { state?: string; timeout?: number }) => {
        const timeout = opts?.timeout ?? 10000;
        return new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const check = async () => {
            const exists = await this.view.evaluate(
              `!!document.querySelector(${JSON.stringify(selector)})`
            ) as boolean;
            if (exists) return resolve();
            if (Date.now() - start > timeout) return reject(new Error(`Timeout: ${selector}`));
            setTimeout(check, 100);
          };
          check();
        });
      },
    };
  }

  // ─── Playwright Page API compatibility ────────────────────────────────────

  url(): string { return this.view.url; }
  async title(): Promise<string> { return this.view.title || (await this.evaluate("document.title") as string); }

  viewportSize(): { width: number; height: number } | null {
    return { width: 1280, height: 720 }; // default; updated via resize()
  }

  async waitForLoadState(state?: string, opts?: { timeout?: number }): Promise<void> {
    await new Promise(r => setTimeout(r, 200));
  }

  async waitForURL(pattern: string | RegExp, opts?: { timeout?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const url = this.view.url;
      const matches = pattern instanceof RegExp ? pattern.test(url) : url.includes(pattern);
      if (matches) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for URL to match ${pattern}`);
  }

  async waitForSelector(selector: string, opts?: { state?: string; timeout?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const exists = await this.view.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as boolean;
      if (exists) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for ${selector}`);
  }

  async setContent(html: string): Promise<void> {
    await this.view.navigate(`data:text/html,${encodeURIComponent(html)}`);
    await new Promise(r => setTimeout(r, 100));
  }

  async content(): Promise<string> {
    return this.view.evaluate("document.documentElement.outerHTML") as Promise<string>;
  }

  async addInitScript(script: string | (() => void)): Promise<void> {
    // Bun.WebView doesn't have addInitScript — execute immediately
    const expr = typeof script === "function" ? `(${script.toString()})()` : script;
    await this.view.evaluate(expr);
  }

  keyboard = {
    press: (key: string) => this.view.press(key),
  };

  // Context stub (for network interception — not supported, returns no-op)
  context() {
    return {
      close: async () => { await this.close(); },
      newPage: async () => { throw new Error("Multi-tab not supported in Bun.WebView. Use engine: 'playwright'"); },
      cookies: async () => [],
      addCookies: async (_: unknown) => {},
      clearCookies: async () => {},
      newCDPSession: async () => { throw new Error("CDP session via context not available in Bun.WebView. Use view.cdp() when shipped."); },
      route: async (_pattern: unknown, _handler: unknown) => {
        throw new Error("Network interception not supported in Bun.WebView. Use engine: 'cdp' or 'playwright'.");
      },
      unrouteAll: async () => {},
      pages: () => [],
      addInitScript: async (script: string) => { await this.addInitScript(script); },
    };
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    if (!this._eventListeners.has(event)) this._eventListeners.set(event, []);
    this._eventListeners.get(event)!.push(handler);
    return this;
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    const listeners = this._eventListeners.get(event) ?? [];
    this._eventListeners.set(event, listeners.filter(l => l !== handler));
    return this;
  }

  private _emit(event: string, ...args: unknown[]): void {
    for (const handler of this._eventListeners.get(event) ?? []) {
      try { handler(...args); } catch {}
    }
  }

  // PDF — not supported
  async pdf(_opts?: unknown): Promise<Buffer> {
    throw new Error("PDF generation not supported in Bun.WebView. Use engine: 'playwright'.");
  }

  // Coverage — not supported
  coverage = {
    startJSCoverage: async () => {},
    stopJSCoverage: async () => [],
    startCSSCoverage: async () => {},
    stopCSSCoverage: async () => [],
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  setSessionId(id: string): void { this._sessionId = id; }
  getSessionId(): string | undefined { return this._sessionId; }

  getNativeView(): NativeBunWebView { return this.view; }

  async close(): Promise<void> {
    try { await this.view.close(); } catch {}
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close(); }
}
