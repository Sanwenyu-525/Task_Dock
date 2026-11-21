//! 安全保险箱 UI 状态。
//!
//! **不持有 DEK、主密码、恢复密钥或未揭示字段值**；锁定事件到达时清空
//! 列表、详情、搜索结果与剪贴板令牌，避免 React 树里残留明文。

import { create } from "zustand";
import {
  onVaultLocked,
  onVaultStatus,
  vaultApi,
  type VaultAuditEvent,
  type VaultCategory,
  type VaultLockSettings,
  type VaultRecordDetail,
  type VaultRecordDraft,
  type VaultRecordListItem,
  type VaultRecordPatch,
  type VaultStatus,
} from "../lib/vault";

export type VaultFilter =
  | { kind: "all" }
  | { kind: "type"; value: string }
  | { kind: "category"; value: string }
  | { kind: "tag"; value: string }
  | { kind: "favorite" };

interface VaultStoreState {
  status: VaultStatus | null;
  items: VaultRecordListItem[];
  categories: VaultCategory[];
  tags: VaultCategory[];
  detail: VaultRecordDetail | null;
  settings: VaultLockSettings | null;
  audit: VaultAuditEvent[];
  filter: VaultFilter;
  query: string;
  loading: boolean;
  error: string | null;
  lastCopied: { token: string; fieldId: string; clearedAfterSecs: number } | null;
  /**
   * 会话世代：`resetAfterLock` 递增。
   *
   * 用途是让「锁定之后才返回的异步响应」可以被丢弃。只靠 `resetAfterLock()` 清空
   * 状态不够——在飞的 `getRecord`/`copySecret` 回来时会把明文/令牌重新写回来
   * （`T-LOCK-07` 的前端面）。
   */
  epoch: number;

