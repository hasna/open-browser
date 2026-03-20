import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "../db/schema.js";
import { registerAgent, heartbeat, listAgents, getAgent, cleanStaleAgents, isAgentStale, getActiveAgents } from "./agents.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "browser-test-"));
  process.env["BROWSER_DB_PATH"] = join(tmpDir, "test.db");
  process.env["BROWSER_DATA_DIR"] = tmpDir;
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env["BROWSER_DB_PATH"];
  delete process.env["BROWSER_DATA_DIR"];
});

describe("lib/agents", () => {
  it("registerAgent creates an agent", () => {
    const a = registerAgent("maximus", { description: "test" });
    expect(a.name).toBe("maximus");
    expect(a.id).toBeTruthy();
  });

  it("registerAgent is idempotent", () => {
    const a1 = registerAgent("cassius");
    const a2 = registerAgent("cassius");
    expect(a1.id).toBe(a2.id);
  });

  it("heartbeat succeeds", () => {
    const a = registerAgent("brutus");
    expect(() => heartbeat(a.id)).not.toThrow();
  });

  it("listAgents returns all agents", () => {
    registerAgent("a1");
    registerAgent("a2");
    expect(listAgents().length).toBeGreaterThanOrEqual(2);
  });

  it("isAgentStale returns false for fresh agent", () => {
    const a = registerAgent("titus");
    expect(isAgentStale(a, 60000)).toBe(false);
  });

  it("isAgentStale returns true when threshold exceeded", () => {
    const a = registerAgent("nero");
    expect(isAgentStale(a, 0)).toBe(true);
  });

  it("getActiveAgents filters fresh agents", () => {
    registerAgent("julius");
    const active = getActiveAgents(60000);
    expect(active.some((a) => a.name === "julius")).toBe(true);
  });

  it("cleanStaleAgents removes agents", () => {
    registerAgent("cicero");
    const removed = cleanStaleAgents(-1000);
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});
