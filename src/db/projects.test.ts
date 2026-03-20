import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "./schema.js";
import { createProject, ensureProject, getProject, listProjects, updateProject, deleteProject } from "./projects.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "browser-test-"));
  process.env["BROWSER_DB_PATH"] = join(tmpDir, "test.db");
  process.env["BROWSER_DATA_DIR"] = tmpDir;
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env["BROWSER_DB_PATH"];
  delete process.env["BROWSER_DATA_DIR"];
});

describe("projects CRUD", () => {
  it("creates and retrieves a project", () => {
    const p = createProject({ name: "test-proj", path: "/tmp/test" });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("test-proj");
    expect(p.path).toBe("/tmp/test");
    const fetched = getProject(p.id);
    expect(fetched.id).toBe(p.id);
  });

  it("ensureProject is idempotent", () => {
    const p1 = ensureProject("myapp", "/tmp/myapp");
    const p2 = ensureProject("myapp", "/tmp/myapp");
    expect(p1.id).toBe(p2.id);
  });

  it("lists projects", () => {
    createProject({ name: "a", path: "/a" });
    createProject({ name: "b", path: "/b" });
    expect(listProjects().length).toBeGreaterThanOrEqual(2);
  });

  it("updates a project", () => {
    const p = createProject({ name: "orig", path: "/orig" });
    const updated = updateProject(p.id, { description: "new desc" });
    expect(updated.description).toBe("new desc");
  });

  it("throws ProjectNotFoundError for missing id", () => {
    expect(() => getProject("nonexistent")).toThrow("Project not found");
  });

  it("deletes a project", () => {
    const p = createProject({ name: "to-delete", path: "/tmp/del" });
    deleteProject(p.id);
    expect(() => getProject(p.id)).toThrow();
  });
});
