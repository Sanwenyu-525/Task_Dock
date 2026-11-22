//! 暂存条目右键菜单（轻量，不使用原生菜单）。
//!
//! 与 DropdownMenu 的分工：卡片「⋯」仍用通用菜单；右键菜单需要按当前多选集合
//! 执行批量动作，且落点是指针位置而不是锚点按钮。Escape/点击外部关闭接入
//! 全局弹层栈，键盘 Up/Down 在菜单项间移动。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";

export interface ShelfContextAction {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export default function ShelfContextMenu({
  open,
  x,
  y,
  label,
  items,
  onClose,
}: {
  open: boolean;
  x: number;
  y: number;
  label: string;
  items: ShelfContextAction[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useOverlayLayer("menu", open, onClose, ref);
  useFocusTrap(open, ref);

  useEffect(() => {
    if (!open) return;
    setPos({ left: x, top: y });
    // 布局后按实际尺寸收敛到视口内，避免靠近右下角时菜单被裁掉。
    const raf = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos({
        left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [open, x, y]);

  // 点击菜单外部关闭；菜单内部的点击由按钮自行处理。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const moveFocus = (direction: 1 | -1) => {
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (current + direction + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return createPortal(
    <div
      ref={ref}
      className="shelf-context-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(-1);
        } else if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={`shelf-context-item${item.danger ? " is-danger" : ""}`}
          disabled={item.disabled}
          {...(index === 0 ? { "data-autofocus": true } : {})}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
        >
          {item.icon && <span className="shelf-context-icon">{item.icon}</span>}
          <span className="shelf-context-label">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
