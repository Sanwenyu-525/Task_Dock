//! 文件暂存架 store：列表分页、筛选、多选、分组、统计与增删改动作。
//!
//! 模式对齐 useClipboardStore：请求代际防乱序、错误字符串化、store 承担
//! IPC 生命周期（本模块无外部事件源，只有主动刷新）。

import { create } from "zustand";
import {
  shelfAddFromClipboard,
  shelfAddLink,
  shelfAddPaths,
  shelfAddText,
  shelfCheckExists,
  shelfCleanup,
  shelfClear,
  shelfCopyTo,
  shelfDelete,
  shelfMoveItems,
  shelfRelocateItem,
  shelfGroupCreate,
  shelfGroupDelete,
  shelfGroups,
  shelfGroupRename,
  shelfList,
  shelfStats,
  shelfUnlinkTask,
  shelfUpdate,
  type ShelfCleanupReport,
  type ShelfConflictStrategy,
  type ShelfDeleteReport,
  type ShelfFailedEntry,
  type ShelfGroup,
  type ShelfItem,
  type ShelfKind,
  type ShelfAddReport,
  type ShelfOpReport,
  type ShelfStats,
  type ShelfUpdatePatch,
} from "../lib/bridge";
import { logEvent, startOperation, type DiagLevel } from "../lib/diagnostics";

/** 分页大小：与剪贴板面板一致的后端分页节奏。 */
export const SHELF_PAGE_SIZE = 100;

/** 工具面板「最近暂存」条数：只取一页的极小片段，不加载完整历史。 */
export const SHELF_RECENT_LIMIT = 4;

/** 最近暂存的软缓存：重新展开胶囊时 5s 内复用，避免子页来回切换重复 IPC。 */
export const SHELF_RECENT_TTL_MS = 5_000;

export interface ShelfFilter {
  search: string;
  kind: ShelfKind | "all";
  group_id: string; // "all" | 分组 id | "none"
  favorite_only: boolean;
}

interface ShelfState {
  items: ShelfItem[];
  total: number;
  groups: ShelfGroup[];
  stats: ShelfStats | null;
  filter: ShelfFilter;
  loading: boolean;
  error: string | null;
  /** 删除/清空/清理后的权威刷新失败时，保留旧列表并提示可重试。 */
  mutationSyncError: string | null;
  deletionBusy: boolean;
  /** 手动过期清理在途闸：预览/执行都不得并发发起。 */
  cleanupBusy: boolean;
  /** 工具面板「最近暂存」轻量切片（独立于完整列表，避免胶囊加载整页历史） */
  recent: ShelfItem[];
  recentLoading: boolean;
  recentLoaded: boolean;
  recentError: string | null;
  /** 多选（顺序无关；后端批量接口按 id 集合处理） */
  selectedIds: string[];
  detailId: string | null;
  /** 清理预览弹层使用 */
  lastCleanup: ShelfCleanupReport | null;

