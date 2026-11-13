//! 任务面板：紧凑概览 → 快速添加 → 日期筛选/工具 → 搜索/状态/排序 → 提醒摘要 → 列表。
//! 筛选器视觉权重低于任务本身；搜索框常驻在日期筛选下方，不随列表滚动。
//! v0.6：卡片层级与空状态插画按视觉预设重绘（结构不变，两套皮肤共用）。
//! v0.9：编辑任务改为页面内编辑态（列表 ↔ 编辑切换），退出后恢复列表滚动位置；
//! 筛选状态本就在 `useTasksStore`，切换不丢失。
//! 2026-11-09：页头（概览/快速添加/筛选/搜索）固定，只有任务列表独立滚动；
//! 搜索框紧跟在日期筛选下面、状态/排序上面。
//! 2026-11-12：改为「任务优先」的三模式视图（列表 / 专注 / 统计）。工具入口集中到
//! 单行操作区，列表占满剩余高度；专注与统计是独立工作视图，不再携带列表工具栏。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QuickAdd from "./QuickAdd";
import QuickReminder from "./QuickReminder";
import ActiveReminders from "./ActiveReminders";
import TaskItem from "./TaskItem";
import TaskEditorView from "./TaskEditorView";
import { useTasksStore } from "../../store/useTasksStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { locateElement } from "../global-search/locate";
import { Select, SearchField, DropdownMenu } from "../ui";
import {
  ArrowLeft,
  BarChart3,
  ListChecks,
  AlertTriangle,
  Inbox,
  Sparkles,
  Timer,
  MoreHorizontal,
} from "lucide-react";
import TaskAnalyticsPanel from "./analytics/TaskAnalyticsPanel";
import FocusWorkspace from "../focus/FocusWorkspace";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import ContextHelpButton from "../help/ContextHelpButton";
import ModuleRunControl from "../lifecycle/ModuleRunControl";
import { useViewsOverflow } from "./useViewsOverflow";
import "./tasks-layout.css";

/** 任务页三种模式：列表是工作台，专注/统计是独立工作视图（与列表互斥）。 */
type TasksMode = "list" | "focus" | "analytics";

const VIEWS: readonly { id: "today" | "tomorrow" | "week" | "overdue" | "all"; labelKey: MessageKey }[] = [
  // 2026-11-09：按用户要求「全部」放最前，其余日期视图依次后移。
  { id: "all", labelKey: "tasks.view.all" },
  { id: "today", labelKey: "tasks.view.today" },
  { id: "tomorrow", labelKey: "tasks.view.tomorrow" },
  { id: "week", labelKey: "tasks.view.week" },
  { id: "overdue", labelKey: "tasks.view.overdue" },
] as const;

const STATUSES: readonly { id: "pending" | "completed" | "all"; labelKey: MessageKey }[] = [
  { id: "pending", labelKey: "tasks.status.pending" },
  { id: "completed", labelKey: "tasks.status.completed" },
  { id: "all", labelKey: "tasks.status.all" },
] as const;

const SORTS: readonly { id: "due" | "priority" | "created"; labelKey: MessageKey }[] = [
  { id: "due", labelKey: "tasks.sort.due" },
  { id: "priority", labelKey: "tasks.sort.priority" },
  { id: "created", labelKey: "tasks.sort.created" },
] as const;

