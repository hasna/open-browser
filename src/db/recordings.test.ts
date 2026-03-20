import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "./schema.js";
import { createRecording, getRecording, listRecordings, updateRecording, deleteRecording } from "./recordings.js";

let tmpDir: string;

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

describe("recordings CRUD", () => {
  it("creates a recording with steps", () => {
    const r = createRecording({
      name: "login-flow",
      start_url: "https://example.com",
      steps: [{ type: "navigate", url: "https://example.com", timestamp: Date.now() }],
    });
    expect(r.id).toBeTruthy();
    expect(r.name).toBe("login-flow");
    expect(r.steps).toHaveLength(1);
    const fetched = getRecording(r.id);
    expect(fetched.steps).toHaveLength(1);
    expect(fetched.steps[0].type).toBe("navigate");
  });

  it("updates recording steps", () => {
    const r = createRecording({ name: "test", steps: [] });
    const updated = updateRecording(r.id, {
      steps: [{ type: "click", selector: "#btn", timestamp: Date.now() }],
    });
    expect(updated.steps).toHaveLength(1);
    expect(updated.steps[0].type).toBe("click");
  });

  it("lists recordings", () => {
    createRecording({ name: "rec1", steps: [] });
    createRecording({ name: "rec2", steps: [] });
    expect(listRecordings().length).toBeGreaterThanOrEqual(2);
  });

  it("deletes a recording", () => {
    const r = createRecording({ name: "to-delete", steps: [] });
    deleteRecording(r.id);
    expect(() => getRecording(r.id)).toThrow("Recording not found");
  });
});
