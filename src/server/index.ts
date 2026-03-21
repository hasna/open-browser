import { join } from "node:path";
import { existsSync } from "node:fs";
import { createSession, closeSession, listSessions, getSessionPage } from "../lib/session.js";
import { navigate, click, type as typeAction, scroll } from "../lib/actions.js";
import { getText, getHTML, getLinks, extract } from "../lib/extractor.js";
import { takeScreenshot, generatePDF } from "../lib/screenshot.js";
import { enableNetworkLogging, startHAR } from "../lib/network.js";
import { getPerformanceMetrics } from "../lib/performance.js";
import { enableConsoleCapture } from "../lib/console.js";
import { crawl } from "../lib/crawler.js";
import { startRecording, stopRecording, replayRecording } from "../lib/recorder.js";
import { registerAgent, heartbeat, listAgents, getAgent } from "../lib/agents.js";
import { ensureProject, listProjects, getProject } from "../db/projects.js";
import { getNetworkLog, clearNetworkLog } from "../db/network-log.js";
import { getConsoleLog } from "../db/console-log.js";
import { listRecordings, getRecording } from "../db/recordings.js";
import { listEntries, getEntry, tagEntry, favoriteEntry, deleteEntry, searchEntries, getGalleryStats } from "../db/gallery.js";
import { listDownloads, getDownload, deleteDownload, cleanStaleDownloads } from "../lib/downloads.js";
import { diffImages } from "../lib/gallery-diff.js";
import type { BrowserEngine } from "../types/index.js";

