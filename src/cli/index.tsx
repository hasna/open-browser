#!/usr/bin/env bun

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"));
import { createSession, closeSession, listSessions, getSessionPage } from "../lib/session.js";
import { navigate, click, type as typeText, scroll } from "../lib/actions.js";
import { getText, getLinks, extract } from "../lib/extractor.js";
import { takeScreenshot } from "../lib/screenshot.js";
import { crawl } from "../lib/crawler.js";
import { registerAgent, heartbeat, listAgents } from "../lib/agents.js";
import { ensureProject, listProjects } from "../db/projects.js";
import { startRecording, stopRecording, replayRecording } from "../lib/recorder.js";
import { listRecordings } from "../db/recordings.js";
import { isLightpandaAvailable } from "../engines/lightpanda.js";
import type { BrowserEngine } from "../types/index.js";

const program = new Command();

program
  .name("browser")
  .description("@hasna/browser — general-purpose browser agent CLI")
  .version(pkg.version);

// ─── navigate ─────────────────────────────────────────────────────────────────

program
  .command("navigate <url>")
  .description("Navigate to a URL and optionally take a screenshot")
  .option("--engine <engine>", "Browser engine: playwright|cdp|lightpanda|auto", "auto")
  .option("--screenshot", "Take a screenshot after navigation")
  .option("--extract", "Extract page text after navigation")
  .option("--headless", "Run in headless mode (default: true)", true)
  .action(async (url: string, opts: { engine: string; screenshot?: boolean; extract?: boolean }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: true });
    console.log(chalk.gray(`Session: ${session.id} (${session.engine})`));
    await navigate(page, url);
    const title = await page.title();
    console.log(chalk.green(`✓ Navigated to: ${url}`));
    console.log(chalk.blue(`  Title: ${title}`));
    if (opts.screenshot) {
      const result = await takeScreenshot(page);
      console.log(chalk.blue(`  Screenshot: ${result.path}`));
    }
    if (opts.extract) {
      const text = await getText(page);
      console.log(chalk.white(`\n${text.slice(0, 500)}...`));
    }
    await closeSession(session.id);
  });

// ─── screenshot ───────────────────────────────────────────────────────────────

