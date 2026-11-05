import { create } from "zustand";
import type { Task } from "../lib/bridge";
import { activeTabGuard } from "../lib/tabGuard";

export type Tab =
  | "tasks"
  | "agents"
  | "apps"
  | "widgets"
  | "actions"
  | "clipboard"
  | "inbox"
  | "shelf"
  | "workflows"
  | "history"
  | "roadmap"
  | "settings";

/**
 * 快捷键逻辑顺序：Ctrl+1…9 映射前九个逻辑 Tab、Ctrl+0=设置。
 * **已发布语义，禁止因视觉入口调整而改变**（新增入口默认不占用数字键）。
 */
export const TAB_ORDER: readonly Tab[] = [
  "tasks",
  "agents",
  "actions",
  "clipboard",
  "inbox",
  "shelf",
  "workflows",
  "history",
  "roadmap",
  "settings",
] as const;

/**
 * 完整模式侧边栏视觉顺序：导航渲染、提示与文档共用这一处定义。
 * v0.10 新增「应用」入口（位于 Agent 之后、行动之前）；它不占用 Ctrl+数字，
 * 因此与 `TAB_ORDER` 分离，避免已有快捷键语义漂移。
 */
export const RAIL_ORDER: readonly Tab[] = [
  "tasks",
  "agents",
  "apps",
  "widgets",
  "actions",
  "clipboard",
  "inbox",
  "shelf",
  "workflows",
  "history",
  "roadmap",
  "settings",
] as const;

export interface ToastAction {
  label: string;
  run: () => void;
}

export type ToastKind = "info" | "success" | "warning" | "error";

/** 桌面通知点击「定位本轮」：主窗口据此展开 Agent 树并滚动/高亮到具体轮次。 */
export interface AgentFocusTarget {
  sourceId: string;
  sessionId: string;
  refId: string | null;
  /** 每次请求自增，便于同一对象重复定位时重新触发（不依赖时间戳碰撞）。 */
  token: number;
}

export interface ToastData {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
  /** 稳定错误码：去重与诊断依据优先于文案 */
  code?: string;
  /** 可核验的技术细节（悬停可见），不进入正文 */
  detail?: string;
  /** 入队时间戳：用于相同消息短时间去重 */
  at: number;
}

/** Toast 队列容量上限：超过时移除最早的普通提示（错误优先保留） */
export const TOAST_QUEUE_MAX = 3;

/** 相同根因（同错误码同文案）在该窗口内的重复推送直接忽略 */
const TOAST_DEDUP_MS = 2000;

/**
 * 跨 Tab 切换的待决导航：编辑中有未保存改动时只记录目标，等用户明确选择。
 * `after` 用于「打开编辑器」这类需要与切页一起完成的程序化导航。
 */
export interface PendingTabNav {
  tab: Tab;
  guardId: string;
  after: (() => void) | null;
}

