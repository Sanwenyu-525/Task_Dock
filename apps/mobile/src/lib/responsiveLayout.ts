// 移动端响应式断点唯一事实源：页面不各自写 340 / 1.25，测试与真机使用同一套规则。
// 只做结构切换，不通过缩小字号来适配窄屏。

export const NARROW_WIDTH_DP = 340;
export const LARGE_FONT_SCALE = 1.25;
/** 四项统计 2×2 的断点：低于 480dp 时 4 格一行必然被 gap 挤成 3+1，统一改 2×2。 */
export const STATS_TWO_COL_BREAKPOINT = 480;

/** 工具页网格统一：320dp 两列（四项分区不会挤成 3+1），其余四列。 */
export function gridColumnsForWidth(width: number): 2 | 4 {
  return width <= NARROW_WIDTH_DP ? 2 : 4;
}

/** 工作区文件集合：窄屏或大字号时改纵向整行，避免三列每格过窄。 */
export function shouldStackFileCards(width: number, fontScale: number): boolean {
  return width <= NARROW_WIDTH_DP || fontScale > LARGE_FONT_SCALE;
}

/** 四项统计：窄屏/常规手机宽度 2×2，平板宽度一行四格（gap 已计入，避免 3+1）。 */
export function shouldUseNarrowStats(width: number): boolean {
  return width < STATS_TWO_COL_BREAKPOINT;
}