program
  .command("screenshot <url>")
  .description("Navigate to a URL and take a screenshot")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--selector <selector>", "CSS selector for element screenshot")
  .option("--full-page", "Capture full page")
  .option("--format <format>", "Image format: png|jpeg|webp", "png")
  .action(async (url: string, opts: { engine: string; selector?: string; fullPage?: boolean; format: string }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: true });
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
  .action(async (url: string, opts: { engine: string; selector?: string; format: string }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: true });
    await navigate(page, url);
    const result = await extract(page, { format: opts.format as "text" | "links" | "html" | "table" | "structured", selector: opts.selector });
    if (opts.format === "links" && result.links) {
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
  .action(async (url: string, script: string, opts: { engine: string }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: true });
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

// ─── session ─────────────────────────────────────────────────────────────────

const sessionCmd = program.command("session").description("Manage browser sessions");

sessionCmd
  .command("create")
  .description("Create a new browser session")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--url <url>", "Start URL")
  .action(async (opts: { engine: string; url?: string }) => {
    const { session } = await createSession({ engine: opts.engine as BrowserEngine, startUrl: opts.url });
    console.log(chalk.green(`✓ Session created`));
    console.log(JSON.stringify(session, null, 2));
  });

sessionCmd
  .command("list")
  .description("List all sessions")
  .option("--status <status>", "Filter by status")
  .action((opts: { status?: string }) => {
    const sessions = listSessions(opts.status ? { status: opts.status as "active" | "closed" | "error" } : undefined);
    if (sessions.length === 0) {
      console.log(chalk.gray("No sessions found"));
    } else {
      sessions.forEach((s) => console.log(`${s.id} [${s.status}] ${s.engine} ${s.start_url ?? ""}`));
    }
  });

sessionCmd
  .command("close <id>")
  .description("Close a session")
  .action(async (id: string) => {
    await closeSession(id);
    console.log(chalk.green(`✓ Session closed: ${id}`));
  });

// ─── record ──────────────────────────────────────────────────────────────────

const recordCmd = program.command("record").description("Manage action recordings");

recordCmd
  .command("start <name>")
  .description("Start recording actions in a new session")
  .option("--url <url>", "Start URL")
  .option("--engine <engine>", "Browser engine", "auto")
  .action(async (name: string, opts: { url?: string; engine: string }) => {
    const { session } = await createSession({ engine: opts.engine as BrowserEngine, startUrl: opts.url });
    const recording = startRecording(session.id, name, opts.url);
    console.log(chalk.green(`✓ Recording started`));
    console.log(`  Recording ID: ${recording.id}`);
    console.log(`  Session ID: ${session.id}`);
  });

recordCmd
  .command("stop <recording_id>")
  .description("Stop an active recording")
  .action((id: string) => {
    const recording = stopRecording(id);
    console.log(chalk.green(`✓ Recording stopped: ${recording.name}`));
    console.log(`  Steps: ${recording.steps.length}`);
  });

recordCmd
  .command("replay <recording_id>")
  .description("Replay a recording in a new session")
  .option("--url <url>", "Override start URL")
  .option("--engine <engine>", "Browser engine", "auto")
  .action(async (id: string, opts: { url?: string; engine: string }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, startUrl: opts.url });
    const result = await replayRecording(id, page);
    console.log(result.success ? chalk.green("✓ Replay complete") : chalk.red("✗ Replay had errors"));
    console.log(`  Steps: ${result.steps_executed} executed, ${result.steps_failed} failed`);
    if (result.errors.length > 0) result.errors.forEach((e) => console.log(chalk.red(`  - ${e}`)));
    await closeSession(session.id);
  });

recordCmd
  .command("list")
  .description("List all recordings")
  .action(() => {
    const recordings = listRecordings();
    if (recordings.length === 0) {
      console.log(chalk.gray("No recordings found"));
    } else {
      recordings.forEach((r) => console.log(`${r.id} "${r.name}" (${r.steps.length} steps) ${r.created_at}`));
    }
  });

// ─── agent ───────────────────────────────────────────────────────────────────

const agentCmd = program.command("agent").description("Manage registered agents");

agentCmd
  .command("register <name>")
  .description("Register an agent")
  .option("--description <desc>", "Agent description")
  .option("--project <id>", "Project ID")
  .action((name: string, opts: { description?: string; project?: string }) => {
    const agent = registerAgent(name, { description: opts.description, projectId: opts.project });
    console.log(chalk.green(`✓ Agent registered: ${agent.name}`));
    console.log(JSON.stringify(agent, null, 2));
  });

agentCmd
  .command("list")
  .description("List all registered agents")
  .action(() => {
    const agents = listAgents();
    if (agents.length === 0) {
      console.log(chalk.gray("No agents found"));
    } else {
      agents.forEach((a) => console.log(`${a.id} "${a.name}" last_seen=${a.last_seen}`));
    }
  });

agentCmd
  .command("heartbeat <agent_id>")
  .description("Send a heartbeat for an agent")
  .action((id: string) => {
    heartbeat(id);
    console.log(chalk.green(`✓ Heartbeat sent: ${id}`));
  });

// ─── project ─────────────────────────────────────────────────────────────────

const projectCmd = program.command("project").description("Manage projects");

projectCmd
  .command("create <name> <path>")
  .description("Create a new project")
  .option("--description <desc>", "Description")
  .action((name: string, path: string, opts: { description?: string }) => {
    const project = ensureProject(name, path, opts.description);
    console.log(chalk.green(`✓ Project: ${project.name}`));
    console.log(JSON.stringify(project, null, 2));
  });

