import { describe, it, expect, afterAll } from "bun:test";
import { isTuiAvailable, launchTui, closeTui, getTerminalText, waitForTerminalText, sendKeys, sendSpecialKey, type TuiSession } from "./tui.js";
import { selectEngine, isEngineAvailable, inferUseCase } from "./selector.js";
import { UseCase } from "../types/index.js";

const tuiAvailable = isTuiAvailable();

describe("TUI engine", () => {
  describe("isTuiAvailable", () => {
    it("returns a boolean", () => {
      expect(typeof isTuiAvailable()).toBe("boolean");
    });
  });

  describe("selector integration", () => {
    it("maps TERMINAL_TEST to tui engine when available", () => {
      const engine = selectEngine(UseCase.TERMINAL_TEST);
      if (tuiAvailable) {
        expect(engine).toBe("tui");
      } else {
        // Falls through to default behavior
        expect(typeof engine).toBe("string");
      }
    });

    it("explicit tui engine overrides use case", () => {
      expect(selectEngine(UseCase.SCRAPE, "tui")).toBe("tui");
    });

    it("isEngineAvailable reports tui correctly", () => {
      expect(isEngineAvailable("tui")).toBe(tuiAvailable);
    });

    it("inferUseCase maps 'terminal' to TERMINAL_TEST", () => {
      expect(inferUseCase("terminal")).toBe(UseCase.TERMINAL_TEST);
    });

    it("inferUseCase maps 'tui' to TERMINAL_TEST", () => {
      expect(inferUseCase("tui")).toBe(UseCase.TERMINAL_TEST);
    });
  });

  // Integration tests — only run if ttyd is installed
  describe.skipIf(!tuiAvailable)("integration", () => {
    let session: TuiSession | null = null;

    afterAll(async () => {
      if (session) {
        await closeTui(session);
        session = null;
      }
    });

    it("launches a TUI session with echo command", async () => {
      session = await launchTui("bash -c \"echo TUI_TEST_OUTPUT; exec sleep 30\"", {
        headless: true,
        viewport: { width: 800, height: 600 },
      });

      expect(session).toBeDefined();
      expect(session.page).toBeDefined();
      expect(session.browser).toBeDefined();
      expect(session.ttydProcess).toBeDefined();
      expect(session.port).toBeGreaterThan(0);
    }, 30_000);

    it("can read terminal text", async () => {
      if (!session) return;
      // Give xterm.js time to render
      await new Promise((r) => setTimeout(r, 3000));
      const found = await waitForTerminalText(session.page, "TUI_TEST_OUTPUT", 15_000);
      if (!found) {
        const text = await getTerminalText(session.page);
        console.log("[tui-test] Terminal text:", JSON.stringify(text.slice(0, 500)));
      }
      expect(found).toBe(true);

      const text = await getTerminalText(session.page);
      expect(text).toContain("TUI_TEST_OUTPUT");
    }, 25_000);

    it("can take a screenshot", async () => {
      if (!session) return;
      const screenshot = await session.page.screenshot();
      expect(screenshot).toBeInstanceOf(Buffer);
      expect(screenshot.length).toBeGreaterThan(0);
    }, 10_000);

    it("closes cleanly", async () => {
      if (!session) return;
      await closeTui(session);
      // Verify ttyd process is dead
      expect(session.ttydProcess.killed).toBe(true);
      session = null;
    }, 10_000);
  });
});
