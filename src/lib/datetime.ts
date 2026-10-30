//! 本地日期时间的解析与格式化（纯函数）。
//!
//! 统一使用 `<input type="datetime-local">` 的取值格式 `YYYY-MM-DDTHH:mm`：
//! - 与后端交互仍走 ISO 字符串（见 lib/format.ts 的 to/fromLocalInputValue）；
//! - 这里只负责「本地年月日时分 ↔ 字符串」的解析、校验与日历网格。

export interface LocalDateParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** 校验本地日期时间各字段是否在合法范围内（含月份天数与闰年）。 */
export function isValidLocalParts(p: LocalDateParts): boolean {
  if (!Number.isFinite(p.year) || p.year < 1 || p.year > 9999) return false;
  if (p.month < 1 || p.month > 12) return false;
  if (p.day < 1 || p.day > daysInMonth(p.year, p.month)) return false;
  if (p.hour < 0 || p.hour > 23) return false;
  if (p.minute < 0 || p.minute > 59) return false;
  return true;
}

/** `YYYY-MM-DDTHH:mm` → 字段；格式非法返回 null。 */
export function parseLocalInput(value: string | null | undefined): LocalDateParts | null {
  if (!value) return null;
  const m = LOCAL_RE.exec(value.trim());
  if (!m) return null;
  const parts: LocalDateParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
  return isValidLocalParts(parts) ? parts : null;
}

/** 字段 → `YYYY-MM-DDTHH:mm`。 */
export function formatLocalInput(p: LocalDateParts): string {
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * 宽松文本解析：接受 `2026-10-30 18:30`、`2026/10/30 18:30`、`2026-10-30T18:30`。
 * 非法返回 null（调用方据此给出错误提示，不提交脏数据）。
 */
export function parseLooseInput(text: string): string | null {
  const t = text.trim().replace(/\//g, "-").replace(/\s+/, "T");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2})$/.exec(t);
  if (!m) return null;
  const parts: LocalDateParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
  return isValidLocalParts(parts) ? formatLocalInput(parts) : null;
}

/** 展示用文本：`2026-10-30 18:30`。 */
export function formatLocalDisplay(value: string | null | undefined): string {
  const p = parseLocalInput(value);
  if (!p) return "";
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** 今天的本地零点。 */
export function todayLocal(now = new Date()): LocalDateParts {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: 0, minute: 0 };
}

/** 此刻的本地时间。 */
export function nowLocal(now = new Date()): LocalDateParts {
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
  };
}

export interface CalendarCell {
  iso: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

/**
 * 生成日历网格（周一为首列）。
 * 前后补齐相邻月份的日期，使每行都是完整 7 天。
 */
export function monthGrid(year: number, month: number, today = new Date()): CalendarCell[][] {
  const first = new Date(year, month - 1, 1);
  const offset = (first.getDay() + 6) % 7; // 周一 = 0
  const start = new Date(year, month - 1, 1 - offset);
  const todayIso = `${pad(today.getFullYear(), 4)}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const weeks: CalendarCell[][] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let w = 0; w < 6; w++) {
    const week: CalendarCell[] = [];
    for (let d = 0; d < 7; d++) {
      const iso = `${pad(cursor.getFullYear(), 4)}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
      week.push({
        iso,
        day: cursor.getDate(),
        inMonth: cursor.getMonth() === month - 1 && cursor.getFullYear() === year,
        isToday: iso === todayIso,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** 在 `YYYY-MM-DD` 基础上加减天数，返回新的 `YYYY-MM-DD`。 */
export function shiftDay(iso: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + delta);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 在 `YYYY-MM` 基础上加减月份，返回新的 `YYYY-MM`。 */
export function shiftMonth(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}`;
}
