// 重复规则：字段名与桌面端 `recurrence_rules` 对齐（freq / interval / by_weekday /
// by_monthday / by_setpos / anchor），同一条规则在两端含义一致。
// 独立模式下手机是唯一权威，必须自己算下一次发生，不能依赖桌面端。
//
// 时间语义（与 src-tauri/src/recurrence.rs 对齐）：
// - 一律按设备本地时区计算，保留墙钟时分（setDate/setFullYear 不会改变小时）；
// - nextOccurrence 返回**严格晚于**给定时刻的下一次发生；
// - weekly 的相位原点是 anchor（规则创建日），缺失时退回基准日；
// - monthly 的候选月 = 锚点月 + k × interval，靠 day.min(当月天数) 收敛大小月。

export type RecurrenceFreq = "daily" | "weekly" | "monthly";

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** ≥ 1；0 或缺失按 1 处理 */
  interval: number;
  /** 1=周一 … 7=周日；weekly 为空时退回基准日的星期 */
  by_weekday: number[];
  /** monthly 的几号；为空时退回基准日的日 */
  by_monthday: number | null;
  /** 桌面端「每月第 N 个星期X / 最后一个」扩展；手机端只保留并参与推进，不新建 */
  by_setpos?: number | null;
  /** 相位原点（YYYY-MM-DD）；桌面端建规则时写入 */
  anchor?: string | null;
}

const DAY_MS = 86_400_000;
/** 补偿推进上限：与桌面端一致，防止规则异常时死循环 */
const MAX_ADVANCE_STEPS = 2_000;
/** weekly 的搜索视界（天） */
const WEEKLY_HORIZON = 800;
/** monthly 的搜索视界（期数） */
const MONTHLY_HORIZON = 1_200;

export const WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WEEKDAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];
const WORKDAYS = [1, 2, 3, 4, 5];

/** 1=周一 … 7=周日（JS 的 getDay 是 0=周日） */
export function weekdayNum(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1;
}

/** 本地日期的「天序号」：用 UTC 构造消除夏令时造成的 23/25 小时日 */
function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function parseAnchor(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!matched) return null;
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatAnchor(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 容错解析：损坏的 JSON、未知频率、越界星期都退化成「不重复」或清洗后的合法规则。
 * 历史脏数据不能让任务列表或完成操作崩掉。
 */
export function parseRecurrence(raw: string | null | undefined): RecurrenceRule | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") return null;

  const source = parsed as Record<string, unknown>;
  const freq = source.freq;
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly") return null;

  const intervalRaw = typeof source.interval === "number" ? Math.trunc(source.interval) : 1;
  const interval = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? intervalRaw : 1;

  const weekdays = Array.isArray(source.by_weekday) ? source.by_weekday : [];
  const by_weekday = weekdays
    .filter((value): value is number => typeof value === "number" && value >= 1 && value <= 7)
    .map((value) => Math.trunc(value));

  const monthday = source.by_monthday;
  const by_monthday =
    typeof monthday === "number" && monthday >= 1 && monthday <= 31 ? Math.trunc(monthday) : null;

  const setpos = source.by_setpos;
  const by_setpos =
    typeof setpos === "number" && Number.isFinite(setpos) && setpos !== 0
      ? Math.trunc(setpos)
      : undefined;

  return {
    freq,
    interval,
    by_weekday,
    by_monthday,
    ...(by_setpos !== undefined ? { by_setpos } : {}),
    anchor: typeof source.anchor === "string" ? source.anchor : null,
  };
}

/** 写回 TEXT 列：只输出约定字段，避免把临时的 UI 状态带进库 */
export function serializeRecurrence(rule: RecurrenceRule): string {
  return JSON.stringify({
    freq: rule.freq,
    interval: rule.interval,
    by_weekday: rule.by_weekday,
    by_monthday: rule.by_monthday,
    ...(rule.by_setpos != null ? { by_setpos: rule.by_setpos } : {}),
    ...(rule.anchor ? { anchor: rule.anchor } : {}),
  });
}

/** 每月第 pos 个「by_weekday 中的某天」；pos=-1 表示当月最后一个 */
function nthWeekdayInMonth(
  year: number,
  monthIndex: number,
  weekdays: number[],
  pos: number,
): Date | null {
  const hits: Date[] = [];
  const total = daysInMonth(year, monthIndex);
  for (let day = 1; day <= total; day += 1) {
    const date = new Date(year, monthIndex, day);
    if (weekdays.includes(weekdayNum(date))) hits.push(date);
  }
  if (hits.length === 0) return null;
  if (pos === -1) return hits[hits.length - 1];
  return hits[pos - 1] ?? null;
}

function atSameClock(date: Date, template: Date): Date {
  date.setHours(
    template.getHours(),
    template.getMinutes(),
    template.getSeconds(),
    template.getMilliseconds(),
  );
  return date;
}

/**
 * 严格晚于 `after` 的下一次发生（本地时区 epoch ms）；规则无法产出时返回 null。
 * 返回 null 与「没有规则」不同：调用方应把任务当作普通任务处理，而不是静默停在原地。
 */
