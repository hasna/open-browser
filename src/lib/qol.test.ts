import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright";
import { resetDatabase } from "../db/schema.js";
import { clickText, fillForm, waitForText, withRetry, watchPage, getWatchChanges, stopWatch } from "./actions.js";
import { elementExists, getPageInfo } from "./extractor.js";
import { ElementNotFoundError } from "../types/index.js";

let browser: Browser;
let page: Page;
let testServer: ReturnType<typeof Bun.serve>;
let BASE: string;
let tmpDir: string;

const FORM_HTML = `<!DOCTYPE html><html><body>
  <h1>Test Form</h1>
  <p id="welcome">Welcome to the test page</p>
  <form id="myform">
    <input id="name" name="name" type="text" />
    <input id="email" name="email" type="email" />
    <input id="agree" name="agree" type="checkbox" />
    <select id="role" name="role">
      <option value="user">User</option>
      <option value="admin">Admin</option>
    </select>
    <button id="submit" type="submit">Submit Form</button>
  </form>
  <a href="https://example.com">External Link</a>
  <a href="/about">About</a>
  <img src="/logo.png" />
  <div id="dynamic" style="display:none">Hidden</div>
</body></html>`;

beforeAll(async () => {
  testServer = Bun.serve({
    port: 0,
    fetch() { return new Response(FORM_HTML, { headers: { "Content-Type": "text/html" } }); },
  });
  BASE = `http://localhost:${testServer.port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(BASE);
});

afterAll(async () => {
  await browser.close();
  testServer.stop();
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "qol-test-"));
  process.env["BROWSER_DB_PATH"] = join(tmpDir, "test.db");
  process.env["BROWSER_DATA_DIR"] = tmpDir;
  resetDatabase();
  // Re-navigate to reset state
});

afterEach(() => {
  resetDatabase();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env["BROWSER_DB_PATH"];
  delete process.env["BROWSER_DATA_DIR"];
});

describe("clickText", () => {
  it("clicks element by text content", async () => {
    await page.goto(BASE);
    await expect(clickText(page, "Submit Form")).resolves.toBeUndefined();
  });

  it("throws BrowserError when text not found", async () => {
    await page.goto(BASE);
    await expect(clickText(page, "Nonexistent Button XYZ", { timeout: 1000 })).rejects.toThrow();
  });
});

describe("fillForm", () => {
  it("fills text, checkbox, and select in one call", async () => {
    await page.goto(BASE);
    const result = await fillForm(page, {
      "#name": "Andrei",
      "#email": "andrei@hasna.com",
      "#agree": true,
      "#role": "admin",
    });
    expect(result.filled).toBe(4);
    expect(result.errors).toHaveLength(0);
    expect(result.fields_attempted).toBe(4);
    expect(await page.inputValue("#name")).toBe("Andrei");
    expect(await page.inputValue("#email")).toBe("andrei@hasna.com");
    expect(await page.isChecked("#agree")).toBe(true);
    expect(await page.inputValue("#role")).toBe("admin");
  });

  it("reports errors for missing selectors", async () => {
    await page.goto(BASE);
    const result = await fillForm(page, {
      "#name": "Valid",
      "#nonexistent": "Invalid",
    });
    expect(result.filled).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("#nonexistent");
  });
});

describe("waitForText", () => {
  it("resolves when text is already present", async () => {
    await page.goto(BASE);
    await expect(waitForText(page, "Welcome to the test page")).resolves.toBeUndefined();
  });

  it("throws ElementNotFoundError when text never appears", async () => {
    await page.goto(BASE);
    await expect(waitForText(page, "Text That Never Appears XYZ", { timeout: 500 })).rejects.toThrow(ElementNotFoundError);
  });

  it("resolves after dynamic content appears", async () => {
    await page.goto(BASE);
    // Reveal hidden div via JS after short delay
    setTimeout(() => page.evaluate(() => {
      const el = document.getElementById("dynamic");
      if (el) { el.style.display = "block"; el.textContent = "Now Visible"; }
    }), 300);
    await expect(waitForText(page, "Now Visible", { timeout: 3000 })).resolves.toBeUndefined();
  });
});

describe("elementExists", () => {
  it("returns exists:true for present selector", async () => {
    await page.goto(BASE);
    const result = await elementExists(page, "#submit");
    expect(result.exists).toBe(true);
    expect(result.count).toBe(1);
    expect(result.visible).toBe(true);
  });

  it("returns exists:false for absent selector", async () => {
    await page.goto(BASE);
    const result = await elementExists(page, "#does-not-exist");
    expect(result.exists).toBe(false);
    expect(result.count).toBe(0);
    expect(result.visible).toBe(false);
  });

  it("counts multiple matching elements", async () => {
    await page.goto(BASE);
    const result = await elementExists(page, "a");
    expect(result.exists).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(2);
  });
});

describe("getPageInfo", () => {
  it("returns all expected fields", async () => {
    await page.goto(BASE);
    const info = await getPageInfo(page);
    expect(typeof info.url).toBe("string");
    expect(typeof info.title).toBe("string");
    expect(typeof info.links_count).toBe("number");
    expect(typeof info.images_count).toBe("number");
    expect(typeof info.forms_count).toBe("number");
    expect(typeof info.text_length).toBe("number");
    expect(typeof info.viewport.width).toBe("number");
    expect(typeof info.viewport.height).toBe("number");
  });

  it("counts links, images, forms correctly", async () => {
    await page.goto(BASE);
    const info = await getPageInfo(page);
    expect(info.links_count).toBeGreaterThanOrEqual(2);
    expect(info.images_count).toBeGreaterThanOrEqual(1);
    expect(info.forms_count).toBeGreaterThanOrEqual(1);
    expect(info.text_length).toBeGreaterThan(0);
  });
});

describe("withRetry", () => {
  it("succeeds on first attempt", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return "ok"; });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on retryable error and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("Timeout waiting for selector");
      return "success";
    }, { retries: 3, delay: 10 });
    expect(result).toBe("success");
    expect(calls).toBe(3);
  });

  it("does NOT retry ElementNotFoundError", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new ElementNotFoundError("#missing");
    }, { retries: 3, delay: 10 })).rejects.toThrow(ElementNotFoundError);
    expect(calls).toBe(1);
  });

  it("throws after exhausting retries", async () => {
    await expect(withRetry(async () => {
      throw new Error("Timeout: persistent failure");
    }, { retries: 2, delay: 10 })).rejects.toThrow("persistent failure");
  });
});

describe("watchPage", () => {
  it("starts watch and returns handle with id", async () => {
    await page.goto(BASE);
    const handle = watchPage(page, { intervalMs: 100 });
    expect(handle.id).toBeTruthy();
    handle.stop();
  });

  it("captures initial state on first check", async () => {
    await page.goto(BASE);
    const handle = watchPage(page, { intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 300));
    const changes = getWatchChanges(handle.id);
    expect(changes.length).toBeGreaterThanOrEqual(1);
    handle.stop();
  });

  it("stopWatch clears the watch", async () => {
    await page.goto(BASE);
    const handle = watchPage(page, { intervalMs: 100 });
    handle.stop();
    const id = handle.id;
    await new Promise((r) => setTimeout(r, 200));
    // After stop, no new changes should accumulate
    const changes = getWatchChanges(id);
    const count1 = changes.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(getWatchChanges(id).length).toBe(count1);
  });
});

describe("session naming (DB level)", () => {
  it("creates session with name", async () => {
    const { createSession, getSessionByName } = await import("../db/sessions.js");
    const s = createSession({ engine: "playwright", name: "my-named-session" });
    expect(s.name).toBe("my-named-session");
    const found = getSessionByName("my-named-session");
    expect(found?.id).toBe(s.id);
  });

  it("renameSession updates name", async () => {
    const { createSession, renameSession, getSession } = await import("../db/sessions.js");
    const s = createSession({ engine: "playwright" });
    const renamed = renameSession(s.id, "renamed");
    expect(renamed.name).toBe("renamed");
    expect(getSession(s.id).name).toBe("renamed");
  });

  it("getSessionByName returns null for missing name", async () => {
    const { getSessionByName } = await import("../db/sessions.js");
    expect(getSessionByName("nonexistent-name")).toBeNull();
  });
});
