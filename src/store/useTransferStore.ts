//! 工作篮状态：条目、筛选、选择、面板与批次进度。
//!
//! 设计取舍：
//! - 条目正文由后端分级存储，前端列表只拿必要字段；
//! - 选择用 id 数组而不是对象，切换筛选后只保留仍存在的 id；
//! - 批次进度以 `transfer_batch` 的返回值为准，事件只触发一次刷新；
//! - 面板状态走 `panelState`（localStorage），与条目数据分离。

import { create } from "zustand";
import * as client from "../lib/crossTab/transferClient";
import {
  DEFAULT_PANEL_STATE,
  getPanelState,
  resolvePanelMode,
  setPanelState,
  setPanelWidth,
  subscribePanelState,
} from "../lib/crossTab/panelState";
import type {
  PanelState,
  TransferBatch,
  TransferContext,
  TransferCounts,
  TransferItem,
  TransferItemInput,
  TransferOptions,
  TransferTarget,
} from "../lib/crossTab/types";

interface TransferFilterState {
  search: string;
  itemTypes: string[];
}

interface TransferStore {
  items: TransferItem[];
  total: number;
  counts: TransferCounts;
  loading: boolean;
  error: string | null;
  filter: TransferFilterState;
  selection: string[];
  panel: PanelState;
  context: TransferContext;
  activeBatch: TransferBatch | null;
  pending: { ids: string[]; target: TransferTarget; options: TransferOptions } | null;
  busy: boolean;
  lastMessage: string | null;

  refresh: () => Promise<void>;
  setSearch: (search: string) => void;
  setItemTypes: (types: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  selectAllVisible: () => void;

  add: (inputs: TransferItemInput[]) => Promise<{ added: number; duplicates: number }>;
  remove: (ids: string[]) => Promise<number>;
  togglePin: (id: string) => Promise<void>;
  clearTemporary: () => Promise<number>;

  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  togglePinnedPanel: () => void;
  resizePanel: (width: number) => void;
  panelMode: () => "dock" | "drawer";

  send: (ids: string[], target: TransferTarget, options?: TransferOptions) => Promise<TransferBatch>;
  retry: (options?: TransferOptions) => Promise<TransferBatch | null>;
  undo: (batchId: string) => Promise<{ moved: number; message: string }>;
  setContext: (context: TransferContext) => void;
  dismissBatch: () => void;
}

const EMPTY_COUNTS: TransferCounts = { total: 0, ready: 0, failed: 0, pinned: 0 };

/** 列表展示顺序：固定优先，其次按 sort_order。 */
function sortItems(items: TransferItem[]): TransferItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.sortOrder - b.sortOrder;
  });
}

let refreshSeq = 0;
let monitorTimer: number | null = null;

