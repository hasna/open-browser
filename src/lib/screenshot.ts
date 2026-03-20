import type { Page } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { ScreenshotOptions, ScreenshotResult } from "../types/index.js";
import { BrowserError } from "../types/index.js";

const DATA_DIR = process.env["BROWSER_DATA_DIR"] ?? join(homedir(), ".browser");

function getScreenshotDir(projectId?: string): string {
  const base = join(DATA_DIR, "screenshots");
  const date = new Date().toISOString().split("T")[0];
  const dir = projectId ? join(base, projectId, date) : join(base, date);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function takeScreenshot(
  page: Page,
  opts?: ScreenshotOptions & { projectId?: string }
): Promise<ScreenshotResult> {
  try {
    const dir = getScreenshotDir(opts?.projectId);
    const timestamp = Date.now();
    const format = opts?.format ?? "png";
    const screenshotPath = opts?.path ?? join(dir, `${timestamp}.${format}`);

    const screenshotOpts: Parameters<Page["screenshot"]>[0] = {
      path: screenshotPath,
      fullPage: opts?.fullPage ?? false,
      type: format === "webp" ? "jpeg" : format,
      quality: format === "jpeg" || format === "webp" ? (opts?.quality ?? 90) : undefined,
    };

    let buffer: Buffer;
    if (opts?.selector) {
      const el = await page.$(opts.selector);
      if (!el) throw new BrowserError(`Element not found: ${opts.selector}`, "ELEMENT_NOT_FOUND");
      buffer = await el.screenshot({ ...screenshotOpts });
    } else {
      buffer = await page.screenshot(screenshotOpts);
    }

    const viewportSize = page.viewportSize() ?? { width: 1280, height: 720 };

    return {
      path: screenshotPath,
      base64: buffer.toString("base64"),
      width: viewportSize.width,
      height: viewportSize.height,
      size_bytes: buffer.length,
    };
  } catch (err) {
    if (err instanceof BrowserError) throw err;
    throw new BrowserError(
      `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      "SCREENSHOT_FAILED"
    );
  }
}

export async function generatePDF(page: Page, opts?: import("../types/index.js").PDFOptions & { projectId?: string }): Promise<import("../types/index.js").PDFResult> {
  try {
    const base = join(DATA_DIR, "pdfs");
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
      base64: buffer.toString("base64"),
      size_bytes: buffer.length,
    };
  } catch (err) {
    throw new BrowserError(
      `PDF generation failed: ${err instanceof Error ? err.message : String(err)}`,
      "PDF_FAILED"
    );
  }
}
