//! 行动入口统一图标「Pointer Click（指针点击）」。
//!
//! 语义：一只带闪光线的指针，表达「由用户点选触发的行动」。
//! 几何取自根目录提供的 `01-pointer-click.svg`（viewBox `0 0 24 24`），
//! 只用于完整模式左侧导航的「行动」入口，不改动其它闪电语义的图标。
//!
//! 约定（与 AgentIcon 一致）：
//! - 内联 SVG，不引入外部 SVG 文件请求，也不引入第三方依赖；
//! - 颜色一律 currentColor，跟随父元素文字色（正常/悬停/选中/禁用都由现有状态色驱动，
//!   组件自己不带固定色、渐变、阴影或背景底板）；
//! - viewBox 固定 `0 0 24 24`，宽高同时由 `size` 决定，等比缩放不裁剪；
//! - 默认 `aria-hidden="true"`：图标不参与朗读，可访问名由所在按钮的 aria-label 提供。

import type { CSSProperties } from "react";

export type PointerClickIconProps = {
  /** 图标边长（px）。宽高同值，保持 1:1 等比缩放。 */
  size?: number;
  /** 线宽。默认 1.75，与相邻导航图标一致。 */
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
};

export default function PointerClickIcon({
  size = 18,
  strokeWidth = 1.75,
  className,
  style,
  "aria-hidden": ariaHidden = true,
}: PointerClickIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden={ariaHidden}
      focusable="false"
      data-action-icon="pointer-click"
    >
      <path d="m7.4 3.2 1.7 14 3.4-3.2 3.1 6.2 2.9-1.6-3.2-5.9 4.6-.8L7.4 3.2Z" />
      <path d="M3.6 3.5 2 1.9M11.9 2.5v2M2.5 9h2.1" />
    </svg>
  );
}
