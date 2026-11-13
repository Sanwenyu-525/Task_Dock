//! 日期视图横向滚动：溢出方向状态 + 激活项自动入视 + 滚轮映射。
//!
//! 只服务任务页的 `.tasks-views`（320/360 窄窗 5 个日期视图放不下时横向滚动）。
//! 与 `tasks-layout.css` 里的 12px 边缘遮罩配合：有隐藏内容的那一侧显示渐变，
//! 到边界立即消失；`VIEW_REVEAL_MARGIN` 必须与遮罩宽度一致，避免激活项被淡化。
//!
//! 不新增轮询/定时器/依赖：边缘状态由 scroll 事件、ResizeObserver 与每次渲染后的
//! 布局 effect 驱动，监听与 observer 都在 effect 清理函数里释放。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** 与 CSS 边缘遮罩宽度保持一致（见 tasks-layout.css `.tasks-views`）。 */
export const VIEW_REVEAL_MARGIN = 12;

/** 亚像素/取整误差容忍：<= 1px 的溢出不视为「有隐藏内容」。 */
export const VIEW_OVERFLOW_TOLERANCE = 1;

export interface ViewOverflowEdges {
  /** 左侧（滚动起点方向）还有隐藏内容。 */
  start: boolean;
  /** 右侧（滚动终点方向）还有隐藏内容。 */
  end: boolean;
}

const NO_OVERFLOW: ViewOverflowEdges = { start: false, end: false };

/**
 * 由滚动容器的三个尺寸计算两侧是否还有隐藏内容。
 * 无溢出（含 1px 取整误差）时两侧都为 false，调用方据此完全移除指示。
 */
export function computeOverflowEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
  tolerance = VIEW_OVERFLOW_TOLERANCE,
): ViewOverflowEdges {
  const max = Math.max(0, scrollWidth - clientWidth);
  if (max <= tolerance) return NO_OVERFLOW;
  return {
    start: scrollLeft > tolerance,
    end: scrollLeft < max - tolerance,
  };
}

export interface RevealMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  /** 目标按钮相对滚动容器 padding 盒的偏移（offsetLeft）。 */
  itemLeft: number;
  /** 目标按钮宽度（offsetWidth）。 */
  itemWidth: number;
  /** 目标与容器可见边缘之间保留的距离，默认等于遮罩宽度。 */
  margin?: number;
}

/**
 * 把目标按钮滚动到完整可见（含两侧 margin）后应设置的 scrollLeft。
 * 已完整可见时原样返回；结果夹取在 [0, max] 内，不会把页面或父容器带走。
 */
export function computeRevealScrollLeft({
  scrollLeft,
  scrollWidth,
  clientWidth,
  itemLeft,
  itemWidth,
  margin = VIEW_REVEAL_MARGIN,
}: RevealMetrics): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  if (max <= 0) return 0;
  const safeLeft = Math.max(0, itemLeft);
  const safeWidth = Math.max(0, itemWidth);
  const itemRight = safeLeft + safeWidth;
  let next: number;
  if (safeLeft < scrollLeft + margin) {
    // 左缘被裁（或离边缘太近）：把按钮左缘放到 margin 内侧。
    next = safeLeft - margin;
  } else if (itemRight > scrollLeft + clientWidth - margin) {
    // 右缘被裁（或离边缘太近）：把按钮右缘放到 margin 内侧。
    next = itemRight - clientWidth + margin;
  } else {
    return scrollLeft;
  }
  return Math.min(max, Math.max(0, next));
}

export interface ViewsOverflow extends ViewOverflowEdges {
  /** 把指定日期视图滚动到可见区（用于键盘聚焦，不影响页面滚动）。 */
  reveal: (viewId: string) => void;
}

interface UseViewsOverflowOptions {
  /** 列表视图未挂载时（编辑态 / 专注 / 统计）不监听 DOM。 */
  enabled?: boolean;
  /** 视觉以外的重排信号（如语言切换），用于重新把当前项带回可见区。 */
  reflowKey?: string;
}

/**
 * 监听 `.tasks-views` 的横向滚动状态与尺寸变化，并处理：
 * - 边缘指示：`start` / `end` 只反映「该方向还有余量」；
 * - 激活项入视：激活视图、语言或挂载状态变化后自动滚动（含键盘 Tab 聚焦）；
 * - 滚轮：仅在横向还能滚动且该方向有余量时把竖向手势映射为横向滚动，
 *   到边界放行默认行为；不拦截 Ctrl+滚轮（捏合缩放）。
 */
export function useViewsOverflow(
  scrollRef: RefObject<HTMLElement | null>,
  activeView: string,
  { enabled = true, reflowKey = "" }: UseViewsOverflowOptions = {},
): ViewsOverflow {
  const [edges, setEdges] = useState<ViewOverflowEdges>(NO_OVERFLOW);
  // 避免把函数写进 state 更新比较：只同步变化后的布尔值，滚动时不触发无意义渲染。
  const edgesRef = useRef<ViewOverflowEdges>(NO_OVERFLOW);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = computeOverflowEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
    const prev = edgesRef.current;
    if (prev.start === next.start && prev.end === next.end) return;
    edgesRef.current = next;
    setEdges(next);
  }, [scrollRef]);

  const reveal = useCallback(
    (viewId: string) => {
      const el = scrollRef.current;
      if (!el) return;
      const target = el.querySelector<HTMLElement>(`[data-view="${viewId}"]`);
      if (!target) return;
      const next = computeRevealScrollLeft({
        scrollLeft: el.scrollLeft,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        itemLeft: target.offsetLeft,
        itemWidth: target.offsetWidth,
      });
      if (Math.abs(next - el.scrollLeft) > 0.5) el.scrollLeft = next;
      update();
    },
    [scrollRef, update],
  );

  // 激活视图变化（含外部下钻）或语言变化后，把当前项带回可见区。
  useLayoutEffect(() => {
    if (!enabled) return;
    reveal(activeView);
  }, [enabled, activeView, reflowKey, reveal]);

  // 每次渲染后同步一次：语言切换改变按钮文本宽度时，不必等容器自身 resize。
  useLayoutEffect(() => {
    if (enabled) update();
  }, [enabled, update]);

  // 滚动 / 容器或按钮尺寸变化：更新边缘指示。
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", update, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(el);
      for (const child of Array.from(el.children)) observer.observe(child);
    }
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [enabled, scrollRef, update]);

  // 鼠标滚轮 / 触摸板竖向手势 → 横向滚动；到边界放行默认行为。
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // 捏合缩放（Ctrl+滚轮）不拦截。
      if (event.ctrlKey) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= VIEW_OVERFLOW_TOLERANCE) return;
      // trackpad 横向手势的 deltaX 优先；普通鼠标滚轮只有 deltaY，映射为横向。
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const step =
        event.deltaMode === 1
          ? delta * 16
          : event.deltaMode === 2
            ? delta * el.clientWidth
            : delta;
      const atStart = el.scrollLeft <= 0;
      const atEnd = el.scrollLeft >= max - 0.5;
      if ((step < 0 && atStart) || (step > 0 && atEnd)) return;
      el.scrollLeft = Math.min(max, Math.max(0, el.scrollLeft + step));
      event.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [enabled, scrollRef]);

  return { start: edges.start, end: edges.end, reveal };
}