  refreshStatus: () => Promise<void>;
  refreshList: () => Promise<void>;
  refreshTaxonomy: () => Promise<void>;
  refreshAll: () => Promise<void>;
  setFilter: (filter: VaultFilter) => Promise<void>;
  setQuery: (query: string) => Promise<void>;
  selectRecord: (id: string, reveal?: string[]) => Promise<void>;
  clearDetail: () => void;
  createRecord: (draft: VaultRecordDraft) => Promise<void>;
  updateRecord: (id: string, rev: number, patch: VaultRecordPatch) => Promise<void>;
  deleteRecord: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  toggleFieldReveal: (fieldId: string) => Promise<void>;
  copyField: (recordId: string, fieldId: string, clearAfterSecs?: number) => Promise<void>;
  clearClipboard: () => Promise<void>;
  saveSettings: (next: VaultLockSettings) => Promise<void>;
  refreshAudit: () => Promise<void>;
  lock: () => Promise<void>;
  resetAfterLock: () => void;
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** 搜索防抖：避免逐键触发 IPC；锁定后由 resetAfterLock 清空计时器。 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 锁定/状态事件的模块级订阅。
 *
 * 为什么不能只放在 `VaultPanel` 里：面板卸载后订阅即被解除，而 store 里可能还留着
 * 明文详情；此时锁定不会再触发清理，直到下次打开面板才发现。订阅挂在 store 模块上，
 * 生命周期与窗口一致；幂等，重复调用不会建立第二份监听。
 */
let vaultWatch: { dispose: () => void } | null = null;

function ensureVaultWatch(): void {
  if (vaultWatch) return;
  const offs: Array<() => void> = [];
  const handle = { dispose: () => offs.splice(0).forEach((off) => off()) };
  vaultWatch = handle;
  void onVaultLocked(() => {
    // 先递增世代并清空，再刷新状态：任何在飞请求回来都会因世代不符被丢弃。
    useVaultStore.getState().resetAfterLock();
    void useVaultStore.getState().refreshStatus();
  })
    .then((off) => {
      if (vaultWatch === handle) offs.push(off);
      else off();
    })
    .catch(() => {
      // 无 Tauri 运行时（单测）或注册失败：不影响手动锁定路径。
    });
  void onVaultStatus(() => {
    void useVaultStore.getState().refreshStatus();
  })
    .then((off) => {
      if (vaultWatch === handle) offs.push(off);
      else off();
    })
    .catch(() => {});
}

/** 仅供测试：解除模块级订阅并复位。 */
export function resetVaultWatchForTests(): void {
  vaultWatch?.dispose();
  vaultWatch = null;
}

export const useVaultStore = create<VaultStoreState>((set, get) => ({
  status: null,
  items: [],
  categories: [],
  tags: [],
  detail: null,
  settings: null,
  audit: [],
  filter: { kind: "all" },
  query: "",
  loading: false,
  error: null,
  lastCopied: null,
  epoch: 0,

  refreshStatus: async () => {
    ensureVaultWatch();
    try {
      const status = await vaultApi.status();
      set({ status, error: null });
      if (!status.unlocked && status.state !== "recovery") get().resetAfterLock();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  refreshList: async () => {
    const { filter, query } = get();
    const epoch = get().epoch;
    set({ loading: true, error: null });
    try {
      const params: Parameters<typeof vaultApi.listRecords>[0] = {
        query: query.trim() || undefined,
        limit: 200,
      };
      if (filter.kind === "type") params.recordType = filter.value;
      if (filter.kind === "category") params.categoryId = filter.value;
      if (filter.kind === "tag") params.tagId = filter.value;
      if (filter.kind === "favorite") params.favoriteOnly = true;
      const items = await vaultApi.listRecords(params);
      // 锁定/重置之后到达的列表：丢弃，不写回状态。
      if (get().epoch !== epoch) return;
      set({ items, loading: false });
    } catch (error) {
      if (get().epoch !== epoch) return;
      set({ loading: false, error: messageOf(error) });
    }
  },

  refreshTaxonomy: async () => {
    try {
      const [categories, tags] = await Promise.all([vaultApi.categories(), vaultApi.tags()]);
      set({ categories, tags });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  refreshAll: async () => {
    await get().refreshStatus();
    const current = get().status;
    if (!current?.unlocked && current?.state !== "recovery") return;
    await Promise.all([get().refreshTaxonomy(), get().refreshList()]);
    try {
      const settings = await vaultApi.getSettings();
      set({ settings });
    } catch {
      // 设置读取失败不阻塞列表；保持默认展示。
    }
  },

  setFilter: async (filter) => {
    set({ filter });
    await get().refreshList();
  },

  setQuery: async (query) => {
    set({ query });
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void get().refreshList();
    }, 250);
  },

  selectRecord: async (id, reveal = []) => {
    const epoch = get().epoch;
    try {
      const detail = await vaultApi.getRecord(id, reveal);
      // 请求期间发生了锁定：详情可能含明文，必须丢弃（后端也会复核世代，
      // 但前端这道判断覆盖「后端已返回、锁定事件后到」的顺序）。
      if (get().epoch !== epoch) return;
      set({ detail, error: null });
      await get().refreshList();
    } catch (error) {
      if (get().epoch !== epoch) return;
      set({ error: messageOf(error) });
    }
  },

  clearDetail: () => set({ detail: null }),

  createRecord: async (draft) => {
    set({ error: null });
    try {
      await vaultApi.createRecord(draft);
      await Promise.all([get().refreshList(), get().refreshTaxonomy()]);
    } catch (error) {
      set({ error: messageOf(error) });
      throw error;
    }
  },

  updateRecord: async (id, rev, patch) => {
    set({ error: null });
    try {
      await vaultApi.updateRecord(id, rev, patch);
      await get().refreshList();
      if (get().detail?.id === id) await get().selectRecord(id, []);
    } catch (error) {
      set({ error: messageOf(error) });
      throw error;
    }
  },

  deleteRecord: async (id) => {
    try {
      await vaultApi.deleteRecord(id);
      if (get().detail?.id === id) set({ detail: null });
      await get().refreshList();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  toggleFavorite: async (id) => {
    try {
      await vaultApi.toggleFavorite(id);
      await get().refreshList();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  toggleFieldReveal: async (fieldId) => {
    const detail = get().detail;
    if (!detail) return;
    const revealed = detail.fields.filter((f) => f.revealed).map((f) => f.id);
    const next = revealed.includes(fieldId)
      ? revealed.filter((id) => id !== fieldId)
      : [...revealed, fieldId];
    await get().selectRecord(detail.id, next);
  },

  copyField: async (recordId, fieldId, clearAfterSecs) => {
    const epoch = get().epoch;
    try {
      const receipt = await vaultApi.copySecret(recordId, fieldId, clearAfterSecs);
      if (get().epoch !== epoch) {
        // 复制成功但随后被锁定：后端锁定流程会按指纹清除；这里再补一次即时清理，
        // 并**不**把「已复制」令牌写回已锁定的界面。
        void vaultApi.clearClipboardNow().catch(() => {});
        return;
      }
      set({ lastCopied: { ...receipt, fieldId }, error: null });
    } catch (error) {
      if (get().epoch !== epoch) return;
      set({ error: messageOf(error) });
      throw error;
    }
  },

  clearClipboard: async () => {
    try {
      await vaultApi.clearClipboardNow();
      set({ lastCopied: null });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  saveSettings: async (settings) => {
    try {
      await vaultApi.setSettings(settings);
      set({ settings });
    } catch (error) {
      set({ error: messageOf(error) });
      throw error;
    }
  },

  refreshAudit: async () => {
    try {
      set({ audit: await vaultApi.audit() });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  lock: async () => {
    try {
      await vaultApi.lock("manual");
    } finally {
      get().resetAfterLock();
      await get().refreshStatus();
    }
  },

  resetAfterLock: () => {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    set((state) => ({
      items: [],
      detail: null,
      categories: [],
      tags: [],
      settings: null,
      audit: [],
      query: "",
      filter: { kind: "all" },
      lastCopied: null,
      // 在飞请求会被世代判断丢弃，`loading` 必须同时复位：否则锁定界面会一直转圈。
      loading: false,
      // 世代递增必须先于任何后续写入：在飞请求回来时用新世代判断即可丢弃。
      epoch: state.epoch + 1,
    }));
  },
}));
