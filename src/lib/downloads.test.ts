import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveToDownloads, listDownloads, getDownload, deleteDownload, cleanStaleDownloads, exportToPath, getDownloadsDir } from "./downloads.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "downloads-test-"));
  process.env["BROWSER_DATA_DIR"] = tmpDir;
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env["BROWSER_DATA_DIR"];
});

describe("downloads lib", () => {
  it("getDownloadsDir creates directory", () => {
    const dir = getDownloadsDir();
    expect(existsSync(dir)).toBe(true);
  });

  it("saveToDownloads writes file and sidecar", () => {
    const buf = Buffer.from("hello screenshot");
    const file = saveToDownloads(buf, "test.webp", { type: "screenshot" });
    expect(file.id).toBeTruthy();
    expect(file.size_bytes).toBe(buf.length);
    expect(file.type).toBe("screenshot");
    expect(existsSync(file.path)).toBe(true);
    expect(existsSync(file.meta_path)).toBe(true);
  });

  it("sidecar meta.json is valid JSON with correct fields", () => {
    const buf = Buffer.from("pdf content");
    const file = saveToDownloads(buf, "report.pdf", { type: "pdf", sourceUrl: "https://example.com" });
    const meta = JSON.parse(readFileSync(file.meta_path, "utf8"));
    expect(meta.id).toBe(file.id);
    expect(meta.type).toBe("pdf");
    expect(meta.source_url).toBe("https://example.com");
    expect(meta.size_bytes).toBe(buf.length);
  });

  it("listDownloads returns saved files", () => {
    saveToDownloads(Buffer.from("a"), "a.webp");
    saveToDownloads(Buffer.from("bb"), "b.pdf");
    const files = listDownloads();
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("listDownloads filters by sessionId", () => {
    saveToDownloads(Buffer.from("x"), "x.webp", { sessionId: "sess-1" });
    saveToDownloads(Buffer.from("y"), "y.webp", { sessionId: "sess-2" });
    const sess1 = listDownloads("sess-1");
    expect(sess1.length).toBe(1);
    expect(sess1[0].session_id).toBe("sess-1");
  });

  it("getDownload retrieves by id", () => {
    const saved = saveToDownloads(Buffer.from("data"), "data.json");
    const found = getDownload(saved.id);
    expect(found).toBeTruthy();
    expect(found!.id).toBe(saved.id);
    expect(found!.filename).toBe(saved.filename);
  });

  it("getDownload returns null for missing id", () => {
    expect(getDownload("nonexistent")).toBeNull();
  });

  it("deleteDownload removes file and sidecar", () => {
    const saved = saveToDownloads(Buffer.from("delete me"), "del.webp");
    const { path, meta_path } = saved;
    const deleted = deleteDownload(saved.id);
    expect(deleted).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(meta_path)).toBe(false);
  });

  it("deleteDownload returns false for missing id", () => {
    expect(deleteDownload("nonexistent")).toBe(false);
  });

  it("cleanStaleDownloads removes old files", () => {
    // Save a file then clean with days=-1 (everything is "old")
    saveToDownloads(Buffer.from("stale"), "stale.webp");
    const count = cleanStaleDownloads(-1);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(listDownloads().length).toBe(0);
  });

  it("cleanStaleDownloads preserves recent files", () => {
    saveToDownloads(Buffer.from("fresh"), "fresh.webp");
    const count = cleanStaleDownloads(365); // 1 year threshold
    expect(count).toBe(0);
    expect(listDownloads().length).toBeGreaterThanOrEqual(1);
  });

  it("exportToPath copies file to target", () => {
    const saved = saveToDownloads(Buffer.from("export me"), "export.webp");
    const target = join(tmpDir, "exported.webp");
    exportToPath(saved.id, target);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).toString()).toBe("export me");
  });

  it("exportToPath throws for missing id", () => {
    expect(() => exportToPath("nonexistent", "/tmp/out.webp")).toThrow();
  });

  it("auto-detects file type from extension", () => {
    const pdf = saveToDownloads(Buffer.from("pdf"), "doc.pdf");
    expect(pdf.type).toBe("pdf");
    const ss = saveToDownloads(Buffer.from("img"), "shot.webp");
    expect(ss.type).toBe("screenshot");
    const har = saveToDownloads(Buffer.from("har"), "traffic.har");
    expect(har.type).toBe("har");
  });
});
