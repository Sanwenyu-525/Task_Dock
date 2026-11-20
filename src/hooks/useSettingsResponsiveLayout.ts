//! 设置工作区响应式布局模式（2026-11-20 设置中心重构）。
//!
//! 判断依据是**设置内容区自身宽度**（容器查询容器 `.settings-panel.page-fill`），
//! 不是窗口宽度：全局左导航可拖拽（96–320px）、右详情栏可开合，窗口宽度无法
//! 反映设置工作区的真实可用空间。
//!
//! - CSS 侧用 `@container settings-page (…)` 表达同一组断点（settings-page.css，
//!   两处常量互为镜像，改一处必须同步另一处）；
//! - TS 只在「必须知道布局模式才能换 DOM 结构」的两处消费：导航组件的
//!   树形/紧凑切换与 aria-orientation；
//! - 单一 ResizeObserver 实例挂在容器节点上，设置模块内禁止自建第二套监听。

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * 断点（逻辑像素，测量对象 = settings-page 容器内容宽度）：
 * - ≥1100：导航 200px，内容可双栏（配置 + 预览）；
 * - 760–1099：导航 176px，内容单列；
 * - <760：导航折叠为顶部紧凑条，内容独占宽度。
 */
export const SETTINGS_CONTAINER_WIDE_MIN = 1100;
export const SETTINGS_CONTAINER_MEDIUM_MIN = 760;

export type SettingsLayoutMode = "wide" | "medium" | "narrow";

function modeFor(width: number): SettingsLayoutMode {
  if (width >= SETTINGS_CONTAINER_WIDE_MIN) return "wide";
  if (width >= SETTINGS_CONTAINER_MEDIUM_MIN) return "medium";
  return "narrow";
}

const SUPPORTED =
  typeof window !== "undefined" && typeof ResizeObserver === "function";

/**
 * 监听设置容器宽度并返回布局模式。
 *
 * `ref` 指向 `.settings-panel` 根节点（container-type: inline-size）；
 * 容器缺省 / ResizeObserver 不可用（jsdom、老 WebView）时退回 "medium"——
 * 树形导航在任何环境都可渲染，不会因为能力缺失丢失导航。
 */
export function useSettingsResponsiveLayout(
  containerRef: RefObject<HTMLElement | null>,
): SettingsLayoutMode {
  const [mode, setMode] = useState<SettingsLayoutMode>("medium");
  const modeRef = useRef<SettingsLayoutMode>("medium");
  modeRef.current = mode;

  useEffect(() => {
    const node = containerRef.current;
    if (!node || !SUPPORTED) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width <= 0) return;
      const next = modeFor(width);
      setMode((prev) => (prev === next ? prev : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerRef]);

  return mode;
}
