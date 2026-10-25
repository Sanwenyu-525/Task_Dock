//! 单个任务条目：完成（带撤销反馈）、双击或按钮编辑、元信息展示。

import { Check, Clock, Repeat, Link2, Pencil } from "lucide-react";
import type { Task } from "../../lib/bridge";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import { formatDue, isOverdue, priorityLabel, describeRecurrence } from "../../lib/format";

interface Props {
  task: Task;
  compact?: boolean;
}

export default function TaskItem({ task, compact }: Props) {
  const toggle = useTasksStore((s) => s.toggle);
  const openEditor = useUiStore((s) => s.openEditor);
  const showToast = useUiStore((s) => s.showToast);
  const overdue = task.status === "pending" && isOverdue(task.due_at);

  async function onToggle() {
    const was = task.status;
    try {
      const updated = await toggle(task.id);
      if (was === "pending" && updated.status === "completed") {
        showToast(`已完成「${updated.title}」`, {
          kind: "success",
          action: {
            label: "撤销",
            run: () => {
              toggle(updated.id).catch((e) => showToast(`撤销失败：${String(e)}`, { kind: "error" }));
            },
          },
        });
      }
    } catch (e) {
      showToast(`操作失败：${String(e)}`, { kind: "error" });
    }
  }

  return (
    <div className={`task-item priority-${task.priority} ${task.status}`}>
      <button
        className={`task-check ${task.status === "completed" ? "done" : ""}`}
        onClick={onToggle}
        title={task.status === "completed" ? "取消完成" : "完成"}
        aria-label={task.status === "completed" ? "取消完成" : "完成任务"}
      >
        {task.status === "completed" && <Check size={12} />}
      </button>
      <div
        className="task-main"
        onDoubleClick={() => openEditor(task)}
        title={compact ? "双击编辑" : undefined}
      >
        <div className="task-title-row">
          <span className={`priority-tag p${task.priority}`}>{priorityLabel(task.priority)}</span>
          <span className="task-title">{task.title}</span>
        </div>
        <div className="task-meta">
          {task.due_at && (
            <span className={`task-due ${overdue ? "overdue" : ""}`}>
              <Clock size={11} /> {formatDue(task.due_at)}
            </span>
          )}
          {task.recurrence && (
            <span className="task-rec" title={`重复：${describeRecurrence(task.recurrence)}`}>
              <Repeat size={11} /> {describeRecurrence(task.recurrence)}
            </span>
          )}
          {task.category && <span className="task-cat">{task.category}</span>}
          {task.tags.map((t) => (
            <span key={t} className="task-tag">
              #{t}
            </span>
          ))}
          {task.linked_agents > 0 && (
            <span className="task-link" title={`关联 ${task.linked_agents} 个 Agent 会话`}>
              <Link2 size={11} /> {task.linked_agents}
            </span>
          )}
        </div>
      </div>
      {!compact && (
        <button className="icon-btn sm task-edit" onClick={() => openEditor(task)} title="编辑任务" aria-label="编辑任务">
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}
