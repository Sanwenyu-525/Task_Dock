// 时间戳转换的纯函数层：秒 / 毫秒 / ISO 8601 / 本地 / UTC 之间的换算与校验。
//
// 关键约束（全部由下面的实现保证，单测覆盖）：
// - 秒与毫秒只做显式 ×1000 / ÷1000，绝不「按位数猜完再算两次」；
// - 自动识别有明确规则（|值| ≥ 1e12 视为毫秒，否则秒），并返回 detected 让 UI 明示；
// - 日期按「日历字段」校验（2 月 30 日、13 月、25 点都报错），不是 Date 的宽松解析；
// - 本地时间用设备时区构造 Date，夏令时切换导致的「不存在的本地时间」会因字段回读不一致而报错；
// - 格式化手写年/月/日/时/分/秒，不依赖 Intl（Hermes 的 Intl 在小体积构建里可能被裁）；
// - 本文件为纯函数，不轮询、不读系统时间：now 由调用方传入。

export type TimestampUnit = "auto" | "seconds" | "milliseconds";
export type TimeZoneChoice = "local" | "utc";

export interface EpochParseSuccess {
  ok: true;
  epochMs: number;
  /** 实际采用的单位（auto 时是识别结果） */
  unit: "seconds" | "milliseconds";
  /** 自动识别不可靠时给用户看的说明 */
  note?: string;
}

export interface EpochParseFailure {
  ok: false;
  message: string;
}

export type EpochParseResult = EpochParseSuccess | EpochParseFailure;

/** JS Date 的有效范围（毫秒），超出后 getTime() 为 NaN。 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

export function isFiniteEpoch(epochMs: number): boolean {
  return Number.isFinite(epochMs) && Math.abs(epochMs) <= MAX_EPOCH_MS;
}

function formatNumber(value: number, pad: number): string {
  return String(Math.abs(Math.trunc(value))).padStart(pad, "0");
}

/**
 * 解析用户输入的时间戳。
 *
 * 允许：整数或带小数的数字、前后空白、正负号。小数只作为「秒」有意义，
 * 毫秒模式下按四舍五入取整并在 note 里说明。
 */
export function parseTimestampInput(text: string, unit: TimestampUnit): EpochParseResult {
  const raw = text.trim();
  if (!raw) return { ok: false, message: "请输入时间戳" };
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    return { ok: false, message: "时间戳只能是数字（允许小数秒与正负号）" };
  }

  let resolved: "seconds" | "milliseconds";
  let note: string | undefined;
  if (unit === "auto") {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return { ok: false, message: "这个数字太大，无法安全换算" };
    // 规则与常见工具一致：13 位毫秒 ≈ 2001 年之后；10 位秒 ≈ 1970–2286。
    // 11–12 位落在 1970–2001 的毫秒区间，按毫秒处理并明确提示，用户可手动切换。
    if (Math.abs(numeric) >= 1e12) {
      resolved = "milliseconds";
      note = "按毫秒识别（13 位及以上）；如果是秒请手动切换单位";
    } else {
      resolved = "seconds";
      note = "按秒识别（10 位左右）；如果是毫秒请手动切换单位";
    }
  } else {
    resolved = unit;
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return { ok: false, message: "这个数字太大，无法安全换算" };

  let epochMs: number;
  if (resolved === "seconds") {
    if (Math.abs(numeric) > MAX_EPOCH_MS / 1000) {
      return { ok: false, message: "秒级时间戳超出可表示范围" };
    }
    epochMs = numeric * 1000;
  } else {
    if (Math.abs(numeric) > MAX_EPOCH_MS) {
      return { ok: false, message: "毫秒级时间戳超出可表示范围" };
    }
    epochMs = numeric;
  }
  epochMs = Math.round(epochMs);

  if (!isFiniteEpoch(epochMs)) return { ok: false, message: "换算后的时间超出可表示范围" };
  const year = new Date(epochMs).getUTCFullYear();
  if (year < 1 || year > 9999) {
    return { ok: false, message: "换算结果年份超出 1–9999，无法格式化" };
  }
  return { ok: true, epochMs, unit: resolved, note };
}

