//! 文件列表/网格（虚拟化渲染 + 选择 + 缩略图占位）。
//!
//! 大目录红线（任务规范 §10）：数千条目不一次性建 DOM——窗口化渲染，
//! 列表行高固定 26px，网格按列数分行虚拟化；缩略图客户端并发 ≤3、缓存有界。
//! 排序/筛选在内存完成（≤8000 条，JS 排序远低于交互阈值），不重复请求后端。

import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { FsEntry } from "../../lib/bridge";
import { fileVisual, formatModified, formatSize, toneVar } from "../../lib/filesWorkspace/fileMeta";
import { joinPath } from "../../lib/filesWorkspace/pathUtils";

const LIST_ROW_H = 26;
const GRID_CELL_W = 104;
const GRID_CELL_H = 116;
const GRID_GAP = 8;

// ── 缩略图（客户端并发 ≤3 + 有界缓存）─────────────────────────────────

const thumbCache = new Map<string, string | null>();
const THUMB_CACHE_MAX = 300;
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
): { start: number; end: number; viewportH: number } {
  const [range, setRange] = useState({ start: 0, end: 40, viewportH: 480 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const viewportH = Math.max(el.clientHeight, 120);
      const start = Math.max(0, Math.floor(el.scrollTop / itemHeight) - 4);
      const end = Math.min(count, Math.ceil((el.scrollTop + viewportH) / itemHeight) + 4);
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
  }, [containerRef, itemHeight, count]);
  return range;
}

// ── 行/单元格 ───────────────────────────────────────────────────────────

interface EntryRowProps {
  entry: FsEntry;
  path: string;
  selected: boolean;
  active: boolean;
  isDropTarget: boolean;
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
  index,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
}: EntryRowProps) {
  const visual = fileVisual(entry.category);
  const Icon = visual.icon;
  return (
    <div
      className={`fw-row${selected ? " is-selected" : ""}${active && selected ? " is-active" : ""}${isDropTarget ? " is-drop-folder" : ""}`}
      style={{ height: LIST_ROW_H, color: entry.kind === "dir" ? toneVar(visual.tone) : undefined }}
      data-fw-path={path}
      data-fw-kind={entry.kind}
      role="option"
      aria-selected={selected}
      onPointerDown={(e) => onPointerDown(e, entry, index)}
      onDoubleClick={() => onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
    >
      <span className="fw-row-icon" aria-hidden="true">
        <Icon size={15} strokeWidth={1.6} />
      </span>
      <span className="fw-row-name" title={entry.name}>
        {entry.name}
      </span>
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
      className={`fw-cell${selected ? " is-selected" : ""}${active && selected ? " is-active" : ""}${isDropTarget ? " is-drop-folder" : ""}`}
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
    </div>
  );
});

// ── 列表主体 ────────────────────────────────────────────────────────────

export interface FileListProps {
  entries: FsEntry[];
  dirPath: string;
  viewMode: "list" | "grid";
  selectedPaths: ReadonlySet<string>;
  activePath: string | null;
  dropTargetPath: string | null;
  thumbnails: boolean;
  onEntryPointerDown: (e: React.PointerEvent, entry: FsEntry, index: number) => void;
  onEntryActivate: (entry: FsEntry) => void;
  onEntryContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  onBodyPointerDown: (e: React.PointerEvent) => void;
  onBodyContextMenu: (e: React.MouseEvent) => void;
  children?: ReactNode;
}

export default function FileList({
  entries,
  dirPath,
  viewMode,
  selectedPaths,
  activePath,
  dropTargetPath,
  thumbnails,
  onEntryPointerDown,
  onEntryActivate,
  onEntryContextMenu,
  onBodyPointerDown,
  onBodyContextMenu,
  children,
}: FileListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);

  // 网格按容器宽度计算列数（分栏宽度变化自适应）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || viewMode !== "grid") return;
    const measure = () => {
      const inner = el.clientWidth - 8;
      const per = Math.max(2, Math.floor((inner + GRID_GAP) / (GRID_CELL_W + GRID_GAP)));
      setCols(per);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode]);

  const rowCount = viewMode === "list" ? entries.length : Math.ceil(entries.length / cols);
  const rowH = viewMode === "list" ? LIST_ROW_H : GRID_CELL_H + GRID_GAP;
  const { start, end } = useScrollRange(containerRef, rowH, rowCount);

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
              thumbnails={thumbnails}
              onPointerDown={onEntryPointerDown}
              onDoubleClick={onEntryActivate}
              onContextMenu={onEntryContextMenu}
              onDragStartFile={onFileDragStart}
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
      className={`fw-body fw-${viewMode}`}
      ref={containerRef}
      role="listbox"
      aria-multiselectable="true"
      onPointerDown={onBodyPointerDown}
      onContextMenu={onBodyContextMenu}
    >
      <div style={innerStyle}>
        <div style={offsetStyle}>
          {Array.from({ length: Math.max(0, end - start) }, (_, i) => renderRow(start + i))}
          {children}
        </div>
      </div>
    </div>
  );
}
