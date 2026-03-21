import type { Page, ElementHandle } from "playwright";
import type { ExtractOptions, ExtractResult, PageInfo } from "../types/index.js";
import { BrowserError } from "../types/index.js";

export async function getText(page: Page, selector?: string): Promise<string> {
  if (selector) {
    const el = await page.$(selector);
    if (!el) return "";
    return (await el.textContent()) ?? "";
  }
  return page.evaluate(() => document.body.innerText ?? "");
}

export async function getHTML(page: Page, selector?: string): Promise<string> {
  if (selector) {
    const el = await page.$(selector);
    if (!el) return "";
    return (await el.innerHTML()) ?? "";
  }
  return page.content();
}

export async function getLinks(page: Page, baseUrl?: string): Promise<string[]> {
  return page.evaluate((base) => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => {
        const href = (a as HTMLAnchorElement).href;
        if (!href) return null;
        if (href.startsWith("http")) return href;
        if (base && href.startsWith("/")) return new URL(href, base).href;
        return null;
      })
      .filter((h): h is string => h !== null);
  }, baseUrl ?? page.url());
}

export async function getTitle(page: Page): Promise<string> {
  return page.title();
}

export async function getUrl(page: Page): Promise<string> {
  return page.url();
}

export async function getMetaTags(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const meta: Record<string, string> = {};
    document.querySelectorAll("meta[name], meta[property]").forEach((el) => {
      const key = el.getAttribute("name") ?? el.getAttribute("property") ?? "";
      const value = el.getAttribute("content") ?? "";
      if (key) meta[key] = value;
    });
    return meta;
  });
}

export async function findElements(page: Page, selector: string): Promise<ElementHandle[]> {
  return page.$$(selector);
}

export async function extractStructured(
  page: Page,
  schema: Record<string, string>
): Promise<Record<string, string | string[]>> {
  const result: Record<string, string | string[]> = {};
  for (const [field, selector] of Object.entries(schema)) {
    const elements = await page.$$(selector);
    if (elements.length === 0) {
      result[field] = "";
    } else if (elements.length === 1) {
      result[field] = (await elements[0].textContent())?.trim() ?? "";
    } else {
      result[field] = await Promise.all(
        elements.map(async (el) => (await el.textContent())?.trim() ?? "")
      );
    }
  }
  return result;
}

export async function extractTable(page: Page, selector: string): Promise<string[][]> {
  return page.evaluate((sel) => {
    const table = document.querySelector(sel);
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll("tr"));
    return rows.map((row) =>
      Array.from(row.querySelectorAll("th, td")).map((cell) => cell.textContent?.trim() ?? "")
    );
  }, selector);
}

export async function getAriaSnapshot(page: Page): Promise<string> {
  try {
    // Use Playwright's built-in aria snapshot
    return await (page as Page & { ariaSnapshot?: () => Promise<string> }).ariaSnapshot?.() ??
      page.evaluate(() => {
        function walk(el: Element, indent = 0): string {
          const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
          const label = el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby") ?? el.textContent?.trim().slice(0, 50) ?? "";
          const line = "  ".repeat(indent) + `[${role}] ${label}`;
          const children = Array.from(el.children).map((c) => walk(c, indent + 1)).join("\n");
          return children ? `${line}\n${children}` : line;
        }
        return walk(document.body);
      });
  } catch {
    return page.evaluate(() => document.body.innerText?.slice(0, 2000) ?? "");
  }
}

export async function extract(page: Page, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const result: ExtractResult = {};
  const format = opts.format ?? "text";

  switch (format) {
    case "text":
      result.text = await getText(page, opts.selector);
      break;
    case "html":
      result.html = await getHTML(page, opts.selector);
      break;
    case "links":
      result.links = await getLinks(page);
      break;
    case "table":
      result.table = opts.selector ? await extractTable(page, opts.selector) : [];
      break;
    case "structured":
      if (opts.schema) result.structured = await extractStructured(page, opts.schema);
      break;
  }

  return result;
}

// ─── QoL: element existence check ────────────────────────────────────────────

export async function elementExists(
  page: Page,
  selector: string,
  opts?: { visible?: boolean }
): Promise<{ exists: boolean; visible: boolean; count: number }> {
  const elements = await page.$$(selector);
  if (elements.length === 0) return { exists: false, visible: false, count: 0 };

  let visible = false;
  try {
    visible = await elements[0].isVisible();
  } catch {
    visible = false;
  }

  return { exists: true, visible, count: elements.length };
}

// ─── QoL: one-shot page info ──────────────────────────────────────────────────

export async function getPageInfo(page: Page): Promise<PageInfo> {
  const url = page.url();
  const title = await page.title();

  const info = await page.evaluate(() => {
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute("content");
    const metaKw = document.querySelector('meta[name="keywords"]')?.getAttribute("content");
    return {
      meta_description: metaDesc ?? undefined,
      meta_keywords: metaKw ?? undefined,
      links_count: document.querySelectorAll("a[href]").length,
      images_count: document.querySelectorAll("img").length,
      forms_count: document.querySelectorAll("form").length,
      text_length: (document.body?.innerText ?? "").length,
    };
  });

  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };

  return {
    url,
    title,
    ...info,
    has_console_errors: false,
    viewport,
  };
}
