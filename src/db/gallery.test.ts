import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "./schema.js";
import { createEntry, getEntry, listEntries, updateEntry, deleteEntry, tagEntry, untagEntry, favoriteEntry, searchEntries, getGalleryStats } from "./gallery.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gallery-test-"));
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

describe("gallery CRUD", () => {
  const sampleEntry = () => ({
    path: "/tmp/test.webp",
    url: "https://example.com",
    title: "Example Domain",
    format: "webp",
    width: 1280,
    height: 720,
    original_size_bytes: 50000,
    compressed_size_bytes: 20000,
    compression_ratio: 0.4,
    tags: [] as string[],
    is_favorite: false,
  });

  it("creates and retrieves an entry", () => {
    const e = createEntry(sampleEntry());
    expect(e.id).toBeTruthy();
    expect(e.url).toBe("https://example.com");
    expect(e.compression_ratio).toBe(0.4);

    const fetched = getEntry(e.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.id).toBe(e.id);
  });

  it("lists entries", () => {
    createEntry(sampleEntry());
    createEntry({ ...sampleEntry(), url: "https://other.com" });
    const entries = listEntries({ limit: 10 });
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by tag", () => {
    const e = createEntry(sampleEntry());
    tagEntry(e.id, "regression");
    const tagged = listEntries({ tag: "regression" });
    expect(tagged.some((x) => x.id === e.id)).toBe(true);
    const untagged = listEntries({ tag: "nonexistent" });
    expect(untagged.some((x) => x.id === e.id)).toBe(false);
  });

  it("filters by isFavorite", () => {
    const e = createEntry(sampleEntry());
    favoriteEntry(e.id, true);
    const favs = listEntries({ isFavorite: true });
    expect(favs.some((x) => x.id === e.id)).toBe(true);
    const nonFavs = listEntries({ isFavorite: false });
    expect(nonFavs.some((x) => x.id === e.id)).toBe(false);
  });

  it("tagEntry adds tag to array", () => {
    const e = createEntry(sampleEntry());
    tagEntry(e.id, "smoke");
    tagEntry(e.id, "perf");
    const updated = getEntry(e.id)!;
    expect(updated.tags).toContain("smoke");
    expect(updated.tags).toContain("perf");
  });

  it("tagEntry is idempotent", () => {
    const e = createEntry(sampleEntry());
    tagEntry(e.id, "dup");
    tagEntry(e.id, "dup");
    const updated = getEntry(e.id)!;
    expect(updated.tags.filter((t) => t === "dup").length).toBe(1);
  });

  it("untagEntry removes tag", () => {
    const e = createEntry(sampleEntry());
    tagEntry(e.id, "to-remove");
    untagEntry(e.id, "to-remove");
    const updated = getEntry(e.id)!;
    expect(updated.tags).not.toContain("to-remove");
  });

  it("favoriteEntry toggles is_favorite", () => {
    const e = createEntry(sampleEntry());
    expect(getEntry(e.id)!.is_favorite).toBe(false);
    favoriteEntry(e.id, true);
    expect(getEntry(e.id)!.is_favorite).toBe(true);
    favoriteEntry(e.id, false);
    expect(getEntry(e.id)!.is_favorite).toBe(false);
  });

  it("updateEntry updates notes", () => {
    const e = createEntry(sampleEntry());
    updateEntry(e.id, { notes: "Found regression here" });
    expect(getEntry(e.id)!.notes).toBe("Found regression here");
  });

  it("deleteEntry removes the entry", () => {
    const e = createEntry(sampleEntry());
    deleteEntry(e.id);
    expect(getEntry(e.id)).toBeNull();
  });

  it("searchEntries finds by URL", () => {
    createEntry({ ...sampleEntry(), url: "https://search-target.com" });
    const results = searchEntries("search-target");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("searchEntries finds by title", () => {
    createEntry({ ...sampleEntry(), title: "Unique Title XYZ" });
    const results = searchEntries("Unique Title XYZ");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("getGalleryStats returns correct counts", () => {
    createEntry(sampleEntry());
    const e2 = createEntry({ ...sampleEntry(), format: "jpeg" });
    favoriteEntry(e2.id, true);
    const stats = getGalleryStats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.favorites).toBeGreaterThanOrEqual(1);
    expect(stats.total_size_bytes).toBeGreaterThan(0);
    expect(stats.by_format["webp"]).toBeGreaterThanOrEqual(1);
    expect(stats.by_format["jpeg"]).toBeGreaterThanOrEqual(1);
  });
});
