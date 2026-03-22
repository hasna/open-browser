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
    {
      version: 2,
      sql: `
        -- Gallery entries
        CREATE TABLE IF NOT EXISTS gallery_entries (
          id                    TEXT PRIMARY KEY,
          session_id            TEXT REFERENCES sessions(id) ON DELETE SET NULL,
          project_id            TEXT REFERENCES projects(id) ON DELETE SET NULL,
          url                   TEXT,
          title                 TEXT,
          path                  TEXT NOT NULL,
          thumbnail_path        TEXT,
          format                TEXT,
          width                 INTEGER,
          height                INTEGER,
          original_size_bytes   INTEGER,
          compressed_size_bytes INTEGER,
          compression_ratio     REAL,
          tags                  TEXT NOT NULL DEFAULT '[]',
          notes                 TEXT,
          is_favorite           INTEGER NOT NULL DEFAULT 0,
          created_at            TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Session name column (migration 2 adds it)
        ALTER TABLE sessions ADD COLUMN name TEXT;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name) WHERE name IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_gallery_session ON gallery_entries(session_id);
        CREATE INDEX IF NOT EXISTS idx_gallery_project ON gallery_entries(project_id);
        CREATE INDEX IF NOT EXISTS idx_gallery_favorite ON gallery_entries(is_favorite);
        CREATE INDEX IF NOT EXISTS idx_gallery_created ON gallery_entries(created_at);
      `,
    },
    {
      version: 3,
      sql: `
        -- Session lock/claim for multi-agent ownership
        ALTER TABLE sessions ADD COLUMN locked_by TEXT;
        ALTER TABLE sessions ADD COLUMN locked_at TEXT;
      `,
    },
    {
      version: 4,
      sql: `
        CREATE TABLE IF NOT EXISTS session_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          details TEXT DEFAULT '{}',
          timestamp TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, timestamp);
      `,
    },
    {
      version: 5,
      sql: `
        CREATE TABLE IF NOT EXISTS session_tags (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          PRIMARY KEY (session_id, tag)
        );
        CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);
      `,
    },
    {
      version: 6,
      sql: `
        CREATE TABLE IF NOT EXISTS auth_flows (
          id                 TEXT PRIMARY KEY,
          name               TEXT NOT NULL UNIQUE,
          domain             TEXT NOT NULL,
          recording_id       TEXT REFERENCES recordings(id),
          storage_state_path TEXT,
          created_at         TEXT DEFAULT (datetime('now')),
          last_used          TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_auth_flows_domain ON auth_flows(domain);
        CREATE INDEX IF NOT EXISTS idx_auth_flows_name ON auth_flows(name);
      `,
    },
    {
      version: 7,
      sql: `
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          steps TEXT NOT NULL DEFAULT '[]',
          start_url TEXT,
          last_run TEXT,
          last_heal TEXT,
          heal_count INTEGER DEFAULT 0,
          run_count INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `,
    },
    {
      version: 8,
      sql: `
        CREATE TABLE IF NOT EXISTS datasets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          source_url TEXT,
          source_type TEXT NOT NULL DEFAULT 'page',
          data TEXT NOT NULL DEFAULT '[]',
          schema TEXT,
          row_count INTEGER DEFAULT 0,
          last_refresh TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS api_endpoints (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          url TEXT NOT NULL,
          method TEXT DEFAULT 'GET',
          response_schema TEXT,
          sample_response TEXT,
          status_code INTEGER,
          content_type TEXT,
          discovered_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_api_endpoints_session ON api_endpoints(session_id);
      `,
    },
    {
      version: 9,
      sql: `
        CREATE TABLE IF NOT EXISTS scripts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          domain TEXT NOT NULL DEFAULT '',
          description TEXT DEFAULT '',
          variables TEXT NOT NULL DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          last_run TEXT,
          run_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS script_steps (
          id TEXT PRIMARY KEY,
          script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          step_order INTEGER NOT NULL,
          type TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          description TEXT DEFAULT '',
          ai_enabled INTEGER DEFAULT 0,
          ai_config TEXT DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_script_steps_order ON script_steps(script_id, step_order);

        CREATE TABLE IF NOT EXISTS script_runs (
          id TEXT PRIMARY KEY,
          script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'running',
          current_step INTEGER DEFAULT 0,
          total_steps INTEGER DEFAULT 0,
          current_description TEXT DEFAULT '',
          variables TEXT DEFAULT '{}',
          steps_log TEXT DEFAULT '[]',
          errors TEXT DEFAULT '[]',
          started_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT,
          duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_script_runs_script ON script_runs(script_id, status);
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
