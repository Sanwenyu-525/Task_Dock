import { create } from "zustand";
import type { Task } from "../lib/bridge";
import { activeTabGuard } from "../lib/tabGuard";

export type Tab =
  | "workbench"
  | "workspace"
  | "tasks"
  | "agents"
  | "apps"
  | "widgets"
  | "actions"
  | "clipboard"
  | "mobile"
  | "inbox"
  | "shelf"
  | "workflows"
  | "history"
  | "roadmap"
  | "settings"
  | "help"
  | "diagnostics"
  | "resource";

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
 * 开发工作台（workbench）是开发模式的主要入口（任务优先布局），位于最前；
 * 它不占用 Ctrl+数字，因此与 `TAB_ORDER` 分离，避免已有快捷键语义漂移。
 * v0.10 新增「应用」入口（位于 Agent 之后、行动之前）；它不占用 Ctrl+数字，
 * 因此与 `TAB_ORDER` 分离，避免已有快捷键语义漂移。
 * 帮助中心（help）同为仅视觉入口（settings 之前），不占 Ctrl+数字。
 * 诊断中心（diagnostics）默认隐藏、不占快捷键，位于帮助之后、设置之前。
 * 资源管理（resource）是默认可见的普通入口（默认顺序在 settings 之前），不占快捷键。
 * 手机互传（mobile）是从设置里提出来的操作入口，位于剪贴板之后、收集与暂存之前，
 * 不占快捷键。
 */
