import { describe, it, expect, beforeEach } from "bun:test";
import { diffSnapshots, getLastSnapshot, setLastSnapshot, clearLastSnapshot } from "./snapshot.js";
import type { SnapshotResult } from "./snapshot.js";
import type { RefInfo } from "../types/index.js";

function makeRef(role: string, name: string, overrides: Partial<RefInfo> = {}): RefInfo {
  return {
    role,
    name,
    visible: true,
    enabled: true,
    ...overrides,
  };
}

function makeSnapshot(
  refs: Record<string, RefInfo>,
  tree = "- document\n  - heading 'Test'"
): SnapshotResult {
  return {
    tree,
    refs,
    interactive_count: Object.keys(refs).length,
  };
}

describe("diffSnapshots", () => {
  it("detects added elements", () => {
    const before = makeSnapshot({
      "@e0": makeRef("button", "Submit"),
    });
    const after = makeSnapshot({
      "@e0": makeRef("button", "Submit"),
      "@e1": makeRef("link", "Home"),
    });

    const diff = diffSnapshots(before, after);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].info.name).toBe("Home");
    expect(diff.added[0].info.role).toBe("link");
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects removed elements", () => {
    const before = makeSnapshot({
      "@e0": makeRef("button", "Submit"),
      "@e1": makeRef("link", "Home"),
    });
    const after = makeSnapshot({
      "@e0": makeRef("button", "Submit"),
    });

    const diff = diffSnapshots(before, after);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].info.name).toBe("Home");
    expect(diff.added).toHaveLength(0);
  });

  it("detects modified elements (enabled changed)", () => {
    const before = makeSnapshot({
      "@e0": makeRef("button", "Submit", { enabled: true }),
    });
    const after = makeSnapshot({
      "@e0": makeRef("button", "Submit", { enabled: false }),
    });

    const diff = diffSnapshots(before, after);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].before.enabled).toBe(true);
    expect(diff.modified[0].after.enabled).toBe(false);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("detects modified elements (value changed)", () => {
    const before = makeSnapshot({
      "@e0": makeRef("textbox", "Email", { value: "" }),
    });
    const after = makeSnapshot({
      "@e0": makeRef("textbox", "Email", { value: "test@test.com" }),
    });

    const diff = diffSnapshots(before, after);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].before.value).toBe("");
    expect(diff.modified[0].after.value).toBe("test@test.com");
  });

  it("detects modified elements (checked changed)", () => {
    const before = makeSnapshot({
      "@e0": makeRef("checkbox", "Remember me", { checked: false }),
    });
    const after = makeSnapshot({
      "@e0": makeRef("checkbox", "Remember me", { checked: true }),
    });

    const diff = diffSnapshots(before, after);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].before.checked).toBe(false);
    expect(diff.modified[0].after.checked).toBe(true);
  });

  it("matches elements by role+name, not ref number", () => {
    // Before has @e0=Submit, @e1=Cancel
    // After has @e0=Cancel (different ref number but same role+name)
    const before = makeSnapshot({
      "@e0": makeRef("button", "Submit"),
      "@e1": makeRef("button", "Cancel"),
    });
    const after = makeSnapshot({
      "@e0": makeRef("button", "Cancel"),
    });

    const diff = diffSnapshots(before, after);
    // Submit was removed, Cancel is still there
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].info.name).toBe("Submit");
    expect(diff.added).toHaveLength(0);
  });

  it("returns empty diff for identical snapshots", () => {
    const snap = makeSnapshot({
      "@e0": makeRef("button", "Submit"),
      "@e1": makeRef("link", "Home"),
    });

    const diff = diffSnapshots(snap, snap);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("handles empty snapshots", () => {
    const before = makeSnapshot({});
    const after = makeSnapshot({});

    const diff = diffSnapshots(before, after);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects url_changed from tree differences", () => {
    const before = makeSnapshot(
      { "@e0": makeRef("button", "Submit") },
      "- document 'Page A'\n  - button 'Submit'"
    );
    const after = makeSnapshot(
      { "@e0": makeRef("button", "Go Back") },
      "- document 'Page B'\n  - button 'Go Back'"
    );

    const diff = diffSnapshots(before, after);
    expect(diff.url_changed).toBe(true);
  });

  it("handles complex mixed changes", () => {
    const before = makeSnapshot({
      "@e0": makeRef("button", "Submit"),
      "@e1": makeRef("textbox", "Name", { value: "Alice" }),
      "@e2": makeRef("link", "Old Link"),
    });
    const after = makeSnapshot({
      "@e0": makeRef("button", "Submit"),
      "@e1": makeRef("textbox", "Name", { value: "Bob" }),
      "@e3": makeRef("link", "New Link"),
    });

    const diff = diffSnapshots(before, after);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].info.name).toBe("New Link");
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].info.name).toBe("Old Link");
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].before.value).toBe("Alice");
    expect(diff.modified[0].after.value).toBe("Bob");
  });
});

describe("last snapshot cache", () => {
  const sessionId = "test-session-123";

  beforeEach(() => {
    clearLastSnapshot(sessionId);
  });

  it("returns null when no snapshot cached", () => {
    expect(getLastSnapshot(sessionId)).toBeNull();
  });

  it("stores and retrieves a snapshot", () => {
    const snap = makeSnapshot({ "@e0": makeRef("button", "OK") });
    setLastSnapshot(sessionId, snap);
    expect(getLastSnapshot(sessionId)).toEqual(snap);
  });

  it("overwrites previous snapshot", () => {
    const snap1 = makeSnapshot({ "@e0": makeRef("button", "OK") });
    const snap2 = makeSnapshot({ "@e0": makeRef("button", "Cancel") });
    setLastSnapshot(sessionId, snap1);
    setLastSnapshot(sessionId, snap2);
    expect(getLastSnapshot(sessionId)?.refs["@e0"].name).toBe("Cancel");
  });

  it("clears snapshot", () => {
    const snap = makeSnapshot({ "@e0": makeRef("button", "OK") });
    setLastSnapshot(sessionId, snap);
    clearLastSnapshot(sessionId);
    expect(getLastSnapshot(sessionId)).toBeNull();
  });

  it("isolates different sessions", () => {
    const snap1 = makeSnapshot({ "@e0": makeRef("button", "A") });
    const snap2 = makeSnapshot({ "@e0": makeRef("button", "B") });
    setLastSnapshot("session-1", snap1);
    setLastSnapshot("session-2", snap2);
    expect(getLastSnapshot("session-1")?.refs["@e0"].name).toBe("A");
    expect(getLastSnapshot("session-2")?.refs["@e0"].name).toBe("B");
  });
});
