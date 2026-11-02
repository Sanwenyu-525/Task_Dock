//! 列表状态变化反馈的共用动效开关与时长。
//! 时长必须与 styles.css 中对应的关键帧/过渡保持一致，改一处就要改另一处。

/** 卡片离场（收拢淡出）时长，与 `clip-remove` 关键帧一致。 */
export const EXIT_MS = 190;

/** 分组内一行的重排过渡时长（上移/下移的轻量 FLIP）。 */
export const REORDER_MS = 200;

/**
 * 系统「减少动态」开关。
 *
 * CSS 侧的全局规则只把动效压到瞬时，JS 侧若仍按动画时长等待，就等于用动效
 * 拖慢了数据同步；因此这里读取同一个标志，减少动态时直接跳过等待与位移。
 */
export function prefersReducedMotion(): boolean {
  // store 层也会在 node 测试环境运行，先确认 window 存在再读媒体查询
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
