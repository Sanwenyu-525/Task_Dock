//! 剪贴板抽屉视图状态：筛选、分页与多选。
//! 列表项由后端压实（正文→预览），完整内容在详情面板按需读取。
//!
//! 一致性约定：
//! - 每次筛选变化推进 `filterGen`，旧筛选的响应一律丢弃；
//! - 每次请求推进 `reqSeq`，只有最新请求可以写入视图（防异步乱序覆盖）；
//! - 追加分页按 id 去重，并与当前代际绑定，筛选切换后不再拼接旧页；
//! - 任何一次落库后都清理已不存在于列表中的选择；
//! - 离场中的条目（`exiting`）由本 store 钉在原位，任何一次刷新都不能把它提前卸载。

import { create } from "zustand";
import { clipboardView, onClipboardChanged, type ClipboardGroup, type ClipboardItem, type ClipboardView } from "../lib/bridge";
import { EXIT_MS, prefersReducedMotion } from "../lib/motion";
import { createSubscriptionScope } from "../lib/subscriptions";

const PAGE_SIZE = 80;
/** 后端 `clipboard_view` 的 limit 上限；静默刷新按这个块大小补齐已加载条目。 */
const MAX_PAGE_SIZE = 200;

export interface ClipboardFilters {
  kind: string;
  search: string;
  favorite: boolean;
}

/**
 * 离场快照：后端已删除、但退出动画还没播完的行。
 *
 * 删除命令会立刻 `emit_changed`，静默刷新与后台采集随时可能落库；若按服务端结果
 * 直接覆盖视图，被删卡片会在动画中途被卸载，用户就看不出「刚才删的是哪一条」。
 * 因此由 store 把它按原索引钉回列表，动画结束（`endExit`）或筛选代际变化时才放手。
 */
interface ExitEntry {
  kind: "item" | "group";
  row: ClipboardItem | ClipboardGroup;
  /** 删除瞬间在列表中的位置，用于原位补回 */
  index: number;
  /** 绑定的筛选代际：切换筛选后不再钉回（否则会把文本条目钉进图片列表） */
  gen: number;
}

let filterGen = 0;
let reqSeq = 0;
/**
 * 离场收尾定时器（id → timer），归 **store** 所有而非组件。
 *
 * 根因：此前定时器挂在组件实例上，删除动画中途关闭抽屉时定时器被卸载清理，
 * 但 `exiting` 快照留在 store 里无人收尾——重新打开抽屉时 `load()` 会把
 * 服务端已删除的行按快照钉回列表，看起来像「删除的内容复活了」。
 * 现在定时器与离场 ID 一一对应、随快照同生共死，组件卸载不影响收尾；
 * 每个条目只清自己的定时器，互不误伤。
 */
const exitTimers = new Map<string, ReturnType<typeof setTimeout>>();

