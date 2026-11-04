//! 今日任务微件：只读展示，数据与任务页共用 useTasksStore.tasks / stats。
//! 点击条目打开现有任务编辑器，不复制任务操作与缓存。

import { AlertCircle, ChevronRight, ListTodo } from "lucide-react";

import { formatDue } from "../../lib/format";
import type { WidgetConfig } from "../../lib/widgets/model";
import { todayPendingTasks } from "../../lib/widgets/selectors";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import { openFullApp } from "../capsule/actions";

export default function TodayTasksWidget({ config }: { config: WidgetConfig }) {
  const tasks = useTasksStore((s) => s.tasks);
  const stats = useTasksStore((s) => s.stats);
  const statsError = useTasksStore((s) => s.statsError);
  const loading = useTasksStore((s) => s.loading);
  const openEditor = useUiStore((s) => s.openEditor);

  const maxItems = typeof config.maxItems === "number" ? config.maxItems : 5;
  const now = Date.now();
  const items = todayPendingTasks(tasks, now).slice(0, maxItems);

  const summary = stats
    ? `今日到期 ${stats.due_today} · 逾期 ${stats.overdue}`
    : statsError
      ? "统计未刷新"
      : "统计读取中";

  return (
    <div className="widget-today">
      <div className="widget-status-line">
        <span>{summary}</span>
        {statsError && (
          <span className="widget-warn" data-tip={statsError}>
            <AlertCircle size={12} aria-hidden="true" />
          </span>
        )}
      </div>

      {items.length > 0 ? (
        <ul className="widget-list" aria-label="今日待办">
          {items.map((task) => {
            const overdue = task.due_at ? new Date(task.due_at).getTime() < now : false;
            return (
              <li key={task.id}>
                <button
                  className="widget-row"
                  aria-label={`打开任务「${task.title}」`}
                  onClick={() => openEditor(task)}
                >
                  <span className="widget-task-title">{task.title}</span>
                  <span className={`widget-task-meta ${overdue ? "overdue" : ""}`}>
                    {overdue ? "已逾期" : formatDue(task.due_at)}
                  </span>
                  <ChevronRight size={12} className="widget-row-chevron" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="widget-empty">
          <ListTodo size={20} aria-hidden="true" />
          <span>{loading ? "读取中…" : "今天没有到期任务"}</span>
        </div>
      )}

      <div className="widget-foot">
        <button className="widget-link" onClick={() => openFullApp("tasks")}>
          打开任务页
        </button>
      </div>
    </div>
  );
}
