import type { Page } from "playwright";
import type { Cookie } from "playwright";

// ─── Cookies ─────────────────────────────────────────────────────────────────

export async function getCookies(page: Page, filter?: { name?: string; domain?: string }): Promise<Cookie[]> {
  const cookies = await page.context().cookies();
  if (filter?.name) return cookies.filter((c) => c.name === filter.name);
  if (filter?.domain) return cookies.filter((c) => c.domain?.includes(filter.domain!));
  return cookies;
}

export async function setCookie(page: Page, cookie: Cookie): Promise<void> {
  await page.context().addCookies([cookie]);
}

export async function clearCookies(page: Page, filter?: { name?: string; domain?: string }): Promise<void> {
  if (!filter) {
    await page.context().clearCookies();
    return;
  }
  const existing = await getCookies(page, filter);
  // Remove matching by setting expired cookies
  for (const cookie of existing) {
    await page.context().addCookies([{ ...cookie, expires: 0 }]);
  }
}

// ─── Local Storage ───────────────────────────────────────────────────────────

export async function getLocalStorage(page: Page, key?: string): Promise<Record<string, string> | string | null> {
  return page.evaluate((k) => {
    if (k) return localStorage.getItem(k);
    const result: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const itemKey = localStorage.key(i)!;
      result[itemKey] = localStorage.getItem(itemKey)!;
    }
    return result;
  }, key ?? null);
}

export async function setLocalStorage(page: Page, key: string, value: string): Promise<void> {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
}

export async function clearLocalStorage(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear());
}

// ─── Session Storage ─────────────────────────────────────────────────────────

export async function getSessionStorage(page: Page, key?: string): Promise<Record<string, string> | string | null> {
  return page.evaluate((k) => {
    if (k) return sessionStorage.getItem(k);
    const result: Record<string, string> = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const itemKey = sessionStorage.key(i)!;
      result[itemKey] = sessionStorage.getItem(itemKey)!;
    }
    return result;
  }, key ?? null);
}

export async function setSessionStorage(page: Page, key: string, value: string): Promise<void> {
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [key, value]);
}

export async function clearSessionStorage(page: Page): Promise<void> {
  await page.evaluate(() => sessionStorage.clear());
}

// ─── IndexedDB ───────────────────────────────────────────────────────────────

export async function getIndexedDB(
  page: Page,
  dbName: string,
  storeName: string
): Promise<unknown[]> {
  return page.evaluate(
    ([db, store]) =>
      new Promise<unknown[]>((resolve, reject) => {
        const req = indexedDB.open(db);
        req.onsuccess = () => {
          const database = req.result;
          const tx = database.transaction(store, "readonly");
          const objectStore = tx.objectStore(store);
          const all = objectStore.getAll();
          all.onsuccess = () => resolve(all.result as unknown[]);
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
    [dbName, storeName]
  );
}
