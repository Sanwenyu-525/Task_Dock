//! 文件工作区状态（工作台窗口内独立 store）。
//!
//! 职责边界（第三轮明确拆分，任务规范 §三）：
//! - **目录会话**：打开的目录、标签 ID、当前路径、导航历史、激活标签、视图/排序/搜索、
//!   用户固定的目录、最近目录、容量收纳标签——属于用户的工作内容，布局操作不得销毁；
//! - **布局**：分割树、分栏方向、比例、标签到窗格的分配、活动区域、最大化——属于内容的
//!   组织方式，可以整体替换（并进入撤销栈）；
//! - 树形状与窗格状态在本 store；目录列表数据在 `dirCache`（按路径缓存，不重复拉取）；
//! - 持久化经 `filesWorkspace/persist.ts` 串行写入设置键（防抖 600ms），保存分割树、
//!   每窗格标签路径与激活标签、固定/最近目录、收纳标签；撤销栈只在本会话内有效；
//! - 布局撤销只恢复布局与标签分配，**不撤销真实文件系统操作**（复制/移动/删除从不入栈）。

import { create } from "zustand";

import {
  MAX_TABS_PER_PANE,
  adjacentPaneId,
  defaultTree,
  duplicateTab,
  freshId,
  hasPane,
  normalizeTree,
  paneIds,
  removePane,
  reassignPaneIds,
  splitPane as splitPaneInTree,
  swapPaneWithSibling,
  swapPanes as swapPanesInTree,
  updateRatio as updateRatioInTree,
  type SplitDirection,
  type SplitNode,
  LAYOUT_PRESETS,
} from "../lib/filesWorkspace/model";
import {
  sameLayoutShape,
  planTabTransfer,
  type TransferSource,
} from "../lib/filesWorkspace/layoutTransfer";
import {
  basename,
  isSubPath,
  normalizePath,
  parentOf,
  samePath,
} from "../lib/filesWorkspace/pathUtils";
import {
  MAX_PINNED_DIRS,
  MAX_RECENT,
  MAX_RECENT_DIRS,
  MAX_STASHED_TABS,
  MAX_TEMPLATES,
  bindSettingsStore,
  persistFilesWorkspace,
  readFilesWorkspacePersisted,
  type FilesWorkspacePersisted,
  type PersistedPane,
  type PersistedState,
  type PersistedTab,
} from "../lib/filesWorkspace/persist";
import type { ColWidths } from "../lib/filesWorkspace/columnWidths";
import { invalidateDirs } from "../lib/filesWorkspace/dirCache";
import { useSettingsStore } from "./useSettingsStore";

export type ViewMode = "list" | "grid";
export type SortField = "name" | "modified" | "type" | "size";
export type FileFilter =
  | "all"
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "doc"
  | "sheet"
  | "slide"
  | "code"
  | "archive"
  | "large"
  | "recent";

export interface FolderTab {
  tabId: string;
  /**
   * 用户最初添加的目录（规范化绝对路径）；导航只改 path，该值在标签生命周期内不变。
   * 标题恒取它的名称，因此进入子目录不会改变标签标题。
   */
  openedPath: string;
  /** 当前目录（规范化绝对路径）。 */
  path: string;
  /** 目录历史（含当前）。 */
  history: string[];
  historyIndex: number;
  viewMode: ViewMode;
  sortField: SortField;
  sortAsc: boolean;
  /** 当前目录内筛选（空 = 不筛选）。 */
  search: string;
  /** 文件类型快速筛选；每个标签独立（持久化随 panes 一起保存）。 */
  filter?: FileFilter;
  showHidden: boolean;
}

export interface PaneState {
  tabs: FolderTab[];
  activeTabId: string | null;
}

export interface PaneSelection {
  paths: string[];
  anchor: string | null;
}

/** 布局快照（撤销/重做单元）：只含布局 + 标签分配，不含文件系统事实。 */
export interface LayoutSnapshot {
  tree: SplitNode;
  panes: Record<string, PaneState>;
  activePaneId: string;
  maximizedPaneId: string | null;
  stashed: FolderTab[];
  /**
   * 由这次布局操作「顺带创建」的标签 ID（目前只有 splitPane 会复制当前目录）。
   * 撤销这一步时必须同时丢弃它们，否则 restoreSnapshot 会把它们当成「快照之后
   * 新打开的目录」救援回来，导致撤销后多出一个重复标签。
   */
  createdTabIds?: string[];
}

/** 关闭区域的结果：容量不足时必须阻止（不得静默丢标签）。 */
export type ClosePaneResult =
  | { status: "closed"; movedTabs: number; stashedTabs: number; discardedTabs: number }
  | {
      status: "blocked";
      reason: "lastPane" | "missing" | "capacity" | "structure";
      /** 无法安置的标签（UI 用于「会关闭哪些标签」的明确提示）。 */
      tabs: FolderTab[];
      targetPaneId?: string;
      capacity: number;
    };

/** 应用布局预设的结果（容量不足时阻止，不截断）。 */
export type LayoutApplyResult =
  | { ok: true; unchanged: boolean; tabCount: number; stashedCount: number }
  | { ok: false; reason: "unknownPreset" | "capacity"; tabCount: number; overflow: number };

/** 应用布局模板所需的最小结构（持久化模板的子集；调用方无需提供 name）。 */
export type FilesTemplate = { id: string; tree: SplitNode; panes: PersistedPane[] };

/** 应用布局模板的结果：模板缺失与持久化失败都必须由调用方可见（不静默）。 */
export type ApplyTemplateResult =
  | { ok: true; templateId: string }
  | { ok: false; reason: "missing" | "persist-failed"; error?: string };

/** 撤销栈上限：足够覆盖一次连续拖拽 + 多次布局操作，又不放大内存。 */
export const MAX_LAYOUT_HISTORY = 20;
/** 同一类操作在该窗口内合并为一条历史（拖动分隔线/连续按键）。 */
const HISTORY_COALESCE_MS = 600;

export type SortMenuField = SortField | null;

/** 新标签默认打开位置：用户主目录（不可得时退到 C:\，由面板层传初始目录）。 */
function makeTab(path: string, history: string[] = []): FolderTab {
  const normalized = normalizePath(path);
  const hist = history.length ? [...history, normalized] : [normalized];
  return {
    tabId: freshId("tab"),
    // openedPath 与 path 初始化为同一值；后续导航只动 path。
    openedPath: normalized,
    path: normalized,
    history: hist,
    historyIndex: hist.length - 1,
    viewMode: "list",
    sortField: "name",
    sortAsc: true,
    search: "",
    showHidden: false,
  };
}

export function tabTitle(tab: FolderTab): string {
  // 恒取最初打开目录的名称；老数据/异常数据 openedPath 为空时退回 path。
  return basename(tab.openedPath) || basename(tab.path) || tab.path;
}

// ── 持久化 ⇄ 标签 的共用恢复/序列化（hydrate 与 applyTemplate 共用，避免迁移规则漂移）──

function isViewMode(value: unknown): value is ViewMode {
  return value === "list" || value === "grid";
}
function isSortField(value: unknown): value is SortField {
  return value === "name" || value === "modified" || value === "type" || value === "size";
}
const FILE_FILTER_VALUES: FileFilter[] = [
  "all", "folder", "image", "video", "audio", "doc", "sheet",
  "slide", "code", "archive", "large", "recent",
];
function isFileFilter(value: unknown): value is FileFilter {
  return typeof value === "string" && FILE_FILTER_VALUES.includes(value as FileFilter);
}

/** 限制历史长度（与导航裁剪一致）。 */
const MAX_TAB_HISTORY = 64;

