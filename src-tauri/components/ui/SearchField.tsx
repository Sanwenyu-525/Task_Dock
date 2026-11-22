//! 搜索输入（公共组件）：搜索图标 + 内嵌输入 + 清空按钮。
//!
//! 边界：
//! - 只做输入交互与视觉，不负责过滤、请求、防抖、匹配算法或业务状态；
//! - 容器复用 `.search-box` 的既有表面/焦点约定，输入挂 `.input-embedded`，
//!   焦点环只由容器 `:focus-within` 表达，内层输入不再自绘；
//! - 清空按钮始终占位，出现/消失不改变输入宽度；
//! - Escape 只转发给调用方（页面可能需要在关闭搜索或阻止窗口级快捷键时自行处理），
//!   中文输入法组合输入期间不转发按键，避免误清空。

import {
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Search, X } from "lucide-react";
import useImeComposition from "../../hooks/useImeComposition";

export type SearchFieldSize = "compact" | "default";

export interface SearchFieldProps {
  value: string;
  /** 输入变化（只回传字符串，不暴露原生事件） */
  onChange: (value: string) => void;
  placeholder?: string;
  /** 输入框可访问名称（必填） */
  ariaLabel: string;
  /** 清空按钮的可访问名称与提示文案 */
  clearLabel?: string;
  /** 自定义搜索图标；缺省使用 Search */
  icon?: ReactNode;
  /** 清空后的额外回调（组件会先调用 onChange("")） */
  onClear?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  size?: SearchFieldSize;
  className?: string;
  /** 需要主动聚焦输入框时由调用方传入；组件内部清空后也复用该引用 */
  inputRef?: RefObject<HTMLInputElement | null>;
}

export default function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearLabel = "清除搜索",
  icon,
  onClear,
  onKeyDown,
  disabled = false,
  autoFocus = false,
  size = "default",
  className,
  inputRef,
}: SearchFieldProps) {
  const internalRef = useRef<HTMLInputElement>(null);
  const hasValue = value.length > 0;
  const ime = useImeComposition();

  function focusInput() {
    (inputRef?.current ?? internalRef.current)?.focus({ preventScroll: true });
  }

  function clear() {
    if (disabled) return;
    onChange("");
    onClear?.();
    // 清空按钮随后隐藏；把焦点留在输入框，避免焦点落到文档根。
    focusInput();
  }

  return (
    <div
      className={`ui-search search-box${size === "compact" ? " ui-search--compact" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      <span className="ui-search-icon" aria-hidden="true">
        {icon ?? <Search size={size === "compact" ? 12 : 13} />}
      </span>
      <input
        ref={inputRef ?? internalRef}
        type="text"
        className="ui-search-input input-embedded"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        autoFocus={autoFocus}
        data-autofocus={autoFocus ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onKeyDown={(event) => {
          // 组合输入（拼音/日文等）中的按键不转发：Escape 应先取消候选，而不是清空。
          if (ime.isComposing(event)) return;
          onKeyDown?.(event);
        }}
      />
      <button
        type="button"
        className={`ui-search-clear icon-btn sm${hasValue ? "" : " is-hidden"}`}
        aria-label={clearLabel}
        aria-hidden={!hasValue}
        tabIndex={hasValue ? 0 : -1}
        data-tip={hasValue ? clearLabel : undefined}
        disabled={disabled}
        onClick={clear}
      >
        <X size={11} aria-hidden="true" />
      </button>
    </div>
  );
}
