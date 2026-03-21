import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright";
import { resetDatabase } from "../db/schema.js";
import { getNetworkLog } from "../db/network-log.js";
import { getConsoleLog } from "../db/console-log.js";
import { takeSnapshot, diffSnapshots, getLastSnapshot } from "./snapshot.js";
import { applyStealthPatches } from "./stealth.js";
import { saveProfile, loadProfile, listProfiles, deleteProfile, applyProfile } from "./profiles.js";
import { newTab, listTabs, switchTab, closeTab } from "./tabs.js";
import { setupDialogHandler, getDialogs, handleDialog } from "./dialogs.js";

let browser: Browser;
let testServer: ReturnType<typeof Bun.serve>;
let TEST_URL: string;
let tmpDir: string;

beforeAll(async () => {
  testServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/page2") {
        return new Response('<html><body><h1>Page 2</h1><button>New Button</button></body></html>', { headers: { "Content-Type": "text/html" } });
      }
      if (url.pathname === "/alert") {
        return new Response('<html><body><script>alert("Hello!")</script></body></html>', { headers: { "Content-Type": "text/html" } });
      }
      return new Response('<html><body><h1>Test</h1><a href="/page2">Page 2</a><button>Submit</button><script>console.log("loaded"); console.error("test-error")</script></body></html>', { headers: { "Content-Type": "text/html" } });
    }
  });
  TEST_URL = `http://localhost:${testServer.port}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  testServer.stop();
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "browser-v3-test-"));
  process.env["BROWSER_DB_PATH"] = join(tmpDir, "test.db");
  process.env["BROWSER_DATA_DIR"] = tmpDir;
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env["BROWSER_DB_PATH"];
  delete process.env["BROWSER_DATA_DIR"];
});

describe("auto-logging on session", () => {
  it("captures network requests from initial navigation", async () => {
    const { createSession, closeSession } = await import("./session.js");
    const { session } = await createSession({ startUrl: TEST_URL, headless: true });
    // Wait for listeners to fire
    await new Promise(r => setTimeout(r, 200));
    const log = getNetworkLog(session.id);
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].url).toContain(`localhost:${testServer.port}`);
    await closeSession(session.id);
  });

  it("captures console messages from initial page", async () => {
    const { createSession, closeSession } = await import("./session.js");
    const { session } = await createSession({ startUrl: TEST_URL, headless: true });
    await new Promise(r => setTimeout(r, 200));
    const messages = getConsoleLog(session.id);
    expect(messages.length).toBeGreaterThan(0);
    await closeSession(session.id);
  });

  it("auto-names session from URL hostname", async () => {
    const { createSession, closeSession } = await import("./session.js");
    const { session } = await createSession({ startUrl: TEST_URL, headless: true });
    expect(session.name).toBe(`localhost`);
    await closeSession(session.id);
  });
});

describe("stealth mode", () => {
  it("navigator.webdriver is falsy after patches", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await applyStealthPatches(page);
    await page.goto(TEST_URL);
    const wd = await page.evaluate(() => (navigator as any).webdriver);
    // headless Chrome may set false instead of undefined — both are "undetected"
    expect(!wd).toBe(true);
    await ctx.close();
  });

  it("navigator.languages is set", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await applyStealthPatches(page);
    await page.goto(TEST_URL);
    const langs = await page.evaluate(() => navigator.languages);
    expect(langs).toContain("en-US");
    await ctx.close();
  });
});

describe("snapshot diff", () => {
  it("detects added elements after navigation", async () => {
    const page = await browser.newPage();
    await page.goto(TEST_URL);
    const before = await takeSnapshot(page, "diff-test");

    await page.goto(`${TEST_URL}/page2`);
    const after = await takeSnapshot(page, "diff-test");

    const diff = diffSnapshots(before, after);
    // Page 2 has "New Button" which wasn't on page 1
    expect(diff.added.length + diff.removed.length + diff.modified.length).toBeGreaterThan(0);
    await page.close();
  });
});

describe("tabs", () => {
  it("newTab creates a new tab and listTabs shows it", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(TEST_URL);
    const tab = await newTab(page, `${TEST_URL}/page2`);
    expect(tab.url).toContain("/page2");

    const tabs = await listTabs(page);
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    await ctx.close();
  });

  it("switchTab changes active page", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(TEST_URL);
    await newTab(page, `${TEST_URL}/page2`);

    const result = await switchTab(page, 0);
    expect(result.page.url()).toContain(`localhost:${testServer.port}`);
    await ctx.close();
  });

  it("closeTab removes a tab", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(TEST_URL);
    await newTab(page, `${TEST_URL}/page2`);
    const before = (await listTabs(page)).length;
    await closeTab(page, 1);
    await new Promise(r => setTimeout(r, 100));
    const after = (await listTabs(page)).length;
    expect(after).toBe(before - 1);
    await ctx.close();
  });
});

describe("profiles", () => {
  it("saveProfile writes files and loadProfile reads them", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(TEST_URL);

    const saved = await saveProfile(page, "test-profile");
    expect(saved.name).toBe("test-profile");

    const loaded = loadProfile("test-profile");
    expect(loaded).toBeTruthy();
    expect(Array.isArray(loaded.cookies)).toBe(true);
    expect(typeof loaded.localStorage).toBe("object");
    await ctx.close();
  });

  it("listProfiles returns saved profiles", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(TEST_URL);
    await saveProfile(page, "prof-a");
    await saveProfile(page, "prof-b");
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(2);
    expect(profiles.some(p => p.name === "prof-a")).toBe(true);
    await ctx.close();
  });

  it("deleteProfile removes the profile", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(TEST_URL);
    await saveProfile(page, "to-delete");
    expect(deleteProfile("to-delete")).toBe(true);
    expect(listProfiles().some(p => p.name === "to-delete")).toBe(false);
    await ctx.close();
  });
});
