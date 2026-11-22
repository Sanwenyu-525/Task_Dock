//! 数值输入：原生 number 输入（去系统外观）+ 自绘步进按钮。
//!
//! 保留 `<input type="number">` 本身，因此上下键、滚轮、表单校验与
//! 既有自动化测试的取值方式都不变；只把系统箭头与焦点样式换成本主题的。

import { useEffect, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";

export interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  id?: string;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
  size?: "sm" | "md";
  suffix?: ReactNode;
  /** 显示步进按钮 */
  showSteppers?: boolean;
}

export default function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  id,
  className,
  inputClassName,
  ariaLabel,
  size = "md",
  suffix,
  showSteppers = true,
}: NumberInputProps) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  function clamp(n: number) {
    let out = n;
    if (min !== undefined && out < min) out = min;
    if (max !== undefined && out > max) out = max;
    return out;
  }

  function bump(delta: number) {
    if (disabled) return;
    onChange(clamp(value + delta * step));
  }

  return (
    <div className={`ui-number size-${size} ${disabled ? "is-disabled" : ""} ${className ?? ""}`}>
      {showSteppers && (
        <button
          type="button"
          className="ui-number-step"
          aria-label="减少"
          tabIndex={-1}
          disabled={disabled || (min !== undefined && value <= min)}
          onClick={() => bump(-1)}
        >
          <Minus size={11} aria-hidden="true" />
        </button>
      )}
      <input
        type="number"
        id={id}
        className={`ui-number-input ${inputClassName ?? ""}`}
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw === "") return;
          const n = Number(raw);
          if (Number.isNaN(n)) return;
          onChange(n);
        }}
        onBlur={() => setText(String(clamp(value)))}
      />
      {showSteppers && (
        <button
          type="button"
          className="ui-number-step"
          aria-label="增加"
          tabIndex={-1}
          disabled={disabled || (max !== undefined && value >= max)}
          onClick={() => bump(1)}
        >
          <Plus size={11} aria-hidden="true" />
        </button>
      )}
      {suffix ? <span className="ui-number-suffix">{suffix}</span> : null}
    </div>
  );
}
