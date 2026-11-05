//! 任务面板：统计概览 → 快速添加 → 日期筛选（主）→ 状态/排序（次级）→ 列表。
//! 筛选器视觉权重低于任务本身；搜索可展开收起，不占常驻高度。
//! v0.6：卡片层级与空状态插画按视觉预设重绘（结构不变，两套皮肤共用）。
//! v0.9：编辑任务改为页面内编辑态（列表 ↔ 编辑切换），退出后恢复列表滚动位置；
//! 筛选状态本就在 `useTasksStore`，切换不丢失。

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
import { BarChart3, X, Search, ListChecks, AlertTriangle, Inbox, Sparkles, Timer } from "lucide-react";
import TaskAnalyticsPanel from "./analytics/TaskAnalyticsPanel";
import FocusWorkspace from "../focus/FocusWorkspace";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";

/** 内容区滚动容器（`.tab-content`）：编辑态切换时用它记录/恢复列表位置。 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

const VIEWS: readonly { id: "today" | "tomorrow" | "week" | "overdue" | "all"; labelKey: MessageKey }[] = [
  { id: "today", labelKey: "tasks.view.today" },
  { id: "tomorrow", labelKey: "tasks.view.tomorrow" },
  { id: "week", labelKey: "tasks.view.week" },
  { id: "overdue", labelKey: "tasks.view.overdue" },
  { id: "all", labelKey: "tasks.view.all" },
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
  const [searchOpen, setSearchOpen] = useState(false);
  // 任务统计子视图（默认日范围，打开才请求；关闭后面板卸载即取消请求）。
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  // 专注与休息子视图：与列表/统计互斥，按需挂载（关闭即卸载，停止订阅与共享时钟引用）。
  const [focusOpen, setFocusOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listScrollTop = useRef(0);
  const wasEditing = useRef(false);

  // 列表可见时持续记录内容区滚动位置。
  // 不能在进入编辑态后再读：列表 DOM 已被替换，scrollTop 会被浏览器夹取。
  useEffect(() => {
    if (editor.open) return;
    const scroller = findScrollParent(rootRef.current);
    if (!scroller) return;
    const onScroll = () => {
      listScrollTop.current = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [editor.open]);

  // 退出编辑态后恢复列表滚动位置（筛选状态由 store 保存，不需要额外恢复）。
  useEffect(() => {
    if (editor.open) {
      wasEditing.current = true;
      return;
    }
    if (!wasEditing.current) return;
    wasEditing.current = false;
    const scroller = findScrollParent(rootRef.current);
    if (!scroller) return;
    const top = listScrollTop.current;
    const raf = requestAnimationFrame(() => {
      scroller.scrollTop = top;
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
  const searchVisible = searchOpen || hasSearch;

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
      <div className="tasks-panel task-editor-page" ref={rootRef}>
        <TaskEditorView task={editor.task} onClose={closeEditor} />
      </div>
    );
  }

  return (
    <div className="tasks-panel" ref={rootRef}>
      {/* 全局概览（跨筛选视图） */}
      <div className="tasks-overview">
        <div className="overview-card" data-tip={t("tasks.overview.pendingTip")}>
          <span className="overview-value">{stats?.pending ?? "–"}</span>
          <span className="overview-label">{t("tasks.overview.pending")}</span>
        </div>
        <div className="overview-card" data-tip={t("tasks.overview.dueTodayTip")}>
          <span className="overview-value">{stats?.due_today ?? "–"}</span>
          <span className="overview-label">{t("tasks.overview.dueToday")}</span>
        </div>
        <div
          className={`overview-card ${stats?.overdue ? "warn" : ""}`}
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
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`seg-btn ${filter.view === v.id ? "active" : ""}`}
              aria-pressed={filter.view === v.id}
              onClick={() => setFilter({ view: v.id })}
            >
              {t(v.labelKey)}
            </button>
          ))}
        </div>
        <span className="flex-spacer" />
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
        <button
          className={`icon-btn sm ${searchVisible ? "active" : ""}`}
          data-tip={searchVisible ? t("tasks.search.collapse") : t("tasks.search.open")}
          aria-label={searchVisible ? t("tasks.search.collapse") : t("tasks.search.open")}
          onClick={() => {
            if (searchOpen && !hasSearch) setSearchOpen(false);
            else {
              setSearchOpen(true);
              requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".search-box input")?.focus());
            }
          }}
        >
          {searchVisible ? <X size={13} /> : <Search size={13} />}
        </button>
      </div>

      {/* 次级工具栏：状态 + 排序 + 搜索输入（收起时不占高度） */}
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

      {searchVisible && (
        <SearchField
          size="compact"
          autoFocus
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
              setSearchOpen(false);
            }
          }}
        />
      )}

      {analyticsOpen ? (
        <TaskAnalyticsPanel />
      ) : focusOpen ? (
        <FocusWorkspace />
      ) : (
        <div className="task-list">
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
                : filter.view === "overdue"
                  ? t("tasks.empty.overdue")
                  : t("tasks.empty.default")}
            </div>
            <div className="empty-hint">
              {hasSearch ? t("tasks.empty.searchHint") : t("tasks.empty.defaultHint")}
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
