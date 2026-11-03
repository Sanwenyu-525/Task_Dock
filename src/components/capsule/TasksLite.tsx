//! 任务面板（胶囊内，对照 `docs/screenshots/v07/停靠效果图/01-tasks.png`）。
//!
//! 数据：直接调用既有 `list_tasks`（view=all, status=pending, sort=due）——
//! **不是**第二套状态源，只是同一后端命令的按需读取；完成经
//! `useTasksStore.toggle` 落库（该动作自带 refresh，统计与主窗口同步刷新）。
//!
//! 分段筛选全部是对**已取回的同一份真实列表**做本地过滤，不新增 IPC，
//! 也不伪造「已完成」视图：已完成的量来自 `stats.completed_today`。
//!
//! 完成交互：先置 `is-done` 视觉态（320ms）再移出列表；`toggle` 失败则撤销
//! 该视觉态并重新拉取真实列表，同时在底栏给出一次失败提示——
//! 绝不把没保存成功的任务伪装成已完成。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Check, CheckCircle2, ChevronRight, ListTodo, Plus } from "lucide-react";
import { listTasks, type Task } from "../../lib/bridge";
import { useTasksStore } from "../../store/useTasksStore";
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
  const [items, setItems] = useState<Task[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timers = useRef<number[]>([]);
  const stats = useTasksStore((s) => s.stats);

  // 一次取回 pending + completed（status=all），五个分段全部在本地切分：
  // 切分段不产生新 IPC，也不会出现「同一屏两次快照不一致」。
  const load = useCallback(async () => {
    try {
      const list = await listTasks({ view: "all", status: "all", sort: "due" });
      const pending = sortPending(list.filter((t) => t.status !== "completed"));
      const done = list
        .filter((t) => t.status === "completed")
        .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
      setItems([...pending, ...done]);
    } catch {
      setItems([]); // 失败按空处理，但不显示假数据
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      await useTasksStore.getState().quickCreate(v, null, null, null);
      setText("");
      await load();
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
      later(() => setItems((prev) => prev?.filter((t) => t.id !== id) ?? prev), 320);
    } catch {
      setCompleting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      flash("完成失败，已回滚");
      void load(); // 重新拉真实状态
    }
  };

  const now = Date.now();
  const visible = useMemo(() => {
    if (!items) return null;
    const isDone = (t: Task) => t.status === "completed";
    const list = items.filter((t) => {
      if (filter === "done") return isDone(t);
      if (isDone(t)) return filter === "all";
      if (filter === "pending") return true;
      if (filter === "today") return t.due_at ? sameDay(new Date(t.due_at).getTime(), now) : false;
      if (filter === "scheduled") return t.due_at !== null;
      return true;
    });
    return list.slice(0, 12);
  }, [items, filter, now]);

  const localDone = items?.filter((t) => t.status === "completed").length ?? 0;
  const pending = stats?.pending ?? items?.filter((t) => t.status !== "completed").length ?? 0;
  const today = stats?.due_today ?? 0;
  const doneToday = stats?.completed_today ?? localDone;
  const total = doneToday + pending;
  const pct = total > 0 ? Math.round((doneToday / total) * 100) : 0;

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

      <Segmented label="任务筛选" options={FILTERS} value={filter} onChange={setFilter} />

      <div className="cap-list">
        {visible !== null && visible.length === 0 && (
          <EmptyState
            icon={<ListTodo size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={
              items && items.length === 0
                ? "暂无待办"
                : filter === "done"
                  ? "还没有已完成的任务"
                  : "该筛选下没有任务"
            }
            actionLabel={items && items.length === 0 ? "新建任务" : undefined}
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
          {notice ?? `已完成 ${doneToday} 项`}
        </span>
        <span className="cap-progress" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </span>
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
