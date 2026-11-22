//! 模块 / 页面级导航（<nav> + aria-current="page"）。
//!
//! 与 SectionTabs 的分工见 docs/ui-themes/15-section-navigation.md §2：
//! 这里切的是「去哪个模块」，内容区不是 tabpanel，因此不用 roving tabindex——
//! Tab 键逐项停靠；方向键 / Home / End 只移动焦点，激活由 Enter/Space 走原生
//! button click（沿用工作空间既有 moveNavFocus 契约，避免方向键误触切换门禁）。

import { useCallback, useEffect, useRef } from "react";
import type { ComponentType } from "react";
import { isNavKey, nextNavIndex } from "./sectionNavKeyboard";
import "./section-navigation.css";

export interface SectionNavItem<T extends string = string> {
  id: T;
  label: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  disabled?: boolean;
}

export interface SectionNavigationProps<T extends string = string> {
  items: readonly SectionNavItem<T>[];
  activeId: T;
  onSelect: (id: T) => void;
  "aria-label": string;
  size?: "md" | "sm";
  className?: string;
}

export default function SectionNavigation<T extends string = string>({
  items,
  activeId,
  onSelect,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: SectionNavigationProps<T>) {
  const navRef = useRef<HTMLElement>(null);

  // 横向溢出时保证当前模块可见
  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!isNavKey(event.key)) return;
    // 单一事实源 = DOM 列表（沿用工作空间旧 moveNavFocus 契约）：
    // 方向键/Home/End 只移动焦点，激活交给 Enter/Space 原生 click。
    const navItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[data-nav-item="true"]:not(:disabled)',
      ),
    );
    if (navItems.length === 0) return;
    const current = navItems.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextNavIndex(event.key, current, navItems.length);
    if (next < 0) return;
    event.preventDefault();
    navItems[next]?.focus();
  }, []);

  return (
    <nav
      ref={navRef}
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
            data-nav-item="true"
            aria-current={active ? "page" : undefined}
            disabled={item.disabled}
            className={`section-nav-item${active ? " is-active" : ""}`}
            onClick={() => onSelect(item.id)}
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
    </nav>
  );
}
