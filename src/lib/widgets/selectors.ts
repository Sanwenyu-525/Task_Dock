//! 微件展示层派生（纯函数，可测试）。
//!
//! 只对现有 Store / 查询结果做筛选与排序，不访问数据库、不缓存业务数据。

import type { AgentRun, Task } from "../bridge";
import { liveRuns } from "../agentTree";

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 今日待办：pending、有截止时间、且截止时间不晚于今天 24:00。
 * 已逾期的任务仍算「今天要处理」，排在列表前面（由 due 升序自然满足）。
 * 不补查后端：数据来自任务页共用的 useTasksStore.tasks。
 */
export function todayPendingTasks(tasks: Task[], now = Date.now()): Task[] {
  const endOfToday = startOfToday(now) + 86_400_000;
  return tasks
    .filter((task) => {
      if (task.status === "completed") return false;
      if (!task.due_at) return false;
      const due = new Date(task.due_at).getTime();
      return Number.isFinite(due) && due < endOfToday;
    })
    .sort((a, b) => {
      const da = new Date(a.due_at ?? 0).getTime();
      const db = new Date(b.due_at ?? 0).getTime();
      return da - db;
    });
}

const RUN_PRIORITY: Record<string, number> = {
  failed: 0,
  waiting: 1,
  running: 2,
  disconnected: 3,
};

/** 需要关注的实时轮次：失败 > 等待介入 > 运行中 > 失联，再按最近更新倒序。 */
export function attentionRuns(runs: AgentRun[], now = Date.now(), limit = 3): AgentRun[] {
  return liveRuns(runs, now)
    .sort(
      (a, b) =>
        (RUN_PRIORITY[a.status] ?? 4) - (RUN_PRIORITY[b.status] ?? 4) ||
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )
    .slice(0, Math.max(0, limit));
}

/** 倒计时剩余毫秒；绝对时间非法时返回 null（不伪造 0）。 */
export function remainingMs(endsAt: string | null | undefined, now = Date.now()): number | null {
  if (!endsAt) return null;
  const t = new Date(endsAt).getTime();
  if (!Number.isFinite(t)) return null;
  return t - now;
}
