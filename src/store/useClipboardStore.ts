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
import {
  clipboardStatus,
  clipboardView,
  onClipboardChanged,
  type ClipboardGroup,
  type ClipboardItem,
  type ClipboardStatus,
  type ClipboardView,
} from "../lib/bridge";
import { EXIT_MS, prefersReducedMotion } from "../lib/motion";
import { createSubscriptionScope } from "../lib/subscriptions";

const PAGE_SIZE = 80;
/** 后端 `clipboard_view` 的 limit 上限；静默刷新按这个块大小补齐已加载条目。 */
const MAX_PAGE_SIZE = 200;

/**
 * 轻量视图的数据状态（与监听运行状态分开）：
 * - loading：查询中（首次为「读取中」，已有数据时静默保留旧列表）；
 * - ready：成功且确有记录；empty：成功但确实一条都没有；
 * - error：本次查询失败——已成功过的旧数据原样保留（绝不置空伪装成
 *   「暂无记录」），由面板区分「旧数据 + 错误条」与「错误空态」，均可重试。
 */
export type ClipboardLiteStatus = "loading" | "ready" | "empty" | "error";

/**
 * 剪贴板监听运行状态（从 `clipboardStatus()` 派生，与列表错误互不混淆）。
 * 派生优先级见 `clipboardMonitorState`：根因态（配置异常/关闭/暂停）先于运行态，
 * 调用失败是 unknown，初始未确定是 checking——绝不默认显示「监听中」。
 */
export type ClipboardMonitorState =
  | "checking"
  | "ok"
  | "paused"
  | "disabled"
  | "configError"
  | "notRunning"
  | "unknown";

/**
 * 从 `clipboardStatus()` 派生监听状态。
 *
 * 优先级（后端语义：configError 时采集 fail-closed，monitoring 不可信；
 * 关闭/暂停是用户意图，优先于线程实际是否在跑）：
 * 1. 调用失败 / 无数据 → unknown（状态未知）；
 * 2. configError → 配置异常；
 * 3. enabled=false → 模块关闭；
 * 4. paused=true → 用户暂停；
 * 5. monitoring=true → 监听正常；
 * 6. 其余（enabled 且未暂停但线程没在跑）→ 监听线程未运行。
 */
export function clipboardMonitorState(
  status: ClipboardStatus | null | undefined,
  failed: boolean,
): ClipboardMonitorState {
  if (failed || !status) return "unknown";
  if (status.configError) return "configError";
  if (!status.enabled) return "disabled";
  if (status.paused) return "paused";
  if (status.monitoring) return "ok";
  return "notRunning";
}

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
/** 轻量视图（胶囊面板）的在途请求代际，与完整页的 reqSeq 互不干扰 */
let liteSeq = 0;
/** 监听状态查询代际：releaseLite 后回来的旧响应不得覆盖新会话 */
let monitorSeq = 0;
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

