//! 纯函数时间/文本格式化（可测试，不依赖 Tauri）。

import type { RecurrenceRuleInput } from "./bridge";

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

/** 今天 / 明天 / 昨天 / 10-28 */
export function formatDayLabel(d: Date, now = new Date()): string {
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  if (diff === -1) return "昨天";
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
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = t - now.getTime();
  const abs = Math.abs(diff);
  let unit: string;
  let n: number;
  if (abs < 3600000) {
    unit = "分钟";
    n = Math.max(1, Math.floor(abs / 60000));
  } else if (abs < DAY) {
    unit = "小时";
    n = Math.max(1, Math.floor(abs / 3600000));
  } else {
    unit = "天";
    n = Math.max(1, Math.floor(abs / DAY));
  }
  const suffix = unit === "天" ? `${n} 天` : `${n} ${unit}`;
  return diff >= 0 ? `${suffix}后` : `${suffix}前`;
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

export const AGENT_STATE_LABELS: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  waiting: "等待处理",
  completed: "本轮完成",
  failed: "执行失败",
  disconnected: "已断开",
};

export const NOTIFICATION_KIND_LABELS: Record<string, string> = {
  reminder: "提醒",
  agent_waiting: "介入",
  agent_done: "完成",
  agent_failed: "失败",
  system: "系统",
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

/** 重复规则的中文描述。 */
export function describeRecurrence(rule: RecurrenceRuleInput | null): string {
  if (!rule || !rule.freq) return "";
  const wd = ["", "一", "二", "三", "四", "五", "六", "日"];
  const days = rule.by_weekday.map((d: number) => `周${wd[d] ?? d}`).join("、");
  switch (rule.freq) {
    case "daily":
      return rule.interval === 1 ? "每天" : `每 ${rule.interval} 天`;
    case "weekly":
      return `${days}${rule.interval > 1 ? `（每 ${rule.interval} 周）` : ""}`;
    case "monthly":
      return `每月 ${rule.by_monthday ?? 1} 号`;
    default:
      return "";
  }
}
