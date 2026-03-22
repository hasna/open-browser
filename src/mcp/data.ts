// ─── Data, scripts, workflows, recordings, agents, gallery, downloads, meta ──

import { register as registerRecordings } from "./recordings.js";
import { register as registerScripts } from "./scripts.js";
import { register as registerMeta } from "./meta.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function register(server: McpServer) {
  registerRecordings(server);
  registerScripts(server);
  registerMeta(server);
}
