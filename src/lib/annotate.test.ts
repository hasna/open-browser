import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { annotateScreenshot } from "./annotate.js";

let browser: Browser;
let page: Page;
let testServer: ReturnType<typeof Bun.serve>;

const HTML = `<!DOCTYPE html><html><body>
  <nav><a href="/a">Link A</a> <a href="/b">Link B</a></nav>
  <button>Submit</button>
  <input type="text" aria-label="Search" />
</body></html>`;

beforeAll(async () => {
  testServer = Bun.serve({ port: 0, fetch() { return new Response(HTML, { headers: { "Content-Type": "text/html" } }); } });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`http://localhost:${testServer.port}`);
});

afterAll(async () => {
  await browser.close();
  testServer.stop();
});

describe("annotateScreenshot", () => {
  it("returns buffer larger than empty (labels added)", async () => {
    const result = await annotateScreenshot(page, "ann-test-1");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("annotations array has entries for interactive elements", async () => {
    const result = await annotateScreenshot(page, "ann-test-2");
    expect(result.annotations.length).toBeGreaterThanOrEqual(3); // 2 links + 1 button + 1 textbox
  });

  it("each annotation has required fields", async () => {
    const result = await annotateScreenshot(page, "ann-test-3");
    for (const ann of result.annotations) {
      expect(typeof ann.ref).toBe("string");
      expect(ann.ref.startsWith("@e")).toBe(true);
      expect(typeof ann.label).toBe("number");
      expect(ann.label).toBeGreaterThanOrEqual(1);
      expect(typeof ann.x).toBe("number");
      expect(typeof ann.y).toBe("number");
      expect(typeof ann.width).toBe("number");
      expect(typeof ann.height).toBe("number");
      expect(typeof ann.role).toBe("string");
      expect(typeof ann.name).toBe("string");
    }
  });

  it("labels are sequential starting from 1", async () => {
    const result = await annotateScreenshot(page, "ann-test-4");
    const labels = result.annotations.map((a) => a.label).sort((a, b) => a - b);
    for (let i = 0; i < labels.length; i++) {
      expect(labels[i]).toBe(i + 1);
    }
  });

  it("labelToRef maps numbers to ref strings", async () => {
    const result = await annotateScreenshot(page, "ann-test-5");
    for (const [label, ref] of Object.entries(result.labelToRef)) {
      expect(parseInt(label)).toBeGreaterThanOrEqual(1);
      expect(ref.startsWith("@e")).toBe(true);
    }
    expect(Object.keys(result.labelToRef).length).toBe(result.annotations.length);
  });

  it("buffer is valid image (sharp can read it)", async () => {
    const result = await annotateScreenshot(page, "ann-test-6");
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
    expect(meta.format).toBe("webp");
  });
});
