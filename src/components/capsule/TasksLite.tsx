//! 任务面板（胶囊内，对照 `docs/design-refs/v07/停靠效果图/01-tasks.png`）。
//!
//! 数据：**不再自持列表**。列表来自 `useTasksStore.lite`（挂载时按「全部」
//! 读取一份真实结果，切换分段时按该分段的真实查询再读一份）——完成/新增走
//! store 的动作落库，store.refresh() 在面板打开时保持当前分段刷新这份轻量
//! 列表，主窗口与胶囊因此只有一个状态源。
//!
//! 分段查询对应关系：待办=status=pending；今日=后端 view=due_today（本地今天
//! 到期且未完成）；日程=后端 view=scheduled（due_at 非空且未完成）并按
//! sort=scheduled 把未逾期/未来任务排在逾期之前（成员不变，仅顺序）；已完成=
//! status=completed 按完成时间倒序；全部=最近创建的真实任务。**后端先按真实
//! 条件过滤、排序，最后 LIMIT 12**，前端不做「前 12 条再筛」的二次截断——
//! 否则 20 条逾期任务会把今天到期的任务挤出结果，面板误显示为空。
//! 面板底栏明确标注「最近记录」，完整入口在「全部任务」。
//! 已完成的量来自 `stats.completed_today`，不伪造数据。
//!
//! 完成交互：先置 `is-done` 视觉态（320ms）再移出列表；`toggle` 失败则撤销
//! 该视觉态并重新拉取真实列表，同时在底栏给出一次失败提示——
//! 绝不把没保存成功的任务伪装成已完成。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Check, CheckCircle2, ChevronRight, ListTodo, Plus } from "lucide-react";
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

/** 分段 → 轻量查询范围：一一对应，每个分段只取自己需要的真实结果。 */
function scopeOf(filter: Filter): TaskLiteScope {
  if (filter === "done") return "completed";
  return filter;
}

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
   * 切分段只在数据范围不同时重新读取：每个分段对应一份真实查询。
   * `liteScope` 是已有数据的范围，`liteTarget` 是最近请求的范围；两者任一
   * 与目标不一致就要重新确认——否则切回刚离开的分段时，在途响应会把旧范围
   * 数据作废，而面板误以为已有数据不再请求，最终停在空白。
   */
  const changeFilter = (next: Filter) => {
    setFilter(next);
    const target = scopeOf(next);
    const state = useTasksStore.getState();
    if (
      state.liteScope !== target ||
      state.liteTarget !== target ||
      state.liteError !== null
    ) {
      void loadLite(target);
    }
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
  const scope = scopeOf(filter);
  // 只有「已成功写入的数据范围」与当前分段一致时，才允许据此判断空态。
  const scopeReady = items !== null && liteScope === scope;
  const visible = useMemo(() => {
    // 分段范围与已取回数据不一致时视为读取中：不拿旧范围的列表冒充新分段
    if (!items || liteScope !== scopeOf(filter)) return null;
    // 范围已由后端查询表达（过滤 + 排序 + LIMIT），面板只负责展示排序与移出动画。
    // 「日程」保留后端 sort=scheduled 的「未来优先、逾期置后」顺序；其余分段
    // 仍用本地 sortPending（逾期优先）。本地再按逾期优先排会把后端已排好的
    // 未来计划重新压回逾期后面，等于抵消查询修复。
    const pendingList =
      filter === "scheduled"
        ? items.filter((t) => t.status !== "completed")
        : sortPending(items.filter((t) => t.status !== "completed"));
    const doneList = items
      .filter((t) => t.status === "completed")
      .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    return [...pendingList, ...doneList].filter((t) => !hidden.has(t.id)).slice(0, 12);
  }, [items, liteScope, filter, hidden]);

  const localDone = items?.filter((t) => t.status === "completed").length ?? 0;
  const pending = stats?.pending ?? items?.filter((t) => t.status !== "completed").length ?? 0;
  const today = stats?.due_today ?? 0;
  const doneToday = stats?.completed_today ?? localDone;
  const total = doneToday + pending;
  const pct = total > 0 ? Math.round((doneToday / total) * 100) : 0;
  // 数据错误与空态分开：失败时旧列表保留展示 + 可重试错误条；没成功过则错误空态
  const dataError = liteError !== null;
  // 空态只在「当前分段的真实查询结果为空」时出现，不能由 LIMIT 截断推断
  const noTasksAtAll = scopeReady && items !== null && items.length === 0;
  const emptyText =
    filter === "done"
      ? "暂无已完成任务"
      : filter === "today"
        ? "今天没有到期任务"
        : filter === "scheduled"
          ? "暂无日程任务"
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
        {/* 错误优先于空态：读取失败绝不伪装成「暂无任务」。
            当前分段尚无成功数据时给错误空态；已有当前分段数据则保留列表 + 错误条。 */}
        {dataError && !scopeReady && (
          <EmptyState
            icon={<ListTodo size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="任务列表读取失败"
            actionLabel="重试"
            onAction={() => void loadLite(scope)}
          />
        )}

        {dataError && scopeReady && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">刷新失败，显示的是上次结果</span>
            <button
              type="button"
              className="cap-mini"
              aria-label="重试读取任务列表"
              onClick={() => void loadLite(scope)}
            >
              重试
            </button>
          </div>
        )}

        {!dataError && scopeReady && visible !== null && visible.length === 0 && (
          <EmptyState
            icon={<ListTodo size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={emptyText}
            actionLabel={noTasksAtAll ? "新建任务" : undefined}
            onAction={() => inputRef.current?.focus()}
          />
        )}
        {scopeReady && visible?.map((t) => {
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
        {/* 全局零任务时没有「今天的完成进度」可言，不渲染无意义的 0% 进度条 */}
        {total > 0 && (
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
