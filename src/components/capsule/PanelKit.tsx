//! 胶囊面板的通用外壳与基元（**纯展示**，不含业务逻辑）。
//!
//! 四个面板（任务 / Agent / 剪贴板 / 应用）共用同一套标题、摘要、分段筛选、
//! 空状态与底栏，避免出现四套圆角、边框、间距。样式全部落在 `styles.css`
//! 的 `cap-*` 类上，组件这里只做结构，不内联颜色。
//!
//! 设计口径（对照 `docs/design-refs/v07/停靠效果图/01..04`）：
//! - 标题 19px / 说明 11.5px，右侧 30px 玻璃图标按钮；
//! - 分段筛选是内凹容器 + 白色凸起药丸；
//! - 列表项是单层白玻璃卡（14px 圆角），层级只靠内高光与极轻投影。

import type { ReactNode } from "react";

export function PanelHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="cap-head">
      <div className="cap-head-text">
        <span className="cap-title">{title}</span>
        {sub ? <span className="cap-sub">{sub}</span> : null}
      </div>
      {actions ? <div className="cap-actions">{actions}</div> : null}
    </header>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

/**
 * 分段筛选。`role="tablist"` + `aria-selected` 让读屏能读出当前筛选，
 * 视觉上只用白色药丸表达选中（不加粗边框，避免「四个按钮四个框」）。
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="cap-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          className="cap-seg-btn"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  text,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="cap-empty">
      {icon}
      <p>{text}</p>
      {actionLabel && onAction ? (
        <button type="button" className="cap-link" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/** 字节数 → 紧凑文案（1.2 MB / 320 KB / 800 B）。仅展示，不参与判定。 */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
