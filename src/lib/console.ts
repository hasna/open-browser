import type { Page, ConsoleMessage as PlaywrightConsoleMessage } from "playwright";
import type { ConsoleMessage, ConsoleLevel } from "../types/index.js";
import { logConsoleMessage, getConsoleLog, clearConsoleLog } from "../db/console-log.js";

export function enableConsoleCapture(page: Page, sessionId: string): () => void {
  const onConsole = (msg: PlaywrightConsoleMessage) => {
    const levelMap: Record<string, ConsoleLevel> = {
      log: "log",
      warn: "warn",
      error: "error",
      debug: "debug",
      info: "info",
      warning: "warn",
    };
    const level: ConsoleLevel = levelMap[msg.type()] ?? "log";
    const location = msg.location();

    try {
      logConsoleMessage({
        session_id: sessionId,
        level,
        message: msg.text(),
        source: location.url || undefined,
        line_number: location.lineNumber || undefined,
      });
    } catch {
      // Non-fatal
    }
  };

  page.on("console", onConsole);
  return () => page.off("console", onConsole);
}

export { getConsoleLog, clearConsoleLog };

export async function capturePageErrors(
  page: Page,
  sessionId: string
): Promise<() => void> {
  const onError = (err: Error) => {
    try {
      logConsoleMessage({
        session_id: sessionId,
        level: "error",
        message: `[Page Error] ${err.message}`,
        source: err.stack?.split("\n")[1]?.trim(),
      });
    } catch {
      // Non-fatal
    }
  };

  page.on("pageerror", onError);
  return () => page.off("pageerror", onError);
}
