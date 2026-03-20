import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { click, type as typeText, fill, scroll, hover, goBack, goForward, navigate, waitForSelector, pressKey } from "./actions.js";
import { ElementNotFoundError, NavigationError } from "../types/index.js";

let browser: Browser;
let page: Page;

const FORM_HTML = `<!DOCTYPE html><html><body>
  <button id="btn" onclick="this.textContent='clicked'">Click me</button>
  <input id="inp" type="text" />
  <input id="check" type="checkbox" />
  <select id="sel"><option value="a">A</option><option value="b">B</option></select>
  <div id="hover-target">Hover here</div>
  <div id="visible">Visible</div>
</body></html>`;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(FORM_HTML);
});

afterAll(async () => {
  await browser.close();
});

describe("actions", () => {
  it("click changes button text", async () => {
    await click(page, "#btn");
    const text = await page.textContent("#btn");
    expect(text).toBe("clicked");
  });

  it("type inserts text into input", async () => {
    await typeText(page, "#inp", "hello");
    const value = await page.inputValue("#inp");
    expect(value).toBe("hello");
  });

  it("fill sets input value", async () => {
    await fill(page, "#inp", "world");
    const value = await page.inputValue("#inp");
    expect(value).toBe("world");
  });

  it("scroll doesn't throw", async () => {
    await expect(scroll(page, "down", 100)).resolves.toBeUndefined();
  });

  it("hover doesn't throw", async () => {
    await expect(hover(page, "#hover-target")).resolves.toBeUndefined();
  });

  it("waitForSelector finds visible element", async () => {
    await expect(waitForSelector(page, "#visible")).resolves.toBeUndefined();
  });

  it("pressKey doesn't throw", async () => {
    await expect(pressKey(page, "Tab")).resolves.toBeUndefined();
  });

  it("navigate goes to about:blank", async () => {
    await navigate(page, "about:blank");
    expect(page.url()).toBe("about:blank");
    // Restore for other tests
    await page.setContent(FORM_HTML);
  });

  it("throws ElementNotFoundError for missing selector (waitForSelector)", async () => {
    await expect(waitForSelector(page, "#does-not-exist", { timeout: 500 })).rejects.toThrow(ElementNotFoundError);
  });
});
