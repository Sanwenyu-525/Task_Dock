//! 任务面板（胶囊内，对照 `docs/design-refs/v07/停靠效果图/01-tasks.png`）。
//!
//! 数据：**不再自持列表**。列表来自 `useTasksStore.lite`（挂载时 loadLite()
//! 取一次 list_tasks：view=all, status=all, sort=due），完成/新增走 store 的
//! 动作落库，store.refresh() 在面板打开时顺带刷新这份轻量列表——
//! 主窗口与胶囊因此只有一个状态源。
//!
//! 分段筛选只在**同一份真实结果**上做本地细分：待办/今日/日程共用一个
//! status=pending 的轻量结果，已完成单独用 status=completed 读取——否则
//! 「最近 12 条」的截断会把可能存在的已完成任务误显示为空。
//! 面板底栏明确标注「最近记录」，完整入口在「全部任务」。
//! 已完成的量来自 `stats.completed_today`，不伪造数据。
//!
//! 完成交互：先置 `is-done` 视觉态（320ms）再移出列表；`toggle` 失败则撤销
//! 该视觉态并重新拉取真实列表，同时在底栏给出一次失败提示——
//! 绝不把没保存成功的任务伪装成已完成。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Check, CheckCircle2, ChevronRight, ListTodo, Plus } from "lucide-react";
import type { Task } from "../../lib/bridge";
import { useTasksStore, type TaskLiteScope } from "../../store/useTasksStore";
import { openFullApp } from "./actions";
import { dueLabel, sortPending } from "./format";
import { EmptyState, PanelHead, Segmented, type SegOption } from "./PanelKit";

type Filter = "all" | "pending" | "today" | "scheduled" | "done";

/** 分段与效果图一致：全部 / 待办 / 今日 / 日程 / 已完成。
 *  全部 = 待办 + 已完成（同一份真实列表，已完成排在后面且不可勾选）。 */
const FILTERS: readonly SegOption<Filter>[] = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待办" },
  { value: "today", label: "今日" },
  { value: "scheduled", label: "日程" },
  { value: "done", label: "已完成" },
];

/** 分段 → 需要读取的轻量结果范围：只有「已完成」需要换一份查询。 */
function scopeOf(filter: Filter): TaskLiteScope {
  if (filter === "done") return "completed";
  if (filter === "all") return "all";
  return "pending";
}

const sameDay = (a: number, b: number): boolean => {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
};

