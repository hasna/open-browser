import { describe, it, expect, mock } from "bun:test";
import { selectEngine, isEngineAvailable, inferUseCase } from "./selector.js";
import { UseCase } from "../types/index.js";

describe("engine selector", () => {
  describe("selectEngine", () => {
    it("returns playwright for form fill", () => {
      expect(selectEngine(UseCase.FORM_FILL)).toBe("playwright");
    });

    it("returns playwright for screenshot", () => {
      expect(selectEngine(UseCase.SCREENSHOT)).toBe("playwright");
    });

    it("returns playwright for SPA navigate", () => {
      expect(selectEngine(UseCase.SPA_NAVIGATE)).toBe("playwright");
    });

    it("returns playwright for auth flow", () => {
      expect(selectEngine(UseCase.AUTH_FLOW)).toBe("playwright");
    });

    it("returns cdp for network monitor", () => {
      expect(selectEngine(UseCase.NETWORK_MONITOR)).toBe("cdp");
    });

    it("returns cdp for HAR capture", () => {
      expect(selectEngine(UseCase.HAR_CAPTURE)).toBe("cdp");
    });

    it("returns cdp for perf profile", () => {
      expect(selectEngine(UseCase.PERF_PROFILE)).toBe("cdp");
    });

    it("returns cdp for script inject", () => {
      expect(selectEngine(UseCase.SCRIPT_INJECT)).toBe("cdp");
    });

    it("returns cdp for coverage", () => {
      expect(selectEngine(UseCase.COVERAGE)).toBe("cdp");
    });

    it("prefers lightpanda for scrape if available, falls back to playwright", () => {
      // Whether lightpanda is available or not, we get a valid engine
      const engine = selectEngine(UseCase.SCRAPE);
      expect(["lightpanda", "playwright"]).toContain(engine);
    });

    it("explicit engine overrides use case", () => {
      expect(selectEngine(UseCase.SCRAPE, "playwright")).toBe("playwright");
      expect(selectEngine(UseCase.SCREENSHOT, "cdp")).toBe("cdp");
    });

    it("auto explicit falls back to use-case selection", () => {
      const engine = selectEngine(UseCase.FORM_FILL, "auto");
      expect(engine).toBe("playwright");
    });
  });

  describe("isEngineAvailable", () => {
    it("playwright is always available", () => {
      expect(isEngineAvailable("playwright")).toBe(true);
    });

    it("cdp is always available", () => {
      expect(isEngineAvailable("cdp")).toBe(true);
    });

    it("auto is always available", () => {
      expect(isEngineAvailable("auto")).toBe(true);
    });

    it("lightpanda depends on binary", () => {
      const available = isEngineAvailable("lightpanda");
      expect(typeof available).toBe("boolean");
    });
  });

  describe("inferUseCase", () => {
    it("maps scrape to SCRAPE", () => {
      expect(inferUseCase("scrape")).toBe(UseCase.SCRAPE);
    });

    it("maps screenshot to SCREENSHOT", () => {
      expect(inferUseCase("screenshot")).toBe(UseCase.SCREENSHOT);
    });

    it("maps network to NETWORK_MONITOR", () => {
      expect(inferUseCase("network")).toBe(UseCase.NETWORK_MONITOR);
    });

    it("maps har to HAR_CAPTURE", () => {
      expect(inferUseCase("har")).toBe(UseCase.HAR_CAPTURE);
    });

    it("defaults to SPA_NAVIGATE for unknown", () => {
      expect(inferUseCase("unknown-thing")).toBe(UseCase.SPA_NAVIGATE);
    });

    it("is case-insensitive", () => {
      expect(inferUseCase("SCRAPE")).toBe(UseCase.SCRAPE);
    });
  });
});
