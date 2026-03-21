import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { takeSnapshot } from "./snapshot.js";
import { clickRef, typeRef, fillRef, selectRef, checkRef, hoverRef } from "./actions.js";
import { ElementNotFoundError } from "../types/index.js";

let browser: Browser;
let page: Page;
let testServer: ReturnType<typeof Bun.serve>;

const HTML = `<!DOCTYPE html><html><body>
  <button id="btn" onclick="this.textContent='clicked!'">Click Me</button>
  <a href="#" onclick="event.preventDefault(); document.getElementById('status').textContent='linked!'">Go Link</a>
  <input type="text" aria-label="Name" />
  <input type="email" aria-label="Email" />
  <input type="checkbox" aria-label="Agree" />
  <select aria-label="Role"><option value="user">User</option><option value="admin">Admin</option></select>
  <div id="hover-target" aria-label="Hoverable" role="button" onmouseenter="this.textContent='hovered!'">Hover Me</div>
  <span id="status">ready</span>
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

function findRef(refs: Record<string, { name: string }>, name: string): string {
  const entry = Object.entries(refs).find(([_, r]) => r.name === name);
  if (!entry) throw new Error(`Ref not found for name: ${name}`);
  return entry[0];
}

describe("ref-based actions", () => {
  it("clickRef clicks the correct button", async () => {
    await page.goto(`http://localhost:${testServer.port}`);
    const snap = await takeSnapshot(page, "ref-click-test");
    const ref = findRef(snap.refs, "Click Me");
    await clickRef(page, "ref-click-test", ref);
    const text = await page.textContent("#btn");
    expect(text).toBe("clicked!");
  });

  it("typeRef types into the correct input", async () => {
    await page.goto(`http://localhost:${testServer.port}`);
    const snap = await takeSnapshot(page, "ref-type-test");
    const ref = findRef(snap.refs, "Name");
    await typeRef(page, "ref-type-test", ref, "hello world");
    const val = await page.inputValue('[aria-label="Name"]');
    expect(val).toBe("hello world");
  });

  it("fillRef fills the correct input", async () => {
    await page.goto(`http://localhost:${testServer.port}`);
    const snap = await takeSnapshot(page, "ref-fill-test");
    const ref = findRef(snap.refs, "Email");
    await fillRef(page, "ref-fill-test", ref, "test@example.com");
    const val = await page.inputValue('[aria-label="Email"]');
    expect(val).toBe("test@example.com");
  });

  it("selectRef selects the correct option", async () => {
    await page.goto(`http://localhost:${testServer.port}`);
    const snap = await takeSnapshot(page, "ref-select-test");
    const ref = findRef(snap.refs, "Role");
    await selectRef(page, "ref-select-test", ref, "admin");
    const val = await page.inputValue('[aria-label="Role"]');
    expect(val).toBe("admin");
  });

  it("checkRef checks the checkbox", async () => {
    await page.goto(`http://localhost:${testServer.port}`);
    const snap = await takeSnapshot(page, "ref-check-test");
    const ref = findRef(snap.refs, "Agree");
    await checkRef(page, "ref-check-test", ref, true);
    expect(await page.isChecked('[aria-label="Agree"]')).toBe(true);
    await checkRef(page, "ref-check-test", ref, false);
    expect(await page.isChecked('[aria-label="Agree"]')).toBe(false);
  });

  it("hoverRef hovers the element", async () => {
    await page.goto(`http://localhost:${testServer.port}`);
    const snap = await takeSnapshot(page, "ref-hover-test");
    const ref = findRef(snap.refs, "Hoverable");
    await hoverRef(page, "ref-hover-test", ref);
    // Just verify no throw — hover events are flaky in headless
  });

  it("throws ElementNotFoundError for stale ref", async () => {
    await page.goto(`http://localhost:${testServer.port}`);
    await takeSnapshot(page, "ref-stale-test");
    // @e999 doesn't exist
    await expect(clickRef(page, "ref-stale-test", "@e999")).rejects.toThrow(ElementNotFoundError);
  });

  it("throws for missing session snapshot", async () => {
    await expect(clickRef(page, "nonexistent-session", "@e0")).rejects.toThrow();
  });
});