export function nextOccurrence(rule: RecurrenceRule, after: number): number | null {
  const base = new Date(after);
  const interval = Math.max(1, rule.interval);

  if (rule.freq === "daily") {
    const next = new Date(base);
    next.setDate(next.getDate() + interval);
    return next.getTime();
  }

  if (rule.freq === "weekly") {
    const weekdays =
      rule.by_weekday.length > 0 ? rule.by_weekday : [weekdayNum(base)];
    const anchor = parseAnchor(rule.anchor) ?? base;
    const anchorDay = dayNumber(anchor);

    for (let step = 1; step <= WEEKLY_HORIZON; step += 1) {
      const candidate = new Date(base);
      candidate.setDate(candidate.getDate() + step);
      if (!weekdays.includes(weekdayNum(candidate))) continue;
      const weeks = Math.floor((dayNumber(candidate) - anchorDay) / 7);
      if (weeks % interval !== 0) continue;
      return candidate.getTime();
    }
    return null;
  }

  // monthly
  const anchorDate = parseAnchor(rule.anchor) ?? base;
  const anchorMonth = anchorDate.getFullYear() * 12 + anchorDate.getMonth();
  const setpos = rule.by_setpos != null && rule.by_weekday.length > 0 ? rule.by_setpos : null;

  for (let k = 0; k <= MONTHLY_HORIZON; k += 1) {
    const total = anchorMonth + k * interval;
    const year = Math.floor(total / 12);
    const monthIndex = ((total % 12) + 12) % 12;

    let date: Date | null;
    if (setpos != null) {
      date = nthWeekdayInMonth(year, monthIndex, rule.by_weekday, setpos);
    } else {
      const day = Math.min(
        Math.max(rule.by_monthday ?? base.getDate(), 1),
        daysInMonth(year, monthIndex),
      );
      date = new Date(year, monthIndex, day);
    }
    if (!date) continue;
    const candidate = atSameClock(date, base);
    if (candidate.getTime() > after) return candidate.getTime();
  }

  return null;
}

/**
 * 完成本期后推进到下一期：跳过休眠/停机期间错过的时间，直到严格晚于 now。
 * `fromDue` 是进入本次操作时读到的期次（身份），为空表示任务本来没有截止时间。
 */
export function advanceOccurrence(
  rule: RecurrenceRule,
  fromDue: number | null,
  now: number,
): number | null {
  let base = fromDue ?? now;
  for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
    const next = nextOccurrence(rule, base);
    if (next == null) return null;
    if (next > now) return next;
    base = next;
  }
  return null;
}

/** 人类可读的规则说明，用于任务行徽标与动作表副标题 */
export function describeRecurrence(rule: RecurrenceRule): string {
  const isWorkdays =
    rule.by_weekday.length === WORKDAYS.length &&
    WORKDAYS.every((day, index) => rule.by_weekday[index] === day);

  if (rule.freq === "daily") {
    return rule.interval === 1 ? "每天" : `每 ${rule.interval} 天`;
  }

  if (rule.freq === "weekly") {
    if (isWorkdays) return rule.interval === 1 ? "工作日" : `每 ${rule.interval} 周的工作日`;
    if (rule.by_weekday.length === 0) return rule.interval === 1 ? "每周" : `每 ${rule.interval} 周`;
    const days = rule.by_weekday.map((day) => WEEKDAY_SHORT[day - 1]).join("、");
    return rule.interval === 1 ? `每周${days}` : `每 ${rule.interval} 周的周${days}`;
  }

  if (rule.by_setpos != null && rule.by_weekday.length > 0) {
    if (rule.by_setpos === -1) {
      return isWorkdays ? "每月最后一个工作日" : "每月最后一个指定星期";
    }
    return `每月第 ${rule.by_setpos} 个${
      rule.by_weekday.length === 1 ? WEEKDAY_CN[rule.by_weekday[0] - 1] : "指定星期"
    }`;
  }
  if (rule.by_monthday != null) {
    return rule.interval === 1 ? `每月 ${rule.by_monthday} 日` : `每 ${rule.interval} 月的 ${rule.by_monthday} 日`;
  }
  return "每月";
}

export type RecurrencePreset = "none" | "daily" | "weekly" | "monthly" | "workday";

/**
 * 由预设与基准时刻生成规则。基准一般取任务的截止时间（没有则取当前时刻）：
 * 这样「每周」落在用户选的那一天，「每月」落在用户选的那一号，不需要再做日期选择器。
 */
export function buildRecurrencePreset(
  preset: Exclude<RecurrencePreset, "none">,
  baseMs: number,
  anchorMs: number = baseMs,
): RecurrenceRule {
  const base = new Date(baseMs);
  const anchor = formatAnchor(anchorMs);
  switch (preset) {
    case "daily":
      return { freq: "daily", interval: 1, by_weekday: [], by_monthday: null, anchor };
    case "weekly":
      return {
        freq: "weekly",
        interval: 1,
        by_weekday: [weekdayNum(base)],
        by_monthday: null,
        anchor,
      };
    case "workday":
      return { freq: "weekly", interval: 1, by_weekday: [...WORKDAYS], by_monthday: null, anchor };
    case "monthly":
    default:
      return {
        freq: "monthly",
        interval: 1,
        by_weekday: [],
        by_monthday: base.getDate(),
        anchor,
      };
  }
}

/** 反向映射：现有规则能否被某个预设精确表达；不能则归为 custom（界面给「保持原定」） */
export function presetOf(rule: RecurrenceRule | null, baseMs: number): RecurrencePreset | "custom" {
  if (!rule) return "none";
  if (rule.interval !== 1 || rule.by_setpos != null) return "custom";

  const baseWeekday = weekdayNum(new Date(baseMs));
  if (rule.freq === "daily" && rule.by_weekday.length === 0) return "daily";

  if (rule.freq === "weekly") {
    const isWorkdays =
      rule.by_weekday.length === WORKDAYS.length &&
      WORKDAYS.every((day, index) => rule.by_weekday[index] === day);
    if (isWorkdays) return "workday";
    if (rule.by_weekday.length === 1 && rule.by_weekday[0] === baseWeekday) return "weekly";
    return "custom";
  }

  if (rule.freq === "monthly" && rule.by_monthday === new Date(baseMs).getDate()) {
    return "monthly";
  }
  return "custom";
}
