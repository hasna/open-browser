import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright";
import { resetDatabase } from "../db/schema.js";
import { enableNetworkLogging, startHAR, addInterceptRule } from "./network.js";
import { getNetworkLog, logRequest } from "../db/network-log.js";
import { createSession } from "../db/sessions.js";

let browser: Browser;
let page: Page;
let tmpDir: string;

// Local test server
let testServer: ReturnType<typeof Bun.serve>;
let TEST_URL: string;

beforeAll(async () => {
  testServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response("<html><body>net-test</body></html>", {
        headers: { "Content-Type": "text/html" },
      });
    },
  });
  TEST_URL = `http://localhost:${testServer.port}/`;

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
  testServer.stop();
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "browser-test-"));
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

describe("network", () => {
  it("enableNetworkLogging returns a cleanup function", () => {
    const cleanup = enableNetworkLogging(page, "test-sid");
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("logRequest writes to DB and getNetworkLog retrieves it", () => {
    // Create a real session first (FK constraint)
    const session = createSession({ engine: "playwright" });
    logRequest({
      session_id: session.id,
      method: "GET",
      url: "https://example.com/",
      status_code: 200,
      duration_ms: 123,
      resource_type: "document",
    });
    const log = getNetworkLog(session.id);
    expect(log.length).toBe(1);
    expect(log[0].url).toBe("https://example.com/");
    expect(log[0].status_code).toBe(200);
    expect(log[0].duration_ms).toBe(123);
  });

  it("startHAR returns capture object with stop() function", () => {
    const capture = startHAR(page);
    expect(typeof capture.stop).toBe("function");
    const har = capture.stop();
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator.name).toBe("@hasna/browser");
    expect(Array.isArray(har.log.entries)).toBe(true);
  });

  it("startHAR captures requests during navigation", async () => {
    const capture = startHAR(page);
    await page.goto(TEST_URL);
    const har = capture.stop();
    expect(har.log.entries.length).toBeGreaterThan(0);
    const entry = har.log.entries[0];
    expect(entry.request.url).toContain(`localhost:${testServer.port}`);
    expect(entry.response.status).toBe(200);
  });

  it("addInterceptRule installs without throwing", async () => {
    await expect(
      addInterceptRule(page, { pattern: "**/*.css", action: "block" })
    ).resolves.toBeUndefined();
    await page.unrouteAll();
  });
});
