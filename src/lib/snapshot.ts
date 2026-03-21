import type { Page, Locator } from "playwright";
import type { SnapshotDiff } from "../types/index.js";

// ─── Types (re-exported from types/index.ts) ──────────────────────────────────

export interface RefInfo {
  role: string;
  name: string;
  description?: string;
  visible: boolean;
  enabled: boolean;
  value?: string;
  checked?: boolean;
}

export interface SnapshotResult {
  tree: string;
  refs: Record<string, RefInfo>;
  interactive_count: number;
}

// ─── Per-session last snapshot cache ─────────────────────────────────────────

const lastSnapshots = new Map<string, SnapshotResult>();

export function getLastSnapshot(sessionId: string): SnapshotResult | null {
  return lastSnapshots.get(sessionId) ?? null;
}

export function setLastSnapshot(sessionId: string, snapshot: SnapshotResult): void {
  lastSnapshots.set(sessionId, snapshot);
}

export function clearLastSnapshot(sessionId: string): void {
  lastSnapshots.delete(sessionId);
}

// ─── Per-session ref cache ────────────────────────────────────────────────────

interface CachedRef {
  role: string;
  name: string;
  locatorSelector: string;
}

const sessionRefMaps = new Map<string, Map<string, CachedRef>>();

const INTERACTIVE_ROLES = [
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "menuitem", "menuitemcheckbox", "menuitemradio", "option",
  "searchbox", "slider", "spinbutton", "switch", "tab",
  "treeitem", "listbox", "menu",
];

// ─── Core snapshot function ───────────────────────────────────────────────────

