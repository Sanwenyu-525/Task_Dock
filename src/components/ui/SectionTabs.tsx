//! 页面内内容面板切换（WAI-ARIA Tabs，自动激活）。
//!
//! 与 SectionNavigation 的分工见 docs/ui-themes/15-section-navigation.md §2：
//! 这里切的是「内容面板」，用 tablist/tab/tabpanel 语义；roving tabindex，
//! 焦点即选中，←/→/↑/↓、Home/End 移动焦点并自动激活；disabled 项不参与
//! 焦点与激活。Enter/Space 走原生 button click，不在此拦截。
//!
//! 面板由调用方渲染并保持 ID 关联：
//!   id={`${idPrefix}-panel-${id}`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${id}`}

import { useCallback, useEffect, useRef } from "react";
import type { ComponentType } from "react";
import { isNavKey, nextNavIndex } from "./sectionNavKeyboard";
import "./section-navigation.css";

export interface SectionTabItem<T extends string = string> {
  id: T;
  label: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  disabled?: boolean;
}

export interface SectionTabsProps<T extends string = string> {
  items: readonly SectionTabItem<T>[];
  activeId: T;
  onChange: (id: T) => void;
  "aria-label": string;
  /** 稳定 ID 基：tab `${idPrefix}-tab-${id}`，panel `${idPrefix}-panel-${id}`。 */
  idPrefix: string;
  size?: "md" | "sm";
  className?: string;
}

export default function SectionTabs<T extends string = string>({
  items,
  activeId,
  onChange,
  idPrefix,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: SectionTabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  // 横向溢出时保证选中项可见（窄容器轨道滚动）
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!isNavKey(event.key)) return;
      // 单一事实源 = DOM 列表：disabled 无论是 props 还是调用方直接置灰都生效。
      const tabs = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
      );
      if (tabs.length === 0) return;
      const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
      const next = nextNavIndex(event.key, current, tabs.length);
      if (next < 0) return;
      event.preventDefault();
      const target = tabs[next];
      target?.focus();
      const id = target?.dataset.sectionTabId as T | undefined;
      // 自动激活；已选中项不重复触发
      if (id && id !== activeId) onChange(id);
    },
    [activeId, onChange],
  );

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      data-size={size}
      className={`section-nav${className ? ` ${className}` : ""}`}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-section-tab-id={item.id}
            id={`${idPrefix}-tab-${item.id}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${item.id}`}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            className={`section-nav-item${active ? " is-active" : ""}`}
            onClick={() => onChange(item.id)}
          >
            {Icon ? (
              <Icon
                size={size === "sm" ? 13 : 14}
                strokeWidth={1.8}
                className="section-nav-icon"
                aria-hidden="true"
              />
            ) : null}
            <span className="section-nav-text">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
