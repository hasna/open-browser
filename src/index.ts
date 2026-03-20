// ─── @hasna/browser — Public API ─────────────────────────────────────────────

// Types
export * from "./types/index.js";

// DB
export { getDatabase, getDataDir, resetDatabase } from "./db/schema.js";
export { createProject, ensureProject, getProject, getProjectByName, listProjects, updateProject, deleteProject } from "./db/projects.js";
export { registerAgent as dbRegisterAgent, heartbeat as dbHeartbeat, getAgent, getAgentByName, listAgents as dbListAgents, updateAgent, deleteAgent, cleanStaleAgents } from "./db/agents.js";
export type { RegisterAgentOptions } from "./db/agents.js";
export { createSession as dbCreateSession, getSession, listSessions as dbListSessions, closeSession as dbCloseSession, updateSessionStatus, deleteSession } from "./db/sessions.js";
export { createSnapshot, getSnapshot, listSnapshots, deleteSnapshot, deleteSnapshotsBySession } from "./db/snapshots.js";
export { logRequest, getNetworkRequest, getNetworkLog, clearNetworkLog, deleteNetworkRequest } from "./db/network-log.js";
export { logConsoleMessage, getConsoleMessage, getConsoleLog, clearConsoleLog } from "./db/console-log.js";
export { createRecording, getRecording, listRecordings as dbListRecordings, updateRecording, deleteRecording } from "./db/recordings.js";
export { createCrawlResult, getCrawlResult, listCrawlResults, deleteCrawlResult } from "./db/crawl-results.js";
export { recordHeartbeat, getLastHeartbeat, listHeartbeats, cleanOldHeartbeats } from "./db/heartbeats.js";

// Engines
export * from "./engines/playwright.js";
export * from "./engines/cdp.js";
export * from "./engines/lightpanda.js";
export { selectEngine, isEngineAvailable, inferUseCase } from "./engines/selector.js";

// Lib
export * from "./lib/session.js";
export * from "./lib/actions.js";
export * from "./lib/extractor.js";
export * from "./lib/network.js";
export * from "./lib/performance.js";
export * from "./lib/console.js";
export * from "./lib/screenshot.js";
export * from "./lib/storage.js";
export * from "./lib/recorder.js";
export * from "./lib/crawler.js";
export * from "./lib/agents.js";
