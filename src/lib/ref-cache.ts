/**
 * Element ref cache — stores snapshot refs in mementos so repeat page visits
 * skip the snapshot entirely (0 tokens for known pages).
 */

import type { RefInfo } from "../types/index.js";

const REF_CACHE_PREFIX = "browser-refs:";
const REF_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REF_CACHE_MAX_SIZE = 500;

// In-memory L1 cache (always available, fast)
const l1Cache = new Map<string, { refs: Record<string, RefInfo>; expires: number }>();

// Periodic sweep of expired entries (every 5 minutes)
const l1Sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of l1Cache) {
    if (entry.expires <= now) l1Cache.delete(key);
  }
}, 5 * 60_000);
if (l1Sweeper.unref) l1Sweeper.unref();

function cacheKey(url: string): string {
  try {
    const u = new URL(url);
    return `${REF_CACHE_PREFIX}${u.hostname}${u.pathname}`;
  } catch {
    return `${REF_CACHE_PREFIX}${url}`;
  }
}

async function getMementosSDK() {
  try { return await import("@hasna/mementos"); } catch { return null; }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function cacheRefs(url: string, refs: Record<string, RefInfo>): Promise<void> {
  const key = cacheKey(url);
  const expires = Date.now() + REF_CACHE_TTL_MS;

  // Evict oldest entries if at capacity
  if (l1Cache.size >= REF_CACHE_MAX_SIZE && !l1Cache.has(key)) {
    const firstKey = l1Cache.keys().next().value;
    if (firstKey) l1Cache.delete(firstKey);
  }

  // Always write L1
  l1Cache.set(key, { refs, expires });

  // Write to mementos L2 for cross-session persistence
  const sdk = await getMementosSDK();
  if (sdk?.createMemory) {
    try {
      await sdk.createMemory({
        key,
        value: JSON.stringify(refs),
        category: "knowledge",
        scope: "shared",
        importance: 5,
        tags: ["browser-refs", "element-cache"],
        ttl_ms: REF_CACHE_TTL_MS,
      });
    } catch {}
  }
}

export async function getCachedRefs(url: string): Promise<Record<string, RefInfo> | null> {
  const key = cacheKey(url);

  // Check L1 first (fastest)
  const l1 = l1Cache.get(key);
  if (l1) {
    if (l1.expires > Date.now()) return l1.refs;
    // Evict expired entry
    l1Cache.delete(key);
  }

  // Check L2 (mementos)
  const sdk = await getMementosSDK();
  if (sdk?.getMemoryByKey) {
    try {
      const mem = await sdk.getMemoryByKey(key);
      if (mem) {
        const refs = JSON.parse(mem.value) as Record<string, RefInfo>;
        // Populate L1 for next time
        l1Cache.set(key, { refs, expires: Date.now() + REF_CACHE_TTL_MS });
        return refs;
      }
    } catch {}
  }

  return null;
}

export function invalidateRefCache(url?: string): void {
  if (url) {
    l1Cache.delete(cacheKey(url));
  } else {
    // Clear all browser-refs entries
    for (const key of l1Cache.keys()) {
      if (key.startsWith(REF_CACHE_PREFIX)) l1Cache.delete(key);
    }
  }
}
