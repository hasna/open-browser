import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { takeSnapshot, getRefLocator, hasRefs, clearSessionRefs } from "./snapshot.js";

let browser: Browser;
let page: Page;
let testServer: ReturnType<typeof Bun.serve>;

const FORM_HTML = `<!DOCTYPE html><html><body>
  <h1>Snapshot Test</h1>
  <nav>
    <a href="/home">Home</a>
    <a href="/about">About</a>
  </nav>
  <form>
    <input type="text" aria-label="Username" />
    <input type="email" aria-label="Email" />
    <input type="checkbox" aria-label="Subscribe" />
    <select aria-label="Country"><option>US</option><option>UK</option></select>
    <button type="submit">Register</button>
  </form>
</body></html>`;

beforeAll(async () => {
  testServer = Bun.serve({ port: 0, fetch() { return new Response(FORM_HTML, { headers: { "Content-Type": "text/html" } }); } });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`http://localhost:${testServer.port}`);
});

afterAll(async () => {
  await browser.close();
  testServer.stop();
});

describe("takeSnapshot", () => {
  it("returns a tree string with ref annotations", async () => {
    const result = await takeSnapshot(page, "snap-test-1");
    expect(result.tree).toBeTruthy();
    expect(result.tree).toContain("[@e");
    expect(result.tree.length).toBeGreaterThan(50);
  });

  it("refs contain buttons, links, inputs", async () => {
    const result = await takeSnapshot(page, "snap-test-2");
    const roles = Object.values(result.refs).map((r) => r.role);
    expect(roles).toContain("button");
    expect(roles).toContain("link");
    expect(roles).toContain("textbox");
  });

  it("each ref has role, name, visible, enabled", async () => {
    const result = await takeSnapshot(page, "snap-test-3");
    for (const [ref, info] of Object.entries(result.refs)) {
      expect(typeof info.role).toBe("string");
      expect(typeof info.name).toBe("string");
      expect(info.name.length).toBeGreaterThan(0);
      expect(typeof info.visible).toBe("boolean");
      expect(typeof info.enabled).toBe("boolean");
    }
  });

  it("interactive_count matches refs count", async () => {
    const result = await takeSnapshot(page, "snap-test-4");
    expect(result.interactive_count).toBe(Object.keys(result.refs).length);
  });

  it("interactive_count is correct for the test page", async () => {
    const result = await takeSnapshot(page, "snap-test-5");
    // 2 links (Home, About) + 2 textboxes (Username, Email) + 1 checkbox + 1 combobox + 1 button = 7
    expect(result.interactive_count).toBeGreaterThanOrEqual(7);
  });

  it("refs are stable within same page state", async () => {
    const r1 = await takeSnapshot(page, "snap-test-6a");
    const r2 = await takeSnapshot(page, "snap-test-6b");
    // Same number of refs since page didn't change
    expect(r1.interactive_count).toBe(r2.interactive_count);
    // Same role+name combos
    const names1 = Object.values(r1.refs).map((r) => `${r.role}:${r.name}`).sort();
    const names2 = Object.values(r2.refs).map((r) => `${r.role}:${r.name}`).sort();
    expect(names1).toEqual(names2);
  });

  it("refMap is cached per session", async () => {
    clearSessionRefs("snap-cache-test");
    expect(hasRefs("snap-cache-test")).toBe(false);
    await takeSnapshot(page, "snap-cache-test");
    expect(hasRefs("snap-cache-test")).toBe(true);
    clearSessionRefs("snap-cache-test");
    expect(hasRefs("snap-cache-test")).toBe(false);
  });
});

describe("getRefLocator", () => {
  it("resolves a button ref to the correct element", async () => {
    const result = await takeSnapshot(page, "ref-resolve-1");
    const btnRef = Object.entries(result.refs).find(([_, r]) => r.name === "Register")?.[0];
    expect(btnRef).toBeTruthy();
    const locator = getRefLocator(page, "ref-resolve-1", btnRef!);
    const text = await locator.textContent();
    expect(text).toContain("Register");
  });

  it("resolves a textbox ref and can fill it", async () => {
    const result = await takeSnapshot(page, "ref-resolve-2");
    const inputRef = Object.entries(result.refs).find(([_, r]) => r.name === "Username")?.[0];
    expect(inputRef).toBeTruthy();
    const locator = getRefLocator(page, "ref-resolve-2", inputRef!);
    await locator.fill("testuser");
    const val = await locator.inputValue();
    expect(val).toBe("testuser");
  });

  it("throws for invalid ref", async () => {
    await takeSnapshot(page, "ref-resolve-3");
    expect(() => getRefLocator(page, "ref-resolve-3", "@e999")).toThrow("Ref @e999 not found");
  });

  it("throws for missing session snapshot", () => {
    expect(() => getRefLocator(page, "no-such-session", "@e0")).toThrow("No snapshot taken");
  });
});
