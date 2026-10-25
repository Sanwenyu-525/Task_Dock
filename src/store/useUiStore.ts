import { create } from "zustand";
import type { Task } from "../lib/bridge";

export type Tab = "tasks" | "agents" | "history" | "settings";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastData {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
  action?: ToastAction;
}

export const useUiStore = create<{
  tab: Tab;
  setTab: (t: Tab) => void;
  editor: { open: boolean; task: Task | null };
  openEditor: (task?: Task) => void;
  closeEditor: () => void;
  toast: ToastData | null;
  showToast: (msg: string | null, opts?: { kind?: ToastData["kind"]; action?: ToastAction }) => void;
  dismissToast: () => void;
  quickAddToken: number;
  bumpQuickAdd: () => void;
}>((set) => ({
  tab: "tasks",
  setTab: (t) => set({ tab: t }),
  editor: { open: false, task: null },
  openEditor: (task) => set({ editor: { open: true, task: task ?? null } }),
  closeEditor: () => set({ editor: { open: false, task: null } }),
  toast: null,
  showToast: (msg, opts) => {
    if (!msg) {
      set({ toast: null });
      return;
    }
    set((s) => ({
      toast: {
        id: (s.toast?.id ?? 0) + 1,
        message: msg,
        kind: opts?.kind ?? "info",
        action: opts?.action,
      },
    }));
  },
  dismissToast: () => set({ toast: null }),
  quickAddToken: 0,
  bumpQuickAdd: () => set((s) => ({ quickAddToken: s.quickAddToken + 1 })),
}));
