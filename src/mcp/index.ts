#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { register as registerSessions } from "./sessions.js";
import { register as registerActions } from "./actions.js";
import { register as registerCapture } from "./capture.js";
import { register as registerNetwork } from "./network.js";
import { register as registerData } from "./data.js";
import { register as registerTui } from "./tui.js";

const _pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string };

const server = new McpServer({
  name: "@hasna/browser",
  version: "0.0.1",
});

registerSessions(server);
registerActions(server);
registerCapture(server);
registerNetwork(server);
registerData(server);
registerTui(server);

// --- send_feedback tool ---
import { z } from "zod";
import { getDatabase } from "../db/schema.js";

server.tool(
  "send_feedback",
  "Send feedback about this service",
  { message: z.string(), email: z.string().optional(), category: z.enum(["bug", "feature", "general"]).optional() },
  async (params) => {
    try {
      const db = getDatabase();
      db.prepare("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)").run(params.message, params.email || null, params.category || "general", _pkg.version);
      return { content: [{ type: "text", text: "Feedback saved. Thank you!" }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// Log version to stderr on startup so debugging is instant
const _startupToolCount = Object.keys((server as any)._registeredTools ?? {}).length;
console.error(`@hasna/browser v${_pkg.version} — ${_startupToolCount} tools | data: ${(await import("../db/schema.js")).getDataDir()}`);

const transport = new StdioServerTransport();
await server.connect(transport);
