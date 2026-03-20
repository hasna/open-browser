import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { getText, getHTML, getLinks, getTitle, getUrl, extractStructured, extractTable, getAriaSnapshot, extract } from "./extractor.js";

let browser: Browser;
let page: Page;

const HTML = `<!DOCTYPE html><html><head><title>Test Page</title></head><body>
  <h1>Hello World</h1>
  <p id="para">Some <strong>text</strong> here</p>
  <a href="https://example.com">Example</a>
  <a href="https://other.com">Other</a>
  <table id="tbl"><tr><th>Name</th><th>Value</th></tr><tr><td>foo</td><td>bar</td></tr></table>
  <span class="item">Alpha</span>
  <span class="item">Beta</span>
</body></html>`;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(HTML);
});

afterAll(async () => {
  await browser.close();
});

describe("extractor", () => {
  it("getText returns body text", async () => {
    const text = await getText(page);
    expect(text).toContain("Hello World");
    expect(text).toContain("Some text here");
  });

  it("getText with selector returns element text", async () => {
    const text = await getText(page, "#para");
    expect(text).toContain("Some");
  });

  it("getHTML returns full page HTML", async () => {
    const html = await getHTML(page);
    expect(html).toContain("<h1>Hello World</h1>");
  });

  it("getHTML with selector returns element HTML", async () => {
    const html = await getHTML(page, "#para");
    expect(html).toContain("<strong>text</strong>");
  });

  it("getLinks returns all links", async () => {
    const links = await getLinks(page);
    expect(links).toContain("https://example.com/");
    expect(links).toContain("https://other.com/");
  });

  it("getTitle returns page title", async () => {
    expect(await getTitle(page)).toBe("Test Page");
  });

  it("extractStructured maps fields to selectors", async () => {
    const result = await extractStructured(page, { heading: "h1", items: ".item" });
    expect(result.heading).toBe("Hello World");
    expect(result.items).toEqual(["Alpha", "Beta"]);
  });

  it("extractTable returns 2D array", async () => {
    const table = await extractTable(page, "#tbl");
    expect(table[0]).toEqual(["Name", "Value"]);
    expect(table[1]).toEqual(["foo", "bar"]);
  });

  it("getAriaSnapshot returns string", async () => {
    const snapshot = await getAriaSnapshot(page);
    expect(typeof snapshot).toBe("string");
    expect(snapshot.length).toBeGreaterThan(0);
  });

  it("extract format=text returns text", async () => {
    const result = await extract(page, { format: "text" });
    expect(result.text).toBeDefined();
    expect(result.text!.length).toBeGreaterThan(0);
  });

  it("extract format=links returns links array", async () => {
    const result = await extract(page, { format: "links" });
    expect(result.links).toBeDefined();
    expect(result.links!.length).toBeGreaterThanOrEqual(2);
  });

  it("getText returns empty string for missing selector", async () => {
    const text = await getText(page, "#nonexistent");
    expect(text).toBe("");
  });
});
