// ─── Browse commands: navigate, check, audit, compare, screenshot, extract, eval, crawl ───

import type { Command } from "commander";
import chalk from "chalk";
import { createSession, closeSession } from "../../lib/session.js";
import { navigate } from "../../lib/actions.js";
import { getText, getLinks, extract } from "../../lib/extractor.js";
import { takeScreenshot } from "../../lib/screenshot.js";
import { crawl } from "../../lib/crawler.js";
import type { BrowserEngine } from "../../types/index.js";

export function register(program: Command) {

// ─── navigate ─────────────────────────────────────────────────────────────────

program
  .command("navigate <url>")
  .description("Navigate to a URL and optionally take a screenshot")
  .option("--engine <engine>", "Browser engine: playwright|cdp|lightpanda|auto", "auto")
  .option("--screenshot", "Take a screenshot after navigation")
  .option("--extract", "Extract page text after navigation")
  .option("--headed", "Run in headed (visible) mode")
  .option("--json", "Output as JSON")
  .action(async (url: string, opts: { engine: string; screenshot?: boolean; extract?: boolean; headed?: boolean; json?: boolean }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: !opts.headed });
    await navigate(page, url);
    const title = await page.title();
    let screenshotPath: string | undefined;
    if (opts.screenshot) {
      const result = await takeScreenshot(page);
      screenshotPath = result.path;
    }
    let text: string | undefined;
    if (opts.extract) {
      text = await getText(page);
    }
    if (opts.json) {
      const output: Record<string, unknown> = { session_id: session.id, engine: session.engine, url, title };
      if (screenshotPath) output.screenshot = screenshotPath;
      if (text) output.text = text.slice(0, 500);
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(chalk.gray(`Session: ${session.id} (${session.engine})`));
      console.log(chalk.green(`✓ Navigated to: ${url}`));
      console.log(chalk.blue(`  Title: ${title}`));
      if (screenshotPath) console.log(chalk.blue(`  Screenshot: ${screenshotPath}`));
      if (text) console.log(chalk.white(`\n${text.slice(0, 500)}...`));
    }
    await closeSession(session.id);
  });

// ─── check ───────────────────────────────────────────────────────────────────

program
  .command("check <url>")
  .description("One-liner page health check: navigate, screenshot, extract info, check errors")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--headed", "Run in headed (visible) mode")
  .option("--json", "Output as JSON")
  .action(async (url: string, opts: { engine: string; headed?: boolean; json?: boolean }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: !opts.headed });
    await navigate(page, url);
    const title = await page.title();
    const currentUrl = page.url();
    const text = await getText(page);
    const links = await getLinks(page);
    const result = await takeScreenshot(page);

    const summary = {
      url: currentUrl,
      title,
      text_length: text.length,
      links_count: links.length,
      screenshot: result.path,
      screenshot_size_kb: +(result.size_bytes / 1024).toFixed(1),
    };

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(chalk.green(`✓ ${title}`));
      console.log(chalk.blue(`  URL: ${currentUrl}`));
      console.log(chalk.gray(`  Text: ${text.length} chars, Links: ${links.length}`));
      console.log(chalk.gray(`  Screenshot: ${result.path} (${summary.screenshot_size_kb} KB)`));
    }
    await closeSession(session.id);
  });

// ─── audit ───────────────────────────────────────────────────────────────────

