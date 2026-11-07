/**
 * 名称截断判定 + `data-tip` 同步（应用中心 / 胶囊应用网格共用）。
 *
 * 规则（2026-11-06 统一）：
 * - 名称完整显示时**不挂**提示：同文案的浮层只是噪声，还会压住相邻磁贴；
 * - 只有布局真的截断（宽或高任一溢出）时才挂完整名称；
 * - 只挂名称本身，不挂 exe 路径 / 网址等内容——路径对「这是哪个应用」没有帮助；
 * - 必须在 mouseenter / focus 里**同步**写入，全局 `TooltipLayer` 的冒泡监听才能读到；
 * - 离开 / 失焦 / 进入启动态时移除，避免提示条残留在下一个磁贴上。
 *
 * 前提：目标元素的样式已声明裁剪（单行 `text-overflow: ellipsis` 或多行
 * `-webkit-line-clamp` + `overflow: hidden`），否则 scroll 尺寸不会超出可见尺寸。
 */
export function syncTruncatedTip(host: HTMLElement, selector: string, text: string): void {
  const el = host.querySelector<HTMLElement>(selector);
  if (!el) return;
  const clipped =
    el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  if (clipped && text) host.dataset.tip = text;
  else delete host.dataset.tip;
}

/** 清除提示：离开 / 失焦时同步移除，提示条不会残留或串到相邻磁贴。 */
export function clearTip(host: HTMLElement): void {
  delete host.dataset.tip;
}
