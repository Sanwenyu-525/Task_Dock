//! 单个任务条目：完成（带撤销反馈）、双击或按钮编辑、元信息展示、关联目标跳转。
//!
//! v0.4：任务卡展示关联应用/网址/文件/Agent 图标（最多 3 个直列，其余折叠为
//! 数量入口）；点击图标 = 打开该目标（≠ 任务完成）；多目标经快捷菜单选择；
//! 菜单顶部提供「打开工作区」（批量启动由 WorkspaceLauncher 执行）。

import { useRef, useState } from "react";
import { AlarmClock, Check, Clock, Repeat, Link2, Pencil, Rocket, Layers } from "lucide-react";
import type { Task } from "../../lib/bridge";
import { snoozeReminder } from "../../lib/bridge";
import { EXIT_MS, prefersReducedMotion } from "../../lib/motion";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { formatDue, isOverdue, priorityLabel, describeRecurrence } from "../../lib/format";
import { navNavigate, resultMessage } from "../../lib/navigation";
import TargetMenu, { TargetAvatar } from "../navigation/TargetMenu";
import { DropdownMenu } from "../ui";

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
  const refreshTasks = useTasksStore((s) => s.refresh);
  const statusFilter = useTasksStore((s) => s.filter.status);
  const openEditor = useUiStore((s) => s.openEditor);
  const showToast = useUiStore((s) => s.showToast);
  const openWorkspace = useUiStore((s) => s.openWorkspace);
  const openContext = useUiStore((s) => s.openContext);
  const links = useNavigationStore((s) => s.linksByTask[task.id]) ?? [];
  const [menuOpen, setMenuOpen] = useState(false);
  /** 状态切换请求在途：挡住连点把同一条任务翻回翻去 */
  const [busy, setBusy] = useState(false);
  /** 延后请求在途：挡住连点发出多次 snooze */
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  /**
   * 完成（默认未完成筛选下会退出列表）：先播一段收拢淡出再提交刷新。
   * 动画只是反馈层——失败会立即移除该状态弹回原位，结果永远以后端为准。
   */
  const [leaving, setLeaving] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const overdue = task.status === "pending" && isOverdue(task.due_at);

  async function onToggle() {
    if (busy) return;
    const was = task.status;
    const willExitList = was === "pending" && (statusFilter ?? "pending") === "pending";
    setBusy(true);
    try {
      if (willExitList && !prefersReducedMotion()) {
        const el = rowRef.current;
        if (el) {
          // 高度只量这一次；等收拢播完再刷新，避免列表先抽走这一行导致动画被截断
          el.style.setProperty("--clip-exit-h", `${el.offsetHeight}px`);
          setLeaving(true);
          await new Promise((r) => setTimeout(r, EXIT_MS));
        }
      }
      const updated = await toggle(task.id);
      if (was === "pending" && updated.status === "completed") {
        // 默认停在「未完成」筛选：这一行会消失，说清是退出筛选而不是被删掉
        showToast(
          (statusFilter ?? "pending") === "pending"
            ? `已完成「${updated.title}」，已退出「未完成」列表（任务仍在，切到「已完成」可看到）`
            : `已完成「${updated.title}」`,
          {
            kind: "success",
            action: {
              label: "撤销",
              run: () => {
                toggle(updated.id).catch((e) => showToast(`撤销失败：${String(e)}`, { kind: "error" }));
              },
            },
          },
        );
      } else if (was === "completed") {
        // 取消完成此前完全静默：状态翻了却没有任何反馈
        showToast(`已重新打开「${updated.title}」`, { kind: "info" });
      }
    } catch (e) {
      // 后端没成功：撤掉离场状态，任务原位保持正常
      setLeaving(false);
      showToast(`操作失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
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

  /**
   * 延后提醒（任务卡入口）：走真实后端 snooze_reminder。
   * 成功反馈（含撤销）由 reminder-snoozed 事件统一弹 Toast，这里只报失败。
   */
  async function onSnooze(minutes: number) {
    if (snoozeBusy) return;
    setSnoozeBusy(true);
    try {
      await snoozeReminder(task.id, minutes);
      await refreshTasks();
    } catch (e) {
      showToast(`延后失败：${String(e)}`, { kind: "error" });
    } finally {
      setSnoozeBusy(false);
    }
  }

  // 默认目标排在最前：让「一键打开默认入口」在窄窗/紧凑模式下也可见，
  // 而不是被前几个非默认目标挤出直列区（默认值仍由 TaskEditor 显式设置）。
  const orderedLinks = [...links].sort(
    (a, b) => Number(b.is_default) - Number(a.is_default),
  );
  const inline = orderedLinks.slice(
    0,
    compact ? MAX_INLINE_TARGETS_COMPACT : MAX_INLINE_TARGETS,
  );
  const overflow = links.length - inline.length;
  // 工作区入口在两种模式下都必须可达：
  // 旧实现把它挂在 `!compact` 上，而「+N」入口只在 >3 个目标时出现，
  // 于是紧凑模式下关联 2~3 个目标时**完全没有**启动整个工作区的入口。
  const canLaunchWorkspace = links.length >= 2;

  return (
    <div
      ref={rowRef}
      data-task-id={task.id}
      className={`task-card task-item priority-${task.priority} ${task.status} ${leaving ? "leaving" : ""}`}
    >
      <button
        className={`task-check ${task.status === "completed" ? "done" : ""}`}
        onClick={onToggle}
        title={task.status === "completed" ? "取消完成" : "完成"}
        aria-label={task.status === "completed" ? "取消完成" : "完成任务"}
        aria-busy={busy}
        disabled={busy}
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
          {task.status === "pending" && task.next_remind_at && (
            <span className="task-next-remind">
              <AlarmClock size={11} /> 提醒 {formatDue(task.next_remind_at)}
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
                data-default={l.is_default ? "true" : undefined}
                title={`打开：${l.target.display_name}${l.is_default ? "（默认目标）" : ""}`}
                aria-label={`打开${l.is_default ? "默认目标 " : " "}${l.target.display_name}`}
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
          {task.status === "pending" && task.next_remind_at && (
            <DropdownMenu
              disabled={snoozeBusy}
              trigger={({ ref, expanded, onClick, onKeyDown }) => (
                <button
                  ref={ref}
                  className="icon-btn sm task-snooze"
                  data-tip="延后提醒"
                  aria-label={`延后「${task.title}」的提醒`}
                  aria-expanded={expanded}
                  aria-haspopup="menu"
                  disabled={snoozeBusy}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                >
                  <AlarmClock size={13} />
                </button>
              )}
              items={[
                { key: "5", label: "5 分钟后再提醒", onSelect: () => void onSnooze(5) },
                { key: "10", label: "10 分钟后再提醒", onSelect: () => void onSnooze(10) },
                { key: "30", label: "30 分钟后再提醒", onSelect: () => void onSnooze(30) },
                { key: "60", label: "1 小时后再提醒", onSelect: () => void onSnooze(60) },
              ]}
              menuLabel="延后提醒"
            />
          )}
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
          data-tip="打开工作区（批量启动关联目标）"
          aria-label="打开工作区"
          onClick={() => openWorkspace(task)}
        >
          <Rocket size={13} />
        </button>
      )}
    </div>
  );
}