projectCmd
  .command("list")
  .description("List all projects")
  .action(() => {
    const projects = listProjects();
    if (projects.length === 0) {
      console.log(chalk.gray("No projects found"));
    } else {
      projects.forEach((p) => console.log(`${p.id} "${p.name}" ${p.path}`));
    }
  });

// ─── install-browser ──────────────────────────────────────────────────────────

program
  .command("install-browser")
  .description("Install a browser engine")
  .option("--engine <engine>", "Engine to install: lightpanda|chromium", "chromium")
  .action(async (opts: { engine: string }) => {
    if (opts.engine === "chromium") {
      const { execSync } = await import("node:child_process");
      console.log(chalk.gray("Installing Chromium via Playwright..."));
      execSync("bunx playwright install chromium", { stdio: "inherit" });
      console.log(chalk.green("✓ Chromium installed"));
    } else if (opts.engine === "lightpanda") {
      console.log(chalk.yellow("Lightpanda must be installed manually."));
      console.log("Visit: https://github.com/lightpanda-io/lightpanda/releases");
      console.log("Or set LIGHTPANDA_BINARY env var to point to the binary.");
      if (isLightpandaAvailable()) {
        console.log(chalk.green("✓ Lightpanda is already available"));
      }
    }
  });

// ─── mcp ─────────────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Start the MCP server (stdio)")
  .action(async () => {
    await import("../mcp/index.js");
  });

// ─── serve ────────────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the REST API server")
  .option("--port <port>", "Port to listen on", "7030")
  .action(async (opts: { port: string }) => {
    process.env["BROWSER_SERVER_PORT"] = opts.port;
    await import("../server/index.js");
  });

// ─── gallery ─────────────────────────────────────────────────────────────────

const galleryCmd = program.command("gallery").description("Manage screenshot gallery");

galleryCmd
  .command("list")
  .description("List gallery entries")
  .option("--project <id>", "Filter by project ID")
  .option("--tag <tag>", "Filter by tag")
  .option("--favorite", "Show only favorites")
  .option("--limit <n>", "Max entries", "20")
  .action(async (opts: { project?: string; tag?: string; favorite?: boolean; limit: string }) => {
    const { listEntries } = await import("../db/gallery.js");
    const entries = listEntries({ projectId: opts.project, tag: opts.tag, isFavorite: opts.favorite, limit: parseInt(opts.limit) });
    if (entries.length === 0) { console.log(chalk.gray("No gallery entries found")); return; }
    entries.forEach((e) => {
      const fav = e.is_favorite ? chalk.yellow("★") : " ";
      const tags = e.tags.length ? chalk.blue(` [${e.tags.join(",")}]`) : "";
      const size = e.compressed_size_bytes ? chalk.gray(` ${(e.compressed_size_bytes / 1024).toFixed(1)}KB`) : "";
      const ratio = e.compression_ratio != null ? chalk.green(` ${(e.compression_ratio * 100).toFixed(0)}%`) : "";
      console.log(`${fav} ${e.id.slice(0, 8)} ${chalk.cyan(e.format ?? "?")}${size}${ratio}${tags} ${chalk.gray(e.url?.slice(0, 60) ?? "")}`);
    });
    console.log(chalk.gray(`\n${entries.length} entries`));
  });

galleryCmd
  .command("get <id>")
  .description("Show gallery entry details")
  .action(async (id: string) => {
    const { getEntry } = await import("../db/gallery.js");
    const entry = getEntry(id);
    if (!entry) { console.log(chalk.red(`Not found: ${id}`)); return; }
    console.log(JSON.stringify(entry, null, 2));
  });

galleryCmd
  .command("tag <id> <tag>")
  .description("Add a tag to a gallery entry")
  .action(async (id: string, tag: string) => {
    const { tagEntry } = await import("../db/gallery.js");
    const entry = tagEntry(id, tag);
    console.log(chalk.green(`✓ Tagged: ${entry?.tags.join(", ")}`));
  });