  load: (opts?: { silent?: boolean; preserveLoaded?: boolean }) => Promise<boolean>;
  /** 最近暂存：limit 固定为 SHELF_RECENT_LIMIT；force 跳过 5s 软缓存 */
  loadRecent: (opts?: { force?: boolean }) => Promise<boolean>;
  loadMore: () => Promise<void>;
  setFilter: (patch: Partial<ShelfFilter>) => Promise<void>;
  refreshMeta: () => Promise<boolean>;
  retryShelfSync: () => Promise<boolean>;
  addPaths: (
    paths: string[],
    mode: "reference" | "managed",
    source: "picker" | "drag" | "manual",
    groupId?: string | null,
  ) => Promise<{ added: number; failed: ShelfFailedEntry[] }>;
  addLink: (url: string, groupId?: string | null) => Promise<ShelfItem>;
  addText: (text: string, groupId?: string | null) => Promise<ShelfItem>;
  addFromClipboard: (
    itemIds: string[],
    mode: "reference" | "managed",
    groupId?: string | null,
  ) => Promise<{ added: number; failed: ShelfFailedEntry[] }>;
  updateItem: (id: string, patch: ShelfUpdatePatch) => Promise<ShelfItem>;
  deleteItems: (ids: string[], includeProtected: boolean) => Promise<ShelfMutationResult>;
  clearShelf: (includeProtected: boolean) => Promise<ShelfMutationResult>;
  runCleanup: (dryRun: boolean, includeProtected: boolean) => Promise<ShelfCleanupResult>;
  verifyExists: (ids: string[]) => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  renameGroup: (id: string, name: string) => Promise<void>;
  removeGroup: (id: string) => Promise<void>;
  moveToGroup: (ids: string[], groupId: string) => Promise<void>;
  /** 文件操作：move=移动原文件，copy=复制到目录/导出托管副本。 */
  runFileOp: (
    op: "move" | "copy",
    ids: string[],
    targetDir: string,
    strategy: ShelfConflictStrategy,
    removeAfter: boolean,
  ) => Promise<ShelfOpReport>;
  relocateItem: (id: string, path: string) => Promise<ShelfItem>;
  unlinkTask: (itemId: string, taskId: string) => Promise<void>;
  toggleSelect: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setDetail: (id: string | null) => void;
}

export interface ShelfMutationResult {
  report: ShelfDeleteReport;
  synced: boolean;
  remainingTotal: number | null;
}

/**
 * 清理结果：report 是后端唯一事实源，synced 表示执行后的权威刷新是否成功。
 * dry_run 预览不写数据，synced 恒为 true。
 */
export interface ShelfCleanupResult {
  report: ShelfCleanupReport;
  synced: boolean;
}

/** 模块级请求代际：筛选切换后，旧响应不得覆盖新状态。 */
let reqSeq = 0;
/** 最近暂存独立代际：完整列表的刷新不能改写胶囊里的轻量切片。 */
let recentSeq = 0;
let recentLoadedAt = 0;
/** 数据代次：新增/删除/改名后递增，早于变更的最近响应一律丢弃。 */
let recentVersion = 0;

/** 暂存数据发生变化：下次打开胶囊必须重新取最近列表，旧响应不得覆盖。 */
function invalidateRecent(): void {
  recentVersion += 1;
  recentLoadedAt = 0;
}

/** 测试辅助：清掉最近切片的模块级软缓存，避免用例之间共享 TTL。 */
export function __resetShelfRecentCache(): void {
  recentSeq += 1;
  recentVersion += 1;
  recentLoadedAt = 0;
}

function sortItems(items: ShelfItem[]): ShelfItem[] {
  // 与后端排序保持一致（置顶优先、新者先），本地插入/更新后直接重排
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}

// ── 添加结果分级（诊断中心可稳定筛选） ──────────────────────
//
// 一次投递可能同时有成功与失败条目。旧实现无论 `failed` 多少都写 `success`，
// 诊断中心只能看到「添加成功」，真实失败仅存在于界面 Toast。这里按返回的 report
// 做一次**有界汇总**：
// - 全成功 → INFO/success（保持既有行为）；
// - 部分/全部失败 → failed 终态 + 稳定合成码，级别由失败分类决定；
// - 0 添加 0 失败 → WARN/failed（后端没有可落库内容）；
// metadata 只放计数、模式、来源与稳定错误码，绝不写路径/文件名。

const SHELF_ADD_PARTIAL_FAILED = "SHELF_ADD_PARTIAL_FAILED";
const SHELF_ADD_FAILED = "SHELF_ADD_FAILED";
const SHELF_ADD_NO_INPUT = "SHELF_ADD_NO_INPUT";
const SHELF_ADD_REFRESH_FAILED = "SHELF_ADD_REFRESH_FAILED";
const SHELF_FAILURE_CODES_MAX = 3;
const SHELF_FAILURE_CODE_MAX_CHARS = 40;

