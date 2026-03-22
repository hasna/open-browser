// ─── Tool commands: record, agent, project, gallery, downloads, login, attach, watch, daemon, install-browser, mcp, serve ───

import type { Command } from "commander";
import chalk from "chalk";
import { createSession, closeSession, getSessionPage } from "../../lib/session.js";
import { navigate } from "../../lib/actions.js";
import { getText } from "../../lib/extractor.js";
import { takeScreenshot } from "../../lib/screenshot.js";
import { registerAgent, heartbeat, listAgents } from "../../lib/agents.js";
import { ensureProject, listProjects } from "../../db/projects.js";
import { startRecording, stopRecording, replayRecording } from "../../lib/recorder.js";
import { listRecordings } from "../../db/recordings.js";
import { isLightpandaAvailable } from "../../engines/lightpanda.js";
import type { BrowserEngine } from "../../types/index.js";

export function register(program: Command) {

// ─── record ──────────────────────────────────────────────────────────────────

const recordCmd = program.command("record").description("Manage action recordings");

recordCmd
  .command("start <name>")
  .description("Start recording actions in a new session")
  .option("--url <url>", "Start URL")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--headed", "Run in headed (visible) mode")
  .action(async (name: string, opts: { url?: string; engine: string; headed?: boolean }) => {
    const { session } = await createSession({ engine: opts.engine as BrowserEngine, startUrl: opts.url, headless: !opts.headed });
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
  .option("--headed", "Run in headed (visible) mode")
  .action(async (id: string, opts: { url?: string; engine: string; headed?: boolean }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, startUrl: opts.url, headless: !opts.headed });
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

// ─── attach (CDP connect) ─────────────────────────────────────────────────────

program
  .command("attach")
  .description("Attach to a running Chrome browser via CDP")
  .option("--port <port>", "Chrome debugging port", "9222")
  .option("--host <host>", "Chrome debugging host", "localhost")
  .option("--json", "Output as JSON")
  .action(async (opts: { port: string; host: string; json?: boolean }) => {
    const cdpUrl = `http://${opts.host}:${opts.port}`;
    const { session, page } = await createSession({ cdpUrl });
    const title = await page.title();
    const url = page.url();
    if (opts.json) {
      console.log(JSON.stringify({ session_id: session.id, url, title, cdp_url: cdpUrl }));
    } else {
      console.log(chalk.green(`✓ Attached to Chrome at ${cdpUrl}`));
      console.log(chalk.blue(`  Session: ${session.id}`));
      console.log(chalk.blue(`  Page: ${title} (${url})`));
    }
  });

// ─── login ──────────────────────────────────────────────────────────────────

program
  .command("login <url>")
  .description("Login to a site: detect form, fill credentials from secrets, save auth state")
  .option("--email <email>", "Email to login with")
  .option("--save-as <name>", "Name to save storage state as")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--headed", "Run in headed (visible) mode")
  .option("--json", "Output as JSON")
  .action(async (url: string, opts: { email?: string; saveAs?: string; engine: string; headed?: boolean; json?: boolean }) => {
    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: !opts.headed });
    await navigate(page, url);

    // Detect login form
    const formInfo = await page.evaluate(() => {
      const emailInput = document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="email"], input[autocomplete="username"]') as HTMLInputElement | null;
      const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement | null;
      const submitBtn = document.querySelector('button[type="submit"], input[type="submit"], button:has(span)') as HTMLElement | null;
      return {
        hasEmailInput: !!emailInput,
        hasPasswordInput: !!passwordInput,
        hasSubmitButton: !!submitBtn,
        emailSelector: emailInput ? (emailInput.id ? `#${emailInput.id}` : emailInput.name ? `input[name="${emailInput.name}"]` : 'input[type="email"]') : null,
        passwordSelector: passwordInput ? (passwordInput.id ? `#${passwordInput.id}` : 'input[type="password"]') : null,
        submitSelector: submitBtn ? (submitBtn.id ? `#${submitBtn.id}` : 'button[type="submit"]') : null,
        pageTitle: document.title,
      };
    });

    if (!opts.json) {
      console.log(chalk.gray(`Page: ${formInfo.pageTitle}`));
      console.log(chalk.gray(`  Email input: ${formInfo.hasEmailInput ? '✓' : '✗'}`));
      console.log(chalk.gray(`  Password input: ${formInfo.hasPasswordInput ? '✓' : '✗'}`));
      console.log(chalk.gray(`  Submit button: ${formInfo.hasSubmitButton ? '✓' : '✗'}`));
    }

    // Try to get credentials from secrets
    let email = opts.email;
    let password: string | undefined;

    if (!email) {
      try {
        const { getCredentials } = await import("../../lib/auth.js");
        const hostname = new URL(url).hostname;
        const creds = await getCredentials(hostname);
        if (creds) {
          email = creds.email ?? creds.username;
          password = creds.password;
          if (!opts.json) console.log(chalk.blue(`  Credentials found for ${hostname}`));
        }
      } catch {}
    }

    // Fill email if we have it and there's an input
    if (email && formInfo.emailSelector) {
      await page.fill(formInfo.emailSelector, email);
      if (!opts.json) console.log(chalk.green(`  ✓ Filled email: ${email}`));
    }

    // Fill password if we have it
    if (password && formInfo.passwordSelector) {
      await page.fill(formInfo.passwordSelector, password);
      if (!opts.json) console.log(chalk.green(`  ✓ Filled password`));
    }

    // Submit if we have a button
    if (formInfo.hasSubmitButton && formInfo.submitSelector) {
      await page.click(formInfo.submitSelector);
      if (!opts.json) console.log(chalk.green(`  ✓ Submitted form`));

      // Wait for navigation
      try {
        await page.waitForNavigation({ timeout: 10000 });
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }

    const finalUrl = page.url();
    const loggedIn = finalUrl !== url;

    // Save storage state
    let savedAs: string | undefined;
    if (opts.saveAs || loggedIn) {
      const name = opts.saveAs ?? new URL(url).hostname.replace(/\./g, "-");
      try {
        const { saveStateFromPage } = await import("../../lib/storage-state.js");
        await saveStateFromPage(page, name);
        savedAs = name;
        if (!opts.json) console.log(chalk.green(`  ✓ State saved as: ${name}`));
      } catch {}
    }

    if (opts.json) {
      console.log(JSON.stringify({ session_id: session.id, url: finalUrl, logged_in: loggedIn, form_detected: formInfo.hasEmailInput, saved_as: savedAs }));
    } else {
      console.log(loggedIn ? chalk.green(`\n✓ Login successful → ${finalUrl}`) : chalk.yellow(`\n⚠ May need manual steps (magic link, 2FA, etc)`));
    }

    if (!opts.headed) await closeSession(session.id);
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
    const { listEntries } = await import("../../db/gallery.js");
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
    const { getEntry } = await import("../../db/gallery.js");
    const entry = getEntry(id);
    if (!entry) { console.log(chalk.red(`Not found: ${id}`)); return; }
    console.log(JSON.stringify(entry, null, 2));
  });

galleryCmd
  .command("tag <id> <tag>")
  .description("Add a tag to a gallery entry")
  .action(async (id: string, tag: string) => {
    const { tagEntry } = await import("../../db/gallery.js");
    const entry = tagEntry(id, tag);
    console.log(chalk.green(`✓ Tagged: ${entry?.tags.join(", ")}`));
  });

galleryCmd
  .command("search <query>")
  .description("Search gallery by URL, title, notes, or tags")
  .option("--limit <n>", "Max results", "10")
  .action(async (query: string, opts: { limit: string }) => {
    const { searchEntries } = await import("../../db/gallery.js");
    const results = searchEntries(query, parseInt(opts.limit));
    if (results.length === 0) { console.log(chalk.gray("No results")); return; }
    results.forEach((e) => console.log(`${e.id.slice(0, 8)} ${e.title ?? ""} ${chalk.gray(e.url ?? "")}`));
  });

galleryCmd
  .command("diff <id1> <id2>")
  .description("Pixel-diff two gallery screenshots")
  .option("--output <path>", "Save diff image to path")
  .action(async (id1: string, id2: string, opts: { output?: string }) => {
    const { getEntry } = await import("../../db/gallery.js");
    const { diffImages } = await import("../../lib/gallery-diff.js");
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
    const { getGalleryStats } = await import("../../db/gallery.js");
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
    const { listEntries, deleteEntry } = await import("../../db/gallery.js");
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
    const { listDownloads } = await import("../../lib/downloads.js");
    const files = listDownloads();
    if (files.length === 0) { console.log(chalk.gray("No downloads")); return; }
    files.forEach((f) => console.log(`${f.id.slice(0, 8)} ${chalk.cyan(f.type)} ${chalk.gray((f.size_bytes / 1024).toFixed(1) + "KB")} ${f.filename}`));
  });

downloadsCmd
  .command("clean")
  .description("Delete downloads older than N days")
  .option("--days <n>", "Age threshold in days", "7")
  .action(async (opts: { days: string }) => {
    const { cleanStaleDownloads } = await import("../../lib/downloads.js");
    const count = cleanStaleDownloads(parseInt(opts.days));
    console.log(chalk.green(`✓ Deleted ${count} stale download(s)`));
  });

downloadsCmd
  .command("export <id> <target>")
  .description("Copy a download to a target path")
  .action(async (id: string, target: string) => {
    const { exportToPath } = await import("../../lib/downloads.js");
    const path = exportToPath(id, target);
    console.log(chalk.green(`✓ Exported to: ${path}`));
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

// ─── daemon ─────────────────────────────────────────────────────────────────

const daemonCmd = program.command("daemon").description("Manage the browser daemon (persistent background sessions)");

daemonCmd
  .command("start")
  .description("Start the browser daemon in the background")
  .option("--port <port>", "Port to listen on", "7030")
  .action(async (opts: { port: string }) => {
    const { isDaemonRunning, getDaemonPidFile, getDaemonStatus } = await import("../../lib/daemon-client.js");
    if (isDaemonRunning()) {
      console.log(chalk.yellow("Daemon is already running."));
      const status = await getDaemonStatus();
      console.log(chalk.gray(`  PID: ${status.pid}, Port: ${status.port}, Sessions: ${status.sessions ?? "?"}`));
      return;
    }

    const { spawn } = await import("node:child_process");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");

    const pidFile = getDaemonPidFile();
    mkdirSync(dirname(pidFile), { recursive: true });

    // Spawn the REST server as a detached background process
    const child = spawn(process.execPath, [import.meta.dir + "/../../server/index.js"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, BROWSER_SERVER_PORT: opts.port },
    });
    child.unref();

    if (child.pid) {
      writeFileSync(pidFile, String(child.pid));
      // Wait a moment for server to start
      await new Promise(r => setTimeout(r, 1500));
      console.log(chalk.green(`✓ Daemon started`));
      console.log(chalk.gray(`  PID: ${child.pid}, Port: ${opts.port}`));
      console.log(chalk.gray(`  Sessions will persist across CLI invocations.`));
      console.log(chalk.gray(`  Stop with: browser daemon stop`));
    } else {
      console.log(chalk.red("Failed to start daemon"));
    }
  });

daemonCmd
  .command("stop")
  .description("Stop the browser daemon")
  .action(async () => {
    const { isDaemonRunning, getDaemonPid, getDaemonPidFile } = await import("../../lib/daemon-client.js");
    const { unlinkSync } = await import("node:fs");

    if (!isDaemonRunning()) {
      console.log(chalk.gray("Daemon is not running."));
      return;
    }

    const pid = getDaemonPid();
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      try { unlinkSync(getDaemonPidFile()); } catch {}
      console.log(chalk.green(`✓ Daemon stopped (PID: ${pid})`));
    }
  });

daemonCmd
  .command("status")
  .description("Check daemon status")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { getDaemonStatus } = await import("../../lib/daemon-client.js");
    const status = await getDaemonStatus();

    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
    } else if (status.running) {
      console.log(chalk.green("● Daemon running"));
      console.log(chalk.gray(`  PID: ${status.pid}`));
      console.log(chalk.gray(`  Port: ${status.port}`));
      if (status.sessions != null) console.log(chalk.gray(`  Active sessions: ${status.sessions}`));
      if (status.uptime_ms != null) console.log(chalk.gray(`  Uptime: ${Math.round(status.uptime_ms / 1000)}s`));
    } else {
      console.log(chalk.gray("○ Daemon not running"));
      console.log(chalk.gray(`  Start with: browser daemon start`));
    }
  });

