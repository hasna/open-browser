import type { Page } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import sharp from "sharp";
import type { ScreenshotOptions, ScreenshotResult, PDFOptions, PDFResult } from "../types/index.js";
import { BrowserError } from "../types/index.js";
import { createEntry } from "../db/gallery.js";
import { getDataDir } from "../db/schema.js";

function getScreenshotDir(projectId?: string): string {
  const base = join(getDataDir(), "screenshots");
  const date = new Date().toISOString().split("T")[0];
  const dir = projectId ? join(base, projectId, date) : join(base, date);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Compression pipeline ─────────────────────────────────────────────────────

async function compressBuffer(
  raw: Buffer,
  format: "webp" | "jpeg" | "png",
  quality: number,
  maxWidth: number
): Promise<Buffer> {
  let pipeline = sharp(raw).resize({ width: maxWidth, withoutEnlargement: true });

  switch (format) {
    case "webp":
      return pipeline.webp({ quality, effort: 4 }).toBuffer();
    case "jpeg":
      return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    case "png":
      return pipeline.png({ compressionLevel: 9 }).toBuffer();
  }
}

async function generateThumbnail(raw: Buffer, dir: string, stem: string): Promise<{ path: string; base64: string }> {
  const thumbPath = join(dir, `${stem}.thumb.webp`);
  const thumbBuffer = await sharp(raw)
    .resize({ width: 200, withoutEnlargement: true })
    .webp({ quality: 70, effort: 3 })
    .toBuffer();
  await Bun.write(thumbPath, thumbBuffer);
  return { path: thumbPath, base64: thumbBuffer.toString("base64") };
}

// ─── takeScreenshot ───────────────────────────────────────────────────────────

export async function takeScreenshot(
  page: Page,
  opts?: ScreenshotOptions & { projectId?: string; sessionId?: string; track?: boolean }
): Promise<ScreenshotResult> {
  try {
    const dir = getScreenshotDir(opts?.projectId);
    const timestamp = Date.now();
    const format = opts?.format ?? "webp";
    const compress = opts?.compress ?? true;
    const maxWidth = opts?.maxWidth ?? 1280;
    const quality = opts?.quality ?? (format === "webp" ? 82 : format === "jpeg" ? 85 : undefined);
    const stem = String(timestamp);

    // Always capture raw PNG from Playwright first (lossless source)
    // NOTE: Do NOT include undefined fields in rawOpts — Playwright 1.58+ rejects them
    const rawOpts: { fullPage: boolean; type: "png" } = {
      fullPage: opts?.fullPage ?? false,
      type: "png",
    };

    let rawBuffer: Buffer;
    // Check if this is a BunWebViewSession (has screenshot() returning Uint8Array)
    const isBunView = typeof (page as any).getNativeView === "function";
    if (opts?.selector) {
      if (isBunView) {
        // Bun.WebView doesn't support element screenshots — take full page and note it
        const uint8 = await (page as any).screenshot();
        rawBuffer = Buffer.from(uint8 instanceof Uint8Array ? uint8 : await uint8);
      } else {
        const el = await page.$(opts.selector);
        if (!el) throw new BrowserError(`Element not found: ${opts.selector}`, "ELEMENT_NOT_FOUND");
        rawBuffer = await el.screenshot(rawOpts) as Buffer;
      }
    } else if (isBunView) {
      // Bun.WebView path — screenshot() returns Uint8Array, convert to Buffer
      const uint8 = await (page as any).screenshot();
      rawBuffer = Buffer.from(uint8 instanceof Uint8Array ? uint8 : await uint8);
    } else {
      rawBuffer = await page.screenshot(rawOpts) as Buffer;
    }

    const originalSizeBytes = rawBuffer.length;

    // Compress via sharp pipeline — with fallback if sharp fails
    let finalBuffer: Buffer;
    let compressed = true;
    let fallback = false;
    try {
      if (compress && format !== "png") {
        finalBuffer = await compressBuffer(rawBuffer, format, quality ?? 82, maxWidth);
      } else if (compress && format === "png") {
        finalBuffer = await compressBuffer(rawBuffer, "png", quality ?? 9, maxWidth);
      } else {
        finalBuffer = rawBuffer;
        compressed = false;
      }
    } catch (sharpErr) {
      // Fallback: use raw PNG if sharp fails
      fallback = true;
      compressed = false;
      finalBuffer = rawBuffer;
    }

    const compressedSizeBytes = finalBuffer.length;
    const compressionRatio = originalSizeBytes > 0 ? compressedSizeBytes / originalSizeBytes : 1;

    // Write final file
    const ext = format;
    const screenshotPath = opts?.path ?? join(dir, `${stem}.${ext}`);
    await Bun.write(screenshotPath, finalBuffer);

    // Generate thumbnail (always from raw PNG for best quality)
    let thumbnailPath: string | undefined;
    let thumbnailBase64: string | undefined;
    if (opts?.thumbnail !== false) {
      const thumb = await generateThumbnail(rawBuffer, dir, stem);
      thumbnailPath = thumb.path;
      thumbnailBase64 = thumb.base64;
    }

    // Get dimensions from sharp metadata
    const meta = await sharp(finalBuffer).metadata();
    const width = meta.width ?? (page.viewportSize()?.width ?? 1280);
    const height = meta.height ?? (page.viewportSize()?.height ?? 720);

    const result: ScreenshotResult = {
      path: screenshotPath,
      base64: finalBuffer.toString("base64"),
      width,
      height,
      size_bytes: compressedSizeBytes,
      original_size_bytes: originalSizeBytes,
      compressed_size_bytes: compressedSizeBytes,
      compression_ratio: compressionRatio,
      thumbnail_path: thumbnailPath,
      thumbnail_base64: thumbnailBase64,
      ...(fallback ? { fallback: true, compressed: false } : {}),
    };

    // Auto-track in gallery (can be disabled with opts.track = false)
    if (opts?.track !== false) {
      try {
        const url = await page.url().valueOf();
        let title: string | undefined;
        try { title = await page.title(); } catch {}

        const entry = createEntry({
          session_id: opts?.sessionId,
          project_id: opts?.projectId,
          url,
          title,
          path: screenshotPath,
          thumbnail_path: thumbnailPath,
          format: ext,
          width,
          height,
          original_size_bytes: originalSizeBytes,
          compressed_size_bytes: compressedSizeBytes,
          compression_ratio: compressionRatio,
          tags: [],
          is_favorite: false,
        });
        result.gallery_id = entry.id;
      } catch {
        // Non-fatal: gallery tracking failure doesn't break screenshot
      }
    }

    return result;
  } catch (err) {
    if (err instanceof BrowserError) throw err;
    throw new BrowserError(
      `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      "SCREENSHOT_FAILED"
    );
  }
}

// ─── generatePDF ──────────────────────────────────────────────────────────────

export async function generatePDF(
  page: Page,
  opts?: PDFOptions & { projectId?: string }
): Promise<PDFResult> {
  try {
    const base = join(getDataDir(), "pdfs");
    const date = new Date().toISOString().split("T")[0];
    const dir = opts?.projectId ? join(base, opts.projectId, date) : join(base, date);
    mkdirSync(dir, { recursive: true });

    const timestamp = Date.now();
    const pdfPath = opts?.path ?? join(dir, `${timestamp}.pdf`);

    const buffer = await page.pdf({
      path: pdfPath,
      format: opts?.format ?? "A4",
      landscape: opts?.landscape ?? false,
      margin: opts?.margin,
      printBackground: opts?.printBackground ?? true,
    });

    return {
      path: pdfPath,
      base64: Buffer.from(buffer).toString("base64"),
      size_bytes: buffer.length,
    };
  } catch (err) {
    throw new BrowserError(
      `PDF generation failed: ${err instanceof Error ? err.message : String(err)}`,
      "PDF_FAILED"
    );
  }
}
