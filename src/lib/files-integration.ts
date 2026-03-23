import { join } from "node:path";
import { mkdirSync, copyFileSync } from "node:fs";
import { getDataDir } from "../db/schema.js";

export interface FilePersistResult {
  id: string;
  path: string;
  permanent: boolean;
  provider: "open-files" | "local";
}

export async function persistFile(
  localPath: string,
  opts?: {
    projectId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    type?: string;
  }
): Promise<FilePersistResult> {
  // Try open-files SDK if installed
  try {
    const mod = await import("@hasna/files" as string);
    if (mod?.saveFile) {
      const ref = await (mod.saveFile as Function)(localPath, opts);
      return { id: ref.id, path: ref.path ?? localPath, permanent: true, provider: "open-files" };
    }
  } catch {
    // Not installed — fall back to local persistent dir
  }

  // Fallback: copy to ~/.hasna/browser/persistent/{date}/{filename}
  const dataDir = getDataDir();
  const date = new Date().toISOString().split("T")[0];
  const dir = join(dataDir, "persistent", date);
  mkdirSync(dir, { recursive: true });

  const filename = localPath.split("/").pop() ?? "file";
  const targetPath = join(dir, filename);
  copyFileSync(localPath, targetPath);

  return {
    id: `local-${Date.now()}`,
    path: targetPath,
    permanent: false,
    provider: "local",
  };
}
