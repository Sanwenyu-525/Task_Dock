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

export const FILE_WORKSPACE_SETTING_KEY = "file_workspace_layouts";
export const FILE_WORKSPACE_VERSION = 1;

/** 单窗格标签（持久化最小集；视图/排序属于会话恢复可选数据）。 */
export interface PersistedTab {
  tabId: string;
  path: string;
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
}

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

function normalizePanes(raw: unknown, tree: SplitNode): PersistedPane[] {
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
          const path = sanePath(tab.path);
          const tabId = typeof tab.tabId === "string" && tab.tabId.length <= 64 ? tab.tabId : null;
          if (path && tabId) tabs.push({ tabId, path });
        }
      }
      const activeTabId =
        typeof item.activeTabId === "string" &&
        tabs.some((t) => t.tabId === item.activeTabId)
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

function normalizeState(raw: unknown): PersistedState | null {
  if (!isRecord(raw)) return null;
  const tree = normalizeTree(raw.tree);
  const panes = normalizePanes(raw.panes, tree);
  const ids = idsOf(tree);
  if (ids.length === 0) return null;
  const activePaneId =
    typeof raw.activePaneId === "string" && ids.includes(raw.activePaneId)
      ? raw.activePaneId
      : ids[0];
  return { tree, panes, activePaneId };
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
