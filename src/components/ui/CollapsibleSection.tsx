//! 可折叠分组（公共组件）：标题 + 可选图标/描述/徽标/右侧操作区 + 内容。
//!
//! 设计约束：
//! - 视觉沿用设置页折叠分组（同一套 Token：圆角/卡面/边框/内边距/箭头）；
//! - 只做受控/非受控展开状态，**不读写 localStorage**：持久化由调用方或
//!   `lib/collapsibleState` 负责，避免视觉组件绑定全局偏好；
//! - 标题区域是独立的触发按钮，右侧操作区是兄弟节点，内部按钮不会误触发折叠；
//! - 折叠时卸载内容（不保留不可见内容的键盘焦点）；若焦点仍在内容内，收回触发按钮。
//!   受控父组件从外部收起时，用布局阶段检查 + 聚焦跟踪恢复焦点，不注册持续监听；
//! - 内容容器始终存在，折叠时 `hidden` + 不渲染子节点，保证 `aria-controls` 指向真实节点；
//! - 箭头 140ms 旋转，尊重 `prefers-reduced-motion`；内容高度不定，不做高度动画。

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface CollapsibleSectionProps {
  /** 标题（纯文本，稳定展示；不用中文标题做持久化键） */
  title: string;
  /** 可选图标（Lucide 图标节点） */
  icon?: ReactNode;
  /** 可选描述，显示在标题下方 */
  description?: ReactNode;
  /** 可选状态 / 数量徽标，显示在标题同一行 */
  badge?: ReactNode;
  /** 可选标题右侧操作区（与折叠触发按钮分离，不误触折叠） */
  actions?: ReactNode;
  /** 受控展开状态（优先）；不传时使用内部状态 */
  expanded?: boolean;
  /** 非受控初始展开状态（默认折叠） */
  defaultExpanded?: boolean;
  /** 展开状态变化回调（受控与非受控都会调用） */
  onExpandedChange?: (expanded: boolean) => void;
  disabled?: boolean;
  /** 稳定 ID，用于 aria-controls；缺省时由 useId 生成 */
  id?: string;
  className?: string;
  children: ReactNode;
}

export default function CollapsibleSection({
  title,
  icon,
  description,
  badge,
  actions,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  disabled = false,
  id,
  className,
  children,
}: CollapsibleSectionProps) {
  const autoId = useId();
  const sectionId = id ?? `collapsible-${autoId.replace(/[:]/g, "")}`;
  const bodyId = `${sectionId}-body`;
  const sectionRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 焦点最近一次是否落在内容区：布局阶段据此判断是否收回触发按钮。 */
  const hadBodyFocusRef = useRef(false);
  const wasOpenRef = useRef(expanded ?? defaultExpanded);
  const [internalOpen, setInternalOpen] = useState(defaultExpanded);
  const open = expanded ?? internalOpen;

  // 受控父组件在外部收起时，内容子树已卸载；若焦点因此落到文档根，收回触发按钮。
  // 不监听 document，不做定时器；只在展开状态真实变化时执行一次。
  useLayoutEffect(() => {
    if (wasOpenRef.current && !open && hadBodyFocusRef.current) {
      const active = document.activeElement;
      if (!active || active === document.body || !sectionRef.current?.contains(active)) {
        toggleRef.current?.focus({ preventScroll: true });
      }
      hadBodyFocusRef.current = false;
    }
    wasOpenRef.current = open;
  }, [open]);

  function toggle() {
    if (disabled) return;
    const next = !open;
    // 折叠会卸载内容：先确认焦点不在即将消失的区域，避免焦点落到文档根。
    if (!next && bodyRef.current?.contains(document.activeElement)) {
      toggleRef.current?.focus({ preventScroll: true });
    }
    if (expanded === undefined) setInternalOpen(next);
    onExpandedChange?.(next);
  }

  return (
    <section
      ref={sectionRef}
      className={`collapsible-section${icon ? " has-icon" : ""}${
        className ? ` ${className}` : ""
      }`}
      data-collapsible-section={sectionId}
    >
      <div className="collapsible-head">
        <button
          ref={toggleRef}
          type="button"
          className="collapsible-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          disabled={disabled}
          onClick={toggle}
        >
          <span className="collapsible-text">
            {/* 箭头与标题行同一层：与标题单行垂直居中，而不是与「标题 + 描述」整体居中。 */}
            <span className="collapsible-title-row">
              <span className="collapsible-title">
                {icon && (
                  <span className="collapsible-icon" aria-hidden="true">
                    {icon}
                  </span>
                )}
                <span className="collapsible-title-text">{title}</span>
                {badge && <span className="collapsible-badge">{badge}</span>}
              </span>
              <ChevronRight
                size={12}
                className={`collapsible-chevron${open ? " is-open" : ""}`}
                aria-hidden="true"
              />
            </span>
            {description && <span className="collapsible-desc">{description}</span>}
          </span>
        </button>
        {actions && <div className="collapsible-actions">{actions}</div>}
      </div>
      <div
        ref={bodyRef}
        className="collapsible-body"
        id={bodyId}
        hidden={!open}
        onFocus={() => {
          hadBodyFocusRef.current = true;
        }}
        onBlur={(event) => {
          // 焦点离开内容区（含移出组件）时清除标记；折叠卸载期间的失焦不改变标记，
          // 由布局阶段的 activeElement 兜底判断。
          const next = event.relatedTarget as Node | null;
          if (!next || !event.currentTarget.contains(next)) {
            hadBodyFocusRef.current = false;
          }
        }}
      >
        {open ? children : null}
      </div>
    </section>
  );
}