/**
 * 从持久化标签恢复完整会话：hydrate 与 applyTemplate 共用同一迁移规则。
 * - openedPath = persisted.openedPath ?? persisted.path（旧数据兜底）；
 * - 会话字段缺失用 makeTab 默认值；
 * - history/historyIndex 有则恢复并校验越界，否则收敛为单条当前路径。
 */
function restoreTab(persisted: PersistedTab): FolderTab {
  const path = normalizePath(persisted.path);
  const base = makeTab(path);
  const tab: FolderTab = {
    ...base,
    openedPath: persisted.openedPath ? normalizePath(persisted.openedPath) : path,
    viewMode: isViewMode(persisted.viewMode) ? persisted.viewMode : base.viewMode,
    sortField: isSortField(persisted.sortField) ? persisted.sortField : base.sortField,
    sortAsc: typeof persisted.sortAsc === "boolean" ? persisted.sortAsc : base.sortAsc,
    search: typeof persisted.search === "string" ? persisted.search : base.search,
    filter: isFileFilter(persisted.filter) ? persisted.filter : base.filter,
    showHidden: typeof persisted.showHidden === "boolean" ? persisted.showHidden : base.showHidden,
  };
  const stored = Array.isArray(persisted.history)
    ? persisted.history.map(normalizePath).filter(Boolean).slice(0, MAX_TAB_HISTORY)
    : [];
  if (stored.length > 0) {
    const rawIndex =
      typeof persisted.historyIndex === "number" && Number.isInteger(persisted.historyIndex)
        ? persisted.historyIndex
        : stored.length - 1;
    const index = Math.min(Math.max(rawIndex, 0), stored.length - 1);
    tab.history = stored;
    tab.historyIndex = index;
    tab.path = stored[index];
  }
  return tab;
}

/** 标签 → 持久化标签（含全部会话字段；不写选中/拖拽等临时态）。 */
function toPersistedTab(tab: FolderTab): PersistedTab {
  return {
    tabId: tab.tabId,
    path: tab.path,
    openedPath: tab.openedPath,
    history: [...tab.history],
    historyIndex: tab.historyIndex,
    viewMode: tab.viewMode,
    sortField: tab.sortField,
    sortAsc: tab.sortAsc,
    search: tab.search,
    filter: tab.filter,
    showHidden: tab.showHidden,
  };
}

interface FilesWorkspaceData {
  tree: SplitNode;
  panes: Record<string, PaneState>;
  activePaneId: string;
  maximizedPaneId: string | null;
}

interface FilesWorkspaceState extends FilesWorkspaceData {
  selection: Record<string, PaneSelection>;
  /** 容量收纳的标签（布局缩小装不下时暂存；可恢复，绝不静默删除）。 */
  stashed: FolderTab[];
  /** 最近打开目录（最近使用在前，LRU ≤ 8）。 */
  recentDirs: string[];
  /**
   * 最近使用的布局模板 ID（最近使用在前，去重，≤ MAX_RECENT）。
   * 与项目维度无关（全局一份），随持久化的 `recentTemplates` 字段共存。
   */
  recentTemplates: string[];
  /** 用户固定目录（不被 LRU 淘汰）。 */
  pinnedDirs: string[];
  /**
   * 列表视图列宽（仅用户拖拽改过的列；全分栏共享，未改列回 CSS 默认值）。
   * 随持久化 `colWidths` 字段跨会话保留。
   */
  colWidths: ColWidths;
  /** 布局撤销栈（会话内）。 */
  layoutHistory: LayoutSnapshot[];
  /** 布局重做栈（会话内）。 */
  layoutFuture: LayoutSnapshot[];
  /** 布局编辑模式：普通模式不做整窗格拖拽，避免与文件/标签拖拽争夺命中区域。 */
  layoutEditMode: boolean;
  /** 持久化键（global / project:<id>）；面板层设置。 */
  stateKey: string;
  /** 是否已注入过初始状态（避免空树先渲染）。 */
  hydrated: boolean;
  /** 最近一次持久化写入失败原因（null=无错误；面板显示可见反馈）。 */
  persistError: string | null;
}

/** 持久化快照（stateKey 单独承载，不进 store 公开字段）。 */
interface SnapshotPayload {
  stateKeyRef: string;
  stateData: PersistedState;
}

export interface FilesWorkspaceActions {
  /** 注入持久化状态（损坏由 persist 层归一化兜底）。 */
  hydrate: (state: PersistedState, stateKey: string) => void;
  /** 面板层声明当前绑定键（项目切换）。 */
  setStateKey: (stateKey: string) => void;
  /** 更新列表视图列宽（拖拽/键盘/双击重置后提交；全分栏共享）。 */
  setColWidths: (widths: ColWidths) => void;
  snapshot: () => SnapshotPayload;
  persistNow: () => Promise<void>;
  /** 落盘待写防抖状态（项目切换/卸载前）。 */
  flushPending: () => Promise<void>;

  openInPane: (paneId: string, path: string, mode: "newTab" | "replace") => boolean;
  openPathInActive: (path: string, mode?: "newTab" | "replace") => boolean;
  navigate: (paneId: string, direction: "back" | "forward" | "up") => void;
  refreshPane: (paneId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  setActiveTab: (paneId: string, tabId: string) => void;
  /** 同窗格内复制标签（插到源标签后并激活副本）；深拷贝由纯函数 duplicateTab 负责。 */
  duplicateTabInPane: (paneId: string, tabId: string) => void;
  reorderTab: (paneId: string, from: number, to: number) => void;
  moveTabToPane: (tabId: string, fromPaneId: string, toPaneId: string, index?: number) => void;
  extractTabToPane: (
    tabId: string,
    fromPaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    side?: "before" | "after",
  ) => boolean;

  splitPane: (
    paneId: string,
    direction: SplitDirection,
    openPath?: string | null,
    side?: "before" | "after",
  ) => string | null;
  /**
   * 关闭区域。默认 `transfer`：把标签转移到相邻（及剩余）区域，容量不足则**阻止**
   * 并返回待安置标签；`stash` 把装不下的标签放入可恢复收纳；`discard` 才真正丢弃
   * 标签（UI 必须显式确认并列出标签）。任何模式都不触碰真实文件。
   */
  closePane: (paneId: string, options?: { mode?: "transfer" | "stash" | "discard" }) => ClosePaneResult;
  /** 关闭除保留区域外的所有区域（同样不静默丢标签）。 */
  closeOtherPanes: (keepPaneId: string, options?: { mode?: "transfer" | "stash" | "discard" }) => ClosePaneResult;
  /** 仅关闭确实为空（无标签）的窗格；最后一个窗格受保护。返回是否关闭成功。 */
  closeEmptyPane: (paneId: string) => boolean;
  /** 一次性关闭全部空窗格（至少保留一个）；返回关闭数量。 */
  closeAllEmptyPanes: () => number;
  /**
   * 目录重命名成功后，把所有标签（含 stashed）的 openedPath/path/history 中的旧路径
   * 同步为新路径（精确匹配 + 子路径 + Windows 大小写不敏感）。返回受影响标签数。
   */
  remapTabPaths: (oldPath: string, newPath: string) => number;
  /**
   * 批量路径映射（目录移动一次可能涉及多项）：一次状态更新 + 一次持久化，
   * 避免循环调用 remapTabPaths 触发多次全量落盘。返回受影响标签数。
   */
  remapTabPathsBatch: (mappings: ReadonlyArray<{ from: string; to: string }>) => number;
  /** 与相邻窗格交换位置（保持标签）。 */
  swapPane: (paneId: string) => void;
  /** 任意两区域位置互换（布局编辑模式：拖动区域 A 到区域 B 中心）。 */
  swapPanes: (a: string, b: string) => boolean;
  updateRatio: (splitId: string, ratio: number) => void;
  /**
   * 分割线拖动事务：开始记录一次撤销快照 → 每帧只预览树比例（不写历史、不持久化）
   * → 松开提交最终比例（仍只保留一条撤销记录）。取消恢复拖动前树并回滚该快照。
   */
  beginRatioResize: (splitId: string) => void;
  previewRatio: (splitId: string, ratio: number) => void;
  commitRatioResize: () => void;
  cancelRatioResize: () => void;
  /** 文件移动成功后的来源选择清理（按真实成功项；失败/部分完成仍保留选择）。 */
  removePathsFromSelections: (paths: string[]) => void;
  setActivePane: (paneId: string) => void;
  toggleMaximize: (paneId: string) => void;
  /** 应用布局预设并**保留全部已打开目录**（按稳定规则重新分配标签）。 */
  applyLayoutPresetPreservingTabs: (presetId: string) => LayoutApplyResult;
  /** 旧语义：清空窗格后按初始路径重建（仅用于显式重置，面板不再使用）。 */
  applyPreset: (presetId: string, initialPaths?: string[]) => void;
  applyTemplate: (templateId: string, templates: FilesTemplate[]) => Promise<ApplyTemplateResult>;
  saveCurrentAsTemplate: (name: string) => Promise<{ id: string; tree: SplitNode; panes: PersistedPane[] }>;

  undoLayout: () => boolean;
  redoLayout: () => boolean;
  setLayoutEditMode: (value: boolean) => void;

  recordRecentDir: (path: string) => void;
  /** 清空最近目录（地址栏路径历史）；不触碰固定目录与已打开标签。 */
  clearRecentDirs: () => void;
  togglePinnedDir: (path: string) => void;
  /** 把收纳中的标签恢复到指定/活动区域（容量不足则返回 false）。 */
  restoreStashedTab: (tabId: string, paneId?: string) => boolean;
  /** 清空收纳（仅在用户显式操作后调用）。 */
  clearStashed: () => void;

  patchTab: (paneId: string, tabId: string, patch: Partial<FolderTab>) => void;
  setSelection: (paneId: string, paths: string[], anchor?: string | null) => void;
  clearSelection: (paneId: string) => void;
  notifyDirsChanged: (paths: string[]) => void;
}

export type FilesWorkspaceStore = FilesWorkspaceState & FilesWorkspaceActions;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
// create() 之后注入：persistError 只能经 store 实例 setState 更新（模块层函数拿不到 set）。
let applyPersistError: ((value: string | null) => void) | null = null;
/** 历史合并窗口（同一 kind+key 的连续操作合并为一条撤销单元）。 */
let historyCoalesce: { kind: string; key: string; at: number } | null = null;
/** 分割线拖动事务：保存拖动前快照与历史栈，取消时精确回滚且不留下撤销项。 */
let ratioDrag: {
  splitId: string;
  snapshot: LayoutSnapshot;
  history: LayoutSnapshot[];
  future: LayoutSnapshot[];
} | null = null;

function schedulePersist(get: () => FilesWorkspaceStore): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushPersist(get)();
  }, 600);
}

