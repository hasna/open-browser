import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "../db/schema.js";

let tmpDir: string;

function setupDb() {
  tmpDir = mkdtempSync(join(tmpdir(), "browser-cli-test-"));
  process.env["BROWSER_DB_PATH"] = join(tmpDir, "test.db");
  process.env["BROWSER_DATA_DIR"] = tmpDir;
  resetDatabase();
}

function teardownDb() {
  resetDatabase();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env["BROWSER_DB_PATH"];
  delete process.env["BROWSER_DATA_DIR"];
}

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "index.tsx"), ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BROWSER_DB_PATH: process.env["BROWSER_DB_PATH"],
        BROWSER_DATA_DIR: process.env["BROWSER_DATA_DIR"],
      },
    }
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("CLI — help flags", () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it("browser --help exits 0 and shows commands", async () => {
    const { stdout, code } = await runCli("--help");
    expect(code).toBe(0);
    expect(stdout).toContain("navigate");
    expect(stdout).toContain("session");
    expect(stdout).toContain("agent");
    expect(stdout).toContain("project");
  });

  it("browser session --help shows subcommands", async () => {
    const { stdout, code } = await runCli("session", "--help");
    expect(code).toBe(0);
    expect(stdout).toContain("create");
    expect(stdout).toContain("list");
    expect(stdout).toContain("close");
  });

  it("browser agent --help shows subcommands", async () => {
    const { stdout, code } = await runCli("agent", "--help");
    expect(code).toBe(0);
    expect(stdout).toContain("register");
    expect(stdout).toContain("list");
    expect(stdout).toContain("heartbeat");
  });

  it("browser project --help shows subcommands", async () => {
    const { stdout, code } = await runCli("project", "--help");
    expect(code).toBe(0);
    expect(stdout).toContain("create");
    expect(stdout).toContain("list");
  });

  it("browser record --help shows subcommands", async () => {
    const { stdout, code } = await runCli("record", "--help");
    expect(code).toBe(0);
    expect(stdout).toContain("start");
    expect(stdout).toContain("stop");
    expect(stdout).toContain("replay");
  });
});

describe("CLI — session commands (DB-only)", () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it("session list shows no sessions initially", async () => {
    const { stdout, code } = await runCli("session", "list");
    expect(code).toBe(0);
    expect(stdout).toContain("No sessions");
  });
});

describe("CLI — agent commands", () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it("agent register creates agent and shows JSON", async () => {
    const { stdout, code } = await runCli("agent", "register", "testbot", "--description", "my bot");
    expect(code).toBe(0);
    expect(stdout).toContain("testbot");
    expect(stdout).toContain("my bot");
  });

  it("agent list shows registered agent", async () => {
    await runCli("agent", "register", "myagent");
    const { stdout, code } = await runCli("agent", "list");
    expect(code).toBe(0);
    expect(stdout).toContain("myagent");
  });

  it("agent list shows empty when no agents", async () => {
    const { stdout, code } = await runCli("agent", "list");
    expect(code).toBe(0);
    expect(stdout).toContain("No agents");
  });
});

describe("CLI — project commands", () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it("project create creates project and shows JSON", async () => {
    const { stdout, code } = await runCli("project", "create", "myapp", "/tmp/myapp");
    expect(code).toBe(0);
    expect(stdout).toContain("myapp");
    expect(stdout).toContain("/tmp/myapp");
  });

  it("project list shows created project", async () => {
    await runCli("project", "create", "webapp", "/tmp/webapp");
    const { stdout, code } = await runCli("project", "list");
    expect(code).toBe(0);
    expect(stdout).toContain("webapp");
  });

  it("project list shows empty initially", async () => {
    const { stdout, code } = await runCli("project", "list");
    expect(code).toBe(0);
    expect(stdout).toContain("No projects");
  });
});

describe("CLI — record commands (DB-only)", () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it("record list shows empty initially", async () => {
    const { stdout, code } = await runCli("record", "list");
    expect(code).toBe(0);
    expect(stdout).toContain("No recordings");
  });
});

describe("CLI — version flag", () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it("--version shows current version from package.json", async () => {
    const { stdout, code } = await runCli("--version");
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
