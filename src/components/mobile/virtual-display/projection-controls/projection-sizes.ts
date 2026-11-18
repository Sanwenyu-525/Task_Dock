//! 投屏导航栏尺寸规范（逻辑 px，与 Rust `projection_layout.rs` 常量同源）。
//!
//! 这里的数值是 CSS 逻辑像素：WebView 随系统 DPI 缩放，CSS px 自动适配，
//! 因此所有尺寸函数都接受 DPI 仅用于换算物理像素（调试/测试口径），
//! CSS 本身直接用逻辑常量。**不能只放大图标而不扩大点击热区。**

import { DPI_SCALE_MIN } from "./projection-constants";

/** 按钮点击区域（逻辑 px）——Windows 桌面触达规范 48–56px。 */
export const NAV_BUTTON_LOGICAL = 52;
/** 图标视觉尺寸（逻辑 px）。 */
export const NAV_ICON_LOGICAL = 20;
/** 容器内边距（逻辑 px）。 */
export const NAV_PADDING_LOGICAL = 12;
/** 按钮间距（逻辑 px）。 */
export const NAV_GAP_LOGICAL = 8;
/** 导航列宽（逻辑 px）= 按钮 + 左右内边距 + 呼吸空间。 */
export const NAV_COLUMN_LOGICAL = 88;
/** Side 模式下导航 WebView 向左溢出给 Tooltip/菜单的逻辑宽度。 */
export const NAV_TOOLTIP_PAD_LOGICAL = 104;
/** 底部条模式下导航条上方的 Tooltip 余量（逻辑 px）。 */
export const NAV_BOTTOM_PAD_LOGICAL = 24;
/** Tooltip 显示延迟 / 隐藏延迟（ms）。 */
export const TOOLTIP_SHOW_DELAY_MS = 350;
export const TOOLTIP_HIDE_DELAY_MS = 120;

export function dpiScale(dpi: number): number {
  const scale = dpi > 0 ? dpi / 96 : 1;
  return Math.max(DPI_SCALE_MIN, scale);
}

/** 按钮物理点击区（调试/验收口径；CSS 用逻辑值）。 */
export function getNavigationButtonSize(dpi = 96): number {
  return Math.round(NAV_BUTTON_LOGICAL * dpiScale(dpi));
}

/** 按钮间距物理值。 */
export function getNavigationSpacing(dpi = 96): number {
  return Math.round(NAV_GAP_LOGICAL * dpiScale(dpi));
}

/**
 * 导航容器尺寸（物理 px）。
 *
 * @param buttonCount 参与排布的按钮数（禁用按钮仍占位，计入）
 * @param orientation vertical = Side/Compact 列；horizontal = Bottom 条
 */
export function getNavigationContainerSize(
  buttonCount: number,
  orientation: "vertical" | "horizontal",
  dpi = 96,
): { width: number; height: number } {
  const scale = dpiScale(dpi);
  const count = Math.max(0, buttonCount);
  if (orientation === "vertical") {
    const content = count * NAV_BUTTON_LOGICAL + Math.max(0, count - 1) * NAV_GAP_LOGICAL;
    return {
      width: Math.round(NAV_COLUMN_LOGICAL * scale),
      height: Math.round((content + 2 * NAV_PADDING_LOGICAL) * scale),
    };
  }
  const content = count * NAV_BUTTON_LOGICAL + Math.max(0, count - 1) * NAV_GAP_LOGICAL;
  return {
    width: Math.round((content + 2 * NAV_PADDING_LOGICAL) * scale),
    height: Math.round((NAV_BUTTON_LOGICAL + 2 * NAV_PADDING_LOGICAL) * scale),
  };
}

/** 导航列物理宽（Side/Compact 模式，含 Tooltip 溢出区的是 webview 而非列本身）。 */
export function getNavigationColumnSize(dpi = 96): number {
  return Math.round(NAV_COLUMN_LOGICAL * dpiScale(dpi));
}
