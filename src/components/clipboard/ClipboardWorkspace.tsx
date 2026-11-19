//! 智能剪贴板工作区：**页面与抽屉共用同一份业务逻辑**。
//!
//! - `variant="page"`：完整模式左侧导航「剪贴板」页，直接占据右侧内容区；
//! - `variant="drawer"`：任务关联 / 紧凑模式下的临时抽屉，遮罩 + 侧滑面板。
//!
//! 两种形态共用同一套状态、订阅与操作逻辑（不复制第二份）：
//! - 数据加载、筛选、分页、多选由 useClipboardStore 统一持有；
//! - 后端变更监听由 store 内部**引用计数**保证全局只有一个 Tauri 监听，
//!   因此页面与抽屉同时存在时不会重复处理同一次采集事件；
//! - Escape 走全局弹层栈：确认框(dialog) → 顶层模态(modalTop，图片灯箱) →
//!   子弹层(sublayer) → 抽屉(drawer) → 主窗口。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle, Archive, ArrowUpDown, ChevronDown, Clipboard, Copy, Eraser, Filter, FolderPlus, Info, Link2,
  ListChecks, Loader2, Merge, Pause, Pin, Play, RefreshCw, RotateCcw, Settings as SettingsIcon,
  Star, Trash2, X,
} from "lucide-react";
import { addClipboardItemsToTray } from "../../lib/crossTab/modules/clipboard";
import { useTransferStore } from "../../store/useTransferStore";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import WorkspaceSplit from "../../workbench/WorkspaceSplit";
import {
  clipboardClearHistory,
  clipboardCopyGroupFiles,
  clipboardCopyGroupRich,
  clipboardCopyItem,
  clipboardCopyItemsFiles,
  clipboardCopyItemsRich,
  clipboardCreateGroup,
  clipboardDeleteGroup,
  clipboardDeleteItems,
  clipboardGroupPage,
  clipboardItem,
  clipboardLinkTask,
  clipboardMergeGroups,
  clipboardOpenUrl,
  clipboardRevealLocalPath,
  clipboardStatus,
  clipboardToggleGroup,
  clipboardToggleItem,
  clipboardSources,
  type ClipboardGroup,
  type ClipboardItem,
  type ClipboardSourceOption,
  type ClipboardStatus,
  type CopyReport,
  type DeleteReport,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { clipSource, clipboardTime, fileBaseName, fileDirName, formatBytes, groupDeleteFeedback, kindLabel, objectHint, sourceAppName } from "../../lib/clipboardUi";
import { fileTypeFromName } from "../../lib/fileTypeUi";
import { CLIPBOARD_DENSITY_OPTIONS } from "../../lib/clipboardDensity";
import { EXIT_MS, REORDER_MS, prefersReducedMotion } from "../../lib/motion";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useLifecycleStore } from "../../store/useLifecycleStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useMainUiVisible } from "../../hooks/useMainUiVisible";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";
import { ConfirmDialog } from "../ui/Dialog";
import DropdownMenu from "../ui/DropdownMenu";
import EmptyState from "../ui/EmptyState";
import SearchField from "../ui/SearchField";
import ClipboardGroupCard from "./ClipboardGroupCard";
import ClipboardGroupDetail from "./ClipboardGroupDetail";
import ClipboardItemCard from "./ClipboardItemCard";
import ClipboardItemDetail from "./ClipboardItemDetail";
import { ClipboardHeroImage, clearClipboardMediaCache, forgetClipboardMedia } from "./Media";
import {
  WorkbenchDetailFacts,
  WorkbenchDetailHostProvider,
  WorkbenchPageDetail,
  useWorkbenchDetailHost,
} from "../../workbench/pageDetail";
import CopySwitchPanel from "./CopySwitchPanel";
import ImageLightbox from "./ImageLightbox";
import PastePanel from "./PastePanel";
import type { AskConfirm, ClipboardDetail } from "./types";
import ContextHelpButton from "../help/ContextHelpButton";
import { requestSettingsSectionReveal } from "../../lib/settingsSections";
// 页面态专属布局（网格密度 / 详情两栏）；所有规则带 .clipboard-page 前缀，抽屉态不受影响。
import "./clipboard-page.css";

const KIND_CHIPS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "text", label: "文字" },
  { id: "url", label: "链接" },
  { id: "html", label: "富文本" },
  { id: "image", label: "图片" },
  { id: "files", label: "文件" },
];

/** 时间范围筛选：0 表示不限；后端按 last_seen_at 截断，不扫描正文。 */
const TIME_RANGES: { days: number; label: string }[] = [
  { days: 0, label: "全部时间" },
  { days: 1, label: "24 小时" },
  { days: 7, label: "7 天" },
  { days: 30, label: "30 天" },
];

const SORT_OPTIONS: { id: "recent" | "most_used"; label: string; hint: string }[] = [
  { id: "recent", label: "最近记录", hint: "按采集时间，置顶条目仍优先" },
  { id: "most_used", label: "使用最多", hint: "按复制次数，置顶条目仍优先" },
];

/**
 * 图片灯箱的预览上下文。
 * - `single`：从单条卡片打开，只有当前图片；
 * - `group`：从分组封面打开，`items` 是已加载的图片序列（只含图片、按 position），
 *   `total` 是组内图片真实总数（可能大于已加载数）。分组封面 `cover_items` 最多 3 张，
 *   绝不当作整组序列使用。
 */
interface PreviewState {
  mode: "single" | "group";
  /** 打开时点击的图片 id（分组序列就绪前先用它占位） */
  itemId: string;
  groupId: string | null;
  items: ClipboardItem[];
  total: number;
  /** 后端内容版本；翻页时变化说明分组内容已移动，需要重取第一页 */
  revision: string | null;
  /**
   * 首屏真实图片序列是否已返回。false 时 items 只有打开的那张封面占位，
   * 灯箱不能把占位索引当成组内正式位置。
   */
  ready: boolean;
  loading: boolean;
  error: string | null;
}

/** 分组图片分页大小：与后端单页上限（50）一致，只取轻量元数据，不取原图。 */
const PREVIEW_PAGE_SIZE = 50;

/** 追加下一页时按 id 去重，保证序列不重复、不改变已加载顺序。 */
function mergePreviewItems(loaded: ClipboardItem[], next: ClipboardItem[]): ClipboardItem[] {
  const seen = new Set(loaded.map((i) => i.id));
  return [...loaded, ...next.filter((i) => !seen.has(i.id))];
}

export interface ClipboardWorkspaceProps {
  variant: "page" | "drawer";
  /** 活跃态：false 时不加载、不订阅（面板页离开时避免后台空转） */
  active: boolean;
  /** 抽屉形态的关闭回调 */
  onClose?: () => void;
}

