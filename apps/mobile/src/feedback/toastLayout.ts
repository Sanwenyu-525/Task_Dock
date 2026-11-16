// Toast 页面锚点的纯计算层：不依赖 React / RN。
// 页面只上报「实际测量到的固定顶部/底部操作区」；Shell 不靠不断累加高度常量。
import type { ToastPlacement } from "./toastQueue";

export interface ToastPageLayout {
  /** 从页面根顶部到固定顶部操作区底部的实际高度。 */
  topInset?: number;
  /** 固定底部操作区实际高度（包含其底部安全区）。 */
  bottomBarHeight?: number;
  /** 键盘弹出时底部操作区是否随键盘上移；true 时 Toast 必须同时避开键盘和操作区。 */
  bottomBarAboveKeyboard?: boolean;
  /** 页面默认位置：顶部操作区过高的页面可以默认落到底部。 */
  defaultPlacement?: ToastPlacement;
}

export type ToastLayouts = Record<string, ToastPageLayout>;

export const EMPTY_TOAST_LAYOUT: ToastPageLayout = {};

const LAYOUT_KEYS = [
  "topInset",
  "bottomBarHeight",
  "bottomBarAboveKeyboard",
  "defaultPlacement",
] as const;

function sameLayoutValue(a: ToastPageLayout, b: ToastPageLayout): boolean {
  return LAYOUT_KEYS.every((key) => a[key] === b[key]);
}

/** 更新单个页面的锚点；相同值返回原 Map，避免 onLayout 造成无意义的重渲染。 */
export function updateToastLayout(
  layouts: ToastLayouts,
  scope: string,
  patch: ToastPageLayout,
): ToastLayouts {
  const current = layouts[scope] ?? {};
  const next: ToastPageLayout = { ...current };
  for (const key of LAYOUT_KEYS) {
    if (patch[key] === undefined) delete next[key];
    else next[key] = patch[key] as never;
  }
  if (sameLayoutValue(current, next)) return layouts;
  return { ...layouts, [scope]: next };
}

/** 页面卸载后清理锚点，避免旧页面高度被新页面继承。 */
export function clearToastLayout(layouts: ToastLayouts, scope: string): ToastLayouts {
  if (!(scope in layouts)) return layouts;
  const next = { ...layouts };
  delete next[scope];
  return next;
}

export function activeToastLayout(layouts: ToastLayouts, scope: string): ToastPageLayout {
  return layouts[scope] ?? EMPTY_TOAST_LAYOUT;
}

/**
 * 顶部锚点：
 * - 页面测量到固定顶部操作区时，使用「状态栏 + 实测高度 + 间距」；
 * - 没有测量值时回退到统一 56dp 标题栏。
 */
export function resolveToastTopOffset({
  safeTop,
  layout,
  defaultHeaderHeight,
  gap,
}: {
  safeTop: number;
  layout: ToastPageLayout;
  defaultHeaderHeight: number;
  gap: number;
}): number {
  const header = layout.topInset && layout.topInset > 0 ? layout.topInset : defaultHeaderHeight;
  return safeTop + header + gap;
}

/**
 * 底部锚点：键盘打开时不能丢掉固定操作区。
 * - 操作区随键盘上移：键盘高度 + 实测操作区高度 + 间距；
 * - 操作区被键盘遮住/不存在：键盘高度 + 间距；
 * - 键盘关闭：实测操作区高度 + 间距，否则回退页面登记值。
 */
export function resolveToastBottomOffset({
  keyboardHeight,
  layout,
  defaultBottomOffset,
  gap,
}: {
  keyboardHeight: number;
  layout: ToastPageLayout;
  defaultBottomOffset: number;
  gap: number;
}): number {
  const barHeight =
    layout.bottomBarHeight && layout.bottomBarHeight > 0 ? layout.bottomBarHeight : 0;
  if (keyboardHeight > 0) {
    return keyboardHeight + (layout.bottomBarAboveKeyboard ? barHeight : 0) + gap;
  }
  return barHeight > 0 ? barHeight + gap : defaultBottomOffset;
}
