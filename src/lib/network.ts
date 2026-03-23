import type { Page, Request, Response, Route } from "playwright";
import type { NetworkRequest, HAR, HAREntry, InterceptRule } from "../types/index.js";
import { logRequest } from "../db/network-log.js";
import { CDPClient } from "../engines/cdp.js";

// ─── Network Logging ──────────────────────────────────────────────────────────

export function enableNetworkLogging(page: Page, sessionId: string): () => void {
  const requestStart = new Map<string, number>();

  const onRequest = (req: Request) => {
    requestStart.set(req.url(), Date.now());
  };

  const onResponse = (res: Response) => {
    const start = requestStart.get(res.url()) ?? Date.now();
    requestStart.delete(res.url());
    const duration = Date.now() - start;
    const req = res.request();

    try {
      logRequest({
        session_id: sessionId,
        method: req.method(),
        url: res.url(),
        status_code: res.status(),
        request_headers: JSON.stringify(req.headers()),
        response_headers: JSON.stringify(res.headers()),
        body_size: (res.headers()["content-length"] != null ? parseInt(res.headers()["content-length"]) : undefined),
        duration_ms: duration,
        resource_type: req.resourceType(),
      });
    } catch {
      // Non-fatal
    }
  };

  const onRequestFailed = (req: Request) => {
    requestStart.delete(req.url());
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  return () => {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
    requestStart.clear();
  };
}

// ─── Intercept Rules ─────────────────────────────────────────────────────────

export async function addInterceptRule(page: Page, rule: InterceptRule): Promise<void> {
  await page.route(rule.pattern, async (route: Route) => {
    if (rule.action === "block") {
      await route.abort();
    } else if (rule.action === "modify" && rule.response) {
      await route.fulfill({
        status: rule.response.status,
        body: rule.response.body,
        headers: rule.response.headers,
      });
    } else {
      // log and continue
      await route.continue();
    }
  });
}

export async function clearInterceptRules(page: Page): Promise<void> {
  await page.unrouteAll();
}

// ─── HAR Capture ─────────────────────────────────────────────────────────────

export interface HARCapture {
  entries: HAREntry[];
  stop: () => HAR;
}

export function startHAR(page: Page): HARCapture {
  const entries: HAREntry[] = [];
  const requestStart = new Map<string, { time: number; method: string; headers: Record<string, string>; postData?: string }>();

  const onRequest = (req: Request) => {
    requestStart.set(req.url() + req.method(), {
      time: Date.now(),
      method: req.method(),
      headers: req.headers(),
      postData: req.postData() ?? undefined,
    });
  };

  const onResponse = async (res: Response) => {
    const key = res.url() + res.request().method();
    const start = requestStart.get(key);
    if (!start) return;
    requestStart.delete(key);
    const duration = Date.now() - start.time;

    const entry: HAREntry = {
      startedDateTime: new Date(start.time).toISOString(),
      time: duration,
      request: {
        method: start.method,
        url: res.url(),
        headers: Object.entries(start.headers).map(([name, value]) => ({ name, value })),
        postData: start.postData ? { text: start.postData } : undefined,
      },
      response: {
        status: res.status(),
        statusText: res.statusText(),
        headers: Object.entries(res.headers()).map(([name, value]) => ({ name, value })),
        content: {
          size: parseInt(res.headers()["content-length"] ?? "0") || 0,
          mimeType: res.headers()["content-type"] ?? "application/octet-stream",
        },
      },
      timings: { send: 0, wait: duration, receive: 0 },
    };

    entries.push(entry);
  };

  const onRequestFailed = (req: Request) => {
    requestStart.delete(req.url() + req.method());
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  return {
    entries,
    stop: (): HAR => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      requestStart.clear();
      return {
        log: {
          version: "1.2",
          creator: { name: "@hasna/browser", version: "0.0.1" },
          entries,
        },
      };
    },
  };
}
