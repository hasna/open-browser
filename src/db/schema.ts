import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

export function getDataDir(): string {
  return process.env["BROWSER_DATA_DIR"] ?? join(homedir(), ".browser");
}

let _db: Database | null = null;
let _dbPath: string | null = null;

export function getDatabase(path?: string): Database {
  const resolvedPath = path ?? process.env["BROWSER_DB_PATH"] ?? join(getDataDir(), "browser.db");
  // Re-create if path changed (e.g. test isolation)
  if (_db && _dbPath === resolvedPath) return _db;
  if (_db) { try { _db.close(); } catch {} _db = null; }

  mkdirSync(join(resolvedPath, ".."), { recursive: true });

  _db = new Database(resolvedPath);
  _dbPath = resolvedPath;
  _db.exec("PRAGMA journal_mode=WAL;");
  _db.exec("PRAGMA foreign_keys=ON;");

  runMigrations(_db);
  return _db;
}

export function resetDatabase(): void {
  if (_db) { try { _db.close(); } catch {} }
  _db = null;
  _dbPath = null;
}

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.query("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version
    )
  );

  const migrations: Array<{ version: number; sql: string }> = [
    {
      version: 1,
      sql: `
        CREATE TABLE IF NOT EXISTS projects (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          path        TEXT NOT NULL,
          description TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS agents (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT,
          session_id  TEXT,
          project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
          working_dir TEXT,
          last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS heartbeats (
          id         TEXT PRIMARY KEY,
          agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          session_id TEXT,
          timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id         TEXT PRIMARY KEY,
          engine     TEXT NOT NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
          start_url  TEXT,
          status     TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          closed_at  TEXT
        );

        CREATE TABLE IF NOT EXISTS snapshots (
          id              TEXT PRIMARY KEY,
          session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          url             TEXT NOT NULL,
          title           TEXT,
          html            TEXT,
          screenshot_path TEXT,
          timestamp       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS network_log (
          id               TEXT PRIMARY KEY,
          session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          method           TEXT NOT NULL,
          url              TEXT NOT NULL,
          status_code      INTEGER,
          request_headers  TEXT,
          response_headers TEXT,
          request_body     TEXT,
          body_size        INTEGER,
          duration_ms      INTEGER,
          resource_type    TEXT,
          timestamp        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS console_log (
          id          TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          level       TEXT NOT NULL DEFAULT 'log',
          message     TEXT NOT NULL,
          source      TEXT,
          line_number INTEGER,
          timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS recordings (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          start_url  TEXT,
          steps      TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS crawl_results (
          id         TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          start_url  TEXT NOT NULL,
          depth      INTEGER NOT NULL DEFAULT 1,
          pages      TEXT NOT NULL DEFAULT '[]',
          links      TEXT NOT NULL DEFAULT '[]',
          errors     TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);
        CREATE INDEX IF NOT EXISTS idx_network_log_session ON network_log(session_id);
        CREATE INDEX IF NOT EXISTS idx_console_log_session ON console_log(session_id);
        CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
        CREATE INDEX IF NOT EXISTS idx_heartbeats_agent ON heartbeats(agent_id);
        CREATE INDEX IF NOT EXISTS idx_recordings_project ON recordings(project_id);
        CREATE INDEX IF NOT EXISTS idx_crawl_results_project ON crawl_results(project_id);
      `,
    },
  ];

  for (const m of migrations) {
    if (!applied.has(m.version)) {
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(m.version);
      })();
    }
  }
}
