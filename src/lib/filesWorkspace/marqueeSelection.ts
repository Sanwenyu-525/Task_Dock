//! 文件工作区矩形框选：纯几何、选择合并与自动滚动速度。
//!
//! 设计边界：
//! - 命中计算只依赖「虚拟列表几何 + 条目数组」，不读取 DOM 行节点；
//! - 列表/网格使用各自几何，网格列数变化后调用方必须传入新列数；
//! - 帧合并、自动滚动循环和指针生命周期由 FileList 负责，本模块保持无状态可单测。

import { joinPath } from "./pathUtils";

export type MarqueeViewMode = "list" | "grid";
export type MarqueeSelectionMode = "replace" | "add" | "toggle";

/** 建议的统一手势类型；FilePane 只实现 file-drag-*，FileList 只实现 marquee-*。 */
export type FilePointerGesture =
  | "idle"
  | "marquee-pending"
  | "marquee-active"
  | "file-drag-pending"
  | "file-drag-active";

export interface MarqueeEntry {
  name: string;
}

export interface MarqueeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MarqueeGeometry {
  viewMode: MarqueeViewMode;
  /** 列表行槽高度（内容坐标，不含吸顶表头）。 */
  rowHeight: number;
  /** 网格列数（由容器宽度实时测量）。 */
  gridCols: number;
  gridCellWidth: number;
  gridCellHeight: number;
  gridGap: number;
  /** 网格行左右内边距（与 `.fw-grid-row` 的 0 4px 对应）。 */
  gridPaddingX: number;
  /** 列表行可选择区域宽度（内容坐标）。 */
  bodyWidth: number;
}

export interface MarqueeBodyRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 规格化任意两个角点，返回左上/右下坐标。 */
export function normalizeMarqueeRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): MarqueeRect {
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: Math.max(ax, bx),
    bottom: Math.max(ay, by),
  };
}

/** 严格相交：贴边不算命中，避免零面积矩形选中整行。 */
export function rectsIntersect(a: MarqueeRect, b: MarqueeRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * 把指针的视口坐标换算为滚动内容坐标。
 * 列表的吸顶表头不占内容坐标，因此减 headOffset；网格 headOffset=0。
 */
export function toMarqueeContentPoint(
  clientX: number,
  clientY: number,
  body: MarqueeBodyRect,
  scrollTop: number,
  headOffset: number,
): { x: number; y: number } {
  return {
    x: clientX - body.left,
    y: clientY - body.top + Math.max(0, scrollTop) - headOffset,
  };
}

/**
 * 按虚拟几何命中矩形覆盖的文件路径。
 *
 * 只遍历矩形覆盖的行/列候选：复杂度与框选覆盖量相关，与目录总条目数无关。
 * 列表行使用视觉 inset（上下各 1px、左右 2px），与独立行轮廓保持一致；
 * 网格卡片按实际列数、卡片宽高与 gap 计算。
 */
export function marqueeHitTest(
  entries: readonly MarqueeEntry[],
  dirPath: string,
  rect: MarqueeRect,
  geometry: MarqueeGeometry,
): string[] {
  if (!entries.length || rect.right <= rect.left || rect.bottom <= rect.top) return [];
  const hits: string[] = [];

  if (geometry.viewMode === "list") {
    const rowHeight = Math.max(1, geometry.rowHeight);
    const firstRow = Math.max(0, Math.floor(rect.top / rowHeight));
    const lastRow = Math.min(
      entries.length - 1,
      Math.floor((rect.bottom - 0.001) / rowHeight),
    );
    const width = Math.max(0, geometry.bodyWidth);
    for (let index = firstRow; index <= lastRow; index += 1) {
      // 行槽本身参与虚拟滚动；绘制背景的 inset 不改变行槽高度。
      const rowTop = index * rowHeight + 1;
      const rowBottom = (index + 1) * rowHeight - 1;
      const item: MarqueeRect = { left: 2, top: rowTop, right: width - 2, bottom: rowBottom };
      if (rectsIntersect(rect, item)) hits.push(joinPath(dirPath, entries[index].name));
    }
    return hits;
  }

  const cols = Math.max(1, Math.floor(geometry.gridCols));
  const strideX = Math.max(1, geometry.gridCellWidth + geometry.gridGap);
  const strideY = Math.max(1, geometry.gridCellHeight + geometry.gridGap);
  const firstRow = Math.max(0, Math.floor(rect.top / strideY));
  const lastRow = Math.floor((rect.bottom - 0.001) / strideY);
  const firstCol = Math.max(0, Math.floor((rect.left - geometry.gridPaddingX) / strideX));
  const lastCol = Math.floor((rect.right - geometry.gridPaddingX - 0.001) / strideX);
  const lastIndex = entries.length - 1;

  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= Math.min(cols - 1, lastCol); col += 1) {
      const index = row * cols + col;
      if (index > lastIndex) return hits;
      const left = geometry.gridPaddingX + col * strideX;
      const top = row * strideY;
      const item: MarqueeRect = {
        left,
        top,
        right: left + geometry.gridCellWidth,
        bottom: top + geometry.gridCellHeight,
      };
      if (rectsIntersect(rect, item)) hits.push(joinPath(dirPath, entries[index].name));
    }
  }
  return hits;
}