export default function TasksPanel() {
  const { t, locale } = useLocale();
  const filter = useTasksStore((s) => s.filter);
  const setFilter = useTasksStore((s) => s.setFilter);
  const tasks = useTasksStore((s) => s.tasks);
  const exitHolds = useTasksStore((s) => s.exitHolds);
  const loading = useTasksStore((s) => s.loading);
  const error = useTasksStore((s) => s.error);
  const refresh = useTasksStore((s) => s.refresh);
  const stats = useTasksStore((s) => s.stats);
  const linksError = useNavigationStore((s) => s.linksError);
  const loadTaskLinks = useNavigationStore((s) => s.loadTaskLinks);
  const editor = useUiStore((s) => s.editor);
  const closeEditor = useUiStore((s) => s.closeEditor);
  // 列表 / 专注 / 统计共用单一模式状态：同一时刻只渲染一个视图，
  // 避免两个布尔各自为政导致列表工具栏与子视图并存。
  const [mode, setMode] = useState<TasksMode>("list");
  // 快捷提醒默认不占位：由「更多」菜单按需打开，关闭即卸载。
  const [quickReminderOpen, setQuickReminderOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const listScrollTop = useRef(0);
  // 日期分段容器：横向溢出指示与激活项入视都由 useViewsOverflow 负责。
  const viewsRef = useRef<HTMLDivElement>(null);
  // 指针按下后的 focus 不做「入视」滚动：mousedown 与 mouseup 之间把按钮
  // 从指针下移走会让 click 落到祖先，部分可见的日期项会点不动。
  const pointerFocusRef = useRef(false);
  // 返回列表时把焦点交还给进入子视图的按钮（键盘用户不丢上下文）。
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const analyticsButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<"focus" | "analytics" | null>(null);
  const focusReturnRaf = useRef(0);

  /**
   * 返回列表：只切模式并归还焦点，绝不重置 `useTasksStore.filter`。
   * 滚动位置由下方视口恢复 effect 统一处理（与编辑态返回共用同一套逻辑）。
   */
  const backToList = useCallback(() => {
    const target = returnFocusRef.current;
    setMode("list");
    cancelAnimationFrame(focusReturnRaf.current);
    focusReturnRaf.current = requestAnimationFrame(() => {
      const el =
        target === "focus"
          ? focusButtonRef.current
          : target === "analytics"
            ? analyticsButtonRef.current
            : null;
      el?.focus({ preventScroll: true });
      returnFocusRef.current = null;
    });
  }, []);

  // 编辑态与两个子视图都会卸载列表 DOM；scrollTop 无法在返回时再读取，
  // 因此统一用 onScroll 持续记录的 listScrollTop 在回到列表后写回。
  // 若首帧 scrollHeight 尚未稳定导致被浏览器夹取，只在下一帧补写一次
  // （不轮询、不 setTimeout）。
  const viewport = editor.open ? "editor" : mode;
  const lastViewport = useRef<string>("list");
  useEffect(() => {
    const previous = lastViewport.current;
    lastViewport.current = viewport;
    if (viewport !== "list" || previous === "list") return;
    const list = listRef.current;
    if (!list) return;
    const top = listScrollTop.current;
    let second = 0;
    const first = requestAnimationFrame(() => {
      list.scrollTop = top;
      if (list.scrollTop !== top) {
        second = requestAnimationFrame(() => {
          list.scrollTop = top;
        });
      }
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [viewport]);

  // 卸载时取消可能还在排队的焦点归还帧，不留悬空回调。
  useEffect(() => () => cancelAnimationFrame(focusReturnRaf.current), []);

  // Escape 关闭子视图：捕获阶段优先处理，避免冒泡到窗口级「隐藏到托盘」。
  // 只在子视图注册，列表模式下不拦截 Escape（搜索框自己处理）。
  useEffect(() => {
    if (mode === "list") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      backToList();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [mode, backToList]);

  const hasSearch = !!filter.search?.trim();
  // 「今日到期」卡下钻到窄口径 due_today；它仍属于「今日」分段，切换分段回到宽口径。
  const todayTabActive = filter.view === "today" || filter.view === "due_today";
  // 空态口径说明只对下钻后的未完成列表成立；切到「已完成/全部」后不再提示去看逾期。
  const dueTodayEmpty =
    filter.view === "due_today" && (filter.status ?? "pending") === "pending";

  /**
   * 离场补渲染：完成行的动画还没播完时，后台整表刷新可能先把这一行抽走。
   * 这里只在渲染层把快照按原位置补回，`tasks` 仍是后端返回的唯一真实数据；
   * 快照在动画结束或切换视图时释放，不会长期残留、也不会进入排序/分页。
   */
  const displayedTasks = useMemo(() => {
    if (!exitHolds.length) return tasks;
    let out = tasks.slice();
    for (const hold of [...exitHolds].sort((a, b) => a.index - b.index)) {
      if (out.some((task) => task.id === hold.task.id)) continue;
      const before = hold.beforeId ? out.findIndex((task) => task.id === hold.beforeId) : -1;
      const at = before >= 0 ? before : Math.min(hold.index, out.length);
      out = [...out.slice(0, at), hold.task, ...out.slice(at)];
    }
    return out;
  }, [tasks, exitHolds]);

  // 日期分段横向滚动（320/360 窄窗）：溢出侧显示边缘渐变；激活项在
  // 外部下钻 / 键盘聚焦 / 语言切换后自动进入可见区。编辑态与子视图不监听。
  const activeView = todayTabActive ? "today" : filter.view ?? "all";
  const viewsOverflow = useViewsOverflow(viewsRef, activeView, {
    enabled: !editor.open && mode === "list",
    reflowKey: locale,
  });

  // 全局搜索定位：消费一次性意图（只处理任务类；workspace 意图由 TaskContextDrawer 消费）。
  // 用关键词过滤确保目标可见，数据渲染后滚动高亮。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "tasks") return;
    const intent = pendingLocate;
    consumeLocate();
    // 定位必须回到列表：子视图打开时先关闭，否则目标行不在 DOM 中。
    setMode("list");
    if (filter.view !== "all" || filter.status !== "all" || filter.search !== intent.keyword) {
      setFilter({ view: "all", status: "all", search: intent.keyword });
    }
    locateElement({
      find: () => document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(intent.id)}"]`),
    });
    // 仅响应定位意图变化；filter 等依赖刻意不列入，避免重复消费。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocate]);

  // 编辑态：主内容区切换（不新开窗口、不铺遮罩）。列表 DOM 卸载，筛选与滚动由上方逻辑恢复。
  if (editor.open) {
    return (
      <div className="tasks-panel task-editor-page page-fill">
        <TaskEditorView task={editor.task} onClose={closeEditor} />
      </div>
    );
  }

  // 专注与统计是独立工作视图：只保留返回头 + 工作区本身，不带列表工具栏。
  // 三种模式共用一个渲染树，只有头部与主体分支——这样 `ActiveReminders` 不会
  // 在切模式时卸载：它保留已取回的提醒数据（返回列表时摘要行立即在位），
  // 列表高度不会在返回后的异步回包里再变一次，滚动位置才能精确恢复。
  const subview = mode !== "list";
  const analytics = mode === "analytics";
  const ModeIcon = analytics ? BarChart3 : Timer;
  return (
    <div
      className={`tasks-panel ${subview ? "tasks-subview" : ""} page-fill`}
      data-task-mode={mode}
    >
      {subview ? (
        <header className="tasks-subview-head">
          <button
            type="button"
            className="btn sm tasks-subview-back"
            aria-label={t("tasks.backToList")}
            onClick={backToList}
          >
            <ArrowLeft size={13} aria-hidden="true" /> {t("tasks.backToList")}
          </button>
          <span className="tasks-subview-title">
            <ModeIcon size={13} aria-hidden="true" />{" "}
            {t(analytics ? "tasks.modeTitle.analytics" : "tasks.modeTitle.focus")}
          </span>
          <span className="flex-spacer" />
        </header>
      ) : (
        <div className="tasks-head">
          {/* 全局概览（跨筛选视图）：三张卡都可点击下钻到对应列表 */}
          <div className="tasks-overview tasks-overview--compact">
            <div
              className="overview-card is-clickable"
              data-tip={t("tasks.overview.pendingTip")}
              role="button"
              tabIndex={0}
              onClick={() => setFilter({ view: "all", status: "pending" })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setFilter({ view: "all", status: "pending" });
                }
              }}
            >
              <span className="overview-value">{stats?.pending ?? "–"}</span>
              <span className="overview-label">{t("tasks.overview.pending")}</span>
            </div>
            <div
              className="overview-card is-clickable"
              data-tip={t("tasks.overview.dueTodayTip")}
              role="button"
              tabIndex={0}
              onClick={() => setFilter({ view: "due_today", status: "pending" })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setFilter({ view: "due_today", status: "pending" });
                }
              }}
            >
              <span className="overview-value">{stats?.due_today ?? "–"}</span>
              <span className="overview-label">{t("tasks.overview.dueToday")}</span>
            </div>
            <div
              className={`overview-card is-clickable ${stats?.overdue ? "warn" : ""}`}
              data-tip={t("tasks.overview.overdueTip")}
              onClick={() => setFilter({ view: "overdue" })}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                // role=button 键盘契约：Enter 与 Space 都可激活（Space 需阻止默认滚动）
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setFilter({ view: "overdue" });
                }
              }}
            >
              <span className="overview-value">{stats?.overdue ?? "–"}</span>
              <span className="overview-label">{t("tasks.overview.overdue")}</span>
            </div>
          </div>

          <QuickAdd />

          {/* 日期筛选常驻；提醒调度、帮助、专注、统计、更多集中在同一行。
              窄窗只允许日期分段横向滚动，工具图标不换行。 */}
          <div className="tasks-viewbar">
            <div
              ref={viewsRef}
              className="seg-group tasks-views"
              role="group"
              aria-label={t("tasks.rangeAria")}
              data-overflow-start={viewsOverflow.start ? "true" : undefined}
              data-overflow-end={viewsOverflow.end ? "true" : undefined}
            >
              {VIEWS.map((v) => {
                const active = v.id === "today" ? todayTabActive : filter.view === v.id;
                return (
                  <button
                    key={v.id}
                    className={`seg-btn ${active ? "active" : ""}`}
                    aria-pressed={active}
                    data-view={v.id}
                    data-tip={
                      v.id === "today" && filter.view === "due_today"
                        ? t("tasks.view.todayDueTip")
                        : undefined
                    }
                    // 键盘 Tab 到被遮住的日期项时，立即把它带进可见区；
                    // 鼠标/触摸按下触发的 focus 跳过（否则按钮会在按下与抬起
                    // 之间移走，click 丢失）。指针点击后由 activeView 变化
                    // 的 effect 完成入视。
                    onPointerDown={() => {
                      pointerFocusRef.current = true;
                    }}
                    onFocus={() => {
                      if (pointerFocusRef.current) {
                        pointerFocusRef.current = false;
                        return;
                      }
                      viewsOverflow.reveal(v.id);
                    }}
                    onClick={() => setFilter({ view: v.id })}
                  >
                    {t(v.labelKey)}
                  </button>
                );
              })}
            </div>
            <span className="flex-spacer" />
            <div className="tasks-actions" role="group" aria-label={t("tasks.actionsAria")}>
              {/* 提醒调度暂停：只暂停到期提醒触发，任务数据与共享调度循环不受影响。 */}
              <ModuleRunControl moduleId="reminders" />
              <ContextHelpButton articleId="help.tasks.create-reminders" />
              <button
                ref={focusButtonRef}
                type="button"
                className="icon-btn sm"
                data-tip={t("tasks.focus")}
                aria-label={t("tasks.focus")}
                aria-pressed={false}
                onClick={() => {
                  returnFocusRef.current = "focus";
                  setMode("focus");
                }}
              >
                <Timer size={13} aria-hidden="true" />
              </button>
              <button
                ref={analyticsButtonRef}
                type="button"
                className="icon-btn sm"
                data-tip={t("tasks.analytics")}
                aria-label={t("tasks.analytics")}
                aria-pressed={false}
                onClick={() => {
                  returnFocusRef.current = "analytics";
                  setMode("analytics");
                }}
              >
                <BarChart3 size={13} aria-hidden="true" />
              </button>
              <DropdownMenu
                trigger={({ ref, expanded, onClick, onKeyDown }) => (
                  <button
                    ref={ref}
                    type="button"
                    className="icon-btn sm"
                    data-tip={t("tasks.more")}
                    aria-label={t("tasks.more")}
                    aria-haspopup="menu"
                    aria-expanded={expanded}
                    onClick={onClick}
                    onKeyDown={onKeyDown}
                  >
                    <MoreHorizontal size={13} aria-hidden="true" />
                  </button>
                )}
                items={[
                  {
                    key: "quick-reminder",
                    label: t("quickReminder.collapsed"),
                    radio: true,
                    checked: quickReminderOpen,
                    onSelect: () => setQuickReminderOpen((v) => !v),
                  },
                ]}
                menuLabel={t("tasks.more")}
              />
            </div>
          </div>

          {/* 搜索 + 状态 + 排序：同一行紧凑工具区，搜索框吃掉剩余宽度 */}
          <div className="tasks-filterbar">
            <SearchField
              size="compact"
              placeholder={t("tasks.searchPlaceholder")}
              ariaLabel={t("tasks.searchAria")}
              clearLabel={t("tasks.searchClear")}
              value={filter.search ?? ""}
              onChange={(v) => setFilter({ search: v })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  // stopPropagation：别让 Escape 继续冒泡到窗口级「隐藏到托盘」的动作
                  e.stopPropagation();
                  setFilter({ search: "" });
                }
              }}
            />
            <div className="seg-group subtle" role="group" aria-label={t("tasks.statusAria")}>
              {STATUSES.map((s) => (
                <button
                  key={s.id}
                  className={`seg-btn ${(filter.status ?? "pending") === s.id ? "active" : ""}`}
                  aria-pressed={(filter.status ?? "pending") === s.id}
                  onClick={() => setFilter({ status: s.id })}
                >
                  {t(s.labelKey)}
                </button>
              ))}
            </div>
            <Select
              className="sort-select"
              size="sm"
              ariaLabel={t("tasks.sortAria")}
              value={filter.sort ?? "due"}
              options={SORTS.map((s) => ({ value: s.id, label: t(s.labelKey) }))}
              onChange={(v) => setFilter({ sort: v })}
            />
          </div>

          {quickReminderOpen && (
            <QuickReminder open onClose={() => setQuickReminderOpen(false)} />
          )}
        </div>
      )}

      {/* 提醒摘要默认折叠成一行；展开后才渲染条目（共享时钟仍只在可见时订阅）。
          子视图里隐藏但**不卸载**：保留已取回的提醒数据，返回列表时摘要行
          立即在位，列表高度不会在异步回包后再变一次。 */}
      <ActiveReminders hidden={subview} />

      {mode === "analytics" ? (
        <div className="tasks-subview-body tasks-analytics-body">
          <TaskAnalyticsPanel />
        </div>
      ) : mode === "focus" ? (
        <div className="tasks-subview-body page-scroll">
          <FocusWorkspace />
        </div>
      ) : (
        <div
          className="task-list page-scroll"
          ref={listRef}
          onScroll={(e) => {
            listScrollTop.current = e.currentTarget.scrollTop;
          }}
        >
          {linksError && (
            // 关联读取失败 ≠ 没有关联：保留旧图标但明确标注可能过期，并提供重试
            <div className="empty-hint error-text task-list-error" role="status">
              {t("tasks.linksFailed", { error: linksError })}
              <button className="btn sm" onClick={() => void loadTaskLinks()}>
                {t("common.retry")}
              </button>
            </div>
          )}
          {error && displayedTasks.length > 0 && (
            // 列表刷新失败：保留上次结果并明确标记「可能不是最新」，不伪装成已刷新
            <div className="empty-hint error-text task-list-error" role="status">
              {t("tasks.refreshFailed", { error })}
              <button className="btn sm" onClick={() => void refresh()}>
                {t("common.retry")}
              </button>
            </div>
          )}
          {loading && displayedTasks.length === 0 && !error && (
            <div className="empty-state">
              <div className="empty-icon"><ListChecks size={22} /></div>
              <div className="empty-title">{t("tasks.loading")}</div>
            </div>
          )}
          {!loading && error && displayedTasks.length === 0 && (
            // 读取失败 ≠ 没有任务：给出真实错误与重试入口
            <div className="empty-state" role="alert">
              <div className="empty-icon"><AlertTriangle size={22} /></div>
              <div className="empty-title">{t("tasks.loadFailed")}</div>
              <div className="empty-hint error-text">{error}</div>
              <button className="btn sm primary" onClick={() => void refresh()}>
                {t("common.retry")}
              </button>
            </div>
          )}
          {!loading && !error && displayedTasks.length === 0 && (
            <div className="empty-state">
              {/* 轻量插画：纯 CSS 渐变气泡 + 一个 SVG 图标，无位图资源 */}
              <div className="empty-art" aria-hidden="true">
                <span className="empty-bubble b1" />
                <span className="empty-bubble b2" />
                <span className="empty-bubble b3" />
                <span className="empty-bubble b4" />
                <Sparkles size={12} className="empty-spark s1" />
                <Sparkles size={9} className="empty-spark s2" />
                <span className="empty-cloud" />
                <span className="empty-orb">
                  <Inbox size={26} strokeWidth={1.7} />
                </span>
              </div>
              <div className="empty-title">
                {hasSearch
                  ? t("tasks.empty.search")
                  : dueTodayEmpty
                    ? t("tasks.empty.dueToday")
                    : filter.view === "overdue"
                      ? t("tasks.empty.overdue")
                      : t("tasks.empty.default")}
              </div>
              <div className="empty-hint">
                {hasSearch
                  ? t("tasks.empty.searchHint")
                  : dueTodayEmpty
                    ? t("tasks.empty.dueTodayHint")
                    : t("tasks.empty.defaultHint")}
              </div>
            </div>
          )}
          {displayedTasks.map((task) => {
            const hold = exitHolds.find((h) => h.task.id === task.id);
            return (
              <TaskItem
                key={task.id}
                task={task}
                exiting={!!hold}
                exitHeight={hold?.height}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
