//! 文件列表列宽（列表视图表头拖拽调宽，Windows 资源管理器习惯）。
//!
//! 列宽是文件工作区全局状态：所有分栏共用一套，只记录被用户改过的列，
//! 未改列回默认。默认值与 files.css `.fw-body.fw-list` 的 `--fw-col-*`
//! 一一对应，两处必须同步修改。

/** 可拖拽调宽的列（名称列是 1fr 弹性列，自动吸收剩余空间，不直接调宽）。 */
export type ListColumn = "time" | "size" | "type";

export const DEFAULT_COL_WIDTHS: Record<ListColumn, number> = { time: 118, size: 76, type: 88 };
export const MIN_COL_WIDTHS: Record<ListColumn, number> = { time: 72, size: 48, type: 40 };
export const MAX_COL_WIDTHS: Record<ListColumn, number> = { time: 280, size: 200, type: 200 };
/** 名称列保底宽度：拖宽固定列时文件名不得被挤成 0。 */
export const MIN_NAME_WIDTH = 96;
/** 表头/行左右内边距(16) + 图标列(15) + 4×8 列间距，与 files.css 保持一致。 */
export const GRID_CHROME = 63;

export type ColWidths = Partial<Record<ListColumn, number>>;

const LIST_COLUMNS = Object.keys(DEFAULT_COL_WIDTHS) as ListColumn[];

export function effectiveColWidth(widths: ColWidths, col: ListColumn): number {
  const width = widths[col];
  return typeof width === "number" ? width : DEFAULT_COL_WIDTHS[col];
}

/**
 * 拖拽/键盘调宽的唯一钳制入口：列自身上下限 + 名称列保底。
 * `maxByName` 是按容器宽换算出的上限；容器过窄时上限低于下限，按下限兜底
 * （窄分栏断点会隐藏次要列，实际溢出风险由容器查询兜住）。
 */
export function clampColWidth(col: ListColumn, width: number, maxByName = Number.POSITIVE_INFINITY): number {
  const min = MIN_COL_WIDTHS[col];
  // NaN/±Infinity 输入回下限：拖拽坐标异常时不产生 "NaNpx" 之类的非法宽度。
  if (!Number.isFinite(width)) return min;
  const max = Math.max(min, Math.min(MAX_COL_WIDTHS[col], maxByName));
  return Math.round(Math.min(Math.max(width, min), max));
}

/** 名称列保底允许的某列最大宽度：容器宽 − 图标/内边距/间距 − 其余固定列 − 名称保底。 */
export function maxForName(containerWidth: number, widths: ColWidths, col: ListColumn): number {
  const others = LIST_COLUMNS
    .filter((c) => c !== col)
    .reduce((sum, c) => sum + effectiveColWidth(widths, c), 0);
  return containerWidth - GRID_CHROME - MIN_NAME_WIDTH - others;
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
