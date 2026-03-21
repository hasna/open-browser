import type { Page, Cookie } from "playwright";
import { mkdirSync, existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Profile Types ────────────────────────────────────────────────────────────

export interface ProfileData {
  cookies: Cookie[];
  localStorage: Record<string, string>;
  saved_at: string;
  url?: string;
}

export interface ProfileInfo {
  name: string;
  saved_at: string;
  url?: string;
  cookie_count: number;
  storage_key_count: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getProfilesDir(): string {
  const dataDir = process.env["BROWSER_DATA_DIR"] ?? join(homedir(), ".browser");
  const dir = join(dataDir, "profiles");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getProfileDir(name: string): string {
  return join(getProfilesDir(), name);
}

// ─── Profile Management ──────────────────────────────────────────────────────

export async function saveProfile(page: Page, name: string): Promise<ProfileInfo> {
  const dir = getProfileDir(name);
  mkdirSync(dir, { recursive: true });

  // Save cookies
  const cookies = await page.context().cookies();
  writeFileSync(join(dir, "cookies.json"), JSON.stringify(cookies, null, 2));

  // Save localStorage
  let localStorage: Record<string, string> = {};
  try {
    localStorage = await page.evaluate(() => {
      const result: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)!;
        result[key] = window.localStorage.getItem(key)!;
      }
      return result;
    }) as Record<string, string>;
  } catch {
    // Page may not have a valid origin for localStorage
  }
  writeFileSync(join(dir, "storage.json"), JSON.stringify(localStorage, null, 2));

  const savedAt = new Date().toISOString();
  const url = page.url();

  // Save metadata
  const meta = { saved_at: savedAt, url };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  return {
    name,
    saved_at: savedAt,
    url,
    cookie_count: cookies.length,
    storage_key_count: Object.keys(localStorage).length,
  };
}

export function loadProfile(name: string): ProfileData {
  const dir = getProfileDir(name);
  if (!existsSync(dir)) {
    throw new Error(`Profile not found: ${name}`);
  }

  const cookiesPath = join(dir, "cookies.json");
  const storagePath = join(dir, "storage.json");
  const metaPath = join(dir, "meta.json");

  const cookies: Cookie[] = existsSync(cookiesPath)
    ? JSON.parse(readFileSync(cookiesPath, "utf8"))
    : [];

  const localStorage: Record<string, string> = existsSync(storagePath)
    ? JSON.parse(readFileSync(storagePath, "utf8"))
    : {};

  let savedAt = new Date().toISOString();
  let url: string | undefined;
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    savedAt = meta.saved_at ?? savedAt;
    url = meta.url;
  }

  return { cookies, localStorage, saved_at: savedAt, url };
}

export async function applyProfile(page: Page, profileData: ProfileData): Promise<{ cookies_applied: number; storage_keys_applied: number }> {
  // Apply cookies
  if (profileData.cookies.length > 0) {
    await page.context().addCookies(profileData.cookies);
  }

  // Apply localStorage
  const storageKeys = Object.keys(profileData.localStorage);
  if (storageKeys.length > 0) {
    try {
      await page.evaluate((storage) => {
        for (const [key, value] of Object.entries(storage)) {
          window.localStorage.setItem(key, value);
        }
      }, profileData.localStorage);
    } catch {
      // Page may not have a valid origin for localStorage
    }
  }

  return {
    cookies_applied: profileData.cookies.length,
    storage_keys_applied: storageKeys.length,
  };
}

export function listProfiles(): ProfileInfo[] {
  const dir = getProfilesDir();
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const profiles: ProfileInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const profileDir = join(dir, name);

    let savedAt = "";
    let url: string | undefined;
    let cookieCount = 0;
    let storageKeyCount = 0;

    try {
      const metaPath = join(profileDir, "meta.json");
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        savedAt = meta.saved_at ?? "";
        url = meta.url;
      }
      const cookiesPath = join(profileDir, "cookies.json");
      if (existsSync(cookiesPath)) {
        const cookies = JSON.parse(readFileSync(cookiesPath, "utf8"));
        cookieCount = Array.isArray(cookies) ? cookies.length : 0;
      }
      const storagePath = join(profileDir, "storage.json");
      if (existsSync(storagePath)) {
        const storage = JSON.parse(readFileSync(storagePath, "utf8"));
        storageKeyCount = Object.keys(storage).length;
      }
    } catch {
      // Skip malformed profiles
    }

    profiles.push({
      name,
      saved_at: savedAt,
      url,
      cookie_count: cookieCount,
      storage_key_count: storageKeyCount,
    });
  }

  return profiles.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
}

export function deleteProfile(name: string): boolean {
  const dir = getProfileDir(name);
  if (!existsSync(dir)) return false;

  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
