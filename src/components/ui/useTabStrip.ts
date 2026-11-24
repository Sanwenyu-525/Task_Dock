//! 横向 tab 的滑动指示条（全局动画层，`tab-strip.css` 负责画）。
//!
//! 用法（任何 `role="tablist"` 容器都适用）：
//! ```tsx
//! const { stripRef, pillProps } = useTabStrip(activeId, { variant: "raised" });
//! <div ref={stripRef} role="tablist" aria-label="…">
//!   <span {...pillProps} />
//!   <button role="tab" aria-selected={active}>…</button>
//! </div>
//! ```
//!
//! 设计取舍：
//! - **不假设等宽**：几何靠测量选中项，所以文字长短、图标有无、滚动位置都不会错位；
//! - 首帧在 `useLayoutEffect` 里同步定位，不会从左上角滑入；后续切换走 CSS 过渡；
//! - 轨道或项尺寸变化（容器缩放、计数从 228 变 231、字体加载完成）用 `ResizeObserver`
//!   重测，避免指示条停在旧宽度；
//! - 没有选中项时摘掉 `data-tab-pill`，指示条不显示；
//! - jsdom 里 `offsetLeft/offsetWidth` 都是 0，测试只断言属性与变量，不断言像素坐标。

import { useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import "./tab-strip.css";

export type TabStripVariant = "raised" | "accent" | "seg";

export interface TabStripOptions {
  /** 指示条外观：`raised` 抬升白面 / `accent` 主题色轻底 / `seg` 分段控件色。 */
  variant?: TabStripVariant;
  /** 选中项选择器；默认标准 `role="tab"` + `aria-selected`。 */
  activeSelector?: string;
  /** 关掉时只移除指示条，不影响轨道本身。 */
  enabled?: boolean;
}

export interface TabStripPillProps {
  className: string;
  "data-variant": TabStripVariant;
  "aria-hidden": true;
}

export interface TabStripHandle<T extends HTMLElement> {
  stripRef: MutableRefObject<T | null>;
  pillProps: TabStripPillProps;
}

const DEFAULT_ACTIVE_SELECTOR = '[role="tab"][aria-selected="true"]';

/** 写几何变量；`offsetLeft/Top` 是相对轨道 padding 边的坐标，与绝对定位基准一致。 */
function applyGeometry(strip: HTMLElement, active: HTMLElement): void {
  strip.style.setProperty("--ui-tab-pill-x", `${active.offsetLeft}px`);
  strip.style.setProperty("--ui-tab-pill-y", `${active.offsetTop}px`);
  strip.style.setProperty("--ui-tab-pill-w", `${active.offsetWidth}px`);
  strip.style.setProperty("--ui-tab-pill-h", `${active.offsetHeight}px`);
  strip.setAttribute("data-tab-pill", "ready");
}

export function useTabStrip<T extends HTMLElement = HTMLDivElement>(
  activeKey: string | number,
  {
    variant = "accent",
    activeSelector = DEFAULT_ACTIVE_SELECTOR,
    enabled = true,
  }: TabStripOptions = {},
): TabStripHandle<T> {
  const stripRef = useRef<T | null>(null);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || !enabled) return;

    let frame: number | null = null;

    const run = () => {
      frame = null;
      const active = strip.querySelector<HTMLElement>(activeSelector);
      if (!active) {
        strip.removeAttribute("data-tab-pill");
        return;
      }
      applyGeometry(strip, active);
    };

    // 首帧同步：避免挂载后可见的「从 0 滑到目标」。
    run();

    const schedule = () => {
      if (frame !== null) return;
      if (typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(run);
      } else {
        frame = window.setTimeout(run, 0) as unknown as number;
      }
    };

    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (observer) {
      observer.observe(strip);
      strip.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab) => observer.observe(tab));
    }

    // WebView 首次加载字体时会重排一次，宽度可能变；字体就绪后补测一遍。
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready.then(schedule).catch(() => {});

    return () => {
      if (frame !== null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
        else window.clearTimeout(frame);
      }
      observer?.disconnect();
    };
  }, [activeKey, activeSelector, enabled]);

  return {
    stripRef,
    pillProps: {
      className: "ui-tab-pill",
      "data-variant": variant,
      "aria-hidden": true,
    },
  };
}
