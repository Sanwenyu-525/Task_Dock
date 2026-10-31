//! 任务面板（胶囊内）：即将到期 / 待办 / 完成 / 快速新增 / 打开任务页。
//!
//! 数据：直接调用既有 `list_tasks`（view=all, status=pending）——**不是**第二套
//! 状态源，只是同一后端命令的按需读取；完成后经 `useTasksStore.toggle` 落库，
//! 全局统计与主窗口列表照常刷新。

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ListTodo, Plus } from "lucide-react";
import { listTasks, type Task } from "../../lib/bridge";
import { useTasksStore } from "../../store/useTasksStore";
import { openFullApp } from "./actions";
import { dueLabel, sortPending } from "./format";

export default function TasksLite() {
  const [items, setItems] = useState<Task[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await listTasks({ view: "all", status: "pending", sort: "due" });
      setItems(sortPending(list).slice(0, 5));
    } catch {
      setItems([]); // 失败按空处理，但不显示假数据
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await useTasksStore.getState().quickCreate(v, null, null, null);
      setText("");
      await load();
    } catch {
      // 失败保留输入，用户可重试
    } finally {
      setBusy(false);
    }
  };

  const complete = async (id: string) => {
    setItems((prev) => prev?.filter((t) => t.id !== id) ?? prev);
    try {
      await useTasksStore.getState().toggle(id);
    } catch {
      void load(); // 失败回滚（重新拉真实状态）
    }
  };

  const now = Date.now();
  const overdue = items?.filter((t) => t.due_at && new Date(t.due_at).getTime() < now).length ?? 0;

  return (
    <>
      <header className="capsule-head">
        <span className="capsule-title">任务</span>
        <span className="capsule-meta">
          {items === null ? "读取中" : `${items.length} 项待办${overdue > 0 ? ` · ${overdue} 逾期` : ""}`}
        </span>
      </header>

      <div className="capsule-body">
        {items !== null && items.length === 0 && (
          <div className="capsule-empty">
            <ListTodo size={20} strokeWidth={1.6} aria-hidden="true" />
            <p>暂无待办</p>
            <button type="button" className="capsule-link" onClick={() => inputRef.current?.focus()}>
              新建任务
            </button>
          </div>
        )}
        {items?.map((t) => {
          const due = dueLabel(t.due_at, now);
          return (
            <div className="capsule-row" key={t.id}>
              <button
                type="button"
                className="capsule-check"
                aria-label={`完成「${t.title}」`}
                onClick={() => void complete(t.id)}
              >
                <Check size={11} strokeWidth={3} aria-hidden="true" />
              </button>
              <span className="capsule-row-main">
                <span className="capsule-row-title">{t.title}</span>
                <span className={`capsule-row-sub tone-${due.tone}`}>{due.text}</span>
              </span>
            </div>
          );
        })}
      </div>

      <footer className="capsule-foot">
        <div className="capsule-add">
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
        <button type="button" className="capsule-link" onClick={() => openFullApp("tasks")}>
          任务页
        </button>
      </footer>
    </>
  );
}
