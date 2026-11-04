//! 本地化日期、时间与数字。
//!
//! 事实边界：
//! - 数据库与 IPC 中的时间仍是 ISO 字符串 / UTC 语义，本文件**只负责展示**，不改存储；
//! - 一律通过 Intl 生成月份、星期与数字格式，不硬编码月份名；
//! - 无效输入返回空串，避免把 `Invalid Date` 直接渲染到界面。

import { getLocale } from "./index";

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const DEFAULT_DATE: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "2-digit",
};

const DEFAULT_DATE_TIME: Intl.DateTimeFormatOptions = {
  ...DEFAULT_DATE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/** 本地化日期（默认 2026年11月3日 / Nov 03, 2026）。 */
export function formatLocalizedDate(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = DEFAULT_DATE,
): string {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(getLocale(), options).format(date);
}

/** 本地化日期时间（24 小时制）。 */
export function formatLocalizedDateTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = DEFAULT_DATE_TIME,
): string {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(getLocale(), options).format(date);
}

/** 仅时间（HH:mm）。 */
export function formatLocalizedTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
): string {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(getLocale(), options).format(date);
}

/** 本地化数字（千分位、小数位按语言）。 */
export function formatLocalizedNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat(getLocale(), options).format(value);
}

/** 本地化百分比（0.42 → 42%）。 */
export function formatLocalizedPercent(
  value: number,
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 0 },
): string {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat(getLocale(), { style: "percent", ...options }).format(value);
}

/**
 * 相对时间（Intl.RelativeTimeFormat）：30 分钟内按分钟，1 天内按小时，其余按天。
 * 与 `lib/format.ts` 的历史展示函数不同，这里不保证中文空格写法一致，
 * 仅供新页面与集成会话使用。
 */
export function formatLocalizedRelative(
  value: string | number | Date,
  now: Date = new Date(),
): string {
  const date = toDate(value);
  if (!date) return "";
  const diffMs = date.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let divisor = minute;
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  if (abs >= day) {
    divisor = day;
    unit = "day";
  } else if (abs >= hour) {
    divisor = hour;
    unit = "hour";
  }
  const amount = Math.round(diffMs / divisor);
  const normalized = amount === 0 ? (diffMs < 0 ? -1 : 1) : amount;
  return new Intl.RelativeTimeFormat(getLocale(), { numeric: "always" }).format(normalized, unit);
}
