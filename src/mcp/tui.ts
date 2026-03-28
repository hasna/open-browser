// ─── TUI-specific MCP tools ──────────────────────────────────────────────────
// Terminal UI testing tools — interact with, observe, assert, and record TUI apps.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, json, err, resolveSessionId, getSessionPage } from "./helpers.js";

// ─── Key mapping for friendly names ─────────────────────────────────────────

const KEY_MAP: Record<string, string> = {
  // Control keys
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+z": "\x1a",
  "ctrl+l": "\x0c",
  "ctrl+a": "\x01",
  "ctrl+e": "\x05",
  "ctrl+k": "\x0b",
  "ctrl+u": "\x15",
  "ctrl+w": "\x17",
  "ctrl+r": "\x12",
  "ctrl+p": "\x10",
  "ctrl+n": "\x0e",
  // Navigation
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  space: " ",
  // Arrows
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrow_up: "ArrowUp",
  arrow_down: "ArrowDown",
  arrow_left: "ArrowLeft",
  arrow_right: "ArrowRight",
  // Other
  home: "Home",
  end: "End",
  page_up: "PageUp",
  page_down: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Check if the session is a TUI session (engine === "tui") */
function assertTuiSession(sessionId: string) {
  const { getSessionEngine } = require("../lib/session.js");
  const engine = getSessionEngine(sessionId);
  if (engine !== "tui") {
    throw new Error(`browser_tui_* tools require a TUI session (engine="tui"), but this session uses engine="${engine}". Create a TUI session with: browser_session_create(engine="tui", start_url="your-command")`);
  }
}

/** Get terminal text, optionally filtered by row range */
async function getTermText(page: any, startRow?: number, endRow?: number): Promise<{ text: string; rows: string[]; row_count: number }> {
  const result = await page.evaluate((args: any) => {
    const [sr, er] = args;
    const term = (window as any).term ?? (window as any).terminal;
    if (!term?.buffer?.active) return { text: "", rows: [] as string[], row_count: 0 };
    const buf = term.buffer.active;
    const allRows: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) allRows.push(line.translateToString(true));
    }
    const start = sr ?? 0;
    const end = er ?? allRows.length;
    const filtered = allRows.slice(start, end);
    return { text: filtered.join("\n").trimEnd(), rows: filtered, row_count: allRows.length };
  }, [startRow, endRow]);
  return result;
}

// ─── In-memory recording state ───────────────────────────────────────────────

interface TuiRecording {
  sessionId: string;
  startTime: number;
  cols: number;
  rows: number;
  events: Array<[number, string, string]>; // [relative_time_sec, event_type, data]
  intervalId: ReturnType<typeof setInterval>;
  lastText: string;
}

const activeRecordings = new Map<string, TuiRecording>();

// ─── Registration ────────────────────────────────────────────────────────────

