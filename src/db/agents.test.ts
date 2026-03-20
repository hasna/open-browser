import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "./schema.js";
import { registerAgent, heartbeat, getAgent, listAgents, cleanStaleAgents, deleteAgent } from "./agents.js";

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

describe("agents CRUD", () => {
  it("registers an agent", () => {
    const a = registerAgent("brutus", { description: "test agent" });
    expect(a.name).toBe("brutus");
    expect(a.description).toBe("test agent");
    expect(a.id).toBeTruthy();
  });

  it("re-register is idempotent", () => {
    const a1 = registerAgent("maximus");
    const a2 = registerAgent("maximus");
    expect(a1.id).toBe(a2.id);
  });

  it("heartbeat updates last_seen", () => {
    const a = registerAgent("titus");
    heartbeat(a.id);
    const updated = getAgent(a.id);
    expect(updated.last_seen).toBeDefined();
  });

  it("lists agents", () => {
    registerAgent("cassius");
    registerAgent("julius");
    expect(listAgents().length).toBeGreaterThanOrEqual(2);
  });

  it("cleanStaleAgents removes old agents", () => {
    registerAgent("nero");
    // Use threshold of -1000 so cutoff = now + 1s (all agents appear stale)
    const removed = cleanStaleAgents(-1000);
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it("throws AgentNotFoundError on heartbeat for missing agent", () => {
    expect(() => heartbeat("nonexistent")).toThrow("Agent not found");
  });

  it("deletes an agent", () => {
    const a = registerAgent("seneca");
    deleteAgent(a.id);
    expect(() => getAgent(a.id)).toThrow("Agent not found");
  });
});
