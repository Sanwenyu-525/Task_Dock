//! 可搜索下拉（Combobox）：输入关键字动态过滤，支持键盘全流程。
//!
//! 输入框本身就是焦点宿主，展开态用 `aria-activedescendant` 指向高亮项；
//! 与 Select 共用同一套 Popover 定位与弹层栈，因此 Escape 语义一致。

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import Popover from "./Popover";
import { scrollIntoViewIfNeeded } from "./overlay";
import type { SelectOption } from "./Select";

export interface ComboboxProps<T extends string = string> {
  value: T | "" | null | undefined;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  /** 自定义过滤（默认按 label 子串匹配） */
  filter?: (option: SelectOption<T>, query: string) => boolean;
  /** 未选中时的占位文案 */
  placeholder?: string;
}

export default function Combobox<T extends string = string>({
  value,
  options,
  onChange,
  searchPlaceholder = "搜索…",
  emptyText = "无匹配结果",
  ariaLabel,
  id,
  disabled = false,
  className,
  size = "md",
  filter,
  placeholder = "请选择",
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    if (filter) return options.filter((o) => filter(o, q));
    return options.filter((o) => o.label.toLowerCase().includes(q) || String(o.hint ?? "").toLowerCase().includes(q));
  }, [options, query, filter]);

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.querySelector<HTMLElement>(`#${listId}-opt-${activeIndex}`);
    scrollIntoViewIfNeeded(listRef.current, item);
  }, [open, activeIndex, listId]);

  function openMenu() {
    // 展开时清空检索词：用户看到的是完整列表，输入即从第一项开始筛
    setQuery("");
    // 用完整 options 定位当前项（此时检索词尚未生效，filtered 不可靠）
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
    setOpen(true);
  }

  function commit(index: number) {
    const opt = filtered[index];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openMenu();
        else setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        if (!open) openMenu();
        else setActiveIndex((i) => Math.max(0, i - 1));
        return;
      case "Enter":
        if (open && activeIndex >= 0) {
          e.preventDefault();
          commit(activeIndex);
        }
        return;
      case "Home":
        if (open) {
          e.preventDefault();
          setActiveIndex(0);
        }
        return;
      case "End":
        if (open) {
          e.preventDefault();
          setActiveIndex(filtered.length - 1);
        }
        return;
      case "Tab":
        if (open) setOpen(false);
        return;
      default:
        return;
    }
  }

  return (
    <>
      <div
        ref={anchorRef}
        className={`ui-combobox size-${size} ${open ? "is-open" : ""} ${className ?? ""}`}
        onClick={() => {
          if (disabled) return;
          inputRef.current?.focus();
          if (!open) openMenu();
        }}
      >
        {open ? (
          <Search size={12} className="ui-combobox-icon" aria-hidden="true" />
        ) : null}
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          placeholder={open ? searchPlaceholder : selected?.label ?? placeholder}
          value={open ? query : (selected?.label ?? "")}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => {
            if (!open) openMenu();
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        <ChevronDown size={13} className="ui-combobox-caret" aria-hidden="true" />
      </div>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        matchWidth
        className="ui-combobox-popover"
        role="listbox"
        id={listId}
        ariaLabel={ariaLabel}
      >
        <div className="ui-listbox" ref={listRef}>
          {filtered.length === 0 && <div className="ui-listbox-empty">{emptyText}</div>}
          {filtered.map((o, i) => {
            const isSelected = o.value === value;
            return (
              <div
                key={o.value}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                className={`ui-option ${isSelected ? "is-selected" : ""} ${i === activeIndex ? "is-active" : ""} ${
                  o.disabled ? "is-disabled" : ""
                }`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(i)}
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