const PORT = parseInt(process.env["BROWSER_SERVER_PORT"] ?? "7030");
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Active state ─────────────────────────────────────────────────────────────
const networkCleanup = new Map<string, () => void>();
const consoleCleanup = new Map<string, () => void>();
const harCaptures = new Map<string, ReturnType<typeof startHAR>>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function notFound(msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function badRequest(msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function serverError(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e);
  return new Response(JSON.stringify({ error: msg }), {
    status: 500,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ── Sessions ─────────────────────────────────────────────────────────
      if (path === "/api/sessions" && method === "GET") {
        const status = url.searchParams.get("status") as "active" | "closed" | "error" | null;
        const projectId = url.searchParams.get("project_id") ?? undefined;
        return ok({ sessions: listSessions(status ? { status, projectId } : { projectId }) });
      }

      if (path === "/api/sessions" && method === "POST") {
        const body = await req.json() as Record<string, unknown>;
        const { session } = await createSession({
          engine: (body.engine as BrowserEngine) ?? "auto",
          projectId: body.project_id as string | undefined,
          agentId: body.agent_id as string | undefined,
          startUrl: body.start_url as string | undefined,
          headless: (body.headless as boolean) ?? true,
        });
        return ok({ session }, 201);
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && method === "DELETE") {
        const id = sessionMatch[1];
        networkCleanup.get(id)?.();
        consoleCleanup.get(id)?.();
        networkCleanup.delete(id);
        consoleCleanup.delete(id);
        harCaptures.delete(id);
        const session = await closeSession(id);
        return ok({ session });
      }

      // ── Navigate ────────────────────────────────────────────────────────
      if (path === "/api/navigate" && method === "POST") {
        const body = await req.json() as { session_id: string; url: string };
        if (!body.session_id || !body.url) return badRequest("session_id and url required");
        const page = getSessionPage(body.session_id);
        await navigate(page, body.url);
        return ok({ url: body.url, title: await page.title(), current_url: page.url() });
      }

      // ── Extract ─────────────────────────────────────────────────────────
      if (path === "/api/extract" && method === "POST") {
        const body = await req.json() as { session_id: string; format?: string; selector?: string };
        if (!body.session_id) return badRequest("session_id required");
        const page = getSessionPage(body.session_id);
        const result = await extract(page, { format: body.format as "text" | undefined, selector: body.selector });
        return ok(result);
      }

      // ── Screenshot ──────────────────────────────────────────────────────
      if (path === "/api/screenshot" && method === "POST") {
        const body = await req.json() as { session_id: string; selector?: string; full_page?: boolean };
        if (!body.session_id) return badRequest("session_id required");
        const page = getSessionPage(body.session_id);
        const result = await takeScreenshot(page, { selector: body.selector, fullPage: body.full_page });
        return ok(result);
      }

      // ── Screenshots list ─────────────────────────────────────────────────
      if (path.match(/^\/api\/screenshots\/([^/]+)$/) && method === "GET") {
        const sessionId = path.split("/")[3];
        // Return session snapshots from DB
        const { listSnapshots } = await import("../db/snapshots.js");
        return ok({ snapshots: listSnapshots(sessionId) });
      }

      // ── Network log ──────────────────────────────────────────────────────
      if (path.match(/^\/api\/network-log\/([^/]+)$/) && method === "GET") {
        const sessionId = path.split("/")[3];
        if (!networkCleanup.has(sessionId)) {
          const page = getSessionPage(sessionId);
          networkCleanup.set(sessionId, enableNetworkLogging(page, sessionId));
        }
        return ok({ requests: getNetworkLog(sessionId) });
      }

      if (path.match(/^\/api\/network-log\/([^/]+)$/) && method === "DELETE") {
        const sessionId = path.split("/")[3];
        clearNetworkLog(sessionId);
        return ok({ cleared: true });
      }

      // ── Console log ──────────────────────────────────────────────────────
      if (path.match(/^\/api\/console-log\/([^/]+)$/) && method === "GET") {
        const sessionId = path.split("/")[3];
        if (!consoleCleanup.has(sessionId)) {
          const page = getSessionPage(sessionId);
          consoleCleanup.set(sessionId, enableConsoleCapture(page, sessionId));
        }
        return ok({ messages: getConsoleLog(sessionId) });
      }

      // ── Performance ──────────────────────────────────────────────────────
      if (path.match(/^\/api\/performance\/([^/]+)$/) && method === "GET") {
        const sessionId = path.split("/")[3];
        const page = getSessionPage(sessionId);
        return ok({ metrics: await getPerformanceMetrics(page) });
      }

      // ── HAR ──────────────────────────────────────────────────────────────
      if (path === "/api/har/start" && method === "POST") {
        const body = await req.json() as { session_id: string };
        const page = getSessionPage(body.session_id);
        harCaptures.set(body.session_id, startHAR(page));
        return ok({ started: true });
      }

      if (path === "/api/har/stop" && method === "POST") {
        const body = await req.json() as { session_id: string };
        const capture = harCaptures.get(body.session_id);
        if (!capture) return notFound("No active HAR capture");
        const har = capture.stop();
        harCaptures.delete(body.session_id);
        return ok({ har });
      }

      // ── Recordings ───────────────────────────────────────────────────────
      if (path === "/api/recordings" && method === "GET") {
        return ok({ recordings: listRecordings(url.searchParams.get("project_id") ?? undefined) });
      }

      if (path.match(/^\/api\/recordings\/([^/]+)\/replay$/) && method === "POST") {
        const id = path.split("/")[3];
        const body = await req.json() as { session_id: string };
        const page = getSessionPage(body.session_id);
        const result = await replayRecording(id, page);
        return ok(result);
      }

      if (path.match(/^\/api\/recordings\/([^/]+)$/) && method === "DELETE") {
        const id = path.split("/")[3];
        const { deleteRecording } = await import("../db/recordings.js");
        deleteRecording(id);
        return ok({ deleted: id });
      }

      // ── Crawl ────────────────────────────────────────────────────────────
      if (path === "/api/crawl" && method === "POST") {
        const body = await req.json() as { url: string; max_depth?: number; max_pages?: number; engine?: string };
        if (!body.url) return badRequest("url required");
        const result = await crawl(body.url, {
          maxDepth: body.max_depth ?? 2,
          maxPages: body.max_pages ?? 50,
          engine: body.engine as BrowserEngine | undefined,
        });
        return ok(result);
      }

      // ── Agents ───────────────────────────────────────────────────────────
      if (path === "/api/agents" && method === "GET") {
        return ok({ agents: listAgents(url.searchParams.get("project_id") ?? undefined) });
      }

      if (path === "/api/agents" && method === "POST") {
        const body = await req.json() as { name: string; description?: string; project_id?: string; session_id?: string; working_dir?: string };
        if (!body.name) return badRequest("name required");
        const agent = registerAgent(body.name, { description: body.description, projectId: body.project_id, sessionId: body.session_id, workingDir: body.working_dir });
        return ok({ agent }, 201);
      }

      if (path.match(/^\/api\/agents\/([^/]+)\/heartbeat$/) && method === "PUT") {
        const id = path.split("/")[3];
        heartbeat(id);
        return ok({ ok: true, agent_id: id, timestamp: new Date().toISOString() });
      }

      if (path.match(/^\/api\/agents\/([^/]+)$/) && method === "DELETE") {
        const id = path.split("/")[3];
        const { deleteAgent } = await import("../db/agents.js");
        deleteAgent(id);
        return ok({ deleted: id });
      }

      // ── Projects ─────────────────────────────────────────────────────────
      if (path === "/api/projects" && method === "GET") {
        return ok({ projects: listProjects() });
      }

      if (path === "/api/projects" && method === "POST") {
        const body = await req.json() as { name: string; path: string; description?: string };
        if (!body.name || !body.path) return badRequest("name and path required");
        const project = ensureProject(body.name, body.path, body.description);
        return ok({ project }, 201);
      }

      // ── Gallery ──────────────────────────────────────────────────────────
      if (path === "/api/gallery" && method === "GET") {
        const tag = url.searchParams.get("tag") ?? undefined;
        const projectId = url.searchParams.get("project_id") ?? undefined;
        const isFavorite = url.searchParams.get("is_favorite") === "true" ? true : undefined;
        const limit = parseInt(url.searchParams.get("limit") ?? "50");
        const entries = listEntries({ tag, projectId, isFavorite, limit });
        return ok({ entries, count: entries.length });
      }
      if (path === "/api/gallery/stats" && method === "GET") {
        return ok(getGalleryStats(url.searchParams.get("project_id") ?? undefined));
      }
      if (path === "/api/gallery/diff" && method === "POST") {
        const body = await req.json() as { id1: string; id2: string };
        const e1 = getEntry(body.id1); const e2 = getEntry(body.id2);
        if (!e1 || !e2) return notFound("Gallery entry not found");
        return ok(await diffImages(e1.path, e2.path));
      }
      if (path.match(/^\/api\/gallery\/([^/]+)\/tag$/) && method === "POST") {
        const id = path.split("/")[3];
        const body = await req.json() as { tag: string };
        return ok({ entry: tagEntry(id, body.tag) });
      }
      if (path.match(/^\/api\/gallery\/([^/]+)\/favorite$/) && method === "PUT") {
        const id = path.split("/")[3];
        const body = await req.json() as { favorited: boolean };
        return ok({ entry: favoriteEntry(id, body.favorited) });
      }
      if (path.match(/^\/api\/gallery\/([^/]+)\/thumbnail$/) && method === "GET") {
        const id = path.split("/")[3];
        const entry = getEntry(id);
        if (!entry?.thumbnail_path || !existsSync(entry.thumbnail_path)) return notFound("Thumbnail not found");
        return new Response(Bun.file(entry.thumbnail_path), { headers: { ...CORS_HEADERS } });
      }
      if (path.match(/^\/api\/gallery\/([^/]+)\/image$/) && method === "GET") {
        const id = path.split("/")[3];
        const entry = getEntry(id);
        if (!entry?.path || !existsSync(entry.path)) return notFound("Image not found");
        return new Response(Bun.file(entry.path), { headers: { ...CORS_HEADERS } });
      }
      if (path.match(/^\/api\/gallery\/([^/]+)$/) && method === "DELETE") {
        const id = path.split("/")[3];
        deleteEntry(id);
        return ok({ deleted: id });
      }
      if (path.match(/^\/api\/gallery\/([^/]+)$/) && method === "GET") {
        const id = path.split("/")[3];
        const entry = getEntry(id);
        if (!entry) return notFound("Gallery entry not found");
        return ok({ entry });
      }

      // ── Downloads ─────────────────────────────────────────────────────────
      if (path === "/api/downloads" && method === "GET") {
        const sessionId = url.searchParams.get("session_id") ?? undefined;
        const downloads = listDownloads(sessionId);
        return ok({ downloads, count: downloads.length });
      }
      if (path === "/api/downloads/clean" && method === "DELETE") {
        const days = parseInt(url.searchParams.get("days") ?? "7");
        return ok({ deleted_count: cleanStaleDownloads(days) });
      }
      if (path.match(/^\/api\/downloads\/([^/]+)\/raw$/) && method === "GET") {
        const id = path.split("/")[3];
        const file = getDownload(id);
        if (!file || !existsSync(file.path)) return notFound("Download not found");
        return new Response(Bun.file(file.path), { headers: { ...CORS_HEADERS } });
      }
      if (path.match(/^\/api\/downloads\/([^/]+)$/) && method === "DELETE") {
        const id = path.split("/")[3];
        return ok({ deleted: deleteDownload(id) });
      }

      // ── Dashboard (static) ───────────────────────────────────────────────
      const dashboardDist = join(import.meta.dir, "../../dashboard/dist");
      if (existsSync(dashboardDist)) {
        const filePath = path === "/" ? join(dashboardDist, "index.html") : join(dashboardDist, path);
        if (existsSync(filePath)) {
          return new Response(Bun.file(filePath), { headers: CORS_HEADERS });
        }
        // SPA fallback
        return new Response(Bun.file(join(dashboardDist, "index.html")), { headers: CORS_HEADERS });
      }

      if (path === "/" || path === "") {
        return new Response("@hasna/browser REST API running. Dashboard not built.", {
          headers: { "Content-Type": "text/plain", ...CORS_HEADERS },
        });
      }

      return notFound(`Route not found: ${method} ${path}`);
    } catch (e) {
      return serverError(e);
    }
  },
});

console.error(`@hasna/browser server running on http://localhost:${PORT}`);
