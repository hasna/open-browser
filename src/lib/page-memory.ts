/**
 * open-mementos integration — cache page facts to avoid re-scraping.
 * Agents call browser_remember after extracting data, browser_recall before navigating.
 */

export interface PageMemory {
  url: string;
  facts: Record<string, unknown>;
  timestamp: string;
  tags?: string[];
}

const MEMORY_KEY_PREFIX = "browser-page:";
const DEFAULT_TTL_HOURS = 24;

// ─── Mementos SDK wrapper ─────────────────────────────────────────────────────

async function getMementosSDK() {
  try {
    const mod = await import("@hasna/mementos");
    return mod;
  } catch {
    return null;
  }
}

// ─── In-memory fallback (when mementos not available) ────────────────────────

const inMemoryCache = new Map<string, { data: PageMemory; expires: number }>();
const MEMORY_MAX_SIZE = 200;

// Sweep expired entries every 5 minutes
const _memorySweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inMemoryCache) {
    if (entry.expires <= now) inMemoryCache.delete(key);
  }
}, 5 * 60_000);
if (_memorySweeper.unref) _memorySweeper.unref();

function cacheKey(url: string): string {
  try {
    const u = new URL(url);
    return `${MEMORY_KEY_PREFIX}${u.hostname}${u.pathname}`;
  } catch {
    return `${MEMORY_KEY_PREFIX}${url}`;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function rememberPage(
  url: string,
  facts: Record<string, unknown>,
  tags?: string[]
): Promise<void> {
  const key = cacheKey(url);
  const memory: PageMemory = { url, facts, timestamp: new Date().toISOString(), tags };

  // Try mementos SDK
  const sdk = await getMementosSDK();
  if (sdk?.createMemory) {
    try {
      await sdk.createMemory({
        key,
        value: JSON.stringify(memory),
        category: "resource",
        scope: "shared",
        importance: 6,
        tags: [...(tags ?? []), "browser-cache", "page-facts"],
        ttl_ms: DEFAULT_TTL_HOURS * 60 * 60 * 1000,
      });
      return;
    } catch { /* fall through to in-memory */ }
  }

  // In-memory fallback (evict oldest if at capacity)
  if (inMemoryCache.size >= MEMORY_MAX_SIZE && !inMemoryCache.has(key)) {
    const firstKey = inMemoryCache.keys().next().value;
    if (firstKey) inMemoryCache.delete(firstKey);
  }
  inMemoryCache.set(key, {
    data: memory,
    expires: Date.now() + DEFAULT_TTL_HOURS * 60 * 60 * 1000,
  });
}

export async function recallPage(
  url: string,
  maxAgeHours = DEFAULT_TTL_HOURS
): Promise<PageMemory | null> {
  const key = cacheKey(url);
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

  // Try mementos SDK
  const sdk = await getMementosSDK();
  if (sdk?.getMemoryByKey) {
    try {
      const mem = await sdk.getMemoryByKey(key);
      if (mem && mem.updated_at > cutoff) {
        return JSON.parse(mem.value) as PageMemory;
      }
    } catch {}
  }

  // In-memory fallback
  const cached = inMemoryCache.get(key);
  if (cached && cached.expires > Date.now()) {
    if (new Date(cached.data.timestamp) > new Date(cutoff)) {
      return cached.data;
    }
  }

  return null;
}

export async function forgetPage(url: string): Promise<void> {
  const key = cacheKey(url);
  inMemoryCache.delete(key);
  // mementos deletion not needed — let TTL handle it
}
