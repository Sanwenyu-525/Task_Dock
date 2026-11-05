//! 今日任务微件：只读展示，数据与任务页共用 useTasksStore.tasks / stats。
//! 点击条目打开现有任务编辑器，不复制任务操作与缓存。

import { AlertCircle, ChevronRight, ListTodo } from "lucide-react";

import { formatDue } from "../../lib/format";
import type { Task } from "../../lib/bridge";
import type { WidgetConfig } from "../../lib/widgets/model";
import { todayPendingTasks } from "../../lib/widgets/selectors";
import { useLocale } from "../../hooks/useLocale";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import { openFullApp } from "../capsule/actions";

export interface TodayTasksWidgetProps {
  config: WidgetConfig;
  /** 独立桌面窗口：把「打开任务」转交主窗口，不在本窗口改 UI 状态。 */
  onOpenTask?: (task: Task) => void;
  /** 独立桌面窗口：把「打开任务页」转交主窗口。 */
  onOpenPanel?: () => void;
}

export default function TodayTasksWidget({ config, onOpenTask, onOpenPanel }: TodayTasksWidgetProps) {
  const { t } = useLocale();
  const tasks = useTasksStore((s) => s.tasks);
  const stats = useTasksStore((s) => s.stats);
  const error = useTasksStore((s) => s.error);
  const statsError = useTasksStore((s) => s.statsError);
  const loading = useTasksStore((s) => s.loading);
  const openEditor = useUiStore((s) => s.openEditor);

  const maxItems = typeof config.maxItems === "number" ? config.maxItems : 5;
  const now = Date.now();
  const items = todayPendingTasks(tasks, now).slice(0, maxItems);

  const summary = stats
    ? t("widgets.todayTasks.dueOverdue", { due: stats.due_today, overdue: stats.overdue })
    : statsError
      ? t("widgets.todayTasks.statsStale")
      : t("widgets.todayTasks.statsLoading");
  // 列表读取失败时旧 tasks 会被保留；不能把失败显示成「今天没有到期任务」。
  const warning = statsError ?? error;

  return (
    <div className="widget-today">
      <div className="widget-status-line">
        <span>{summary}</span>
        {warning && (
          <span className="widget-warn-note" data-tip={warning}>
            <AlertCircle size={12} aria-hidden="true" />
            <span>{t("widgets.todayTasks.staleShort")}</span>
          </span>
        )}
      </div>

      {items.length > 0 ? (
        <ul className="widget-list" aria-label={t("widgets.todayTasks.listAria")}>
          {items.map((task) => {
            const overdue = task.due_at ? new Date(task.due_at).getTime() < now : false;
            return (
              <li key={task.id}>
                <button
                  className="widget-row"
                  aria-label={t("widgets.todayTasks.openAria", { title: task.title })}
                  onClick={() => (onOpenTask ? onOpenTask(task) : openEditor(task))}
                >
                  <span className="widget-task-title">{task.title}</span>
                  <span className={`widget-task-meta ${overdue ? "overdue" : ""}`}>
                    {overdue ? t("widgets.todayTasks.overdue") : formatDue(task.due_at)}
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
          <span>
            {loading
              ? t("common.loading")
              : error
                ? t("common.failed")
                : t("widgets.todayTasks.empty")}
          </span>
        </div>
      )}

      <div className="widget-foot">
        <button
          className="widget-link"
          onClick={() => (onOpenPanel ? onOpenPanel() : openFullApp("tasks"))}
        >
          {t("widgets.todayTasks.openPanel")}
        </button>
      </div>
    </div>
  );
}
