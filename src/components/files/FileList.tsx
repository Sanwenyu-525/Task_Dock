//! 文件列表/网格（虚拟化渲染 + 选择 + 缩略图占位）。
//!
//! 大目录红线（任务规范 §10）：数千条目不一次性建 DOM——窗口化渲染，
//! 列表行高固定 26px，网格按列数分行虚拟化；缩略图客户端并发 ≤3、缓存有界。
//! 排序/筛选在内存完成（≤8000 条，JS 排序远低于交互阈值），不重复请求后端。

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import type { FsEntry } from "../../lib/bridge";
import { fileVisual, formatModified, formatSize, toneVar } from "../../lib/filesWorkspace/fileMeta";
import { basename, joinPath } from "../../lib/filesWorkspace/pathUtils";
import {
  autoScrollVelocity,
  marqueeHitTest,
  normalizeMarqueeRect,
  toMarqueeContentPoint,
  type MarqueeBodyRect,
  type MarqueeGeometry,
} from "../../lib/filesWorkspace/marqueeSelection";
import { getFwDragState, subscribeFwDrag } from "../../lib/filesWorkspace/interactions";
import { filterTransferablePaths } from "../../lib/filesWorkspace/transfer";
import { useLocale } from "../../hooks/useLocale";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";

const LIST_ROW_H = 26;
/** 吸顶表头高度（与 .fw-list-head CSS 高度一致；虚拟化 headOffset 按此计入）。 */
const LIST_HEAD_H = 26;
const GRID_CELL_W = 104;
const GRID_CELL_H = 116;
const GRID_GAP = 8;
/** 鼠标移动超过该距离才从「空白点击」升级为框选，避免手抖误清空/误选。 */
const MARQUEE_THRESHOLD_PX = 5;
const MARQUEE_AUTO_SCROLL_MAX = 14;
const MARQUEE_AUTO_SCROLL_EDGE = 44;

function scheduleFrame(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === "function") return window.requestAnimationFrame(callback);
  return window.setTimeout(() => callback(Date.now()), 16);
}

function cancelFrame(id: number): void {
  if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(id);
  else window.clearTimeout(id);
}

interface MarqueeSession {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  started: boolean;
  lastClientX: number;
  lastClientY: number;
  lastPathsKey: string;
  moveFrame: number | null;
  autoFrame: number | null;
}

interface MarqueeViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type ListViewMode = "list" | "grid";

// ── 缩略图（客户端并发 ≤3 + 有界缓存）─────────────────────────────────

const thumbCache = new Map<string, string | null>();
const THUMB_CACHE_MAX = 300;
/** 队列上限：快速滚动万级网格时丢弃最旧的未执行任务（未发起 IPC，丢弃安全）。 */
const THUMB_QUEUE_MAX = 500;
let thumbInflight = 0;
const thumbQueue: Array<() => void> = [];

function pumpThumbQueue(): void {
  while (thumbInflight < 3 && thumbQueue.length) {
    const job = thumbQueue.shift();
    if (!job) return;
    thumbInflight += 1;
    void job();
  }
}

// ── 滚动位置会话缓存（会话内内存，不落库）───────────────────────────────
// 归属键 = 稳定标签 tabId：分栏交换、双栏↔四宫格、最大化/恢复导致窗格重挂载后，
// 同一标签的浏览位置不丢；两个标签打开同一路径时位置互不覆盖。拿不到标签上下文
// （孤立挂载/测试）时退回目录路径兜底。缓存有界 LRU，活跃标签受保护不被驱逐。

interface ScrollEntry {
  /** 视口内首个可见条目的文件名（锚点文件）；空目录为空串。 */
  anchorName: string;
  /** 锚点行相对视口顶部的像素偏移（含吸顶表头之外的半行/滚过距离）。 */
  anchorOffset: number;
  viewMode: ListViewMode;
  seq: number;
}

