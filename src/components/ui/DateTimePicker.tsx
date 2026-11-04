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

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, X } from "lucide-react";
import Popover from "./Popover";
import {
  formatLocalDisplay,
  formatLocalInput,
  monthGrid,
  nowLocal,
  parseLocalInput,
  parseLooseInput,
  shiftDay,
  shiftMonth,
  todayLocal,
} from "../../lib/datetime";
import { useLocale } from "../../hooks/useLocale";
import type { LocaleCode } from "../../i18n";

const WEEK_START = new Date(2024, 0, 1); // 2024-01-01 是周一，仅用于取周几文案

/** 周标题由 Intl 生成（zh-CN 得到「一…日」，en-US 得到「M…S」），不硬编码。 */
function weekHeads(locale: LocaleCode): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(
      new Date(WEEK_START.getFullYear(), WEEK_START.getMonth(), WEEK_START.getDate() + i),
    ),
  );
}

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
  const { locale, t } = useLocale();
  const resolvedPlaceholder = placeholder ?? t("dateTime.placeholder");
  const heads = weekHeads(locale);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => formatLocalDisplay(value));
  const [error, setError] = useState<string | null>(null);
  const [viewYM, setViewYM] = useState(() => (parseLocalInput(value) ? value.slice(0, 7) : todayLocal().year + "-" + String(todayLocal().month).padStart(2, "0")));
  const [focusIso, setFocusIso] = useState(() => (parseLocalInput(value) ? value.slice(0, 10) : todayLocal().year + "-" + String(todayLocal().month).padStart(2, "0") + "-" + String(todayLocal().day).padStart(2, "0")));
  const anchorRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLTableSectionElement>(null);

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

  function onGridKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in steps) {
      e.preventDefault();
      moveFocusTo(shiftDay(focusIso, steps[e.key]));
      return;
    }
    if (e.key === "PageUp") {
      e.preventDefault();
      setViewYM((ym) => shiftMonth(ym, -1));
      return;
    }
    if (e.key === "PageDown") {
      e.preventDefault();
      setViewYM((ym) => shiftMonth(ym, 1));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const d = new Date(Number(focusIso.slice(0, 4)), Number(focusIso.slice(5, 7)) - 1, Number(focusIso.slice(8, 10)));
      const idx = (d.getDay() + 6) % 7; // 周一 = 0
      moveFocusTo(shiftDay(focusIso, e.key === "Home" ? -idx : 6 - idx));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickDay(focusIso);
    }
  }

  function moveFocusTo(iso: string) {
    setFocusIso(iso);
    setViewYM(iso.slice(0, 7));
    requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLElement>(`[data-iso="${iso}"]`)?.focus();
    });
  }

  const parts = parseLocalInput(value);
  const [vy, vm] = viewYM.split("-").map(Number) as [number, number];
  const weeks = monthGrid(vy, vm);

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

          <div className="ui-cal-head">
            <button
              type="button"
              className="icon-btn sm"
              aria-label={t("dateTime.prevMonth")}
              onClick={() => setViewYM((ym) => shiftMonth(ym, -1))}
            >
              <ChevronLeft size={13} />
            </button>
            <span className="ui-cal-title" aria-live="polite">
              {t("dateTime.yearMonth", { year: vy, month: vm })}
            </span>
            <button
              type="button"
              className="icon-btn sm"
              aria-label={t("dateTime.nextMonth")}
              onClick={() => setViewYM((ym) => shiftMonth(ym, 1))}
            >
              <ChevronRight size={13} />
            </button>
          </div>

          <table className="ui-cal" aria-label={t("dateTime.tableAria")}>
            <thead>
              <tr>
                {heads.map((w) => (
                  <th key={w} scope="col" abbr={w}>
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody ref={gridRef} onKeyDown={onGridKeyDown}>
              {weeks.map((week) => (
                <tr key={week[0].iso}>
                  {week.map((cell) => {
                    const selected = value.slice(0, 10) === cell.iso;
                    return (
                      <td key={cell.iso} className={cell.inMonth ? "" : "is-outside"}>
                        <button
                          type="button"
                          data-iso={cell.iso}
                          tabIndex={cell.iso === focusIso ? 0 : -1}
                          className={`ui-cal-day ${selected ? "is-selected" : ""} ${cell.isToday ? "is-today" : ""}`}
                          aria-label={cell.iso}
                          aria-current={cell.isToday ? "date" : undefined}
                          aria-pressed={selected}
                          onClick={() => pickDay(cell.iso)}
                          onFocus={() => setFocusIso(cell.iso)}
                        >
                          {cell.day}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

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
