// 纯函数查询层：不依赖 React、不依赖 SQLite，未来可直接迁入 shared/。
// 桌面端同语义实现在 Rust，此处保证手机端离线视图与桌面一致。
import type { Task, TaskCounts, TaskFilter } from "./types";

const DAY_MS = 86_400_000;

/** 设备本地时区的当天 00:00（不用 UTC 日界，避免跨时区把今天算成昨天） */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isOverdue(task: Task, now: number): boolean {
  if (task.status === "completed") return false;
  if (task.dueAt == null) return false;
  return task.dueAt < now;
}

export function isDueToday(task: Task, now: number): boolean {
  if (task.status === "completed") return false;
  if (task.dueAt == null) return false;
  const start = startOfDay(now);
  return task.dueAt >= start && task.dueAt < start + DAY_MS;
}

export function matchesFilter(task: Task, filter: TaskFilter, now: number): boolean {
  switch (filter) {
    case "all":
      return true;
    case "pending":
      return task.status === "pending";
    case "completed":
      return task.status === "completed";
    case "today":
      return isDueToday(task, now);
    case "overdue":
      return isOverdue(task, now);
    default:
      return false;
  }
}

/**
 * 排序口径（与桌面端列表一致）：
 * 未完成在前 → 优先级高在前 → 有截止时间在前（早的在前）→ 新建的在前。
 * 全部用显式比较，避免依赖 Array.sort 的不稳定实现造成两端顺序漂移。
 */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    const ad = a.dueAt ?? Number.POSITIVE_INFINITY;
    const bd = b.dueAt ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return b.createdAt - a.createdAt;
  });
}

export function selectTasks(tasks: Task[], filter: TaskFilter, now: number): Task[] {
  return sortTasks(tasks.filter((t) => matchesFilter(t, filter, now)));
}

export function countTasks(tasks: Task[], now: number): TaskCounts {
  let pending = 0;
  let completed = 0;
  let dueToday = 0;
  let overdue = 0;
  for (const t of tasks) {
    if (t.status === "completed") completed += 1;
    else pending += 1;
    if (isDueToday(t, now)) dueToday += 1;
    if (isOverdue(t, now)) overdue += 1;
  }
  return { total: tasks.length, pending, completed, dueToday, overdue };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 截止时间展示：今天/明天/月-日 + HH:mm；已过期加前缀 */
export function formatDue(dueAt: number | null, now: number): string | null {
  if (dueAt == null) return null;
  const d = new Date(dueAt);
  const start = startOfDay(now);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let label: string;
  if (dueAt >= start && dueAt < start + DAY_MS) label = `今天 ${hhmm}`;
  else if (dueAt >= start + DAY_MS && dueAt < start + 2 * DAY_MS) label = `明天 ${hhmm}`;
  else label = `${d.getMonth() + 1}-${pad(d.getDate())} ${hhmm}`;
  return dueAt < now ? `已过期 · ${label}` : label;
}

/** 「10 分钟前 / 3 小时前 / 11-07」，用于收集箱与任务副标题 */
export function formatRelative(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${pad(d.getDate())}`;
}
