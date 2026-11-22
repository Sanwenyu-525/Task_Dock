//! 搜索定位的滚动 + 高亮小工具（各目标模块消费 pendingLocate 时共用）。

import { prefersReducedMotion } from "../../lib/motion";

/**
 * 在 `attempts` 次重试窗口内等待选择器出现元素，滚动到可见并短暂高亮。
 * 数据加载（过滤/切分类）后目标才会渲染，所以需要重试；总窗口约 attempts × interval。
 */
export function locateElement(opts: {
  find: () => HTMLElement | null;
  attempts?: number;
  intervalMs?: number;
}): void {
  const { find, attempts = 10, intervalMs = 200 } = opts;
  let left = attempts;
  const tick = () => {
    const el = find();
    if (el) {
      el.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      el.classList.add("gs-locate-flash");
      window.setTimeout(() => el.classList.remove("gs-locate-flash"), 2000);
      return;
    }
    left -= 1;
    if (left > 0) window.setTimeout(tick, intervalMs);
  };
  tick();
}
