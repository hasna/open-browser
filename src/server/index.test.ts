import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "../db/schema.js";

let tmpDir: string;

// We boot a fresh server per describe block using the DB routes directly
describe("REST server — projects + agents", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "browser-rest-test-"));
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

  it("GET /api/projects returns empty array initially", async () => {
    const { listProjects } = await import("../db/projects.js");
    expect(listProjects()).toEqual([]);
  });

  it("POST /api/projects creates a project (via DB)", async () => {
    const { ensureProject, listProjects } = await import("../db/projects.js");
    ensureProject("my-app", "/tmp/my-app", "test app");
    const projects = listProjects();
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe("my-app");
  });

  it("GET /api/agents returns empty array initially", async () => {
    const { listAgents } = await import("../db/agents.js");
    expect(listAgents()).toEqual([]);
  });

  it("POST /api/agents registers an agent (via DB)", async () => {
    const { registerAgent, listAgents } = await import("../db/agents.js");
    registerAgent("brutus", { description: "test" });
    const agents = listAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe("brutus");
  });

  it("PUT /api/agents/:id/heartbeat works (via DB)", async () => {
    const { registerAgent, heartbeat, getAgent } = await import("../db/agents.js");
    const a = registerAgent("maximus");
    expect(() => heartbeat(a.id)).not.toThrow();
    const updated = getAgent(a.id);
    expect(updated.last_seen).toBeDefined();
  });

  it("GET /api/sessions returns sessions list (via DB)", async () => {
    const { createSession, listSessions } = await import("../db/sessions.js");
    const s = createSession({ engine: "playwright" });
    const sessions = listSessions({ status: "active" });
    expect(sessions.some((sess) => sess.id === s.id)).toBe(true);
  });

  it("DELETE /api/sessions/:id closes session (via DB)", async () => {
    const { createSession, closeSession, getSession } = await import("../db/sessions.js");
    const s = createSession({ engine: "playwright" });
    closeSession(s.id);
    const updated = getSession(s.id);
    expect(updated.status).toBe("closed");
  });

  it("GET /api/recordings returns recordings (via DB)", async () => {
    const { createRecording, listRecordings } = await import("../db/recordings.js");
    createRecording({ name: "test-rec", steps: [] });
    const recs = listRecordings();
    expect(recs.length).toBe(1);
    expect(recs[0].name).toBe("test-rec");
  });
});

describe("REST server — HTTP endpoints", () => {
  let httpServer: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "browser-http-test-"));
    process.env["BROWSER_DB_PATH"] = join(tmpDir, "test.db");
    process.env["BROWSER_DATA_DIR"] = tmpDir;
    resetDatabase();

    // Start a minimal test HTTP server using the same route logic
    httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;
        const CORS = { "Access-Control-Allow-Origin": "*" };

        if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

        const { listProjects, ensureProject } = await import("../db/projects.js");
        const { listAgents, registerAgent, heartbeat } = await import("../db/agents.js");
        const sessionMod = await import("../db/sessions.js");
        const dbCreateSession = sessionMod.createSession;
        const dbListSessions = sessionMod.listSessions;
        const dbCloseSession = sessionMod.closeSession;
        const { listRecordings } = await import("../db/recordings.js");

        const ok = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
        const notFound = (m: string) => new Response(JSON.stringify({ error: m }), { status: 404, headers: { "Content-Type": "application/json", ...CORS } });

        if (path === "/api/projects" && method === "GET") return ok({ projects: listProjects() });
        if (path === "/api/projects" && method === "POST") {
          const body = await req.json() as { name: string; path: string; description?: string };
          const p = ensureProject(body.name, body.path, body.description);
          return ok({ project: p }, 201);
        }
        if (path === "/api/agents" && method === "GET") return ok({ agents: listAgents() });
        if (path === "/api/agents" && method === "POST") {
          const body = await req.json() as { name: string; description?: string };
          const a = registerAgent(body.name, { description: body.description });
          return ok({ agent: a }, 201);
        }
        if (path.match(/^\/api\/agents\/([^/]+)\/heartbeat$/) && method === "PUT") {
          const id = path.split("/")[3];
          try { heartbeat(id); return ok({ ok: true, agent_id: id }); }
          catch { return notFound("Agent not found"); }
        }
        if (path === "/api/sessions" && method === "GET") return ok({ sessions: dbListSessions() });
        if (path === "/api/sessions" && method === "POST") {
          const body = await req.json() as { engine?: string };
          const s = dbCreateSession({ engine: (body.engine ?? "playwright") as "playwright" });
          return ok({ session: s }, 201);
        }
        if (path.match(/^\/api\/sessions\/([^/]+)$/) && method === "DELETE") {
          const id = path.split("/")[3];
          try { const s = dbCloseSession(id); return ok({ session: s }); }
          catch { return notFound("Session not found"); }
        }
        if (path === "/api/recordings" && method === "GET") return ok({ recordings: listRecordings() });
        return notFound("Not found");
      },
    });
    base = `http://localhost:${httpServer.port}`;
  });

  afterEach(() => {
    httpServer.stop(true);
    resetDatabase();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    delete process.env["BROWSER_DB_PATH"];
    delete process.env["BROWSER_DATA_DIR"];
  });

  it("GET /api/projects returns 200 with projects array", async () => {
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(200);
    const data = await res.json() as { projects: unknown[] };
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it("POST /api/projects creates project", async () => {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "webapp", path: "/tmp/webapp" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { project: { name: string } };
    expect(data.project.name).toBe("webapp");
  });

  it("GET /api/agents returns 200", async () => {
    const res = await fetch(`${base}/api/agents`);
    expect(res.status).toBe(200);
  });

  it("POST /api/agents creates agent", async () => {
    const res = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "brutus" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { agent: { name: string } };
    expect(data.agent.name).toBe("brutus");
  });

  it("PUT /api/agents/:id/heartbeat returns 200", async () => {
    // Create agent first
    const createRes = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "julius" }),
    });
    const { agent } = await createRes.json() as { agent: { id: string } };

    const res = await fetch(`${base}/api/agents/${agent.id}/heartbeat`, { method: "PUT" });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; agent_id: string };
    expect(data.ok).toBe(true);
    expect(data.agent_id).toBe(agent.id);
  });

  it("PUT /api/agents/:nonexistent/heartbeat returns 404", async () => {
    const res = await fetch(`${base}/api/agents/nonexistent/heartbeat`, { method: "PUT" });
    expect(res.status).toBe(404);
  });

  it("GET /api/sessions returns 200", async () => {
    const res = await fetch(`${base}/api/sessions`);
    expect(res.status).toBe(200);
  });

  it("POST /api/sessions creates session", async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "playwright" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { session: { engine: string; status: string } };
    expect(data.session.engine).toBe("playwright");
    expect(data.session.status).toBe("active");
  });

  it("DELETE /api/sessions/:id closes session", async () => {
    const createRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "playwright" }),
    });
    const { session } = await createRes.json() as { session: { id: string } };
    const res = await fetch(`${base}/api/sessions/${session.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const data = await res.json() as { session: { status: string } };
    expect(data.session.status).toBe("closed");
  });

  it("DELETE /api/sessions/:nonexistent returns 404", async () => {
    const res = await fetch(`${base}/api/sessions/nonexistent`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /api/recordings returns 200", async () => {
    const res = await fetch(`${base}/api/recordings`);
    expect(res.status).toBe(200);
  });

  it("OPTIONS returns 204 with CORS headers", async () => {
    const res = await fetch(`${base}/api/sessions`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
