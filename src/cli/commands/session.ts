// ─── Session commands: create, list, close, save-state, list-states ──────────

import type { Command } from "commander";
import chalk from "chalk";
import { createSession, closeSession, listSessions, getSessionPage } from "../../lib/session.js";
import type { BrowserEngine } from "../../types/index.js";

export function register(program: Command) {

const sessionCmd = program.command("session").description("Manage browser sessions");

sessionCmd
  .command("create")
  .description("Create a new browser session")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--url <url>", "Start URL")
  .option("--headed", "Run in headed (visible) mode")
  .action(async (opts: { engine: string; url?: string; headed?: boolean }) => {
    const { session } = await createSession({ engine: opts.engine as BrowserEngine, startUrl: opts.url, headless: !opts.headed });
    console.log(chalk.green(`✓ Session created`));
    console.log(JSON.stringify(session, null, 2));
  });

sessionCmd
  .command("list")
  .description("List all sessions")
  .option("--status <status>", "Filter by status")
  .option("--json", "Output as JSON")
  .action((opts: { status?: string; json?: boolean }) => {
    const sessions = listSessions(opts.status ? { status: opts.status as "active" | "closed" | "error" } : undefined);
    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
    } else if (sessions.length === 0) {
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

sessionCmd
  .command("save-state <name>")
  .description("Save current session auth state for reuse")
  .requiredOption("--session <id>", "Session ID")
  .action(async (name: string, opts: { session: string }) => {
    const page = getSessionPage(opts.session);
    const { saveStateFromPage } = await import("../../lib/storage-state.js");
    const path = await saveStateFromPage(page, name);
    console.log(chalk.green(`✓ State saved: ${name}`));
    console.log(chalk.gray(`  Path: ${path}`));
  });

sessionCmd
  .command("list-states")
  .description("List saved auth states")
  .action(async () => {
    const { listStates } = await import("../../lib/storage-state.js");
    const states = listStates();
    if (states.length === 0) { console.log(chalk.gray("No saved states")); return; }
    states.forEach(s => console.log(`${s.name} ${chalk.gray(s.modified)}`));
  });

} // end register
