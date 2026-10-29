import { create } from "zustand";
import type { Task } from "../lib/bridge";

export type Tab = "tasks" | "agents" | "actions" | "history" | "settings";

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
  /** 任务工作区批量启动弹窗（v0.4） */
  workspace: { open: boolean; task: Task | null };
  openWorkspace: (task: Task) => void;
  closeWorkspace: () => void;
  /** 任务上下文抽屉（v0.5）：现场 / Agent / 关联目标 / 剪贴板 / 动作 */
  context: { open: boolean; task: Task | null };
  openContext: (task: Task) => void;
  closeContext: () => void;
  toast: ToastData | null;
  showToast: (msg: string | null, opts?: { kind?: ToastData["kind"]; action?: ToastAction }) => void;
  dismissToast: () => void;
  quickAddToken: number;
  bumpQuickAdd: () => void;
  /** 剪贴板抽屉（次级面板）：可选携带待关联任务，进入「为任务选择内容」模式 */
  clipboardOpen: boolean;
  clipboardLinkTask: Task | null;
  openClipboard: (opts?: { linkTask?: Task }) => void;
  closeClipboard: () => void;
  /** 任务关联变更计数：任务编辑器据此重读关联列表 */
  clipboardLinkVersion: number;
  bumpClipboardLink: () => void;
}>((set) => ({
  tab: "tasks",
  setTab: (t) => set({ tab: t }),
  editor: { open: false, task: null },
  openEditor: (task) => set({ editor: { open: true, task: task ?? null } }),
  closeEditor: () => set({ editor: { open: false, task: null } }),
  workspace: { open: false, task: null },
  openWorkspace: (task) => set({ workspace: { open: true, task } }),
  closeWorkspace: () => set({ workspace: { open: false, task: null } }),
  context: { open: false, task: null },
  // 抽屉互斥：同一层只保留一个，避免两块次级面板相互遮挡
  openContext: (task) =>
    set({ context: { open: true, task }, clipboardOpen: false, clipboardLinkTask: null }),
  closeContext: () => set({ context: { open: false, task: null } }),
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
  clipboardOpen: false,
  clipboardLinkTask: null,
  openClipboard: (opts) =>
    set({
      clipboardOpen: true,
      clipboardLinkTask: opts?.linkTask ?? null,
      context: { open: false, task: null },
    }),
  closeClipboard: () => set({ clipboardOpen: false, clipboardLinkTask: null }),
  clipboardLinkVersion: 0,
  bumpClipboardLink: () => set((s) => ({ clipboardLinkVersion: s.clipboardLinkVersion + 1 })),
}));