const scrollCache = new Map<string, ScrollEntry>();
const SCROLL_CACHE_MAX = 200;
/** 当前挂载中的会话键：LRU 驱逐不得淘汰正在浏览的标签。 */
const activeSessions = new Set<string>();
let scrollSeq = 0;

/**
 * 锚点索引：优先精确同名；锚点文件被删除/过滤时返回按名称排序的最近邻插入位，
 * 保持浏览上下文，而不是按旧像素位置落到完全不相干的条目上。
 */
function findAnchorIndex(entries: FsEntry[], anchorName: string): number {
  if (!entries.length) return -1;
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].name.localeCompare(anchorName, "zh-CN", { numeric: true }) < 0) lo = mid + 1;
    else hi = mid;
  }
  if (lo < entries.length && entries[lo].name === anchorName) return lo;
  if (lo <= 0) return 0;
  if (lo >= entries.length) return entries.length - 1;
  return lo;
}

function resolveSessionKey(
  el: HTMLElement | null,
  fallbackPath: string,
  prop?: string,
): string {
  if (prop) return `tab:${prop}`;
  const paneEl = el?.closest?.("[data-fw-pane-id]");
  if (paneEl) {
    const paneId = paneEl.getAttribute("data-fw-pane-id");
    const pane = paneId ? useFilesWorkspaceStore.getState().panes[paneId] : undefined;
    const tabId = pane?.tabs.find((t) => t.tabId === pane.activeTabId)?.tabId;
    if (tabId) return `tab:${tabId}`;
  }
  return `path:${fallbackPath}`;
}

function rememberScroll(key: string, entry: Omit<ScrollEntry, "seq">): void {
  if (!Number.isFinite(entry.anchorOffset)) return;
  scrollCache.set(key, { ...entry, seq: ++scrollSeq });
  if (scrollCache.size > SCROLL_CACHE_MAX) {
    // 优先淘汰非活跃会话中最久未访问者；活跃标签位置受保护，不被容量回收丢掉。
    let oldest: string | undefined;
    let oldestSeq = Number.POSITIVE_INFINITY;
    for (const [k, entry] of scrollCache) {
      if (activeSessions.has(k)) continue;
      if (entry.seq < oldestSeq) {
        oldestSeq = entry.seq;
        oldest = k;
      }
    }
    if (oldest === undefined) oldest = scrollCache.keys().next().value;
    if (oldest !== undefined) scrollCache.delete(oldest);
  }
}

/** 标签关闭/移出后由面板层调用：释放已不在任何窗格或收纳中的会话缓存。 */
export function pruneScrollSessions(liveTabIds: ReadonlySet<string>): void {
  for (const key of scrollCache.keys()) {
    if (!key.startsWith("tab:")) continue;
    if (!liveTabIds.has(key.slice("tab:".length))) scrollCache.delete(key);
  }
}

/** 测试用：清空会话缓存与活跃登记。 */
export function __resetScrollCache(): void {
  scrollCache.clear();
  activeSessions.clear();
}

/** 测试用：暴露缓存内部句柄，验证 LRU 有界与活跃保护（不进入产品 API）。 */
export const __scrollCacheForTest = {
  remember: rememberScroll,
  cache: scrollCache,
  active: activeSessions,
  max: SCROLL_CACHE_MAX,
};

/** category 属于可出缩略图的类型（图片/视频）；失败回落图标。 */
function thumbCapable(category: string): boolean {
  return category === "image" || category === "video";
}

