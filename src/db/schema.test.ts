import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "./schema.js";

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

describe("DB schema", () => {
  it("creates database and all tables", () => {
    const db = getDatabase();
    expect(db).toBeDefined();
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("sessions");
    expect(tables).toContain("snapshots");
    expect(tables).toContain("network_log");
    expect(tables).toContain("console_log");
    expect(tables).toContain("recordings");
    expect(tables).toContain("crawl_results");
    expect(tables).toContain("agents");
    expect(tables).toContain("projects");
    expect(tables).toContain("heartbeats");
  });

  it("WAL mode is enabled", () => {
    const db = getDatabase();
    const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    expect(row?.journal_mode).toBe("wal");
  });

  it("returns same instance on repeated calls", () => {
    const db1 = getDatabase();
    const db2 = getDatabase();
    expect(db1).toBe(db2);
  });

  it("resetDatabase clears the singleton", () => {
    const db1 = getDatabase();
    resetDatabase();
    const db2 = getDatabase();
    expect(db1).not.toBe(db2);
  });
});