program
  .command("audit <url>")
  .description("Full site audit: env detection, performance, errors, APIs, data extraction, screenshot")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--headed", "Run in headed (visible) mode")
  .option("--json", "Output as JSON")
  .action(async (url: string, opts: { engine: string; headed?: boolean; json?: boolean }) => {
    const t0 = Date.now();
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: !opts.headed, captureNetwork: true, captureConsole: true });

    if (!opts.json) console.log(chalk.gray(`Auditing: ${url}\n`));

    await navigate(page, url);
    await new Promise(r => setTimeout(r, 2000)); // Let page settle

    const title = await page.title();
    const currentUrl = page.url();

    // Environment detection
    let env: any = {};
    try {
      const { detectEnvironment } = await import("../../lib/env-detector.js");
      env = await detectEnvironment(page);
    } catch {}

    // Deep performance
    let perf: any = {};
    try {
      const { getDeepPerformance } = await import("../../lib/deep-performance.js");
      perf = await getDeepPerformance(page);
    } catch {}

    // Console errors
    const { getConsoleLog } = await import("../../db/console-log.js");
    const errors = getConsoleLog(session.id, "error");

    // API detection
    let apis: any[] = [];
    try {
      const { detectAPIs } = await import("../../lib/api-detector.js");
      apis = detectAPIs(session.id);
    } catch {}

    // Structured data
    let structured: any = {};
    try {
      const { extractStructuredData } = await import("../../lib/structured-extract.js");
      structured = await extractStructuredData(page);
    } catch {}

    // Screenshot
    const screenshot = await takeScreenshot(page, { maxWidth: 1280, quality: 75 });

    const duration = Date.now() - t0;

    const report = {
      url: currentUrl,
      title,
      duration_ms: duration,
      environment: env,
      performance: {
        fcp_ms: perf.web_vitals?.fcp,
        ttfb_ms: perf.web_vitals?.ttfb,
        total_resources: perf.resources?.total_resources,
        total_transfer_kb: perf.resources ? +(perf.resources.total_transfer_bytes / 1024).toFixed(1) : 0,
        resource_breakdown: perf.resources?.by_type,
        third_party_count: perf.third_party?.length ?? 0,
        third_party: perf.third_party,
        dom_nodes: perf.dom?.node_count,
        dom_max_depth: perf.dom?.max_depth,
        memory_mb: perf.memory?.js_heap_used_mb,
      },
      errors: { count: errors.length, sample: errors.slice(0, 3).map((e: any) => e.message?.slice(0, 100)) },
      apis: { count: apis.length, endpoints: apis.map((a: any) => `${a.method} ${a.url}`) },
      data: {
        tables: structured.tables?.length ?? 0,
        lists: structured.lists?.length ?? 0,
        json_ld: structured.jsonLd?.length ?? 0,
        open_graph: Object.keys(structured.openGraph ?? {}).length,
        repeated_elements: structured.repeatedElements?.length ?? 0,
      },
      screenshot: screenshot.path,
    };

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(chalk.bold(`${title}`));
      console.log(chalk.blue(`  ${currentUrl}\n`));

      // Environment
      const envColor = env.env === "prod" ? chalk.green : env.env === "staging" ? chalk.yellow : chalk.cyan;
      console.log(`  Environment: ${envColor(env.env ?? "unknown")} (${env.confidence ?? "?"} confidence)`);

      // Performance
      console.log(`  Performance: FCP ${perf.web_vitals?.fcp ? perf.web_vitals.fcp + 'ms' : '?'}, TTFB ${perf.web_vitals?.ttfb ? Math.round(perf.web_vitals.ttfb) + 'ms' : '?'}`);
      console.log(`  Resources:   ${perf.resources?.total_resources ?? '?'} resources (${report.performance.total_transfer_kb} KB)`);
      console.log(`  Third-party: ${perf.third_party?.length ?? 0} scripts`);
      if (perf.third_party?.length > 0) {
        perf.third_party.slice(0, 5).forEach((tp: any) => {
          console.log(chalk.gray(`    ${tp.domain} (${tp.category}, ${(tp.total_bytes / 1024).toFixed(1)}KB)`));
        });
      }
      console.log(`  DOM:         ${perf.dom?.node_count ?? '?'} nodes, depth ${perf.dom?.max_depth ?? '?'}`);
      console.log(`  Memory:      ${perf.memory?.js_heap_used_mb ?? '?'} MB heap`);

      // Errors
      const errColor = errors.length > 0 ? chalk.red : chalk.green;
      console.log(`  Errors:      ${errColor(errors.length + ' console errors')}`);

      // APIs
      console.log(`  APIs:        ${apis.length} JSON endpoints detected`);
      apis.slice(0, 3).forEach((a: any) => console.log(chalk.gray(`    ${a.method} ${a.url}`)));

      // Data
      console.log(`  Data:        ${report.data.tables} tables, ${report.data.lists} lists, ${report.data.json_ld} JSON-LD, ${report.data.repeated_elements} repeated elements`);

      console.log(`\n  Screenshot:  ${screenshot.path}`);
      console.log(chalk.gray(`  Completed in ${duration}ms`));
    }

    await closeSession(session.id);
  });

// ─── compare ─────────────────────────────────────────────────────────────────

