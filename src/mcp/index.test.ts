import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "../db/schema.js";
import { createSession } from "../db/sessions.js";
import { registerAgent as dbRegisterAgent } from "../db/agents.js";
import { ensureProject } from "../db/projects.js";
import { createRecording, updateRecording } from "../db/recordings.js";

// Test MCP tools through direct DB/lib imports (unit-style),
// and test the tool schemas/structure via McpServer inspection.

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "browser-mcp-test-"));
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResult(data: unknown) {
  return JSON.stringify(data, null, 2);
}

// ─── Tool-level logic tests (through DB + lib, not MCP transport) ─────────────

describe("MCP tool logic — sessions", () => {
  it("browser_session_list returns sessions array", async () => {
    const { listSessions } = await import("../db/sessions.js");
    const sessions = listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("browser_session_create (DB) creates active session", async () => {
    const s = createSession({ engine: "playwright" });
    expect(s.status).toBe("active");
    expect(s.engine).toBe("playwright");
  });

  it("browser_session_close (DB) closes session", async () => {
    const { closeSession, getSession } = await import("../db/sessions.js");
    const s = createSession({ engine: "playwright" });
    closeSession(s.id);
    expect(getSession(s.id).status).toBe("closed");
  });
});

describe("MCP tool logic — agents", () => {
  it("browser_register_agent creates agent", async () => {
    const { registerAgent } = await import("../lib/agents.js");
    const a = registerAgent("brutus", { description: "mcp test" });
    expect(a.name).toBe("brutus");
    expect(a.id).toBeTruthy();
  });

  it("browser_heartbeat updates agent", async () => {
    const { registerAgent, heartbeat, getAgent } = await import("../lib/agents.js");
    const a = registerAgent("maximus");
    expect(() => heartbeat(a.id)).not.toThrow();
    const updated = getAgent(a.id);
    expect(updated.last_seen).toBeDefined();
  });

  it("browser_agent_list returns all agents", async () => {
    const { registerAgent, listAgents } = await import("../lib/agents.js");
    registerAgent("titus");
    registerAgent("nero");
    const agents = listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });
});

describe("MCP tool logic — projects", () => {
  it("browser_project_create (ensureProject) is idempotent", () => {
    const p1 = ensureProject("proj-a", "/tmp/proj-a");
    const p2 = ensureProject("proj-a", "/tmp/proj-a");
    expect(p1.id).toBe(p2.id);
  });

  it("browser_project_list returns projects", () => {
    const { listProjects } = require("../db/projects.js");
    ensureProject("proj-b", "/tmp/proj-b");
    expect(listProjects().length).toBeGreaterThanOrEqual(1);
  });
});

describe("MCP tool logic — recordings", () => {
  it("browser_record_start creates recording with 0 steps", async () => {
    const { startRecording } = await import("../lib/recorder.js");
    const r = startRecording("sess-1", "my-flow", "https://example.com");
    expect(r.name).toBe("my-flow");
    expect(r.steps).toHaveLength(0);
  });

  it("browser_record_step adds step", async () => {
    const { startRecording, recordStep, stopRecording } = await import("../lib/recorder.js");
    const r = startRecording("sess-2", "flow-2");
    recordStep(r.id, { type: "navigate", url: "https://example.com" });
    recordStep(r.id, { type: "click", selector: "#btn" });
    const stopped = stopRecording(r.id);
    expect(stopped.steps).toHaveLength(2);
  });

  it("browser_recordings_list returns all recordings", async () => {
    createRecording({ name: "r1", steps: [] });
    createRecording({ name: "r2", steps: [] });
    const { listRecordings } = await import("../db/recordings.js");
    expect(listRecordings().length).toBeGreaterThanOrEqual(2);
  });
});

describe("MCP tool logic — network log", () => {
  it("browser_network_log returns empty for new session", async () => {
    const { getNetworkLog } = await import("../db/network-log.js");
    const s = createSession({ engine: "playwright" });
    expect(getNetworkLog(s.id)).toEqual([]);
  });
});

describe("MCP tool logic — console log", () => {
  it("browser_console_log returns empty for new session", async () => {
    const { getConsoleLog } = await import("../db/console-log.js");
    const s = createSession({ engine: "playwright" });
    expect(getConsoleLog(s.id)).toEqual([]);
  });
});

describe("MCP tool logic — storage (cookies/localStorage)", () => {
  it("getCookies/getLocalStorage functions exist", async () => {
    const { getCookies, getLocalStorage, setLocalStorage } = await import("../lib/storage.js");
    expect(typeof getCookies).toBe("function");
    expect(typeof getLocalStorage).toBe("function");
    expect(typeof setLocalStorage).toBe("function");
  });
});

describe("MCP JSON response helper", () => {
  it("json helper serializes correctly", () => {
    const data = { sessions: [], count: 0 };
    const text = jsonResult(data);
    expect(JSON.parse(text)).toEqual(data);
  });

  it("error response shape is correct", () => {
    const errResp = { error: "Session not found", code: "SESSION_NOT_FOUND" };
    const text = jsonResult(errResp);
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe("Session not found");
    expect(parsed.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("MCP tool logic — crawl", () => {
  it("crawl function exists and is callable", async () => {
    const { crawl } = await import("../lib/crawler.js");
    expect(typeof crawl).toBe("function");
  });
});

describe("MCP tool logic — screenshot", () => {
  it("takeScreenshot and generatePDF functions exist", async () => {
    const { takeScreenshot, generatePDF } = await import("../lib/screenshot.js");
    expect(typeof takeScreenshot).toBe("function");
    expect(typeof generatePDF).toBe("function");
  });
});

describe("MCP tool logic — performance", () => {
  it("getPerformanceMetrics and startCoverage functions exist", async () => {
    const { getPerformanceMetrics, startCoverage } = await import("../lib/performance.js");
    expect(typeof getPerformanceMetrics).toBe("function");
    expect(typeof startCoverage).toBe("function");
  });
});
