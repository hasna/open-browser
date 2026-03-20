import type { Page } from "playwright";
import type { PerformanceMetrics, CoverageResult } from "../types/index.js";
import { CDPClient } from "../engines/cdp.js";

export async function getPerformanceMetrics(page: Page): Promise<PerformanceMetrics> {
  const navTiming = await page.evaluate(() => {
    const t = performance.timing;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return {
      ttfb: nav ? nav.responseStart - nav.requestStart : t.responseStart - t.requestStart,
      domInteractive: nav ? nav.domInteractive : t.domInteractive - t.navigationStart,
      domComplete: nav ? nav.domComplete : t.domComplete - t.navigationStart,
      loadEvent: nav ? nav.loadEventEnd : t.loadEventEnd - t.navigationStart,
    };
  });

  const paintEntries = await page.evaluate(() => {
    const entries = performance.getEntriesByType("paint");
    const fcp = entries.find((e) => e.name === "first-contentful-paint");
    return { fcp: fcp?.startTime };
  });

  // CDP metrics for heap
  let heapMetrics: { js_heap_size_used?: number; js_heap_size_total?: number } = {};
  try {
    const cdp = await CDPClient.fromPage(page);
    const cdpMetrics = await cdp.getPerformanceMetrics();
    heapMetrics = {
      js_heap_size_used: cdpMetrics.js_heap_size_used,
      js_heap_size_total: cdpMetrics.js_heap_size_total,
    };
  } catch {
    // CDP may not be available in all engines
  }

  return {
    fcp: paintEntries.fcp,
    ttfb: navTiming.ttfb,
    dom_interactive: navTiming.domInteractive,
    dom_complete: navTiming.domComplete,
    load_event: navTiming.loadEvent,
    ...heapMetrics,
  };
}

export async function getMemoryUsage(page: Page): Promise<{ used: number; total: number } | null> {
  try {
    const cdp = await CDPClient.fromPage(page);
    const metrics = await cdp.getPerformanceMetrics();
    return {
      used: metrics.js_heap_size_used ?? 0,
      total: metrics.js_heap_size_total ?? 0,
    };
  } catch {
    return null;
  }
}

export async function getTimingEntries(page: Page): Promise<PerformanceEntry[]> {
  return page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => e.toJSON())
  ) as Promise<PerformanceEntry[]>;
}

export interface CoverageSession {
  stop: () => Promise<CoverageResult>;
}

export async function startCoverage(page: Page): Promise<CoverageSession> {
  const [jsCoverage, cssCoverage] = await Promise.all([
    page.coverage.startJSCoverage(),
    page.coverage.startCSSCoverage(),
  ]);

  return {
    stop: async (): Promise<CoverageResult> => {
      const [jsEntries, cssEntries] = await Promise.all([
        page.coverage.stopJSCoverage(),
        page.coverage.stopCSSCoverage(),
      ]);

      // JS coverage entries use functions[] with nested ranges (Playwright modern API)
      const jsFlat = jsEntries.map((e) => {
        const text = e.source ?? "";
        const ranges = e.functions.flatMap((f) =>
          f.ranges.filter((r) => r.count > 0).map((r) => ({ start: r.startOffset, end: r.endOffset }))
        );
        return { url: e.url, text, ranges };
      });
      const cssFlat = cssEntries.map((e) => ({
        url: e.url,
        text: e.text ?? "",
        ranges: e.ranges.map((r) => ({ start: r.start, end: r.end })),
      }));

      const totalJs = jsFlat.reduce((acc, e) => acc + e.text.length, 0);
      const usedJs = jsFlat.reduce((acc, e) => acc + e.ranges.reduce((s, r) => s + (r.end - r.start), 0), 0);
      const totalCss = cssFlat.reduce((acc, e) => acc + e.text.length, 0);
      const usedCss = cssFlat.reduce((acc, e) => acc + e.ranges.reduce((s, r) => s + (r.end - r.start), 0), 0);

      const totalBytes = totalJs + totalCss;
      const usedBytes = usedJs + usedCss;

      return {
        js: jsFlat,
        css: cssFlat,
        totalBytes,
        usedBytes,
        unusedPercent: totalBytes > 0 ? ((totalBytes - usedBytes) / totalBytes) * 100 : 0,
      };
    },
  };
}
