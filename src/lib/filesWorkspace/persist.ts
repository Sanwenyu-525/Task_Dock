//! 文件工作区持久化（设置键 `file_workspace_layouts`）。
//!
//! 与其他布局域正交（任务规范 §8.3）：
//! - 不写 `workbench_layout`（那是工作台外壳的路由/右栏/宽度）；
//! - 不写 `workspace_instances.layout_json`（那是项目模块顺序）；
//! - 独立版本化 JSON：global 状态 + 项目态（LRU ≤ 8）+ 自定义模板（≤ 20）+ 最近模板。
//!
//! 兼容与回退：损坏/未知版本 → 整体回默认（模板丢失可重建，绝不白屏）；
//! 单个状态/模板损坏只丢弃该条；目录路径失效由恢复侧标注，不阻断布局。

import type { SplitNode } from "./model";
import { normalizeTree, MAX_PANES, MAX_TABS_PER_PANE } from "./model";
import { normalizeColWidths, type ColWidths } from "./columnWidths";

export const FILE_WORKSPACE_SETTING_KEY = "file_workspace_layouts";
export const FILE_WORKSPACE_VERSION = 1;

/**
 * 单窗格标签。
 *
 * `tabId`/`path` 是最小集（旧数据只有这两项）；其余为会话恢复可选字段——
 * 新数据全部写入，缺失时由恢复侧用默认值兜底，因此版本仍为 1（向后兼容）。
 */
export interface PersistedTab {
  tabId: string;
  /** 当前目录（规范化绝对路径）。 */
  path: string;
  /** 用户最初添加的目录；旧数据缺失时用 path 兜底。 */
  openedPath?: string;
  /** 导航历史（含当前）；缺失时收敛为单条 path。 */
  history?: string[];
  /** 历史游标（校验在界内）。 */
  historyIndex?: number;
  viewMode?: "list" | "grid";
  sortField?: "name" | "modified" | "type" | "size";
  sortAsc?: boolean;
  search?: string;
  filter?:
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
  showHidden?: boolean;
}

export interface PersistedPane {
  paneId: string;
  tabs: PersistedTab[];
  activeTabId: string | null;
}

export interface PersistedState {
  tree: SplitNode;
  panes: PersistedPane[];
  activePaneId: string;
  /**
   * 用户显式固定的目录（跨重启保留；与「最近打开」不同，固定项不会被 LRU 淘汰）。
   * 第三轮新增：目录会话的元数据，与布局无关——改变布局不会清空它。
   */
  pinnedDirs?: string[];
  /** 最近打开目录（LRU，最多 MAX_RECENT_DIRS）。 */
  recentDirs?: string[];
  /**
   * 容量收纳的标签：目标布局装不下时暂存于此，绝不截断。
   * 与布局一起持久化，重启后仍可恢复。
   */
  stashed?: PersistedTab[];
  /** 列表视图列宽（仅用户改过的列；旧数据缺失时该列回默认，向后兼容版本仍为 1）。 */
  colWidths?: ColWidths;
  /**
   * 右侧预览检查器（是否开启 + 宽度）。旧数据没有该字段 → 关闭 + 默认宽度，
   * 不新增设置键、不新增 SQLite 表。
   */
  previewPane?: PersistedPreviewPane;
}

export interface PersistedPreviewPane {
  open: boolean;
  width: number;
}

/** 预览检查器宽度边界（与界面拖拽的钳制共用同一组常量）。 */
export const PREVIEW_PANE_MIN_WIDTH = 280;
export const PREVIEW_PANE_MAX_WIDTH = 520;
export const PREVIEW_PANE_DEFAULT_WIDTH = 360;


export interface PersistedTemplate {
  id: string;
  name: string;
  tree: SplitNode;
  panes: PersistedPane[];
}

export interface FilesWorkspacePersisted {
  version: number;
  /** 键：`global` 或 `project:<id>`。 */
  states: Record<string, PersistedState>;
  templates: PersistedTemplate[];
  recentTemplates: string[];
}