/** 明确属于「用户输入/目标状态」的预期拒绝：全量失败时只需 WARN。 */
const EXPECTED_FAILURE_CATEGORIES = new Set([
  "validation",
  "not_found",
  "unsupported",
  "conflict",
]);

/** 失败条目的稳定分类；兼容只有 path/reason 的旧后端（按错误码回退）。 */
function failureCategoryOf(entry: ShelfFailedEntry): string {
  const category = typeof entry.category === "string" ? entry.category.trim() : "";
  if (category) return category;
  switch ((entry.code ?? "").trim()) {
    case "DATA_INTEGRITY_ERROR":
      return "integrity";
    case "DATABASE_ERROR":
    case "DATABASE_BUSY":
      return "database";
    case "IO_ERROR":
      return "io";
    case "PERMISSION_DENIED":
    case "PERMISSION_REQUIRED":
      return "permission";
    case "SERVICE_UNAVAILABLE":
    case "SERVICE_OVERLOADED":
      return "service";
    case "TIMEOUT":
      return "timeout";
    case "VALIDATION_ERROR":
      return "validation";
    case "NOT_FOUND":
      return "not_found";
    case "UNSUPPORTED":
      return "unsupported";
    case "CONFLICT":
      return "conflict";
    default:
      return "unknown";
  }
}

const FAILURE_CATEGORY_RANK: Record<string, number> = {
  integrity: 5,
  database: 4,
  io: 3,
  permission: 3,
  service: 3,
  timeout: 3,
  unknown: 3,
  agent: 3,
  config: 3,
  ipc: 3,
  validation: 1,
  not_found: 1,
  unsupported: 1,
  conflict: 1,
};

/**
 * 汇总失败级别与代表分类：
 * - 任一 integrity → CRITICAL；
 * - 全部是预期拒绝（validation/not_found/unsupported/conflict）→ WARN；
 * - 其余（io/permission/service/timeout/database/unknown…）→ ERROR。
 */
function summarizeShelfFailures(failed: ShelfFailedEntry[]): {
  level: DiagLevel;
  category: string;
} {
  const categories = failed.map(failureCategoryOf);
  if (categories.some((category) => category === "integrity")) {
    return { level: "CRITICAL", category: "integrity" };
  }
  const onlyExpected = categories.every((category) => EXPECTED_FAILURE_CATEGORIES.has(category));
  let category = categories[0] ?? "unknown";
  for (const candidate of categories) {
    if ((FAILURE_CATEGORY_RANK[candidate] ?? 3) > (FAILURE_CATEGORY_RANK[category] ?? 3)) {
      category = candidate;
    }
  }
  return { level: onlyExpected ? "WARN" : "ERROR", category };
}

/** 去重、限 3 个、单个 ≤40 字符的失败码串（诊断中心可直接看分类）。 */
function shelfFailureCodes(failed: ShelfFailedEntry[]): string | undefined {
  const codes: string[] = [];
  for (const entry of failed) {
    const code = typeof entry.code === "string" ? entry.code.trim() : "";
    if (!code) continue;
    const bounded = code.slice(0, SHELF_FAILURE_CODE_MAX_CHARS);
    if (!codes.includes(bounded)) codes.push(bounded);
    if (codes.length >= SHELF_FAILURE_CODES_MAX) break;
  }
  return codes.length > 0 ? codes.join(",") : undefined;
}

/** 全部失败且所有条目错误码一致时才复用真实后端码；否则用合成码。 */
function uniformShelfFailureCode(failed: ShelfFailedEntry[]): string | undefined {
  const codes = failed.map((entry) =>
    typeof entry.code === "string" ? entry.code.trim() : "",
  );
  if (codes.length === 0 || codes.some((code) => !code)) return undefined;
  const first = codes[0];
  return codes.every((code) => code === first) ? first : undefined;
}

