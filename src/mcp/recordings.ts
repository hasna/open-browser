// ─── Recording, workflow, crawl, and auth flow tools ─────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  z,
  json,
  err,
  resolveSessionId,
  getSessionPage,
  navigate,
  startRecording,
  stopRecording,
  replayRecording,
  recordStep,
  crawl,
  listRecordings,
  logEvent,
} from "./helpers.js";
import type { BrowserEngine } from "./helpers.js";

export function register(server: McpServer) {

// ── Recording Tools ───────────────────────────────────────────────────────────

server.tool(
  "browser_record_start",
  "Start recording actions in a session",
  { session_id: z.string().optional(), name: z.string(), project_id: z.string().optional() },
  async ({ session_id, name }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const recording = startRecording(sid, name, page.url());
      return json({ recording_id: recording.id, name: recording.name });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_record_step",
  "Manually add a step to an active recording",
  {
    recording_id: z.string(),
    type: z.enum(["navigate", "click", "type", "scroll", "hover", "select", "check", "evaluate"]),
    selector: z.string().optional(),
    value: z.string().optional(),
    url: z.string().optional(),
  },
  async ({ recording_id, type, selector, value, url }) => {
    try {
      recordStep(recording_id, { type, selector, value, url });
      return json({ recorded: type });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_record_stop",
  "Stop recording and save the recording",
  { recording_id: z.string() },
  async ({ recording_id }) => {
    try {
      const recording = stopRecording(recording_id);
      return json({ recording, steps: recording.steps.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_record_replay",
  "Replay a recorded sequence in a session",
  { session_id: z.string().optional(), recording_id: z.string() },
  async ({ session_id, recording_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const result = await replayRecording(recording_id, page);
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_recordings_list",
  "List all recordings",
  { project_id: z.string().optional() },
  async ({ project_id }) => {
    try {
      return json({ recordings: listRecordings(project_id) });
    } catch (e) { return err(e); }
  }
);

// ── Workflow Tools ─────────────────────────────────────────────────────────

server.tool(
  "browser_workflow_save",
  "Save a recording as a reusable workflow with self-healing replay",
  { recording_id: z.string(), name: z.string(), description: z.string().optional() },
  async ({ recording_id, name, description }) => {
    try {
      const { saveWorkflowFromRecording } = await import("../lib/workflows.js");
      return json(saveWorkflowFromRecording(recording_id, name, description));
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_workflow_list",
  "List all saved workflows",
  {},
  async () => {
    try {
      const { listWorkflows } = await import("../lib/workflows.js");
      const workflows = listWorkflows();
      return json({ workflows: workflows.map(w => ({ ...w, steps: `${w.steps.length} steps` })), count: workflows.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_workflow_run",
  "Run a saved workflow with self-healing. If selectors changed, auto-adapts and reports what was healed.",
  { session_id: z.string().optional(), name: z.string() },
  async ({ session_id, name }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { getWorkflowByName, runWorkflow } = await import("../lib/workflows.js");
      const workflow = getWorkflowByName(name);
      if (!workflow) return err(new Error(`Workflow '${name}' not found`));
      const result = await runWorkflow(workflow, page);
      logEvent(sid, "workflow_run", { name, ...result });
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_workflow_delete",
  "Delete a saved workflow",
  { name: z.string() },
  async ({ name }) => {
    try {
      const { deleteWorkflow } = await import("../lib/workflows.js");
      return json({ deleted: deleteWorkflow(name) });
    } catch (e) { return err(e); }
  }
);

// ── Crawl Tools ───────────────────────────────────────────────────────────────

server.tool(
  "browser_crawl",
  "Crawl a URL recursively and return discovered pages",
  {
    url: z.string(),
    max_depth: z.number().optional().default(2),
    max_pages: z.number().optional().default(50),
    same_domain: z.boolean().optional().default(true),
    project_id: z.string().optional(),
    engine: z.enum(["playwright", "cdp", "lightpanda", "bun", "auto"]).optional().default("auto"),
  },
  async ({ url, max_depth, max_pages, same_domain, project_id, engine }) => {
    try {
      const result = await crawl(url, {
        maxDepth: max_depth,
        maxPages: max_pages,
        sameDomain: same_domain,
        projectId: project_id,
        engine: engine as BrowserEngine,
      });
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── Auth Flow Tools ──────────────────────────────────────────────────────────

server.tool(
  "browser_auth_record",
  "Start recording a login flow. Navigate to the login page, perform the login, then call browser_auth_stop to save.",
  { session_id: z.string().optional(), name: z.string().describe("Name for this auth flow (e.g. 'github', 'gmail')"), start_url: z.string().optional().describe("Login page URL") },
  async ({ session_id, name, start_url }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      if (start_url) await navigate(page, start_url);
      const recording = startRecording(sid, `auth-${name}`, page.url());
      return json({ recording_id: recording.id, name, message: "Recording started. Perform login, then call browser_auth_stop." });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_auth_stop",
  "Stop recording a login flow and save as a reusable auth flow with storage state.",
  { session_id: z.string().optional(), name: z.string(), recording_id: z.string() },
  async ({ session_id, name, recording_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const recording = stopRecording(recording_id);
      // Save storage state
      const { saveStateFromPage } = await import("../lib/storage-state.js");
      const statePath = await saveStateFromPage(page, name);
      // Extract domain
      let domain = "";
      try { domain = new URL(page.url()).hostname; } catch {}
      // Save auth flow
      const { saveAuthFlow } = await import("../lib/auth-flow.js");
      const flow = saveAuthFlow({ name, domain, recordingId: recording.id, storageStatePath: statePath });
      return json({ flow, recording_steps: recording.steps.length });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_auth_replay",
  "Manually replay a saved auth flow for a domain",
  { session_id: z.string().optional(), name: z.string().describe("Auth flow name to replay") },
  async ({ session_id, name }) => {
    try {
      const sid = resolveSessionId(session_id);
      const page = getSessionPage(sid);
      const { getAuthFlowByName, tryReplayAuth } = await import("../lib/auth-flow.js");
      const flow = getAuthFlowByName(name);
      if (!flow) return err(new Error(`Auth flow '${name}' not found`));
      const result = await tryReplayAuth(page, flow.domain);
      return json(result);
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_auth_list",
  "List all saved auth flows",
  {},
  async () => {
    try {
      const { listAuthFlows } = await import("../lib/auth-flow.js");
      return json({ flows: listAuthFlows() });
    } catch (e) { return err(e); }
  }
);

server.tool(
  "browser_auth_delete",
  "Delete a saved auth flow",
  { name: z.string() },
  async ({ name }) => {
    try {
      const { deleteAuthFlow } = await import("../lib/auth-flow.js");
      return json({ deleted: deleteAuthFlow(name) });
    } catch (e) { return err(e); }
  }
);

} // end register