// ─── watch ───────────────────────────────────────────────────────────────────

program
  .command("watch <url>")
  .description("Monitor a URL for changes — periodic screenshot + diff")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--interval <seconds>", "Check interval in seconds", "30")
  .option("--threshold <percent>", "Change threshold percent to report", "5")
  .option("--headed", "Run in headed mode")
  .option("--json", "Output as JSON")
  .action(async (url: string, opts: { engine: string; interval: string; threshold: string; headed?: boolean; json?: boolean }) => {
    const intervalMs = parseInt(opts.interval) * 1000;
    const threshold = parseFloat(opts.threshold);

    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: !opts.headed });
    console.log(chalk.gray(`Watching: ${url} (every ${opts.interval}s, threshold ${opts.threshold}%)`));
    console.log(chalk.gray(`Session: ${session.id} — Press Ctrl+C to stop\n`));

    await navigate(page, url);
    let baselineResult = await takeScreenshot(page, { format: "png" });
    let baselinePath = baselineResult.path;
    let checkCount = 0;

    if (!opts.json) console.log(chalk.blue(`[${new Date().toISOString()}] Baseline captured: ${baselinePath}`));

    const check = async () => {
      checkCount++;
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 2000)); // Wait for render
        const newResult = await takeScreenshot(page, { format: "png" });

        // Diff
        const { diffImages } = await import("../../lib/gallery-diff.js");
        const diff = await diffImages(baselinePath, newResult.path);

        const changed = diff.changed_percent > threshold;
        const timestamp = new Date().toISOString();

        if (opts.json) {
          console.log(JSON.stringify({ timestamp, check: checkCount, changed_percent: diff.changed_percent, changed, screenshot: newResult.path, diff_path: changed ? diff.diff_path : undefined }));
        } else if (changed) {
          console.log(chalk.red(`[${timestamp}] CHANGED: ${diff.changed_percent.toFixed(2)}% (${diff.changed_pixels} pixels)`));
          console.log(chalk.gray(`  Screenshot: ${newResult.path}`));
          console.log(chalk.gray(`  Diff: ${diff.diff_path}`));
          // Update baseline
          baselinePath = newResult.path;
        } else {
          console.log(chalk.green(`[${timestamp}] No change (${diff.changed_percent.toFixed(2)}%)`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ timestamp: new Date().toISOString(), check: checkCount, error: msg }));
        } else {
          console.log(chalk.red(`[${new Date().toISOString()}] Error: ${msg}`));
        }
      }
    };

    const timer = setInterval(check, intervalMs);

    // Handle Ctrl+C gracefully
    process.on("SIGINT", async () => {
      clearInterval(timer);
      console.log(chalk.gray(`\nStopping watch. ${checkCount} checks performed.`));
      await closeSession(session.id);
      process.exit(0);
    });
  });

// ─── mcp ─────────────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Start the MCP server (stdio)")
  .action(async () => {
    await import("../../mcp/index.js");
  });

// ─── serve ────────────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the REST API server")
  .option("--port <port>", "Port to listen on", "7030")
  .action(async (opts: { port: string }) => {
    process.env["BROWSER_SERVER_PORT"] = opts.port;
    await import("../../server/index.js");
  });

} // end register
