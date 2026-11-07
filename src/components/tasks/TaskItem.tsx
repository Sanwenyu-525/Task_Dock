//! 单个任务条目：完成（带撤销反馈）、双击或按钮编辑、元信息展示、关联目标跳转。
//!
//! v0.4：任务卡展示关联应用/网址/文件/Agent 图标（最多 3 个直列，其余折叠为
//! 数量入口）；点击图标 = 打开该目标（≠ 任务完成）；多目标经快捷菜单选择；
//! 菜单顶部提供「打开工作区」（批量启动由 WorkspaceLauncher 执行）。

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AlarmClock, Check, Clock, Repeat, Link2, Pencil, Rocket, Layers } from "lucide-react";
import type { Task } from "../../lib/bridge";
import { snoozeReminder } from "../../lib/bridge";
import { EXIT_MS, prefersReducedMotion } from "../../lib/motion";
import { useTasksStore, taskViewKey } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { formatDue, isOverdue, priorityLabel, describeRecurrence } from "../../lib/format";
import { navNavigate, resultMessage } from "../../lib/navigation";
import { errorMessage } from "../../lib/errors";
import { clearTip, syncTruncatedTip } from "../../lib/nameTip";
import TargetMenu, { TargetAvatar } from "../navigation/TargetMenu";
import { DropdownMenu } from "../ui";

interface Props {
  task: Task;
  compact?: boolean;
  /**
   * 后台刷新已把这一行抽走时，由任务列表按离场快照补渲染。
   * 此时沿用同一套离场外观与隔离，不再重复测高或起第二段动画。
   */
  exiting?: boolean;
  exitHeight?: number;
}

/** 离场结束后的焦点归属：相邻任务；没有相邻任务就回到列表入口控件。 */
function focusAfterExit(anchorId: string | null): void {
  const usable = (el: HTMLElement | null): el is HTMLElement =>
    !!el && !el.closest("[inert]") && !el.hasAttribute("disabled");
  if (anchorId) {
    const btn = document.querySelector<HTMLElement>(
      `[data-task-id="${CSS.escape(anchorId)}"] .task-check`,
    );
    // 不把焦点交给另一个正在离场的任务，也不交给不可用的按钮
    if (usable(btn)) {
      btn.focus();
      return;
    }
  }
  // 相邻任务也不可用（连续完成把后续任务也送去离场）时，退到列表里第一个仍在场的任务
  const alive = document.querySelector<HTMLElement>(
    ".tasks-panel .task-list [data-task-id]:not(.leaving):not([inert]) .task-check",
  );
  if (usable(alive)) {
    alive.focus();
    return;
  }
  const fallback =
    document.querySelector<HTMLElement>(".tasks-panel .quick-add-input") ??
    document.querySelector<HTMLElement>(".tasks-panel .filter-bar.primary .seg-btn");
  fallback?.focus();
}

/** 直列图标上限：超出部分折叠为数量入口，避免任务卡失控。 */
const MAX_INLINE_TARGETS = 3;
/** 紧凑模式更窄（320px 也要可用），直列只留 2 个。 */
const MAX_INLINE_TARGETS_COMPACT = 2;

