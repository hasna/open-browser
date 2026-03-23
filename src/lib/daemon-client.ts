/**
 * Daemon client — connects to a running browser daemon via HTTP.
 * Falls back to null if no daemon is running.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../db/schema.js";

const PID_FILE = join(getDataDir(), "daemon.pid");
const DEFAULT_PORT = 7030;

export function getDaemonPidFile(): string { return PID_FILE; }
export function getDaemonPort(): number {
  return parseInt(process.env["BROWSER_DAEMON_PORT"] ?? String(DEFAULT_PORT), 10);
}

export function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    process.kill(pid, 0); // Check if process exists (doesn't actually kill)
    return true;
  } catch {
    return false;
  }
}

export function getDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    return parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    return null;
  }
}

export async function getDaemonStatus(): Promise<{ running: boolean; pid: number | null; port: number; sessions?: number; uptime_ms?: number }> {
  const pid = getDaemonPid();
  const port = getDaemonPort();
  if (!isDaemonRunning()) return { running: false, pid: null, port };

  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json() as any;
    return { running: true, pid, port, sessions: data.active_sessions ?? 0, uptime_ms: data.uptime_ms };
  } catch {
    return { running: true, pid, port };
  }
}