export const useUiStore = create<{
  tab: Tab;
  setTab: (t: Tab, opts?: { force?: boolean; after?: () => void }) => void;
  /** 有待决的未保存切换时，由全局确认条消费 */
  pendingTab: PendingTabNav | null;
  confirmPendingTab: () => void;
  cancelPendingTab: () => void;
  /**
   * 「收集与暂存」合并入口的子页状态（v0.8）：inbox=快速收集 / shelf=文件暂存 /
   * notes=快速笔记（仅子页，不占用逻辑 Tab 与 Ctrl+数字）。
   * setTab(inbox|shelf) 时幂等同步；点击合并入口回打开上一次的子页（默认 inbox）。
   */
  collectionSub: "inbox" | "shelf" | "notes";
  setCollectionSub: (sub: "inbox" | "shelf" | "notes") => void;
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
  showToast: (
    msg: string | null,
    opts?: { kind?: ToastKind; action?: ToastAction; code?: string; detail?: string },
  ) => void;
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
  /** 通知跳转的 Agent 定位目标（只消费一次，AgentPanel 处理后清除） */
  agentFocus: AgentFocusTarget | null;
  focusAgent: (target: Omit<AgentFocusTarget, "token">) => void;
  clearAgentFocus: () => void;
  /**
   * 工具面板「应用」页发起的一次性配置意图：
   * picker = 打开应用选择器（添加/编辑目标）；manage = 定位到应用管理区。
   * 由设置页消费后清除，避免反复自动弹出。
   */
  appConfig: { kind: "picker" | "manage"; token: number } | null;
  requestAppConfig: (kind: "picker" | "manage") => void;
  clearAppConfig: () => void;
  /**
   * 胶囊「+」的一进应用中心添加页意图（只消费一次）。
   * 由 AppsPanel 在挂载/收到新 token 时消费并清除，避免返回或取消后自动重开。
   */
  appsAddRequest: { token: number } | null;
  requestAppsAdd: () => void;
  clearAppsAddRequest: () => void;
}>((set, get) => ({
  tab: "tasks",
  // 收集箱/暂存架是同一视觉入口的两个子页：setTab 落到其中之一时同步子页状态，
  // 其余 Tab 不改动上次子页选择（合并入口「回到上次子页」的语义依据）。
  // 门禁：编辑器有未保存改动时只记录目标；保存中直接拒绝切换并说明原因。
  setTab: (t, opts) => {
    const state = get();
    // 同 Tab 内通过 `after` 重新打开编辑器（如小组件「新建任务」）也会替换草稿，同样需要门禁。
    if (!opts?.force && (t !== state.tab || Boolean(opts?.after))) {
      const guard = activeTabGuard();
      if (guard) {
        if (guard.isBusy()) {
          state.showToast("正在保存，请等待完成后再切换页面", {
            kind: "warning",
            code: "tab-guard-busy",
          });
          return;
        }
        if (guard.isDirty()) {
          set({ pendingTab: { tab: t, guardId: guard.id, after: opts?.after ?? null } });
          return;
        }
      }
    }
    set((s) => ({
      tab: t,
      collectionSub: t === "inbox" || t === "shelf" ? t : s.collectionSub,
      pendingTab: null,
    }));
    opts?.after?.();
  },
  pendingTab: null,
  confirmPendingTab: () => {
    const pending = get().pendingTab;
    if (!pending) return;
    const guard = activeTabGuard();
    if (guard && guard.id === pending.guardId) guard.discard();
    set({ pendingTab: null });
    get().setTab(pending.tab, { force: true, after: pending.after ?? undefined });
  },
  cancelPendingTab: () => set({ pendingTab: null }),
  collectionSub: "inbox",
  setCollectionSub: (sub) => set({ collectionSub: sub }),
  editor: { open: false, task: null },
  // 编辑态由任务面板（TasksPanel）在页面内承载：从其他页（如小组件）打开时切回任务页，
  // 否则编辑表单没有宿主。
  // 同样经过 setTab 门禁：其他页有未保存草稿时不能静默切走并卸载它。
  openEditor: (task) =>
    get().setTab("tasks", {
      after: () => set({ editor: { open: true, task: task ?? null } }),
    }),
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
      // 相同根因去重：优先错误码 + 文案，避免轮询/重复点击刷屏
      const dup = [...s.toasts].reverse().find((t) => {
        const sameCode = opts?.code ? t.code === opts.code : true;
        return t.message === msg && t.kind === kind && sameCode && now - t.at < TOAST_DEDUP_MS;
      });
      if (dup) {
        return { toast: dup, toasts: s.toasts };
      }
      const next: ToastData = {
        id: (s.toasts.at(-1)?.id ?? s.toast?.id ?? 0) + 1,
        message: msg,
        kind,
        action: opts?.action,
        code: opts?.code,
        detail: opts?.detail,
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
  agentFocus: null,
  focusAgent: (target) =>
    set((s) => ({
      agentFocus: { ...target, token: (s.agentFocus?.token ?? 0) + 1 },
    })),
  clearAgentFocus: () => set({ agentFocus: null }),
  appConfig: null,
  requestAppConfig: (kind) =>
    set((s) => ({ appConfig: { kind, token: (s.appConfig?.token ?? 0) + 1 } })),
  clearAppConfig: () => set({ appConfig: null }),
  appsAddRequest: null,
  requestAppsAdd: () =>
    set((s) => ({ appsAddRequest: { token: (s.appsAddRequest?.token ?? 0) + 1 } })),
  clearAppsAddRequest: () => set({ appsAddRequest: null }),
}));
