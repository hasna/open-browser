import { describe, it, expect } from "bun:test";
import { applyStealthPatches, REALISTIC_USER_AGENT } from "./stealth.js";

describe("stealth module", () => {
  it("exports applyStealthPatches as an async function", () => {
    expect(typeof applyStealthPatches).toBe("function");
  });

  it("exports a realistic Chrome 125 user agent string", () => {
    expect(REALISTIC_USER_AGENT).toContain("Chrome/125");
    expect(REALISTIC_USER_AGENT).toContain("Macintosh");
    expect(REALISTIC_USER_AGENT).toContain("Safari/537.36");
  });

  it("user agent does not contain headless or automation indicators", () => {
    expect(REALISTIC_USER_AGENT).not.toContain("Headless");
    expect(REALISTIC_USER_AGENT).not.toContain("headless");
    expect(REALISTIC_USER_AGENT).not.toContain("Puppeteer");
    expect(REALISTIC_USER_AGENT).not.toContain("Playwright");
  });
});
