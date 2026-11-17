// 底部弹层拖拽关闭的判定规则（纯函数）：
// - 只在「明显向下」的位移才接过手势，短点按与横向滑动不触发；
// - 位移足够远，或速度足够快（快速下滑），才允许关闭；
// - 其余情况回弹原位，避免轻微拖动就把弹层关掉。
//
// 与 BottomSheet 的 48dp 拖拽区配合使用：触摸面积由视图层保证，判定只关心手势数据。
export const SHEET_DISMISS_DISTANCE = 64;
export const SHEET_DISMISS_VELOCITY = 0.7;
export const SHEET_DRAG_START_SLOP = 5;

/** 是否应该由拖拽区接管这次移动（向下、且以纵向为主） */
export function shouldCaptureSheetDrag(dy: number, dx: number): boolean {
  return dy > SHEET_DRAG_START_SLOP && Math.abs(dy) > Math.abs(dx);
}

/** 松手时是否满足关闭条件：足够远，或足够快 */
export function shouldDismissSheet(dy: number, vy: number): boolean {
  if (dy <= SHEET_DRAG_START_SLOP) return false;
  return dy > SHEET_DISMISS_DISTANCE || vy > SHEET_DISMISS_VELOCITY;
}