export const MAX_STATES = 8;
export const MAX_TEMPLATES = 20;
export const MAX_RECENT = 8;
/** 最近打开目录上限（去重后按最近使用排序）。 */
export const MAX_RECENT_DIRS = 8;
/** 固定目录上限（防止持久化载荷无界增长）。 */
export const MAX_PINNED_DIRS = 12;
/** 收纳标签上限：超过时保留最早的（宁可停用更多布局，也不能丢目录）。 */
export const MAX_STASHED_TABS = 64;


export function defaultPersisted(): FilesWorkspacePersisted {
  return { version: FILE_WORKSPACE_VERSION, states: {}, templates: [], recentTemplates: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 路径合法性（持久化侧只做形状校验；存在性由恢复侧按需探测）。 */
function sanePath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 4096) return null;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value;
}

/** 会话枚举白名单（与 store 的同名联合类型一致，但本模块不依赖 store）。 */
const VIEW_MODES = ["list", "grid"] as const;
const SORT_FIELDS = ["name", "modified", "type", "size"] as const;
const FILE_FILTERS = [
  "all", "folder", "image", "video", "audio", "doc", "sheet",
  "slide", "code", "archive", "large", "recent",
] as const;

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : null;
}

/** 历史数组上限（与 store 内导航裁剪一致）。 */
const MAX_PERSISTED_HISTORY = 64;

/**
 * 归一化单个持久化标签：透传并校验会话字段，旧数据缺 openedPath 时用 path 兜底。
 * `seenTabIds` 跨窗格/收纳共享，用于保证 tabId 全局唯一（重复者直接丢弃）。
 */
function normalizePersistedTab(raw: Record<string, unknown>, seenTabIds: Set<string>): PersistedTab | null {
  const path = sanePath(raw.path);
  const tabId = typeof raw.tabId === "string" && raw.tabId.length <= 64 ? raw.tabId : null;
  if (!path || !tabId || seenTabIds.has(tabId)) return null;
  seenTabIds.add(tabId);

  const tab: PersistedTab = {
    tabId,
    path,
    openedPath: sanePath(raw.openedPath) ?? path,
  };

  if (Array.isArray(raw.history)) {
    const history = raw.history
      .map((p) => sanePath(p))
      .filter((p): p is string => p !== null)
      .slice(0, MAX_PERSISTED_HISTORY);
    if (history.length > 0) {
      tab.history = history;
      const idx =
        typeof raw.historyIndex === "number" && Number.isInteger(raw.historyIndex)
          ? raw.historyIndex
          : history.length - 1;
      tab.historyIndex = Math.min(Math.max(idx, 0), history.length - 1);
    }
  }
  const viewMode = oneOf(raw.viewMode, VIEW_MODES);
  if (viewMode) tab.viewMode = viewMode;
  const sortField = oneOf(raw.sortField, SORT_FIELDS);
  if (sortField) tab.sortField = sortField;
  const filter = oneOf(raw.filter, FILE_FILTERS);
  if (filter) tab.filter = filter;
  if (typeof raw.sortAsc === "boolean") tab.sortAsc = raw.sortAsc;
  if (typeof raw.showHidden === "boolean") tab.showHidden = raw.showHidden;
  if (typeof raw.search === "string") tab.search = raw.search;
  return tab;
}