export function register(server: McpServer) {

// ── browser_tui_send_keys ────────────────────────────────────────────────────

server.tool(
  "browser_tui_send_keys",
  `Send keystrokes to a TUI terminal session. Use friendly key names.

SUPPORTED KEYS:
- Control: ctrl+c, ctrl+d, ctrl+z, ctrl+l, ctrl+a, ctrl+e, ctrl+k, ctrl+u, ctrl+w, ctrl+r
- Navigation: enter, tab, escape, backspace, delete, space
- Arrows: up, down, left, right (or arrow_up, arrow_down, arrow_left, arrow_right)
- Function: f1-f12
- Position: home, end, page_up, page_down

Pass multiple keys as a comma-separated string: "tab,tab,enter" or "ctrl+c"
For typing text, use browser_tui_send_text instead.`,
  {
    session_id: z.string().optional(),
    keys: z.string().describe("Comma-separated key names: 'enter', 'ctrl+c', 'tab,tab,enter', 'arrow_down,arrow_down,enter'"),
  },
  async ({ session_id, keys }) => {
    try {
      const sid = resolveSessionId(session_id);
      assertTuiSession(sid);
      const page = getSessionPage(sid);

      const keyList = keys.split(",").map((k) => k.trim().toLowerCase());
      const sent: string[] = [];

      for (const key of keyList) {
        const mapped = KEY_MAP[key];
        if (mapped) {
          if (mapped.length === 1 && mapped.charCodeAt(0) < 32) {
            // Control character — type it directly
            await page.keyboard.insertText(mapped);
          } else {
            await page.keyboard.press(mapped);
          }
          sent.push(key);
        } else {
          // Unknown key — try pressing it as-is (Playwright key name)
          await page.keyboard.press(key);
          sent.push(key);
        }
      }

      return json({ sent, count: sent.length });
    } catch (e) { return err(e); }
  }
);

// ── browser_tui_send_text ────────────────────────────────────────────────────

server.tool(
  "browser_tui_send_text",
  `Type text into a TUI terminal and optionally press Enter. This is the most common way to interact with terminal apps.

Examples:
- Send a command: text="ls -la", press_enter=true
- Type without executing: text="partial input", press_enter=false
- Send to a prompt: text="yes", press_enter=true`,
  {
    session_id: z.string().optional(),
    text: z.string().describe("Text to type into the terminal"),
    press_enter: z.boolean().optional().default(true).describe("Press Enter after typing (default: true)"),
  },
  async ({ session_id, text, press_enter }) => {
    try {
      const sid = resolveSessionId(session_id);
      assertTuiSession(sid);
      const page = getSessionPage(sid);

      const textarea = await page.$(".xterm-helper-textarea");
      if (textarea) {
        await textarea.type(text);
      } else {
        await page.keyboard.type(text);
      }

      if (press_enter) {
        await page.keyboard.press("Enter");
      }

      return json({ typed: text, pressed_enter: press_enter });
    } catch (e) { return err(e); }
  }
);

// ── browser_tui_resize ───────────────────────────────────────────────────────

server.tool(
  "browser_tui_resize",
  "Resize the terminal to a specific number of columns and rows. Useful for testing responsive TUI layouts at different terminal sizes.",
  {
    session_id: z.string().optional(),
    cols: z.number().describe("Number of columns (e.g. 80, 120, 200)"),
    rows: z.number().describe("Number of rows (e.g. 24, 40, 50)"),
  },
  async ({ session_id, cols, rows }) => {
    try {
      const sid = resolveSessionId(session_id);
      assertTuiSession(sid);
      const page = getSessionPage(sid);

      const result = await page.evaluate((args: any) => {
        const [c, r] = args;
        const term = (window as any).term ?? (window as any).terminal;
        if (!term) return { resized: false, error: "No terminal instance found" };
        term.resize(c, r);
        return { resized: true, cols: c, rows: r };
      }, [cols, rows]);

      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── browser_tui_get_text ─────────────────────────────────────────────────────

server.tool(
  "browser_tui_get_text",
  `Get the text content from the terminal buffer. Returns all visible text, or a specific row range.

Use this to read what the terminal is currently displaying. For waiting until specific text appears, use browser_tui_wait_for_text instead.`,
  {
    session_id: z.string().optional(),
    start_row: z.number().optional().describe("First row to read (0-indexed, default: 0)"),
    end_row: z.number().optional().describe("Last row (exclusive). Omit for all rows."),
  },
  async ({ session_id, start_row, end_row }) => {
    try {
      const sid = resolveSessionId(session_id);
      assertTuiSession(sid);
      const page = getSessionPage(sid);
      const result = await getTermText(page, start_row, end_row);
      return json(result);
    } catch (e) { return err(e); }
  }
);

// ── browser_tui_wait_for_text ────────────────────────────────────────────────

server.tool(
  "browser_tui_wait_for_text",
  `Wait for specific text to appear in the terminal output. Polls the terminal buffer until the text is found or timeout is reached.

Use this after sending a command to wait for its output, or to wait for a TUI app to finish loading.`,
  {
    session_id: z.string().optional(),
    text: z.string().describe("Text to wait for (substring match)"),
    timeout_ms: z.number().optional().default(30000).describe("Timeout in milliseconds (default: 30000)"),
  },
  async ({ session_id, text, timeout_ms }) => {
    try {
      const sid = resolveSessionId(session_id);
      assertTuiSession(sid);
      const page = getSessionPage(sid);

      const start = Date.now();
      while (Date.now() - start < timeout_ms) {
        const result = await getTermText(page);
        if (result.text.includes(text)) {
          return json({ found: true, elapsed_ms: Date.now() - start, terminal_text: result.text });
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      const finalText = await getTermText(page);
      return json({ found: false, elapsed_ms: timeout_ms, terminal_text: finalText.text });
    } catch (e) { return err(e); }
  }
);

// ── browser_tui_get_cursor ───────────────────────────────────────────────────

server.tool(
  "browser_tui_get_cursor",
  "Get the current cursor position (row and column) in the terminal.",
  {
    session_id: z.string().optional(),
  },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      assertTuiSession(sid);
      const page = getSessionPage(sid);

      const cursor = await page.evaluate(() => {
        const term = (window as any).term ?? (window as any).terminal;
        if (!term?.buffer?.active) return null;
        return { row: term.buffer.active.cursorY, col: term.buffer.active.cursorX };
      });

      if (!cursor) return err(new Error("Could not read cursor position — no terminal instance"));
      return json(cursor);
    } catch (e) { return err(e); }
  }
);

// ── browser_tui_assert ───────────────────────────────────────────────────────

server.tool(
  "browser_tui_assert",
  `Assert conditions on the terminal state. Chain multiple conditions with AND.

CONDITION SYNTAX:
- "text contains X"        — terminal buffer contains substring X
- "row N contains X"       — row N (0-indexed) contains substring X
- "cursor at R,C"          — cursor is at row R, column C
- "row_count > N"          — total rows greater than N
- "row_count == N"         — total rows equals N

Example: "text contains hello AND row 0 contains $ AND cursor at 1,0"`,
  {
    session_id: z.string().optional(),
    condition: z.string().describe("Assertion condition(s), joined with AND"),
  },
  async ({ session_id, condition }) => {
    try {
      const sid = resolveSessionId(session_id);
      assertTuiSession(sid);
      const page = getSessionPage(sid);

      const termData = await getTermText(page);
      const cursor = await page.evaluate(() => {
        const term = (window as any).term ?? (window as any).terminal;
        if (!term?.buffer?.active) return { row: -1, col: -1 };
        return { row: term.buffer.active.cursorY, col: term.buffer.active.cursorX };
      });

      const checks: Array<{ assertion: string; result: boolean }> = [];
      let allPassed = true;

      for (const part of condition.split(/\s+AND\s+/i)) {
        const trimmed = part.trim();
        let result = false;

        if (/^text\s+contains\s+/i.test(trimmed)) {
          const needle = trimmed.replace(/^text\s+contains\s+/i, "").replace(/^["']|["']$/g, "");
          result = termData.text.includes(needle);
        } else if (/^row\s+(\d+)\s+contains\s+/i.test(trimmed)) {
          const match = trimmed.match(/^row\s+(\d+)\s+contains\s+(.+)/i);
          if (match) {
            const rowIdx = parseInt(match[1]);
            const needle = match[2].replace(/^["']|["']$/g, "");
            result = (termData.rows[rowIdx] ?? "").includes(needle);
          }
        } else if (/^cursor\s+at\s+(\d+)\s*,\s*(\d+)/i.test(trimmed)) {
          const match = trimmed.match(/^cursor\s+at\s+(\d+)\s*,\s*(\d+)/i);
          if (match) {
            result = cursor.row === parseInt(match[1]) && cursor.col === parseInt(match[2]);
          }
        } else if (/^row_count\s*(>|>=|<|<=|==|!=)\s*(\d+)/i.test(trimmed)) {
          const match = trimmed.match(/^row_count\s*(>|>=|<|<=|==|!=)\s*(\d+)/i);
          if (match) {
            const op = match[1];
            const n = parseInt(match[2]);
            const count = termData.row_count;
            result = op === ">" ? count > n : op === ">=" ? count >= n : op === "<" ? count < n : op === "<=" ? count <= n : op === "==" ? count === n : count !== n;
          }
        }

        checks.push({ assertion: trimmed, result });
        if (!result) allPassed = false;
      }

      return json({ passed: allPassed, checks, cursor, row_count: termData.row_count });
    } catch (e) { return err(e); }
  }
);

// ── browser_tui_snapshot ─────────────────────────────────────────────────────

server.tool(
  "browser_tui_snapshot",
  "Capture a structured snapshot of the terminal buffer: all rows as an array, cursor position, dimensions, and theme. Useful for comparing terminal state before and after actions.",
  {
    session_id: z.string().optional(),
  },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      assertTuiSession(sid);
      const page = getSessionPage(sid);

      const snapshot = await page.evaluate(() => {
        const term = (window as any).term ?? (window as any).terminal;
        if (!term?.buffer?.active) return null;
        const buf = term.buffer.active;
        const rows: string[] = [];
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          if (line) rows.push(line.translateToString(true));
        }
        return {
          rows,
          cols: term.cols,
          total_rows: term.rows,
          buffer_length: buf.length,
          cursor_row: buf.cursorY,
          cursor_col: buf.cursorX,
          font_size: term.options?.fontSize,
          theme: term.options?.theme?.background === "#ffffff" ? "light" : "dark",
        };
      });

      if (!snapshot) return err(new Error("Could not capture snapshot — no terminal instance"));
      return json(snapshot);
    } catch (e) { return err(e); }
  }
);

// ── browser_tui_record_start ─────────────────────────────────────────────────

server.tool(
  "browser_tui_record_start",
  "Start recording the terminal session as an asciicast v2 file (asciinema-compatible). Polls the terminal buffer at an interval and captures changes.",
  {
    session_id: z.string().optional(),
    interval_ms: z.number().optional().default(500).describe("Polling interval in ms (default: 500)"),
  },
  async ({ session_id, interval_ms }) => {
    try {
      const sid = resolveSessionId(session_id);
      assertTuiSession(sid);
      const page = getSessionPage(sid);

      if (activeRecordings.has(sid)) {
        return err(new Error("Recording already active for this session. Stop it first with browser_tui_record_stop."));
      }

      // Get initial terminal dimensions
      const dims = await page.evaluate(() => {
        const term = (window as any).term ?? (window as any).terminal;
        return term ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 };
      });

      const initialText = (await getTermText(page)).text;

      const recording: TuiRecording = {
        sessionId: sid,
        startTime: Date.now(),
        cols: dims.cols,
        rows: dims.rows,
        events: [],
        lastText: initialText,
        intervalId: setInterval(async () => {
          try {
            const current = await getTermText(page);
            if (current.text !== recording.lastText) {
              const elapsed = (Date.now() - recording.startTime) / 1000;
              recording.events.push([elapsed, "o", current.text.slice(recording.lastText.length) || current.text]);
              recording.lastText = current.text;
            }
          } catch {}
        }, interval_ms),
      };

      activeRecordings.set(sid, recording);
      return json({ recording: true, session_id: sid, interval_ms, cols: dims.cols, rows: dims.rows });
    } catch (e) { return err(e); }
  }
);

// ── browser_tui_record_stop ──────────────────────────────────────────────────

server.tool(
  "browser_tui_record_stop",
  "Stop recording and return the asciicast v2 JSON. Compatible with asciinema player.",
  {
    session_id: z.string().optional(),
  },
  async ({ session_id }) => {
    try {
      const sid = resolveSessionId(session_id);
      const recording = activeRecordings.get(sid);
      if (!recording) return err(new Error("No active recording for this session"));

      clearInterval(recording.intervalId);
      activeRecordings.delete(sid);

      const duration = (Date.now() - recording.startTime) / 1000;

      // Build asciicast v2 format
      const header = {
        version: 2,
        width: recording.cols,
        height: recording.rows,
        timestamp: Math.floor(recording.startTime / 1000),
        duration,
        env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
      };

      const lines = [JSON.stringify(header)];
      for (const [time, type, data] of recording.events) {
        lines.push(JSON.stringify([time, type, data]));
      }

      const asciicast = lines.join("\n");

      return json({
        format: "asciicast_v2",
        duration_seconds: Math.round(duration * 10) / 10,
        event_count: recording.events.length,
        asciicast,
      });
    } catch (e) { return err(e); }
  }
);

} // end register