function mergeItems(current: ClipboardView["items"], next: ClipboardView["items"]) {
  const seen = new Set(current.map((i) => i.id));
  const merged = [...current];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

function queryView(f: ClipboardFilters, limit: number, offset: number) {
  return clipboardView({
    kind: f.kind,
    search: f.search.trim() || undefined,
    favorite: f.favorite,
    limit,
    offset,
  });
}

/** 把仍在离场的行按删除前的位置插回服务端结果；同一代际才钉回。 */
function reattach<T extends { id: string }>(rows: T[], held: ExitEntry[]): T[] {
  if (held.length === 0) return rows;
  const out = [...rows];
  for (const entry of [...held].sort((a, b) => a.index - b.index)) {
    if (out.some((r) => r.id === entry.row.id)) continue;
    out.splice(Math.min(entry.index, out.length), 0, entry.row as unknown as T);
  }
  return out;
}

/**
 * 静默刷新窗口：至少覆盖当前已加载的条目数。
 *
 * 后台采集刷新若只请求第一页，已加载多页的列表会突然缩减，滚动位置与
 * “加载更多”状态一起丢失。这里按后端上限分块补齐，任何一页在途时筛选
 * 或请求代数变化就立即放弃，避免旧响应拼接进新视图。
 */
async function fetchRefreshWindow(
  f: ClipboardFilters,
  target: number,
  seq: number,
  gen: number,
): Promise<ClipboardView | null> {
  let acc: ClipboardView | null = null;
  let offset = 0;
  while (offset < target) {
    if (seq !== reqSeq || gen !== filterGen) return null;
    const limit = Math.min(MAX_PAGE_SIZE, target - offset);
    const page = await queryView(f, limit, offset);
    if (seq !== reqSeq || gen !== filterGen) return null;
    if (acc) {
      acc = {
        items: mergeItems(acc.items, page.items),
        groups: page.groups,
        stats: page.stats,
        total_items: page.total_items,
      };
    } else {
      acc = page;
    }
    if (page.items.length < limit) break;
    offset += page.items.length;
  }
  return acc;
}

export const useClipboardStore = create<{
  view: ClipboardView | null;
  filters: ClipboardFilters;
  /** 历史 / 分组 二级视图 */
  section: "items" | "groups";
  /** 搜索框原始文本（与 filters.search 分离，搜索框内容即时回显） */
  searchText: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  selectedItems: string[];
  selectedGroups: string[];
  /** 正在播放退出动画、必须留在列表里的行（id → 快照） */
  exiting: Record<string, ExitEntry>;
  setFilters: (patch: Partial<ClipboardFilters>) => void;
  setSection: (section: "items" | "groups") => void;
  setSearchText: (text: string) => void;
  load: (opts?: { append?: boolean; silent?: boolean }) => Promise<void>;
  /** 复制成功后只更新该条目的使用次数，不重新拉取整个列表。 */
  bumpItemCopy: (id: string) => void;
  /** 标题编辑后就地替换该条目，不整表刷新。 */
  renameItem: (id: string, title: string, titleSource: string) => void;
  /** 收藏/置顶返回最新实体后就地替换，图标状态不必等整表刷新。 */
  patchItem: (item: ClipboardItem) => void;
  patchGroup: (group: ClipboardGroup) => void;
  /**
   * 标记这些 id 正在离场：快照当前行并按原位钉住，直到 `endExit`。
   * 只应在后端确认删除成功之后调用。
   * 收尾定时器由 store 持有：到点自动 `endExit`，组件卸载（关闭抽屉）也不会
   * 让快照滞留——重开抽屉时不会把已删除的行钉回列表。
   */
  beginExit: (ids: string[], kind: "item" | "group") => void;
  /** 结束离场：放开钉住的行并从本地视图剔除（服务端已经没有它们）。幂等。 */
  endExit: (ids: string[]) => void;
  toggleItemSelection: (id: string) => void;
  toggleGroupSelection: (id: string) => void;
  clearSelection: () => void;
  /** 订阅后端变更；**全局只建一个** Tauri 监听，页面与抽屉共享 */
  setLive: (active: boolean) => void;
}>((set, get) => ({
  view: null,
  filters: { kind: "all", search: "", favorite: false },
  section: "items",
  searchText: "",
  loading: false,
  loadingMore: false,
  error: null,
  selectedItems: [],
  selectedGroups: [],
  exiting: {},

  setFilters: (patch) => {
    filterGen += 1;
    set((s) => ({
      filters: { ...s.filters, ...patch },
      selectedItems: [],
      selectedGroups: [],
    }));
  },

  setSection: (section) => set({ section }),
  setSearchText: (searchText) => set({ searchText }),

  load: async (opts) => {
    const append = opts?.append === true;
    const silent = opts?.silent === true;
    if (append && get().loadingMore) return;
    const gen = filterGen;
    const seq = ++reqSeq;
    const f = get().filters;
    if (append) set({ loadingMore: true });
    else if (!silent) set({ loading: true });
    try {
      let view: ClipboardView;
      if (append) {
        view = await queryView(f, PAGE_SIZE, get().view?.items.length ?? 0);
      } else if (silent) {
        // 后台刷新保持已加载的条目数，不能把多页列表缩回第一页。
        const loaded = get().view?.items.length ?? 0;
        const fetched = await fetchRefreshWindow(f, Math.max(loaded, PAGE_SIZE), seq, gen);
        if (!fetched) return;
        view = fetched;
      } else {
        view = await queryView(f, PAGE_SIZE, 0);
      }
      // 旧筛选或旧请求的响应不得覆盖新状态
      if (seq !== reqSeq || gen !== filterGen) return;
      set((s) => {
        // 始终基于副本更新：桥接返回的 view 由调用方持有，不能被就地改写
        const merged =
          append && s.view
            ? { ...view, items: mergeItems(s.view.items, view.items) }
            : { ...view };
        // 刷新后剔除已被清理/删除的选中项（以服务端结果为准，不含仍在离场的行）
        const ids = new Set(merged.items.map((i) => i.id));
        const gids = new Set(merged.groups.map((g) => g.id));
        // 离场中的行按原位钉回：筛选代际已变的快照直接丢弃
        const exiting: Record<string, ExitEntry> = {};
        const held: ExitEntry[] = [];
        for (const [id, entry] of Object.entries(s.exiting)) {
          if (entry.gen !== gen) continue;
          exiting[id] = entry;
          held.push(entry);
        }
        if (held.length > 0) {
          merged.items = reattach(
            merged.items,
            held.filter((e) => e.kind === "item"),
          );
          merged.groups = reattach(
            merged.groups,
            held.filter((e) => e.kind === "group"),
          );
        }
        return {
          view: merged,
          exiting,
          loading: false,
          loadingMore: false,
          error: null,
          selectedItems: s.selectedItems.filter((id) => ids.has(id)),
          selectedGroups: s.selectedGroups.filter((id) => gids.has(id)),
        };
      });
    } catch (e) {
      if (seq !== reqSeq || gen !== filterGen) return;
      set({ loading: false, loadingMore: false, error: String(e) });
    }
  },

  bumpItemCopy: (id) =>
    set((s) => {
      if (!s.view) return {};
      let changed = false;
      const items = s.view.items.map((item) => {
        if (item.id !== id) return item;
        changed = true;
        return { ...item, copy_count: item.copy_count + 1 };
      });
      return changed ? { view: { ...s.view, items } } : {};
    }),

  renameItem: (id, title, titleSource) =>
    set((s) => {
      if (!s.view) return {};
      let changed = false;
      const items = s.view.items.map((item) => {
        if (item.id !== id) return item;
        changed = true;
        return { ...item, title, title_source: titleSource };
      });
      return changed ? { view: { ...s.view, items } } : {};
    }),

  patchItem: (item) =>
    set((s) => {
      if (!s.view) return {};
      const items = s.view.items.map((x) => (x.id === item.id ? item : x));
      if (!items.some((x) => x.id === item.id)) return {};
      return { view: { ...s.view, items } };
    }),

  patchGroup: (group) =>
    set((s) => {
      if (!s.view) return {};
      const groups = s.view.groups.map((x) => (x.id === group.id ? group : x));
      if (!groups.some((x) => x.id === group.id)) return {};
      return { view: { ...s.view, groups } };
    }),

  beginExit: (ids, kind) =>
    set((s) => {
      if (!s.view || ids.length === 0) return {};
      const rows = kind === "item" ? s.view.items : s.view.groups;
      const exiting = { ...s.exiting };
      const started: string[] = [];
      for (const id of ids) {
        if (exiting[id]) continue;
        const index = rows.findIndex((r) => r.id === id);
        if (index < 0) continue;
        exiting[id] = { kind, row: rows[index], index, gen: filterGen };
        started.push(id);
      }
      // 收尾定时器由 store 持有：即使组件在动画期间卸载（关闭抽屉/切页），
      // 到点也会结束离场并从本地视图剔除，已确认的删除结果不会以快照形式复活。
      // 用全局 setTimeout（而非 window.）：store 也会在 node 环境测试中运行。
      for (const id of started) {
        if (exitTimers.has(id)) continue;
        exitTimers.set(
          id,
          setTimeout(() => {
            exitTimers.delete(id);
            useClipboardStore.getState().endExit([id]);
          }, prefersReducedMotion() ? 0 : EXIT_MS),
        );
      }
      return { exiting };
    }),

  endExit: (ids) =>
    set((s) => {
      // 只结束自己名下的定时器：批量与单个条目的收尾互不干扰
      for (const id of ids) {
        const t = exitTimers.get(id);
        if (t !== undefined) {
          clearTimeout(t);
          exitTimers.delete(id);
        }
      }
      if (ids.length === 0) return {};
      const exiting = { ...s.exiting };
      for (const id of ids) delete exiting[id];
      if (!s.view) return { exiting };
      // 服务端确认已删除：本地视图同步剔除，不再等下一次刷新。
      // 无条件按 id 过滤（不要求 id 曾在 exiting 里）：分组详情删除等路径
      // 直接调 endExit 摘除已确认删除的行；重复调用是空操作，幂等。
      const gone = new Set(ids);
      return {
        exiting,
        view: {
          ...s.view,
          items: s.view.items.filter((i) => !gone.has(i.id)),
          groups: s.view.groups.filter((g) => !gone.has(g.id)),
        },
      };
    }),

  toggleItemSelection: (id) =>
    set((s) => ({
      selectedItems: s.selectedItems.includes(id)
        ? s.selectedItems.filter((x) => x !== id)
        : [...s.selectedItems, id],
    })),

  toggleGroupSelection: (id) =>
    set((s) => ({
      selectedGroups: s.selectedGroups.includes(id)
        ? s.selectedGroups.filter((x) => x !== id)
        : [...s.selectedGroups, id],
    })),

  clearSelection: () => set({ selectedItems: [], selectedGroups: [] }),

  setLive: (active) => {
    if (active) acquireLive();
    else releaseLive();
  },
}));

/**
 * 实时监听：**整个应用只有一个** `onClipboardChanged` 监听。
 *
 * 剪贴板既可能是侧边栏页面、又可能是任务关联抽屉；若两处各自注册监听，
 * 一次采集事件会被处理两遍（重复刷新、重复去抖），这里用引用计数保证唯一性。
 */
let liveScope: ReturnType<typeof createSubscriptionScope> | null = null;
let liveRefs = 0;
let liveTimer: number | undefined;

function acquireLive() {
  liveRefs += 1;
  if (liveScope) return;
  liveScope = createSubscriptionScope();
  liveScope.add(
    onClipboardChanged(() => {
      if (liveTimer !== undefined) window.clearTimeout(liveTimer);
      liveTimer = window.setTimeout(() => {
        liveTimer = undefined;
        void useClipboardStore.getState().load({ silent: true });
      }, 300);
    }),
  );
}

function releaseLive() {
  liveRefs = Math.max(0, liveRefs - 1);
  if (liveRefs > 0) return;
  if (liveTimer !== undefined) {
    window.clearTimeout(liveTimer);
    liveTimer = undefined;
  }
  liveScope?.dispose();
  liveScope = null;
}

/** 测试/热更新用：重置请求代际，避免跨代响应污染新实例。 */
export function resetClipboardRequestState() {
  filterGen += 1;
  reqSeq += 1;
  // 代际已推进，任何遗留的离场快照都不该再钉进新列表；收尾定时器一并回收
  for (const t of exitTimers.values()) clearTimeout(t);
  exitTimers.clear();
  useClipboardStore.setState({ exiting: {} });
}
