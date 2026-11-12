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
//! 完成交互：先置 `is-done` 视觉态（320ms）再移出列表；底栏给出限时「撤销」，
//! 已完成条目也可直接点勾选圈恢复为待办（勾回）。`toggle` 失败则撤销该视觉态
//! 并重新拉取真实列表，同时在底栏给出一次失败提示——
//! 绝不把没保存成功的任务伪装成已完成，也不把撤销失败说成已恢复。
//! 重复任务完成后后端只推进期次（任务仍 pending）：此时不隐藏、不给「撤销」，
//! 而是提示下一期并展示刷新后的新期次——第二次 toggle 会继续推进，不能当作撤销。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BookmarkCheck,
  Check,
  CheckCircle2,
  ChevronRight,
  FolderGit2,
  ListTodo,
  Plus,
} from "lucide-react";
import { useTasksStore, type TaskLiteScope } from "../../store/useTasksStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { fetchTask, type Task } from "../../lib/bridge";
import { describeRecurrence } from "../../lib/format";
import useImeComposition from "../../hooks/useImeComposition";
import { resolveDevProjectChip } from "../devwork/DevProjectContext";
import { useLocale } from "../../hooks/useLocale";
import { openFullApp, openTaskEditor } from "./actions";
import { dueLabel, sortPending } from "./format";
import { EmptyState, PanelHead, Segmented, type SegOption } from "./PanelKit";

type Filter = "all" | "pending" | "today" | "scheduled" | "done";

const pad = (n: number) => String(n).padStart(2, "0");

