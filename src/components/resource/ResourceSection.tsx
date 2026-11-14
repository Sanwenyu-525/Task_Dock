//! 资源页专用折叠区块：折叠时**保留**子树（`hidden`），不卸载。
//!
//! 为什么不直接用 `components/ui/CollapsibleSection`：
//! - 公共折叠组件的语义是「折叠即卸载」，适合纯展示的设置分组；
//! - 资源页的空间分析与应用数据占用承载真实扫描结果和按需 IPC：
//!   卸载会丢掉已扫描报告、让「进入磁盘页只统计一次」的既有生命周期失效；
//! - 这里折叠只隐藏内容：不可见时不在可访问性树、不可 Tab 聚焦、不占高度，
//!   但组件状态与已加载数据保留，展开后无需重新扫描。
//!
//! 交互约束：标题按钮是唯一触发点（`aria-expanded` + `aria-controls`），
//! 32px 命中区，箭头旋转 140ms 并尊重 `prefers-reduced-motion`。

import { useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface ResourceSectionProps {
  id?: string;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  icon?: ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}

export default function ResourceSection({
  id,
  title,
  description,
  badge,
  icon,
  expanded,
  onExpandedChange,
  children,
}: ResourceSectionProps) {
  const autoId = useId();
  const sectionId = id ?? `resource-section-${autoId.replace(/:/g, "")}`;
  const bodyId = `${sectionId}-body`;
  return (
    <section className="resource-collapsible" data-resource-collapsible={sectionId}>
      <button
        type="button"
        className="resource-collapsible-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        data-resource-anchor-focus
        onClick={() => onExpandedChange(!expanded)}
      >
        <span className="resource-collapsible-title-row">
          {icon && (
            <span className="resource-collapsible-icon" aria-hidden="true">
              {icon}
            </span>
          )}
          <span className="resource-collapsible-title">{title}</span>
          {badge && <span className="resource-collapsible-badge">{badge}</span>}
          <ChevronRight
            size={12}
            className={`resource-collapsible-chevron${expanded ? " is-open" : ""}`}
            aria-hidden="true"
          />
        </span>
        {description && (
          <span className="resource-collapsible-desc">{description}</span>
        )}
      </button>
      <div id={bodyId} className="resource-collapsible-body" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
