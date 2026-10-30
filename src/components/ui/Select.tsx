//! 单选下拉（Select-Only Combobox 模式）。
//!
//! 焦点始终留在触发按钮上，展开态用 `aria-activedescendant` 指向当前高亮项，
//! 因此键盘用户不会在 DOM 焦点与视觉高亮之间「掉队」。
//!
//! 行为：点击展开/收起 · 外部点击关闭 · Escape 只关本层 · ↑↓ 导航 ·
//! Enter/Space 选择 · Home/End 跳首尾 · Tab 正常离开 · 禁用项不可选。

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Check } from "lucide-react";
import Popover from "./Popover";
import { scrollIntoViewIfNeeded } from "./overlay";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
  hint?: string;
}

export interface SelectProps<T extends string = string> {
  value: T | "" | null | undefined;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  id?: string;
  className?: string;
  triggerClassName?: string;
  size?: "sm" | "md";
  /** 弹出层对齐方式 */
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
  /** 触发按钮宽度策略 */
  block?: boolean;
}

export default function Select<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = "请选择",
  disabled = false,
  ariaLabel,
  id,
  className,
  triggerClassName,
  size = "md",
  placement = "bottom-start",
  block = false,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const typeRef = useRef({ text: "", at: 0 });

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const firstEnabled = () => options.findIndex((o) => !o.disabled);
  const lastEnabled = () => {
    for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
    return -1;
  };
  const step = (from: number, dir: 1 | -1) => {
    if (options.length === 0) return -1;
    let i = from;
    for (let n = 0; n < options.length; n++) {
      i = (i + dir + options.length) % options.length;
      if (!options[i].disabled) return i;
    }
    return -1;
  };

  // 展开后把高亮项滚进可视区域
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const item = listRef.current?.querySelector<HTMLElement>(`#${cssEscape(listId)}-opt-${activeIndex}`);
    scrollIntoViewIfNeeded(listRef.current, item);
  }, [open, activeIndex, listId]);

  function openMenu(startIndex?: number) {
    const idx = startIndex ?? (selectedIndex >= 0 ? selectedIndex : firstEnabled());
    setActiveIndex(idx);
    setOpen(true);
  }

  function commit(index: number) {
    const opt = options[index];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    anchorRef.current?.focus();
  }

  function typeahead(ch: string) {
    const now = Date.now();
    const t = typeRef.current;
    t.text = now - t.at > 600 ? ch : t.text + ch;
    t.at = now;
    const q = t.text.toLowerCase();
    const start = activeIndex >= 0 ? activeIndex + 1 : 0;
    for (let k = 0; k < options.length; k++) {
      const i = (start + k) % options.length;
      if (options[i].disabled) continue;
      if (options[i].label.toLowerCase().startsWith(q)) {
        setActiveIndex(i);
        return;
      }
    }
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        openMenu(open ? step(activeIndex, 1) : selectedIndex >= 0 ? step(selectedIndex, 1) : firstEnabled());
        return;
      case "ArrowUp":
        e.preventDefault();
        openMenu(open ? step(activeIndex, -1) : selectedIndex >= 0 ? step(selectedIndex, -1) : lastEnabled());
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (open) commit(activeIndex);
        else openMenu();
        return;
      case "Home":
        if (open) {
          e.preventDefault();
          setActiveIndex(firstEnabled());
        }
        return;
      case "End":
        if (open) {
          e.preventDefault();
          setActiveIndex(lastEnabled());
        }
        return;
      case "Tab":
        // Tab 正常离开：收起菜单但不拦截焦点移动
        if (open) setOpen(false);
        return;
      default:
        if (open && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          typeahead(e.key);
        }
    }
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        id={id}
        className={`ui-select-trigger size-${size} ${block ? "block" : ""} ${open ? "is-open" : ""} ${
          selected ? "" : "is-placeholder"
        } ${triggerClassName ?? ""} ${className ?? ""}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="ui-select-value">
          {selected ? (
            <>
              {selected.icon ? <span className="ui-select-icon">{selected.icon}</span> : null}
              <span className="ui-select-label">{selected.label}</span>
              {selected.hint ? <span className="ui-select-hint">{selected.hint}</span> : null}
            </>
          ) : (
            <span className="ui-select-label">{placeholder}</span>
          )}
        </span>
        <ChevronDown size={13} className="ui-select-caret" aria-hidden="true" />
      </button>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement={placement}
        matchWidth
        className="ui-select-popover"
        role="listbox"
        id={listId}
        ariaLabel={ariaLabel}
      >
        <div className="ui-listbox" ref={listRef}>
          {options.length === 0 && <div className="ui-listbox-empty">暂无可选项</div>}
          {options.map((o, i) => {
            const isSelected = o.value === value;
            const isActive = i === activeIndex;
            return (
              <div
                key={o.value}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                className={`ui-option ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""} ${
                  o.disabled ? "is-disabled" : ""
                }`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => !o.disabled && setActiveIndex(i)}
                onClick={() => commit(i)}
              >
                {o.icon ? <span className="ui-option-icon">{o.icon}</span> : null}
                <span className="ui-option-label">{o.label}</span>
                {o.hint ? <span className="ui-option-hint">{o.hint}</span> : null}
                {isSelected && <Check size={13} className="ui-option-check" aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

/** id 里的特殊字符转义（CSS 选择器安全）。 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
