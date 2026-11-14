// 任务分组：纯展示层的切分，不改排序、不改筛选语义。
// 输入已是 selectTasksByFilter 排好序的结果，所以组内顺序沿用全局顺序
//（未完成→优先级→截止→新建）。
import { endOfWeekExclusive, startOfDay } from "../domain/taskQuery";
import type { Task } from "../domain/types";
import type { GroupHintTone, GroupTone } from "../components/TaskGroupHeader";

const DAY_MS = 86_400_000;

export type SectionKey = "today" | "week" | "later" | "undated" | "done";

/** 行在所属分组中的位置：首/末行决定分组卡的圆角 */
export type TaskRowPosition = "only" | "first" | "middle" | "last";

export interface TaskSection {
  key: SectionKey;
  title: string;
  tone: GroupTone;
  tasks: Task[];
  /** 分组头右侧的补充说明，例如「2 项已逾期」 */
  hint?: string;
  hintTone?: GroupHintTone;
}

export type TaskListRow =
  | { type: "section"; section: TaskSection }
  | { type: "task"; task: Task; entranceIndex: number; position: TaskRowPosition };

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
  const weekEnd = endOfWeekExclusive(now);
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
    hintTone?: GroupHintTone;
  }[] = [
    {
      key: "today",
      title: "今天",
      tone: "accent",
      hint: overdueInToday > 0 ? `${overdueInToday} 项已逾期` : undefined,
      hintTone: "warn",
    },
    { key: "week", title: "本周", tone: "muted" },
    { key: "later", title: "以后", tone: "muted" },
    { key: "undated", title: "无日期", tone: "muted" },
    { key: "done", title: "已完成", tone: "ok", hint: "勾选可恢复" },
  ];

  return definitions
    .map((definition) => ({
      ...definition,
      tasks: buckets[definition.key],
    }))
    .filter((section) => section.tasks.length > 0);
}

export function flattenSections(
  sections: TaskSection[],
  collapsed?: ReadonlySet<SectionKey>,
): TaskListRow[] {
  const rows: TaskListRow[] = [];
  let ordinal = 0;
  for (const section of sections) {
    rows.push({ type: "section", section });
    // 折叠只影响展示：分组头仍然保留，计数照常显示
    if (collapsed?.has(section.key)) continue;
    const total = section.tasks.length;
    for (let index = 0; index < total; index += 1) {
      const position: TaskRowPosition =
        total === 1 ? "only" : index === 0 ? "first" : index === total - 1 ? "last" : "middle";
      // 只有前 9 个任务参与入场 stagger；再多的行在滚动时直接呈现，避免列表一直"飞"
      rows.push({
        type: "task",
        task: section.tasks[index],
        entranceIndex: Math.min(ordinal, 9),
        position,
      });
      ordinal += 1;
    }
  }
  return rows;
}
