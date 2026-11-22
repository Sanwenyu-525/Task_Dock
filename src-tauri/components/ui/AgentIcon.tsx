//! Agent 统一图标「Orbit Core（轨道智能核心）」。
//!
//! 语义：三段轨道弧 + 三个外围节点表达多 Agent 协作，中央实心节点表达智能核心。
//! 项目里所有「表示 Agent」的位置都只用这一个组件，禁止各页面自行复制 SVG 源码。
//!
//! 约定：
//! - 内联 SVG，不引入外部 SVG 文件请求，也不引入第三方依赖；
//! - 颜色一律 currentColor，跟随父元素文字色（正常/悬停/选中/禁用都由现有状态色驱动，
//!   组件自己不带品牌色、渐变、阴影或背景底板）；
//! - viewBox 固定 `0 0 24 24`，宽高同时由 `size` 决定，等比缩放不裁剪；
//! - 默认 `aria-hidden="true"`：图标不参与朗读，可访问名由所在按钮/文字的 aria-label 提供，
//!   避免同一入口被读两遍。

import type { ComponentType, CSSProperties } from "react";

export type AgentIconProps = {
  /** 图标边长（px）。宽高同值，保持 1:1 等比缩放。 */
  size?: number;
  /** 线宽。小尺寸（≤12px）下轨道弧会略微发虚，调用方可单独提到 1.9~2 兼顾辨识度。 */
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
};

/** 通用图标组件契约：Lucide 图标与 AgentIcon 都能赋值，便于在同一张表里混排。 */
export type IconComponent = ComponentType<AgentIconProps>;

export default function AgentIcon({
  size = 18,
  strokeWidth = 1.75,
  className,
  style,
  "aria-hidden": ariaHidden = true,
}: AgentIconProps) {
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
      data-agent-icon="orbit-core"
    >
      <path d="M12 5.2a6.8 6.8 0 0 1 5.7 3.1" />
      <path d="M18.1 14.2a6.8 6.8 0 0 1-5.1 4.6" />
      <path d="M8.6 18a6.8 6.8 0 0 1-3.1-8.6" />
      <circle cx="12" cy="4.1" r="1.5" />
      <circle cx="18.8" cy="15.1" r="1.5" />
      <circle cx="5.2" cy="16.2" r="1.5" />
      <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
