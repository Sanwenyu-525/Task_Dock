//! 文件工作区状态（工作台窗口内独立 store）。
//!
//! 职责边界：
//! - 树形状（分割树）+ 每窗格标签/导航状态 + 激活窗格 + 最大化 + 选择；
//! - 持久化：经 `filesWorkspace/persist.ts` 串行写入设置键（防抖 600ms），
//!   保存分割树、每窗格标签路径与激活标签；视图/排序/搜索属于会话态不落库；
//! - 目录列表数据不进本 store：`filesWorkspace/dirCache.ts` 按路径缓存，
//!   组件按需订阅，避免同目录多窗格重复拉取；
//! - 项目切换由面板层驱动：`loadForProject`（带代际令牌，旧加载结果作废）。

import { create } from "zustand";

import {
  defaultTree,
  freshId,
  hasPane,
  normalizeTree,
  paneIds,
  paneCount,
  removePane,
  reassignPaneIds,
  splitPane as splitPaneInTree,
  swapPaneWithSibling,
  updateRatio as updateRatioInTree,
  type SplitDirection,
  type SplitNode,
  LAYOUT_PRESETS,
} from "../lib/filesWorkspace/model";
import {
  basename,
  normalizePath,
  parentOf,
  samePath,
} from "../lib/filesWorkspace/pathUtils";
import {
  bindSettingsStore,
  persistFilesWorkspace,
  type PersistedPane,
  type PersistedState,
} from "../lib/filesWorkspace/persist";
import { invalidateDirs } from "../lib/filesWorkspace/dirCache";
import { useSettingsStore } from "./useSettingsStore";

export type ViewMode = "list" | "grid";
export type SortField = "name" | "modified" | "type" | "size";

