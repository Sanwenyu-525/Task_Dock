//! 状态徽标（公共组件）：只负责「语义色 + 尺寸 + 图标」的视觉呈现。
//!
//! 边界：
//! - 业务状态枚举到 tone 的映射留在业务层（例如 Agent 健康状态、规划状态），
//!   组件不内置任何业务判断，也不读取数据；
//! - 颜色复用 `--status-*` / `--accent` / `--text-tertiary` 语义 Token，
//!   深浅主题与两套视觉预设共用同一份结构；
//! - 长文案允许换行，不强行 nowrap 撑破窄卡片。

import type { ReactNode } from "react";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusBadgeProps {
  tone: StatusTone;
  size?: "sm" | "md";
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 统一提示气泡内容（使用 data-tip，不用原生 title） */
  dataTip?: string;
}

export default function StatusBadge({
  tone,
  size = "md",
  icon,
  children,
  className,
  dataTip,
}: StatusBadgeProps) {
  return (
    <span
      className={`ui-status-badge tone-${tone} size-${size}${
        className ? ` ${className}` : ""
      }`}
      data-tone={tone}
      data-tip={dataTip}
    >
      {icon}
      {children}
    </span>
  );
}
