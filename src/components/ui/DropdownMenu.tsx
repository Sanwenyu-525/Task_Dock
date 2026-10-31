//! 操作菜单（DropdownMenu）：锚定触发器 + role="menu" 列表。
//!
//! 键盘：↑↓ 移动 · Enter/Space 触发 · Home/End 跳首尾 · Esc 只关本层 ·
//! 字母键快速定位。禁用项不可触发，单选组用 menuitemradio + aria-checked。

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import Popover from "./Popover";
import { scrollIntoViewIfNeeded } from "./overlay";

export interface DropdownMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  description?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** 单选组：渲染为 menuitemradio 并带 aria-checked */
  radio?: boolean;
  checked?: boolean;
  onSelect?: () => void;
}

export interface DropdownMenuTriggerProps {
  ref: (el: HTMLElement | null) => void;
  expanded: boolean;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

export interface DropdownMenuProps {
  trigger: (props: DropdownMenuTriggerProps) => ReactNode;
  items: ReadonlyArray<DropdownMenuItem>;
  menuLabel?: string;
  /** bottom/top = 相对触发器水平居中；start/end 对齐左右缘 */
  placement?: "bottom" | "bottom-start" | "bottom-end" | "top" | "top-start" | "top-end";
  matchWidth?: boolean;
  /** 菜单目标最小宽度（px）：按最长选项文本 + 图标 + 勾选标记 + 内边距声明，
   *  内容更宽时仍会自然增长，绝不截断选项 */
  menuMinWidth?: number;
  className?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function DropdownMenu({
  trigger,
  items,
  menuLabel,
  placement = "bottom-end",
  matchWidth = false,
  menuMinWidth,
  className,
  disabled = false,
  onOpenChange,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const anchorRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const typeRef = useRef({ text: "", at: 0 });

  function setOpenState(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }

  function enabledIndexes() {
    return items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  }

  function openMenu() {
    const idxs = enabledIndexes();
    const checked = items.findIndex((it) => it.checked);
    const start = checked >= 0 && !items[checked].disabled ? checked : idxs[0] ?? -1;
    setActiveIndex(start);
    setOpenState(true);
  }

  useEffect(() => {
    if (!open) return;
    // 展开后把焦点交给菜单（role=menu 的焦点管理）
    const raf = requestAnimationFrame(() => {
      const target = menuRef.current?.querySelector<HTMLElement>(`#${menuId}-item-${activeIndex}`);
      target?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, activeIndex, menuId]);

  useEffect(() => {
    if (!open) return;
    const item = menuRef.current?.querySelector<HTMLElement>(`#${menuId}-item-${activeIndex}`);
    scrollIntoViewIfNeeded(menuRef.current, item);
  }, [open, activeIndex, menuId]);

  function step(from: number, dir: 1 | -1) {
    const idxs = enabledIndexes();
    if (idxs.length === 0) return -1;
    const pos = idxs.indexOf(from);
    if (pos < 0) return dir === 1 ? idxs[0] : idxs[idxs.length - 1];
    const next = idxs[(pos + dir + idxs.length) % idxs.length];
    return next;
  }

  function activate(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    setOpenState(false);
    item.onSelect?.();
  }

  function typeahead(ch: string) {
    const now = Date.now();
    const t = typeRef.current;
    t.text = now - t.at > 600 ? ch : t.text + ch;
    t.at = now;
    const q = t.text.toLowerCase();
    const idxs = enabledIndexes();
    const start = idxs.findIndex((i) => i > activeIndex);
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[(Math.max(0, start) + k) % idxs.length];
      if (items[i].label.toLowerCase().startsWith(q)) {
        setActiveIndex(i);
        return;
      }
    }
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => step(i, 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => step(i, -1));
        return;
      case "Home":
        e.preventDefault();
        setActiveIndex(enabledIndexes()[0] ?? -1);
        return;
      case "End":
        e.preventDefault();
        setActiveIndex(enabledIndexes().slice(-1)[0] ?? -1);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        activate(activeIndex);
        return;
      case "Tab":
        setOpenState(false);
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) typeahead(e.key);
    }
  }

  return (
    <>
      {trigger({
        ref: (el) => {
          anchorRef.current = el;
        },
        expanded: open,
        onClick: () => {
          if (disabled) return;
          if (open) setOpenState(false);
          else openMenu();
        },
        onKeyDown: (e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) openMenu();
            else setActiveIndex((i) => step(i, e.key === "ArrowDown" ? 1 : -1));
          }
        },
      })}

      <Popover
        open={open}
        onOpenChange={setOpenState}
        anchorRef={anchorRef}
        placement={placement}
        matchWidth={matchWidth}
        style={menuMinWidth ? ({ "--menu-min-w": `${menuMinWidth}px` } as CSSProperties) : undefined}
        className={`ui-menu-popover ${className ?? ""}`}
        role="menu"
        ariaLabel={menuLabel}
      >
        <div className="ui-menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          {items.map((it, i) => (
            <button
              key={it.key}
              id={`${menuId}-item-${i}`}
              type="button"
              role={it.radio ? "menuitemradio" : "menuitem"}
              aria-checked={it.radio ? !!it.checked : undefined}
              aria-disabled={it.disabled || undefined}
              tabIndex={i === activeIndex ? 0 : -1}
              className={`ui-menu-item ${it.checked ? "is-checked" : ""} ${it.danger ? "is-danger" : ""} ${
                it.disabled ? "is-disabled" : ""
              } ${i === activeIndex ? "is-active" : ""}`}
              onMouseEnter={() => !it.disabled && setActiveIndex(i)}
              onClick={() => activate(i)}
            >
              {it.icon ? <span className="ui-menu-icon">{it.icon}</span> : null}
              <span className="ui-menu-text">
                <span className="ui-menu-label">{it.label}</span>
                {it.description ? <em className="ui-menu-desc">{it.description}</em> : null}
              </span>
              {/* 单选项勾选标记：与右键菜单统一「选中」视觉词汇（此前仅底色+字重） */}
              {it.trailing ? (
                <span className="ui-menu-trailing">{it.trailing}</span>
              ) : it.radio ? (
                <span className="ui-menu-trailing" aria-hidden="true">
                  {it.checked ? <Check size={14} strokeWidth={2.5} /> : null}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