export interface FolderTab {
  tabId: string;
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

export type SortMenuField = SortField | null;

/** 新标签默认打开位置：用户主目录（不可得时退到 C:\，由面板层传初始目录）。 */
function makeTab(path: string, history: string[] = []): FolderTab {
  const normalized = normalizePath(path);
  const hist = history.length ? [...history, normalized] : [normalized];
  return {
    tabId: freshId("tab"),
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
  return basename(tab.path) || tab.path;
}

interface FilesWorkspaceData {
  tree: SplitNode;
  panes: Record<string, PaneState>;
  activePaneId: string;
  maximizedPaneId: string | null;
}

interface FilesWorkspaceState extends FilesWorkspaceData {
  selection: Record<string, PaneSelection>;
  /** 持久化键（global / project:<id>）；面板层设置。 */
  stateKey: string;
  /** 是否已注入过初始状态（避免空树先渲染）。 */
  hydrated: boolean;
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
  snapshot: () => SnapshotPayload;
  persistNow: () => Promise<void>;

  openInPane: (paneId: string, path: string, mode: "newTab" | "replace") => void;
  openPathInActive: (path: string, mode?: "newTab" | "replace") => void;
  navigate: (paneId: string, direction: "back" | "forward" | "up") => void;
  refreshPane: (paneId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  setActiveTab: (paneId: string, tabId: string) => void;
  duplicateTab: (paneId: string, tabId: string) => void;
  reorderTab: (paneId: string, from: number, to: number) => void;
  moveTabToPane: (tabId: string, fromPaneId: string, toPaneId: string, index?: number) => void;
  extractTabToPane: (tabId: string, fromPaneId: string, targetPaneId: string, direction: SplitDirection) => boolean;

  splitPane: (paneId: string, direction: SplitDirection, openPath?: string | null) => string | null;
  closePane: (paneId: string) => void;
  swapPane: (paneId: string) => void;
  updateRatio: (splitId: string, ratio: number) => void;
  setActivePane: (paneId: string) => void;
  toggleMaximize: (paneId: string) => void;
  applyPreset: (presetId: string, initialPaths?: string[]) => void;
  applyTemplate: (
    templateId: string,
    templates: Array<{ id: string; tree: SplitNode; panes: PersistedPane[] }>,
  ) => void;
  saveCurrentAsTemplate: (name: string) => Promise<{ id: string; tree: SplitNode; panes: PersistedPane[] }>;

  patchTab: (paneId: string, tabId: string, patch: Partial<FolderTab>) => void;
  setSelection: (paneId: string, paths: string[], anchor?: string | null) => void;
  clearSelection: (paneId: string) => void;
  notifyDirsChanged: (paths: string[]) => void;
}

export type FilesWorkspaceStore = FilesWorkspaceState & FilesWorkspaceActions;

/** 持久化快照（stateKey 单独承载，不进 store 公开字段）。 */
interface SnapshotPayload {
  stateKeyRef: string;
  stateData: PersistedState;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(get: () => FilesWorkspaceStore): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = get().snapshot();
    void persistFilesWorkspace((current) => {
      // 重排：把活跃键移到末尾（LRU 语义），再写回。
      const states = { ...current.states };
      delete states[snapshot.stateKeyRef];
      states[snapshot.stateKeyRef] = snapshot.stateData;
      return { ...current, states };
    }).catch(() => {
      // 持久化失败不打断交互；下一次操作会再写（错误在写入链内保留）。
    });
  }, 600);
}

// snapshot 的持久化负载需要 stateKey，单独承载避免污染 store 公开状态。
const useFilesWorkspaceStore = create<FilesWorkspaceStore>((set, get) => {
  const ensurePaneState = (panes: Record<string, PaneState>, tree: SplitNode, initialPaths: string[] = []): Record<string, PaneState> => {
    const next: Record<string, PaneState> = {};
    for (const paneId of paneIds(tree)) {
      const existing = panes[paneId];
      if (existing && existing.tabs.length >= 0) {
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

  return {
    tree: defaultTree(),
    panes: {
      "pane-1": { tabs: [], activeTabId: null },
    },
    activePaneId: "pane-1",
    maximizedPaneId: null,
    selection: {},
    stateKey: "global",
    hydrated: false,

    hydrate: (state, stateKey) => {
      const tree = normalizeTree(state.tree);
      const ids = paneIds(tree);
      const panes: Record<string, PaneState> = {};
      for (const paneId of ids) {
        const persisted = state.panes.find((p) => p.paneId === paneId);
        if (persisted && persisted.tabs.length > 0) {
          const tabs = persisted.tabs.slice(0, 12).map((t) => makeTab(t.path));
          // 恢复：把历史收敛为单条（历史不持久化），路径即当前。
          panes[paneId] = {
            tabs,
            activeTabId:
              tabs.find((t) => t.tabId === persisted.activeTabId)?.tabId ?? tabs[0].tabId,
          };
        } else {
          panes[paneId] = { tabs: [], activeTabId: null };
        }
      }
      set({
        tree,
        panes,
        activePaneId: ids.includes(state.activePaneId) ? state.activePaneId : ids[0],
        maximizedPaneId: null,
        selection: {},
        stateKey,
        hydrated: true,
      });
    },

    setStateKey: (stateKey) => set({ stateKey }),

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
                tabs: pane.tabs.map((t) => ({ tabId: t.tabId, path: t.path })),
                activeTabId: pane.activeTabId,
              },
            ];
          }),
          activePaneId: s.activePaneId,
        },
      };
    },

    persistNow: async () => {
      const snapshot = get().snapshot();
      await persistFilesWorkspace((current) => {
        const states = { ...current.states };
        delete states[snapshot.stateKeyRef];
        states[snapshot.stateKeyRef] = snapshot.stateData;
        return { ...current, states };
      });
    },

    openInPane: (paneId, rawPath, mode) => {
      const path = normalizePath(rawPath);
      if (!path || !hasPane(get().tree, paneId)) return;
      set((s) => {
        const pane = s.panes[paneId];
        if (!pane) return s;
        if (mode === "replace" && pane.activeTabId) {
          return {
            panes: {
              ...s.panes,
              [paneId]: {
                ...pane,
                tabs: pane.tabs.map((t) =>
                  t.tabId === pane.activeTabId ? { ...t, path, history: [path], historyIndex: 0 } : t,
                ),
              },
            },
            activePaneId: paneId,
          };
        }
        if (pane.tabs.length >= 12) return s;
        const tab = makeTab(path);
        return {
          panes: {
            ...s.panes,
            [paneId]: { tabs: [...pane.tabs, tab], activeTabId: tab.tabId },
          },
          activePaneId: paneId,
        };
      });
      schedulePersist(get);
    },

    openPathInActive: (rawPath, mode = "newTab") => {
      const active = get().activePaneId;
      get().openInPane(active, rawPath, mode);
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
      if (tab?.path) invalidateDirs([tab.path], tab.showHidden);
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

    duplicateTab: (paneId, tabId) => {
      set((s) => {
        const pane = s.panes[paneId];
        const source = pane?.tabs.find((t) => t.tabId === tabId);
        if (!pane || !source || pane.tabs.length >= 12) return s;
        const copy: FolderTab = { ...source, tabId: freshId("tab") };
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
      set((s) => {
        const from = s.panes[fromPaneId];
        const to = s.panes[toPaneId];
        const tab = from?.tabs.find((t) => t.tabId === tabId);
        if (!from || !to || !tab || to.tabs.length >= 12) return s;
        const fromTabs = from.tabs.filter((t) => t.tabId !== tabId);
        const toTabs = [...to.tabs];
        toTabs.splice(index ?? toTabs.length, 0, tab);
        return {
          panes: {
            ...s.panes,
            [fromPaneId]: { ...from, tabs: fromTabs, activeTabId: fromTabs[Math.min(fromTabs.length - 1, Math.max(0, from.tabs.findIndex((t) => t.tabId === tabId) - 1))]?.tabId ?? null },
            [toPaneId]: { ...to, tabs: toTabs, activeTabId: tab.tabId },
          },
          activePaneId: toPaneId,
        };
      });
      schedulePersist(get);
    },

    extractTabToPane: (tabId, fromPaneId, targetPaneId, direction) => {
      const s = get();
      const tab = s.panes[fromPaneId]?.tabs.find((t) => t.tabId === tabId);
      if (!tab) return false;
      const result = splitPaneInTree(s.tree, targetPaneId, direction);
      if (!result) return false;
      set((st) => {
        const from = st.panes[fromPaneId];
        if (!from) return st;
        const fromTabs = from.tabs.filter((t) => t.tabId !== tabId);
        const newPane: PaneState = { tabs: [tab], activeTabId: tab.tabId };
        const panes = {
          ...st.panes,
          [fromPaneId]: { ...from, tabs: fromTabs, activeTabId: fromTabs[fromTabs.length - 1]?.tabId ?? null },
          [result.newPaneId]: newPane,
        };
        return { tree: result.tree, panes, activePaneId: result.newPaneId, maximizedPaneId: null };
      });
      schedulePersist(get);
      return true;
    },

    splitPane: (paneId, direction, openPath) => {
      const s = get();
      const result = splitPaneInTree(s.tree, paneId, direction);
      if (!result) return null;
      const path = openPath ?? s.panes[paneId]?.tabs.find((t) => t.tabId === s.panes[paneId]?.activeTabId)?.path ?? "";
      set((st) => {
        const panes = ensurePaneState(st.panes, result.tree);
        const newPane = panes[result.newPaneId];
        if (newPane && newPane.tabs.length === 0 && path) {
          const tab = makeTab(path);
          panes[result.newPaneId] = { tabs: [tab], activeTabId: tab.tabId };
        }
        return { tree: result.tree, panes, activePaneId: result.newPaneId, maximizedPaneId: null };
      });
      schedulePersist(get);
      return result.newPaneId;
    },

    closePane: (paneId) => {
      const s = get();
      if (paneCount(s.tree) <= 1) return;
      const tree = removePane(s.tree, paneId);
      if (!tree) return;
      const remaining = paneIds(tree);
      const panes = { ...s.panes };
      delete panes[paneId];
      set({
        tree,
        panes,
        activePaneId: remaining.includes(s.activePaneId) ? s.activePaneId : remaining[0],
        maximizedPaneId: s.maximizedPaneId === paneId ? null : s.maximizedPaneId,
      });
      schedulePersist(get);
    },

    swapPane: (paneId) => {
      withTree(swapPaneWithSibling(get().tree, paneId));
    },

    updateRatio: (splitId, ratio) => {
      withTree(updateRatioInTree(get().tree, splitId, ratio));
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

    applyPreset: (presetId, initialPaths) => {
      const preset = LAYOUT_PRESETS[presetId];
      if (!preset) return;
      const tree = reassignPaneIds(preset.build());
      set((s) => ({
        tree,
        panes: ensurePaneState({}, tree, (initialPaths ?? []).map(normalizePath)),
        maximizedPaneId: null,
        selection: {},
        activePaneId: paneIds(tree)[0],
      }));
      schedulePersist(get);
    },

    applyTemplate: (templateId, templates) => {
      const template = templates.find((t) => t.id === templateId);
      if (!template) return;
      const tree = reassignPaneIds(template.tree);
      const panes: Record<string, PaneState> = {};
      for (const paneId of paneIds(tree)) {
        const persisted = template.panes.find((p) => p.paneId === paneId);
        const tabs = (persisted?.tabs ?? []).slice(0, 12).map((t) => makeTab(t.path));
        panes[paneId] = { tabs, activeTabId: tabs[0]?.tabId ?? null };
      }
      set({ tree, panes, maximizedPaneId: null, selection: {}, activePaneId: paneIds(tree)[0] });
      schedulePersist(get);
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
        templates: [...current.templates.slice(0, 19), template],
      }));
      return template;
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

export { useFilesWorkspaceStore };
