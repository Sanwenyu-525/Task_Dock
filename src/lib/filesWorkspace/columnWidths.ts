//! 文件列表列宽（列表视图表头拖拽调宽）。
//!
//! 交互语义（2026-11-22 用户确认）：手柄在**列边界**上，拖动只移动被抓住的
//! 那条分隔线——它左右两列互补增减（总宽恒定），其余列与其他分隔线不动。
//! 名称列保持 minmax(0,1fr) 弹性占满（自动吸收总宽变化），不参与存储。

export type ListColumn = "time" | "size" | "type";
/** 可拖拽的列边界（分隔线两侧的列）。 */
export type ListBoundary = "name-time" | "time-size" | "size-type";

export const DEFAULT_COL_WIDTHS: Record<ListColumn, number> = { time: 118, size: 76, type: 88 };
export const MIN_COL_WIDTHS: Record<ListColumn, number> = { time: 72, size: 48, type: 40 };
export const MAX_COL_WIDTHS: Record<ListColumn, number> = { time: 280, size: 200, type: 200 };
/** 名称列保底宽：拖 name-time 边界把日期列拖宽时，文件名不得被挤穿。 */
export const MIN_NAME_WIDTH = 96;
/** 表头/行左右内边距(16) + 图标列(15) + 4×8 列间距，与 files.css 保持一致。 */
export const GRID_CHROME = 63;

export type ColWidths = Partial<Record<ListColumn, number>>;

const LIST_COLUMNS: ListColumn[] = ["time", "size", "type"];

const BOUNDARY_COLS: Record<ListBoundary, { left: ListColumn | "name"; right: ListColumn }> = {
  "name-time": { left: "name", right: "time" },
  "time-size": { left: "time", right: "size" },
  "size-type": { left: "size", right: "type" },
};

export function effectiveColWidth(widths: ColWidths, col: ListColumn): number {
  const width = widths[col];
  return typeof width === "number" ? width : DEFAULT_COL_WIDTHS[col];
}

/** 一次边界拖拽的结果：受影响列的新宽（总宽恒定，未触及列不出现）。 */
export interface BoundaryDragResult {
  widths: ColWidths;
  /** 实际生效的位移：被两侧列上下限与名称保底钳制后，可能与光标位移不同。 */
  applied: number;
}

const round = (value: number) => Math.round(value);

/**
 * 边界拖拽的唯一计算入口：`delta` 为光标位移（向右为正）。
 * 分隔线随光标移动：左列 +delta、右列 -delta，两侧各自钳制上下限；
 * name-time 边界的左列是弹性名称列——只施加名称保底约束，不落存储。
 * 任何一侧钳到限后位移停在钳制点（与 Windows 一致）。
 */
export function applyBoundaryDrag(
  containerWidth: number,
  widths: ColWidths,
  boundary: ListBoundary,
  delta: number,
): BoundaryDragResult {
  if (!Number.isFinite(delta)) return { widths: {}, applied: 0 };
  const { left, right } = BOUNDARY_COLS[boundary];
  const width = (col: ListColumn) => effectiveColWidth(widths, col);

  let lo = -Number.MAX_VALUE;
  let hi = Number.MAX_VALUE;
  if (left === "name") {
    const rightWidth = width(right);
    const nameNow = containerWidth - GRID_CHROME - width("time") - width("size") - width("type");
    // 右列自身上下限（右列 = time - delta）与名称保底（名称 = nameNow + delta）。
    lo = Math.max(rightWidth - MAX_COL_WIDTHS[right], MIN_NAME_WIDTH - nameNow);
    hi = rightWidth - MIN_COL_WIDTHS[right];
  } else {
    const leftWidth = width(left);
    const rightWidth = width(right);
    lo = Math.max(MIN_COL_WIDTHS[left] - leftWidth, rightWidth - MAX_COL_WIDTHS[right]);
    hi = Math.min(MAX_COL_WIDTHS[left] - leftWidth, rightWidth - MIN_COL_WIDTHS[right]);
  }
  const applied = round(Math.min(Math.max(delta, lo), hi));

  const next: ColWidths = {};
  if (left === "name") {
    next[right] = round(width(right) - applied);
  } else {
    next[left] = round(width(left) + applied);
    next[right] = round(width(right) - applied);
  }
  return { widths: next, applied };
}

/** 持久化归一：非法/越界列丢弃（该列回默认），全部无效返回 undefined。 */
export function normalizeColWidths(raw: unknown): ColWidths | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: ColWidths = {};
  let count = 0;
  for (const col of LIST_COLUMNS) {
    const width = (raw as Record<string, unknown>)[col];
    if (
      typeof width === "number" &&
      Number.isFinite(width) &&
      width >= MIN_COL_WIDTHS[col] &&
      width <= MAX_COL_WIDTHS[col]
    ) {
      out[col] = Math.round(width);
      count += 1;
    }
  }
  return count > 0 ? out : undefined;
}