function normalizePanes(
  raw: unknown,
  tree: SplitNode,
  seenTabIds: Set<string> = new Set(),
): PersistedPane[] {
  const validPaneIds = new Set(idsOf(tree));
  const panes: PersistedPane[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw.slice(0, MAX_PANES)) {
      if (!isRecord(item)) continue;
      const paneId = typeof item.paneId === "string" ? item.paneId : null;
      if (!paneId || !validPaneIds.has(paneId)) continue;
      const tabs: PersistedTab[] = [];
      if (Array.isArray(item.tabs)) {
        for (const tab of item.tabs.slice(0, MAX_TABS_PER_PANE)) {
          if (!isRecord(tab)) continue;
          const normalized = normalizePersistedTab(tab, seenTabIds);
          if (normalized) tabs.push(normalized);
        }
      }
      // activeTabId 必须指向本窗格实际存在的标签，否则回落首个（绝不悬空）。
      const activeTabId =
        typeof item.activeTabId === "string" && tabs.some((t) => t.tabId === item.activeTabId)
          ? item.activeTabId
          : (tabs[0]?.tabId ?? null);
      panes.push({ paneId, tabs, activeTabId });
    }
  }
  return panes;
}

/** 分割树收集窗格 ID（与 model.paneIds 一致的顺序）。 */
function idsOf(node: SplitNode): string[] {
  if (node.type === "pane") return [node.paneId];
  return [...idsOf(node.first), ...idsOf(node.second)];
}

/** 目录列表（去重 + 上限；非法项直接丢弃）。 */
function normalizeDirs(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const path = sanePath(item);
    if (!path) continue;
    if (out.some((p) => p.toLowerCase() === path.toLowerCase())) continue;
    out.push(path);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeStashed(raw: unknown, seenTabIds: Set<string> = new Set()): PersistedTab[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedTab[] = [];
  for (const item of raw.slice(0, MAX_STASHED_TABS)) {
    if (!isRecord(item)) continue;
    const normalized = normalizePersistedTab(item, seenTabIds);
    if (normalized) out.push(normalized);
  }
  return out;
}

function normalizeState(raw: unknown): PersistedState | null {
  if (!isRecord(raw)) return null;
  const tree = normalizeTree(raw.tree);
  // 跨窗格 + 收纳共享去重集合：同一 tabId 在整套状态里只能出现一次。
  const seenTabIds = new Set<string>();
  const panes = normalizePanes(raw.panes, tree, seenTabIds);
  const ids = idsOf(tree);
  if (ids.length === 0) return null;
  const activePaneId =
    typeof raw.activePaneId === "string" && ids.includes(raw.activePaneId)
      ? raw.activePaneId
      : ids[0];
  const previewPane = normalizePreviewPane(raw.previewPane);
  return {
    tree,
    panes,
    activePaneId,
    pinnedDirs: normalizeDirs(raw.pinnedDirs, MAX_PINNED_DIRS),
    recentDirs: normalizeDirs(raw.recentDirs, MAX_RECENT_DIRS),
    stashed: normalizeStashed(raw.stashed, seenTabIds),
    colWidths: normalizeColWidths(raw.colWidths),
    ...(previewPane ? { previewPane } : {}),
  };
}

/**
 * 预览检查器状态归一化：宽度钳制到 [280, 520]，非整数四舍五入。
 * 损坏/缺失 → undefined（读取侧用默认关闭 + 360px），绝不因一个字段回退整个布局。
 */
export function normalizePreviewPane(raw: unknown): PersistedPreviewPane | undefined {
  if (!isRecord(raw)) return undefined;
  const open = typeof raw.open === "boolean" ? raw.open : false;
  const widthRaw = typeof raw.width === "number" && Number.isFinite(raw.width) ? raw.width : PREVIEW_PANE_DEFAULT_WIDTH;
  const width = Math.min(
    PREVIEW_PANE_MAX_WIDTH,
    Math.max(PREVIEW_PANE_MIN_WIDTH, Math.round(widthRaw)),
  );
  return { open, width };
}


/**
 * 归一化任意来源的持久化数据。绝不抛错：
 * - version 缺失/非法 → 整体回默认；
 * - states 超限取最近（states 本身就是 LRU，写入侧维护，读取侧只裁剪数量）；
 * - 模板逐条校验（tree/panes 损坏丢弃该模板）。
 */
export function normalizePersisted(raw: unknown): FilesWorkspacePersisted {
  if (!isRecord(raw) || raw.version !== FILE_WORKSPACE_VERSION) {
    return defaultPersisted();
  }
  const out = defaultPersisted();
  if (isRecord(raw.states)) {
    const entries = Object.entries(raw.states).slice(0, MAX_STATES);
    for (const [key, value] of entries) {
      const keyOk = key === "global" || /^project:[A-Za-z0-9_-]{1,64}$/.test(key);
      if (!keyOk) continue;
      const state = normalizeState(value);
      if (state) out.states[key] = state;
    }
  }
  if (Array.isArray(raw.templates)) {
    for (const item of raw.templates.slice(0, MAX_TEMPLATES)) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === "string" && item.id.length <= 64 ? item.id : null;
      const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 80) : null;
      if (!id || !name) continue;
      const tree = normalizeTree(item.tree);
      if (idsOf(tree).length === 0) continue;
      const panes = normalizePanes(item.panes, tree);
      out.templates.push({ id, name, tree, panes });
    }
  }
  if (Array.isArray(raw.recentTemplates)) {
    for (const id of raw.recentTemplates) {
      if (typeof id === "string" && id.length <= 64 && !out.recentTemplates.includes(id)) {
        out.recentTemplates.push(id);
        if (out.recentTemplates.length >= MAX_RECENT) break;
      }
    }
  }
  return out;
}