export async function takeSnapshot(page: Page, sessionId?: string): Promise<SnapshotResult> {
  // 1. Get the ARIA snapshot (YAML-like tree from Playwright)
  let ariaTree: string;
  try {
    ariaTree = await page.locator("body").ariaSnapshot();
  } catch {
    ariaTree = "";
  }

  // 2. Discover all interactive elements and assign refs
  const refs: Record<string, RefInfo> = {};
  const refMap = new Map<string, CachedRef>();
  let refCounter = 0;

  for (const role of INTERACTIVE_ROLES) {
    const locators = page.getByRole(role as any);
    const count = await locators.count();

    for (let i = 0; i < count; i++) {
      const el = locators.nth(i);
      let name = "";
      let visible = false;
      let enabled = true;
      let value: string | undefined;
      let checked: boolean | undefined;

      try {
        visible = await el.isVisible();
        if (!visible) continue; // Skip hidden elements
      } catch { continue; }

      try {
        // Get accessible name: aria-label, text content, or title
        name = await el.evaluate((e) => {
          const el = e as HTMLElement;
          return el.getAttribute("aria-label")
            ?? el.textContent?.trim().slice(0, 80)
            ?? el.getAttribute("title")
            ?? el.getAttribute("placeholder")
            ?? "";
        });
      } catch { continue; }

      if (!name) continue; // Skip unnamed elements

      try { enabled = await el.isEnabled(); } catch {}

      try {
        if (role === "checkbox" || role === "radio" || role === "switch") {
          checked = await el.isChecked();
        }
      } catch {}

      try {
        if (role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "combobox") {
          value = await el.inputValue();
        }
      } catch {}

      const ref = `@e${refCounter}`;
      refCounter++;

      refs[ref] = { role, name, visible, enabled, value, checked };

      const escapedName = name.replace(/"/g, '\\"');
      refMap.set(ref, { role, name, locatorSelector: `role=${role}[name="${escapedName}"]` });
    }
  }

  // 3. Inject ref annotations into the ARIA tree string
  let annotatedTree = ariaTree;
  for (const [ref, info] of Object.entries(refs)) {
    // Find the element in the tree text and append the ref
    const escapedName = info.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(${info.role}\\s+"${escapedName.slice(0, 40)}[^"]*")`, "m");
    const match = annotatedTree.match(pattern);
    if (match) {
      annotatedTree = annotatedTree.replace(match[0], `${match[0]} [${ref}]`);
    }
  }

  // If annotation didn't match all refs (common with complex trees), append a ref section
  const unmatchedRefs = Object.entries(refs).filter(([ref]) => !annotatedTree.includes(`[${ref}]`));
  if (unmatchedRefs.length > 0) {
    annotatedTree += "\n\n--- Interactive elements ---";
    for (const [ref, info] of unmatchedRefs) {
      const extras: string[] = [];
      if (info.checked !== undefined) extras.push(`checked=${info.checked}`);
      if (!info.enabled) extras.push("disabled");
      if (info.value) extras.push(`value="${info.value}"`);
      const extrasStr = extras.length ? ` (${extras.join(", ")})` : "";
      annotatedTree += `\n${info.role} "${info.name}" [${ref}]${extrasStr}`;
    }
  }

  // Cache the refMap for this session
  if (sessionId) {
    sessionRefMaps.set(sessionId, refMap);
  }

  return {
    tree: annotatedTree,
    refs,
    interactive_count: refCounter,
  };
}

// ─── Ref resolution ───────────────────────────────────────────────────────────

export function getRefLocator(page: Page, sessionId: string, ref: string): Locator {
  const refMap = sessionRefMaps.get(sessionId);
  if (!refMap) throw new Error(`No snapshot taken for session ${sessionId}. Call browser_snapshot first.`);

  const entry = refMap.get(ref);
  if (!entry) throw new Error(`Ref ${ref} not found. Available refs: ${[...refMap.keys()].slice(0, 20).join(", ")}`);

  return page.getByRole(entry.role as any, { name: entry.name }).first();
}

export function getRefInfo(sessionId: string, ref: string): CachedRef | null {
  const refMap = sessionRefMaps.get(sessionId);
  if (!refMap) return null;
  return refMap.get(ref) ?? null;
}

export function getSessionRefs(sessionId: string): Map<string, CachedRef> | null {
  return sessionRefMaps.get(sessionId) ?? null;
}

export function clearSessionRefs(sessionId: string): void {
  sessionRefMaps.delete(sessionId);
}

export function hasRefs(sessionId: string): boolean {
  return sessionRefMaps.has(sessionId) && (sessionRefMaps.get(sessionId)?.size ?? 0) > 0;
}

// ─── Snapshot diff ───────────────────────────────────────────────────────────
// Compares two snapshots by matching refs on name+role (not ref number, since
// ref numbers reset every snapshot).  Returns added, removed, and modified
// interactive elements plus url/title change flags.

function refKey(info: RefInfo): string {
  return `${info.role}::${info.name}`;
}

export function diffSnapshots(before: SnapshotResult, after: SnapshotResult): SnapshotDiff {
  // Build lookup maps keyed by role::name
  const beforeMap = new Map<string, { ref: string; info: RefInfo }>();
  for (const [ref, info] of Object.entries(before.refs)) {
    beforeMap.set(refKey(info), { ref, info });
  }

  const afterMap = new Map<string, { ref: string; info: RefInfo }>();
  for (const [ref, info] of Object.entries(after.refs)) {
    afterMap.set(refKey(info), { ref, info });
  }

  const added: SnapshotDiff["added"] = [];
  const removed: SnapshotDiff["removed"] = [];
  const modified: SnapshotDiff["modified"] = [];

  // Elements in after but not in before → added
  // Elements in both → check for modifications
  for (const [key, afterEntry] of afterMap) {
    const beforeEntry = beforeMap.get(key);
    if (!beforeEntry) {
      added.push({ ref: afterEntry.ref, info: afterEntry.info });
    } else {
      // Check if any property changed
      const b = beforeEntry.info;
      const a = afterEntry.info;
      if (
        b.visible !== a.visible ||
        b.enabled !== a.enabled ||
        b.value !== a.value ||
        b.checked !== a.checked ||
        b.description !== a.description
      ) {
        modified.push({ ref: afterEntry.ref, before: b, after: a });
      }
    }
  }

  // Elements in before but not in after → removed
  for (const [key, beforeEntry] of beforeMap) {
    if (!afterMap.has(key)) {
      removed.push({ ref: beforeEntry.ref, info: beforeEntry.info });
    }
  }

  // URL / title change detection: extract from tree first lines
  // The ARIA tree doesn't carry URL/title directly, so we compare tree prefixes.
  // A simple heuristic: if the trees differ significantly, something changed.
  const url_changed = before.tree.split("\n")[0] !== after.tree.split("\n")[0];
  const title_changed = before.tree !== after.tree && (added.length > 0 || removed.length > 0 || modified.length > 0);

  return { added, removed, modified, url_changed, title_changed };
}
