import type { Page } from "playwright";
import type { Recording, RecordingStep, ReplayResult } from "../types/index.js";
import { createRecording, getRecording, updateRecording, listRecordings } from "../db/recordings.js";
import { navigate, click, type as typeText, scroll } from "./actions.js";
import { BrowserError } from "../types/index.js";

interface ActiveRecording {
  id: string;
  steps: RecordingStep[];
  cleanup: () => void;
}

const activeRecordings = new Map<string, ActiveRecording>();

export function startRecording(sessionId: string, name: string, startUrl?: string): Recording {
  const steps: RecordingStep[] = [];

  const recording = createRecording({ name, start_url: startUrl, steps });

  // We attach listeners to the page in startPageRecording
  activeRecordings.set(recording.id, {
    id: recording.id,
    steps,
    cleanup: () => {},
  });

  return recording;
}

export function attachPageListeners(page: Page, recordingId: string): void {
  const active = activeRecordings.get(recordingId);
  if (!active) throw new BrowserError(`No active recording: ${recordingId}`, "RECORDING_NOT_ACTIVE");

  const onFrameNav = () => {
    active.steps.push({
      type: "navigate",
      url: page.url(),
      timestamp: Date.now(),
    });
  };

  page.on("framenavigated", onFrameNav);

  const cleanup = () => {
    page.off("framenavigated", onFrameNav);
  };

  active.cleanup = cleanup;
}

export function recordStep(recordingId: string, step: Omit<RecordingStep, "timestamp">): void {
  const active = activeRecordings.get(recordingId);
  if (!active) throw new BrowserError(`No active recording: ${recordingId}`, "RECORDING_NOT_ACTIVE");
  active.steps.push({ ...step, timestamp: Date.now() });
}

export function stopRecording(recordingId: string): Recording {
  const active = activeRecordings.get(recordingId);
  if (!active) throw new BrowserError(`No active recording: ${recordingId}`, "RECORDING_NOT_ACTIVE");

  active.cleanup();
  activeRecordings.delete(recordingId);

  return updateRecording(recordingId, { steps: active.steps });
}

export async function replayRecording(
  recordingId: string,
  page: Page
): Promise<ReplayResult> {
  const recording = getRecording(recordingId);
  const startTime = Date.now();
  let executed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const step of recording.steps) {
    try {
      switch (step.type) {
        case "navigate":
          if (step.url) await navigate(page, step.url);
          break;
        case "click":
          if (step.selector) await click(page, step.selector);
          break;
        case "type":
          if (step.selector && step.value) await typeText(page, step.selector, step.value);
          break;
        case "scroll":
          await scroll(page, "down");
          break;
        case "hover":
          if (step.selector) {
            const el = await page.$(step.selector);
            if (el) await el.hover();
          }
          break;
        case "evaluate":
          if (step.value) await page.evaluate(step.value);
          break;
        case "wait":
          if (step.selector) {
            await page.waitForSelector(step.selector, { timeout: 10000 }).catch(() => {});
          }
          break;
      }
      executed++;
    } catch (err) {
      failed++;
      errors.push(`Step ${step.type} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Small delay between steps
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    recording_id: recordingId,
    success: failed === 0,
    steps_executed: executed,
    steps_failed: failed,
    errors,
    duration_ms: Date.now() - startTime,
  };
}

export function exportRecording(recordingId: string, format: "json" | "playwright" | "puppeteer" = "json"): string {
  const recording = getRecording(recordingId);

  if (format === "json") {
    return JSON.stringify(recording, null, 2);
  }

  if (format === "playwright") {
    const lines: string[] = [
      `import { test, expect } from '@playwright/test';`,
      ``,
      `test('${recording.name}', async ({ page }) => {`,
    ];
    for (const step of recording.steps) {
      switch (step.type) {
        case "navigate":
          lines.push(`  await page.goto('${step.url}');`);
          break;
        case "click":
          lines.push(`  await page.click('${step.selector}');`);
          break;
        case "type":
          lines.push(`  await page.type('${step.selector}', '${step.value}');`);
          break;
        case "scroll":
          lines.push(`  await page.evaluate(() => window.scrollBy(0, 300));`);
          break;
        case "evaluate":
          lines.push(`  await page.evaluate(${step.value});`);
          break;
      }
    }
    lines.push(`});`);
    return lines.join("\n");
  }

  // puppeteer format
  const lines: string[] = [
    `const puppeteer = require('puppeteer');`,
    ``,
    `(async () => {`,
    `  const browser = await puppeteer.launch();`,
    `  const page = await browser.newPage();`,
  ];
  for (const step of recording.steps) {
    switch (step.type) {
      case "navigate": lines.push(`  await page.goto('${step.url}');`); break;
      case "click": lines.push(`  await page.click('${step.selector}');`); break;
      case "type": lines.push(`  await page.type('${step.selector}', '${step.value}');`); break;
    }
  }
  lines.push(`  await browser.close();`, `})();`);
  return lines.join("\n");
}

export { listRecordings, getRecording };