function loadThumb(
  path: string,
  onLoad: (dataUrl: string | null) => void,
): () => void {
  let cancelled = false;
  const cached = thumbCache.get(path);
  if (cached !== undefined) {
    onLoad(cached);
    return () => {};
  }
  const job = () => {
    import("../../lib/bridge")
      .then(({ fsThumbnail }) => fsThumbnail(path, 96))
      .then((dataUrl) => {
        if (cancelled) return;
        if (thumbCache.size >= THUMB_CACHE_MAX) {
          const oldest = thumbCache.keys().next().value;
          if (oldest !== undefined) thumbCache.delete(oldest);
        }
        thumbCache.set(path, dataUrl);
        onLoad(dataUrl);
      })
      .catch(() => {
        if (!cancelled) onLoad(null);
      })
      .finally(() => {
        thumbInflight -= 1;
        pumpThumbQueue();
      });
  };
  thumbQueue.push(job);
  // 队列超限：丢弃最旧的未执行任务（禁积压；已执行任务由 cancelled 标志兜底）。
  while (thumbQueue.length > THUMB_QUEUE_MAX) {
    thumbQueue.shift();
  }
  pumpThumbQueue();
  return () => {
    cancelled = true;
  };
}

// ── 虚拟化范围计算 ──────────────────────────────────────────────────────

