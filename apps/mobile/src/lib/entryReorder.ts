// 拖拽落点计算：只做几何数学，不碰手势与视图。
//
// 为什么单独抽出来：真机上「拖到哪一格」是最容易错乱的环节（行数算错、最后一格
// 落不下、越界后索引变成 -1）。把「位移 → 目标下标」变成纯函数后，可以穷举边界，
// 手势层只负责把 dx/dy 喂进来，出错时能立刻分清是数学错还是手势错。
//
// 约束：纯函数，不得 import react / react-native。

/** 网格步进：gridDropIndex 只需要「相邻两格原点的距离」，不需要单元格尺寸 */
export interface GridDropMetrics {
  /** 每行列数（工作台 4 列，窄屏 2 列） */
  columns: number;
  /** 列步进 = 单元格宽度 + 列间距 */
  columnStep: number;
  /** 行步进 = 单元格高度 + 行间距 */
  rowStep: number;
}

/** 把任意下标收敛到 [0, count-1]；非有限值按 0 处理 */
export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return Math.min(Math.max(Math.round(index), 0), count - 1);
}

/**
 * 网格内拖拽的目标下标。
 *
 * 算法：把「起点格 + 位移/步进」四舍五入成行列，再换算回线性下标。
 * 最后一行的空格子会被收敛到 count-1（拖到右下空白处等于「放到最后」）。
 */
export function gridDropIndex(
  fromIndex: number,
  dx: number,
  dy: number,
  metrics: GridDropMetrics,
  count: number,
): number {
  if (count <= 0) return 0;
  const columns = Math.max(1, Math.floor(metrics.columns));
  const columnStep = metrics.columnStep > 0 ? metrics.columnStep : 1;
  const rowStep = metrics.rowStep > 0 ? metrics.rowStep : 1;
  const from = clampIndex(fromIndex, count);

  const startColumn = from % columns;
  const startRow = Math.floor(from / columns);
  const columnShift = Number.isFinite(dx) ? Math.round(dx / columnStep) : 0;
  const rowShift = Number.isFinite(dy) ? Math.round(dy / rowStep) : 0;

  const targetColumn = Math.min(
    Math.max(startColumn + columnShift, 0),
    columns - 1,
  );
  const targetRow = Math.max(0, startRow + rowShift);

  return clampIndex(targetRow * columns + targetColumn, count);
}

/** 竖向列表内拖拽的目标下标（管理页「已显示」列表） */
export function listDropIndex(
  fromIndex: number,
  dy: number,
  rowStep: number,
  count: number,
): number {
  if (count <= 0) return 0;
  const step = rowStep > 0 ? rowStep : 1;
  const from = clampIndex(fromIndex, count);
  const shift = Number.isFinite(dy) ? Math.round(dy / step) : 0;
  return clampIndex(from + shift, count);
}

/** 是否是「轻点」而不是拖拽：位移小于阈值才算点按（编辑态里点按=打开动作表） */
export function isTapGesture(dx: number, dy: number, threshold = 6): boolean {
  return Math.abs(dx) <= threshold && Math.abs(dy) <= threshold;
}

/** 竖向列表拖拽的即时换位结果 */
export interface SettledReorder {
  index: number;
  /** 累计净换位数：translateY = dy - swaps * rowStep，让被拖行始终跟着手指 */
  swaps: number;
  moved: boolean;
}

/**
 * 竖向列表的「跨过半行就换位」算法（管理页已显示列表）。
 *
 * 与网格的区别：网格是松手时一次性落到目标格（2D 目标格直观），
 * 竖向列表用即时换位——拖动过程中列表就在动，用户永远知道当前顺序。
 * 这里把「累计位移 → 换几次位」抽成纯函数，手势层只做 apply。
 */
export function settleReorder(
  currentIndex: number,
  dy: number,
  swaps: number,
  rowStep: number,
  count: number,
  thresholdRatio = 0.5,
): SettledReorder {
  if (count <= 0) return { index: 0, swaps: 0, moved: false };
  const step = rowStep > 0 ? rowStep : 1;
  let index = clampIndex(currentIndex, count);
  let net = Number.isFinite(swaps) ? Math.round(swaps) : 0;
  let moved = false;

  // guard 上限 = count：最多把一行从一端挪到另一端，不会因为异常输入死循环
  for (let guard = 0; guard <= count; guard += 1) {
    const residual = (Number.isFinite(dy) ? dy : 0) - net * step;
    if (residual > step * thresholdRatio && index < count - 1) {
      index += 1;
      net += 1;
      moved = true;
      continue;
    }
    if (residual < -step * thresholdRatio && index > 0) {
      index -= 1;
      net -= 1;
      moved = true;
      continue;
    }
    break;
  }

  return { index, swaps: net, moved };
}
