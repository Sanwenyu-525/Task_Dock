//! 胶囊面板的时间文案（纯函数，可单测）。
//!
//! 与主窗口的完整时间格式刻意不同：胶囊空间窄，只回答"什么时候 / 过期多久"。

const pad = (n: number): string => String(n).padStart(2, "0");

/** 相对时长的紧凑写法：45m / 3h / 2d。 */
export function humanGap(ms: number): string {
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  if (min < 60) return `${Math.max(1, min)}m`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour}h`;
  return `${Math.round(hour / 24)}d`;
}

export interface DueLabel {
  text: string;
  /** overdue = 已过期（语义色）；soon = 24h 内；normal = 其他 */
  tone: "overdue" | "soon" | "normal";
}

/**
 * 任务截止文案。
 * - 无截止时间 → 「无期限」；
 * - 已过期 → 「逾期 2h」；
 * - 今天/明天 → 「今天 18:00」「明天 09:30」；
 * - 其他 → 「11月3日」。
 */
export function dueLabel(iso: string | null, now: number = Date.now()): DueLabel {
  if (!iso) return { text: "无期限", tone: "normal" };
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return { text: "无期限", tone: "normal" };
  const diff = t - now;
  if (diff < 0) return { text: `逾期 ${humanGap(diff)}`, tone: "overdue" };
  const d = new Date(t);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return { text: `今天 ${hhmm}`, tone: "soon" };
  if (isTomorrow) return { text: `明天 ${hhmm}`, tone: "soon" };
  const text =
    d.getFullYear() === today.getFullYear()
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return { text, tone: diff <= 24 * 3600 * 1000 ? "soon" : "normal" };
}

/** 待办排序：过期优先，其次按截止时间升序，无期限排最后；同档按创建时间倒序。 */
export function sortPending<T extends { due_at: string | null; created_at: string }>(
  list: readonly T[],
  now: number = Date.now(),
): T[] {
  const rank = (t: T): number => {
    if (!t.due_at) return 2;
    const ts = new Date(t.due_at).getTime();
    return Number.isFinite(ts) && ts < now ? 0 : 1;
  };
  return [...list].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const da = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
    const db = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return b.created_at.localeCompare(a.created_at);
  });
}