galleryCmd
  .command("search <query>")
  .description("Search gallery by URL, title, notes, or tags")
  .option("--limit <n>", "Max results", "10")
  .action(async (query: string, opts: { limit: string }) => {
    const { searchEntries } = await import("../db/gallery.js");
    const results = searchEntries(query, parseInt(opts.limit));
    if (results.length === 0) { console.log(chalk.gray("No results")); return; }
    results.forEach((e) => console.log(`${e.id.slice(0, 8)} ${e.title ?? ""} ${chalk.gray(e.url ?? "")}`));
  });

galleryCmd
  .command("diff <id1> <id2>")
  .description("Pixel-diff two gallery screenshots")
  .option("--output <path>", "Save diff image to path")
  .action(async (id1: string, id2: string, opts: { output?: string }) => {
    const { getEntry } = await import("../db/gallery.js");
    const { diffImages } = await import("../lib/gallery-diff.js");
    const e1 = getEntry(id1);
    const e2 = getEntry(id2);
    if (!e1 || !e2) { console.log(chalk.red("One or both entries not found")); return; }
    const result = await diffImages(e1.path, e2.path);
    if (opts.output) {
      const { copyFileSync } = await import("node:fs");
      copyFileSync(result.diff_path, opts.output);
      console.log(chalk.green(`✓ Diff saved: ${opts.output}`));
    }
    console.log(chalk.blue(`Changed pixels: ${result.changed_pixels} / ${result.total_pixels} (${result.changed_percent.toFixed(2)}%)`));
  });

galleryCmd
  .command("stats")
  .description("Show gallery statistics")
  .option("--project <id>", "Filter by project")
  .action(async (opts: { project?: string }) => {
    const { getGalleryStats } = await import("../db/gallery.js");
    const stats = getGalleryStats(opts.project);
    console.log(chalk.bold("Gallery Stats:"));
    console.log(`  Total:     ${stats.total}`);
    console.log(`  Favorites: ${stats.favorites}`);
    console.log(`  Size:      ${(stats.total_size_bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Formats:   ${JSON.stringify(stats.by_format)}`);
  });

galleryCmd
  .command("clean")
  .description("Delete gallery entries with missing files")
  .action(async () => {
    const { listEntries, deleteEntry } = await import("../db/gallery.js");
    const { existsSync } = await import("node:fs");
    const entries = listEntries({ limit: 9999 });
    let removed = 0;
    for (const e of entries) {
      if (!existsSync(e.path)) { deleteEntry(e.id); removed++; }
    }
    console.log(chalk.green(`✓ Cleaned ${removed} orphaned entries`));
  });

// ─── downloads ────────────────────────────────────────────────────────────────

const downloadsCmd = program.command("downloads").description("Manage downloads folder");

downloadsCmd
  .command("list")
  .description("List downloaded files")
  .action(async () => {
    const { listDownloads } = await import("../lib/downloads.js");
    const files = listDownloads();
    if (files.length === 0) { console.log(chalk.gray("No downloads")); return; }
    files.forEach((f) => console.log(`${f.id.slice(0, 8)} ${chalk.cyan(f.type)} ${chalk.gray((f.size_bytes / 1024).toFixed(1) + "KB")} ${f.filename}`));
  });

downloadsCmd
  .command("clean")
  .description("Delete downloads older than N days")
  .option("--days <n>", "Age threshold in days", "7")
  .action(async (opts: { days: string }) => {
    const { cleanStaleDownloads } = await import("../lib/downloads.js");
    const count = cleanStaleDownloads(parseInt(opts.days));
    console.log(chalk.green(`✓ Deleted ${count} stale download(s)`));
  });

downloadsCmd
  .command("export <id> <target>")
  .description("Copy a download to a target path")
  .action(async (id: string, target: string) => {
    const { exportToPath } = await import("../lib/downloads.js");
    const path = exportToPath(id, target);
    console.log(chalk.green(`✓ Exported to: ${path}`));
  });

program.parseAsync(process.argv);