export default function TasksLite() {
  const items = useTasksStore((s) => s.lite);
  const liteScope = useTasksStore((s) => s.liteScope);
  const liteError = useTasksStore((s) => s.liteError);
  const loadLite = useTasksStore((s) => s.loadLite);
  const releaseLite = useTasksStore((s) => s.releaseLite);
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timers = useRef<number[]>([]);
  const stats = useTasksStore((s) => s.stats);

  // 面板打开 → 取一次轻量列表；关闭 → 释放并作废在途响应。
  useEffect(() => {
    void loadLite("all");
    return () => releaseLite();
  }, [loadLite, releaseLite]);

  /**
   * 切分段只在数据范围不同时重新读取：待办/今日/日程共用 pending 结果，
   * 已完成单独读 completed。请求数量受控，不随每次点击都发一条。
   */
  const changeFilter = (next: Filter) => {
    setFilter(next);
    const target = scopeOf(next);
    if (useTasksStore.getState().liteScope !== target) void loadLite(target);
  };

  // 所有延时都必须可回收：面板卸载时清空，避免对已卸载组件 setState
  useEffect(() => {
    const list = timers.current;
    return () => {
      list.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const t = window.setTimeout(fn, ms);
    timers.current.push(t);
  }, []);

  const flash = useCallback(
    (msg: string) => {
      setNotice(msg);
      later(() => setNotice((n) => (n === msg ? null : n)), 2400);
    },
    [later],
  );

  const add = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      // store 的 quickCreate 内部 refresh()：面板打开时已含轻量列表刷新
      await useTasksStore.getState().quickCreate(v, null, null, null);
      setText("");
    } catch {
      flash("添加失败，请重试"); // 失败保留输入，用户可重试
    } finally {
      setBusy(false);
    }
  };

  const complete = async (id: string) => {
    setCompleting((prev) => new Set(prev).add(id));
    try {
      await useTasksStore.getState().toggle(id);
      // 视觉反馈先行：留 320ms 让勾选动画可见，再移出列表
      later(() => setHidden((prev) => new Set(prev).add(id)), 320);
    } catch {
      setCompleting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      flash("完成失败，已回滚");
      void loadLite(); // 重新拉真实状态，不靠本地猜测
    }
  };

  const now = Date.now();
  const scopeReady = items !== null && liteScope === scopeOf(filter);
  const visible = useMemo(() => {
    // 分段范围与已取回数据不一致时视为读取中：不拿旧范围的列表冒充新分段
    if (!items || liteScope !== scopeOf(filter)) return null;
    // 展示顺序在面板里定：过期优先 → 截止升序 → 无期限最后，已完成按完成时间倒序
    const pendingList = sortPending(items.filter((t) => t.status !== "completed"));
    const doneList = items
      .filter((t) => t.status === "completed")
      .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    const ordered = [...pendingList, ...doneList].filter((t) => !hidden.has(t.id));
    const isDone = (t: Task) => t.status === "completed";
    const list = ordered.filter((t) => {
      if (filter === "done") return isDone(t);
      if (isDone(t)) return filter === "all";
      if (filter === "pending") return true;
      if (filter === "today") return t.due_at ? sameDay(new Date(t.due_at).getTime(), now) : false;
      if (filter === "scheduled") return t.due_at !== null;
      return true;
    });
    return list.slice(0, 12);
  }, [items, liteScope, filter, now, hidden]);

  const localDone = items?.filter((t) => t.status === "completed").length ?? 0;
  const pending = stats?.pending ?? items?.filter((t) => t.status !== "completed").length ?? 0;
  const today = stats?.due_today ?? 0;
  const doneToday = stats?.completed_today ?? localDone;
  const total = doneToday + pending;
  const pct = total > 0 ? Math.round((doneToday / total) * 100) : 0;
  // 数据错误与空态分开：失败时旧列表保留展示 + 可重试错误条；没成功过则错误空态
  const dataError = liteError !== null;
  const noTasksAtAll = scopeReady && items !== null && items.length === 0;
  const emptyText =
    filter === "done"
      ? "暂无已完成任务"
      : filter === "today" || filter === "scheduled"
        ? "该筛选下没有任务"
        : filter === "pending"
          ? "暂无待办任务"
          : "暂无任务";

  return (
    <>
      <PanelHead
        title="任务"
        sub={stats ? `今天 ${today} 项 · 待办 ${pending}` : "读取中"}
        actions={
          <button
            type="button"
            className="cap-iconbtn"
            aria-label="快速新增任务"
            onClick={() => inputRef.current?.focus()}
          >
            <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
        }
      />

      <Segmented label="任务筛选" options={FILTERS} value={filter} onChange={changeFilter} />

      <div className="cap-list">
        {/* 错误优先于空态：读取失败绝不伪装成「暂无待办」 */}
        {dataError && items === null && (
          <EmptyState
            icon={<ListTodo size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="任务列表读取失败"
            actionLabel="重试"
            onAction={() => void loadLite(scopeOf(filter))}
          />
        )}

        {dataError && items !== null && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">刷新失败，显示的是上次结果</span>
            <button
              type="button"
              className="cap-mini"
              aria-label="重试读取任务列表"
              onClick={() => void loadLite(scopeOf(filter))}
            >
              重试
            </button>
          </div>
        )}

        {!dataError && visible !== null && visible.length === 0 && (
          <EmptyState
            icon={<ListTodo size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={emptyText}
            actionLabel={noTasksAtAll ? "新建任务" : undefined}
            onAction={() => inputRef.current?.focus()}
          />
        )}
        {visible?.map((t) => {
          const due = dueLabel(t.due_at, now);
          const completed = t.status === "completed";
          const isDone = completing.has(t.id) || completed;
          return (
            <div className={`cap-item cap-task-row${isDone ? " is-done" : ""}`} key={t.id}>
              {completed ? (
                // 已完成的条目只呈现状态，不给「再点一次」的假入口：
                // 取消完成属于主窗口的任务详情，胶囊内不做隐式写操作。
                <span className="cap-check is-checked is-static" aria-hidden="true">
                  <Check size={11} strokeWidth={3} />
                </span>
              ) : (
                <button
                  type="button"
                  className={`cap-check${isDone ? " is-checked" : ""}`}
                  aria-label={`完成「${t.title}」`}
                  aria-pressed={isDone}
                  onClick={() => void complete(t.id)}
                >
                  <Check size={11} strokeWidth={3} aria-hidden="true" />
                </button>
              )}
              <span className="cap-main">
                <span className="cap-item-title" title={t.title}>
                  {t.title}
                </span>
                <span className="cap-task-tags">
                  {t.category ? <span className="cap-tag">{t.category}</span> : null}
                  {t.due_at ? (
                    <span className={`cap-pill tone-${due.tone}`}>{due.text}</span>
                  ) : (
                    <span className="cap-item-sub">无期限</span>
                  )}
                </span>
              </span>
              <span className="cap-task-side">
                {t.remind_at ? (
                  <span className="cap-task-bell" aria-label="已设置提醒" title="已设置提醒">
                    <Bell size={12} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">
          <CheckCircle2 size={12} strokeWidth={1.8} aria-hidden="true" />
          {notice ?? `最近记录 · 完成 ${doneToday}`}
        </span>
        {/* 零任务时没有「今天的完成进度」可言，不渲染无意义的 0% 进度条 */}
        {!noTasksAtAll && (
          <span className="cap-progress" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
        <button type="button" className="cap-link" onClick={() => openFullApp("tasks")}>
          全部任务
          <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>

      <div className="cap-input cap-task-add">
        <Plus size={13} strokeWidth={2.2} aria-hidden="true" />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="添加任务，回车保存"
          aria-label="快速添加任务"
          maxLength={200}
        />
      </div>
    </>
  );
}