export const RAIL_ORDER: readonly Tab[] = [
  "workbench",
  "workspace",
  "tasks",
  "agents",
  "apps",
  "widgets",
  "actions",
  "clipboard",
  "mobile",
  "inbox",
  "shelf",
  "workflows",
  "history",
  "roadmap",
  "help",
  "diagnostics",
  "resource",
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

/** 工具面板逐项粘贴意图有效期：导航被取消/页面异常时不会在很久以后突然弹层。 */
export const CLIPBOARD_PASTE_REQUEST_TTL_MS = 15_000;
/** 规划中心精确定位意图的有效期：导航事务完成后立即消费，过期即作废。 */
export const ROADMAP_FOCUS_REQUEST_TTL_MS = 15_000;

/**
 * 跨 Tab 切换的待决导航：编辑中有未保存改动时只记录目标，等用户明确选择。
 * `after` 用于「打开编辑器」这类需要与切页一起完成的程序化导航。
 */
export interface PendingTabNav {
  tab: Tab;
  guardId: string;
  after: (() => void) | null;
  /**
   * 用户对待决导航做出最终选择时回调：`confirmed` 在切页之后调用
   * （after 抛错也保证调用），`cancelled` 不切页。跨窗口导航事务用它把
   * 「pending」变成确定的最终结果，避免调用方只能等到超时。
   */
  onResolve?: ((result: "confirmed" | "cancelled") => void) | null;
}

/**
 * 导航事务结果：
 * - switched：已切页（after 已同步执行）
 * - pending：被未保存草稿拦截，等待用户确认/取消（after 绑定在 pendingTab 上）
 * - blocked：当前页面正在保存等硬拒绝，未切页且不会排队
 */
export type TabSwitchResult = "switched" | "pending" | "blocked";

export const useUiStore = create<{
  tab: Tab;
  setTab: (
    t: Tab,
    opts?: { force?: boolean; after?: () => void; onResolve?: (result: "confirmed" | "cancelled") => void },
  ) => TabSwitchResult;
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
  /**
   * 只写入编辑器状态，**不做导航**：供「导航成功之后」的 after 回调使用。
   * 需要跨页打开编辑器时用 `openEditor`（内部仍走 setTab 门禁）；已经自行
   * 完成导航事务的调用方（如胶囊 `openTaskEditor`）用本方法，避免二次导航
   * 覆盖待确认导航绑定的 after，导致编辑意图丢失。
   */
  openEditorNow: (task?: Task | null) => void;
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
  /**
   * 工具面板「逐项粘贴」的一次性意图：携带截图组身份，切到完整剪贴板页后
   * 由 ClipboardWorkspace 打开既有 PastePanel（复用目标选择与粘贴状态机）。
   */
  clipboardPasteRequest: {
    token: number;
    groupId: string;
    groupName: string;
    /** 一次性意图有效期：导航/页面异常时不会在很久以后突然弹层。 */
    expiresAt: number;
  } | null;
  requestClipboardPaste: (groupId: string, groupName: string) => void;
  clearClipboardPasteRequest: () => void;
  /**
   * 打开帮助中心指定教程的一次性意图（如 ContextHelpButton「查看完整教程」）：
   * 调用方先 setTab("help")，HelpCenterPanel 挂载/收到新 token 时消费并清除。
   */
  helpOpenRequest: { token: number; articleId: string } | null;
  requestHelpArticle: (articleId: string) => void;
  clearHelpArticleRequest: () => void;
  /** 从上下文帮助或设置入口进入帮助中心的来源页；离开 help Tab 时自动清空。 */
  helpReturnTab: Tab | null;
  setHelpReturnTab: (tab: Tab | null) => void;
  /**
   * 收集箱投递结果条「查看诊断」的一次性意图：携带批次 operation_id。
   * 由 DiagnosticsCenterPanel 在挂载/收到新 token 时消费并清除，
   * 避免下次进入诊断中心重复定位同一个操作链。
   */
  diagnosticsOperationRequest: { token: number; operationId: string } | null;
  requestDiagnosticsOperation: (operationId: string) => void;
  /** 取走一次性意图并清除；没有或已被消费时返回 null。 */
  consumeDiagnosticsOperation: () => string | null;
  /**
   * 工具面板「规划中心」发起的一次性精确定位意图：携带项目/功能（可选里程碑）。
   * 由 PlanningWorkspace 在挂载或收到新 token 时消费一次并清除；
   * 带 TTL：导航或页面异常时不会在很久以后突然跳到旧位置。
   */
  roadmapFocusRequest: {
    token: number;
    projectId: string;
    featureId?: string;
    milestoneId?: string;
    expiresAt: number;
  } | null;
  requestRoadmapFocus: (target: {
    projectId: string;
    featureId?: string;
    milestoneId?: string;
  }) => void;
  /** 取走一次性定位意图并清除；没有、已消费或已过期时返回 null。 */
  consumeRoadmapFocus: () => {
    projectId: string;
    featureId?: string;
    milestoneId?: string;
  } | null;
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
          return "blocked";
        }
        if (guard.isDirty()) {
          set({
            pendingTab: {
              tab: t,
              guardId: guard.id,
              after: opts?.after ?? null,
              onResolve: opts?.onResolve ?? null,
            },
          });
          return "pending";
        }
      }
    }
    set((s) => ({
      tab: t,
      collectionSub: t === "inbox" || t === "shelf" ? t : s.collectionSub,
      pendingTab: null,
      helpReturnTab: t === "help" ? s.helpReturnTab : null,
    }));
    opts?.after?.();
    return "switched";
  },
  pendingTab: null,
  confirmPendingTab: () => {
    const pending = get().pendingTab;
    if (!pending) return;
    const guard = activeTabGuard();
    if (guard && guard.id === pending.guardId) guard.discard();
    set({ pendingTab: null });
    try {
      get().setTab(pending.tab, { force: true, after: pending.after ?? undefined });
    } finally {
      // 无论 after 是否抛错，「用户已确认」这个最终态都要回传。
      pending.onResolve?.("confirmed");
    }
  },
  cancelPendingTab: () => {
    const pending = get().pendingTab;
    set({ pendingTab: null });
    pending?.onResolve?.("cancelled");
  },
  collectionSub: "inbox",
  setCollectionSub: (sub) => set({ collectionSub: sub }),
  editor: { open: false, task: null },
  // 编辑态由任务面板（TasksPanel）在页面内承载：从其他页（如小组件）打开时切回任务页，
  // 否则编辑表单没有宿主。
  // 同样经过 setTab 门禁：其他页有未保存草稿时不能静默切走并卸载它。
  openEditor: (task) => get().setTab("tasks", { after: () => get().openEditorNow(task) }),
  openEditorNow: (task) => set({ editor: { open: true, task: task ?? null } }),
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
  clipboardPasteRequest: null,
  requestClipboardPaste: (groupId, groupName) =>
    set((s) => ({
      clipboardPasteRequest: {
        token: (s.clipboardPasteRequest?.token ?? 0) + 1,
        groupId,
        groupName,
        expiresAt: Date.now() + CLIPBOARD_PASTE_REQUEST_TTL_MS,
      },
    })),
  clearClipboardPasteRequest: () => set({ clipboardPasteRequest: null }),
  helpOpenRequest: null,
  requestHelpArticle: (articleId) =>
    set((s) => ({
      helpOpenRequest: {
        token: (s.helpOpenRequest?.token ?? 0) + 1,
        articleId,
      },
    })),
  clearHelpArticleRequest: () => set({ helpOpenRequest: null }),
  helpReturnTab: null,
  setHelpReturnTab: (helpReturnTab) => set({ helpReturnTab }),
  diagnosticsOperationRequest: null,
  requestDiagnosticsOperation: (operationId) =>
    set((s) => ({
      diagnosticsOperationRequest: {
        token: (s.diagnosticsOperationRequest?.token ?? 0) + 1,
        operationId,
      },
    })),
  consumeDiagnosticsOperation: () => {
    const request = get().diagnosticsOperationRequest;
    if (!request) return null;
    set({ diagnosticsOperationRequest: null });
    return request.operationId;
  },
  roadmapFocusRequest: null,
  requestRoadmapFocus: ({ projectId, featureId, milestoneId }) =>
    set((s) => ({
      roadmapFocusRequest: {
        token: (s.roadmapFocusRequest?.token ?? 0) + 1,
        projectId,
        featureId,
        milestoneId,
        expiresAt: Date.now() + ROADMAP_FOCUS_REQUEST_TTL_MS,
      },
    })),
  consumeRoadmapFocus: () => {
    const request = get().roadmapFocusRequest;
    if (!request) return null;
    set({ roadmapFocusRequest: null });
    if (Date.now() > request.expiresAt) return null;
    return {
      projectId: request.projectId,
      featureId: request.featureId,
      milestoneId: request.milestoneId,
    };
  },
}));
