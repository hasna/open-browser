import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import sharp from "sharp";
import type { GalleryDiffResult } from "../types/index.js";

export async function diffImages(path1: string, path2: string): Promise<GalleryDiffResult> {
  const img1 = sharp(path1);
  const img2 = sharp(path2);

  const [meta1, meta2] = await Promise.all([img1.metadata(), img2.metadata()]);

  const w = Math.min(meta1.width ?? 1280, meta2.width ?? 1280);
  const h = Math.min(meta1.height ?? 720, meta2.height ?? 720);

  // Resize both to same size, get raw RGBA buffers
  const [raw1, raw2] = await Promise.all([
    sharp(path1).resize(w, h, { fit: "fill" }).raw().toBuffer(),
    sharp(path2).resize(w, h, { fit: "fill" }).raw().toBuffer(),
  ]);

  // Compute diff: per-pixel absolute difference, highlight changed pixels red
  const totalPixels = w * h;
  const channels = 3; // sharp raw without alpha uses 3 channels by default
  const diffBuffer = Buffer.alloc(raw1.length);
  let changedPixels = 0;

  for (let i = 0; i < raw1.length; i += channels) {
    const dr = Math.abs(raw1[i] - raw2[i]);
    const dg = Math.abs(raw1[i + 1] - raw2[i + 1]);
    const db = Math.abs(raw1[i + 2] - raw2[i + 2]);
    const diff = (dr + dg + db) / 3;

    if (diff > 10) {
      // Changed pixel — show as red
      changedPixels++;
      diffBuffer[i] = 255;
      diffBuffer[i + 1] = 0;
      diffBuffer[i + 2] = 0;
    } else {
      // Unchanged — show dimmed original
      diffBuffer[i] = Math.round(raw1[i] * 0.4);
      diffBuffer[i + 1] = Math.round(raw1[i + 1] * 0.4);
      diffBuffer[i + 2] = Math.round(raw1[i + 2] * 0.4);
    }
  }

  const dataDir = process.env["BROWSER_DATA_DIR"] ?? join(homedir(), ".browser");
  const diffDir = join(dataDir, "diffs");
  mkdirSync(diffDir, { recursive: true });
  const diffPath = join(diffDir, `diff-${Date.now()}.webp`);

  const diffImageBuffer = await sharp(diffBuffer, { raw: { width: w, height: h, channels } })
    .webp({ quality: 85 })
    .toBuffer();

  await Bun.write(diffPath, diffImageBuffer);

  return {
    diff_path: diffPath,
    diff_base64: diffImageBuffer.toString("base64"),
    changed_pixels: changedPixels,
    total_pixels: totalPixels,
    changed_percent: (changedPixels / totalPixels) * 100,
  };
}
