import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright";
import { resetDatabase } from "../db/schema.js";
import { startRecording, stopRecording, replayRecording, recordStep, exportRecording } from "./recorder.js";

let browser: Browser;
let page: Page;
let tmpDir: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent('<html><body><button id="btn">Click</button></body></html>');
});

afterAll(async () => {
  await browser.close();
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

describe("recorder", () => {
  it("startRecording creates a recording", () => {
    const r = startRecording("session-1", "test-recording", "https://example.com");
    expect(r.id).toBeTruthy();
    expect(r.name).toBe("test-recording");
    expect(r.steps).toHaveLength(0);
  });

  it("recordStep adds a step to active recording", () => {
    const r = startRecording("session-2", "with-steps");
    recordStep(r.id, { type: "click", selector: "#btn" });
    recordStep(r.id, { type: "type", selector: "#inp", value: "hello" });
    const stopped = stopRecording(r.id);
    expect(stopped.steps).toHaveLength(2);
    expect(stopped.steps[0].type).toBe("click");
    expect(stopped.steps[1].type).toBe("type");
  });

  it("stopRecording persists steps to DB", () => {
    const r = startRecording("session-3", "persist-test");
    recordStep(r.id, { type: "navigate", url: "https://example.com" });
    const stopped = stopRecording(r.id);
    expect(stopped.steps).toHaveLength(1);
  });

  it("exportRecording as JSON returns valid JSON", () => {
    const r = startRecording("session-4", "export-test");
    recordStep(r.id, { type: "navigate", url: "https://example.com" });
    stopRecording(r.id);
    const json = exportRecording(r.id, "json");
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("export-test");
    expect(parsed.steps).toHaveLength(1);
  });

  it("exportRecording as playwright format returns test code", () => {
    const r = startRecording("session-5", "playwright-test");
    recordStep(r.id, { type: "navigate", url: "https://example.com" });
    stopRecording(r.id);
    const code = exportRecording(r.id, "playwright");
    expect(code).toContain("import { test, expect }");
    expect(code).toContain("page.goto");
  });

  it("replayRecording executes steps on page", async () => {
    const r = startRecording("session-6", "replay-test", "about:blank");
    recordStep(r.id, { type: "navigate", url: "about:blank" });
    stopRecording(r.id);
    const result = await replayRecording(r.id, page);
    expect(result.recording_id).toBe(r.id);
    expect(result.steps_executed).toBe(1);
    expect(result.steps_failed).toBe(0);
  });

  it("throws when recording step to unknown recording", () => {
    expect(() => recordStep("nonexistent", { type: "click" })).toThrow("No active recording");
  });
});