/** 详情里的绝对时间（行内只给「今天/逾期」相对文案，详情需要可核对的时刻）。 */
function momentLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? "" : `${d.getFullYear()}/`}${d.getMonth() + 1}月${d.getDate()}日 ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

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
  const { t } = useLocale();
  const items = useTasksStore((s) => s.lite);
  const liteScope = useTasksStore((s) => s.liteScope);
  const liteError = useTasksStore((s) => s.liteError);
  const loadLite = useTasksStore((s) => s.loadLite);
  const releaseLite = useTasksStore((s) => s.releaseLite);
  const [filter, setFilter] = useState<Filter>("all");
  const filterRef = useRef<Filter>(filter);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  /** 在途完成的同步锁：`completing` 是异步 state，同一 tick 的连点会都读到旧值。 */
  const completingRef = useRef(new Set<string>());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  /** 最近一次完成：底栏据此提供限时撤销，不把「完成」做成不可逆操作。 */
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 计时器用 Set 并在回调触发后删除：长期打开的面板不会把已结束的 ID 一直累积。
  const timers = useRef(new Set<number>());
  // 每个任务最近一次「完成」的序号：撤销/勾回会递增它，使尚未执行的移出失效。
  // 不依赖刷新后的列表状态判断——刷新可能失败或滞后，不能让它决定动画是否收尾。
  const completeTokens = useRef(new Map<string, number>());
  const ime = useImeComposition();
  const stats = useTasksStore((s) => s.stats);

  // 开发工作台「当前任务」在胶囊内的置顶标记（显式设置，不自动推断）。
  // 列表里有就用列表数据；不在轻量列表（超出 LIMIT 12）时按需单独取一次。
  const currentId = useSettingsStore((s) => s.settings?.workbench_current_task ?? "") || null;
  const [fetchedCurrent, setFetchedCurrent] = useState<Task | null>(null);
  useEffect(() => {
    // 轻量列表未落地前不补取：否则会先为 null 取一次、列表到达后再取一次。
    if (items === null) return;
    if (!currentId || items.some((t) => t.id === currentId)) {
      setFetchedCurrent(null);
      return;
    }
    let alive = true;
    fetchTask(currentId)
      .then((task) => {
        if (alive) setFetchedCurrent(task);
      })
      .catch(() => {
        // 任务可能已被删除：胶囊内不弹窗，标记条退场（工作台内会如实展示失效态）
        if (alive) setFetchedCurrent(null);
      });
    return () => {
      alive = false;
    };
  }, [currentId, items]);
  const currentTask = useMemo(
    () => (currentId ? (items?.find((t) => t.id === currentId) ?? fetchedCurrent) : null),
    [currentId, items, fetchedCurrent],
  );

  // 开发工作台「当前项目」chip（Round 1）：与工作台开发现场区块共享 30s 缓存
  // （resolveDevProjectChip 内部命中同一份模块级缓存），不重复请求。
  // 列表未命中 / 读取失败 / 未设置：一律不渲染 chip，不渲染空壳。
  const currentProjectId =
    useSettingsStore((s) => s.settings?.workbench_current_project ?? "") || null;
  const [projectChip, setProjectChip] = useState<{
    name: string;
    branch: string | null;
  } | null>(null);
  useEffect(() => {
    if (!currentProjectId) {
      setProjectChip(null);
      return;
    }
    let alive = true;
    resolveDevProjectChip(currentProjectId)
      .then((c) => {
        if (alive) setProjectChip(c);
      })
      .catch(() => {
        if (alive) setProjectChip(null);
      });
    return () => {
      alive = false;
    };
  }, [currentProjectId]);

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
    if (next !== filterRef.current) {
      filterRef.current = next;
      // 「完成后移出」只属于完成时的分段：切段后按真实状态重新展示，
      // 否则刚完成的任务切到「已完成」也会被本地 hidden 隐藏。
      setHidden(new Set());
    }
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
    const pending = timers.current;
    return () => {
      pending.forEach((t) => window.clearTimeout(t));
      pending.clear();
    };
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);

  const flash = useCallback(
    (msg: string) => {
      setNotice(msg);
      later(() => setNotice((n) => (n === msg ? null : n)), 2400);
    },
    [later],
  );

  const add = async () => {
    const raw = text;
    const v = raw.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      // store 的 quickCreate 内部 refresh()：面板打开时已含轻量列表刷新
      await useTasksStore.getState().quickCreate(v, null, null, null);
      // 只清空「提交后没有改动」的输入：提交期间新输入的第二条内容（含输入法
      // 组合中的候选）不能被这次响应清空；组合态下 value 可能仍是旧文本。
      setText((cur) => (ime.isComposingNow() || cur !== raw ? cur : ""));
    } catch {
      flash("添加失败，请重试"); // 失败保留输入，用户可重试
    } finally {
      setBusy(false);
    }
  };

  const complete = async (target: Task) => {
    const id = target.id;
    // 同一任务的完成请求在途时忽略后续点击（双击/键盘连按）；其他任务不受影响。
    if (completingRef.current.has(id)) return;
    completingRef.current.add(id);
    const completedIn = filterRef.current;
    setCompleting((prev) => new Set(prev).add(id));
    try {
      const updated = await useTasksStore.getState().toggle(id);
      setExpandedId((cur) => (cur === id ? null : cur));
      if (updated.status === "completed") {
        setUndo({ id, title: target.title });
        // 撤销入口限时保留；期间又完成了别的任务时，只让最新一次的定时器生效。
        later(() => setUndo((cur) => (cur?.id === id ? null : cur)), 6000);
        // 视觉反馈先行：留 320ms 让勾选动画可见，再移出列表。
        // 期间切了分段就不再加 hidden——新分段应按真实状态展示。
        const token = (completeTokens.current.get(id) ?? 0) + 1;
        completeTokens.current.set(id, token);
        later(() => {
          if (filterRef.current !== completedIn) return;
          // 撤销/勾回已递增序号：这次移出属于旧的一次完成，不能再隐藏已恢复的任务。
          if (completeTokens.current.get(id) !== token) return;
          setHidden((prev) => new Set(prev).add(id));
        }, 320);
      } else {
        // 重复任务：后端只把期次推进到下一次，任务仍是 pending。
        // 不隐藏、不提供「撤销」——再次 toggle 只会继续推进期次，不是回退。
        setCompleting((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        flash(updated.due_at ? `已完成本期，下一期 ${momentLabel(updated.due_at)}` : "已完成本期");
      }
    } catch {
      setCompleting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      flash("完成失败，已回滚");
      void loadLite(scopeOf(filterRef.current)); // 重新拉当前分段的真实状态，不靠本地猜测
    } finally {
      completingRef.current.delete(id);
    }
  };

  /**
   * 撤销最近一次完成：走同一个 `toggle` 写回真实状态（不是只改本地视觉），
   * 失败时保留撤销入口并重拉真实列表，不把失败的撤销说成已恢复。
   */
  const undoComplete = async () => {
    if (!undo || undoing) return;
    const target = undo;
    setUndoing(true);
    try {
      await useTasksStore.getState().toggle(target.id);
      completeTokens.current.set(target.id, (completeTokens.current.get(target.id) ?? 0) + 1);
      // 完成时的勾选态与移出态都只属于「已完成」：撤销后必须一并清掉，
      // 否则回到列表的任务会被旧的 completing 记录继续画成已勾选。
      setCompleting((prev) => {
        if (!prev.has(target.id)) return prev;
        const next = new Set(prev);
        next.delete(target.id);
        return next;
      });
      setHidden((prev) => {
        if (!prev.has(target.id)) return prev;
        const next = new Set(prev);
        next.delete(target.id);
        return next;
      });
      setUndo((cur) => (cur?.id === target.id ? null : cur));
      flash("已撤销完成");
    } catch {
      flash("撤销失败，请重试");
      void loadLite(scopeOf(filterRef.current));
    } finally {
      setUndoing(false);
    }
  };

  /** 已完成任务重新打开（勾回）：状态写回仍走 store，失败同样回滚并重拉真实列表。 */
  const reopen = async (id: string) => {
    if (reopening) return;
    setReopening(id);
    try {
      await useTasksStore.getState().toggle(id);
      completeTokens.current.set(id, (completeTokens.current.get(id) ?? 0) + 1);
      setExpandedId(null);
      // 与撤销同理：旧的完成视觉态不能跟着任务回到待办列表。
      setCompleting((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setUndo((cur) => (cur?.id === id ? null : cur));
      flash("已重新打开");
    } catch {
      flash("操作失败，已回滚");
      void loadLite(scope);
    } finally {
      setReopening(null);
    }
  };

  /** 详情里的「编辑」不复制表单：定位到完整任务页并复用主窗口编辑器。
   *  切页与「打开编辑器」必须是同一个导航事务（openTaskEditor 内部只 setTab 一次），
   *  否则存在草稿时第二次导航会覆盖待确认导航绑定的 after，编辑意图丢失。 */
  const edit = (task: Task) => {
    openTaskEditor(task);
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
    return [...pendingList, ...doneList]
      .filter((t) => !hidden.has(t.id))
      // 当前任务已在置顶标记条展示时，从普通列表中去重（标记条是唯一入口，不重复占行）
      .filter((t) => !(currentTask && t.id === currentTask.id))
      .slice(0, 12);
  }, [items, liteScope, filter, hidden, currentTask]);

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
            data-tip-placement="bottom"
            onClick={() => inputRef.current?.focus()}
          >
            <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
        }
      />

      <Segmented label="任务筛选" options={FILTERS} value={filter} onChange={changeFilter} />

      {/* 当前任务置顶条（开发工作台锚点）：一个点击直达工作台，继续工作不进任务列表翻找 */}
      {currentTask && (
        <div className={`cap-item cap-current-row${currentTask.status === "completed" ? " is-done" : ""}`}>
          <span className="cap-current-flag" aria-hidden="true">
            <BookmarkCheck size={12} strokeWidth={2} />
          </span>
          <button
            type="button"
            className="cap-main cap-row-open"
            aria-label={`当前任务「${currentTask.title}」，打开工作台`}
            onClick={() => void openFullApp("workbench")}
          >
            <span className="cap-item-title" title={currentTask.title}>
              {currentTask.title}
            </span>
            <span className="cap-task-tags">
              <span className="cap-tag">当前</span>
              {currentTask.status === "completed" ? <span className="cap-pill tone-done">已完成</span> : null}
            </span>
          </button>
        </div>
      )}

      {/* 当前项目 chip（Round 1）：只读、不可交互，分支仅在 probe ok 时显示；
          未设置/未命中不渲染，不留空壳 */}
      {projectChip && (
        <div
          className="cap-devproject-chip"
          aria-label={t("devwork.project.chipAria", { name: projectChip.name })}
        >
          <FolderGit2 size={11} strokeWidth={2} aria-hidden="true" />
          <span className="cap-devproject-chip-text">
            {projectChip.name}
            {projectChip.branch ? ` · ${projectChip.branch}` : ""}
          </span>
        </div>
      )}

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
          const open = expandedId === t.id;
          const desc = t.description.trim();
          const remind = t.next_remind_at ?? t.remind_at;
          const recurrence = describeRecurrence(t.recurrence);
          return (
            <div className="cap-task-group" key={t.id}>
              <div className={`cap-item cap-task-row${isDone ? " is-done" : ""}`}>
                {completed ? (
                  // 已完成条目：点勾选圈直接恢复为待办（勾回），不必先展开详情。
                  // completed 状态下 toggle 只会写回 pending，不会误触发「再完成一次」。
                  <button
                    type="button"
                    className="cap-check is-checked"
                    aria-label={`将「${t.title}」恢复为待办`}
                    data-tip="恢复为待办"
                    aria-busy={reopening === t.id}
                    disabled={reopening === t.id}
                    onClick={() => void reopen(t.id)}
                  >
                    <Check size={11} strokeWidth={3} aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`cap-check${isDone ? " is-checked" : ""}`}
                    aria-label={`完成「${t.title}」`}
                    // 行内已经显示标题：提示只给动作，不重复长文案
                    data-tip="标记完成"
                    aria-pressed={isDone}
                    onClick={() => void complete(t)}
                  >
                    <Check size={11} strokeWidth={3} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="cap-main cap-row-open"
                  aria-label={`${open ? "收起" : "查看"}「${t.title}」详情`}
                  aria-expanded={open}
                  aria-controls={`task-detail-${t.id}`}
                  onClick={() => setExpandedId(open ? null : t.id)}
                >
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
                </button>
                <span className="cap-task-side">
                  {t.remind_at ? (
                    <span className="cap-task-bell" aria-label="已设置提醒" title="已设置提醒">
                      <Bell size={12} strokeWidth={1.8} aria-hidden="true" />
                    </span>
                  ) : null}
                </span>
              </div>
              {open && (
                <div className="cap-task-detail" id={`task-detail-${t.id}`}>
                  {desc ? (
                    <p className="cap-detail-desc">{desc}</p>
                  ) : (
                    <p className="cap-detail-desc is-muted">暂无备注</p>
                  )}
                  {t.due_at ? (
                    <div className="cap-detail-row">
                      <span className="cap-detail-label">截止</span>
                      <span className="cap-detail-value">{momentLabel(t.due_at)}</span>
                    </div>
                  ) : null}
                  {remind ? (
                    <div className="cap-detail-row">
                      <span className="cap-detail-label">提醒</span>
                      <span className="cap-detail-value">{momentLabel(remind)}</span>
                    </div>
                  ) : null}
                  {t.category ? (
                    <div className="cap-detail-row">
                      <span className="cap-detail-label">分类</span>
                      <span className="cap-detail-value">{t.category}</span>
                    </div>
                  ) : null}
                  {t.tags.length > 0 ? (
                    <div className="cap-detail-row">
                      <span className="cap-detail-label">标签</span>
                      <span className="cap-detail-value">{t.tags.join(" · ")}</span>
                    </div>
                  ) : null}
                  {recurrence ? (
                    <div className="cap-detail-row">
                      <span className="cap-detail-label">重复</span>
                      <span className="cap-detail-value">{recurrence}</span>
                    </div>
                  ) : null}
                  <div className="cap-detail-actions">
                    {completed ? (
                      <button
                        type="button"
                        className="cap-mini is-ok"
                        aria-label={`重新打开「${t.title}」`}
                        aria-busy={reopening === t.id}
                        disabled={reopening === t.id}
                        onClick={() => void reopen(t.id)}
                      >
                        重新打开
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="cap-mini"
                      aria-label={`编辑「${t.title}」`}
                      onClick={() => edit(t)}
                    >
                      编辑
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">
          <CheckCircle2 size={12} strokeWidth={1.8} aria-hidden="true" />
          {notice ?? (undo ? `已完成「${undo.title}」` : `最近记录 · 完成 ${doneToday}`)}
        </span>
        {/* 全局零任务时没有「今天的完成进度」可言，不渲染无意义的 0% 进度条 */}
        {total > 0 && (
          <span className="cap-progress" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
        <div className="cap-actions">
          {undo ? (
            <button
              type="button"
              className="cap-link"
              aria-label={`撤销完成「${undo.title}」`}
              disabled={undoing}
              onClick={() => void undoComplete()}
            >
              撤销
            </button>
          ) : null}
          <button type="button" className="cap-link" onClick={() => openFullApp("tasks")}>
            全部任务
            <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="cap-input cap-task-add">
        <Plus size={13} strokeWidth={2.2} aria-hidden="true" />
        <input
          className="input-embedded"
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            // 输入法确认候选的 Enter/Escape 不能触发新增或清空。
            if (ime.isComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            } else if (e.key === "Escape" && text) {
              e.preventDefault();
              e.stopPropagation();
              setText("");
            }
          }}
          placeholder="添加任务，回车保存"
          aria-label="快速添加任务"
          maxLength={200}
        />
      </div>
    </>
  );
}
