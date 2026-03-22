// ─── Script commands: run, list, import, show, delete ────────────────────────

import type { Command } from "commander";
import chalk from "chalk";
import { createSession, closeSession } from "../../lib/session.js";
import type { BrowserEngine } from "../../types/index.js";

export function register(program: Command) {

const scriptCmd = program.command("script").description("Manage automation scripts (browser + connector + AI)");

scriptCmd
  .command("run <name>")
  .description("Run a saved script (sync, shows progress live)")
  .option("--engine <engine>", "Browser engine", "auto")
  .option("--headed", "Run in headed (visible) mode")
  .option("--json", "Output as JSON")
  .option("--var <pairs...>", "Set variables (key=value)")
  .action(async (name: string, opts: { engine: string; headed?: boolean; json?: boolean; var?: string[] }) => {
    const { getScriptByName, getSteps, migrateJsonScripts } = await import("../../db/scripts.js");
    const { executeScriptSync } = await import("../../lib/script-engine.js");
    migrateJsonScripts();

    const script = getScriptByName(name);
    if (!script) { console.log(chalk.red(`Script '${name}' not found.`)); return; }

    const { session, page } = await createSession({ engine: opts.engine as BrowserEngine, headless: !opts.headed });
    const steps = getSteps(script.id);

    const overrides: Record<string, string> = {};
    if (opts.var) {
      for (const pair of opts.var) {
        const [k, ...v] = pair.split("=");
        if (k) overrides[k] = v.join("=");
      }
    }

    if (!opts.json) {
      console.log(chalk.gray(`Running: ${script.name} (${steps.length} steps)`));
      if (script.description) console.log(chalk.gray(`  ${script.description}\n`));
    }

    const result = await executeScriptSync(script.id, page, overrides);

    if (opts.json) {
      console.log(JSON.stringify({ ...result, session_id: session.id }));
    } else {
      if (result.success) {
        console.log(chalk.green(`\n✓ Completed (${result.steps_executed} steps, ${result.duration_ms}ms)`));
      } else {
        console.log(chalk.red(`\n✗ Failed (${result.steps_failed}/${result.steps_executed} failed)`));
        result.errors.forEach(e => console.log(chalk.red(`  ${e}`)));
      }
    }

    if (!opts.headed) await closeSession(session.id);
  });

scriptCmd
  .command("list")
  .description("List saved scripts")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { listScripts, migrateJsonScripts } = await import("../../db/scripts.js");
    migrateJsonScripts();
    const scripts = listScripts();
    if (opts.json) {
      console.log(JSON.stringify(scripts, null, 2));
    } else if (scripts.length === 0) {
      console.log(chalk.gray("No scripts. Import with: browser script import <file.json>"));
    } else {
      scripts.forEach(s => {
        console.log(`${chalk.bold(s.name)} ${chalk.gray(`(${s.domain})`)} — runs: ${s.run_count}`);
        if (s.description) console.log(chalk.gray(`  ${s.description}`));
      });
    }
  });

scriptCmd
  .command("import <file>")
  .description("Import a script from a JSON file into SQLite")
  .action(async (file: string) => {
    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync(file)) { console.log(chalk.red(`File not found: ${file}`)); return; }
    const raw = JSON.parse(readFileSync(file, "utf8"));

    const { upsertScript, getSteps } = await import("../../db/scripts.js");
    const steps = (raw.steps ?? []).map((s: any) => {
      const isAI = s.type === "ai";
      return {
        type: isAI ? "extract" : s.type,
        config: { action: s.action, selector: s.selector, url: s.url, value: s.value, text: s.text, timeout: s.timeout, connector: s.connector, args: s.args, seconds: s.seconds, check: s.check, equals: s.equals, contains: s.contains, skip_to: s.skip_to, name: s.name, save_as: s.save_as, pattern: s.pattern, ...(isAI ? { prompt: s.prompt, source: s.check ?? "last_output" } : {}) },
        description: s.description ?? "",
        ai_enabled: isAI || !!s.ai_enabled,
        ai_config: isAI ? { provider: "cerebras", model: s.model ?? "fast", prompt: s.prompt } : (s.ai_config ?? {}),
      };
    });

    const script = upsertScript({ name: raw.name, domain: raw.domain ?? "", description: raw.description ?? "", variables: raw.variables ?? {}, steps });
    const saved = getSteps(script.id);
    console.log(chalk.green(`✓ Imported: ${script.name} (${saved.length} steps)`));
  });

scriptCmd
  .command("show <name>")
  .description("Show script details")
  .action(async (name: string) => {
    const { getScriptByName, getSteps, migrateJsonScripts } = await import("../../db/scripts.js");
    migrateJsonScripts();
    const script = getScriptByName(name);
    if (!script) { console.log(chalk.red(`Script '${name}' not found`)); return; }
    const steps = getSteps(script.id);
    console.log(chalk.bold(`${script.name} (${script.domain})\n`));
    if (script.description) console.log(chalk.gray(`  ${script.description}\n`));
    console.log(chalk.gray(`  Variables: ${Object.keys(script.variables).join(", ")}`));
    console.log(chalk.gray(`  Runs: ${script.run_count}  Last: ${script.last_run ?? "never"}\n`));
    steps.forEach((s, i) => {
      const ai = s.ai_enabled ? chalk.yellow(" [AI]") : "";
      const detail = (s.config as any).url ?? (s.config as any).selector ?? (s.config as any).connector ?? (s.config as any).prompt?.slice(0, 40) ?? "";
      console.log(`  ${chalk.cyan(`${i + 1}.`)} [${s.type}]${ai} ${s.description} ${chalk.gray(String(detail).slice(0, 50))}`);
    });
  });

scriptCmd
  .command("delete <name>")
  .description("Delete a saved script")
  .action(async (name: string) => {
    const { deleteScriptByName } = await import("../../db/scripts.js");
    if (deleteScriptByName(name)) {
      console.log(chalk.green(`✓ Deleted: ${name}`));
    } else {
      console.log(chalk.red(`Script '${name}' not found`));
    }
  });

} // end register
