//! 纯日期选择器：只处理 `YYYY-MM-DD`，不携带时间与时区语义。
//!
//! - 触发区是真实输入框：可直接键入日期，非法输入只提示不提交；
//! - 日历图标是开关（同一入口可开可关）；点输入框只展开、不抢输入焦点；
//! - 选中日期立即提交并关闭；「今天」「清除」在底部，不设确认按钮；
//! - 值未变不回调；开关与切月都不会触发 onChange；
//! - 定位、翻转、边界、弹层栈与 Escape 全部复用 Popover / overlayStack。

import { useEffect, useRef, useState, type FocusEvent as ReactFocusEvent } from "react";
import { CalendarDays } from "lucide-react";
import Popover from "./Popover";
import CalendarGrid from "./CalendarGrid";
import { isValidIsoDate, parseDateInput, todayIsoDate } from "../../lib/datetime";
import { useLocale } from "../../hooks/useLocale";

export interface DatePickerProps {
  /** `YYYY-MM-DD`；空串表示未设置 */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  clearable?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export default function DatePicker({
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  clearable = true,
  size = "md",
  className,
}: DatePickerProps) {
  const { t } = useLocale();
  const display = isValidIsoDate(value) ? value : "";
  const today = todayIsoDate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(display);
  const [error, setError] = useState<string | null>(null);
  const [viewYM, setViewYM] = useState(() => (display ? display.slice(0, 7) : today.slice(0, 7)));
  const [focusIso, setFocusIso] = useState(() => display || today);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 值变化时同步输入框文本（展开中不打断用户输入）
  useEffect(() => {
    if (open) return;
    setText(display);
    setError(null);
  }, [display, open]);

  function commit(next: string) {
    if (next === value) return; // 值没变就不回调：避免误标「已修改」
    onChange(next);
  }

  function openPicker(focusGrid = false) {
    const base = display || today;
    setViewYM(base.slice(0, 7));
    setFocusIso(base);
    setText(display);
    setError(null);
    setOpen(true);
    if (focusGrid) {
      requestAnimationFrame(() => {
        panelRef.current?.querySelector<HTMLElement>(`[data-iso="${base}"]`)?.focus();
      });
    }
  }

  function pickDay(iso: string) {
    commit(iso);
    setOpen(false);
  }

  function commitText() {
    const raw = text.trim();
    if (!raw) {
      if (value !== "") commit("");
      return;
    }
    const parsed = parseDateInput(raw);
    if (!parsed) {
      setError(t("datePicker.invalidFormat"));
      return;
    }
    setError(null);
    commit(parsed);
    setText(parsed);
  }

  // 点击日历面板内的日期/按钮时先失焦：此时不要提交半成品文本，
  // 免得「蓝牙点击日期」同时提交两份值。
  function onInputBlur(e: ReactFocusEvent<HTMLInputElement>) {
    const next = e.relatedTarget as HTMLElement | null;
    if (next?.closest?.(".ui-dp-popover")) return;
    commitText();
  }

  return (
    <>
      <div
        ref={anchorRef}
        className={`ui-dp size-${size} ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""} ${
          className ?? ""
        }`}
      >
        <input
          type="text"
          className={`ui-dp-input input-embedded ${error ? "is-error" : ""}`}
          value={text}
          placeholder={placeholder ?? "YYYY-MM-DD"}
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onBlur={onInputBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText();
            }
          }}
          onClick={() => {
            if (!open && !disabled) openPicker();
          }}
        />
        <button
          type="button"
          className="ui-dp-toggle"
          aria-label={t("datePicker.pickerAria")}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : openPicker(true))}
        >
          <CalendarDays size={13} aria-hidden="true" />
        </button>
        {error ? (
          <span className="ui-dp-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-start"
        matchWidth={false}
        className="ui-dp-popover"
        role="dialog"
        ariaLabel={ariaLabel ?? t("datePicker.pickerAria")}
      >
        <div className="ui-dp-panel" ref={panelRef}>
          <div className="ui-dp-main">
            <CalendarGrid
              viewYM={viewYM}
              onViewYMChange={setViewYM}
              focusIso={focusIso}
              onFocusIsoChange={setFocusIso}
              selectedIso={display}
              onSelect={pickDay}
              ariaLabel={t("dateTime.tableAria")}
            />
          </div>
          <div className="ui-dp-foot">
            {clearable ? (
              <button
                type="button"
                className="ui-dp-link"
                onClick={() => {
                  commit("");
                  setOpen(false);
                }}
              >
                {t("datePicker.clear")}
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="ui-dp-link is-accent"
              onClick={() => pickDay(today)}
            >
              {t("datePicker.today")}
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}
