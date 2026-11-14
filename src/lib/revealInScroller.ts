//! 最小必要的纵向滚动补偿。
//!
//! `Element.scrollIntoView({ block: "nearest" })` 会滚动**所有**祖先滚动容器，
//! 对「列表下方固定的调整条」这种元素，实际表现是整个设置页突然跳动（甚至把
//! 列表自身也滚一段）。这里显式实现同一语义的最小版本：
//!
//! - 只找最近的可滚动祖先（设置页的 page-scroll），没有就退到文档视口；
//! - 只做纵向，只在元素真的越出可见区时补差额，绝不居中；
//! - 元素尺寸为 0（折叠/隐藏）或已可见时返回 0，不产生任何滚动。
//!
//! 返回值是实际滚动量（像素），便于验收断言「没有滚动」「只滚了最小差额」。

const SCROLLABLE = new Set(["auto", "scroll", "overlay"]);

function canScrollVertically(node: HTMLElement): boolean {
  if (node.scrollHeight <= node.clientHeight + 1) return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
  const overflowY = style?.overflowY ?? "";
  return SCROLLABLE.has(overflowY);
}

/** 把元素带进最近可滚动祖先的可见区；返回实际滚动量。 */
export function revealInScroller(element: HTMLElement | null, padding = 8): number {
  if (!element || typeof element.getBoundingClientRect !== "function") return 0;
  const rect = element.getBoundingClientRect();
  // 折叠 / 隐藏时没有几何信息：不做任何滚动补偿。
  if (rect.width === 0 && rect.height === 0) return 0;

  let scroller: HTMLElement | null = element.parentElement;
  while (scroller && scroller !== document.body) {
    if (canScrollVertically(scroller)) break;
    scroller = scroller.parentElement;
  }
  const target = scroller && scroller !== document.body ? scroller : null;

  if (target) {
    const box = target.getBoundingClientRect();
    let delta = 0;
    if (rect.bottom > box.bottom - padding) delta = rect.bottom - (box.bottom - padding);
    else if (rect.top < box.top + padding) delta = rect.top - (box.top + padding);
    if (delta === 0) return 0;
    const before = target.scrollTop;
    target.scrollTop = before + delta;
    return target.scrollTop - before;
  }

  // 没有可滚动祖先：退到文档视口，同样只补最小差额。
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  if (viewportHeight <= 0) return 0;
  const overflow = rect.bottom - (viewportHeight - padding);
  if (overflow <= 0) return 0;
  window.scrollBy(0, overflow);
  return overflow;
}