/** 丢弃全部离场快照定时器（清空成功 / 测试与热更新重置共用）。 */
function dropExitTimers() {
  for (const t of exitTimers.values()) clearTimeout(t);
  exitTimers.clear();
}

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
  /**
   * 全量清空成功后的前端一致性收尾（**只能在后端确认清空成功后调用**）。
   *
   * - 丢弃全部离场快照并回收收尾定时器：否则后续静默刷新会把已删行按快照
   *   重新钉回空列表（看起来像「清空后内容又回来了」）；
   * - 清空多选与轻量视图，推进筛选/请求代际，让清空前发起的在途响应一律作废；
   * - 立即呈现空态，随后 `load()` 以服务端结果为准；
   * - 清空失败时不得调用，否则会提前丢掉仍有效的本地数据；
   * - 不影响单项/批量删除的离场动画（这里只处理「全部已删」这一种终态）。
   */
  resetAfterClear: () => void;
  toggleItemSelection: (id: string) => void;
  toggleGroupSelection: (id: string) => void;
  clearSelection: () => void;
  /** 订阅后端变更；**全局只建一个** Tauri 监听，页面与抽屉共享 */
  /**
   * 胶囊面板的轻量视图：只有 view=all 的前 20 条，不加载分页与历史。
   * null = 面板未打开（此时 live 回调不刷它，不多付一次 IPC）。
   */
  lite: { items: ClipboardItem[]; groups: ClipboardGroup[] } | null;
  liteLoading: boolean;
  /** 轻量视图的数据状态：失败时保留旧 lite，由面板叠加错误提示 */
  liteStatus: ClipboardLiteStatus;
  liteError: string | null;
  /** 监听运行状态（clipboardStatus 派生；与列表错误分开显示） */
  monitor: ClipboardMonitorState;
  /**
   * 轻量视图面板是否处于活跃态（独立于 `lite` 是否有数据）。
   *
   * 组件挂载即活跃，哪怕首次查询失败（`lite === null`）或正在读取——事件到达
   * 时必须继续刷新，否则「打开面板 → 复制 → 读取失败一次」会永久停在错误空态。
   */
  liteActive: boolean;
  /** 读一次轻量视图（胶囊面板挂载时调用；失败不清除已成功数据） */
  loadLite: () => Promise<void>;
  /** 读一次监听状态（面板打开与手动重试时调用，不轮询） */
  loadMonitor: () => Promise<void>;
  /** 面板卸载：作废在途请求并释放轻量视图 */
  releaseLite: () => void;
  /** 完整剪贴板页活跃态：只有它为真时，剪贴板事件才刷新完整列表。 */
  setFullLive: (active: boolean) => void;
  /** 轻量面板活跃态：只有它为真时，剪贴板事件才刷新 `lite`。 */
  setLiteLive: (active: boolean) => void;
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
      // 完整页使用 `view.items`，胶囊使用 `lite.items`：两处都只在命中时
      // 替换数组引用，未命中的切片保持原对象，避免无意义重渲染。
      let view = s.view;
      let viewChanged = false;
      if (view) {
        const items = view.items.map((item) => {
          if (item.id !== id) return item;
          viewChanged = true;
          return { ...item, copy_count: item.copy_count + 1 };
        });
        if (viewChanged) view = { ...view, items };
      }
      let lite = s.lite;
      let liteChanged = false;
      if (lite) {
        const items = lite.items.map((item) => {
          if (item.id !== id) return item;
          liteChanged = true;
          return { ...item, copy_count: item.copy_count + 1 };
        });
        if (liteChanged) lite = { ...lite, items };
      }
      if (!viewChanged && !liteChanged) return {};
      return {
        ...(viewChanged ? { view } : {}),
        ...(liteChanged ? { lite } : {}),
      };
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

  resetAfterClear: () =>
    set((s) => {
      // 离场快照与定时器必须一起失效：只清快照会让定时器到点再 endExit；
      // 只清定时器则快照会被后续静默刷新重新钉回。
      dropExitTimers();
      filterGen += 1;
      reqSeq += 1;
      liteSeq += 1;
      const stats = s.view?.stats;
      return {
        exiting: {},
        selectedItems: [],
        selectedGroups: [],
        error: null,
        loading: false,
        loadingMore: false,
        // 立即呈现空态；随后 load() 以服务端结果为准，旧请求已按代际作废
        view:
          s.view && stats
            ? {
                ...s.view,
                items: [],
                groups: [],
                total_items: 0,
                stats: {
                  ...stats,
                  items: 0,
                  groups: 0,
                  images: 0,
                  files: 0,
                  favorites: 0,
                  bytes: 0,
                  asset_bytes: 0,
                },
              }
            : s.view,
        // 胶囊轻量视图与完整页一致：正在显示时同步清空，避免残留已删条目
        lite: s.lite ? { items: [], groups: [] } : s.lite,
        liteStatus: s.lite ? "empty" : s.liteStatus,
        liteError: null,
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

  lite: null,
  liteLoading: false,
  liteStatus: "loading",
  liteError: null,
  liteActive: false,
  monitor: "checking",
  loadLite: async () => {
    const seq = ++liteSeq;
    set({ liteLoading: true, liteStatus: "loading" });
    try {
      const view = await clipboardView({ limit: 20 });
      if (seq !== liteSeq) return; // 已有更新的请求，丢弃这次响应
      const hasData = view.items.length > 0 || view.groups.length > 0;
      set({
        lite: { items: view.items, groups: view.groups },
        liteLoading: false,
        liteStatus: hasData ? "ready" : "empty",
        liteError: null,
      });
    } catch (e) {
      if (seq !== liteSeq) return;
      // 失败不清除已成功的数据：lite 原样保留（面板显示旧数据 + 错误条）；
      // 从未成功过（lite === null）时面板显示错误空态。两条路都可重试。
      set({ liteLoading: false, liteStatus: "error", liteError: String(e) });
    }
  },
  loadMonitor: async () => {
    const seq = ++monitorSeq;
    try {
      const status = await clipboardStatus();
      if (seq !== monitorSeq) return;
      useClipboardStore.setState({ monitor: clipboardMonitorState(status, false) });
    } catch {
      if (seq !== monitorSeq) return;
      useClipboardStore.setState({ monitor: "unknown" });
    }
  },
  releaseLite: () => {
    liteSeq += 1; // 卸载后回来的响应一律作废
    monitorSeq += 1;
    // 面板卸载即不再活跃；即使组件清理顺序异常，也不留下活跃引用
    liveLiteRefs = 0;
    set({
      lite: null,
      liteLoading: false,
      liteStatus: "loading",
      liteError: null,
      liteActive: false,
      monitor: "checking", // 下次打开重新确认，绝不带着旧结论伪装新鲜
    });
    ensureLive();
  },

  setFullLive: (active) => {
    if (active) {
      if (liveFullRefs === 0) {
        liveFullRefs = 1;
        ensureLive();
      }
      return;
    }
    if (liveFullRefs === 0) return;
    liveFullRefs = 0;
    ensureLive();
  },

  setLiteLive: (active) => {
    const wasActive = get().liteActive;
    if (active) {
      if (wasActive) return;
      liveLiteRefs += 1;
      set({ liteActive: true });
      ensureLive();
      return;
    }
    if (!wasActive) return;
    liveLiteRefs = Math.max(0, liveLiteRefs - 1);
    set({ liteActive: false });
    ensureLive();
  },
}));