const ISO_PATTERN =
/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export interface DateParseSuccess {
  ok: true;
  epochMs: number;
  /** 输入是否自带时区（自带时 zone 参数只影响「不带时区」的解释） */
  hasZone: boolean;
}

export type DateParseResult = DateParseSuccess | { ok: false; message: string };

function validCalendarDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string | null {
  if (month < 1 || month > 12) return `月份 ${month} 无效（1–12）`;
  if (day < 1 || day > 31) return `日期 ${day} 无效`;
  if (hour > 23) return `小时 ${hour} 无效（0–23）`;
  if (minute > 59) return `分钟 ${minute} 无效（0–59）`;
  if (second > 59) return `秒 ${second} 无效（0–59，闰秒不在支持范围）`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return `${year} 年 ${month} 月只有 ${daysInMonth} 天`;
  return null;
}

/**
 * 解析日期时间输入。
 *
 * 支持：
 * - `2026-11-16`
 * - `2026-11-16 08:30`
 * - `2026-11-16T08:30:00`
 * - `2026-11-16T08:30:00.123`
 * - 末尾 `Z` 或 `+08:00`
 * 未带时区时按 `zone` 解释（local = 设备时区，utc = UTC）。
 */
export function parseDateInput(text: string, zone: TimeZoneChoice): DateParseResult {
  const raw = text.trim();
  if (!raw) return { ok: false, message: "请输入日期时间" };
  const match = ISO_PATTERN.exec(raw);
  if (!match) {
    return {
      ok: false,
      message: "格式应为 2026-11-16、2026-11-16 08:30 或 2026-11-16T08:30:00+08:00",
    };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millis = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));
  const zoneText = match[8];

  const calendarError = validCalendarDate(year, month, day, hour, minute, second);
  if (calendarError) return { ok: false, message: calendarError };

  if (zoneText) {
    let offsetMinutes = 0;
    if (zoneText !== "Z") {
      const sign = zoneText[0] === "-" ? -1 : 1;
      const offsetHour = Number(zoneText.slice(1, 3));
      const offsetMinute = Number(zoneText.slice(4, 6));
      if (offsetHour > 23 || offsetMinute > 59) return { ok: false, message: "时区偏移无效" };
      offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
    }
    const epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
    if (!isFiniteEpoch(epochMs)) return { ok: false, message: "日期超出可表示范围" };
    return { ok: true, epochMs, hasZone: true };
  }

  let epochMs: number;
  if (zone === "utc") {
    epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  } else {
    const date = new Date(year, month - 1, day, hour, minute, second, millis);
    epochMs = date.getTime();
    // 回读日历字段：夏令时跳变造成的不存在时间会被 JS 静默顺延，
    // 这里必须报错而不是把 02:30 显示成 03:30。
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute
    ) {
      return {
        ok: false,
        message: "该本地时间在夏令时切换中不存在（或被顺延），请改用带时区的写法或 UTC",
      };
    }
  }
  if (!isFiniteEpoch(epochMs)) return { ok: false, message: "日期超出可表示范围" };
  return { ok: true, epochMs, hasZone: false };
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function parts(epochMs: number, zone: TimeZoneChoice) {
  const date = new Date(epochMs);
  const year = zone === "utc" ? date.getUTCFullYear() : date.getFullYear();
  const month = (zone === "utc" ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = zone === "utc" ? date.getUTCDate() : date.getDate();
  const hour = zone === "utc" ? date.getUTCHours() : date.getHours();
  const minute = zone === "utc" ? date.getUTCMinutes() : date.getMinutes();
  const second = zone === "utc" ? date.getUTCSeconds() : date.getSeconds();
  const millis = zone === "utc" ? date.getUTCMilliseconds() : date.getMilliseconds();
  const weekday = zone === "utc" ? date.getUTCDay() : date.getDay();
  return { year, month, day, hour, minute, second, millis, weekday };
}

function offsetText(epochMs: number): string {
  const offset = -new Date(epochMs).getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${sign}${formatNumber(Math.floor(abs / 60), 2)}:${formatNumber(abs % 60, 2)}`;
}

export interface EpochDisplay {
  /** Unix 秒（整数） */
  seconds: string;
  /** Unix 毫秒 */
  milliseconds: string;
  /** 2026-11-16 08:30:00 */
  dateTime: string;
  /** 2026-11-16 */
  date: string;
  /** 08:30:00.123 */
  time: string;
  /** 2026-11-16T08:30:00.123+08:00（本地）或 …Z（UTC） */
  iso: string;
  weekday: string;
  /** 本地/UTC 标识，展示在结果标题上 */
  zoneLabel: string;
}

export function formatEpoch(epochMs: number, zone: TimeZoneChoice): EpochDisplay {
  const value = parts(epochMs, zone);
  const dateTime =
    `${value.year}-${formatNumber(value.month, 2)}-${formatNumber(value.day, 2)} ` +
    `${formatNumber(value.hour, 2)}:${formatNumber(value.minute, 2)}:${formatNumber(value.second, 2)}`;
  const date = `${value.year}-${formatNumber(value.month, 2)}-${formatNumber(value.day, 2)}`;
  const time =
    `${formatNumber(value.hour, 2)}:${formatNumber(value.minute, 2)}:${formatNumber(value.second, 2)}` +
    `.${formatNumber(value.millis, 3)}`;
  const isoBase = `${date}T${formatNumber(value.hour, 2)}:${formatNumber(value.minute, 2)}:${formatNumber(
    value.second,
    2,
  )}.${formatNumber(value.millis, 3)}`;
  return {
    seconds: String(Math.floor(epochMs / 1000)),
    milliseconds: String(Math.round(epochMs)),
    dateTime,
    date,
    time,
    iso: zone === "utc" ? `${isoBase}Z` : `${isoBase}${offsetText(epochMs)}`,
    weekday: WEEKDAYS[value.weekday],
    zoneLabel: zone === "utc" ? "UTC" : `本地时间 UTC${offsetText(epochMs)}`,
  };
}

/**
 * 相对时间（用于「最近使用」与时间戳页的辅助说明）。只做粗粒度，不追求精确到分。
 * 传入 now 保证可测试；UI 不在后台每秒轮询。
 */
export function formatRelative(epochMs: number, now: number): string {
  const delta = now - epochMs;
  const abs = Math.abs(delta);
  if (abs < 60_000) return delta >= 0 ? "刚刚" : "即将";
  if (abs < 3_600_000) {
    const minutes = Math.floor(abs / 60_000);
    return delta >= 0 ? `${minutes} 分钟前` : `${minutes} 分钟后`;
  }
  if (abs < 86_400_000) {
    const hours = Math.floor(abs / 3_600_000);
    return delta >= 0 ? `${hours} 小时前` : `${hours} 小时后`;
  }
  if (abs < 30 * 86_400_000) {
    const days = Math.floor(abs / 86_400_000);
    return delta >= 0 ? `${days} 天前` : `${days} 天后`;
  }
  const years = Math.floor(abs / (365 * 86_400_000));
  if (years >= 1) return delta >= 0 ? `${years} 年前` : `${years} 年后`;
  const days = Math.floor(abs / 86_400_000);
  return delta >= 0 ? `${days} 天前` : `${days} 天后`;
}

/** 当前时间戳（毫秒）。只在用户点「填入当前时间」时调用一次，不做定时器。 */
export function currentEpochMs(now: number = Date.now()): number {
  return now;
}