export default function TaskItem({ task, compact, exiting, exitHeight }: Props) {
  const toggle = useTasksStore((s) => s.toggle);
  const refreshTasks = useTasksStore((s) => s.refresh);
  const holdForExit = useTasksStore((s) => s.holdForExit);
  const releaseExitHold = useTasksStore((s) => s.releaseExitHold);
  const filter = useTasksStore((s) => s.filter);
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
  const isLeaving = leaving || !!exiting;

  // 视图切换后旧视图的完成离场不再成立（任务可能在新列表里正常出现），立即撤掉离场态
  useEffect(() => {
    setLeaving(false);
  }, [filter]);

  async function onToggle() {
    if (busy || isLeaving) return;
    const was = task.status;
    const filterAtStart = useTasksStore.getState().filter;
    const viewAtStart = taskViewKey(filterAtStart);
    const willExitList = was === "pending" && (filterAtStart.status ?? "pending") === "pending";
    // 点击即进入执行中并提交后端；动画只负责「成功且会退出筛选」后的离场反馈，
    // 绝不为了动画推迟写入。列表刷新也等离场播完再发，避免这一行被提前抽走。
    setBusy(true);
    let held = false;
    /** 本次登记的离场快照序号：迟到的旧动画只能释放自己那一次。 */
    let holdToken: number | null = null;
    let handoff = false;
    let anchorId: string | null = null;
    try {
      const updated = await toggle(task.id, { refresh: false });
      // 请求在途期间用户可能已切筛选/搜索/排序：此时成功结果只同步后端，
      // 不得把旧视图的离场快照补渲染进新列表，也不得在新视图里演退出。
      const sameView = taskViewKey(useTasksStore.getState().filter) === viewAtStart;
      if (was === "pending" && updated.status === "completed") {
        // 默认停在「未完成」筛选：这一行会消失，说清是退出筛选而不是被删掉
        showToast(
          (filterAtStart.status ?? "pending") === "pending" && sameView
            ? `已完成「${updated.title}」，已退出「未完成」列表（任务仍在，切到「已完成」可看到）`
            : `已完成「${updated.title}」`,
          {
            kind: "success",
            action: {
              label: "撤销",
              run: () => {
                toggle(updated.id).catch((e) => showToast(`撤销失败：${errorMessage(e)}`, { kind: "error" }));
              },
            },
          },
        );
        if (willExitList && sameView) {
          const el = rowRef.current;
          const listEl = el?.closest(".task-list") ?? null;
          const rows = listEl
            ? Array.from(listEl.querySelectorAll<HTMLElement>("[data-task-id]"))
            : [];
          const selfIndex = el ? rows.indexOf(el) : -1;
          const alive = (row: HTMLElement) =>
            !row.classList.contains("leaving") && !row.hasAttribute("inert");
          const nextId =
            selfIndex >= 0 ? rows.slice(selfIndex + 1).find(alive)?.dataset.taskId ?? null : null;
          const prevId =
            selfIndex > 0
              ? rows.slice(0, selfIndex).reverse().find(alive)?.dataset.taskId ?? null
              : null;
          anchorId = nextId ?? prevId;
          // 焦点原本在被点的这一行（inert 后浏览器会把它丢到 body）→ 离场结束交还列表
          handoff =
            document.activeElement === document.body || (!!el && el.contains(document.activeElement));
          if (!prefersReducedMotion() && el) {
            // 高度只量这一次；后端已成功，接下来只是把这一行收拢退出
            const height = el.offsetHeight;
            el.style.setProperty("--clip-exit-h", `${height}px`);
            // 后台整表刷新可能先抽走这一行：登记快照，动画期间由列表按原位置补渲染
            holdToken = holdForExit(task, Math.max(0, selfIndex), nextId, height);
            held = true;
            setLeaving(true);
            await new Promise((r) => setTimeout(r, EXIT_MS));
          }
        }
      } else if (was === "completed") {
        // 取消完成此前完全静默：状态翻了却没有任何反馈
        showToast(`已重新打开「${updated.title}」`, { kind: "info" });
      }
      // 离场播完（或不需要离场）后再按服务端结果同步列表
      await refreshTasks();
      // 撤销或刷新失败后任务仍在列表里：撤掉离场态，不能让它一直不可见/不可操作
      if (held && useTasksStore.getState().tasks.some((t) => t.id === task.id)) {
        setLeaving(false);
      }
      // 视图没在请求期间变过才交还焦点，避免把焦点抢到另一个筛选的列表里
      if (handoff && taskViewKey(useTasksStore.getState().filter) === viewAtStart) {
        focusAfterExit(anchorId);
      }
    } catch (e) {
      // 后端没成功：从未进入离场状态，任务原位保持正常
      setLeaving(false);
      showToast(`更新任务状态失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      if (held && holdToken !== null) releaseExitHold(task.id, holdToken);
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
      showToast(`打开「${name}」失败：${errorMessage(e)}`, { kind: "error" });
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
      showToast(`延后提醒失败：${errorMessage(e)}`, { kind: "error" });
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
      className={`task-card task-item priority-${task.priority} ${task.status} ${isLeaving ? "leaving" : ""}`}
      // 离场期间同时隔离鼠标与键盘：inert 让内部控件不可聚焦/不可点击，
      // aria-hidden 让读屏器不再朗读正在退场的条目；结束后由列表交还焦点。
      inert={isLeaving || undefined}
      aria-hidden={isLeaving || undefined}
      style={
        exiting && exitHeight
          ? ({ "--clip-exit-h": `${exitHeight}px` } as CSSProperties)
          : undefined
      }
    >
      <button
        className={`task-check ${task.status === "completed" ? "done" : ""}`}
        onClick={onToggle}
        data-tip={task.status === "completed" ? "取消完成" : "完成"}
        aria-label={task.status === "completed" ? "取消完成" : "完成任务"}
        aria-busy={busy}
        disabled={busy || isLeaving}
      >
        {task.status === "completed" && <Check size={12} />}
      </button>
      <div
        className="task-main"
        onDoubleClick={() => openEditor(task)}
        data-tip={compact ? "双击编辑" : undefined}
      >
        <div
          className="task-title-row"
          // 长标题单行省略后没有任何可读补偿（验收 UI-12）：悬停时只在
          // 真的发生截断时挂完整标题，未截断不制造噪声提示。
          onMouseEnter={(e) => syncTruncatedTip(e.currentTarget, ".task-title", task.title)}
          onMouseLeave={(e) => clearTip(e.currentTarget)}
        >
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
                data-tip={`打开：${l.target.display_name}${l.is_default ? "（默认目标）" : ""}`}
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
                data-tip={`还有 ${overflow} 个关联目标`}
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
          <button className="icon-btn sm task-edit" onClick={() => openEditor(task)} data-tip="编辑任务" aria-label="编辑任务">
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
