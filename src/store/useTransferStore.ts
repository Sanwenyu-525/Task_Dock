//! 工作篮状态：条目、筛选、选择、面板与批次进度。
//!
//! 设计取舍：
//! - 条目正文由后端分级存储，前端列表只拿必要字段；
//! - 选择用 id 数组而不是对象，切换筛选后只保留仍存在的 id；
//! - 批次进度以 `transfer_batch` 的返回值为准，事件只触发一次刷新；
//! - 面板状态走 `panelState`（localStorage，唯一事实源），与条目数据分离；
//! - 移除条目会先取完整快照，撤销时按原 id / 原正文恢复，不只恢复标题。

import { create } from "zustand";
import * as client from "../lib/crossTab/transferClient";
import {
  DEFAULT_PANEL_STATE,
  getPanelMode,
  getPanelState,
  setPanelMode as writePanelMode,
  setPanelState,
  setPanelWidth,
  subscribePanelMode,
  subscribePanelState,
} from "../lib/crossTab/panelState";
import type {
  PanelMode,
  PanelState,
  TransferAddResult,
  TransferBatch,
  TransferContext,
  TransferCounts,
  TransferItem,
  TransferItemInput,
  TransferOptions,
  TransferRejection,
  TransferTarget,
} from "../lib/crossTab/types";

interface TransferFilterState {
  search: string;
  itemTypes: string[];
}

/** 被移除条目的完整快照：撤销时按原 id / 原正文恢复。 */
export interface RemovedSnapshot {
  items: TransferItem[];
  at: number;
}

interface TransferStore {
  items: TransferItem[];
  total: number;
  counts: TransferCounts;
  loading: boolean;
  error: string | null;
  /** 本窗口是否已完成首次加载：面板在 dock/drawer 之间切换时不再重复请求。 */
  loaded: boolean;
  filter: TransferFilterState;
  selection: string[];
  panel: PanelState;
  panelMode: PanelMode;
  context: TransferContext;
  activeBatch: TransferBatch | null;
  /**
   * 批次轮询状态：`failed` 表示自动重试次数用尽（不是批次失败）。
   * 界面必须能区分「批次完成」与「状态查不到」，后者提供手动重试。
   */
  monitorState: "idle" | "polling" | "retrying" | "failed";
  monitorError: string | null;
  monitorAttempts: number;
  pending: { ids: string[]; target: TransferTarget; options: TransferOptions } | null;
  lastRemoved: RemovedSnapshot | null;
  busy: boolean;
  lastMessage: string | null;

  refresh: () => Promise<void>;
  /** 首次加载：已加载过则直接返回（切换面板形态不重复请求后端）。 */
  ensureLoaded: () => Promise<void>;
  setSearch: (search: string) => void;
  setItemTypes: (types: string[]) => void;
  toggleSelection: (id: string) => void;
  selectItem: (id: string, selected: boolean) => void;
  clearSelection: () => void;
  selectAllVisible: () => void;
  invertSelection: () => void;

  add: (inputs: TransferItemInput[]) => Promise<TransferAddResult>;
  remove: (ids: string[]) => Promise<number>;
  undoRemove: () => Promise<number>;
  dismissRemoved: () => void;
  togglePin: (id: string) => Promise<void>;
  clearTemporary: () => Promise<number>;
  reorder: (ids: string[]) => Promise<void>;

  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  togglePinnedPanel: () => boolean;
  resizePanel: (width: number) => void;
  setPanelMode: (mode: PanelMode) => void;

  send: (ids: string[], target: TransferTarget, options?: TransferOptions) => Promise<TransferBatch>;
  retry: () => Promise<TransferBatch | null>;
  /** 批次状态自动轮询放弃后，由用户手动重新开始（不清空 activeBatch）。 */
  retryBatchMonitor: () => void;
  undo: (batchId: string) => Promise<{ moved: number; ok: boolean; message: string }>;
  setContext: (context: TransferContext) => void;
  handleBatchEvent: (payload: unknown) => void;
  dismissBatch: () => void;
}

const EMPTY_COUNTS: TransferCounts = { total: 0, ready: 0, failed: 0, pinned: 0 };
const TERMINAL = ["completed", "partial", "failed", "cancelled"];

/** 列表展示顺序：固定优先，其次按 sort_order。 */
function sortItems(items: TransferItem[]): TransferItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.sortOrder - b.sortOrder;
  });
}

let refreshSeq = 0;
let monitorTimer: number | null = null;
let monitorSeq = 0;

/** 批次轮询节奏：600ms 起步，失败按 2 倍退避到 5s，最多 6 次后停在 `failed`。 */
const MONITOR_BASE_MS = 600;
const MONITOR_MAX_MS = 5000;
const MONITOR_MAX_ATTEMPTS = 6;
/** 窗口隐藏时的复查间隔：不做 IPC，只等回到前台。 */
const MONITOR_HIDDEN_MS = 2000;

