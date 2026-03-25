/**
 * open-todos integration — queue browser tasks for agents to pick up.
 */

export interface BrowserTask {
  title: string;
  description: string;
  url?: string;
  skill?: string;
  priority?: "low" | "medium" | "high" | "critical";
  assigned_to?: string;
}

// ─── Todos SDK wrapper ────────────────────────────────────────────────────────

async function getTodosSDK() {
  try {
    const mod = await import("@hasna/todos");
    return mod;
  } catch {
    return null;
  }
}

// In-memory fallback (bounded — evicts oldest when full)
const QUEUE_MAX_SIZE = 100;
const inMemoryQueue: Array<BrowserTask & { id: string; status: "pending"; created_at: string }> = [];

// ─── Public API ───────────────────────────────────────────────────────────────

export interface QueuedTask {
  task_id: string;
  title: string;
  status: string;
  queued_at: string;
}

export async function queueBrowserTask(task: BrowserTask): Promise<QueuedTask> {
  const sdk = await getTodosSDK();

  if (sdk?.createTask) {
    try {
      const created = await sdk.createTask({
        title: task.title,
        description: `${task.description}${task.url ? `\n\nURL: ${task.url}` : ""}${task.skill ? `\n\nSkill: ${task.skill}` : ""}`,
        priority: task.priority ?? "medium",
        assigned_to: task.assigned_to,
        tags: ["browser-task"],
      });
      return {
        task_id: created.id ?? created.short_id,
        title: created.title,
        status: created.status,
        queued_at: created.created_at,
      };
    } catch {}
  }

  // In-memory fallback (evict oldest if full)
  if (inMemoryQueue.length >= QUEUE_MAX_SIZE) inMemoryQueue.shift();
  const id = `btask-${Date.now()}`;
  const entry = { ...task, id, status: "pending" as const, created_at: new Date().toISOString() };
  inMemoryQueue.push(entry);
  return { task_id: id, title: task.title, status: "pending", queued_at: entry.created_at };
}

export async function getBrowserTasks(status?: "pending" | "in_progress"): Promise<QueuedTask[]> {
  const sdk = await getTodosSDK();

  if (sdk?.listTasks) {
    try {
      const tasks = await (sdk as any).listTasks({ status, tags: ["browser-task"] });
      return ((tasks as any)?.tasks ?? tasks ?? []).map((t: any) => ({
        task_id: t.id ?? t.short_id,
        title: t.title,
        status: t.status,
        queued_at: t.created_at,
      }));
    } catch {}
  }

  const filtered = status ? inMemoryQueue.filter(t => t.status === status) : inMemoryQueue;
  return filtered.map(t => ({ task_id: t.id, title: t.title, status: t.status, queued_at: t.created_at }));
}

export async function completeBrowserTask(
  taskId: string,
  result: Record<string, unknown>
): Promise<void> {
  const sdk = await getTodosSDK();

  if (sdk?.completeTask) {
    try {
      await (sdk as any).completeTask(taskId, JSON.stringify(result));
      return;
    } catch {}
  }

  const idx = inMemoryQueue.findIndex(t => t.id === taskId);
  if (idx >= 0) inMemoryQueue.splice(idx, 1);
}