export default function ClipboardWorkspace({ variant, active, onClose }: ClipboardWorkspaceProps) {
  const isDrawer = variant === "drawer";
  const linkTask = useUiStore((s) => s.clipboardLinkTask);
  const closeDrawer = useUiStore((s) => s.closeClipboard);
  const bumpLink = useUiStore((s) => s.bumpClipboardLink);
  const setTab = useUiStore((s) => s.setTab);
  const showToast = useUiStore((s) => s.showToast);
  const settings = useSettingsStore((s) => s.settings);
  // 停靠期主界面 display:none + inert：页面与抽屉都不可见。活跃态 = 调用方
  // active 且主界面可见，否则暂停加载/实时订阅/弹层注册（组件保持挂载，
  // 状态不丢；恢复可见时 load effect 依赖变化自动补一次刷新）。
  const uiVisible = useMainUiVisible();
  const uiActive = active && uiVisible;

  const view = useClipboardStore((s) => s.view);
  const filters = useClipboardStore((s) => s.filters);
  const section = useClipboardStore((s) => s.section);
  const searchText = useClipboardStore((s) => s.searchText);
  const loading = useClipboardStore((s) => s.loading);
  const loadingMore = useClipboardStore((s) => s.loadingMore);
  const error = useClipboardStore((s) => s.error);
  const selectedItems = useClipboardStore((s) => s.selectedItems);
  const selectedGroups = useClipboardStore((s) => s.selectedGroups);
  const setFilters = useClipboardStore((s) => s.setFilters);
  const setSection = useClipboardStore((s) => s.setSection);
  const density = useClipboardStore((s) => s.density);
  const setDensity = useClipboardStore((s) => s.setDensity);
  const setSearchText = useClipboardStore((s) => s.setSearchText);
  const load = useClipboardStore((s) => s.load);
  const setFullLive = useClipboardStore((s) => s.setFullLive);
  const toggleItemSelection = useClipboardStore((s) => s.toggleItemSelection);
  const toggleGroupSelection = useClipboardStore((s) => s.toggleGroupSelection);
  const clearSelection = useClipboardStore((s) => s.clearSelection);

  const [detail, setDetailState] = useState<ClipboardDetail | null>(null);
  /** 主窗口 Tab 没有工作台外壳的右栏宿主；此时卡片主体回退到完整详情，避免「点了没反应」。 */
  const detailHost = useWorkbenchDetailHost();
  const hasRailHost = !!detailHost;
  /** 外壳没有详情栏宿主时（主窗口 Tab / 非工作台路由），页面自己在宽窗口提供右栏。
      用一条 ResizeObserver 判断页面可用宽度，不按窗口宽度硬编码；窄窗仍回退完整详情。 */
  const [localRailWide, setLocalRailWide] = useState(false);
  const [localRailHost, setLocalRailHost] = useState<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setLocalRailWide(entry.contentRect.width >= 1180);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isDrawer]);
  /** 页面态：有外壳宿主，或宽窗口下可由页面自己渲染右栏；抽屉始终回退完整详情。 */
  const canPreview = !isDrawer && (hasRailHost || localRailWide);
  const pageDetailHost = hasRailHost ? detailHost : localRailHost;
  /** 选中条目的右栏预览：列表保持原位，详情在 WorkbenchPageDetail 中只读展示。 */
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** 左侧「时间与来源」高级筛选：默认展开，用户可按需折叠，主内容区随侧栏一起扩展。 */
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(true);
  /**
   * 右栏预览的**完整内容**（列表只是压实后的预览，正文被截断）。
   * 每次选中一条才取一次，`alive` 代际保证快速换选时旧响应不覆盖新内容；
   * 拉取失败保留列表预览，右栏不会变成空白。
   */
  const [railFull, setRailFull] = useState<{ id: string; item: ClipboardItem } | null>(null);
  useEffect(() => {
    if (!previewId) {
      setRailFull(null);
      return;
    }
    let alive = true;
    clipboardItem(previewId)
      .then((item) => {
        if (alive) setRailFull({ id: previewId, item });
      })
      .catch(() => {
        // 取完整内容失败不影响预览：继续展示列表里的截断预览。
      });
    return () => {
      alive = false;
    };
  }, [previewId]);
  /** 详情打开前的列表滚动位置；返回列表时按同一筛选恢复（不恢复旧筛选的位置）。 */
  const savedListScrollRef = useRef<{ top: number; filterKey: string } | null>(null);
  const restoreListScrollRef = useRef<{ top: number; filterKey: string } | null>(null);
  /**
   * 打开/关闭详情的统一入口：在列表仍然挂载时同步记录滚动位置，
   * 关闭时把快照交给 layout effect 在列表重新挂载后恢复。
   */
  function setDetail(next: ClipboardDetail | null) {
    if (next && !detail) {
      savedListScrollRef.current = {
        top: scrollRef.current?.scrollTop ?? 0,
        filterKey: listFilterKey,
      };
    } else if (!next && detail) {
      restoreListScrollRef.current = savedListScrollRef.current;
    }
    setDetailState(next);
  }
  /**
   * 列表里点缩略图打开的原图灯箱（详情视图内的灯箱由 ClipboardItemDetail 自己托管）。
   * 分组封面只给出点击的那张图片；整组图片序列在打开后用 `clipboard_group_page`
   * 按页取轻量元数据，不能用封面（最多 3 张）冒充整组。
   */
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const previewRef = useRef<PreviewState | null>(null);
  previewRef.current = preview;
  /** 预览请求代号：打开/关闭/换组立即失效，旧请求不得回写新状态。 */
  const previewGenRef = useRef(0);

  /** 关闭灯箱：递增代号让在途分组分页请求全部作废，并清空预览状态。 */
  function closePreview() {
    previewGenRef.current += 1;
    setPreview(null);
  }

  /** 单条卡片 → 单图灯箱（不显示切换控件）。 */
  function openSingleImage(item: ClipboardItem) {
    previewGenRef.current += 1;
    setPreview({
      mode: "single",
      itemId: item.id,
      groupId: null,
      items: [item],
      total: 1,
      revision: null,
      ready: true,
      loading: false,
      error: null,
    });
  }

  /** 分组封面 → 分组多图灯箱；先用点击的封面占位，随即按页取真实图片序列。 */
  function openGroupImage(group: ClipboardGroup, item: ClipboardItem) {
    const gen = ++previewGenRef.current;
    setPreview({
      mode: "group",
      itemId: item.id,
      groupId: group.id,
      items: [item],
      total: Math.max(1, group.image_count),
      revision: null,
      ready: false,
      loading: true,
      error: null,
    });
    void fetchGroupPreviewPage(group.id, gen, 0);
  }

  async function fetchGroupPreviewPage(groupId: string, gen: number, offset: number) {
    try {
      const page = await clipboardGroupPage(groupId, {
        limit: PREVIEW_PAGE_SIZE,
        offset,
        imagesOnly: true,
      });
      if (gen !== previewGenRef.current) return;
      const current = previewRef.current;
      if (!current || current.groupId !== groupId) return;
      // 翻页期间分组内容变了（移动/新增/删除）：丢弃已拼接的旧序列，从第一页重取，
      // 避免序号与 position 错位；灯箱会按当前图片 id 重新定位。
      if (offset > 0 && current.revision && page.revision !== current.revision) {
        await fetchGroupPreviewPage(groupId, gen, 0);
        return;
      }
      const items = offset === 0 ? page.items : mergePreviewItems(current.items, page.items);
      setPreview({
        ...current,
        items,
        total: Math.max(items.length, page.imageCount),
        revision: page.revision,
        ready: true,
        loading: false,
        error: null,
      });
    } catch (e) {
      if (gen !== previewGenRef.current) return;
      const current = previewRef.current;
      if (!current || current.groupId !== groupId) return;
      // 首屏失败时没有可靠序列，退回单图展示并明确报错，不伪造总数；后续页失败保留已加载部分。
      setPreview({
        ...current,
        total: offset === 0 ? current.items.length : current.total,
        // 首屏失败时没有真实序列，按单图收尾并明确报错，不再等待占位定位。
        ready: true,
        loading: false,
        error: `分组图片读取失败：${errorMessage(e)}`,
      });
    }
  }

  /** 灯箱临近已加载末尾时补下一页；串行且最多一次在途，避免重复 IPC。 */
  const requestMorePreviewRef = useRef<() => void>(() => {});
  requestMorePreviewRef.current = () => {
    const p = previewRef.current;
    if (!p || p.mode !== "group" || !p.groupId || p.loading) return;
    if (p.items.length >= p.total) return;
    const next = { ...p, loading: true };
    previewRef.current = next;
    setPreview(next);
    void fetchGroupPreviewPage(p.groupId, previewGenRef.current, p.items.length);
  };
  const onPreviewNeedMore = useCallback(() => requestMorePreviewRef.current(), []);
  const [status, setStatus] = useState<ClipboardStatus | null>(null);
  /** 暂停/恢复在途：按钮禁用并显示 loading，避免快速连点制造并发意图。 */
  const [pauseBusy, setPauseBusy] = useState(false);
  /** 状态读取失败：保留旧状态并标记过期，避免把「监听异常」显示成未知/正常 */
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 批量管理：显式模式，即使 0 选中也保留「全选当前页 / 退出」入口。 */
  const [batchMode, setBatchMode] = useState(false);
  /**
   * 页内筛选侧栏是否展开（只影响页面态）。
   * 窄容器时 WorkspaceSplit 已会自动降级为上下分区；这里给用户一个主动收纳入口，
   * 收纳后主区用满宽度，筛选入口仍在工具栏（不会「窄窗直接消失」）。
   */
  const [filtersOpen, setFiltersOpen] = useState(true);
  /** 来源应用选项（后端聚合，最多 8 项）；预览/测试环境不可用时静默降级为无来源菜单。 */
  const [sourceOptions, setSourceOptions] = useState<ClipboardSourceOption[]>([]);
  useEffect(() => {
    if (isDrawer || !filtersOpen || section !== "items") return;
    if (typeof clipboardSources !== "function") return;
    let alive = true;
    void clipboardSources(8)
      .then((rows) => {
        if (alive) setSourceOptions(rows);
      })
      .catch(() => {
        // 来源筛选是增强项：查询失败不影响主列表与现有筛选。
      });
    return () => {
      alive = false;
    };
  }, [isDrawer, filtersOpen, section, view?.total_items]);
  const [groupName, setGroupName] = useState("");
  const [mergeName, setMergeName] = useState("");
  const [confirm, setConfirm] = useState<{
    title: string;
    detail?: string;
    confirmLabel: string;
    danger?: boolean;
    run: () => void | Promise<void>;
  } | null>(null);
  /** 列表滚动状态的归属键：筛选或「历史/分组」视图一变，旧锚点与旧位置一律作废。 */
  const listFilterKey = `${section}|${filters.kind}|${filters.favorite ? "1" : "0"}|${filters.search.trim()}|${filters.sourceApp ?? ""}|${filters.recentDays ?? 0}|${filters.sort ?? "recent"}`;
  /**
   * 预览归属键：不含排序。筛选/视图一变，右侧内容就不再对应当前列表，
   * 立即收起预览，避免右栏残留一条已被筛掉的记录；仅重排（排序）不打断预览。
   */
  const previewScopeKey = `${section}|${filters.kind}|${filters.favorite ? "1" : "0"}|${filters.search.trim()}|${filters.sourceApp ?? ""}|${filters.recentDays ?? 0}`;
  const previewScopeRef = useRef(previewScopeKey);
  useEffect(() => {
    if (previewScopeRef.current === previewScopeKey) return;
    previewScopeRef.current = previewScopeKey;
    setPreviewId(null);
  }, [previewScopeKey]);
  // 删除/清空/保存导致条目离开当前列表（同一筛选内的数据刷新）时同步收起预览。
  useEffect(() => {
    if (!previewId || !view) return;
    if (section !== "items" || !view.items.some((item) => item.id === previewId)) {
      setPreviewId(null);
    }
  }, [previewId, section, view]);
  const advancedFilterCount = (filters.recentDays ? 1 : 0) + (filters.sourceApp ? 1 : 0);
  const drawerRef = useRef<HTMLElement>(null);

  // 删除反馈链：执行中（等后端确认）→ 目标卡片离场 → 离场结束再静默补位。
  // 离场中的行由 store 钉在原位，后台采集事件与静默刷新都不能把它提前卸载；
  // 快照的收尾定时器归 store 所有，动画中途关闭抽屉（卸载）也能正常收尾，
  // 不会把已删除的行以快照形式带回列表。这里的组件定时器只负责收尾后的
  // 静默刷新与焦点交接，卸载时统一回收；不做常驻轮询或高频刷新。
  const exiting = useClipboardStore((s) => s.exiting);
  const beginExit = useClipboardStore((s) => s.beginExit);
  const endExit = useClipboardStore((s) => s.endExit);
  const patchItem = useClipboardStore((s) => s.patchItem);
  const patchGroup = useClipboardStore((s) => s.patchGroup);
  /** 后端尚未确认：目标卡片显示执行中并挡住重复提交 */
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  /** 真实滚动容器是 `.clip-body`（`.clip-list` 只是行容器，自身不滚动）。 */
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 发起操作时用户所在的卡片：确认框会抢走焦点，等到确认后再取就拿不到了 */
  const confirmAnchor = useRef<string | null>(null);
  const exitTimers = useRef<number[]>([]);
  useEffect(
    () => () => {
      exitTimers.current.forEach((t) => window.clearTimeout(t));
      exitTimers.current = [];
    },
    [],
  );

  // 主列表轻量重排（FLIP）：置顶/取消置顶、静默刷新带来的顺序变化用一次
  // 位移补偿过渡。不引动画库、不常驻 rAF；只读一次 offsetTop，播完即走。
  // 与删除离场互斥：离场行的高度收拢已经在表达位移，再叠 FLIP 会来回打架。
  const listTopsRef = useRef<Map<string, number>>(new Map());
  const prevExitCountRef = useRef(0);
  const exitCount = Object.keys(exiting).length;
  useEffect(() => {
    prevExitCountRef.current = exitCount;
  }, [exitCount]);
  const flipSig =
    section +
    "|" +
    (view?.items.map((i) => i.id).join("|") ?? "") +
    "|" +
    (view?.groups.map((g) => g.id).join("|") ?? "");

  /**
   * 滚动锚点：记录滚动后第一个可见行（条目 ID + 相对可视区顶部的偏移）。
   * 只在 scroll 事件里按阈值采样并读一次 rect，没有持续 rAF，也不写样式，
   * 因此不会强制重排；列表结构变化时才用它做一次滚动补偿。
   */
  const scrollAnchorRef = useRef<{ id: string; delta: number } | null>(null);
  const scrollMetaRef = useRef<{ filterKey: string; sig: string } | null>(null);
  function recordScrollAnchor() {
    const body = scrollRef.current;
    if (!body) return;
    const rows = Array.from(body.querySelectorAll<HTMLElement>("[data-clip-id]"));
    const viewportTop = body.getBoundingClientRect().top;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      // 第一条与可视区相交的行就是滚动锚点；顶部行被新内容挤下去时据此还原
      if (rect.bottom > viewportTop + 1) {
        scrollAnchorRef.current = { id: row.dataset.clipId ?? "", delta: rect.top - viewportTop };
        return;
      }
    }
    scrollAnchorRef.current = null;
  }

  useLayoutEffect(() => {
    // 详情占用 .clip-body 时没有列表行：只更新归属键，不补偿也不播 FLIP
    if (detail) {
      scrollMetaRef.current = { filterKey: listFilterKey, sig: flipSig };
      return;
    }
    const body = scrollRef.current;
    const el = listRef.current;
    let compensated = false;
    const prevMeta = scrollMetaRef.current;
    scrollMetaRef.current = { filterKey: listFilterKey, sig: flipSig };
    if (body && prevMeta) {
      if (prevMeta.filterKey !== listFilterKey) {
        // 筛选/分组切换允许回顶；旧筛选的滚动状态不得落到新筛选上
        body.scrollTop = 0;
        scrollAnchorRef.current = null;
      } else if (prevMeta.sig !== flipSig) {
        const anchor = scrollAnchorRef.current;
        // 顶部附近不补偿，保证外部新增历史时正常显示最新内容
        if (anchor && body.scrollTop > 8) {
          const rows = body.querySelectorAll<HTMLElement>("[data-clip-id]");
          let row: HTMLElement | null = null;
          for (const r of rows) {
            if (r.dataset.clipId === anchor.id) {
              row = r;
              break;
            }
          }
          if (row) {
            const delta = row.getBoundingClientRect().top - body.getBoundingClientRect().top;
            const shift = delta - anchor.delta;
            if (Math.abs(shift) >= 1) {
              body.scrollTop += shift;
              scrollAnchorRef.current = { id: anchor.id, delta };
              compensated = true;
            }
          }
        }
      }
    }
    if (!el) return;
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-clip-id]"));
    const tops = new Map(rows.map((r) => [r.dataset.clipId ?? "", r.offsetTop]));
    const prev = listTopsRef.current;
    const prevExiting = prevExitCountRef.current;
    listTopsRef.current = tops;
    // 首次渲染没有参照位置；离场开始/结束的渲染不做重排（收拢动画已表达位移）
    if (prev.size === 0 || exitCount > 0 || prevExiting > 0) return;
    // 滚动补偿已经表达位移，再叠 FLIP 会双重移动（数据正确性优先于动画）
    if (compensated || prefersReducedMotion() || rows.length > 60) return;
    for (const r of rows) {
      const id = r.dataset.clipId ?? "";
      const before = prev.get(id);
      if (before === undefined) continue;
      const delta = before - (tops.get(id) ?? before);
      if (delta === 0 || typeof r.animate !== "function") continue;
      r.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: REORDER_MS, easing: "ease" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipSig, listFilterKey, detail]);

  /** 从详情返回列表：列表重新挂载后恢复原滚动位置（同一筛选内才恢复）。 */
  useLayoutEffect(() => {
    if (detail) return;
    const body = scrollRef.current;
    const saved = restoreListScrollRef.current;
    restoreListScrollRef.current = null;
    if (!body || !saved) return;
    if (saved.filterKey !== listFilterKey) return;
    body.scrollTop = saved.top;
    recordScrollAnchor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  /** 焦点在被删卡片上时，先记下相邻行的 id，供离场结束后接管焦点。 */
  function captureFocusAnchor(ids: string[]): string | null {
    const active = document.activeElement;
    let card =
      active instanceof HTMLElement ? active.closest<HTMLElement>("[data-clip-id]") : null;
    // 「更多操作」菜单渲染在 portal 里：触发删除时焦点已不在卡片内。
    // 单条删除按目标 id 反查卡片，否则键盘用户确认后会掉回 body。
    if (!card && ids.length === 1) {
      card =
        Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-clip-id]") ?? []).find(
          (el) => el.dataset.clipId === ids[0],
        ) ?? null;
    }
    if (!card) return null;
    const gone = new Set(ids);
    const rows = Array.from(
      card.parentElement?.querySelectorAll<HTMLElement>("[data-clip-id]") ?? [],
    );
    const self = rows.indexOf(card);
    const alive = (el: HTMLElement) => !gone.has(el.dataset.clipId ?? "");
    const next = rows.slice(self + 1).find(alive);
    const prev = rows.slice(0, Math.max(self, 0)).reverse().find(alive);
    return (next ?? prev)?.dataset.clipId ?? null;
  }
  /** 离场结束：放手让列表补位、静默刷新，并把焦点交还给相邻卡片或搜索框。 */
  function scheduleExitEnd(ids: string[], anchorId: string | null, after?: () => void) {
    const timer = window.setTimeout(
      () => {
        exitTimers.current = exitTimers.current.filter((t) => t !== timer);
        endExit(ids);
        void load({ silent: true });
        if (anchorId) {
          const selector = `[data-clip-id="${CSS.escape(anchorId)}"]`;
          const el = listRef.current?.querySelector<HTMLElement>(selector);
          // 卡片根节点不再是按钮（也不再吃键盘事件），焦点必须落到卡内真实入口：
          // 条目的主预览按钮，分组则退回第一个可用动作按钮，最后才是搜索框。
          const main = el?.querySelector<HTMLElement>(".clip-item-main");
          if (main && main.tagName === "BUTTON") {
            main.focus();
          } else {
            (el?.querySelector<HTMLElement>("button:not([disabled])") ?? searchRef.current)?.focus();
          }
        }
        after?.();
      },
      prefersReducedMotion() ? 0 : EXIT_MS,
    );
    exitTimers.current.push(timer);
  }

  /**
   * 删除的统一反馈链。`countOf` 决定「后端到底删掉了几个目标对象」：
   * 条目看 `deleted`，分组看命令是否成功（`deleted` 只统计连带删除的条目）。
   * 数量为 0 时如实提示并刷新，绝不演一场成功。
   */
  async function runDelete(
    ids: string[],
    kind: "item" | "group",
    invokeDelete: () => Promise<DeleteReport>,
    countOf: (r: DeleteReport) => number,
    report: (deleted: number) => void,
    after?: () => void,
  ) {
    setPendingIds((prev) => [...prev, ...ids]);
    // 优先用发起操作时记下的相邻行；没有（例如批量操作在工具栏发起）就不接管焦点
    const anchorId = confirmAnchor.current ?? captureFocusAnchor(ids);
    confirmAnchor.current = null;
    try {
      const r = await invokeDelete();
      const deleted = countOf(r);
      if (deleted <= 0) {
        showToast("这些内容已经不存在，列表已刷新", { kind: "warning" });
        void load({ silent: true });
        return;
      }
      if (deleted < ids.length) {
        // 后端只删掉一部分，而且报告里说不清是哪几条：整批演离场等于把没删掉的
        // 也伪装成已删除。如实报数并按服务端结果重新同步，剩下由刷新来定性。
        showToast(`选中 ${ids.length} 条，实际删除 ${deleted} 条，其余仍在列表中`, { kind: "warning" });
        void load({ silent: true });
        return;
      }
      beginExit(ids, kind);
      report(deleted);
      scheduleExitEnd(ids, anchorId, after);
    } catch (e) {
      showToast(`删除剪贴板项失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setPendingIds((prev) => prev.filter((x) => !ids.includes(x)));
    }
  }

  const askConfirm: AskConfirm = (opts) => {
    // 确认框打开后会夺走焦点，此刻还没删任何东西，先记下相邻卡片
    confirmAnchor.current = captureFocusAnchor([]);
    setConfirm({
      title: opts.title,
      detail: opts.detail,
      confirmLabel: opts.confirmLabel ?? "确认",
      danger: opts.danger,
      run: opts.run,
    });
  };

  // 打开或筛选变化时拉取（停靠隐藏期暂停；恢复可见时依赖变化自动补一次）
  useEffect(() => {
    if (!uiActive) return;
    void load();
  }, [
    uiActive,
    filters.kind,
    filters.favorite,
    filters.search,
    filters.sourceApp,
    filters.recentDays,
    filters.sort,
    load,
  ]);

  // 搜索防抖：输入框即时回显，筛选条件延迟落库
  useEffect(() => {
    if (!uiActive) return;
    const t = window.setTimeout(() => {
      if (searchText !== filters.search) setFilters({ search: searchText });
    }, 260);
    return () => window.clearTimeout(t);
  }, [searchText, uiActive, filters.search, setFilters]);

  // 全局搜索定位：消费一次性意图，直接按 id 打开条目详情
  // （ClipboardItemDetail 以 itemId 独立取数，不依赖当前过滤列表）。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "clipboard") return;
    const intent = pendingLocate;
    consumeLocate();
    setDetail({ kind: "item", id: intent.id });
    // 仅响应定位意图变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocate]);

  // 工具面板「逐项粘贴」：一次性意图，切到本页后直接打开既有 PastePanel。
  // 目标窗口选择、身份预检、队列进度、取消/恢复全部复用完整面板，
  // 工具面板不维护第二套粘贴状态机。
  const pasteRequest = useUiStore((s) => s.clipboardPasteRequest);
  const clearPasteRequest = useUiStore((s) => s.clearClipboardPasteRequest);
  useEffect(() => {
    // 抽屉与页面共用 Workspace：只允许完整页面消费工具面板导航意图，
    // 避免用户打开剪贴板抽屉时被一个待决粘贴请求劫持。
    if (!pasteRequest || !uiActive || isDrawer) return;
    const intent = pasteRequest;
    clearPasteRequest();
    // 导航事务异常/用户很久后才进入剪贴板：过期意图直接丢弃，不突然弹层。
    if (Date.now() > intent.expiresAt) return;
    setDetail({ kind: "paste", id: intent.groupId, name: intent.groupName });
    // 仅响应一次性意图变化；setDetail 每次渲染重建，不能进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasteRequest, uiActive, isDrawer, clearPasteRequest]);

  // 关联模式固定回到「历史」：上次浏览停在「分组」时直接复用会让用户看不到任何可选条目
  useEffect(() => {
    if (!linkTask) return;
    setSection("items");
    clearSelection();
  }, [linkTask, clearSelection, setSection]);

  // 实时监听：交给 store 统一管理（全局只建一个 Tauri 监听）。
  // 停靠隐藏期退出消费者引用（liveFullRefs 归零，无胶囊消费者时监听整体拆除）；
  // 后端采集线程独立运行，不受此影响 —— 这里只停 UI 刷新，不停采集。
  useEffect(() => {
    if (!uiActive) return;
    setFullLive(true);
    return () => setFullLive(false);
  }, [uiActive, setFullLive]);

  // 监听状态（区分「已暂停」与「监听线程未启动」）
  useEffect(() => {
    if (!uiActive) return;
    let alive = true;
    clipboardStatus()
      .then((s) => {
        if (alive) {
          setStatus(s);
          setStatusError(null);
        }
      })
      .catch((e) => {
        if (alive) setStatusError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [uiActive]);

  // 关闭时重置子视图与确认框
  useEffect(() => {
    if (active) return;
    setDetail(null);
    setConfirm(null);
    // 离开面板时关掉灯箱：递增代号作废在途分组分页请求，避免回到面板后旧图闪现
    setPreview(null);
    previewGenRef.current += 1;
  }, [active]);

  // 弹层栈：详情子视图 → 抽屉。确认框由 ConfirmDialog 自己注册（dialog，优先级最高）。
  // 按活跃态注册：停靠隐藏期的不可见弹层不得消费 Escape（否则胶囊态按 Esc
  // 会去关看不见的详情/抽屉，而不是收起面板）。
  useOverlayLayer("sublayer", uiActive && !!detail, () => setDetail(null));
  // 关联模式（从任务编辑器发起）时，抽屉是**盖在编辑器之上**的模态选择面，
  // Escape 必须先关抽屉而不是编辑器——弹层层级要和视觉层级一致。
  // 因此关联模式按 dialog 注册，并让任务编辑器在抽屉打开期间让出弹层栈。
  useOverlayLayer(linkTask ? "dialog" : "drawer", uiActive && isDrawer, () => (onClose ?? closeDrawer)(), drawerRef);
  // 焦点陷阱：抽屉内 Tab 循环；确认框打开时交由确认框自己接管
  useFocusTrap(uiActive && isDrawer && !confirm, drawerRef);

  // 配置异常优先于 enabled/paused：损坏的配置绝不能显示为“监听中”。
  const configError = status?.configError ?? null;
  const configOrigin = status?.configOrigin ?? null;
  const legacyPaused = !configError && configOrigin === "legacy_upgrade_paused";
  const paused = configError ? true : settings?.clipboard_paused ?? false;
  const enabled = configError ? false : settings?.clipboard_enabled ?? true;
  /**
   * 监听状态必须区分「尚未查询完」与「监听正常」。
   *
   * 2026-11-16 修复：此前 `status === null` 时 `monitoringDown` 为 false，
   * 分支直接落到「监听中」——首次挂载、状态查询失败都会短暂/持续显示
   * 一个未经确认的正常态。现在三态前置：
   *   查询中（checking）→ 运行状态未知（unknown）→ 只有拿到 `monitoring=true`
   *   才允许显示「监听中」。暂停/停用的「意图态」仍可先于线程状态显示，
   *   因为那是数据库里已确认的用户设置，不代表线程已在跑。
   */
  const statusLoaded = status !== null;
  const statusUnknown = !statusLoaded && statusError !== null;
  const monitoringDown = statusLoaded && status?.monitoring === false;
  const draining = Boolean(status?.monitoring || status?.maintenance || status?.draining);
  // 停用/暂停请求已接受但线程仍在收尾：如实显示过渡态，不提前说“已停止/已暂停”。
  const stopping = !enabled && draining;
  const pausing = enabled && paused && draining;
  const statusLabel = configError
    ? "配置异常，自动记录已暂停"
    : statusUnknown
      ? "运行状态未知"
      : !statusLoaded
        ? "正在检查运行状态…"
        : !enabled
          ? stopping
            ? "正在停止…"
            : "已停用"
          : paused
            ? pausing
              ? "正在暂停…"
              : "已暂停"
            : monitoringDown
              ? "监听未启动"
              : "监听中";
  const statusTone = configError
    ? "bad"
    : statusUnknown
      ? "bad"
      : !statusLoaded
        ? "idle"
        : !enabled
          ? stopping
            ? "paused"
            : "off"
          : paused
            ? "paused"
            : monitoringDown
              ? "bad"
              : "ok";
  const stats = view?.stats;

  function reportCopy(r: CopyReport) {
    const warn = r.warnings.length > 0 ? `；${r.warnings.join("；")}` : "";
    // 剪贴板写入成功但统计/降级项未完成时显示「部分成功」，不冒充完全成功
    const partial = r.warnings.length > 0 || r.stats_recorded === false;
    showToast(
      `${partial ? "已复制（部分成功）" : "已复制"} ${r.item_count} 项（${r.mode.toUpperCase()}，${formatBytes(r.bytes)}）${warn}`,
      { kind: partial ? "info" : "success" },
    );
  }

  async function onCopyItem(item: ClipboardItem) {
    try {
      const r = await clipboardCopyItem(item.id);
      reportCopy(r);
      // 复制不改变排序：只就地更新使用次数，避免整表刷新导致分页丢失或滚动跳顶。
      // 统计没落库时不能显示次数（否则 UI 与数据库永久不一致）。
      if (r.stats_recorded !== false) useClipboardStore.getState().bumpItemCopy(item.id);
    } catch (e) {
      showToast(`复制失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  async function onToggleItem(item: ClipboardItem, flag: "favorite" | "pinned") {
    try {
      const updated = await clipboardToggleItem(item.id, flag);
      // 后端返回最新实体：图标就地翻转，不必等整表刷新才确认操作生效
      patchItem(updated);
      const hint = objectHint(item);
      if (flag === "favorite") {
        showToast(
          updated.favorite
            ? `已收藏「${hint}」`
            : filters.favorite
              // 只看收藏下取消收藏会让它离开当前列表：说清是退出筛选，不是删除
              ? `已取消收藏「${hint}」，退出「只看收藏」列表，内容仍保留在历史中`
              : `已取消收藏「${hint}」，内容仍保留在历史中`,
          { kind: "success" },
        );
      } else {
        showToast(
          updated.pinned
            ? `已置顶「${hint}」，将排到列表前面`
            : `已取消置顶「${hint}」，按时间回到原位`,
          { kind: "success" },
        );
      }
      // 置顶会改变排序，仍需静默刷新拿到新的顺序
      void load({ silent: true });
    } catch (e) {
      showToast(`更新剪贴板项收藏/置顶失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  function onDeleteItem(item: ClipboardItem) {
    askConfirm({
      title: "删除这条剪贴板历史？",
      detail: item.file_paths.length > 0
        ? "将同时从所属分组和任务关联中移除；文件条目只删除历史记录，不会删除磁盘上的文件。"
        : "将同时从所属分组和任务关联中移除。",
      confirmLabel: "删除",
      danger: true,
      run: () =>
        runDelete(
          [item.id],
          "item",
          () => clipboardDeleteItems([item.id]),
          (r) => r.deleted,
          // 带上对象信息：相似内容连排时，只有一句「删除成功」认不出动的是哪条
          () => showToast(`已删除「${objectHint(item)}」`, { kind: "success" }),
          // 后端已确认删除：丢弃该条目的图像缓存，避免缩略图/预览残留在内存里，
          // 也防止「删完又滚回来」时旧图闪现。
          () => forgetClipboardMedia(item.id),
        ),
    });
  }

  /** 链接条目：显式用户操作才访问网络（后端二次校验只允许 http/https）。 */
  async function onOpenUrlItem(item: ClipboardItem) {
    try {
      await clipboardOpenUrl(item.id);
      showToast("已在浏览器中打开链接", { kind: "success" });
    } catch (e) {
      showToast(`打开链接失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  /** 文件条目：在资源管理器中定位（不打开内容，只定位路径）。 */
  async function onRevealLocalFile(path: string) {
    try {
      await clipboardRevealLocalPath(path);
    } catch (e) {
      showToast(`定位文件失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  async function onCopyGroup(group: ClipboardGroup, mode: "rich" | "files") {
    setBusy(`${mode}-${group.id}`);
    try {
      const r = mode === "rich"
        ? await clipboardCopyGroupRich(group.id)
        : await clipboardCopyGroupFiles(group.id);
      reportCopy(r);
    } catch (e) {
      showToast(`复制失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onToggleGroup(group: ClipboardGroup, flag: "favorite" | "pinned") {
    try {
      const updated = await clipboardToggleGroup(group.id, flag);
      patchGroup(updated);
      const action = flag === "favorite"
        ? updated.favorite ? "已收藏" : "已取消收藏"
        : updated.pinned ? "已置顶" : "已取消置顶";
      showToast(`${action}分组「${group.name}」`, { kind: "success" });
      void load({ silent: true });
    } catch (e) {
      showToast(`更新分组收藏/置顶失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  function onDeleteGroup(group: ClipboardGroup) {
    // 反馈必须用后端真实报告（尤其 retained_shared），不能拿 0 假定：
    // 分组只删自身时条目仍保留，是否「因共享而保留」只有后端知道。
    let lastReport: DeleteReport | null = null;
    askConfirm({
      title: `删除分组「${group.name}」？`,
      detail: "只删除分组本身，分组内的历史条目仍保留。若要连同内容删除，请在分组详情中操作。",
      confirmLabel: "删除分组",
      danger: true,
      // 保留条目时报告的 deleted 只统计条目（恒为 0），分组本身删没删看 groups_deleted：
      // 分组不存在时（groups_deleted = 0）如实提示并刷新，绝不演一场成功
      run: () =>
        runDelete(
          [group.id],
          "group",
          async () => {
            const r = await clipboardDeleteGroup(group.id, false);
            lastReport = r;
            return r;
          },
          (r) => r.groups_deleted,
          // 与分组详情共用同一反馈函数：判定看 groups_deleted，文案不各写一份
          (deleted) => {
            const feedback = groupDeleteFeedback(group.name, false, {
              groups_deleted: deleted,
              deleted: lastReport?.deleted ?? 0,
              retained_shared: lastReport?.retained_shared ?? 0,
            });
            showToast(feedback.message, { kind: feedback.kind });
          },
        ),
    });
  }

  function onClearHistory() {
    if (historyCount === 0) return;
    askConfirm({
      title: "确定清空全部剪贴板历史？",
      detail:
        "将删除 Dock 保存的全部历史条目、分组和相关内部图片缓存，包括收藏和置顶内容。此操作不可撤销。" +
        "不会清除系统当前剪贴板，也不会删除电脑中的原始文件。",
      confirmLabel: "确认清空",
      danger: true,
      run: async () => {
        setBusy("clear-history");
        try {
          const r = await clipboardClearHistory();
          // 后端确认成功后才让本地离场快照/定时器失效；失败时保留现有数据。
          setDetail(null);
          closePreview();
          // 清空后没有「原列表」可返回：丢弃刚记录的详情返回快照
          restoreListScrollRef.current = null;
          useClipboardStore.getState().resetAfterClear();
          // 清空成功后才丢弃图像缓存：失败时 UI 仍展示旧数据，缓存也必须继续可用。
          clearClipboardMediaCache();
          const warn = r.failed_files > 0
            ? `；${r.failed_files} 个缓存文件删除失败，将在下次清理时重试`
            : "";
          showToast(
            `已清空 ${r.items} 条历史、${r.groups} 个分组${warn}`,
            { kind: r.failed_files > 0 ? "info" : "success" },
          );
          await load();
        } catch (e) {
          showToast(`清空失败：${errorMessage(e)}`, { kind: "error" });
        } finally {
          setBusy(null);
        }
      },
    });
  }

  async function onCreateGroup() {
    if (selectedItems.length === 0) return;
    setBusy("create-group");
    try {
      const g = await clipboardCreateGroup(groupName.trim() || "手动分组", selectedItems);
      setGroupName("");
      clearSelection();
      setSection("groups");
      showToast(`已创建分组「${g.name}」，共 ${g.item_count} 项`, { kind: "success" });
      void load({ silent: true });
    } catch (e) {
      showToast(`创建分组失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  /** 任意多选批量复制：rich=富文本整合；files=文件/图片本地路径。 */
  async function onCopySelectedItems(mode: "rich" | "files") {
    if (selectedItems.length === 0) return;
    setBusy(`copy-selected-${mode}`);
    try {
      const r = mode === "rich"
        ? await clipboardCopyItemsRich(selectedItems)
        : await clipboardCopyItemsFiles(selectedItems);
      reportCopy(r);
    } catch (e) {
      showToast(`批量复制失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onMergeGroups() {
    if (selectedGroups.length < 2) return;
    const ids = [...selectedGroups];
    setBusy("merge");
    try {
      const g = await clipboardMergeGroups(ids, mergeName.trim() || "合并分组");
      setMergeName("");
      // 原分组用与删除一致的离场语言退场，新分组随刷新出现
      beginExit(ids, "group");
      clearSelection();
      setSection("groups");
      showToast(`已合并为「${g.name}」，共 ${g.item_count} 项；原 ${ids.length} 个分组不再单独显示`, { kind: "success" });
      // 离场结束时 scheduleExitEnd 已带一次静默刷新，这里不再重复请求
      scheduleExitEnd(ids, null);
    } catch (e) {
      showToast(`合并失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  function onDeleteSelectedItems() {
    const ids = [...selectedItems];
    if (ids.length === 0) return;
    askConfirm({
      title: `删除选中的 ${ids.length} 条历史？`,
      detail: "将同时从所属分组和任务关联中移除；文件条目只删除记录，不会删除磁盘文件。",
      confirmLabel: "删除所选",
      danger: true,
      run: () =>
        runDelete(
          ids,
          "item",
          () => clipboardDeleteItems(ids),
          (r) => r.deleted,
          // 走到这里说明选中项已全部删除；数量仍以后端为准
          (deleted) => showToast(`已删除 ${deleted} 条`, { kind: "success" }),
          () => {
            ids.forEach(forgetClipboardMedia);
            clearSelection();
          },
        ),
    });
  }

  /** 批量加入全局工作篮：只读历史，不复制系统剪贴板监听。 */
  async function onAddSelectedToTray() {
    if (selectedItems.length === 0) return;
    setBusy("tray");
    try {
      const { report, rejected } = await addClipboardItemsToTray([...selectedItems]);
      if (report) {
        showToast(`已加入工作篮 ${report.items.length} 项`, { kind: "success" });
        if (report.duplicates > 0) {
          showToast(`其中 ${report.duplicates} 项已在工作篮中，未重复加入`, { kind: "warning" });
        }
      }
      if (rejected.length > 0) {
        showToast(`${rejected.length} 项未被加入：${rejected[0].message}`, { kind: "error" });
      }
      useTransferStore.getState().openPanel();
    } catch (e) {
      showToast(`加入工作篮失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onLink(targetType: "item" | "group", targetId: string) {
    if (!linkTask) return;
    try {
      await clipboardLinkTask(linkTask.id, targetType, targetId);
      bumpLink();
      showToast(`已关联到任务「${linkTask.title}」`, { kind: "success" });
      closeDrawer();
    } catch (e) {
      showToast(`关联失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  async function togglePause() {
    if (pauseBusy) return;
    const nextPaused = !paused;
    setPauseBusy(true);
    try {
      // 统一走生命周期适配层（内部写既有 clipboard_paused 设置键）：
      // 设置页、胶囊与资源管理使用同一份意图，不存在第二套暂停状态。
      const result = await useLifecycleStore.getState().setPaused("clipboard", nextPaused);
      if (result === "failed") {
        const reason = useLifecycleStore.getState().errors.clipboard;
        showToast(`切换失败：${reason ?? "未知错误"}`, { kind: "error" });
        return;
      }
      // 写库成功不等于线程已退出/已重建：回读实际状态后再给出反馈。
      const s = await clipboardStatus();
      setStatus(s);
      setStatusError(null);
      if (result === "unconfirmed") {
        // 配置已更新但状态查询失败：只报告“未确认”，不冒充资源已释放/监听已恢复。
        showToast("配置已更新，运行状态未确认（可稍后重试刷新）", { kind: "warning" });
      } else if (nextPaused) {
        const stillDraining = s.monitoring || s.maintenance || s.draining;
        showToast(
          stillDraining
            ? "已暂停记录新内容，采集线程正在安全收尾"
            : "已暂停记录新的剪贴板内容（历史仍可查看）",
          { kind: stillDraining ? "info" : "success" },
        );
      } else if (s.monitoring) {
        showToast("已恢复监听", { kind: "success" });
      } else {
        // 不把「配置已恢复」冒充成「监听已启动」。
        showToast("已恢复记录，监听线程尚未启动，正在重试", { kind: "warning" });
      }
    } catch (e) {
      showToast(`切换失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setPauseBusy(false);
    }
  }

  function goSettings() {
    // 跨模块定位：设置页按一级分类组织后，直接定位到「智能剪贴板」分组
    // （切分类 → 展开分组 → 滚动由设置页统一处理），用户不用再自己找。
    requestSettingsSectionReveal("clipboard");
    setTab("settings");
    if (isDrawer) closeDrawer();
  }

  const filterActive =
    filters.kind !== "all" ||
    filters.favorite ||
    filters.search.trim() !== "" ||
    Boolean(filters.sourceApp) ||
    Boolean(filters.recentDays);
  const sortMode = filters.sort ?? "recent";
  const canResetFilters = filterActive || sortMode !== "recent";

  /** 条件重置：搜索框、类型、收藏、来源、时间、排序一次归零。 */
  function resetFilters() {
    useClipboardStore.getState().setSearchText("");
    setFilters({
      kind: "all",
      search: "",
      favorite: false,
      sourceApp: undefined,
      recentDays: undefined,
      sort: "recent",
    });
  }

  /** 清空入口的可用性：条目与分组都为空时没有可清空的内容。 */
  const historyCount = (stats?.items ?? 0) + (stats?.groups ?? 0);
  /** 所选里是否至少有一条文件/图片；纯文字选区不能「复制为文件」。 */
  const selectedHasFiles = (view?.items ?? []).some(
    (i) => selectedItems.includes(i.id) && (i.kind === "image" || i.kind === "files"),
  );

  function renderList() {
    if (section === "groups") {
      const groups = view?.groups ?? [];
      if (loading && !view) return <div className="clip-loading">正在加载分组…</div>;
      if (error) {
        return (
          <div className="clip-empty">
            <span>{error}</span>
            <button className="btn sm" onClick={() => void load()}>重试</button>
          </div>
        );
      }
      if (groups.length === 0) {
        return (
          <EmptyState
            icon={<Clipboard size={22} />}
            title="暂无分组"
            hint="连续复制的相关操作会自动整理为分组；也可以在历史中勾选条目后手动创建分组。"
          />
        );
      }
      return (
        <div className={`clip-list${isDrawer ? "" : ` clip-group-grid clip-density-${density}`}`} ref={listRef}>
          {groups.map((g) => (
            <ClipboardGroupCard
              key={g.id}
              group={g}
              density={isDrawer ? undefined : density}
              selected={selectedGroups.includes(g.id)}
              removing={!!exiting[g.id]}
              pending={pendingIds.includes(g.id)}
              linkMode={!!linkTask}
              onSelect={() => toggleGroupSelection(g.id)}
              onToggle={(flag) => void onToggleGroup(g, flag)}
              onCopyRich={() => void onCopyGroup(g, "rich")}
              onCopyFiles={() => void onCopyGroup(g, "files")}
              onPaste={() => setDetail({ kind: "paste", id: g.id, name: g.name })}
              onDetail={() => setDetail({ kind: "group", id: g.id })}
              onDelete={() => onDeleteGroup(g)}
              onLink={() => void onLink("group", g.id)}
              onOpenImage={(item) => openGroupImage(g, item)}
            />
          ))}
        </div>
      );
    }

    const items = view?.items ?? [];
    if (loading && !view) return <div className="clip-loading">正在加载剪贴板历史…</div>;
    if (error) {
      return (
        <div className="clip-empty">
          <span>{error}</span>
          <button className="btn sm" onClick={() => void load()}>重试</button>
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <EmptyState
          icon={<Clipboard size={22} />}
          title={filterActive ? "没有符合条件的记录" : "还没有剪贴板记录"}
          hint={
            configError
              ? "剪贴板配置异常，自动记录已暂停；请在设置 → 智能剪贴板中修复。"
              : !enabled
                ? "剪贴板记录已停用，可在设置中开启。"
                : paused
                  ? "监听已暂停，恢复后新的复制才会被记录。"
                  : filterActive
                    ? "试试清除搜索或切换类型筛选。"
                    : "复制文字、图片或文件后会自动出现在这里。"
          }
        />
      );
    }
    return (
      <>
        {/* 页面态加网格修饰类（宽屏自适应多列）；抽屉保持原单列列表 */}
        <div className={`clip-list${isDrawer ? "" : ` clip-list-grid clip-density-${density}`}`} ref={listRef}>
          {items.map((item) => (
            <ClipboardItemCard
              key={item.id}
              item={item}
              selected={selectedItems.includes(item.id)}
              previewed={canPreview && previewId === item.id}
              removing={!!exiting[item.id]}
              pending={pendingIds.includes(item.id)}
              linkMode={!!linkTask}
              density={isDrawer ? undefined : density}
              onSelect={() => toggleItemSelection(item.id)}
              onCopy={() => void onCopyItem(item)}
              onCopySwitch={() => setDetail({ kind: "copy-switch", item })}
              onToggle={(flag) => void onToggleItem(item, flag)}
              onDetail={() => setDetail({ kind: "item", id: item.id })}
              onPreview={
                isDrawer
                  ? undefined
                  : canPreview
                    ? () => setPreviewId(item.id)
                    : () => setDetail({ kind: "item", id: item.id })
              }
              onDelete={() => onDeleteItem(item)}
              onLink={() => void onLink("item", item.id)}
              onOpenImage={() => openSingleImage(item)}
              onOpenUrl={item.kind === "url" ? () => void onOpenUrlItem(item) : undefined}
            />
          ))}
        </div>
        {view && view.items.length < view.total_items && (
          <button className="btn sm clip-more" onClick={() => void load({ append: true })} disabled={loadingMore}>
            {loadingMore ? <RefreshCw size={12} className="spin" /> : null}
            加载更多（{view.items.length}/{view.total_items}）
          </button>
        )}
      </>
    );
  }

  /**
   * 灯箱当前条目：优先按打开时的 id 定位（分组序列可能晚到），找不到就退回序列首张。
   * 序列为空（分组已无图片/被删）时关闭灯箱，不留指向已删除数据的预览。
   */
  const previewItem = preview
    ? preview.items.find((i) => i.id === preview.itemId) ?? preview.items[0]
    : null;

  /** 右栏预览对象：只从当前已加载列表里取，翻页/筛选变化后自然失效，不保留旧详情。 */
  const railItem = previewId
    ? (view?.items.find((i) => i.id === previewId) ?? null)
    : null;
  const railSource = railItem ? clipSource(railItem) : null;
  /** 右栏正文：优先用按需取的完整内容，失败时退回列表里的截断预览。 */
  const railDetail = railFull && railItem && railFull.id === railItem.id ? railFull.item : null;
  const railText = (railDetail?.text || railItem?.preview || "").trim();

  /** 页头动作在页面态与抽屉态共用；抽屉隐藏帮助入口，关闭按钮只在抽屉出现。 */
  const headActions = (
    <>
      {!isDrawer && <ContextHelpButton articleId="help.clipboard.history" />}
      <button
        className={`icon-btn sm ${paused ? "active" : ""}`}
        data-tip={
          !enabled
            ? "剪贴板记录已停用，请在设置中开启"
            : paused
              ? "恢复监听"
              : "暂停记录新的剪贴板内容（停止监听与维护线程，仍可查看历史与粘贴）"
        }
        aria-label={paused ? "恢复监听" : "暂停监听"}
        aria-pressed={paused}
        aria-busy={pauseBusy}
        disabled={!enabled || pauseBusy}
        onClick={togglePause}
      >
        {pauseBusy ? (
          <Loader2 size={13} className="spin" aria-hidden="true" />
        ) : paused ? (
          <Play size={13} aria-hidden="true" />
        ) : (
          <Pause size={13} aria-hidden="true" />
        )}
      </button>
      <button className="icon-btn sm" data-tip="剪贴板设置" aria-label="剪贴板设置" onClick={goSettings}>
        <SettingsIcon size={13} />
      </button>
      {isDrawer && (
        <button className="icon-btn sm" data-tip="关闭 (Esc)" aria-label="关闭剪贴板" onClick={onClose ?? closeDrawer}>
          <X size={14} />
        </button>
      )}
    </>
  );
  const headStatus = (
    <span className={`clip-status tone-${statusTone}`}>
      <i /> {statusLabel}
    </span>
  );

  const body = (
    <>
      {isDrawer ? (
        <header className="clip-head">
          <div className="clip-head-title">
            <Clipboard size={15} />
            <span>智能剪贴板</span>
            {headStatus}
          </div>
          <div className="clip-head-actions">{headActions}</div>
        </header>
      ) : (
        <WorkbenchPageHeader
          icon={Clipboard}
          title="智能剪贴板"
          meta={headStatus}
          subtitle={
            canPreview
              ? "搜索与筛选历史；点卡片在右侧预览，勾选可批量复制"
              : "搜索与筛选历史；点卡片打开完整详情，勾选可批量复制"
          }
          actions={<div className="clip-head-actions">{headActions}</div>}
        />
      )}
      {statusError && (
        <div className="empty-hint error-text" role="status">
          剪贴板状态读取失败：{statusError}（下方状态可能不是最新）
          <button
            className="btn sm"
            onClick={() => {
              clipboardStatus()
                .then((s) => {
                  setStatus(s);
                  setStatusError(null);
                })
                .catch((e) => setStatusError(errorMessage(e)));
            }}
          >
            重试
          </button>
        </div>
      )}

      {configError && (
        <div className="clip-link-banner clip-config-banner" role="alert">
          <AlertTriangle size={12} />
          <span>
            {configError.message}
            {configError.keys.length > 0 ? `（键：${configError.keys.join("、")}）` : ""}
            。监听线程仍在运行，但不会记录任何新内容；损坏的原始值已保留，可在设置中修复。
          </span>
          <button className="link-btn" onClick={goSettings}>去修复</button>
        </div>
      )}

      {legacyPaused && (
        <div className="clip-link-banner" role="status">
          <Info size={12} />
          <span>从旧版本升级：为避免未经确认的记录，剪贴板自动采集默认保持暂停，Task Dock 不会自行开始记录。</span>
          <button className="link-btn" onClick={goSettings}>去设置</button>
        </div>
      )}

      {linkTask && (
        <div className="clip-link-banner">
          <Link2 size={12} />
          <span>为任务「{linkTask.title}」选择要关联的条目或分组；关联后抽屉会自动关闭。</span>
          <button className="link-btn" onClick={onClose ?? closeDrawer}>取消</button>
        </div>
      )}

      {!detail && (
        <>
          <div className="clip-toolbar">
            {/* 搜索 + 排序 + 筛选导航属于同一组「查找」操作；窄窗整组换行，
                搜索框仍拿到该行的最大可用宽度。 */}
            <div className="clip-toolbar-query">
              <SearchField
              className="clip-search"
              size="compact"
              inputRef={searchRef}
              value={searchText}
              onChange={setSearchText}
              placeholder="搜索文字、来源应用、文件名…"
              ariaLabel="搜索剪贴板历史"
              clearLabel="清除搜索"
            />
            {section === "items" && (
              <DropdownMenu
                menuLabel="剪贴板排序"
                menuMinWidth={190}
                placement="bottom-start"
                items={SORT_OPTIONS.map((option) => ({
                  key: option.id,
                  label: option.label,
                  description: option.hint,
                  radio: true,
                  checked: sortMode === option.id,
                  onSelect: () => setFilters({ sort: option.id }),
                }))}
                trigger={({ ref, expanded, onClick, onKeyDown }) => (
                  <button
                    ref={ref}
                    type="button"
                    className={`btn sm clip-sort-btn ${expanded ? "is-open" : ""}`}
                    aria-haspopup="menu"
                    aria-expanded={expanded}
                    data-tip="切换「最近记录 / 使用最多」；置顶条目始终优先"
                    onClick={onClick}
                    onKeyDown={onKeyDown}
                  >
                    <ArrowUpDown size={12} aria-hidden="true" />
                    {sortMode === "most_used" ? "使用最多" : "最近记录"}
                  </button>
                )}
              />
            )}
            {isDrawer && (
              // 抽屉没有左侧导航，收藏筛选只能留在工具条；页面态由导航区承担，
              // 不再出现「顶部一个星标 + 侧栏一个仅看收藏」的重复入口。
              <button
                className={`icon-btn sm ${filters.favorite ? "active" : ""}`}
                data-tip={filters.favorite ? "显示全部" : "只看收藏"}
                aria-label={filters.favorite ? "显示全部条目" : "只看收藏"}
                aria-pressed={filters.favorite}
                onClick={() => setFilters({ favorite: !filters.favorite })}
              >
                <Star size={13} />
              </button>
            )}
            {!isDrawer && (
              <button
                type="button"
                className={`icon-btn sm ${filtersOpen ? "active" : ""}`}
                data-tip={filtersOpen ? "收起筛选导航，把宽度让给内容" : "展开筛选导航"}
                aria-label={filtersOpen ? "收起筛选导航" : "展开筛选导航"}
                aria-pressed={filtersOpen}
                aria-controls="clipboard-filter-pane"
                onClick={() => setFiltersOpen((v) => !v)}
              >
                <Filter size={13} aria-hidden="true" />
              </button>
            )}
            </div>
            <div className="clip-toolbar-tools">
              {!isDrawer && (
                <div className="clip-toolbar-group">
                  <div className="clip-density-switch" role="group" aria-label="视图密度">
                {CLIPBOARD_DENSITY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`clip-density-btn ${density === option.value ? "active" : ""}`}
                    aria-pressed={density === option.value}
                    data-tip={option.hint}
                    onClick={() => setDensity(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
                  </div>
                </div>
              )}
              {!isDrawer && <span className="clip-toolbar-divider" aria-hidden="true" />}
              <div className="clip-toolbar-group clip-toolbar-manage">
                <button
              className={`btn sm ${batchMode ? "primary" : ""}`}
              aria-pressed={batchMode}
              aria-label={batchMode ? "退出批量管理" : "进入批量管理"}
              data-tip="显式勾选、全选当前页并批量复制/分组/删除"
              onClick={() => {
                setBatchMode((on) => {
                  if (on) clearSelection();
                  return !on;
                });
              }}
            >
              <ListChecks size={13} aria-hidden="true" /> 批量
            </button>
            <button
              className="btn sm"
              disabled={selectedItems.length === 0 || busy !== null}
              onClick={() => void onAddSelectedToTray()}
              data-tip="把选中的剪贴板内容加入全局工作篮，随后可批量发送到文件工作区"
            >
              {busy === "tray" ? <Loader2 size={13} className="spin" /> : <Archive size={13} aria-hidden="true" />} 加入工作篮
            </button>
            <button
              className="btn sm"
              onClick={goSettings}
              data-tip="在设置中调整保留天数、数量上限、排除应用；立即清理"
            >
              <Eraser size={13} aria-hidden="true" /> 清理规则
            </button>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="clip-page-main">
      <WorkspaceSplit
        id="clipboard"
        sidebarLabel="剪贴板导航"
        sidebar={
          !detail && !isDrawer && filtersOpen ? (
            <div className="clip-filter-pane" id="clipboard-filter-pane">
              <div className="workspace-rail-head">
                <span className="workspace-rail-eyebrow">剪贴板</span>
                <h2>内容导航</h2>
              </div>
              <div className="clip-side-sections" role="tablist" aria-label="剪贴板视图">
                <button
                  role="tab"
                  aria-selected={section === "items"}
                  className={section === "items" ? "active" : ""}
                  onClick={() => {
                    setSection("items");
                    clearSelection();
                  }}
                >
                  <span>历史</span>
                  <em>{view?.total_items ?? 0}</em>
                </button>
                <button
                  role="tab"
                  aria-selected={section === "groups"}
                  className={section === "groups" ? "active" : ""}
                  onClick={() => {
                    setSection("groups");
                    clearSelection();
                  }}
                >
                  <span>分组</span>
                  <em>{view?.groups.length ?? 0}</em>
                </button>
              </div>
              <div className="clip-side-group" role="group" aria-label="类型筛选">
                <span className="clip-side-label">内容类型</span>
                {KIND_CHIPS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    className={`clip-side-type ${filters.kind === k.id ? "active" : ""}`}
                    aria-pressed={filters.kind === k.id}
                    onClick={() => setFilters({ kind: k.id })}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              {section === "items" && (
                <>
                  {/* 高级筛选（时间/来源）可折叠；折叠后侧栏更短，主内容区随
                      WorkspaceSplit 一起拿回宽度。折叠不等于清除：已生效的筛选
                      仍显示数量徽标，避免用户忘记当前范围。 */}
                  <button
                    type="button"
                    className="clip-advanced-toggle"
                    aria-expanded={advancedFiltersOpen}
                    aria-controls="clipboard-advanced-filters"
                    onClick={() => setAdvancedFiltersOpen((v) => !v)}
                  >
                    <span>时间与来源</span>
                    {advancedFilterCount > 0 && (
                      <em>{advancedFilterCount} 项已筛选</em>
                    )}
                    <ChevronDown
                      size={12}
                      className={advancedFiltersOpen ? "is-open" : ""}
                      aria-hidden="true"
                    />
                  </button>
                  {advancedFiltersOpen && (
                    <div id="clipboard-advanced-filters" className="clip-advanced-filters">
                  <div className="clip-side-group" role="group" aria-label="记录时间">
                    <span className="clip-side-label">记录时间</span>
                    {TIME_RANGES.map((range) => (
                      <button
                        key={range.days}
                        type="button"
                        className={`clip-side-type ${(filters.recentDays ?? 0) === range.days ? "active" : ""}`}
                        aria-pressed={(filters.recentDays ?? 0) === range.days}
                        onClick={() => setFilters({ recentDays: range.days || undefined })}
                      >
                        {range.label}
                      </button>
                    ))}
                  </div>
                  <div className="clip-side-group clip-side-source-group" role="group" aria-label="来源应用筛选">
                    <span className="clip-side-label">来源应用</span>
                    <DropdownMenu
                      menuLabel="来源应用筛选"
                      menuMinWidth={220}
                      placement="bottom-start"
                      items={[
                        {
                          key: "__all__",
                          label: "全部来源",
                          description: "不限制来源进程",
                          radio: true,
                          checked: !filters.sourceApp,
                          onSelect: () => setFilters({ sourceApp: undefined }),
                        },
                        ...sourceOptions.map((source) => ({
                          key: source.app,
                          label: `${sourceAppName(source.app)}（${source.count}）`,
                          description: sourceAppName(source.app) !== source.app ? source.app : undefined,
                          radio: true,
                          checked: filters.sourceApp === source.app,
                          onSelect: () => setFilters({ sourceApp: source.app }),
                        })),
                      ]}
                      trigger={({ ref, expanded, onClick, onKeyDown }) => (
                        <button
                          ref={ref}
                          type="button"
                          className={`clip-side-source ${expanded ? "is-open" : ""}`}
                          aria-haspopup="menu"
                          aria-expanded={expanded}
                          title={filters.sourceApp ? sourceAppName(filters.sourceApp) : "全部来源"}
                          onClick={onClick}
                          onKeyDown={onKeyDown}
                        >
                          <span>{filters.sourceApp ? sourceAppName(filters.sourceApp) : "全部来源"}</span>
                          <em>{sourceOptions.length > 0 ? `${sourceOptions.length} 个` : "可选"}</em>
                        </button>
                      )}
                    />
                  </div>
                    </div>
                  )}
                </>
              )}
              <button
                type="button"
                className={`clip-side-favorite ${filters.favorite ? "active" : ""}`}
                aria-pressed={filters.favorite}
                onClick={() => setFilters({ favorite: !filters.favorite })}
              >
                <Star size={12} aria-hidden="true" />
                {filters.favorite ? "仅看收藏（已开启）" : "仅看收藏"}
              </button>
              <button
                type="button"
                className="clip-filter-reset"
                disabled={!canResetFilters}
                onClick={resetFilters}
                data-tip="清除搜索、类型、收藏、来源、时间范围并恢复最近记录排序"
              >
                <RotateCcw size={12} aria-hidden="true" />
                重置筛选
              </button>
              <p className="clip-side-hint">
                {section === "items"
                  ? `当前加载 ${view?.items.length ?? 0} / ${view?.total_items ?? 0} 条`
                  : `当前 ${view?.groups.length ?? 0} 个分组`}
              </p>
            </div>
          ) : null
        }
      >
      <div className="clip-body" ref={scrollRef} onScroll={recordScrollAnchor}>
        {detail?.kind === "item" ? (
          <ClipboardItemDetail
            itemId={detail.id}
            linkTask={linkTask}
            askConfirm={askConfirm}
            onBack={() => setDetail(null)}
            onChanged={() => void load({ silent: true })}
            onSearchHistory={(query) => {
              // 只填入关键词：同时更新搜索框文本与筛选条件，避免防抖回写旧值。
              useClipboardStore.getState().setSearchText(query);
              setFilters({ search: query, kind: "all", favorite: false });
              setSection("items");
              setDetail(null);
            }}
          />
        ) : detail?.kind === "group" ? (
          <ClipboardGroupDetail
            groupId={detail.id}
            linkTask={linkTask}
            askConfirm={askConfirm}
            onBack={() => setDetail(null)}
            onChanged={() => void load({ silent: true })}
          />
        ) : detail?.kind === "paste" ? (
          <PastePanel groupId={detail.id} groupName={detail.name} onBack={() => setDetail(null)} />
        ) : detail?.kind === "paste-items" ? (
          <PastePanel itemIds={detail.ids} onBack={() => setDetail(null)} />
        ) : detail?.kind === "copy-switch" ? (
          <CopySwitchPanel item={detail.item} onBack={() => setDetail(null)} />
        ) : (
          renderList()
        )}
      </div>
      </WorkspaceSplit>
      {!isDrawer && !hasRailHost && localRailWide && !detail && railItem && (
        <aside className="wb-context clip-local-rail" ref={setLocalRailHost} aria-label="所选内容预览" />
      )}
      </div>

      {/* 右栏：所选内容预览。中央列表始终保留；完整详情仍由「详情」按钮进入，
          不改变原有详情页的编辑/跳转能力。
          2026-11-16：64px 缩略图改为 640px 预览规格 + 完整正文 + 文件清单，
          右栏本身可滚动（wb-context），长内容不撑破窗口。 */}
      {!detail && railItem && pageDetailHost && (
        <WorkbenchDetailHostProvider host={pageDetailHost}>
        <WorkbenchPageDetail
          title="所选内容预览"
          actions={
            <div className="clip-rail-actions">
              <button
                type="button"
                className="icon-btn sm"
                data-tip="关闭预览（仅收起右栏，不影响批量选择）"
                aria-label="关闭预览"
                onClick={() => setPreviewId(null)}
              >
                <X size={12} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => setDetail({ kind: "item", id: railItem.id })}
              >
                完整详情
              </button>
            </div>
          }
        >
          <div className="clip-rail-head">
            <span className={`clip-rail-kind kind-${railItem.kind}`}>
              {kindLabel(railItem.kind)}
            </span>
            {railItem.kind === "image" && railItem.image_width && railItem.image_height ? (
              <span className="clip-rail-dim">
                {railItem.image_width} × {railItem.image_height}
              </span>
            ) : null}
            {(railItem.pinned || railItem.favorite) && (
              <span className="clip-rail-flags">
                {railItem.pinned && (
                  <em data-tip="已置顶">
                    <Pin size={11} aria-hidden="true" />
                  </em>
                )}
                {railItem.favorite && (
                  <em className="favorite" data-tip="已收藏">
                    <Star size={11} aria-hidden="true" />
                  </em>
                )}
              </span>
            )}
          </div>
          {railItem.kind === "image" && (
            <div
              className={`clip-rail-hero-media ${
                railItem.image_height && railItem.image_width && railItem.image_height > railItem.image_width * 1.2
                  ? "is-tall"
                  : ""
              }`}
            >
              <ClipboardHeroImage
                itemId={railItem.id}
                hasThumb={railItem.has_thumb}
                enabled
                onOpen={() => openSingleImage(railItem)}
                label="查看原图"
              />
            </div>
          )}
          {railItem.title && <p className="wb-detail-title"><span>{railItem.title}</span></p>}
          {railItem.kind === "text" || railItem.kind === "html" ? (
            <div className="clip-rail-text" role="document">
              {railText || "（无文本内容）"}
            </div>
          ) : (
            railItem.preview &&
            railItem.kind !== "image" && <p className="wb-detail-desc">{railItem.preview}</p>
          )}
          {railItem.file_paths.length > 0 && (
            <div className="clip-rail-files" aria-label="文件清单">
              {railItem.file_paths.slice(0, 6).map((path, index) => {
                const type = fileTypeFromName(path);
                const FileIcon = type.icon;
                return (
                  <div className="clip-rail-file" key={`${path}-${index}`}>
                    <FileIcon
                      size={13}
                      className={`file-tone-${type.tone} clip-file-icon`}
                      aria-hidden="true"
                    />
                    <span className="clip-rail-file-text">
                      <span className="clip-rail-file-name">{fileBaseName(path)}</span>
                      <span className="clip-rail-file-meta">{type.label}</span>
                      <span className="clip-rail-file-path" data-tip={path}>{fileDirName(path)}</span>
                    </span>
                  </div>
                );
              })}
              {railItem.file_paths.length > 6 && (
                <div className="clip-rail-file-more">
                  还有 {railItem.file_paths.length - 6} 个文件
                </div>
              )}
              <p className="clip-side-hint">仅记录路径，删除历史不会删除本地文件。</p>
            </div>
          )}
          <WorkbenchDetailFacts
            rows={[
              {
                label: "来源",
                value: railSource
                  ? `${railSource.app}${railSource.window ? ` · ${railSource.window}` : ""}`
                  : railItem.source_title || "未知来源",
              },
              { label: "类型", value: kindLabel(railItem.kind) },
              ...(railItem.kind === "image" && railItem.image_width && railItem.image_height
                ? [{ label: "分辨率", value: `${railItem.image_width} × ${railItem.image_height}` }]
                : []),
              { label: "内容大小", value: formatBytes(railItem.byte_size) },
              { label: "记录时间", value: clipboardTime(railItem.last_seen_at) },
              { label: "使用次数", value: `${railItem.copy_count}` },
              {
                label: "整理状态",
                value: [
                  railItem.pinned ? "已置顶" : null,
                  railItem.favorite ? "已收藏" : null,
                ].filter(Boolean).join(" · ") || "未整理",
              },
            ]}
          />
          <div className="wb-detail-actions">
            <button type="button" className="btn sm primary" onClick={() => void onCopyItem(railItem)}>
              <Copy size={11} aria-hidden="true" /> 复制
            </button>
            {railItem.kind === "image" && (
              <button
                type="button"
                className="btn sm"
                onClick={() => openSingleImage(railItem)}
                data-tip="在灯箱中查看原图"
              >
                查看原图
              </button>
            )}
            {railItem.kind === "url" && (
              <button
                type="button"
                className="btn sm"
                onClick={() => void onOpenUrlItem(railItem)}
                data-tip="用系统默认浏览器打开"
              >
                在浏览器打开
              </button>
            )}
            {railItem.file_paths.length > 0 && (
              <button
                type="button"
                className="btn sm"
                onClick={() => void onRevealLocalFile(railItem.file_paths[0])}
                data-tip="在资源管理器中定位第一个文件"
              >
                定位文件
              </button>
            )}
          </div>
        </WorkbenchPageDetail>
        </WorkbenchDetailHostProvider>
      )}

      {!detail && section === "items" && batchMode && selectedItems.length === 0 && (
        <div className="clip-selectbar clip-batchbar">
          <span>批量管理：勾选条目后复制、分组或删除</span>
          <button
            className="btn sm"
            disabled={!view || view.items.length === 0}
            onClick={() => {
              for (const item of view?.items ?? []) {
                if (!selectedItems.includes(item.id)) toggleItemSelection(item.id);
              }
            }}
          >
            <ListChecks size={11} aria-hidden="true" /> 全选当前页
          </button>
          <button
            className="icon-btn sm"
            onClick={() => {
              setBatchMode(false);
              clearSelection();
            }}
            data-tip="退出批量管理"
            aria-label="退出批量管理"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {!detail && section === "items" && selectedItems.length > 0 && (
        <div className="clip-selectbar">
          <span>{selectedItems.length} 项已选</span>
          <button
            className="btn sm primary"
            onClick={() => void onCopySelectedItems("rich")}
            disabled={busy !== null}
            data-tip="按选择顺序整合文字与图片，写入富文本"
          >
            {busy === "copy-selected-rich" ? <RefreshCw size={11} className="spin" /> : <Copy size={11} />} 复制所选
          </button>
          <button
            className="btn sm"
            onClick={() => void onCopySelectedItems("files")}
            disabled={busy !== null || !selectedHasFiles}
            data-tip={
              !selectedHasFiles
                ? "所选内容没有图片或文件；请使用「复制所选」复制文字"
                : "把所选文件/图片作为文件列表复制；普通文字不包含在内"
            }
          >
            {busy === "copy-selected-files" ? <RefreshCw size={11} className="spin" /> : <Copy size={11} />} 复制为文件
          </button>
          <button
            className="btn sm"
            onClick={() => setDetail({ kind: "paste-items", ids: selectedItems })}
            disabled={busy !== null}
            data-tip="选择目标窗口后按顺序逐条粘贴"
          >
            <Play size={11} /> 逐项粘贴
          </button>
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="新分组名称"
            aria-label="新分组名称"
            maxLength={80}
          />
          <button className="btn sm primary" onClick={onCreateGroup} disabled={busy !== null}>
            {busy === "create-group" ? <RefreshCw size={11} className="spin" /> : <FolderPlus size={11} />} 创建分组
          </button>
          <button className="btn sm danger" onClick={onDeleteSelectedItems} disabled={busy !== null}>
            <Trash2 size={11} /> 删除所选
          </button>
          <button className="icon-btn sm" onClick={clearSelection} data-tip="取消选择" aria-label="取消选择">
            <X size={12} />
          </button>
        </div>
      )}

      {!detail && section === "groups" && selectedGroups.length > 0 && (
        <div className="clip-selectbar">
          <span>{selectedGroups.length} 个分组已选</span>
          <input
            value={mergeName}
            onChange={(e) => setMergeName(e.target.value)}
            placeholder="合并后的分组名称"
            aria-label="合并后的分组名称"
            maxLength={80}
          />
          <button
            className="btn sm primary"
            onClick={onMergeGroups}
            disabled={selectedGroups.length < 2 || busy !== null}
            data-tip={selectedGroups.length < 2 ? "至少选择两个分组" : "按选择顺序合并"}
          >
            {busy === "merge" ? <RefreshCw size={11} className="spin" /> : <Merge size={11} />} 合并
          </button>
          <button className="icon-btn sm" onClick={clearSelection} data-tip="取消选择" aria-label="取消选择">
            <X size={12} />
          </button>
        </div>
      )}

      <footer className="clip-foot">
        <span className={`clip-status tone-${statusTone}`}><i />{statusLabel}</span>
        <span>{stats?.items ?? 0} 条 · {stats?.groups ?? 0} 组</span>
        <span>图片缓存 {formatBytes(stats?.asset_bytes ?? 0)}</span>
        <div className="clip-foot-actions">
          <button
            className="link-btn clip-clear-btn"
            onClick={onClearHistory}
            disabled={historyCount === 0 || busy === "clear-history" || loading}
            data-tip={historyCount === 0 ? "没有可清空的剪贴板历史" : "删除全部历史、分组与内部图片缓存"}
            aria-label="清空剪贴板历史"
          >
            {busy === "clear-history"
              ? <RefreshCw size={11} className="spin" />
              : <Trash2 size={11} />} 清空历史
          </button>
          <button className="link-btn" onClick={goSettings}>
            <SettingsIcon size={11} /> 剪贴板设置
          </button>
        </div>
      </footer>
    </>
  );

  return (
    <>
      {isDrawer ? (
        <div className={`clipboard-layer${linkTask ? " link-mode" : ""}`}>
          <div className="clipboard-scrim" aria-hidden onMouseDown={onClose ?? closeDrawer} />
          <section
            className="clipboard-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="智能剪贴板"
            ref={drawerRef}
            tabIndex={-1}
          >
            {body}
          </section>
        </div>
      ) : (
        <div className="clipboard-page" role="region" aria-label="智能剪贴板" ref={pageRef}>
          {body}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        detail={confirm?.detail}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onCancel={() => {
          confirmAnchor.current = null;
          setConfirm(null);
        }}
        onConfirm={() => {
          const run = confirm?.run;
          setConfirm(null);
          if (run) Promise.resolve(run()).catch((e) => showToast(`操作失败：${errorMessage(e)}`, { kind: "error" }));
        }}
      />

      {preview && previewItem && (
        <ImageLightbox
          item={previewItem}
          items={preview.mode === "group" ? preview.items : undefined}
          total={preview.mode === "group" ? preview.total : undefined}
          sequenceReady={preview.mode === "group" ? preview.ready : true}
          listLoading={preview.mode === "group" && preview.loading}
          listError={preview.mode === "group" ? preview.error ?? undefined : undefined}
          onNeedMore={preview.mode === "group" ? onPreviewNeedMore : undefined}
          askConfirm={askConfirm}
          onClose={closePreview}
        />
      )}
    </>
  );
}
