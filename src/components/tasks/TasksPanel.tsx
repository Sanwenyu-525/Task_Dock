//! 任务面板：统计概览 → 快速添加 → 日期筛选（主）→ 搜索 → 状态/排序（次级）→ 列表。
//! 筛选器视觉权重低于任务本身；搜索框常驻在日期筛选下方，不随列表滚动。
//! v0.6：卡片层级与空状态插画按视觉预设重绘（结构不变，两套皮肤共用）。
//! v0.9：编辑任务改为页面内编辑态（列表 ↔ 编辑切换），退出后恢复列表滚动位置；
//! 筛选状态本就在 `useTasksStore`，切换不丢失。
//! 2026-11-09：页头（概览/快速添加/筛选/搜索）固定，只有任务列表独立滚动；
//! 搜索框紧跟在日期筛选下面、状态/排序上面。

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Select, SearchField } from "../ui";
import { BarChart3, X, ListChecks, AlertTriangle, Inbox, Sparkles, Timer } from "lucide-react";
import TaskAnalyticsPanel from "./analytics/TaskAnalyticsPanel";
import FocusWorkspace from "../focus/FocusWorkspace";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import ContextHelpButton from "../help/ContextHelpButton";
import ModuleRunControl from "../lifecycle/ModuleRunControl";

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
  const { t } = useLocale();
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
  // 任务统计子视图（默认日范围，打开才请求；关闭后面板卸载即取消请求）。
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  // 专注与休息子视图：与列表/统计互斥，按需挂载（关闭即卸载，停止订阅与共享时钟引用）。
  const [focusOpen, setFocusOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const listScrollTop = useRef(0);
  const wasEditing = useRef(false);

  // 退出编辑态后恢复列表滚动位置（筛选状态由 store 保存，不需要额外恢复）。
  // 列表滚动位置由列表容器自身的 onScroll 持续记录：进入编辑态后列表 DOM 已被
  // 替换，不能再从 scrollTop 读取（会被浏览器夹取到 0）。
  useEffect(() => {
    if (editor.open) {
      wasEditing.current = true;
      return;
    }
    if (!wasEditing.current) return;
    wasEditing.current = false;
    const list = listRef.current;
    if (!list) return;
    const top = listScrollTop.current;
    const raf = requestAnimationFrame(() => {
      list.scrollTop = top;
    });
    return () => cancelAnimationFrame(raf);
  }, [editor.open]);

  // Escape 关闭子视图：捕获阶段优先处理，避免冒泡到窗口级「隐藏到托盘」。
  useEffect(() => {
    if (!analyticsOpen && !focusOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setAnalyticsOpen(false);
      setFocusOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [analyticsOpen, focusOpen]);

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

  // 全局搜索定位：消费一次性意图（只处理任务类；workspace 意图由 TaskContextDrawer 消费）。
  // 用关键词过滤确保目标可见，数据渲染后滚动高亮。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "tasks") return;
    const intent = pendingLocate;
    consumeLocate();
    // 定位必须回到列表：子视图打开时先关闭，否则目标行不在 DOM 中。
    setAnalyticsOpen(false);
    setFocusOpen(false);
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

  return (
    <div className="tasks-panel page-fill">
      {/* 全局概览（跨筛选视图）：三张卡都可点击下钻到对应列表 */}
      <div className="tasks-overview">
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
      <QuickReminder />
      <ActiveReminders />

      {/* 主筛选：日期视图优先 */}
      <div className="filter-bar primary">
        <div className="seg-group" role="group" aria-label={t("tasks.rangeAria")}>
          {VIEWS.map((v) => {
            const active = v.id === "today" ? todayTabActive : filter.view === v.id;
            return (
              <button
                key={v.id}
                className={`seg-btn ${active ? "active" : ""}`}
                aria-pressed={active}
                data-tip={
                  v.id === "today" && filter.view === "due_today"
                    ? t("tasks.view.todayDueTip")
                    : undefined
                }
                onClick={() => setFilter({ view: v.id })}
              >
                {t(v.labelKey)}
              </button>
            );
          })}
        </div>
        <span className="flex-spacer" />
        {/* 提醒调度暂停：只暂停到期提醒触发，任务数据与共享调度循环不受影响。 */}
        <ModuleRunControl moduleId="reminders" />
        <ContextHelpButton articleId="help.tasks.create-reminders" />
        <button
          className={`icon-btn sm ${focusOpen ? "active" : ""}`}
          data-tip={focusOpen ? t("tasks.backToList") : t("tasks.focus")}
          aria-label={focusOpen ? t("tasks.backToList") : t("tasks.focus")}
          aria-pressed={focusOpen}
          onClick={() => {
            setFocusOpen((v) => !v);
            setAnalyticsOpen(false);
          }}
        >
          {focusOpen ? <X size={13} /> : <Timer size={13} />}
        </button>
        <button
          className={`icon-btn sm ${analyticsOpen ? "active" : ""}`}
          data-tip={analyticsOpen ? t("tasks.backToList") : t("tasks.analytics")}
          aria-label={analyticsOpen ? t("tasks.backToList") : t("tasks.analytics")}
          aria-pressed={analyticsOpen}
          onClick={() => {
            setAnalyticsOpen((v) => !v);
            setFocusOpen(false);
          }}
        >
          {analyticsOpen ? <X size={13} /> : <BarChart3 size={13} />}
        </button>
      </div>

      {/* 搜索框：常驻在日期筛选下面、状态/排序上面（页头固定，不随列表滚动） */}
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

      {/* 次级工具栏：状态 + 排序 */}
      <div className="filter-bar secondary">
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
        <span className="flex-spacer" />
        <Select
          className="sort-select"
          size="sm"
          ariaLabel={t("tasks.sortAria")}
          value={filter.sort ?? "due"}
          options={SORTS.map((s) => ({ value: s.id, label: t(s.labelKey) }))}
          onChange={(v) => setFilter({ sort: v })}
        />
      </div>

      {analyticsOpen ? (
        <div className="page-scroll">
          <TaskAnalyticsPanel />
        </div>
      ) : focusOpen ? (
        <div className="page-scroll">
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
