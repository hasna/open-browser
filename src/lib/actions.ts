import type { Page } from "playwright";
import { BrowserError, ElementNotFoundError, NavigationError } from "../types/index.js";

export interface ClickOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  delay?: number;
  timeout?: number;
}

export interface TypeOptions {
  delay?: number;
  clear?: boolean;
  timeout?: number;
}

export interface WaitOptions {
  state?: "attached" | "detached" | "visible" | "hidden";
  timeout?: number;
}

export async function click(page: Page, selector: string, opts?: ClickOptions): Promise<void> {
  try {
    await page.click(selector, {
      button: opts?.button ?? "left",
      clickCount: opts?.clickCount ?? 1,
      delay: opts?.delay,
      timeout: opts?.timeout ?? 10000,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      throw new ElementNotFoundError(selector);
    }
    throw new BrowserError(`Click failed on '${selector}': ${err instanceof Error ? err.message : String(err)}`, "CLICK_FAILED");
  }
}

export async function type(page: Page, selector: string, text: string, opts?: TypeOptions): Promise<void> {
  try {
    if (opts?.clear) {
      await page.fill(selector, "", { timeout: opts?.timeout ?? 10000 });
    }
    await page.type(selector, text, { delay: opts?.delay, timeout: opts?.timeout ?? 10000 });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      throw new ElementNotFoundError(selector);
    }
    throw new BrowserError(`Type failed on '${selector}': ${err instanceof Error ? err.message : String(err)}`, "TYPE_FAILED");
  }
}

export async function fill(page: Page, selector: string, value: string, timeout = 10000): Promise<void> {
  try {
    await page.fill(selector, value, { timeout });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function scroll(
  page: Page,
  direction: "up" | "down" | "left" | "right" = "down",
  amount = 300
): Promise<void> {
  const x = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const y = direction === "up" ? -amount : direction === "down" ? amount : 0;
  await page.evaluate(({ x, y }) => window.scrollBy(x, y), { x, y });
}

export async function scrollTo(page: Page, selector: string): Promise<void> {
  try {
    await page.locator(selector).scrollIntoViewIfNeeded();
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function hover(page: Page, selector: string, timeout = 10000): Promise<void> {
  try {
    await page.hover(selector, { timeout });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function selectOption(
  page: Page,
  selector: string,
  value: string,
  timeout = 10000
): Promise<string[]> {
  try {
    return await page.selectOption(selector, value, { timeout });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function checkBox(
  page: Page,
  selector: string,
  checked: boolean,
  timeout = 10000
): Promise<void> {
  try {
    if (checked) {
      await page.check(selector, { timeout });
    } else {
      await page.uncheck(selector, { timeout });
    }
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function uploadFile(
  page: Page,
  selector: string,
  filePaths: string | string[],
  timeout = 10000
): Promise<void> {
  try {
    await page.setInputFiles(selector, filePaths, { timeout });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function goBack(page: Page, timeout = 10000): Promise<void> {
  try {
    await page.goBack({ timeout, waitUntil: "domcontentloaded" });
  } catch (err) {
    throw new NavigationError("back", err instanceof Error ? err.message : String(err));
  }
}

export async function goForward(page: Page, timeout = 10000): Promise<void> {
  try {
    await page.goForward({ timeout, waitUntil: "domcontentloaded" });
  } catch (err) {
    throw new NavigationError("forward", err instanceof Error ? err.message : String(err));
  }
}

export async function reload(page: Page, timeout = 10000): Promise<void> {
  try {
    await page.reload({ timeout, waitUntil: "domcontentloaded" });
  } catch (err) {
    throw new NavigationError("reload", err instanceof Error ? err.message : String(err));
  }
}

export async function navigate(page: Page, url: string, timeout = 30000): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch (err) {
    throw new NavigationError(url, err instanceof Error ? err.message : String(err));
  }
}

export async function waitForSelector(page: Page, selector: string, opts?: WaitOptions): Promise<void> {
  try {
    await page.waitForSelector(selector, {
      state: opts?.state ?? "visible",
      timeout: opts?.timeout ?? 10000,
    });
  } catch (err) {
    throw new ElementNotFoundError(selector);
  }
}

export async function waitForNavigation(page: Page, timeout = 30000): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout });
  } catch (err) {
    throw new NavigationError("navigation", err instanceof Error ? err.message : String(err));
  }
}

export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
}
