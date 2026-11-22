//! 日历网格：月份头（上月/下月）+ 周标题 + 七列日期 + 键盘导航。
//!
//! DateTimePicker 与 DatePicker 共用同一个实现，只处理 `YYYY-MM` / `YYYY-MM-DD`，
//! 不涉及时间、时区与提交语义（选择回调由使用方决定）。
//! 键盘：方向键逐日/逐周，PageUp/PageDown 切月，Home/End 到本周首尾，
//! Enter/Space 选择当前焦点日。

import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { monthGrid, shiftDay, shiftMonth } from "../../lib/datetime";
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

export interface CalendarGridProps {
  /** 当前显示月份 `YYYY-MM` */
  viewYM: string;
  onViewYMChange: (ym: string) => void;
  /** 键盘焦点日 `YYYY-MM-DD` */
  focusIso: string;
  onFocusIsoChange: (iso: string) => void;
  /** 选中日 `YYYY-MM-DD`；空串/未传表示未选中 */
  selectedIso?: string;
  onSelect: (iso: string) => void;
  /** 表格可访问名称 */
  ariaLabel?: string;
}

export default function CalendarGrid({
  viewYM,
  onViewYMChange,
  focusIso,
  onFocusIsoChange,
  selectedIso = "",
  onSelect,
  ariaLabel,
}: CalendarGridProps) {
  const { locale, t } = useLocale();
  const heads = weekHeads(locale);
  const gridRef = useRef<HTMLTableSectionElement>(null);
  const [vy, vm] = viewYM.split("-").map(Number) as [number, number];
  const weeks = monthGrid(vy, vm);

  function moveFocusTo(iso: string) {
    onFocusIsoChange(iso);
    onViewYMChange(iso.slice(0, 7));
    requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLElement>(`[data-iso="${iso}"]`)?.focus();
    });
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
      onViewYMChange(shiftMonth(viewYM, -1));
      return;
    }
    if (e.key === "PageDown") {
      e.preventDefault();
      onViewYMChange(shiftMonth(viewYM, 1));
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
      onSelect(focusIso);
    }
  }

  return (
    <>
      <div className="ui-cal-head">
        <button
          type="button"
          className="icon-btn sm"
          aria-label={t("dateTime.prevMonth")}
          onClick={() => onViewYMChange(shiftMonth(viewYM, -1))}
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
          onClick={() => onViewYMChange(shiftMonth(viewYM, 1))}
        >
          <ChevronRight size={13} />
        </button>
      </div>

      <table className="ui-cal" aria-label={ariaLabel ?? t("dateTime.tableAria")}>
        <thead>
          <tr>
            {heads.map((w, i) => (
              <th key={i} scope="col" abbr={w}>
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={gridRef} onKeyDown={onGridKeyDown}>
          {weeks.map((week) => (
            <tr key={week[0].iso}>
              {week.map((cell) => {
                const selected = selectedIso === cell.iso;
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
                      onClick={() => onSelect(cell.iso)}
                      onFocus={() => onFocusIsoChange(cell.iso)}
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
    </>
  );
}
