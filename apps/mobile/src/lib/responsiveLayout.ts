// 移动端响应式断点唯一事实源：页面不各自写 340 / 1.25，测试与真机使用同一套规则。
// 只做结构切换，不通过缩小字号来适配窄屏。

export const NARROW_WIDTH_DP = 340;
export const LARGE_FONT_SCALE = 1.25;

/** 工具页四组网格统一：320dp 三列，其余四列（同一屏内所有分区必须一致）。 */
export function gridColumnsForWidth(width: number): 3 | 4 {
  return width <= NARROW_WIDTH_DP ? 3 : 4;
}

/** 工作区文件集合：窄屏或大字号时改纵向整行，避免三列每格过窄。 */
export function shouldStackFileCards(width: number, fontScale: number): boolean {
  return width <= NARROW_WIDTH_DP || fontScale > LARGE_FONT_SCALE;
}

/** 我的页四项统计：窄屏 2×2，宽屏一行四格。 */
export function shouldUseNarrowStats(width: number): boolean {
  return width <= NARROW_WIDTH_DP;
}
