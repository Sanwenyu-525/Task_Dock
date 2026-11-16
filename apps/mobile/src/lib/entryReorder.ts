// 拖拽落点计算：只做几何数学，不碰手势与视图。
//
// 为什么单独抽出来：真机上「拖到第几个」是最容易错乱的环节（步进算错、最后一格
// 落不下、越界后索引变成 -1）。把「位移 → 目标下标」变成纯函数后，可以穷举边界，
// 手势层只负责把 dx 喂进来，出错时能立刻分清是数学错还是手势错。
//
// 约束：纯函数，不得 import react / react-native。

/** 把任意下标收敛到 [0, count-1]；非有限值按 0 处理 */
export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return Math.min(Math.max(Math.round(index), 0), count - 1);
}

/**
 * 单行横向轨道内拖拽的目标下标（首页快捷入口，2026-11-16）。
 *
 * 轨道永远一行，所以只有横向位移参与计算；纵向位移忽略——
 * 手指上下抖动不该把入口挪到别处（旧网格正是用 dy 换行，才需要行步进）。
 *
 * 算法：位移 / 步进四舍五入成「跨过几个磁贴」，再夹到 [0, count-1]。
 * 最后一格之后一律收敛到最后，不会算出越界下标。
 */
export function railDropIndex(
  fromIndex: number,
  dx: number,
  step: number,
  count: number,
): number {
  if (count <= 0) return 0;
  const from = clampIndex(fromIndex, count);
  // 步进缺失/非法时不要把像素当步数：整次位移只算一格，
  // 否则 dx=100、step=0 会被当成 100 格直接跳到列表尽头。
  const stride =
    step > 0 ? step : Number.isFinite(dx) ? Math.max(Math.abs(dx), 1) : 1;
  const shift = Number.isFinite(dx) ? Math.round(dx / stride) : 0;
  return clampIndex(from + shift, count);
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
