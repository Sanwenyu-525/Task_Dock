//! 安全保险箱 UI 状态。
//!
//! **不持有 DEK、主密码、恢复密钥或未揭示字段值**；锁定事件到达时清空
//! 列表、详情、搜索结果与剪贴板令牌，避免 React 树里残留明文。

import { create } from "zustand";
import {
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

  refreshStatus: async () => {
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
      set({ items, loading: false });
    } catch (error) {
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
    try {
      const detail = await vaultApi.getRecord(id, reveal);
      set({ detail, error: null });
      await get().refreshList();
    } catch (error) {
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
    try {
      const receipt = await vaultApi.copySecret(recordId, fieldId, clearAfterSecs);
      set({ lastCopied: { ...receipt, fieldId }, error: null });
    } catch (error) {
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
    set({
      items: [],
      detail: null,
      categories: [],
      tags: [],
      settings: null,
      audit: [],
      query: "",
      filter: { kind: "all" },
      lastCopied: null,
    });
  },
}));
