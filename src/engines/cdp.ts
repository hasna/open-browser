import type { Page, CDPSession } from "playwright";
import type { PerformanceMetrics, CoverageEntry, CoverageResult } from "../types/index.js";
import { BrowserError } from "../types/index.js";

// ─── CDP Session Wrapper ──────────────────────────────────────────────────────

export class CDPClient {
  private session: CDPSession;
  private networkEnabled = false;
  private performanceEnabled = false;

  constructor(session: CDPSession) {
    this.session = session;
  }

  static async fromPage(page: Page): Promise<CDPClient> {
    try {
      const session = await page.context().newCDPSession(page);
      return new CDPClient(session);
    } catch (err) {
      throw new BrowserError(
        `Failed to create CDP session: ${err instanceof Error ? err.message : String(err)}`,
        "CDP_SESSION_FAILED"
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    try {
      return await this.session.send(method as Parameters<CDPSession["send"]>[0], params) as T;
    } catch (err) {
      throw new BrowserError(
        `CDP command '${method}' failed: ${err instanceof Error ? err.message : String(err)}`,
        "CDP_COMMAND_FAILED"
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (data: any) => void): void {
    this.session.on(event as Parameters<CDPSession["on"]>[0], handler);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (data: any) => void): void {
    this.session.off(event as Parameters<CDPSession["off"]>[0], handler);
  }

  async enableNetwork(): Promise<void> {
    if (!this.networkEnabled) {
      await this.send("Network.enable");
      this.networkEnabled = true;
    }
  }

  async enablePerformance(): Promise<void> {
    if (!this.performanceEnabled) {
      await this.send("Performance.enable");
      this.performanceEnabled = true;
    }
  }

  async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    await this.enablePerformance();
    const result = await this.send<{ metrics: Array<{ name: string; value: number }> }>(
      "Performance.getMetrics"
    );
    const m: Record<string, number> = {};
    for (const metric of result.metrics) {
      m[metric.name] = metric.value;
    }
    return {
      js_heap_size_used: m["JSHeapUsedSize"],
      js_heap_size_total: m["JSHeapTotalSize"],
      dom_interactive: m["DOMInteractive"],
      dom_complete: m["DOMComplete"],
      load_event: m["LoadEventEnd"],
    };
  }

  async startJSCoverage(): Promise<void> {
    await this.send("Profiler.enable");
    await this.send("Debugger.enable");
    await this.send("Profiler.startPreciseCoverage", {
      callCount: false,
      detailed: true,
    });
  }

  async stopJSCoverage(): Promise<CoverageEntry[]> {
    const result = await this.send<{
      result: Array<{
        scriptId: string;
        url: string;
        functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
      }>;
    }>("Profiler.takePreciseCoverage");
    await this.send("Profiler.stopPreciseCoverage");

    return result.result
      .filter((r) => r.url && !r.url.startsWith("v8-snapshot://"))
      .map((r) => ({
        url: r.url,
        text: "",
        ranges: r.functions.flatMap((f) =>
          f.ranges
            .filter((rng) => rng.count > 0)
            .map((rng) => ({ start: rng.startOffset, end: rng.endOffset }))
        ),
      }));
  }

  async getCoverage(): Promise<CoverageResult> {
    await this.startJSCoverage();
    // Caller should do work here, then call stopCoverage
    const js = await this.stopJSCoverage();
    const totalBytes = js.reduce(
      (acc, e) => acc + e.ranges.reduce((sum, r) => sum + (r.end - r.start), 0),
      0
    );
    return { js, css: [], totalBytes, usedBytes: totalBytes, unusedPercent: 0 };
  }

  async captureHAREntries(
    page: Page,
    handler: (entry: { method: string; url: string; status: number; duration: number }) => void
  ): Promise<() => void> {
    await this.enableNetwork();
    const requestTimings: Map<string, number> = new Map();

    const onRequest = (params: { requestId: string; timestamp: number }) => {
      requestTimings.set(params.requestId, params.timestamp);
    };

    const onResponse = (params: {
      requestId: string;
      response: { url: string; status: number };
      timestamp: number;
    }) => {
      const start = requestTimings.get(params.requestId);
      const duration = start != null ? (params.timestamp - start) * 1000 : 0;
      handler({
        method: "GET",
        url: params.response.url,
        status: params.response.status,
        duration,
      });
    };

    this.on("Network.requestWillBeSent", onRequest);
    this.on("Network.responseReceived", onResponse);

    return () => {
      this.off("Network.requestWillBeSent", onRequest);
      this.off("Network.responseReceived", onResponse);
    };
  }

  async detach(): Promise<void> {
    try {
      await this.session.detach();
    } catch {
      // Ignore
    }
  }
}