/**
 * 合并框选结果。一次拖拽期间始终以 pointerdown 时的基准集合计算：
 * - replace：矩形覆盖即唯一选择；
 * - add（Shift）：基准集合 ∪ 覆盖集合；
 * - toggle（Ctrl）：基准集合与覆盖集合对称差，覆盖期间不反复翻转。
 */
export function mergeMarqueeSelection(
  base: readonly string[],
  candidates: readonly string[],
  mode: MarqueeSelectionMode,
): string[] {
  if (mode === "replace") return uniquePaths(candidates);
  const baseSet = new Set(base);
  const candidateSet = new Set(candidates);
  if (mode === "add") {
    return uniquePaths([...base, ...candidates]);
  }
  const result: string[] = [];
  for (const path of base) {
    if (!candidateSet.has(path)) result.push(path);
  }
  for (const path of candidates) {
    if (!baseSet.has(path)) result.push(path);
  }
  return uniquePaths(result);
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export interface AutoScrollOptions {
  edge?: number;
  maxSpeed?: number;
}

/**
 * 指针接近滚动容器上/下边缘时的每帧速度（px）。边缘内线性加速，超过上限即封顶；
 * 容器外不会无限加速。返回值 0 表示无需滚动。
 */
export function autoScrollVelocity(
  pointerY: number,
  top: number,
  bottom: number,
  options: AutoScrollOptions = {},
): number {
  const height = Math.max(1, bottom - top);
  const edge = Math.min(options.edge ?? 44, height / 3);
  const maxSpeed = Math.max(1, options.maxSpeed ?? 14);
  if (pointerY < top || pointerY > bottom) {
    return pointerY < top ? -maxSpeed : maxSpeed;
  }
  if (pointerY < top + edge) {
    const intensity = (top + edge - pointerY) / edge;
    return -Math.round(maxSpeed * intensity * intensity);
  }
  if (pointerY > bottom - edge) {
    const intensity = (pointerY - (bottom - edge)) / edge;
    return Math.round(maxSpeed * intensity * intensity);
  }
  return 0;
}

/**
 * 键盘焦点移动。列表用上下移动；网格上下跨一行（±cols），左右跨一列。
 * Home/End 只用于单维列表；网格保留给调用方按行列需求处理。
 */
export function moveFocusIndex(
  index: number,
  key: string,
  count: number,
  viewMode: MarqueeViewMode,
  gridCols: number,
): number {
  if (count <= 0) return -1;
  const current = Math.min(Math.max(index, 0), count - 1);
  const cols = Math.max(1, gridCols);
  let next = current;
  if (key === "ArrowUp" || key === "Up") next = current - (viewMode === "grid" ? cols : 1);
  else if (key === "ArrowDown" || key === "Down") next = current + (viewMode === "grid" ? cols : 1);
  else if (key === "ArrowLeft" || key === "Left") next = current - 1;
  else if (key === "ArrowRight" || key === "Right") next = current + 1;
  else if (key === "Home") next = 0;
  else if (key === "End") next = count - 1;
  else return current;
  return Math.min(Math.max(next, 0), count - 1);
}
