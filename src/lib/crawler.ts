import type { CrawlResult, CrawledPage, CrawlOptions } from "../types/index.js";
import { UseCase } from "../types/index.js";
import { selectEngine } from "../engines/selector.js";
import { launchPlaywright, getPage as getPlaywrightPage } from "../engines/playwright.js";
import { connectLightpanda } from "../engines/lightpanda.js";
import { createCrawlResult } from "../db/crawl-results.js";
import { getLinks } from "./extractor.js";

export async function crawl(startUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxDepth = opts.maxDepth ?? 2;
  const maxPages = opts.maxPages ?? 50;
  const sameDomain = opts.sameDomain ?? true;
  const engine = selectEngine(UseCase.EXTRACT_LINKS, opts.engine);

  const startDomain = new URL(startUrl).hostname;
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  const errors: string[] = [];

  // Launch browser
  let browser: Awaited<ReturnType<typeof launchPlaywright>>;
  if (engine === "lightpanda") {
    browser = await connectLightpanda();
  } else {
    browser = await launchPlaywright({ headless: true });
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  async function crawlPage(url: string, depth: number): Promise<void> {
    if (depth > maxDepth || pages.length >= maxPages || visited.has(url)) return;
    if (sameDomain && new URL(url).hostname !== startDomain) return;
    if (opts.filter && !opts.filter(url)) return;

    visited.add(url);

    const page = await context.newPage();
    const crawled: CrawledPage = { url, depth, links: [], error: undefined };

    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      crawled.title = await page.title();
      crawled.status_code = response?.status();
      crawled.links = await getLinks(page, url);
      pages.push(crawled);

      await page.close();

      // Recurse
      for (const link of crawled.links) {
        if (pages.length >= maxPages) break;
        await crawlPage(link, depth + 1);
      }
    } catch (err) {
      crawled.error = err instanceof Error ? err.message : String(err);
      errors.push(`${url}: ${crawled.error}`);
      pages.push(crawled);
      await page.close().catch(() => {});
    }
  }

  try {
    await crawlPage(startUrl, 0);
  } finally {
    await browser.close().catch(() => {});
  }

  const result = createCrawlResult({
    project_id: opts.projectId,
    start_url: startUrl,
    depth: maxDepth,
    pages,
    errors,
  });

  return result;
}