/** 取消挂起的防抖写入（随后的显式写入会包含当时的完整快照）。 */
function cancelPersistTimer(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

/**
 * 显式写入一次完整快照（可行时附带全局字段覆盖）。
 * 走 persist.ts 的串行链，失败向上抛错由调用方决定反馈方式。
 */
function writeSnapshot(
  get: () => FilesWorkspaceStore,
  extra?: Partial<Pick<FilesWorkspacePersisted, "recentTemplates">>,
): Promise<void> {
  const snapshot = get().snapshot();
  return persistFilesWorkspace((current) => {
    // 重排：把活跃键移到末尾（LRU 语义），再写回。
    const states = { ...current.states };
    delete states[snapshot.stateKeyRef];
    states[snapshot.stateKeyRef] = snapshot.stateData;
    return { ...current, ...extra, states };
  });
}

/** 立即执行一次待写快照（返回可等待的写入动作；无待写定时器也为显式写入）。 */
function flushPersist(get: () => FilesWorkspaceStore): () => Promise<void> {
  return async () => {
    try {
      await writeSnapshot(get);
      if (get().persistError !== null) applyPersistError?.(null);
    } catch (e) {
      // 持久化失败不打断交互；错误落入 store 供面板可见反馈（P0：不得静默）。
      applyPersistError?.(e instanceof Error ? e.message : String(e));
    }
  };
}

/**
 * 项目切换/卸载前同步落盘待写状态（P0 竞态）：旧项目最后 ≤600ms 的编辑
 * 若不先落盘，切换后 fire 的旧定时器会把新项目状态写进新键，旧编辑永久丢失。
 */
function flushPendingPersist(get: () => FilesWorkspaceStore): Promise<void> {
  if (!persistTimer) return Promise.resolve();
  cancelPersistTimer();
  return flushPersist(get)();
}

/** 目录列表去重（Windows 路径大小写不敏感）。 */
function dedupeDirs(list: string[], path: string): string[] {
  const target = normalizePath(path);
  if (!target) return list;
  return [target, ...list.filter((p) => !samePath(p, target))];
}

/** 收纳标签去重合并（同一 tabId 不重复入栈）。 */
function mergeStashed(current: FolderTab[], incoming: FolderTab[]): FolderTab[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((t) => t.tabId));
  const next = [...current];
  for (const tab of incoming) {
    if (seen.has(tab.tabId)) continue;
    seen.add(tab.tabId);
    next.push(tab);
  }
  return next;
}

