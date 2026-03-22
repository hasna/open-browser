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

// Log version to stderr on startup so debugging is instant
const _startupToolCount = Object.keys((server as any)._registeredTools ?? {}).length;
console.error(`@hasna/browser v${_pkg.version} — ${_startupToolCount} tools | data: ${(await import("../db/schema.js")).getDataDir()}`);

const transport = new StdioServerTransport();
await server.connect(transport);
