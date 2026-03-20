import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "./schema.js";
import { createSession, getSession, listSessions, closeSession, deleteSession } from "./sessions.js";

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

describe("sessions CRUD", () => {
  it("creates a session", () => {
    const s = createSession({ engine: "playwright" });
    expect(s.id).toBeTruthy();
    expect(s.engine).toBe("playwright");
    expect(s.status).toBe("active");
    const fetched = getSession(s.id);
    expect(fetched.id).toBe(s.id);
  });

  it("closes a session", () => {
    const s = createSession({ engine: "playwright" });
    closeSession(s.id);
    const updated = getSession(s.id);
    expect(updated.status).toBe("closed");
    expect(updated.closed_at).toBeTruthy();
  });

  it("lists sessions by status", () => {
    const s1 = createSession({ engine: "playwright" });
    const s2 = createSession({ engine: "lightpanda" });
    closeSession(s1.id);
    const active = listSessions({ status: "active" });
    expect(active.some((s) => s.id === s2.id)).toBe(true);
    expect(active.every((s) => s.status === "active")).toBe(true);
  });

  it("deletes a session", () => {
    const s = createSession({ engine: "playwright" });
    deleteSession(s.id);
    expect(() => getSession(s.id)).toThrow("Session not found");
  });

  it("throws SessionNotFoundError for missing session", () => {
    expect(() => getSession("missing")).toThrow("Session not found");
  });
});
