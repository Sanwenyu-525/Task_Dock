//! 选择与开关控件。
//!
//! 保留原生 `<input type="checkbox">` 作为真实表单控件（只做视觉隐藏），
//! 因此键盘、屏幕阅读器与既有自动化测试的行为都不变。

import type { ReactNode } from "react";
import { Check } from "lucide-react";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  ariaLabel?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  id,
  className,
  ariaLabel,
}: CheckboxProps) {
  return (
    <label className={`ui-checkbox ${disabled ? "is-disabled" : ""} ${className ?? ""}`}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        <Check size={11} strokeWidth={3} />
      </span>
      {label ? <span className="ui-checkbox-label">{label}</span> : null}
    </label>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  ariaLabel?: string;
}

export function Switch({ checked, onChange, label, disabled = false, id, className, ariaLabel }: SwitchProps) {
  return (
    <label className={`ui-switch ${disabled ? "is-disabled" : ""} ${className ?? ""}`}>
      <input
        type="checkbox"
        role="switch"
        id={id}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ui-switch-track" aria-hidden="true">
        <span className="ui-switch-thumb" />
      </span>
      {label ? <span className="ui-switch-label">{label}</span> : null}
    </label>
  );
}