function stopMonitor(): void {
  if (monitorTimer !== null) {
    window.clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

export const useTransferStore = create<TransferStore>()((set, get) => ({
  items: [],
  total: 0,
  counts: EMPTY_COUNTS,
  loading: false,
  error: null,
  filter: { search: "", itemTypes: [] },
  selection: [],
  panel: getPanelState(),
  context: {
    module: "",
    projectId: null,
    taskId: null,
    directory: null,
    planningId: null,
    knowledgeId: null,
    captureId: null,
    window: "",
    updatedAt: 0,
  },
  activeBatch: null,
  pending: null,
  busy: false,
  lastMessage: null,

  refresh: async () => {
    const seq = ++refreshSeq;
    const { filter } = get();
    set({ loading: true, error: null });
    try {
      const [page, counts] = await Promise.all([
        client.listItems({
          search: filter.search.trim() || undefined,
          itemTypes: filter.itemTypes.length ? filter.itemTypes : undefined,
          limit: 200,
        }),
        client.getCounts(),
      ]);
      if (seq !== refreshSeq) return;
      const ids = new Set(page.items.map((item) => item.id));
      set((state) => ({
        items: sortItems(page.items),
        total: page.total,
        counts,
        loading: false,
        selection: state.selection.filter((id) => ids.has(id)),
      }));
    } catch (error) {
      if (seq !== refreshSeq) return;
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  setSearch: (search) => {
    set((state) => ({ filter: { ...state.filter, search } }));
    void get().refresh();
  },

  setItemTypes: (itemTypes) => {
    set((state) => ({ filter: { ...state.filter, itemTypes } }));
    void get().refresh();
  },

  toggleSelection: (id) =>
    set((state) => ({
      selection: state.selection.includes(id)
        ? state.selection.filter((x) => x !== id)
        : [...state.selection, id],
    })),

  clearSelection: () => set({ selection: [] }),

  selectAllVisible: () =>
    set((state) => ({ selection: state.items.filter((item) => item.status !== "sent").map((item) => item.id) })),

  add: async (inputs) => {
    const report = await client.addItems(inputs);
    await get().refresh();
    return { added: report.items.length, duplicates: report.duplicates };
  },

  remove: async (ids) => {
    const report = await client.removeItems(ids);
    set((state) => ({ selection: state.selection.filter((id) => !ids.includes(id)) }));
    await get().refresh();
    return report.removed;
  },

  togglePin: async (id) => {
    const item = get().items.find((entry) => entry.id === id);
    if (!item) return;
    await client.pinItem(id, !item.pinned);
    await get().refresh();
  },

  clearTemporary: async () => {
    const removed = await client.clearTemporary();
    await get().refresh();
    return removed;
  },

  openPanel: () => {
    const next = setPanelState({ visible: true });
    set({ panel: next });
    void get().refresh();
  },

  closePanel: () => {
    const next = setPanelState({ visible: false });
    set({ panel: next });
  },

  togglePanel: () => {
    const next = setPanelState({ visible: !get().panel.visible });
    set({ panel: next });
    if (next.visible) void get().refresh();
  },

  togglePinnedPanel: () => {
    const next = setPanelState({ pinned: !get().panel.pinned });
    set({ panel: next });
  },

  resizePanel: (width) => {
    const next = setPanelWidth(width);
    set({ panel: next });
  },

  panelMode: () => resolvePanelMode(window.innerWidth),

  send: async (ids, target, options = client.DEFAULT_OPTIONS) => {
    set({ busy: true, lastMessage: null });
    try {
      const batch = await client.executeTransfer(ids, target, options);
      set({ activeBatch: batch, pending: { ids, target, options }, busy: false });
      stopMonitor();
      monitorTimer = window.setInterval(() => {
        void (async () => {
          const current = get().activeBatch;
          if (!current) {
            stopMonitor();
            return;
          }
          try {
            const next = await client.getBatch(current.id);
            set({ activeBatch: next });
            if (["completed", "partial", "failed", "cancelled"].includes(next.status)) {
              stopMonitor();
              set({ pending: null, lastMessage: next.message });
              await get().refresh();
            }
          } catch {
            stopMonitor();
          }
        })();
      }, 600);
      return batch;
    } catch (error) {
      set({ busy: false, lastMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  retry: async (options = client.DEFAULT_OPTIONS) => {
    const batch = get().activeBatch;
    if (!batch) return null;
    set({ busy: true });
    try {
      const next = await client.retryBatch(batch.id, options);
      set({ activeBatch: next, busy: false });
      await get().refresh();
      return next;
    } finally {
      set({ busy: false });
    }
  },

  undo: async (batchId) => {
    const result = await client.undoBatch(batchId);
    await get().refresh();
    return { moved: result.moved, message: result.message };
  },

  setContext: (context) => set({ context }),

  dismissBatch: () => {
    stopMonitor();
    set({ activeBatch: null, pending: null, lastMessage: null });
  },
}));

// 面板状态跨窗口同步：另一个窗口改了宽度/可见性，本窗口跟随。
subscribePanelState((next) => {
  useTransferStore.setState({ panel: next });
});

/** 仅供测试重置。 */
export function resetTransferPanelForTests(): void {
  stopMonitor();
  useTransferStore.setState({
    panel: DEFAULT_PANEL_STATE,
    items: [],
    selection: [],
    activeBatch: null,
    pending: null,
  });
}
