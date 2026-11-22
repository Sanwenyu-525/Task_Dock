//! 空状态基元（验收 UI-09）。
//!
//! 迁移前同一产品有 4 套空态：`.empty-state` 图标圆、`.clip-empty`、
//! `.wf-empty` 虚线框、`.planning-empty-hero` 纯文本。本组件沿用既有的
//! `.empty-state / .empty-icon / .empty-title / .empty-hint` 视觉，
//! 新增 `framed`（添加类空态，虚线框）与 `titleAs`（需要标题语义时用 h3）。
//!
//! 零数据 + 品牌插画（任务页气泡）仍由 TasksPanel 自己维护，不进本组件：
//! 那是产品资产，不是通用空态。

import type { ReactNode } from "react";

interface EmptyStateProps {
  /** 可选：只有一句说明、没有独立标题的空态可省略。 */
  title?: string;
  hint?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  /** 添加类空态：虚线描边 + 近白底，与「筛选为空」区分。 */
  framed?: boolean;
  /** 需要参与文档大纲时传 h3；默认 div（不制造多余标题层级）。 */
  titleAs?: "div" | "h3";
  className?: string;
}

export default function EmptyState({
  title,
  hint,
  icon,
  action,
  framed = false,
  titleAs = "div",
  className,
}: EmptyStateProps) {
  const TitleTag = titleAs;
  return (
    <div className={`empty-state${framed ? " is-framed" : ""}${className ? ` ${className}` : ""}`}>
      {icon ? (
        <div className="empty-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      {title ? <TitleTag className="empty-title">{title}</TitleTag> : null}
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
