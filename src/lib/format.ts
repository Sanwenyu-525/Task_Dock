//! 纯函数时间/文本格式化（可测试，不依赖 Tauri）。

import type { RecurrenceRuleInput } from "./bridge";
import { getLocale, t } from "../i18n";

const DAY = 86400000;

function startOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "15:04" */
export function formatHM(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 今天 / 明天 / 昨天 / 10-28（非中文用 Intl 的本地月日） */
export function formatDayLabel(d: Date, now = new Date()): string {
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY);
  if (diff === 0) return t("format.today");
  if (diff === 1) return t("format.tomorrow");
  if (diff === 2) return t("format.dayAfterTomorrow");
  if (diff === -1) return t("format.yesterday");
  const locale = getLocale();
  if (locale !== "zh-CN") {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "2-digit" }).format(d);
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今天 15:00 · 明天 09:00 · 10-28 09:00 · 无时间 */
export function formatDue(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${formatDayLabel(d, now)} ${formatHM(d)}`;
}

/** 3 分钟后 / 2 小时前 / 3 天前 */
export function formatRelative(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const diff = time - now.getTime();
  const abs = Math.abs(diff);
  const unit = abs < 3600000 ? "minute" : abs < DAY ? "hour" : "day";
  const n = Math.max(
    1,
    Math.floor(abs / (unit === "minute" ? 60000 : unit === "hour" ? 3600000 : DAY)),
  );
  const locale = getLocale();
  if (locale !== "zh-CN") {
    return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(
      diff >= 0 ? n : -n,
      unit,
    );
  }
  // 中文沿用既有空格与「后 / 前」写法，保持既有测试与界面宽度预期。
  if (unit === "minute") return t(diff >= 0 ? "format.relative.minuteFuture" : "format.relative.minutePast", { n });
  if (unit === "hour") return t(diff >= 0 ? "format.relative.hourFuture" : "format.relative.hourPast", { n });
  return t(diff >= 0 ? "format.relative.dayFuture" : "format.relative.dayPast", { n });
}

/** 是否已过期（早于现在）。 */
export function isOverdue(iso: string | null | undefined, now = new Date()): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t < now.getTime();
}

/** 01:23 形式的时长。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/**
 * 本地日期时间与明确时区（用于展示文件修改时间等真实元数据，不从名称猜时间）。
 * 时区采用当前系统偏移，例如 UTC+08:00。
 */
export function formatLocalStamp(
  iso: string | null | undefined,
): { date: string; time: string; zone: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: formatHM(d),
    zone: `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
  };
}

/** 两个 ISO 时间之间的时长文本。 */
export function formatBetween(startIso: string, endIso?: string | null, now = new Date()): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  return formatDuration(Math.max(0, end - start));
}

export const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"];
export const PRIORITY_NAMES = ["紧急", "高", "中", "低"];

export function priorityLabel(p: number): string {
  return PRIORITY_LABELS[Math.min(3, Math.max(0, p))] ?? "P2";
}

// 用 getter 保持既有「点访问」调用不变，同时在读取时取当前语言。
export const AGENT_STATE_LABELS: Record<string, string> = {
  get idle() {
    return t("agent.state.idle");
  },
  get running() {
    return t("agent.state.running");
  },
  get waiting() {
    return t("agent.state.waiting");
  },
  get completed() {
    return t("agent.state.completed");
  },
  get failed() {
    return t("agent.state.failed");
  },
  get disconnected() {
    return t("agent.state.disconnected");
  },
};

export const NOTIFICATION_KIND_LABELS: Record<string, string> = {
  get reminder() {
    return t("notification.kind.reminder");
  },
  get agent_running() {
    return t("notification.kind.agent_running");
  },
  get agent_waiting() {
    return t("notification.kind.agent_waiting");
  },
  get agent_done() {
    return t("notification.kind.agent_done");
  },
  get agent_failed() {
    return t("notification.kind.agent_failed");
  },
  get agent_disconnected() {
    return t("notification.kind.agent_disconnected");
  },
  get system() {
    return t("notification.kind.system");
  },
};

/** datetime-local 输入框值（本地时间）。 */
export function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 值 → ISO 字符串。 */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

const WEEKDAY_CHARS = ["", "一", "二", "三", "四", "五", "六", "日"];

/** 星期几名称由 Intl 生成：zh-CN「周一」、en-US「Mon」；day 1=周一 … 7=周日。 */
function weekdayName(locale: string, day: number): string {
  const date = new Date(2024, 0, 1 + ((day - 1 + 7) % 7));
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
}

/** 英文序数（2 → 2nd），仅用于「每月第 N 个星期X」。 */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** 重复规则描述（含每月第 N 个星期X / 最后一个 / 工作日语义），按当前语言组装。 */
export function describeRecurrence(rule: RecurrenceRuleInput | null): string {
  if (!rule || !rule.freq) return "";
  const locale = getLocale();
  const separator = t("recurrence.separator");
  const days = rule.by_weekday.map((d: number) => weekdayName(locale, d)).join(separator);
  const isMonToFri =
    rule.by_weekday.length === 5 && [1, 2, 3, 4, 5].every((d) => rule.by_weekday.includes(d));
  const workdayLike = rule.freq === "weekly" && isMonToFri;
  switch (rule.freq) {
    case "daily":
      return rule.interval === 1
        ? t("recurrence.daily")
        : t("recurrence.everyNDays", { n: rule.interval });
    case "weekly":
      if (workdayLike && rule.interval === 1) return t("recurrence.workday");
      return rule.interval > 1
        ? t("recurrence.weekdaysWithInterval", { days, n: rule.interval })
        : days;
    case "monthly": {
      const prefix =
        rule.interval === 1
          ? t("recurrence.monthly")
          : t("recurrence.everyNMonths", { n: rule.interval });
      const pos = rule.by_setpos ?? null;
      if (pos != null && rule.by_weekday.length > 0) {
        if (isMonToFri && pos === -1) return t("recurrence.lastWorkday", { prefix });
        if (pos === -1) return t("recurrence.lastWeekday", { prefix, days });
        const posText = locale === "zh-CN" ? WEEKDAY_CHARS[pos] ?? pos : ordinal(pos);
        return t("recurrence.nthWeekday", { prefix, pos: posText, days });
      }
      return t("recurrence.monthDay", { prefix, day: rule.by_monthday ?? 1 });
    }
    default:
      return "";
  }
}

/**
 * 倒计时剩余时间文本：>1h 显示「时:分」（如 1:23），≤1h 显示「分:秒」（如 12:34）。
 * 只做绝对时间换算（remind_at - now），剩余秒数不落库、不缓存。
 */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  if (total > 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${h}:${pad(m)}`;
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad(m)}:${pad(s)}`;
}