// ── 串行写入链（与 workbenchLayout 同模式）────────────────────────────

type SettingsLike = {
  settings: unknown;
  update: (patch: Record<string, unknown>) => Promise<void>;
};

let writeChain: Promise<void> = Promise.resolve();

/** 注册设置存储访问器（由 store 注入，保持本模块无 React 依赖）。 */
let getStore: (() => SettingsLike) | null = null;
export function bindSettingsStore(fn: () => SettingsLike): void {
  getStore = fn;
}

/**
 * 读取当前设置中的归一化数据（只读，不触发写入）。
 * 设置尚未加载时返回 null：调用方应保留内存中的值（如最近模板顺序），不得清空。
 */
export function readFilesWorkspacePersisted(): FilesWorkspacePersisted | null {
  const store = getStore?.();
  if (!store || store.settings === null || store.settings === undefined) return null;
  const settings = store.settings as Record<string, unknown>;
  return normalizePersisted(settings[FILE_WORKSPACE_SETTING_KEY]);
}

/**
 * 读-改-写串行落库：后一次写入基于前一次结果（避免快速操作互相覆盖）。
 * 写入失败直接抛错，由调用方就地反馈，不静默吞掉。
 */
export async function persistFilesWorkspace(
  mutate: (current: FilesWorkspacePersisted) => FilesWorkspacePersisted,
): Promise<void> {
  const run = writeChain.then(async () => {
    const store = getStore?.();
    if (!store || store.settings === null || store.settings === undefined) {
      throw new Error("设置尚未加载，请稍后重试");
    }
    const settings = store.settings as Record<string, unknown>;
    const current = normalizePersisted(settings[FILE_WORKSPACE_SETTING_KEY]);
    const next = mutate(current);
    // LRU 收敛：states 超 MAX_STATES 时丢弃最旧（由 mutate 侧维护 updatedAt 太重，
    // 这里按对象键序保留前 N 个即可——写入侧总是把活跃键放回末尾）。
    const stateKeys = Object.keys(next.states);
    if (stateKeys.length > MAX_STATES) {
      for (const key of stateKeys.slice(0, stateKeys.length - MAX_STATES)) {
        delete next.states[key];
      }
    }
    await store.update({ [FILE_WORKSPACE_SETTING_KEY]: next });
  });
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 测试用：等待写入链落定。 */
export function __flushFilesWorkspaceWrites(): Promise<void> {
  return writeChain;
}

/** 测试用：重置写入链。 */
export function __resetFilesWorkspaceWrites(): void {
  writeChain = Promise.resolve();
}
