//! 日期时间选择器：日历 + 时间 + 可直接键入。
//!
//! 取值格式与 `<input type="datetime-local">` 完全一致（`YYYY-MM-DDTHH:mm`），
//! 与后端的 ISO 转换仍走 lib/format.ts 的 to/fromLocalInputValue。
//!
//! 关键约束：
//! - 只有用户**真的改了**才回调 onChange（值未变则不回调），
//!   因此编辑已有任务时不会把原本的秒截断、也不会动没碰过的字段；
//! - 截止时间与提醒时间互相独立（各自一个实例）；
//! - 支持清空与直接键入，非法输入只提示不提交。

import { useEffect, useRef, useState } from "react";
import { CalendarDays, Clock, X } from "lucide-react";
import Popover from "./Popover";
import CalendarGrid from "./CalendarGrid";
import {
  formatLocalDisplay,
  formatLocalInput,
  nowLocal,
  parseLocalInput,
  parseLooseInput,
  todayLocal,
} from "../../lib/datetime";
import { useLocale } from "../../hooks/useLocale";

export interface DateTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  clearable?: boolean;
  /** 分钟步进 */
  minuteStep?: number;
}

export default function DateTimePicker({
  value,
  onChange,
  onClear,
  placeholder,
  ariaLabel,
  id,
  disabled = false,
  className,
  size = "md",
  clearable = true,
  minuteStep = 1,
}: DateTimePickerProps) {
  const { t } = useLocale();
  const resolvedPlaceholder = placeholder ?? t("dateTime.placeholder");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => formatLocalDisplay(value));
  const [error, setError] = useState<string | null>(null);
  const [viewYM, setViewYM] = useState(() => (parseLocalInput(value) ? value.slice(0, 7) : todayLocal().year + "-" + String(todayLocal().month).padStart(2, "0")));
  const [focusIso, setFocusIso] = useState(() => (parseLocalInput(value) ? value.slice(0, 10) : todayLocal().year + "-" + String(todayLocal().month).padStart(2, "0") + "-" + String(todayLocal().day).padStart(2, "0")));
  const anchorRef = useRef<HTMLButtonElement>(null);

  // 值变化时同步输入框文本（展开中不打断用户输入）
  useEffect(() => {
    if (open) return;
    setText(formatLocalDisplay(value));
    setError(null);
  }, [value, open]);

  function commit(next: string) {
    if (next === value) return; // 值没变就不回调：避免截断秒数、避免误标「已修改」
    onChange(next);
  }

  function openPicker() {
    const p = parseLocalInput(value);
    const t = todayLocal();
    setViewYM(p ? value.slice(0, 7) : `${t.year}-${String(t.month).padStart(2, "0")}`);
    setFocusIso(p ? value.slice(0, 10) : `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`);
    setText(formatLocalDisplay(value));
    setError(null);
    setOpen(true);
  }

  function pickDay(iso: string) {
    const base = parseLocalInput(value) ?? { ...todayLocal(), hour: 9, minute: 0 };
    commit(
      formatLocalInput({
        ...base,
        year: Number(iso.slice(0, 4)),
        month: Number(iso.slice(5, 7)),
        day: Number(iso.slice(8, 10)),
      }),
    );
  }

  function setTime(hour: number, minute: number) {
    const base = parseLocalInput(value) ?? todayLocal();
    commit(formatLocalInput({ ...base, hour, minute }));
  }

  function commitText() {
    const raw = text.trim();
    if (!raw) {
      if (value !== "") commit("");
      return;
    }
    const parsed = parseLooseInput(raw);
    if (!parsed) {
      setError(t("dateTime.invalidFormat"));
      return;
    }
    setError(null);
    commit(parsed);
  }

  const parts = parseLocalInput(value);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        id={id}
        className={`ui-dtp-trigger size-${size} ${open ? "is-open" : ""} ${value ? "" : "is-placeholder"} ${
          className ?? ""
        }`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <CalendarDays size={13} className="ui-dtp-icon" aria-hidden="true" />
        <span className="ui-dtp-text">{value ? formatLocalDisplay(value) : resolvedPlaceholder}</span>
        {clearable && value && !disabled ? (
          <span
            className="ui-dtp-clear"
            role="button"
            tabIndex={-1}
            aria-label={t("dateTime.clearAria")}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              commit("");
              onClear?.();
            }}
          >
            <X size={11} aria-hidden="true" />
          </span>
        ) : null}
      </button>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-start"
        matchWidth={false}
        className="ui-dtp-popover"
        role="dialog"
        ariaLabel={ariaLabel ?? t("dateTime.pickerAria")}
      >
        <div className="ui-dtp">
          <div className="ui-dtp-top">
            <input
              type="text"
              className={`ui-dtp-input ${error ? "is-error" : ""}`}
              value={text}
              placeholder="2026-10-30 18:30"
              aria-label={t("dateTime.inputAria", { label: ariaLabel ?? t("dateTime.pickerAria") })}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitText();
                }
              }}
            />
            {error ? <span className="ui-dtp-error">{error}</span> : null}
          </div>

          <CalendarGrid
            viewYM={viewYM}
            onViewYMChange={setViewYM}
            focusIso={focusIso}
            onFocusIsoChange={setFocusIso}
            selectedIso={value.slice(0, 10)}
            onSelect={pickDay}
            ariaLabel={t("dateTime.tableAria")}
          />

          <div className="ui-dtp-time">
            <Clock size={12} aria-hidden="true" />
            <label className="ui-dtp-field">
              <span>{t("dateTime.hour")}</span>
              <input
                type="number"
                min={0}
                max={23}
                value={parts ? parts.hour : ""}
                aria-label={t("dateTime.hourAria")}
                onChange={(e) => {
                  const h = Number(e.target.value);
                  if (!Number.isInteger(h) || h < 0 || h > 23) return;
                  setTime(h, parts?.minute ?? 0);
                }}
              />
            </label>
            <label className="ui-dtp-field">
              <span>{t("dateTime.minute")}</span>
              <input
                type="number"
                min={0}
                max={59}
                step={minuteStep}
                value={parts ? parts.minute : ""}
                aria-label={t("dateTime.minuteAria")}
                onChange={(e) => {
                  const mi = Number(e.target.value);
                  if (!Number.isInteger(mi) || mi < 0 || mi > 59) return;
                  setTime(parts?.hour ?? 0, mi);
                }}
              />
            </label>
          </div>

          <div className="ui-dtp-actions">
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                const n = nowLocal();
                commit(formatLocalInput(n));
              }}
            >
              {t("dateTime.now")}
            </button>
            {clearable && (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  commit("");
                  onClear?.();
                }}
              >
                {t("dateTime.clear")}
              </button>
            )}
          </div>
        </div>
      </Popover>
    </>
  );
}
