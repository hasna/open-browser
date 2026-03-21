import type { Page } from "playwright";
import sharp from "sharp";
import { takeSnapshot, type RefInfo } from "./snapshot.js";

export interface Annotation {
  ref: string;
  label: number;
  x: number;
  y: number;
  width: number;
  height: number;
  role: string;
  name: string;
}

export interface AnnotatedScreenshotResult {
  buffer: Buffer;
  annotations: Annotation[];
  labelToRef: Record<number, string>;
}

export async function annotateScreenshot(
  page: Page,
  sessionId?: string
): Promise<AnnotatedScreenshotResult> {
  // 1. Take snapshot to get refs
  const snapshot = await takeSnapshot(page, sessionId);

  // 2. Take raw screenshot
  const rawBuffer = await page.screenshot({ type: "png" }) as Buffer;
  const meta = await sharp(rawBuffer).metadata();
  const imgWidth = meta.width ?? 1280;
  const imgHeight = meta.height ?? 720;

  // 3. Get bounding boxes for each ref
  const annotations: Annotation[] = [];
  const labelToRef: Record<number, string> = {};
  let labelCounter = 1;

  for (const [ref, info] of Object.entries(snapshot.refs)) {
    try {
      const locator = page.getByRole(info.role as any, { name: info.name }).first();
      const box = await locator.boundingBox();
      if (!box) continue;

      const annotation: Annotation = {
        ref,
        label: labelCounter,
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        role: info.role,
        name: info.name,
      };
      annotations.push(annotation);
      labelToRef[labelCounter] = ref;
      labelCounter++;
    } catch {
      // Element might not be in viewport or stale
    }
  }

  // 4. Create SVG overlay with numbered labels
  const circleR = 10;
  const fontSize = 12;
  const svgParts: string[] = [];

  for (const ann of annotations) {
    // Position: top-left corner of element
    const cx = Math.min(Math.max(ann.x + circleR, circleR), imgWidth - circleR);
    const cy = Math.min(Math.max(ann.y - circleR - 2, circleR), imgHeight - circleR);

    svgParts.push(`
      <circle cx="${cx}" cy="${cy}" r="${circleR}" fill="#e11d48" stroke="white" stroke-width="1.5"/>
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="white" font-size="${fontSize}" font-family="Arial,sans-serif" font-weight="bold">${ann.label}</text>
    `);

    // Light outline around the element
    svgParts.push(`
      <rect x="${ann.x}" y="${ann.y}" width="${ann.width}" height="${ann.height}" fill="none" stroke="#e11d48" stroke-width="1.5" stroke-opacity="0.6" rx="2"/>
    `);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgWidth}" height="${imgHeight}">${svgParts.join("")}</svg>`;

  // 5. Composite overlay onto screenshot
  const annotatedBuffer = await sharp(rawBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .webp({ quality: 85 })
    .toBuffer();

  return { buffer: annotatedBuffer, annotations, labelToRef };
}