function useScrollRange(
  containerRef: React.RefObject<HTMLElement | null>,
  itemHeight: number,
  count: number,
  headOffset = 0,
): { start: number; end: number; viewportH: number } {
  const [range, setRange] = useState({ start: 0, end: 40, viewportH: 480 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const viewportH = Math.max(el.clientHeight, 120);
      // 吸顶表头占去顶部 headOffset 高度：可见行范围按「表头之下」的滚动偏移换算。
      const visibleTop = Math.max(0, el.scrollTop - headOffset);
      const start = Math.max(0, Math.floor(visibleTop / itemHeight) - 4);
      const end = Math.min(count, Math.ceil((visibleTop + viewportH) / itemHeight) + 4);
      setRange({ start, end, viewportH });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [containerRef, itemHeight, count, headOffset]);
  return range;
}

// ── 行/单元格 ───────────────────────────────────────────────────────────

interface EntryRowProps {
  entry: FsEntry;
  path: string;
  selected: boolean;
  active: boolean;
  isDropTarget: boolean;
  dropLabel?: string;
  index: number;
  thumbnails: boolean;
  onPointerDown: (e: React.PointerEvent, entry: FsEntry, index: number) => void;
  onDoubleClick: (entry: FsEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
}

const ListRow = memo(function ListRow({
  entry,
  path,
  selected,
  active,
  isDropTarget,
  dropLabel,
  index,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
}: EntryRowProps) {
  const visual = fileVisual(entry.category);
  const Icon = visual.icon;
  return (
    <div
      className={`fw-row${selected ? " is-selected" : ""}${active ? " is-active" : ""}${isDropTarget ? " is-drop-folder" : ""}`}
      style={{ height: LIST_ROW_H }}
      data-fw-path={path}
      data-fw-kind={entry.kind}
      role="option"
      aria-selected={selected}
      onPointerDown={(e) => onPointerDown(e, entry, index)}
      onDoubleClick={() => onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
    >
      <span className="fw-row-icon" aria-hidden="true" style={{ color: toneVar(visual.tone) }}>
        <Icon size={15} strokeWidth={1.6} />
      </span>
      <span className="fw-row-name" title={entry.name}>
        {entry.name}
      </span>
      {isDropTarget && dropLabel ? (
        <span className="fw-row-drop-hint" title={path}>{dropLabel}</span>
      ) : null}
      <span className="fw-row-time">{formatModified(entry.modifiedMs)}</span>
      <span className="fw-row-size">{entry.kind === "dir" ? "—" : formatSize(entry.size)}</span>
      <span className="fw-row-type">{entry.kind === "dir" ? "文件夹" : entry.ext ? entry.ext.toUpperCase() : "文件"}</span>
    </div>
  );
});

const GridCell = memo(function GridCell({
  entry,
  path,
  selected,
  active,
  isDropTarget,
  dropLabel,
  index,
  thumbnails,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
}: EntryRowProps) {
  const visual = fileVisual(entry.category);
  const Icon = visual.icon;
  const [thumb, setThumb] = useState<string | null>(
    thumbnails && thumbCapable(entry.category) ? (thumbCache.get(path) ?? null) : null,
  );
  useEffect(() => {
    if (!thumbnails || !thumbCapable(entry.category)) return;
    return loadThumb(path, setThumb);
  }, [thumbnails, path, entry.category]);
  return (
    <div
      className={`fw-cell${selected ? " is-selected" : ""}${active ? " is-active" : ""}${isDropTarget ? " is-drop-folder" : ""}`}
      style={{ width: GRID_CELL_W, height: GRID_CELL_H }}
      data-fw-path={path}
      data-fw-kind={entry.kind}
      role="option"
      aria-selected={selected}
      onPointerDown={(e) => onPointerDown(e, entry, index)}
      onDoubleClick={() => onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
    >
      <span className="fw-cell-thumb" aria-hidden="true">
        {thumb ? (
          <img src={thumb} alt="" draggable={false} loading="lazy" />
        ) : (
          <Icon size={34} strokeWidth={1.4} style={{ color: toneVar(visual.tone) }} />
        )}
      </span>
      <span className="fw-cell-name" title={entry.name}>
        {entry.name}
      </span>
      {isDropTarget && dropLabel ? (
        <span className="fw-cell-drop-hint" title={path}>{dropLabel}</span>
      ) : null}
    </div>
  );
});

// ── 列表主体 ────────────────────────────────────────────────────────────

export interface FileListProps {
  entries: FsEntry[];
  dirPath: string;
  viewMode: "list" | "grid";
  /**
   * 稳定会话标识（标签 tabId）。显式传入时滚动缓存按它归属；缺省时组件从最近的
   * `[data-fw-pane-id]` 窗格反查活动标签，再退回目录路径兜底。
   */
  sessionKey?: string;
  selectedPaths: ReadonlySet<string>;
  activePath: string | null;
  dropTargetPath: string | null;
  thumbnails: boolean;
  onEntryPointerDown: (e: React.PointerEvent, entry: FsEntry, index: number) => void;
  onEntryActivate: (entry: FsEntry) => void;
  onEntryContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  onBodyPointerDown: (e: React.PointerEvent) => void;
  onBodyContextMenu: (e: React.MouseEvent) => void;
  /**
   * 框选阶段回调。`start` 表示阈值已达、基准集合应由 FilePane 记录；
   * `preview` 每次候选实际变化时调用；`commit` 在 pointerup 提交；`cancel` 恢复基准。
   * 不传时禁用框选（布局编辑模式/回收站等）。
   */
  onMarqueeChange?: (payload: {
    phase: "start" | "preview" | "commit" | "cancel";
    paths: string[];
    ctrlKey: boolean;
    shiftKey: boolean;
  }) => void;
  /** 空白处普通点击（未形成框选）时清空选择，由 FilePane 处理。 */
  onBlankClick?: () => void;
  /** 网格列数变化时同步给键盘导航使用。 */
  onGridColsChange?: (cols: number) => void;
  marqueeEnabled?: boolean;
  children?: ReactNode;
}

export default function FileList({
  entries,
  dirPath,
  viewMode,
  sessionKey,
  selectedPaths,
  activePath,
  dropTargetPath,
  thumbnails,
  onEntryPointerDown,
  onEntryActivate,
  onEntryContextMenu,
  onBodyPointerDown,
  onBodyContextMenu,
  onMarqueeChange,
  onBlankClick,
  onGridColsChange,
  marqueeEnabled = true,
  children,
}: FileListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);
  const marqueeRef = useRef<MarqueeSession | null>(null);
  const [marqueeView, setMarqueeView] = useState<MarqueeViewportRect | null>(null);
  /** 网格列数测量完成前不恢复锚点：初始列数只是占位，按错误列数换算会落到错误行。 */
  const [geometryReady, setGeometryReady] = useState(false);
  /** 已恢复过位置的会话键：目录刷新重渲染时不重复回写滚动条，避免打断用户滚动。 */
  const restoredRef = useRef<string | null>(null);
  const { t } = useLocale();
  const [dragState, setDragState] = useState(() => getFwDragState());

  // 只在目录行成为落点后订阅；标签随 Ctrl/Shift/真实卷判定即时刷新。
  useEffect(() => {
    if (!dropTargetPath) return;
    setDragState(getFwDragState());
    return subscribeFwDrag(setDragState);
  }, [dropTargetPath]);

  const dropLabel = useMemo(() => {
    if (!dropTargetPath || dragState.payload?.kind !== "files") return undefined;
    const accepted = filterTransferablePaths(dragState.payload.paths, dropTargetPath);
    const target = basename(dropTargetPath) || dropTargetPath;
    if (!accepted.length) return t("fw.drag.folderInvalid", { target });
    return dragState.effect === "copy"
      ? t("fw.drag.folderCopy", { count: accepted.length, target })
      : t("fw.drag.folderMove", { count: accepted.length, target });
  }, [dropTargetPath, dragState, t]);

  // 网格按容器宽度计算列数（分栏宽度变化自适应）。
  useEffect(() => {
    setGeometryReady(false);
    const el = containerRef.current;
    if (!el || viewMode !== "grid") {
      setGeometryReady(true);
      onGridColsChange?.(1);
      return;
    }
    const measure = () => {
      const inner = el.clientWidth - 8;
      const per = Math.max(2, Math.floor((inner + GRID_GAP) / (GRID_CELL_W + GRID_GAP)));
      setCols(per);
      onGridColsChange?.(per);
      setGeometryReady(true);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode, onGridColsChange]);

  const gridCols = Math.max(1, cols);
  const rowCount = viewMode === "list" ? entries.length : Math.ceil(entries.length / gridCols);
  const rowH = viewMode === "list" ? LIST_ROW_H : GRID_CELL_H + GRID_GAP;
  // 吸顶表头占去顶部 LIST_HEAD_H：可见行范围按「表头之下」的滚动偏移换算。
  const headOffset = viewMode === "list" ? LIST_HEAD_H : 0;
  const { start, end } = useScrollRange(containerRef, rowH, rowCount, headOffset);

  // 重挂载（布局切换/分栏重排/最大化恢复）后按「锚点文件 + 视口内偏移」恢复：
  // 中间条目增删/重排不再依赖首末签名，不会恢复错位置；锚点消失时落到名称最近邻。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const key = resolveSessionKey(el, dirPath, sessionKey);
    activeSessions.add(key);
    const saved = scrollCache.get(key);
    if (saved && saved.viewMode === viewMode && saved.anchorName && entries.length) {
      if (restoredRef.current !== key && (viewMode === "list" || geometryReady)) {
        const index = findAnchorIndex(entries, saved.anchorName);
        const row = viewMode === "list" ? index : Math.floor(index / gridCols);
        const maxScroll = Math.max(0, rowCount * rowH - el.clientHeight);
        const target = Math.max(0, row) * rowH + saved.anchorOffset;
        el.scrollTop = Math.min(maxScroll, Math.max(0, target));
        restoredRef.current = key;
      }
    }
    const onScroll = () => {
      if (!entries.length) return;
      const visibleTop = Math.max(0, el.scrollTop - headOffset);
      const row = Math.floor(visibleTop / rowH);
      const index = viewMode === "list" ? row : row * gridCols;
      const anchor = entries[Math.min(Math.max(index, 0), entries.length - 1)];
      rememberScroll(key, {
        anchorName: anchor?.name ?? "",
        // 相对滚动容器顶部的绝对偏移：包含吸顶表头占位，恢复时无需再加 headOffset。
        anchorOffset: el.scrollTop - row * rowH,
        viewMode,
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      activeSessions.delete(key);
    };
  }, [dirPath, viewMode, sessionKey, entries, rowCount, rowH, headOffset, gridCols, geometryReady]);

  // ── 矩形框选（空白区按下；与行上的文件选择/拖拽互斥）────────────────
  // 只把指针坐标按虚拟几何换算为候选路径，不查询当前 DOM 的 .fw-row；
  // 因此滚出视口的行、25000 项目录和网格都能得到一致结果。
  const entriesRef = useRef(entries);
  const colsRef = useRef(gridCols);
  const marqueeCallbacksRef = useRef({ onMarqueeChange, onBlankClick });
  entriesRef.current = entries;
  colsRef.current = gridCols;
  marqueeCallbacksRef.current = { onMarqueeChange, onBlankClick };
  const stopMarqueeRef = useRef<((cancel: boolean) => void) | null>(null);

  useEffect(() => {
    return () => stopMarqueeRef.current?.(true);
  }, []);

  const marqueeGeometry = (el: HTMLElement): MarqueeGeometry => ({
    viewMode: viewMode === "grid" ? "grid" : "list",
    rowHeight: rowH,
    gridCols: Math.max(1, colsRef.current),
    gridCellWidth: GRID_CELL_W,
    gridCellHeight: GRID_CELL_H,
    gridGap: GRID_GAP,
    gridPaddingX: 4,
    bodyWidth: Math.max(0, el.clientWidth),
  });

  const marqueeBodyRect = (el: HTMLElement): MarqueeBodyRect => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: Math.max(0, el.clientWidth || rect.width),
      height: Math.max(0, el.clientHeight || rect.height),
    };
  };

  const marqueePaths = (
    session: MarqueeSession,
    clientX: number,
    clientY: number,
  ): { paths: string[]; view: MarqueeViewportRect | null } => {
    const el = containerRef.current;
    if (!el) return { paths: [], view: null };
    const body = marqueeBodyRect(el);
    const head = viewMode === "list" ? LIST_HEAD_H : 0;
    const topBound = body.top + head;
    const bottomBound = body.top + body.height;
    const rightBound = body.left + body.width;
    // 指针只在内容区（表头之下、滚动条之外）参与几何计算；视觉矩形同样钳制。
    const x = Math.min(Math.max(clientX, body.left), rightBound);
    const y = Math.min(Math.max(clientY, topBound), bottomBound);
    const start = toMarqueeContentPoint(
      session.startClientX,
      session.startClientY,
      body,
      el.scrollTop,
      head,
    );
    const current = toMarqueeContentPoint(x, y, body, el.scrollTop, head);
    const contentRect = normalizeMarqueeRect(start.x, start.y, current.x, current.y);
    const hits = marqueeHitTest(entriesRef.current, dirPath, contentRect, marqueeGeometry(el));
    const view: MarqueeViewportRect = {
      left: Math.min(session.startClientX, x),
      top: Math.min(session.startClientY, y),
      width: Math.abs(x - session.startClientX),
      height: Math.abs(y - session.startClientY),
    };
    return { paths: hits, view };
  };

  const updateMarquee = (session: MarqueeSession, commit = false): string[] => {
    if (marqueeRef.current !== session) return [];
    const next = marqueePaths(session, session.lastClientX, session.lastClientY);
    setMarqueeView(next.view);
    const key = next.paths.join("\u0000");
    if (commit || key !== session.lastPathsKey) {
      session.lastPathsKey = key;
      marqueeCallbacksRef.current.onMarqueeChange?.({
        phase: commit ? "commit" : "preview",
        paths: next.paths,
        ctrlKey: session.ctrlKey,
        shiftKey: session.shiftKey,
      });
    }
    return next.paths;
  };

  const stopMarquee = (session: MarqueeSession, cancel: boolean): void => {
    if (marqueeRef.current !== session) return;
    marqueeRef.current = null;
    if (session.moveFrame !== null) {
      cancelFrame(session.moveFrame);
      session.moveFrame = null;
    }
    if (session.autoFrame !== null) {
      cancelFrame(session.autoFrame);
      session.autoFrame = null;
    }
    const el = containerRef.current;
    try {
      if (el?.hasPointerCapture?.(session.pointerId)) el.releasePointerCapture(session.pointerId);
    } catch {
      /* pointer capture 已由系统释放（PointerCancel） */
    }
    if (cancel && session.started) {
      marqueeCallbacksRef.current.onMarqueeChange?.({
        phase: "cancel",
        paths: [],
        ctrlKey: session.ctrlKey,
        shiftKey: session.shiftKey,
      });
    }
    setMarqueeView(null);
    if (stopMarqueeRef.current) stopMarqueeRef.current = null;
  };

  const startAutoScroll = (session: MarqueeSession): void => {
    if (session.autoFrame !== null) return;
    const tick = () => {
      if (marqueeRef.current !== session) {
        session.autoFrame = null;
        return;
      }
      const el = containerRef.current;
      if (!el) {
        session.autoFrame = null;
        return;
      }
      const body = marqueeBodyRect(el);
      const top = body.top + (viewMode === "list" ? LIST_HEAD_H : 0);
      const bottom = body.top + body.height;
      const step = autoScrollVelocity(session.lastClientY, top, bottom, {
        edge: MARQUEE_AUTO_SCROLL_EDGE,
        maxSpeed: MARQUEE_AUTO_SCROLL_MAX,
      });
      if (step !== 0) {
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        const before = el.scrollTop;
        el.scrollTop = Math.min(maxScroll, Math.max(0, before + step));
        if (el.scrollTop !== before) updateMarquee(session);
      }
      session.autoFrame = scheduleFrame(tick);
    };
    session.autoFrame = scheduleFrame(tick);
  };

  const handleBodyPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    onBodyPointerDown(e);
    if (!marqueeEnabled || !marqueeCallbacksRef.current.onMarqueeChange) return;
    if (marqueeRef.current) return;
    if (e.button !== 0 || e.pointerType === "touch") return;
    const el = containerRef.current;
    if (!el) return;
    const target = e.target as HTMLElement;
    // 行/表头/工具按钮/滚动条不启动框选；行上的按下继续走 FilePane 的
    // 文件选择或文件拖拽候选，两个手势从命中目标起即互斥。
    if (target.closest("[data-fw-path], .fw-list-head, button, a, input, textarea, select, [data-fw-no-marquee]")) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const xInBody = e.clientX - rect.left;
    const yInBody = e.clientY - rect.top;
    if (xInBody < 0 || yInBody < 0 || xInBody > el.clientWidth || yInBody > el.clientHeight) return;
    if (yInBody < (viewMode === "list" ? LIST_HEAD_H : 0)) return;

    e.preventDefault();
    const session: MarqueeSession = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      ctrlKey: e.ctrlKey || e.metaKey,
      shiftKey: e.shiftKey,
      started: false,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      lastPathsKey: "",
      moveFrame: null,
      autoFrame: null,
    };
    marqueeRef.current = session;
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      /* 某些合成事件没有可捕获指针；窗口监听仍可完成框选 */
    }

    const onMove = (event: PointerEvent) => {
      if (marqueeRef.current !== session || event.pointerId !== session.pointerId) return;
      session.lastClientX = event.clientX;
      session.lastClientY = event.clientY;
      if (!session.started) {
        if (
          Math.hypot(
            session.lastClientX - session.startClientX,
            session.lastClientY - session.startClientY,
          ) < MARQUEE_THRESHOLD_PX
        ) {
          return;
        }
        session.started = true;
        marqueeCallbacksRef.current.onMarqueeChange?.({
          phase: "start",
          paths: [],
          ctrlKey: session.ctrlKey,
          shiftKey: session.shiftKey,
        });
        startAutoScroll(session);
      }
      if (session.moveFrame === null) {
        session.moveFrame = scheduleFrame(() => {
          session.moveFrame = null;
          if (marqueeRef.current === session) updateMarquee(session);
        });
      }
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== session.pointerId) return;
      session.lastClientX = event.clientX;
      session.lastClientY = event.clientY;
      if (session.started) {
        updateMarquee(session, true);
      } else {
        marqueeCallbacksRef.current.onBlankClick?.();
      }
      cleanup(false);
    };

    const onCancel = (event: PointerEvent) => {
      if (event.pointerId !== session.pointerId) return;
      cleanup(true);
    };

    const onBlur = () => cleanup(true);

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || marqueeRef.current !== session) return;
      // 捕获阶段截断：Escape 只取消本次框选并恢复基准选择，不再让面板清空选择。
      event.preventDefault();
      event.stopPropagation();
      cleanup(true);
    };

    const cleanup = (cancel: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey, true);
      stopMarquee(session, cancel);
    };
    stopMarqueeRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey, true);
  };

  const renderRow = (rowIndex: number): ReactNode => {
    if (viewMode === "list") {
      const entry = entries[rowIndex];
      if (!entry) return null;
      const path = joinPath(dirPath, entry.name);
      return (
        <ListRow
          key={entry.name}
          entry={entry}
          path={path}
          index={rowIndex}
          selected={selectedPaths.has(path)}
          active={activePath === path}
          isDropTarget={dropTargetPath === path && entry.kind === "dir"}
          dropLabel={dropTargetPath === path ? dropLabel : undefined}
          thumbnails={thumbnails}
          onPointerDown={onEntryPointerDown}
          onDoubleClick={onEntryActivate}
          onContextMenu={onEntryContextMenu}
        />
      );
    }
    const slice = entries.slice(rowIndex * cols, rowIndex * cols + cols);
    return (
      <div key={rowIndex} className="fw-grid-row" style={{ height: GRID_CELL_H, gap: GRID_GAP }}>
        {slice.map((entry, i) => {
          const path = joinPath(dirPath, entry.name);
          return (
            <GridCell
              key={entry.name}
              entry={entry}
              path={path}
              index={rowIndex * cols + i}
              selected={selectedPaths.has(path)}
              active={activePath === path}
              isDropTarget={dropTargetPath === path && entry.kind === "dir"}
              dropLabel={dropTargetPath === path ? dropLabel : undefined}
              thumbnails={thumbnails}
              onPointerDown={onEntryPointerDown}
              onDoubleClick={onEntryActivate}
              onContextMenu={onEntryContextMenu}
            />
          );
        })}
      </div>
    );
  };

  const innerStyle: CSSProperties = {
    height: rowCount * rowH,
    position: "relative",
  };
  const offsetStyle: CSSProperties = {
    position: "absolute",
    top: start * rowH,
    left: 0,
    right: 0,
  };

  return (
    <div
      className={`fw-body fw-${viewMode}${marqueeView ? " is-marquee-active" : ""}`}
      ref={containerRef}
      role="listbox"
      aria-multiselectable="true"
      onPointerDown={handleBodyPointerDown}
      onContextMenu={onBodyContextMenu}
    >
      {viewMode === "list" && (
        <div className="fw-list-head" aria-hidden="true">
          <span className="fw-row-icon" />
          <span className="fw-row-name">{t("fw.sort.name")}</span>
          <span className="fw-row-time">{t("fw.sort.modified")}</span>
          <span className="fw-row-size">{t("fw.sort.size")}</span>
          <span className="fw-row-type">{t("fw.sort.type")}</span>
        </div>
      )}
      <div style={innerStyle}>
        <div style={offsetStyle}>
          {Array.from({ length: Math.max(0, end - start) }, (_, i) => renderRow(start + i))}
          {children}
        </div>
      </div>
      {marqueeView && (
        <div
          className="fw-marquee"
          aria-hidden="true"
          style={{
            left: marqueeView.left,
            top: marqueeView.top,
            width: marqueeView.width,
            height: marqueeView.height,
          }}
        />
      )}
    </div>
  );
}
