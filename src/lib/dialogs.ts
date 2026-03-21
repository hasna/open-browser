import type { Page, Dialog } from "playwright";

// ─── Dialog Info ──────────────────────────────────────────────────────────────

export interface DialogInfo {
  type: string;
  message: string;
  default_value: string;
  timestamp: string;
}

// ─── Pending dialog store ─────────────────────────────────────────────────────

interface PendingDialog {
  dialog: Dialog;
  info: DialogInfo;
  autoTimer: ReturnType<typeof setTimeout>;
}

const pendingDialogs = new Map<string, PendingDialog[]>();

const AUTO_DISMISS_MS = 5000;

// ─── Dialog Handling ──────────────────────────────────────────────────────────

export function setupDialogHandler(page: Page, sessionId: string): () => void {
  const onDialog = (dialog: Dialog) => {
    const info: DialogInfo = {
      type: dialog.type(),
      message: dialog.message(),
      default_value: dialog.defaultValue(),
      timestamp: new Date().toISOString(),
    };

    // Auto-dismiss after 5s to prevent blocking
    const autoTimer = setTimeout(() => {
      try {
        dialog.dismiss().catch(() => {});
      } catch {
        // Dialog may have already been handled
      }
      // Remove from pending
      const list = pendingDialogs.get(sessionId);
      if (list) {
        const idx = list.findIndex((p) => p.dialog === dialog);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) pendingDialogs.delete(sessionId);
      }
    }, AUTO_DISMISS_MS);

    const pending: PendingDialog = { dialog, info, autoTimer };

    if (!pendingDialogs.has(sessionId)) {
      pendingDialogs.set(sessionId, []);
    }
    pendingDialogs.get(sessionId)!.push(pending);
  };

  page.on("dialog", onDialog);

  return () => {
    page.off("dialog", onDialog);
    // Clean up any pending auto-timers
    const list = pendingDialogs.get(sessionId);
    if (list) {
      for (const p of list) clearTimeout(p.autoTimer);
      pendingDialogs.delete(sessionId);
    }
  };
}

export function getDialogs(sessionId: string): DialogInfo[] {
  const list = pendingDialogs.get(sessionId);
  if (!list) return [];
  return list.map((p) => p.info);
}

export async function handleDialog(
  sessionId: string,
  action: "accept" | "dismiss",
  promptText?: string
): Promise<{ handled: boolean; dialog?: DialogInfo }> {
  const list = pendingDialogs.get(sessionId);
  if (!list || list.length === 0) {
    return { handled: false };
  }

  // Handle the oldest pending dialog (FIFO)
  const pending = list.shift()!;
  clearTimeout(pending.autoTimer);

  if (list.length === 0) {
    pendingDialogs.delete(sessionId);
  }

  try {
    if (action === "accept") {
      await pending.dialog.accept(promptText);
    } else {
      await pending.dialog.dismiss();
    }
  } catch {
    // Dialog may have been auto-dismissed already
  }

  return { handled: true, dialog: pending.info };
}

export function clearDialogs(sessionId: string): void {
  const list = pendingDialogs.get(sessionId);
  if (list) {
    for (const p of list) {
      clearTimeout(p.autoTimer);
      try { p.dialog.dismiss().catch(() => {}); } catch {}
    }
    pendingDialogs.delete(sessionId);
  }
}
