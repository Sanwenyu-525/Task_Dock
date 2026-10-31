//! 任务面板：统计概览 → 快速添加 → 日期筛选（主）→ 状态/排序（次级）→ 列表。
//! 筛选器视觉权重低于任务本身；搜索可展开收起，不占常驻高度。
//! v0.6：卡片层级与空状态插画按视觉预设重绘（结构不变，两套皮肤共用）。

import { useState } from "react";
import QuickAdd from "./QuickAdd";
import TaskItem from "./TaskItem";
import { useTasksStore } from "../../store/useTasksStore";
import { Select } from "../ui";
import { Search, X, ListChecks, CalendarClock, AlertTriangle, Inbox, Sparkles } from "lucide-react";

const VIEWS = [
  { id: "today", label: "今日" },
  { id: "tomorrow", label: "明日" },
  { id: "week", label: "本周" },
  { id: "overdue", label: "逾期" },
  { id: "all", label: "全部" },
] as const;

const STATUSES = [
  { id: "pending", label: "未完成" },
  { id: "completed", label: "已完成" },
  { id: "all", label: "全部状态" },
] as const;

const SORTS = [
  { id: "due", label: "按时间" },
  { id: "priority", label: "按紧急度" },
  { id: "created", label: "按创建" },
] as const;

export default function TasksPanel() {
  const filter = useTasksStore((s) => s.filter);
  const setFilter = useTasksStore((s) => s.setFilter);
  const tasks = useTasksStore((s) => s.tasks);
  const loading = useTasksStore((s) => s.loading);
  const stats = useTasksStore((s) => s.stats);
  const [searchOpen, setSearchOpen] = useState(false);

  const hasSearch = !!filter.search?.trim();
  const searchVisible = searchOpen || hasSearch;

  return (
    <div className="tasks-panel">
      {/* 全局概览（跨筛选视图） */}
      <div className="tasks-overview">
        <div className="overview-card tone-accent" title="全部未完成任务">
          <ListChecks size={15} strokeWidth={1.9} className="overview-icon" />
          <span className="overview-value">{stats?.pending ?? "–"}</span>
          <span className="overview-label">待完成</span>
        </div>
        <div className="overview-card tone-violet" title="今天到期">
          <CalendarClock size={15} strokeWidth={1.9} className="overview-icon" />
          <span className="overview-value">{stats?.due_today ?? "–"}</span>
          <span className="overview-label">今日到期</span>
        </div>
        <div
          className={`overview-card tone-warn ${stats?.overdue ? "warn" : ""}`}
          title="已过期未完成"
          onClick={() => setFilter({ view: "overdue" })}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && setFilter({ view: "overdue" })}
        >
          <AlertTriangle size={15} strokeWidth={1.9} className="overview-icon" />
          <span className="overview-value">{stats?.overdue ?? "–"}</span>
          <span className="overview-label">逾期</span>
        </div>
      </div>

      <QuickAdd />

      {/* 主筛选：日期视图优先 */}
      <div className="filter-bar primary">
        <div className="seg-group" role="group" aria-label="日期范围">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`seg-btn ${filter.view === v.id ? "active" : ""}`}
              onClick={() => setFilter({ view: v.id })}
            >
              {v.label}
            </button>
          ))}
        </div>
        <span className="flex-spacer" />
        <button
          className={`icon-btn sm ${searchVisible ? "active" : ""}`}
          data-tip={searchVisible ? "收起搜索" : "搜索任务"}
          aria-label={searchVisible ? "收起搜索" : "搜索任务"}
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
        <div className="seg-group subtle" role="group" aria-label="状态">
          {STATUSES.map((s) => (
            <button
              key={s.id}
              className={`seg-btn ${(filter.status ?? "pending") === s.id ? "active" : ""}`}
              onClick={() => setFilter({ status: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="flex-spacer" />
        <Select
          className="sort-select"
          size="sm"
          ariaLabel="排序方式"
          value={filter.sort ?? "due"}
          options={SORTS.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(v) => setFilter({ sort: v })}
        />
      </div>

      {searchVisible && (
        <div className="search-box">
          <Search size={12} />
          <input
            autoFocus
            className="input-embedded"
            placeholder="搜索标题 / 描述（Enter 确认）"
            value={filter.search ?? ""}
            onChange={(e) => setFilter({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // stopPropagation：别让 Escape 继续冒泡到窗口级「隐藏到托盘」的动作
                e.stopPropagation();
                setFilter({ search: "" });
                setSearchOpen(false);
              }
            }}
          />
          {hasSearch && (
            <button className="icon-btn sm" data-tip="清空搜索" aria-label="清空搜索" onClick={() => setFilter({ search: "" })}>
              <X size={11} />
            </button>
          )}
        </div>
      )}

      <div className="task-list">
        {loading && tasks.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon"><ListChecks size={22} /></div>
            <div className="empty-title">加载中…</div>
          </div>
        )}
        {!loading && tasks.length === 0 && (
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
              {hasSearch ? "没有匹配的任务" : filter.view === "overdue" ? "没有逾期任务，很好" : "这里还很清爽"}
            </div>
            <div className="empty-hint">
              {hasSearch
                ? "换个关键词，或清空搜索查看全部"
                : "用上方输入框快速添加，支持「明天下午三点开会」这样的自然语言"}
            </div>
          </div>
        )}
        {tasks.map((t) => (
          <TaskItem key={t.id} task={t} />
        ))}
      </div>
    </div>
  );
}
