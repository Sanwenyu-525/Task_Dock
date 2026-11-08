// 任务分组：纯展示层的切分，不改排序、不改筛选语义。
// 输入已是 selectTasks 排好序的结果，所以组内顺序沿用全局顺序（未完成→优先级→截止→新建）。
import { startOfDay } from "../domain/taskQuery";
import type { Task } from "../domain/types";
import type { GroupTone } from "../components/TaskGroupHeader";

const DAY_MS = 86_400_000;

export type SectionKey = "today" | "week" | "later" | "undated" | "done";

export interface TaskSection {
  key: SectionKey;
  title: string;
  tone: GroupTone;
  tasks: Task[];
  /** 分组头右侧的补充说明，例如「2 项已逾期」 */
  hint?: string;
  /** 仅「今天」分组：其中已逾期的条数，用于分组头提示 */
  overdue: number;
}

export type TaskListRow =
  | { type: "section"; section: TaskSection }
  | { type: "task"; task: Task; entranceIndex: number };

/** 本周边界（开区间）：下周一 00:00；今天就是周日时是明天 00:00 */
function weekEndExclusive(now: number): number {
  const weekday = new Date(now).getDay();
  return startOfDay(now) + (((7 - weekday) % 7) + 1) * DAY_MS;
}

function sectionOf(task: Task, now: number, weekEnd: number): SectionKey {
  if (task.status === "completed") return "done";
  if (task.dueAt == null) return "undated";
  // 逾期项归入「今天」，保证「今天」组永远是第一个需要处理的地方
  const todayEnd = startOfDay(now) + DAY_MS;
  if (task.dueAt < todayEnd) return "today";
  if (task.dueAt < weekEnd) return "week";
  return "later";
}

export function buildTaskSections(tasks: Task[], now: number): TaskSection[] {
  const weekEnd = weekEndExclusive(now);
  const buckets: Record<SectionKey, Task[]> = {
    today: [],
    week: [],
    later: [],
    undated: [],
    done: [],
  };
  for (const task of tasks) {
    buckets[sectionOf(task, now, weekEnd)].push(task);
  }

  const overdueInToday = buckets.today.filter(
    (task) => task.status === "pending" && task.dueAt != null && task.dueAt < now,
  ).length;

  const definitions: {
    key: SectionKey;
    title: string;
    tone: GroupTone;
    hint?: string;
  }[] = [
    {
      key: "today",
      title: "今天",
      tone: "accent",
      hint: overdueInToday > 0 ? `${overdueInToday} 项已逾期` : undefined,
    },
    { key: "week", title: "本周", tone: "muted" },
    { key: "later", title: "以后", tone: "muted" },
    { key: "undated", title: "无日期", tone: "muted" },
    { key: "done", title: "已完成", tone: "ok", hint: "轻点可恢复" },
  ];

  return definitions
    .map((definition) => ({
      ...definition,
      tasks: buckets[definition.key],
      overdue: definition.key === "today" ? overdueInToday : 0,
    }))
    .filter((section) => section.tasks.length > 0);
}

export function flattenSections(sections: TaskSection[]): TaskListRow[] {
  const rows: TaskListRow[] = [];
  let ordinal = 0;
  for (const section of sections) {
    rows.push({ type: "section", section });
    for (const task of section.tasks) {
      // 只有前 9 个任务参与入场 stagger；再多的行在滚动时直接呈现，避免列表一直"飞"
      rows.push({ type: "task", task, entranceIndex: Math.min(ordinal, 9) });
      ordinal += 1;
    }
  }
  return rows;
}