function shelfAddMetadata(
  paths: number,
  added: number,
  failed: number,
  mode: "reference" | "managed",
  source: "picker" | "drag" | "manual",
  failureCodes?: string,
): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {
    count: paths,
    total: paths,
    added,
    failed,
    mode,
    source,
  };
  if (failureCodes) metadata.failure_codes = failureCodes;
  return metadata;
}

export const useShelfStore = create<ShelfState>((set, get) => ({
  items: [],
  total: 0,
  groups: [],
  stats: null,
  filter: { search: "", kind: "all", group_id: "all", favorite_only: false },
  loading: false,
  error: null,
  mutationSyncError: null,
  deletionBusy: false,
  cleanupBusy: false,
  recent: [],
  recentLoading: false,
  recentLoaded: false,
  recentError: null,
  selectedIds: [],
  detailId: null,
  lastCleanup: null,

  load: async (opts) => {
    const seq = ++reqSeq;
    const current = get();
    const filter = current.filter;
    const loadedTarget = opts?.preserveLoaded
      ? Math.max(SHELF_PAGE_SIZE, current.items.length)
      : SHELF_PAGE_SIZE;
    if (!opts?.silent) set({ loading: true });
    try {
      const items: ShelfItem[] = [];
      let total = 0;
      do {
        const page = await shelfList({
          search: filter.search || undefined,
          kind: filter.kind,
          group_id: filter.group_id,
          favorite_only: filter.favorite_only,
          limit: SHELF_PAGE_SIZE,
          offset: items.length,
        });
        if (seq !== reqSeq) return false;
        items.push(...page.items);
        total = page.total;
        if (
          !opts?.preserveLoaded ||
          items.length >= loadedTarget ||
          items.length >= total ||
          page.items.length === 0
        ) {
          break;
        }
      } while (true);
      // 服务端权威收敛：刷新后不再存在于列表中的选中项同步移除
      const ids = new Set(items.map((i) => i.id));
      if (seq !== reqSeq) return false;
      set((s) => ({
        items,
        total,
        error: null,
        selectedIds: s.selectedIds.filter((id) => ids.has(id)),
        detailId: s.detailId && ids.has(s.detailId) ? s.detailId : null,
      }));
      return true;
    } catch (e) {
      if (seq !== reqSeq) return false;
      set({ error: String(e) });
      return false;
    } finally {
      if (seq === reqSeq) set({ loading: false });
    }
  },

  loadRecent: async (opts) => {
    const force = opts?.force ?? false;
    const s = get();
    // 软缓存 + 在途去重：胶囊子页来回切换 / 重复挂载不产生请求风暴。
    if (!force && s.recentLoaded && Date.now() - recentLoadedAt < SHELF_RECENT_TTL_MS) return true;
    if (!force && s.recentLoading) return false;

    const seq = ++recentSeq;
    const version = recentVersion;
    set({ recentLoading: true, recentError: null });
    try {
      // 只要最近 4 条：按创建时间倒序（不受置顶影响），不读完整历史，
      // 也不动完整列表的筛选/分页状态。
      const page = await shelfList({ sort: "recent", limit: SHELF_RECENT_LIMIT, offset: 0 });
      if (seq !== recentSeq || version !== recentVersion) return false;
      set({ recent: page.items, recentLoaded: true });
      recentLoadedAt = Date.now();

      // 引用/托管文件是否仍可访问：一次批量元数据检查。检查失败时保留库内
      // 上次状态（unknown 不等于 missing），不让辅助探测把列表变成错误态。
      const ids = page.items
        .filter((i) => i.kind !== "link" && i.kind !== "text")
        .map((i) => i.id);
      if (ids.length > 0) {
        try {
          const reports = await shelfCheckExists(ids);
          if (seq !== recentSeq || version !== recentVersion) return false;
          const map = new Map(reports.map((r) => [r.id, r.exists_state]));
          set((prev) => ({
            recent: prev.recent.map((i) =>
              map.has(i.id) ? { ...i, exists_state: map.get(i.id) as ShelfItem["exists_state"] } : i,
            ),
          }));
        } catch {
          // 存在性探测是展示增强：失败不覆盖列表、不阻塞打开/复制。
        }
      }
      return true;
    } catch (e) {
      if (seq === recentSeq && version === recentVersion) set({ recentError: String(e) });
      return false;
    } finally {
      if (seq === recentSeq) set({ recentLoading: false });
    }
  },

  loadMore: async () => {
    const seq = ++reqSeq;
    const s = get();
    if (s.items.length >= s.total) return;
    try {
      const page = await shelfList({
        search: s.filter.search || undefined,
        kind: s.filter.kind,
        group_id: s.filter.group_id,
        favorite_only: s.filter.favorite_only,
        limit: SHELF_PAGE_SIZE,
        offset: s.items.length,
      });
      if (seq !== reqSeq) return;
      set((prev) => {
        const known = new Set(prev.items.map((i) => i.id));
        const merged = sortItems([...prev.items, ...page.items.filter((i) => !known.has(i.id))]);
        return { items: merged, total: page.total };
      });
    } catch (e) {
      if (seq === reqSeq) set({ error: String(e) });
    }
  },

  setFilter: async (patch) => {
    set((s) => ({ filter: { ...s.filter, ...patch } }));
    await get().load();
  },

  refreshMeta: async () => {
    try {
      const [groups, stats] = await Promise.all([shelfGroups(), shelfStats()]);
      set({ groups, stats });
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  retryShelfSync: async () => {
    set({ mutationSyncError: null });
    const [listOk, metaOk, recentOk] = await Promise.all([
      get().load({ silent: true, preserveLoaded: true }),
      get().refreshMeta(),
      get().loadRecent({ force: true }),
    ]);
    const synced = listOk && metaOk && recentOk;
    set({
      mutationSyncError: synced ? null : "暂存架状态刷新失败，当前内容可能未同步。请重试。",
    });
    return synced;
  },

  addPaths: async (paths, mode, source, groupId) => {
    // 一次投递 = 一个 operation_id；只记录数量/来源/存储模式，绝不记录文件路径。
    const op = startOperation("file", "shelf_add_paths");
    let report: ShelfAddReport;
    try {
      op.stage("validate");
      op.stage("persist");
      report = await shelfAddPaths(paths, mode, source, groupId ?? null);
    } catch (e) {
      // 参数/IPC 失败仍抛给 UI（保持既有行为）；业务失败在下面按 report 记录。
      op.fail(e);
      throw e;
    }

    const added = report.added.length;
    const failed = report.failed.length;
    const failureCodes = shelfFailureCodes(report.failed);

    if (added > 0) {
      // 真实存在的收尾步骤：本地合并 + 元数据/列表刷新。
      op.stage("finalize");
      set((s) => ({
        items: sortItems([...report.added, ...s.items]),
        recent: [...report.added, ...s.recent].slice(0, SHELF_RECENT_LIMIT),
      }));
      invalidateRecent();
      // 收尾刷新失败不得改写添加结论：load/refreshMeta 内部已捕获错误并返回
      // false，这里再兜一层异常，只写 WARN，仍返回 report。
      let synced = false;
      try {
        const meta = get().refreshMeta();
        const listOk = await get().load({ silent: true });
        const metaOk = await meta;
        synced = listOk && metaOk;
      } catch {
        synced = false;
      }
      if (!synced) {
        // 这是同一次操作里的**次级**故障，不是添加终态：不写 status，
        // 避免同一 operation_id 同时出现 failed 与 success 两个终态。
        logEvent({
          level: "WARN",
          module: "file",
          action: "shelf_add_paths",
          event: "refresh_failed",
          stage: "finalize",
          operation_id: op.id,
          error_code: SHELF_ADD_REFRESH_FAILED,
          error_category: "unknown",
          message: "暂存内容已添加，但列表刷新失败，界面可能不是最新状态",
          metadata: shelfAddMetadata(paths.length, added, failed, mode, source),
        });
      }
    }

    if (failed === 0 && added > 0) {
      op.success({
        metadata: shelfAddMetadata(paths.length, added, failed, mode, source),
      });
    } else if (failed > 0 && added > 0) {
      const { level, category } = summarizeShelfFailures(report.failed);
      op.fail(
        { code: SHELF_ADD_PARTIAL_FAILED, category },
        {
          severity: level,
          // 失败本身发生在 persist；finalize 只是收尾刷新，不作为失败阶段。
          stage: "persist",
          message: `暂存添加部分失败：共 ${paths.length} 项，成功 ${added}、失败 ${failed}`,
          metadata: shelfAddMetadata(paths.length, added, failed, mode, source, failureCodes),
        },
      );
    } else if (failed > 0) {
      const { level, category } = summarizeShelfFailures(report.failed);
      const code = uniformShelfFailureCode(report.failed) ?? SHELF_ADD_FAILED;
      op.fail(
        { code, category },
        {
          severity: level,
          stage: "persist",
          message: `暂存添加失败：共 ${paths.length} 项，成功 0、失败 ${failed}`,
          metadata: shelfAddMetadata(paths.length, added, failed, mode, source, failureCodes),
        },
      );
    } else {
      // paths 非空但后端既没添加也没失败：不能伪装成成功。
      op.fail(
        { code: SHELF_ADD_NO_INPUT, category: "validation" },
        {
          severity: "WARN",
          stage: "persist",
          message: "暂存添加未产生任何条目",
          metadata: shelfAddMetadata(paths.length, added, failed, mode, source),
        },
      );
    }

    // 业务失败不抛给 UI：调用方按返回的 added/failed 展示逐条结果。
    return { added, failed: report.failed };
  },

  addLink: async (url, groupId) => {
    const item = await shelfAddLink(url, groupId ?? null);
    set((s) => ({
      items: sortItems([item, ...s.items]),
      recent: [item, ...s.recent].slice(0, SHELF_RECENT_LIMIT),
    }));
    invalidateRecent();
    void get().refreshMeta();
    return item;
  },

  addText: async (text, groupId) => {
    const item = await shelfAddText(text, groupId ?? null);
    set((s) => ({
      items: sortItems([item, ...s.items]),
      recent: [item, ...s.recent].slice(0, SHELF_RECENT_LIMIT),
    }));
    invalidateRecent();
    void get().refreshMeta();
    return item;
  },

  addFromClipboard: async (itemIds, mode, groupId) => {
    const report = await shelfAddFromClipboard(itemIds, mode, groupId ?? null);
    if (report.added.length > 0) {
      set((s) => ({
        items: sortItems([...report.added, ...s.items]),
        recent: [...report.added, ...s.recent].slice(0, SHELF_RECENT_LIMIT),
      }));
      invalidateRecent();
      void get().refreshMeta();
      await get().load({ silent: true });
    }
    return { added: report.added.length, failed: report.failed };
  },

  updateItem: async (id, patch) => {
    const item = await shelfUpdate(id, patch);
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? item : i)),
      recent: s.recent.map((i) => (i.id === id ? item : i)),
    }));
    invalidateRecent();
    void get().refreshMeta();
    return item;
  },

  deleteItems: async (ids, includeProtected) => {
    if (get().deletionBusy) throw new Error("暂存架正在处理删除操作");
    if (get().cleanupBusy) throw new Error("暂存架正在清理，请稍候");
    set({ deletionBusy: true });
    try {
      const report = await shelfDelete(ids, includeProtected);
      invalidateRecent();
      const synced = await get().retryShelfSync();
      return {
        report,
        synced,
        remainingTotal: synced ? (get().stats?.total ?? null) : null,
      };
    } finally {
      set({ deletionBusy: false });
    }
  },

  clearShelf: async (includeProtected) => {
    if (get().deletionBusy) throw new Error("暂存架正在处理删除操作");
    if (get().cleanupBusy) throw new Error("暂存架正在清理，请稍候");
    set({ deletionBusy: true });
    try {
      const report = await shelfClear(includeProtected);
      invalidateRecent();
      const synced = await get().retryShelfSync();
      return {
        report,
        synced,
        remainingTotal: synced ? (get().stats?.total ?? null) : null,
      };
    } finally {
      set({ deletionBusy: false });
    }
  },

  runCleanup: async (dryRun, includeProtected) => {
    if (get().cleanupBusy) throw new Error("暂存架正在清理，请稍候");
    if (dryRun) {
      // 预览只读：不改列表、统计与最近缓存，结果交给调用方做二次确认。
      const report = await shelfCleanup(true, includeProtected);
      set({ lastCleanup: report });
      return { report, synced: true };
    }
    set({ cleanupBusy: true });
    try {
      const report = await shelfCleanup(false, includeProtected);
      set({ lastCleanup: report });
      invalidateRecent();
      // 与删除/清空共用同一权威同步路径：列表（保留已加载范围与当前筛选）、
      // 统计、分组与最近暂存一次性收敛；失败只置 mutationSyncError，不重跑清理。
      const synced = await get().retryShelfSync();
      return { report, synced };
    } finally {
      set({ cleanupBusy: false });
    }
  },

  verifyExists: async (ids) => {
    if (ids.length === 0) return;
    const reports = await shelfCheckExists(ids);
    const map = new Map(reports.map((r) => [r.id, r.exists_state]));
    set((s) => ({
      items: s.items.map((i) =>
        map.has(i.id) ? { ...i, exists_state: map.get(i.id) as ShelfItem["exists_state"] } : i,
      ),
    }));
  },

  createGroup: async (name) => {
    await shelfGroupCreate(name);
    await get().refreshMeta();
  },

  renameGroup: async (id, name) => {
    await shelfGroupRename(id, name);
    await get().refreshMeta();
  },

  removeGroup: async (id) => {
    await shelfGroupDelete(id);
    // 分组删除后条目归位默认分组；筛选停在被删分组时回退到全部
    const f = get().filter;
    if (f.group_id === id) {
      await get().setFilter({ group_id: "all" });
    }
    await get().refreshMeta();
    await get().load({ silent: true });
  },

  moveToGroup: async (ids, groupId) => {
    for (const id of ids) {
      await shelfUpdate(id, { group_id: groupId });
    }
    set((s) => ({
      items: s.items.map((i) =>
        ids.includes(i.id)
          ? { ...i, group_id: groupId === "none" ? null : groupId }
          : i,
      ),
      selectedIds: [],
    }));
    void get().refreshMeta();
  },

  runFileOp: async (op, ids, targetDir, strategy, removeAfter) => {
    const report =
      op === "move"
        ? await shelfMoveItems(ids, targetDir, strategy, removeAfter)
        : await shelfCopyTo(ids, targetDir, strategy, removeAfter);
    // 移动会改写路径、移除会删记录，统一以服务端列表为准刷新（保留失败项）。
    invalidateRecent();
    await get().load({ silent: true });
    void get().refreshMeta();
    return report;
  },

  relocateItem: async (id, path) => {
    const item = await shelfRelocateItem(id, path);
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? item : i)),
      recent: s.recent.map((i) => (i.id === id ? item : i)),
    }));
    invalidateRecent();
    return item;
  },

  unlinkTask: async (itemId, taskId) => {
    await shelfUnlinkTask(itemId, taskId);
  },

  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),

  selectAll: () => set((s) => ({ selectedIds: s.items.map((i) => i.id) })),

  clearSelection: () => set({ selectedIds: [] }),

  setDetail: (id) => set({ detailId: id }),
}));