function stopMonitor(): void {
  monitorSeq += 1;
  if (monitorTimer !== null) {
    window.clearTimeout(monitorTimer);
    monitorTimer = null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useTransferStore = create<TransferStore>()((set, get) => {
  /**
   * 单一批次监控：send / retry 共用；重复调用会先停掉上一轮。
   *
   * 失败不再「一次就永久停止」：单次 IPC 失败可能只是后端忙/窗口隐藏，
   * 按 2 倍退避重试有限次数；真的查不到才停在 `failed` 并保留 activeBatch，
   * 由用户点「重新检查」再启动（`retryBatchMonitor`）。
   */
  function startBatchMonitor(batchId: string): void {
    stopMonitor();
    const seq = monitorSeq;
    let attempts = 0;
    let delay = MONITOR_BASE_MS;

    const schedule = (ms: number) => {
      if (seq !== monitorSeq) return;
      monitorTimer = window.setTimeout(() => {
        monitorTimer = null;
        void tick();
      }, ms);
    };

    const tick = async () => {
      if (seq !== monitorSeq) return;
      // 窗口不可见时不做 IPC：WebView 定时器不会自动停，但查进度对用户没有意义。
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule(MONITOR_HIDDEN_MS);
        return;
      }
      try {
        const next = await client.getBatch(batchId);
        if (seq !== monitorSeq) return;
        attempts = 0;
        delay = MONITOR_BASE_MS;
        set({
          activeBatch: next,
          monitorState: "polling",
          monitorError: null,
          monitorAttempts: 0,
        });
        if (TERMINAL.includes(next.status)) {
          stopMonitor();
          set({ pending: null, lastMessage: next.message, monitorState: "idle" });
          await get().refresh();
          return;
        }
        schedule(delay);
      } catch (error) {
        if (seq !== monitorSeq) return;
        attempts += 1;
        if (attempts >= MONITOR_MAX_ATTEMPTS) {
          stopMonitor();
          // 不清 activeBatch / pending：批次可能还在跑，只是暂时查不到状态。
          set({
            monitorState: "failed",
            monitorError: messageOf(error),
            monitorAttempts: attempts,
          });
          return;
        }
        delay = Math.min(delay * 2, MONITOR_MAX_MS);
        set({
          monitorState: "retrying",
          monitorError: messageOf(error),
          monitorAttempts: attempts,
        });
        schedule(delay);
      }
    };
    void tick();
  }

  async function refreshBatch(batchId: string): Promise<TransferBatch | null> {
    try {
      const next = await client.getBatch(batchId);
      set({
        activeBatch: next,
        monitorState: TERMINAL.includes(next.status) ? "idle" : "polling",
        monitorError: null,
        monitorAttempts: 0,
      });
      if (TERMINAL.includes(next.status)) {
        stopMonitor();
        set({ pending: null, lastMessage: next.message });
        await get().refresh();
      }
      return next;
    } catch {
      return null;
    }
  }

  return {
    items: [],
    total: 0,
    counts: EMPTY_COUNTS,
    loading: false,
    error: null,
    loaded: false,
    filter: { search: "", itemTypes: [] },
    selection: [],
    panel: getPanelState(),
    panelMode: getPanelMode(),
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
    monitorState: "idle",
    monitorError: null,
    monitorAttempts: 0,
    pending: null,
    lastRemoved: null,
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
          loaded: true,
          selection: state.selection.filter((id) => ids.has(id)),
        }));
      } catch (error) {
        if (seq !== refreshSeq) return;
        set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    },

    ensureLoaded: async () => {
      if (get().loaded || get().loading) return;
      await get().refresh();
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

    selectItem: (id, selected) =>
      set((state) => ({
        selection: selected
          ? state.selection.includes(id)
            ? state.selection
            : [...state.selection, id]
          : state.selection.filter((x) => x !== id),
      })),

    clearSelection: () => set({ selection: [] }),

    selectAllVisible: () =>
      set((state) => ({
        selection: state.items.filter((item) => item.status !== "sent").map((item) => item.id),
      })),

    invertSelection: () =>
      set((state) => {
        const selectable = state.items.filter((item) => item.status !== "sent").map((item) => item.id);
        const current = new Set(state.selection);
        return { selection: selectable.filter((id) => !current.has(id)) };
      }),

    add: async (inputs) => {
      const report = await client.addItems(inputs);
      await get().refresh();
      return {
        added: report.items.length,
        duplicates: report.duplicates,
        rejected: (report.rejected ?? []) as TransferRejection[],
        items: report.items,
      };
    },

    remove: async (ids) => {
      // 先取完整快照（含溢出正文），撤销才能恢复正文而不仅是标题。
      const snapshot: TransferItem[] = [];
      for (const id of ids) {
        try {
          snapshot.push(await client.getItem(id));
        } catch {
          const cached = get().items.find((item) => item.id === id);
          if (cached) snapshot.push(cached);
        }
      }
      const report = await client.removeItems(ids);
      set((state) => ({
        selection: state.selection.filter((id) => !ids.includes(id)),
        lastRemoved: snapshot.length ? { items: snapshot, at: Date.now() } : state.lastRemoved,
      }));
      await get().refresh();
      return report.removed;
    },

    undoRemove: async () => {
      const snapshot = get().lastRemoved;
      if (!snapshot || snapshot.items.length === 0) return 0;
      const inputs: TransferItemInput[] = snapshot.items.map((item) => ({
        id: item.id,
        itemType: item.itemType,
        sourceModule: item.sourceModule,
        sourceId: item.sourceId,
        title: item.title,
        description: item.description,
        content: item.content,
        payload: item.payload,
        pinned: item.pinned,
      }));
      const report = await client.addItems(inputs);
      set({ lastRemoved: null });
      await get().refresh();
      return report.items.length;
    },

    dismissRemoved: () => set({ lastRemoved: null }),

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

    reorder: async (ids) => {
      // 乐观更新，后端失败时用真实列表回滚。
      set((state) => {
        const byId = new Map(state.items.map((item) => [item.id, item]));
        const ordered = ids
          .map((id) => byId.get(id))
          .filter((item): item is TransferItem => Boolean(item));
        const rest = state.items.filter((item) => !ids.includes(item.id));
        return { items: [...ordered, ...rest] };
      });
      try {
        await client.reorderItems(ids);
      } finally {
        await get().refresh();
      }
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

    /** 返回固定后的真实形态提示：`false` 表示当前无法固定为列。 */
    togglePinnedPanel: () => {
      const next = setPanelState({ pinned: !get().panel.pinned });
      set({ panel: next });
      return get().panelMode === "dock" && next.visible;
    },

    resizePanel: (width) => {
      const next = setPanelWidth(width);
      set({ panel: next });
    },

    setPanelMode: (mode) => {
      writePanelMode(mode);
      set({ panelMode: mode });
    },

    send: async (ids, target, options = client.DEFAULT_OPTIONS) => {
      set({ busy: true, lastMessage: null });
      try {
        const batch = await client.executeTransfer(ids, target, options);
        set({ activeBatch: batch, pending: { ids, target, options }, busy: false });
        startBatchMonitor(batch.id);
        return batch;
      } catch (error) {
        set({ busy: false, lastMessage: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },

    retry: async () => {
      const batch = get().activeBatch;
      if (!batch) return null;
      set({ busy: true });
      try {
        // 重试沿用原始目标 / 冲突策略 / 文本格式 / 文件操作模式；后端以批次记录为准。
        const options = get().pending?.options ?? client.DEFAULT_OPTIONS;
        const next = await client.retryBatch(batch.id, options);
        set({
          activeBatch: next,
          // 重试批次只覆盖失败项；保留原目标与选项，供再次重试/撤销沿用。
          pending: {
            ids: get().pending?.ids ?? next.entries.map((entry) => entry.itemId),
            target: { module: next.targetModule, ref: next.targetRef },
            options,
          },
        });
        startBatchMonitor(next.id);
        await get().refresh();
        return next;
      } finally {
        set({ busy: false });
      }
    },

    retryBatchMonitor: () => {
      const batch = get().activeBatch;
      if (!batch) return;
      // 只重启「状态查询」，不重发批次：后端批次记录仍是唯一事实来源。
      startBatchMonitor(batch.id);
    },

    undo: async (batchId) => {
      const result = await client.undoBatch(batchId);
      await refreshBatch(batchId);
      await get().refresh();
      return { moved: result.moved, ok: result.ok, message: result.message };
    },

    setContext: (context) => set({ context }),

    /** 批次事件只用于同步 activeBatch；是否终态仍以 `transfer_batch` 返回为准。 */
    handleBatchEvent: (payload) => {
      const value = payload as Partial<TransferBatch> | null;
      if (!value || typeof value.id !== "string") return;
      const current = get().activeBatch;
      if (!current || current.id !== value.id) {
        void get().refresh();
        return;
      }
      set({ activeBatch: { ...current, ...value } as TransferBatch });
      if (value.status && TERMINAL.includes(value.status)) {
        void refreshBatch(value.id);
      }
    },

    dismissBatch: () => {
      stopMonitor();
      set({
        activeBatch: null,
        pending: null,
        lastMessage: null,
        monitorState: "idle",
        monitorError: null,
        monitorAttempts: 0,
      });
    },
  };
});

// 面板状态跨窗口同步：另一个窗口改了宽度/可见性，本窗口跟随。
subscribePanelState((next) => {
  useTransferStore.setState({ panel: next });
});

subscribePanelMode((next) => {
  useTransferStore.setState({ panelMode: next });
});

/** 仅供测试重置。 */
export function resetTransferPanelForTests(): void {
  stopMonitor();
  useTransferStore.setState({
    panel: DEFAULT_PANEL_STATE,
    panelMode: "drawer",
    items: [],
    selection: [],
    activeBatch: null,
    pending: null,
    lastRemoved: null,
    loaded: false,
    monitorState: "idle",
    monitorError: null,
    monitorAttempts: 0,
  });
}