/**
 * 实时监听：**整个应用只有一个** `onClipboardChanged` 监听。
 *
 * 完整页与胶囊轻量面板只是同一物理订阅的两个逻辑消费者：
 * - `liveFullRefs` 决定是否静默刷新完整列表（完整页未打开时不得因 Lite 事件查 80 条）；
 * - `liveLiteRefs` 决定是否刷新 `lite`（首次加载失败/为空时也必须继续刷新）。
 *
 * 订阅失败不再被静默吞掉：`SubscriptionScope.add` 返回是否注册成功，失败时销毁
 * 这个空作用域并安排退避重试，避免「liveScope 非空但监听实际没建立，之后永远
 * 无法重新订阅」。重试始终复用同一个作用域槽位，不会叠加监听。
 */
let liveScope: ReturnType<typeof createSubscriptionScope> | null = null;
let liveFullRefs = 0;
let liveLiteRefs = 0;
let liveTimer: number | undefined;
let liveRetryTimer: number | undefined;
let liveRetryAttempt = 0;
/** 事件去抖；连续事件合并成一次刷新，但始终会在 300ms 后执行。 */
const LIVE_DEBOUNCE_MS = 300;
/** 订阅失败后的重试退避上限：面板保持打开时持续尝试恢复，不做数据轮询。 */
const LIVE_RETRY_MAX_MS = 10_000;

function liveConsumerCount() {
  return liveFullRefs + liveLiteRefs;
}

function ensureLive() {
  if (liveConsumerCount() === 0) {
    teardownLive();
    return;
  }
  if (liveScope) return;

  const scope = createSubscriptionScope();
  liveScope = scope;
  void scope.add(onClipboardChanged(handleClipboardChanged)).then((registered) => {
    if (registered) {
      liveRetryAttempt = 0;
      return;
    }
    // 订阅失败：销毁这个空作用域，否则后续 ensureLive 会永远短路
    if (liveScope !== scope) return;
    liveScope = null;
    scope.dispose();
    scheduleLiveRetry();
  });
}

function scheduleLiveRetry() {
  if (liveConsumerCount() === 0 || liveRetryTimer !== undefined) return;
  const delay = Math.min(1000 * 2 ** liveRetryAttempt, LIVE_RETRY_MAX_MS);
  liveRetryAttempt += 1;
  liveRetryTimer = window.setTimeout(() => {
    liveRetryTimer = undefined;
    ensureLive();
  }, delay);
}

function teardownLive() {
  if (liveRetryTimer !== undefined) {
    window.clearTimeout(liveRetryTimer);
    liveRetryTimer = undefined;
  }
  liveRetryAttempt = 0;
  if (liveTimer !== undefined) {
    window.clearTimeout(liveTimer);
    liveTimer = undefined;
  }
  liveScope?.dispose();
  liveScope = null;
}

function handleClipboardChanged() {
  if (liveTimer !== undefined) window.clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => {
    liveTimer = undefined;
    const state = useClipboardStore.getState();
    if (liveFullRefs > 0) void state.load({ silent: true });
    // 用活跃态而不是 `lite !== null`：首次读取失败时也要能被事件带出错误态
    if (liveLiteRefs > 0) void state.loadLite();
  }, LIVE_DEBOUNCE_MS);
}

/** 测试/热更新用：重置请求代际与实时监听，避免跨代响应/旧监听污染新实例。 */
export function resetClipboardRequestState() {
  filterGen += 1;
  reqSeq += 1;
  // 代际已推进，任何遗留的离场快照都不该再钉进新列表；收尾定时器一并回收
  dropExitTimers();
  teardownLive();
  liveFullRefs = 0;
  liveLiteRefs = 0;
  useClipboardStore.setState({ exiting: {}, liteActive: false });
}

// 热更新时旧模块的监听与定时器必须释放：否则旧 store 实例的监听会继续回调，
// 与新实例叠加，表现为「事件到达但面板不更新 / 重复刷新」。
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetClipboardRequestState();
  });
}
