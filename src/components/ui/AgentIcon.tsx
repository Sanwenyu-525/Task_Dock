//! Agent 统一图标「机器人」。
//!
//! 语义：机器人头部、天线、双眼与身体轮廓，表达 Agent 作为可执行智能体。
//! 项目里所有「表示 Agent」的位置都只用这一个组件，禁止各页面自行复制 SVG 源码。
//!
//! 约定：
//! - 内联 SVG（Lucide Bot），不引入外部 SVG 文件请求；
//! - 颜色一律 currentColor，跟随父元素文字色（正常/悬停/选中/禁用都由现有状态色驱动，
//!   组件自己不带品牌色、渐变、阴影或背景底板）；
//! - viewBox 固定 `0 0 24 24`，宽高同时由 `size` 决定，等比缩放不裁剪；
//! - 默认 `aria-hidden="true"`：图标不参与朗读，可访问名由所在按钮/文字的 aria-label 提供，
//!   避免同一入口被读两遍。

import type { ComponentType, CSSProperties } from "react";
import { Bot } from "lucide-react";

export type AgentIconProps = {
  /** 图标边长（px）。宽高同值，保持 1:1 等比缩放。 */
  size?: number;
  /** 线宽。小尺寸（≤12px）下机器人轮廓会略微发虚，调用方可单独提到 1.9~2 兼顾辨识度。 */
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
    <Bot
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={style}
      aria-hidden={ariaHidden}
      focusable="false"
      data-agent-icon="robot"
    />
  );
}
