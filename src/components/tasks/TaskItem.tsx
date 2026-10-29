//! 单个任务条目：完成（带撤销反馈）、双击或按钮编辑、元信息展示、关联目标跳转。
//!
//! v0.4：任务卡展示关联应用/网址/文件/Agent 图标（最多 3 个直列，其余折叠为
//! 数量入口）；点击图标 = 打开该目标（≠ 任务完成）；多目标经快捷菜单选择；
//! 菜单顶部提供「打开工作区」（批量启动由 WorkspaceLauncher 执行）。

import { useState } from "react";
import { Check, Clock, Repeat, Link2, Pencil, Rocket, Layers } from "lucide-react";
import type { Task } from "../../lib/bridge";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { formatDue, isOverdue, priorityLabel, describeRecurrence } from "../../lib/format";
import { navNavigate, resultMessage } from "../../lib/navigation";
import TargetMenu, { TargetAvatar } from "../navigation/TargetMenu";

interface Props {
  task: Task;
  compact?: boolean;
}

/** 直列图标上限：超出部分折叠为数量入口，避免任务卡失控。 */
const MAX_INLINE_TARGETS = 3;
/** 紧凑模式更窄（320px 也要可用），直列只留 2 个。 */
const MAX_INLINE_TARGETS_COMPACT = 2;

export default function TaskItem({ task, compact }: Props) {
  const toggle = useTasksStore((s) => s.toggle);
  const openEditor = useUiStore((s) => s.openEditor);
  const showToast = useUiStore((s) => s.showToast);
  const openWorkspace = useUiStore((s) => s.openWorkspace);
  const openContext = useUiStore((s) => s.openContext);
  const links = useNavigationStore((s) => s.linksByTask[task.id]) ?? [];
  const [menuOpen, setMenuOpen] = useState(false);
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

  /** 点击目标图标：直接跳转（任务状态不受影响）。 */
  async function navigateTarget(targetId: string, name: string, behavior: string, linkId: string) {
    const action =
      behavior === "launch"
        ? "open_app"
        : behavior === "focus_or_launch"
          ? "focus_window"
          : behavior === "resume_session"
            ? "resume_session"
            : undefined;
    try {
      const r = await navNavigate(targetId, { action, task_link_id: linkId });
      showToast(resultMessage(r, name), { kind: r.success ? "success" : "error" });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  const inline = links.slice(0, compact ? MAX_INLINE_TARGETS_COMPACT : MAX_INLINE_TARGETS);
  const overflow = links.length - inline.length;
  // 工作区入口在两种模式下都必须可达：
  // 旧实现把它挂在 `!compact` 上，而「+N」入口只在 >3 个目标时出现，
  // 于是紧凑模式下关联 2~3 个目标时**完全没有**启动整个工作区的入口。
  const canLaunchWorkspace = links.length >= 2;

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
        {links.length > 0 && (
          <div className="task-nav-row" role="group" aria-label="关联目标">
            {inline.map((l) => (
              <button
                key={l.id}
                className="task-nav-btn"
                title={`打开：${l.target.display_name}`}
                aria-label={`打开 ${l.target.display_name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  navigateTarget(l.target_id, l.target.display_name, l.launch_behavior, l.id);
                }}
              >
                <TargetAvatar link={l} size={18} />
              </button>
            ))}
            {overflow > 0 && (
              <button
                className="task-nav-btn task-nav-more"
                title={`还有 ${overflow} 个关联目标`}
                aria-label={`还有 ${overflow} 个关联目标`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                }}
              >
                +{overflow}
              </button>
            )}
          </div>
        )}
      </div>
      {!compact && (
        <>
          <button
            className="icon-btn sm task-context"
            onClick={() => openContext(task)}
            title="任务上下文（现场 / Agent / 关联）"
            aria-label="任务上下文"
          >
            <Layers size={13} />
          </button>
          <button className="icon-btn sm task-edit" onClick={() => openEditor(task)} title="编辑任务" aria-label="编辑任务">
            <Pencil size={13} />
          </button>
        </>
      )}
      {menuOpen && links.length > 0 && (
        <>
          {/* 点击卡片其余区域关闭菜单 */}
          <div className="target-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="target-menu-anchor">
            <TargetMenu
              links={links}
              onClose={() => setMenuOpen(false)}
              onNavigate={(l) => navigateTarget(l.target_id, l.target.display_name, l.launch_behavior, l.id)}
              onOpenAll={
                links.length >= 2
                  ? () => {
                      setMenuOpen(false);
                      openWorkspace(task);
                    }
                  : undefined
              }
            />
          </div>
        </>
      )}
      {/* 快捷工作区入口：≥2 目标时显示（紧凑模式同样可用） */}
      {canLaunchWorkspace && (
        <button
          className="icon-btn sm task-workspace"
          title="打开工作区（批量启动关联目标）"
          aria-label="打开工作区"
          onClick={() => openWorkspace(task)}
        >
          <Rocket size={13} />
        </button>
      )}
    </div>
  );
}