program
  .command("compare <url1> <url2>")
  .description("Compare two URLs: side-by-side screenshots + pixel diff + text diff")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--json", "Output as JSON")
  .action(async (url1: string, url2: string, opts: { engine: string; json?: boolean }) => {
    // Create two sessions
    const [s1, s2] = await Promise.all([
      createSession({ engine: opts.engine as BrowserEngine, headless: true }),
      createSession({ engine: opts.engine as BrowserEngine, headless: true }),
    ]);

    // Navigate both in parallel
    await Promise.all([
      navigate(s1.page, url1),
      navigate(s2.page, url2),
    ]);

    // Screenshot + text both in parallel
    const [ss1, ss2, text1, text2] = await Promise.all([
      takeScreenshot(s1.page, { format: "png" }),
      takeScreenshot(s2.page, { format: "png" }),
      getText(s1.page),
      getText(s2.page),
    ]);

    // Pixel diff
    const { diffImages } = await import("../../lib/gallery-diff.js");
    const diff = await diffImages(ss1.path, ss2.path);

    // Simple text diff stats
    const words1 = text1.split(/\s+/).filter(Boolean);
    const words2 = text2.split(/\s+/).filter(Boolean);
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    const common = words1.filter(w => set2.has(w)).length;
    const textSimilarity = words1.length > 0 ? Math.round((common / Math.max(words1.length, words2.length)) * 100) : 0;

    const result = {
      url1, url2,
      screenshot1: ss1.path,
      screenshot2: ss2.path,
      diff_image: diff.diff_path,
      pixel_change_percent: +diff.changed_percent.toFixed(2),
      text_similarity_percent: textSimilarity,
      text1_length: text1.length,
      text2_length: text2.length,
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(chalk.bold("URL Comparison:\n"));
      console.log(chalk.blue(`  1: ${url1}`));
      console.log(chalk.blue(`  2: ${url2}\n`));
      console.log(`  Pixel diff:     ${diff.changed_percent > 5 ? chalk.red(result.pixel_change_percent + '%') : chalk.green(result.pixel_change_percent + '%')} changed`);
      console.log(`  Text similarity: ${textSimilarity > 80 ? chalk.green(textSimilarity + '%') : chalk.yellow(textSimilarity + '%')}`);
      console.log(chalk.gray(`\n  Screenshot 1: ${ss1.path}`));
      console.log(chalk.gray(`  Screenshot 2: ${ss2.path}`));
      console.log(chalk.gray(`  Diff image:   ${diff.diff_path}`));
    }

    await Promise.all([closeSession(s1.session.id), closeSession(s2.session.id)]);
  });

// ─── screenshot ───────────────────────────────────────────────────────────────

program
  .command("screenshot <url>")
  .description("Navigate to a URL and take a screenshot")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--selector <selector>", "CSS selector for element screenshot")
  .option("--full-page", "Capture full page")
  .option("--format <format>", "Image format: png|jpeg|webp", "png")
  .option("--headed", "Run in headed (visible) mode")
  .action(async (url: string, opts: { engine: string; selector?: string; fullPage?: boolean; format: string; headed?: boolean }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: !opts.headed });
    await navigate(page, url);
    const result = await takeScreenshot(page, {
      selector: opts.selector,
      fullPage: opts.fullPage,
      format: opts.format as "png" | "jpeg" | "webp",
    });
    console.log(chalk.green(`✓ Screenshot saved: ${result.path}`));
    console.log(chalk.gray(`  Size: ${(result.size_bytes / 1024).toFixed(1)} KB`));
    await closeSession(session.id);
  });

// ─── extract ──────────────────────────────────────────────────────────────────

program
  .command("extract <url>")
  .description("Extract content from a URL")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--selector <selector>", "CSS selector")
  .option("--format <format>", "Format: text|html|links|table|structured", "text")
  .option("--headed", "Run in headed (visible) mode")
  .option("--json", "Output as JSON")
  .action(async (url: string, opts: { engine: string; selector?: string; format: string; headed?: boolean; json?: boolean }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: !opts.headed });
    await navigate(page, url);
    const result = await extract(page, { format: opts.format as "text" | "links" | "html" | "table" | "structured", selector: opts.selector });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (opts.format === "links" && result.links) {
      result.links.forEach((l) => console.log(l));
    } else if (opts.format === "table" && result.table) {
      result.table.forEach((row) => console.log(row.join("\t")));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    await closeSession(session.id);
  });

// ─── eval ─────────────────────────────────────────────────────────────────────

program
  .command("eval <url> <script>")
  .description("Run JavaScript in a page context")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--headed", "Run in headed (visible) mode")
  .action(async (url: string, script: string, opts: { engine: string; headed?: boolean }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: !opts.headed });
    await navigate(page, url);
    const result = await page.evaluate(script);
    console.log(JSON.stringify(result, null, 2));
    await closeSession(session.id);
  });

// ─── crawl ────────────────────────────────────────────────────────────────────

program
  .command("crawl <url>")
  .description("Crawl a URL recursively and list discovered pages")
  .option("--depth <n>", "Max crawl depth", "2")
  .option("--max-pages <n>", "Max pages to crawl", "50")
  .option("--engine <engine>", "Browser engine", "auto")
  .action(async (url: string, opts: { depth: string; maxPages: string; engine: string }) => {
    console.log(chalk.gray(`Crawling: ${url} (depth=${opts.depth}, max=${opts.maxPages})...`));
    const result = await crawl(url, {
      maxDepth: parseInt(opts.depth),
      maxPages: parseInt(opts.maxPages),
      engine: opts.engine as BrowserEngine,
    });
    console.log(chalk.green(`✓ Crawled ${result.pages.length} pages`));
    result.pages.forEach((p) => {
      const status = p.status_code ? chalk.cyan(`[${p.status_code}]`) : "";
      const error = p.error ? chalk.red(` ✗ ${p.error}`) : "";
      console.log(`  ${status} ${p.url}${error}`);
    });
    if (result.errors.length > 0) {
      console.log(chalk.red(`\n${result.errors.length} errors:`));
      result.errors.forEach((e) => console.log(chalk.red(`  - ${e}`)));
    }
  });

} // end register
