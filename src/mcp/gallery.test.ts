import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "../db/schema.js";
import { createEntry, getEntry, listEntries, tagEntry, favoriteEntry, searchEntries, getGalleryStats } from "../db/gallery.js";
import { saveToDownloads, listDownloads, getDownload, deleteDownload, cleanStaleDownloads } from "../lib/downloads.js";

let tmpDir: string;

const sample = () => ({
  path: "/tmp/test.webp",
  url: "https://example.com",
  title: "Example",
  format: "webp",
  width: 1280, height: 720,
  original_size_bytes: 50000,
  compressed_size_bytes: 20000,
  compression_ratio: 0.4,
  tags: [] as string[],
  is_favorite: false,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-gallery-test-"));
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

describe("gallery MCP tool logic", () => {
  it("browser_gallery_list returns all entries", () => {
    createEntry(sample());
    createEntry({ ...sample(), url: "https://other.com" });
    const entries = listEntries({ limit: 50 });
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("browser_gallery_list filters by tag", () => {
    const e = createEntry(sample());
    tagEntry(e.id, "smoke");
    const tagged = listEntries({ tag: "smoke" });
    expect(tagged.some((x) => x.id === e.id)).toBe(true);
  });

  it("browser_gallery_list filters by is_favorite", () => {
    const e = createEntry(sample());
    favoriteEntry(e.id, true);
    const favs = listEntries({ isFavorite: true });
    expect(favs.some((x) => x.id === e.id)).toBe(true);
    const nonFavs = listEntries({ isFavorite: false });
    expect(nonFavs.some((x) => x.id === e.id)).toBe(false);
  });

  it("browser_gallery_get retrieves by id", () => {
    const e = createEntry(sample());
    const found = getEntry(e.id);
    expect(found).toBeTruthy();
    expect(found!.id).toBe(e.id);
  });

  it("browser_gallery_get returns null for missing", () => {
    expect(getEntry("nonexistent")).toBeNull();
  });

  it("browser_gallery_tag adds tag", () => {
    const e = createEntry(sample());
    tagEntry(e.id, "regression");
    expect(getEntry(e.id)!.tags).toContain("regression");
  });

  it("browser_gallery_favorite sets is_favorite true then false", () => {
    const e = createEntry(sample());
    favoriteEntry(e.id, true);
    expect(getEntry(e.id)!.is_favorite).toBe(true);
    favoriteEntry(e.id, false);
    expect(getEntry(e.id)!.is_favorite).toBe(false);
  });

  it("browser_gallery_search finds by url", () => {
    createEntry({ ...sample(), url: "https://unique-gallery-url.com" });
    const results = searchEntries("unique-gallery-url");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("browser_gallery_search finds by title", () => {
    createEntry({ ...sample(), title: "Special Page Title" });
    expect(searchEntries("Special Page Title").length).toBeGreaterThanOrEqual(1);
  });

  it("browser_gallery_stats returns correct shape", () => {
    createEntry(sample());
    createEntry({ ...sample(), format: "jpeg", compressed_size_bytes: 15000 });
    const stats = getGalleryStats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(typeof stats.total_size_bytes).toBe("number");
    expect(typeof stats.favorites).toBe("number");
    expect(typeof stats.by_format).toBe("object");
  });

  it("browser_gallery_diff requires real image files", async () => {
    const { diffImages } = await import("../lib/gallery-diff.js");
    // Create two minimal test images using sharp
    const sharp = (await import("sharp")).default;
    const img1 = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } } }).webp().toBuffer();
    const img2 = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } } }).webp().toBuffer();
    const p1 = join(tmpDir, "img1.webp");
    const p2 = join(tmpDir, "img2.webp");
    writeFileSync(p1, img1);
    writeFileSync(p2, img2);

    const result = await diffImages(p1, p2);
    expect(result.diff_base64.length).toBeGreaterThan(0);
    expect(result.total_pixels).toBe(10000); // 100x100
    expect(result.changed_pixels).toBeGreaterThan(0);
    expect(result.changed_percent).toBeGreaterThan(0);
  });
});

describe("downloads MCP tool logic", () => {
  it("browser_downloads_list returns saved downloads", () => {
    saveToDownloads(Buffer.from("shot"), "test.webp");
    saveToDownloads(Buffer.from("pdf content"), "report.pdf");
    const files = listDownloads();
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("browser_downloads_get retrieves by id with correct metadata", () => {
    const saved = saveToDownloads(Buffer.from("hello"), "hello.txt");
    const found = getDownload(saved.id);
    expect(found).toBeTruthy();
    expect(found!.size_bytes).toBe(5);
  });

  it("browser_downloads_delete removes file", () => {
    const saved = saveToDownloads(Buffer.from("x"), "x.webp");
    expect(deleteDownload(saved.id)).toBe(true);
    expect(getDownload(saved.id)).toBeNull();
  });

  it("browser_downloads_clean returns count of removed files", () => {
    saveToDownloads(Buffer.from("old"), "old.webp");
    const count = cleanStaleDownloads(-1);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("downloads list returns empty when nothing saved", () => {
    expect(listDownloads().length).toBe(0);
  });
});

describe("session naming (MCP level)", () => {
  it("createSession with name stores it", async () => {
    const { createSession } = await import("../db/sessions.js");
    const s = createSession({ engine: "playwright", name: "mcp-test-session" });
    expect(s.name).toBe("mcp-test-session");
  });

  it("getSessionByName returns correct session", async () => {
    const { createSession, getSessionByName } = await import("../db/sessions.js");
    const s = createSession({ engine: "playwright", name: "find-me" });
    const found = getSessionByName("find-me");
    expect(found?.id).toBe(s.id);
  });

  it("renameSession updates the name", async () => {
    const { createSession, renameSession, getSession } = await import("../db/sessions.js");
    const s = createSession({ engine: "playwright" });
    renameSession(s.id, "new-name");
    expect(getSession(s.id).name).toBe("new-name");
  });

  it("getSessionByName returns null for unknown name", async () => {
    const { getSessionByName } = await import("../db/sessions.js");
    expect(getSessionByName("ghost-session")).toBeNull();
  });
});
