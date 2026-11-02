import { create } from "zustand";
import type { Task } from "../lib/bridge";

export type Tab = "tasks" | "agents" | "actions" | "clipboard" | "history" | "settings";

/** 完整模式侧边栏顺序：导航渲染、Ctrl+1…6、快捷键说明共用这一处定义。 */
export const TAB_ORDER: readonly Tab[] = [
  "tasks",
  "agents",
  "actions",
  "clipboard",
  "history",
  "settings",
] as const;

export interface ToastAction {
  label: string;
  run: () => void;
}

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastData {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
  /** 入队时间戳：用于相同消息短时间去重 */
  at: number;
}

/** Toast 队列容量上限：超过时移除最早的普通提示（错误优先保留） */
export const TOAST_QUEUE_MAX = 3;

/** 相同消息（同文案同类型）在该窗口内的重复推送直接忽略 */
const TOAST_DEDUP_MS = 2000;

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
  toasts: ToastData[];
  showToast: (msg: string | null, opts?: { kind?: ToastKind; action?: ToastAction }) => void;
  dismissToast: (id?: number) => void;
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
  toasts: [],
  showToast: (msg, opts) => {
    if (!msg) {
      // 清空语义保持兼容：msg 为空时关闭全部 Toast
      set({ toast: null, toasts: [] });
      return;
    }
    const kind = opts?.kind ?? "info";
    const now = Date.now();
    set((s) => {
      // 相同消息短时间去重：避免重复操作刷出多条相同提示
      const dup = [...s.toasts].reverse().find(
        (t) => t.message === msg && t.kind === kind && now - t.at < TOAST_DEDUP_MS,
      );
      if (dup) {
        return { toast: dup, toasts: s.toasts };
      }
      const next: ToastData = {
        id: (s.toasts.at(-1)?.id ?? s.toast?.id ?? 0) + 1,
        message: msg,
        kind,
        action: opts?.action,
        at: now,
      };
      let toasts = [...s.toasts, next];
      // 队列有上限：先挤掉最早的普通提示，全是关键提示时才挤掉最早的
      if (toasts.length > TOAST_QUEUE_MAX) {
        const victimIdx = toasts.findIndex(
          (t) => t.kind !== "error" && t.kind !== "warning",
        );
        const removeIdx = victimIdx >= 0 ? victimIdx : 0;
        toasts = toasts.filter((_, i) => i !== removeIdx);
      }
      return { toast: next, toasts };
    });
  },
  dismissToast: (id) =>
    set((s) => {
      const toasts = id === undefined ? [] : s.toasts.filter((t) => t.id !== id);
      return { toasts, toast: toasts.at(-1) ?? null };
    }),
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