const useFilesWorkspaceStore = create<FilesWorkspaceStore>((set, get) => {
  const ensurePaneState = (
    panes: Record<string, PaneState>,
    tree: SplitNode,
    initialPaths: string[] = [],
  ): Record<string, PaneState> => {
    const next: Record<string, PaneState> = {};
    for (const paneId of paneIds(tree)) {
      const existing = panes[paneId];
      if (existing) {
        next[paneId] = existing;
        continue;
      }
      const path = initialPaths.shift() ?? "";
      const tabs = path ? [makeTab(path)] : [];
      next[paneId] = { tabs, activeTabId: tabs[0]?.tabId ?? null };
    }
    return next;
  };

  const withTree = (tree: SplitNode, extra?: Partial<FilesWorkspaceData>) => {
    set((s) => ({
      tree,
      panes: ensurePaneState(s.panes, tree),
      ...(extra ?? {}),
    }));
    schedulePersist(get);
  };

  const mutateTab = (paneId: string, tabId: string, fn: (tab: FolderTab) => FolderTab) => {
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      const tabs = pane.tabs.map((t) => (t.tabId === tabId ? fn({ ...t }) : t));
      return { panes: { ...s.panes, [paneId]: { ...pane, tabs } } };
    });
    schedulePersist(get);
  };

  const snapshotLayout = (s: FilesWorkspaceStore): LayoutSnapshot => ({
    tree: s.tree,
    panes: s.panes,
    activePaneId: s.activePaneId,
    maximizedPaneId: s.maximizedPaneId,
    stashed: s.stashed,
  });

  /** 记录一次布局变更（同 kind+key 的连续操作合并；新变更清空重做栈）。返回本次可撤销的起始快照。 */
  const recordHistory = (kind: string, key = ""): LayoutSnapshot | null => {
    const s = get();
    const now = Date.now();
    if (
      historyCoalesce &&
      historyCoalesce.kind === kind &&
      historyCoalesce.key === key &&
      now - historyCoalesce.at <= HISTORY_COALESCE_MS
    ) {
      historyCoalesce.at = now;
      return s.layoutHistory[s.layoutHistory.length - 1] ?? null;
    }
    historyCoalesce = { kind, key, at: now };
    const snapshot = snapshotLayout(s);
    set({
      layoutHistory: [...s.layoutHistory, snapshot].slice(-MAX_LAYOUT_HISTORY),
      layoutFuture: [],
    });
    return snapshot;
  };

  const restoreSnapshot = (
    snapshot: LayoutSnapshot,
    history: LayoutSnapshot[],
    future: LayoutSnapshot[],
    dropCreatedTabIds?: ReadonlySet<string>,
  ) => {
    const current = get();
    // 撤销/重做绝不能删掉「快照之后才打开的目录」：快照里没有的标签按原区域优先
    // 放回，装不下就进可恢复收纳；不静默丢弃是这套状态机的硬约束。
    // 例外：由被撤销的 split 操作「顺带创建」的复制标签必须随撤销一起消失，
    // 否则撤销分割会留下一个重复目录（createdTabIds 只由 splitPane 写入）。
    const known = new Set<string>([
      ...Object.values(snapshot.panes).flatMap((pane) => pane.tabs.map((t) => t.tabId)),
      // 收纳标签也属于「快照里已有的目录」：漏掉它们会把重做后的同一批标签当成新标签，
      // 造成同一 tabId 同时出现在区域与收纳里（重复/错位）。
      ...snapshot.stashed.map((t) => t.tabId),
    ]);
    const orphans: Array<{ paneId: string; tab: FolderTab }> = [];
    for (const id of paneIds(current.tree)) {
      for (const tab of current.panes[id]?.tabs ?? []) {
        if (dropCreatedTabIds?.has(tab.tabId)) continue;
        if (!known.has(tab.tabId)) orphans.push({ paneId: id, tab });
      }
    }
    for (const tab of current.stashed) {
      if (dropCreatedTabIds?.has(tab.tabId)) continue;
      if (!known.has(tab.tabId)) orphans.push({ paneId: "", tab });
    }
    const panes: Record<string, PaneState> = {};
    const ids = paneIds(snapshot.tree);
    for (const id of ids) {
      const pane = snapshot.panes[id];
      panes[id] = pane ? { tabs: [...pane.tabs], activeTabId: pane.activeTabId } : { tabs: [], activeTabId: null };
    }
    const stash: FolderTab[] = [...snapshot.stashed];
    for (const orphan of orphans) {
      const preferred = ids.includes(orphan.paneId) ? orphan.paneId : ids[0];
      const order = preferred ? [preferred, ...ids.filter((id) => id !== preferred)] : ids;
      const target = order.find((id) => panes[id].tabs.length < MAX_TABS_PER_PANE);
      if (target) {
        panes[target] = {
          tabs: [...panes[target].tabs, orphan.tab],
          activeTabId: panes[target].activeTabId ?? orphan.tab.tabId,
        };
      } else if (stash.length < MAX_STASHED_TABS) {
        stash.push(orphan.tab);
      } else {
        // 理论上不可达（12 区域 × 12 标签 + 64 收纳远大于单会话可开标签数）；
        // 仍保留在原区域而非丢弃——宁可多留一个标签也不能让目录消失。
        panes[ids[0]].tabs = [...panes[ids[0]].tabs, orphan.tab];
      }
    }
    set({
      tree: snapshot.tree,
      panes,
      activePaneId: snapshot.activePaneId,
      maximizedPaneId: snapshot.maximizedPaneId,
      stashed: stash,
      selection: {},
      layoutHistory: history,
      layoutFuture: future,
    });
    historyCoalesce = null;
    schedulePersist(get);
  };


  /** 把一批标签放入指定区域集合（按顺序填满容量），返回放不下的剩余。 */
  const placeTabs = (
    panes: Record<string, PaneState>,
    order: string[],
    tabs: FolderTab[],
  ): FolderTab[] => {
    const leftover: FolderTab[] = [];
    for (const tab of tabs) {
      let placed = false;
      for (const paneId of order) {
        const pane = panes[paneId];
        if (!pane) continue;
        if (pane.tabs.length >= MAX_TABS_PER_PANE) continue;
        panes[paneId] = { tabs: [...pane.tabs, tab], activeTabId: pane.activeTabId ?? tab.tabId };
        placed = true;
        break;
      }
      if (!placed) leftover.push(tab);
    }
    return leftover;
  };

  const applyClose = (
    paneId: string,
    closing: string[],
    mode: "transfer" | "stash" | "discard",
  ): ClosePaneResult => {
    const s = get();
    if (!hasPane(s.tree, paneId)) {
      return { status: "blocked", reason: "missing", tabs: [], capacity: 0 };
    }
    const remaining = paneIds(s.tree).filter((id) => !closing.includes(id));
    if (remaining.length === 0) {
      return { status: "blocked", reason: "lastPane", tabs: [], capacity: 0 };
    }
    const tabsOf = (ids: string[]): FolderTab[] => ids.flatMap((id) => s.panes[id]?.tabs ?? []);
    const moving = mode === "discard" ? [] : tabsOf(closing);
    const discarded = mode === "discard" ? tabsOf(closing) : [];

    const anchor = adjacentPaneId(s.tree, paneId);
    const order =
      anchor && remaining.includes(anchor)
        ? [anchor, ...remaining.filter((id) => id !== anchor)]
        : [...remaining];

    // 先在副本上完成分配；任何一步失败都返回阻止结果，**此时尚未写入 store**，
    // 因此失败路径不会留下「标签已移除但区域未关闭」的半成品状态。
    const panes: Record<string, PaneState> = { ...s.panes };
    let leftover = mode === "discard" ? [] : placeTabs(panes, order, moving);
    let stashAdd: FolderTab[] = [];
    if (leftover.length > 0 && mode === "stash") {
      const room = MAX_STASHED_TABS - s.stashed.length;
      if (leftover.length > room) {
        return {
          status: "blocked",
          reason: "capacity",
          tabs: leftover,
          targetPaneId: order[0],
          capacity: MAX_TABS_PER_PANE,
        };
      }
      stashAdd = leftover;
      leftover = [];
    }
    if (leftover.length > 0) {
      // transfer 模式装不下：阻止关闭，UI 必须给出明确选择（收纳 / 取消 / 显式关标签）。
      return {
        status: "blocked",
        reason: "capacity",
        tabs: leftover,
        targetPaneId: order[0],
        capacity: MAX_TABS_PER_PANE,
      };
    }

    let tree: SplitNode = s.tree;
    for (const id of closing) {
      const next = removePane(tree, id);
      if (!next) {
        return { status: "blocked", reason: "structure", tabs: moving, capacity: 0 };
      }
      tree = next;
    }
    const ids = paneIds(tree);
    const nextPanes: Record<string, PaneState> = {};
    for (const id of ids) {
      if (panes[id]) nextPanes[id] = panes[id];
    }
    recordHistory("close-pane", closing.join(","));
    set({
      tree,
      panes: nextPanes,
      activePaneId:
        ids.includes(s.activePaneId) && !closing.includes(s.activePaneId) ? s.activePaneId : ids[0],
      maximizedPaneId:
        s.maximizedPaneId && !closing.includes(s.maximizedPaneId) ? s.maximizedPaneId : null,
      stashed: stashAdd.length > 0 ? mergeStashed(s.stashed, stashAdd) : s.stashed,
      selection: {},
    });
    schedulePersist(get);
    return {
      status: "closed",
      movedTabs: moving.length - stashAdd.length,
      stashedTabs: stashAdd.length,
      discardedTabs: discarded.length,
    };
  };

  return {
    tree: defaultTree(),
    panes: {
      "pane-1": { tabs: [], activeTabId: null },
    },
    activePaneId: "pane-1",
    maximizedPaneId: null,
    selection: {},
    stashed: [],
    recentDirs: [],
    recentTemplates: [],
    pinnedDirs: [],
    colWidths: {},
    layoutHistory: [],
    layoutFuture: [],
    layoutEditMode: false,
    stateKey: "global",
    hydrated: false,
    persistError: null,

    hydrate: (state, stateKey) => {
      // 项目切换前先落盘旧键的待写编辑（P0 竞态：否则旧定时器会把新状态写进新键）。
      void flushPendingPersist(get);
      // 最近模板是全局元数据（不属于项目态），重启/切换后从设置中恢复；
      // 设置尚未加载时保留内存值，避免把已应用的最近顺序清空。
      const restoredRecentTemplates =
        readFilesWorkspacePersisted()?.recentTemplates ?? get().recentTemplates;
      const tree = normalizeTree(state.tree);
      const ids = paneIds(tree);
      const panes: Record<string, PaneState> = {};
      // 持久化 tabId 直接复用（P0：旧实现 makeTab 重新生成 ID 后再拿旧 activeTabId
      // 匹配，永不命中 → 激活标签恢复必然失效）。重复 ID 兜底重新生成。
      const seenTabIds = new Set<string>();
      for (const paneId of ids) {
        const persisted = state.panes.find((p) => p.paneId === paneId);
        if (persisted && persisted.tabs.length > 0) {
          const tabs = persisted.tabs.slice(0, MAX_TABS_PER_PANE).map((persistedTab) => {
            const tab = restoreTab(persistedTab);
            if (persistedTab.tabId && !seenTabIds.has(persistedTab.tabId)) {
              seenTabIds.add(persistedTab.tabId);
              tab.tabId = persistedTab.tabId;
            }
            return tab;
          });
          panes[paneId] = {
            tabs,
            activeTabId:
              tabs.find((t) => t.tabId === persisted.activeTabId)?.tabId ?? tabs[0].tabId,
          };
        } else {
          panes[paneId] = { tabs: [], activeTabId: null };
        }
      }
      // 收纳标签恢复：复用同一迁移规则（会话字段/历史随标签一起恢复）。
      const stashed = (state.stashed ?? [])
        .slice(0, MAX_STASHED_TABS)
        .map((persistedTab) => {
          const tab = restoreTab(persistedTab);
          if (persistedTab.tabId && !seenTabIds.has(persistedTab.tabId)) {
            seenTabIds.add(persistedTab.tabId);
            tab.tabId = persistedTab.tabId;
          }
          return tab;
        })
        .filter((t) => Boolean(t.path));
      historyCoalesce = null;
      set({
        tree,
        panes,
        activePaneId: ids.includes(state.activePaneId) ? state.activePaneId : ids[0],
        maximizedPaneId: null,
        selection: {},
        stashed,
        pinnedDirs: (state.pinnedDirs ?? []).slice(0, MAX_PINNED_DIRS),
        recentDirs: (state.recentDirs ?? []).slice(0, MAX_RECENT_DIRS),
        colWidths: state.colWidths ?? {},
        recentTemplates: restoredRecentTemplates,
        layoutHistory: [],
        layoutFuture: [],
        layoutEditMode: false,
        stateKey,
        hydrated: true,
      });
    },

    setStateKey: (stateKey) => set({ stateKey }),

    setColWidths: (widths) => {
      set({ colWidths: widths });
      schedulePersist(get);
    },

    snapshot: (): SnapshotPayload => {
      const s = get();
      return {
        stateKeyRef: s.stateKey,
        stateData: {
          tree: s.tree,
          panes: paneIds(s.tree).flatMap((paneId): PersistedPane[] => {
            const pane = s.panes[paneId];
            if (!pane) return [];
            return [
              {
                paneId,
                tabs: pane.tabs.map(toPersistedTab),
                activeTabId: pane.activeTabId,
              },
            ];
          }),
          activePaneId: s.activePaneId,
          pinnedDirs: [...s.pinnedDirs],
          recentDirs: [...s.recentDirs],
          // 空列宽不写键：与 normalizeState 的「全默认回 undefined」保持同一形态，往返稳定。
          ...(Object.keys(s.colWidths).length > 0 ? { colWidths: { ...s.colWidths } } : {}),
          stashed: s.stashed.map(toPersistedTab),
        },
      };
    },

    persistNow: () => flushPersist(get)(),

    /** 项目切换/卸载前的显式落盘入口（面板层调用）。 */
    flushPending: () => flushPendingPersist(get),

    openInPane: (paneId, rawPath, mode) => {
      const path = normalizePath(rawPath);
      const s0 = get();
      if (!path || !hasPane(s0.tree, paneId)) return false;
      const pane0 = s0.panes[paneId];
      if (!pane0) return false;
      // 容量上限：新标签塞不进去时返回 false，由 UI 给出可见反馈（不静默失败）。
      if (mode === "newTab" && pane0.tabs.length >= MAX_TABS_PER_PANE) return false;
      set((s) => {
        const pane = s.panes[paneId];
        if (!pane) return s;
        const nextRecent = dedupeDirs(s.recentDirs, path).slice(0, MAX_RECENT_DIRS);
        if (mode === "replace" && pane.activeTabId) {
          // 同标签内导航（双击进入/面包屑/上级/路径跳转）：压入历史栈，
          // 丢弃前进分支（与浏览器语义一致），back/forward 依赖它。
          return {
            panes: {
              ...s.panes,
              [paneId]: {
                ...pane,
                tabs: pane.tabs.map((t) => {
                  if (t.tabId !== pane.activeTabId) return t;
                  if (samePath(t.path, path)) return t;
                  const history = [...t.history.slice(0, t.historyIndex + 1), path].slice(-64);
                  return { ...t, path, history, historyIndex: history.length - 1 };
                }),
              },
            },
            activePaneId: paneId,
            recentDirs: nextRecent,
          };
        }
        if (pane.tabs.length >= MAX_TABS_PER_PANE) return s;
        const tab = makeTab(path);
        return {
          panes: {
            ...s.panes,
            [paneId]: { tabs: [...pane.tabs, tab], activeTabId: tab.tabId },
          },
          activePaneId: paneId,
          recentDirs: nextRecent,
        };
      });
      schedulePersist(get);
      return true;
    },

    openPathInActive: (rawPath, mode = "newTab") => {
      const active = get().activePaneId;
      return get().openInPane(active, rawPath, mode);
    },

    navigate: (paneId, direction) => {
      const pane = get().panes[paneId];
      const tab = pane?.tabs.find((t) => t.tabId === pane.activeTabId);
      if (!tab) return;
      if (direction === "back") {
        if (tab.historyIndex <= 0) return;
        mutateTab(paneId, tab.tabId, (t) => ({
          ...t,
          historyIndex: t.historyIndex - 1,
          path: t.history[t.historyIndex - 1],
        }));
        return;
      }
      if (direction === "forward") {
        if (tab.historyIndex >= tab.history.length - 1) return;
        mutateTab(paneId, tab.tabId, (t) => ({
          ...t,
          historyIndex: t.historyIndex + 1,
          path: t.history[t.historyIndex + 1],
        }));
        return;
      }
      // up
      const parent = parentOf(tab.path);
      if (!parent || samePath(parent, tab.path)) return;
      mutateTab(paneId, tab.tabId, (t) => {
        const history = [...t.history.slice(0, t.historyIndex + 1), parent];
        return { ...t, path: parent, history, historyIndex: history.length - 1 };
      });
    },

    refreshPane: (paneId) => {
      const pane = get().panes[paneId];
      const tab = pane?.tabs.find((t) => t.tabId === pane.activeTabId);
      if (tab?.path) invalidateDirs([tab.path]);
    },

    closeTab: (paneId, tabId) => {
      set((s) => {
        const pane = s.panes[paneId];
        if (!pane) return s;
        const tabs = pane.tabs.filter((t) => t.tabId !== tabId);
        const activeTabId =
          pane.activeTabId === tabId
            ? (tabs[Math.max(0, pane.tabs.findIndex((t) => t.tabId === tabId) - 1)]?.tabId ?? null)
            : pane.activeTabId;
        return { panes: { ...s.panes, [paneId]: { tabs, activeTabId } } };
      });
      schedulePersist(get);
    },

    setActiveTab: (paneId, tabId) => {
      set((s) => {
        const pane = s.panes[paneId];
        if (!pane?.tabs.some((t) => t.tabId === tabId)) return s;
        return { panes: { ...s.panes, [paneId]: { ...pane, activeTabId: tabId } }, activePaneId: paneId };
      });
      schedulePersist(get);
    },

    duplicateTabInPane: (paneId, tabId) => {
      set((s) => {
        const pane = s.panes[paneId];
        const source = pane?.tabs.find((t) => t.tabId === tabId);
        if (!pane || !source || pane.tabs.length >= MAX_TABS_PER_PANE) return s;
        const copy = duplicateTab(source);
        const idx = pane.tabs.findIndex((t) => t.tabId === tabId);
        const tabs = [...pane.tabs];
        tabs.splice(idx + 1, 0, copy);
        return { panes: { ...s.panes, [paneId]: { tabs, activeTabId: copy.tabId } }, activePaneId: paneId };
      });
      schedulePersist(get);
    },

    reorderTab: (paneId, from, to) => {
      set((s) => {
        const pane = s.panes[paneId];
        if (!pane) return s;
        if (from < 0 || to < 0 || from >= pane.tabs.length || to >= pane.tabs.length) return s;
        const tabs = [...pane.tabs];
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved);
        return { panes: { ...s.panes, [paneId]: { ...pane, tabs } } };
      });
      schedulePersist(get);
    },

    moveTabToPane: (tabId, fromPaneId, toPaneId, index) => {
      const s0 = get();
      const from0 = s0.panes[fromPaneId];
      const tab0 = from0?.tabs.find((t) => t.tabId === tabId);
      if (!from0 || !tab0 || fromPaneId === toPaneId) return;
      if (!s0.panes[toPaneId] || s0.panes[toPaneId].tabs.length >= MAX_TABS_PER_PANE) return;
      recordHistory("tab-move", tabId);
      set((s) => {
        const from = s.panes[fromPaneId];
        const to = s.panes[toPaneId];
        const tab = from?.tabs.find((t) => t.tabId === tabId);
        if (!from || !to || !tab || to.tabs.length >= MAX_TABS_PER_PANE) return s;
        const fromTabs = from.tabs.filter((t) => t.tabId !== tabId);
        const toTabs = [...to.tabs];
        toTabs.splice(index ?? toTabs.length, 0, tab);
        return {
          panes: {
            ...s.panes,
            [fromPaneId]: {
              ...from,
              tabs: fromTabs,
              activeTabId:
                fromTabs[
                  Math.min(
                    fromTabs.length - 1,
                    Math.max(0, from.tabs.findIndex((t) => t.tabId === tabId) - 1),
                  )
                ]?.tabId ?? null,
            },
            [toPaneId]: { ...to, tabs: toTabs, activeTabId: tab.tabId },
          },
          activePaneId: toPaneId,
        };
      });
      schedulePersist(get);
    },

    extractTabToPane: (tabId, fromPaneId, targetPaneId, direction, side = "after") => {
      const s = get();
      const tab = s.panes[fromPaneId]?.tabs.find((t) => t.tabId === tabId);
      if (!tab) return false;
      const result = splitPaneInTree(s.tree, targetPaneId, direction, side);
      if (!result) return false;
      recordHistory("tab-split", tabId);
      set((st) => {
        const from = st.panes[fromPaneId];
        if (!from) return st;
        const fromTabs = from.tabs.filter((t) => t.tabId !== tabId);
        const newPane: PaneState = { tabs: [tab], activeTabId: tab.tabId };
        const panes = {
          ...st.panes,
          [fromPaneId]: {
            ...from,
            tabs: fromTabs,
            activeTabId: fromTabs[fromTabs.length - 1]?.tabId ?? null,
          },
          [result.newPaneId]: newPane,
        };
        return { tree: result.tree, panes, activePaneId: result.newPaneId, maximizedPaneId: null };
      });
      schedulePersist(get);
      return true;
    },

    splitPane: (paneId, direction, _openPath, side = "after") => {
      const s = get();
      // 没有可复制的活动标签时不产生窗格（也不写历史）——避免空窗格凭空出现。
      // openPath 仅为签名兼容保留：新窗格一律复制当前标签的完整会话，而非按路径重建。
      const pane = s.panes[paneId];
      const activeTab = pane?.tabs.find((t) => t.tabId === pane.activeTabId);
      if (!activeTab) return null;
      const result = splitPaneInTree(s.tree, paneId, direction, side);
      if (!result) return null;
      const copy = duplicateTab(activeTab);
      const history = recordHistory("split", paneId);
      set((st) => {
        const panes = ensurePaneState(st.panes, result.tree);
        panes[result.newPaneId] = { tabs: [copy], activeTabId: copy.tabId };
        return { tree: result.tree, panes, activePaneId: result.newPaneId, maximizedPaneId: null };
      });
      // 撤销分割时必须同时丢弃这个复制标签，否则 undo 后会多出一个重复目录。
      if (history) {
        history.createdTabIds = [...(history.createdTabIds ?? []), copy.tabId];
      }
      schedulePersist(get);
      return result.newPaneId;
    },

    closePane: (paneId, options) => applyClose(paneId, [paneId], options?.mode ?? "transfer"),

    closeOtherPanes: (keepPaneId, options) => {
      const s = get();
      const closing = paneIds(s.tree).filter((id) => id !== keepPaneId);
      if (closing.length === 0) {
        return { status: "closed", movedTabs: 0, stashedTabs: 0, discardedTabs: 0 };
      }
      return applyClose(keepPaneId, closing, options?.mode ?? "transfer");
    },

    closeEmptyPane: (paneId) => {
      const s = get();
      const ids = paneIds(s.tree);
      // 不存在 / 最后一个窗格 / 非空窗格都不动。
      if (!hasPane(s.tree, paneId) || ids.length <= 1) return false;
      if ((s.panes[paneId]?.tabs.length ?? -1) !== 0) return false;
      const tree = removePane(s.tree, paneId);
      if (!tree) return false;
      recordHistory("close-empty-pane", paneId);
      const remaining = paneIds(tree);
      set({
        tree,
        panes: ensurePaneState(s.panes, tree),
        activePaneId: remaining.includes(s.activePaneId) ? s.activePaneId : remaining[0],
        maximizedPaneId: s.maximizedPaneId && s.maximizedPaneId !== paneId ? s.maximizedPaneId : null,
        selection: {},
      });
      schedulePersist(get);
      return true;
    },

    closeAllEmptyPanes: () => {
      const s = get();
      const allIds = paneIds(s.tree);
      if (allIds.length <= 1) return 0;
      const empty = allIds.filter((id) => (s.panes[id]?.tabs.length ?? 0) === 0);
      if (empty.length === 0) return 0;
      let closing = empty;
      if (empty.length === allIds.length) {
        // 全部为空：至少保留 activePaneId（无效则保留树第一个）。
        const keep = allIds.includes(s.activePaneId) ? s.activePaneId : allIds[0];
        closing = empty.filter((id) => id !== keep);
      }
      if (closing.length === 0) return 0;
      let tree = s.tree;
      for (const id of closing) {
        const next = removePane(tree, id);
        if (!next) return 0; // 结构异常：保持原状，不写任何状态。
        tree = next;
      }
      recordHistory("close-all-empty", closing.join(","));
      const remaining = paneIds(tree);
      set({
        tree,
        panes: ensurePaneState(s.panes, tree),
        activePaneId: remaining.includes(s.activePaneId) ? s.activePaneId : remaining[0],
        maximizedPaneId:
          s.maximizedPaneId && !closing.includes(s.maximizedPaneId) ? s.maximizedPaneId : null,
        selection: {},
      });
      schedulePersist(get);
      return closing.length;
    },

    remapTabPaths: (oldPath, newPath) => get().remapTabPathsBatch([{ from: oldPath, to: newPath }]),

    remapTabPathsBatch: (mappings) => {
      // 预归一化并剔除空映射；同一个 from 只保留最后一个（后写入的移动结果为准）。
      const normalized = new Map<string, string>();
      for (const m of mappings) {
        const from = normalizePath(m.from);
        const to = normalizePath(m.to);
        if (from && to) normalized.set(from.toLowerCase(), to);
      }
      if (normalized.size === 0) return 0;
      const entries = [...normalized.entries()];
      // 按 from 长度降序：父目录先映射会让子路径也命中同一条，导致子项的真实新路径
      // 被父级映射覆盖；从最具体的子路径开始匹配，已被映射过的路径不再二次改写。
      entries.sort((a, b) => b[0].length - a[0].length);
      // 精确匹配用 samePath（大小写不敏感）；子路径用 isSubPath（自带分量边界，
      // D:\Projects\A 不会误匹配 D:\Projects\AB）；后缀沿用原路径大小写。
      const mapPath = (p: string): string => {
        for (const [fromLower, to] of entries) {
          if (p.toLowerCase() === fromLower) return to;
          if (isSubPath(fromLower, p)) return to + p.slice(fromLower.length);
        }
        return p;
      };
      const s = get();
      let affected = 0;
      const remapTab = (tab: FolderTab): FolderTab => {
        const openedPath = mapPath(tab.openedPath);
        const path = mapPath(tab.path);
        const history = tab.history.map(mapPath);
        if (
          openedPath === tab.openedPath &&
          path === tab.path &&
          history.every((h, i) => h === tab.history[i])
        ) {
          return tab;
        }
        affected += 1;
        return { ...tab, openedPath, path, history };
      };
      const panes: Record<string, PaneState> = {};
      for (const [paneId, pane] of Object.entries(s.panes)) {
        panes[paneId] = { ...pane, tabs: pane.tabs.map(remapTab) };
      }
      const stashed = s.stashed.map(remapTab);
      if (affected === 0) return 0;
      set({ panes, stashed });
      schedulePersist(get);
      return affected;
    },

    swapPane: (paneId) => {
      recordHistory("swap", paneId);
      withTree(swapPaneWithSibling(get().tree, paneId));
    },

    swapPanes: (a, b) => {
      const s = get();
      const tree = swapPanesInTree(s.tree, a, b);
      if (!tree) return false;
      recordHistory("swap", `${a}:${b}`);
      set({
        tree,
        panes: ensurePaneState(s.panes, tree),
        activePaneId: s.activePaneId,
        selection: {},
      });
      schedulePersist(get);
      return true;
    },

    updateRatio: (splitId, ratio) => {
      recordHistory("ratio", splitId);
      withTree(updateRatioInTree(get().tree, splitId, ratio));
    },

    beginRatioResize: (splitId) => {
      const s = get();
      ratioDrag = {
        splitId,
        snapshot: snapshotLayout(s),
        history: s.layoutHistory,
        future: s.layoutFuture,
      };
      // 整个拖动事务只在这里入栈一次；移动过程不调用 recordHistory。
      set({
        layoutHistory: [...s.layoutHistory, ratioDrag.snapshot].slice(-MAX_LAYOUT_HISTORY),
        layoutFuture: [],
      });
    },

    previewRatio: (splitId, ratio) => {
      // 拖动帧只改树，不写历史、不排持久化：避免每帧一条撤销记录/一次磁盘写。
      set({ tree: updateRatioInTree(get().tree, splitId, ratio) });
    },

    commitRatioResize: () => {
      if (!ratioDrag) return;
      ratioDrag = null;
      schedulePersist(get);
    },

    cancelRatioResize: () => {
      if (!ratioDrag) return;
      const drag = ratioDrag;
      ratioDrag = null;
      set({
        tree: drag.snapshot.tree,
        layoutHistory: drag.history,
        layoutFuture: drag.future,
      });
      // 预览从未持久化；回到拖动前的已持久化状态，无需再写。
    },

    removePathsFromSelections: (paths) => {
      if (!paths.length) return;
      const remove = new Set(paths.map((p) => normalizePath(p).toLowerCase()));
      set((s) => {
        let changed = false;
        const selection: Record<string, PaneSelection> = {};
        for (const [paneId, current] of Object.entries(s.selection)) {
          const kept = current.paths.filter((p) => !remove.has(normalizePath(p).toLowerCase()));
          if (kept.length === current.paths.length) {
            selection[paneId] = current;
            continue;
          }
          changed = true;
          const anchor = current.anchor && kept.some((p) => samePath(p, current.anchor!))
              ? current.anchor
              : (kept[0] ?? null);
          selection[paneId] = { paths: kept, anchor };
        }
        return changed ? { selection } : s;
      });
    },

    setActivePane: (paneId) => {
      if (!hasPane(get().tree, paneId)) return;
      set({ activePaneId: paneId });
      schedulePersist(get);
    },

    toggleMaximize: (paneId) => {
      set((s) => ({ maximizedPaneId: s.maximizedPaneId === paneId ? null : paneId }));
      // 最大化不改变树形状，但也持久化（下次恢复直接最大化）。
      schedulePersist(get);
    },

    applyLayoutPresetPreservingTabs: (presetId) => {
      const s = get();
      const preset = LAYOUT_PRESETS[presetId];
      if (!preset) return { ok: false, reason: "unknownPreset", tabCount: 0, overflow: 0 };
      const built = preset.build();
      const totalTabs = paneIds(s.tree).reduce((sum, id) => sum + (s.panes[id]?.tabs.length ?? 0), 0);
      if (sameLayoutShape(s.tree, built)) {
        return { ok: true, unchanged: true, tabCount: totalTabs, stashedCount: 0 };
      }
      const { tree } = reassignPaneIds(built);
      const targetIds = paneIds(tree);
      const sources: Array<TransferSource<FolderTab>> = paneIds(s.tree).map((id) => ({
        paneId: id,
        tabs: s.panes[id]?.tabs ?? [],
        activeTabId: s.panes[id]?.activeTabId ?? null,
      }));
      const activeTabId =
        s.panes[s.activePaneId]?.tabs.find((t) => t.tabId === s.panes[s.activePaneId]?.activeTabId)
          ?.tabId ?? null;
      const plan = planTabTransfer(sources, targetIds, {
        maxPerPane: MAX_TABS_PER_PANE,
        activePaneId: s.activePaneId,
        activeTabId,
      });
      // 收纳标签借布局扩容的机会放回（目录不长期滞留在收纳里）：
      // 先在目标槽位剩余容量中按视觉顺序安置，仍放不下的继续保留在收纳中。
      const slots = plan.slots.map((slot) => ({ ...slot, tabs: [...slot.tabs] }));
      const keptStash: FolderTab[] = [];
      for (const tab of s.stashed) {
        const slot = slots.find((candidate) => candidate.tabs.length < MAX_TABS_PER_PANE);
        if (slot) {
          slot.tabs.push(tab);
          slot.activeTabId = slot.activeTabId ?? tab.tabId;
        } else {
          keptStash.push(tab);
        }
      }
      const nextStash = mergeStashed(keptStash, plan.stashed);
      // 容量保护：收纳总量超过上限时**阻止**本次布局转换（绝不截断、绝不丢标签）。
      if (nextStash.length > MAX_STASHED_TABS) {
        return {
          ok: false,
          reason: "capacity",
          tabCount: totalTabs,
          overflow: nextStash.length - MAX_STASHED_TABS,
        };
      }
      const panes: Record<string, PaneState> = {};
      for (const slot of slots) {
        panes[slot.paneId] = { tabs: slot.tabs, activeTabId: slot.activeTabId };
      }
      recordHistory("preset", presetId);
      set({
        tree,
        panes,
        stashed: nextStash,
        activePaneId: plan.activePaneId,
        maximizedPaneId: null,
        selection: {},
      });
      schedulePersist(get);
      return {
        ok: true,
        unchanged: false,
        tabCount: totalTabs,
        stashedCount: plan.stashed.length,
      };
    },

    applyPreset: (presetId, initialPaths) => {
      const preset = LAYOUT_PRESETS[presetId];
      if (!preset) return;
      recordHistory("preset-reset", presetId);
      const { tree } = reassignPaneIds(preset.build());
      set(() => ({
        tree,
        panes: ensurePaneState({}, tree, (initialPaths ?? []).map(normalizePath)),
        maximizedPaneId: null,
        selection: {},
        activePaneId: paneIds(tree)[0],
      }));
      schedulePersist(get);
    },

    applyTemplate: async (templateId, templates) => {
      const template = templates.find((t) => t.id === templateId);
      // 模板缺失：不改任何状态、不记历史、不写设置（调用方据此提示）。
      if (!template) return { ok: false, reason: "missing" };
      // 重映射必须同步覆盖 PersistedPane 与 activePaneId（P0：旧实现拿新 ID 查
      // 旧窗格数据，所有标签丢失）。tabId 直接复用（与 hydrate 一致）。
      const { tree, mapping } = reassignPaneIds(template.tree);
      const panes: Record<string, PaneState> = {};
      const seenTabIds = new Set<string>();
      for (const [oldId, newId] of mapping) {
        const persisted = template.panes.find((p) => p.paneId === oldId);
        const tabs = (persisted?.tabs ?? []).slice(0, MAX_TABS_PER_PANE).map((persistedTab) => {
          const tab = restoreTab(persistedTab);
          if (persistedTab.tabId && !seenTabIds.has(persistedTab.tabId)) {
            seenTabIds.add(persistedTab.tabId);
            tab.tabId = persistedTab.tabId;
          }
          return tab;
        });
        panes[newId] = {
          tabs,
          activeTabId:
            tabs.find((t) => t.tabId === persisted?.activeTabId)?.tabId ?? tabs[0]?.tabId ?? null,
        };
      }
      // 最近使用：该 id 置顶、去重、截断（与 persist.normalizePersisted 的读取规则一致）。
      const recentTemplates = [
        templateId,
        ...get().recentTemplates.filter((id) => id !== templateId),
      ].slice(0, MAX_RECENT);
      recordHistory("template", templateId);
      set({
        tree,
        panes,
        maximizedPaneId: null,
        selection: {},
        activePaneId: paneIds(tree)[0],
        recentTemplates,
      });
      // 显式等待落盘：取消挂起的防抖写入，避免两次写入在不同时机互相覆盖；
      // 本次写入经 persist.ts 串行链执行，包含新布局 + 最近模板顺序。
      cancelPersistTimer();
      try {
        await writeSnapshot(get, { recentTemplates });
        if (get().persistError !== null) applyPersistError?.(null);
        return { ok: true, templateId };
      } catch (e) {
        // 内存状态保留（不回滚已应用的布局），失败由调用方按 result 提示。
        const message = e instanceof Error ? e.message : String(e);
        applyPersistError?.(message);
        return { ok: false, reason: "persist-failed", error: message };
      }
    },

    saveCurrentAsTemplate: async (name) => {
      const snapshot = get().snapshot();
      const template = {
        id: freshId("tpl"),
        name: name.trim().slice(0, 80),
        tree: snapshot.stateData.tree,
        panes: snapshot.stateData.panes,
      };
      await persistFilesWorkspace((current) => ({
        ...current,
        // 追加在末尾（既有展示顺序）；满额时移除数组头部的最旧模板，绝不丢新模板。
        templates:
          current.templates.length >= MAX_TEMPLATES
            ? [...current.templates.slice(1, MAX_TEMPLATES), template]
            : [...current.templates, template],
      }));
      return template;
    },

    undoLayout: () => {
      const s = get();
      const prev = s.layoutHistory[s.layoutHistory.length - 1];
      if (!prev) return false;
      restoreSnapshot(
        prev,
        s.layoutHistory.slice(0, -1),
        [...s.layoutFuture, snapshotLayout(s)].slice(-MAX_LAYOUT_HISTORY),
        new Set(prev.createdTabIds ?? []),
      );
      return true;
    },

    redoLayout: () => {
      const s = get();
      const next = s.layoutFuture[s.layoutFuture.length - 1];
      if (!next) return false;
      restoreSnapshot(
        next,
        [...s.layoutHistory, snapshotLayout(s)].slice(-MAX_LAYOUT_HISTORY),
        s.layoutFuture.slice(0, -1),
      );
      return true;
    },

    setLayoutEditMode: (value) => set({ layoutEditMode: value }),

    recordRecentDir: (path) => {
      const target = normalizePath(path);
      if (!target) return;
      set((s) => ({ recentDirs: dedupeDirs(s.recentDirs, target).slice(0, MAX_RECENT_DIRS) }));
      schedulePersist(get);
    },

    clearRecentDirs: () => {
      if (get().recentDirs.length === 0) return;
      set({ recentDirs: [] });
      schedulePersist(get);
    },

    togglePinnedDir: (path) => {
      const target = normalizePath(path);
      if (!target) return;
      set((s) => {
        const exists = s.pinnedDirs.some((p) => samePath(p, target));
        return {
          pinnedDirs: exists
            ? s.pinnedDirs.filter((p) => !samePath(p, target))
            : [target, ...s.pinnedDirs].slice(0, MAX_PINNED_DIRS),
        };
      });
      schedulePersist(get);
    },

    restoreStashedTab: (tabId, paneId) => {
      const s = get();
      const tab = s.stashed.find((t) => t.tabId === tabId);
      if (!tab) return false;
      const preferred = paneId ?? s.activePaneId;
      const order = hasPane(s.tree, preferred)
        ? [preferred, ...paneIds(s.tree).filter((id) => id !== preferred)]
        : paneIds(s.tree);
      const target = order.find((id) => (s.panes[id]?.tabs.length ?? MAX_TABS_PER_PANE) < MAX_TABS_PER_PANE);
      if (!target) return false;
      recordHistory("restore", tabId);
      set((st) => {
        const pane = st.panes[target];
        if (!pane) return st;
        return {
          panes: {
            ...st.panes,
            [target]: { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.tabId },
          },
          stashed: st.stashed.filter((t) => t.tabId !== tabId),
          activePaneId: target,
        };
      });
      schedulePersist(get);
      return true;
    },

    clearStashed: () => {
      if (get().stashed.length === 0) return;
      recordHistory("stash-clear");
      set({ stashed: [] });
      schedulePersist(get);
    },

    patchTab: (paneId, tabId, patch) => {
      mutateTab(paneId, tabId, (t) => ({ ...t, ...patch }));
    },

    setSelection: (paneId, paths, anchor = null) => {
      set((s) => ({ selection: { ...s.selection, [paneId]: { paths, anchor } } }));
    },

    clearSelection: (paneId) => {
      set((s) => {
        if (!s.selection[paneId]) return s;
        const next = { ...s.selection };
        delete next[paneId];
        return { selection: next };
      });
    },

    notifyDirsChanged: (paths) => {
      invalidateDirs(paths);
    },
  };
});

// 绑定设置存储访问器（串行写入链需要）。
bindSettingsStore(() => useSettingsStore.getState());

// persistError 更新通道：写入链（模块层）→ store 实例（面板可见反馈）。
applyPersistError = (value) => {
  useFilesWorkspaceStore.setState({ persistError: value });
};

export { useFilesWorkspaceStore };
