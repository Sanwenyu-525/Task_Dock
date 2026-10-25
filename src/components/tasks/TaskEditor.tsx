//! 任务编辑器：新建/编辑、优先级、时间、重复规则、Agent 关联、导航目标关联。

import { useEffect, useState } from "react";
import { Trash2, Link2, Unlink, X, ArrowUp, ArrowDown, AppWindow, Star } from "lucide-react";
import {
  listTaskLinks,
  linkTaskAgent,
  unlinkTaskAgent,
  type RecurrenceRuleInput,
} from "../../lib/bridge";
import {
  navTaskTargets, navUnlinkTask, navUpdateTaskLink,
  stateBadge,
} from "../../lib/navigation";
import type { TaskNavLink } from "../../lib/navigation";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { describeRecurrence, fromLocalInputValue, toLocalInputValue } from "../../lib/format";
import AppPicker from "../navigation/AppPicker";
import { TargetAvatar } from "../navigation/TargetMenu";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

const BEHAVIOR_LABELS: Record<string, string> = {
  default: "按偏好",
  focus_or_launch: "优先唤醒",
  launch: "总是启动",
  resume_session: "恢复会话",
  open: "打开",
};

export default function TaskEditor() {
  const editor = useUiStore((s) => s.editor);
  const closeEditor = useUiStore((s) => s.closeEditor);
  const showToast = useUiStore((s) => s.showToast);
  const create = useTasksStore((s) => s.create);
  const update = useTasksStore((s) => s.update);
  const remove = useTasksStore((s) => s.remove);
  const agents = useAgentsStore((s) => s.snapshot);
  const refreshNavLinks = useNavigationStore((s) => s.loadTaskLinks);

  const task = editor.task;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(2);
  const [category, setCategory] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [due, setDue] = useState("");
  const [advance, setAdvance] = useState(0);
  const [freq, setFreq] = useState<"" | "daily" | "weekly" | "monthly">("");
  const [interval, setIntervalValue] = useState(1);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [monthday, setMonthday] = useState(1);
  const [links, setLinks] = useState<Awaited<ReturnType<typeof listTaskLinks>>>([]);
  const [linkSession, setLinkSession] = useState("");
  const [navLinks, setNavLinks] = useState<TaskNavLink[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!editor.open) return;
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setPriority(task?.priority ?? 2);
    setCategory(task?.category ?? "");
    setTagsText((task?.tags ?? []).join(", "));
    setDue(toLocalInputValue(task?.due_at));
    setAdvance(task?.advance_minutes ?? 0);
    const r = task?.recurrence;
    setFreq(r ? (r.freq as "daily" | "weekly" | "monthly") : "");
    setIntervalValue(r?.interval ?? 1);
    setWeekdays(r?.by_weekday ?? []);
    setMonthday(r?.by_monthday ?? 1);
    setNavLinks([]);
    setPickerOpen(false);
    if (task) {
      listTaskLinks(task.id).then(setLinks).catch(() => setLinks([]));
      navTaskTargets(task.id).then(setNavLinks).catch(() => setNavLinks([]));
    } else {
      setLinks([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.open, task]);

  // 应用选择器关闭后（可能在其中完成了关联）：重读本任务关联列表
  useEffect(() => {
    if (!pickerOpen && editor.open && task) {
      navTaskTargets(task.id).then(setNavLinks).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);

  if (!editor.open) return null;

  async function reloadNav() {
    if (task) {
      setNavLinks(await navTaskTargets(task.id).catch(() => []));
    }
    await refreshNavLinks();
  }

  async function onNavDefault(id: string) {
    try {
      await navUpdateTaskLink(id, { is_default: true });
      await reloadNav();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onNavBehavior(id: string, behavior: string) {
    try {
      await navUpdateTaskLink(id, { launch_behavior: behavior });
      await reloadNav();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onNavMove(index: number, delta: -1 | 1) {
    const a = navLinks[index];
    const b = navLinks[index + delta];
    if (!a || !b) return;
    try {
      await navUpdateTaskLink(a.id, { display_order: b.display_order });
      await navUpdateTaskLink(b.id, { display_order: a.display_order });
      await reloadNav();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onNavRemove(id: string) {
    try {
      await navUnlinkTask(id);
      await reloadNav();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  // Escape 关闭（输入框内同样生效；不与窗口隐藏冲突——事件在此消费）
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeEditor();
    }
  }

  const recurrence: RecurrenceRuleInput | null = freq
    ? {
        freq,
        interval,
        by_weekday: freq === "weekly" ? weekdays : [],
        by_monthday: freq === "monthly" ? monthday : null,
      }
    : null;

  async function onSave() {
    if (!title.trim()) {
      showToast("标题不能为空");
      return;
    }
    const input = {
      title: title.trim(),
      description: description.trim(),
      priority,
      category: category.trim(),
      tags: tagsText
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20),
      due_at: fromLocalInputValue(due),
      advance_minutes: advance,
      recurrence,
    };
    try {
      if (task) await update(task.id, input);
      else await create(input);
      closeEditor();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function onDelete() {
    if (!task) return;
    try {
      await remove(task.id);
      closeEditor();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function onLink() {
    if (!task || !linkSession) return;
    const [sourceId, sessionId] = linkSession.split("::");
    try {
      await linkTaskAgent(task.id, sourceId, sessionId);
      setLinks(await listTaskLinks(task.id));
      setLinkSession("");
    } catch (e) {
      showToast(String(e));
    }
  }

  async function onUnlink(id: string) {
    try {
      await unlinkTaskAgent(id);
      setLinks(await listTaskLinks(task!.id));
    } catch (e) {
      showToast(String(e));
    }
  }

  const sessions = (agents?.sessions ?? []).slice(0, 50);

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && closeEditor()} onKeyDown={onKeyDown}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{task ? "编辑任务" : "新建任务"}</span>
          <button className="icon-btn sm" onClick={closeEditor}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>标题</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>描述</span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="field-row">
            <label className="field">
              <span>优先级</span>
              <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                <option value={0}>P0 紧急</option>
                <option value={1}>P1 高</option>
                <option value={2}>P2 中</option>
                <option value={3}>P3 低</option>
              </select>
            </label>
            <label className="field">
              <span>分类</span>
              <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="工作 / 生活" />
            </label>
          </div>
          <label className="field">
            <span>标签（逗号分隔）</span>
            <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="审计, Windows" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>截止时间</span>
              <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="field">
              <span>提前提醒（分钟）</span>
              <input
                type="number"
                min={0}
                max={1440}
                value={advance}
                onChange={(e) => setAdvance(Number(e.target.value))}
              />
            </label>
          </div>

          <div className="field">
            <span>重复</span>
            <div className="seg-group">
              <button className={`seg-btn ${freq === "" ? "active" : ""}`} onClick={() => setFreq("")}>
                不重复
              </button>
              <button className={`seg-btn ${freq === "daily" ? "active" : ""}`} onClick={() => setFreq("daily")}>
                每天
              </button>
              <button className={`seg-btn ${freq === "weekly" ? "active" : ""}`} onClick={() => setFreq("weekly")}>
                每周
              </button>
              <button className={`seg-btn ${freq === "monthly" ? "active" : ""}`} onClick={() => setFreq("monthly")}>
                每月
              </button>
            </div>
          </div>
          {freq === "weekly" && (
            <div className="field">
              <span>重复日（周）</span>
              <div className="seg-group">
                {WEEKDAYS.map((d, i) => (
                  <button
                    key={d}
                    className={`seg-btn ${weekdays.includes(i + 1) ? "active" : ""}`}
                    onClick={() =>
                      setWeekdays((ws) => (ws.includes(i + 1) ? ws.filter((x) => x !== i + 1) : [...ws, i + 1]))
                    }
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
          {freq === "monthly" && (
            <label className="field">
              <span>每月几日</span>
              <input
                type="number"
                min={1}
                max={31}
                value={monthday}
                onChange={(e) => setMonthday(Number(e.target.value))}
              />
            </label>
          )}
          {freq && (
            <label className="field">
              <span>间隔（{freq === "daily" ? "天" : freq === "weekly" ? "周" : "个月"}）</span>
              <input
                type="number"
                min={1}
                max={30}
                value={interval}
                onChange={(e) => setIntervalValue(Number(e.target.value))}
              />
            </label>
          )}
          {recurrence && <div className="preview-matched">规则：{describeRecurrence(recurrence)}</div>}

          {task && (
            <div className="field">
              <span>
                <AppWindow size={12} /> 关联目标（软件 / 网址 / 文件 / 目录）
              </span>
              <div className="link-row">
                <button className="btn sm" onClick={() => setPickerOpen(true)}>
                  <AppWindow size={12} /> 添加目标…
                </button>
                {navLinks.length >= 2 && (
                  <span className="endpoint-hint">多个目标可在任务卡「打开工作区」一键启动</span>
                )}
              </div>
              {navLinks.map((l, i) => {
                const badge = stateBadge(l.running_state);
                return (
                  <div key={l.id} className="nav-link-item">
                    <TargetAvatar link={l} size={18} />
                    <span className="nav-link-name" title={l.target.display_name}>
                      {l.target.display_name}
                    </span>
                    <span className={`nav-link-state tone-${badge.tone}`}>{badge.label}</span>
                    <select
                      className="input sm nav-link-behavior"
                      value={l.launch_behavior}
                      aria-label="跳转行为"
                      onChange={(e) => onNavBehavior(l.id, e.target.value)}
                    >
                      {Object.entries(BEHAVIOR_LABELS).map(([v, label]) => (
                        <option key={v} value={v}>{label}</option>
                      ))}
                    </select>
                    <button
                      className={`icon-btn sm ${l.is_default ? "default-on" : ""}`}
                      title={l.is_default ? "默认目标（点击图标直接打开）" : "设为默认目标"}
                      aria-label={l.is_default ? `默认目标：${l.target.display_name}` : `设 ${l.target.display_name} 为默认`}
                      onClick={() => onNavDefault(l.id)}
                    >
                      <Star size={11} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title="上移"
                      aria-label={`上移 ${l.target.display_name}`}
                      disabled={i === 0}
                      onClick={() => onNavMove(i, -1)}
                    >
                      <ArrowUp size={11} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title="下移"
                      aria-label={`下移 ${l.target.display_name}`}
                      disabled={i === navLinks.length - 1}
                      onClick={() => onNavMove(i, 1)}
                    >
                      <ArrowDown size={11} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title="取消关联（不删除目标配置）"
                      aria-label={`取消关联 ${l.target.display_name}`}
                      onClick={() => onNavRemove(l.id)}
                    >
                      <Unlink size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {task && (
            <div className="field">
              <span>
                <Link2 size={12} /> 关联 Agent 会话
              </span>
              <div className="link-row">
                <select value={linkSession} onChange={(e) => setLinkSession(e.target.value)}>
                  <option value="">选择会话…</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={`${s.source_id}::${s.external_id}`}>
                      [{s.source_id}] {s.title || s.external_id}（{s.status}）
                    </option>
                  ))}
                </select>
                <button className="btn sm" onClick={onLink} disabled={!linkSession}>
                  关联
                </button>
              </div>
              {links.map((l) => (
                <div key={l.id} className="link-item">
                  <span>
                    {l.source_id} · {l.session_external_id}
                    {l.run_external_id ? ` · ${l.run_external_id}` : ""}
                  </span>
                  <button className="icon-btn sm" onClick={() => onUnlink(l.id)} title="取消关联">
                    <Unlink size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {task && task.status !== "completed" && (
            <button className="btn danger" onClick={onDelete}>
              <Trash2 size={13} /> 删除
            </button>
          )}
          <div className="flex-spacer" />
          <button className="btn" onClick={closeEditor}>
            取消
          </button>
          <button className="btn primary" onClick={onSave}>
            保存
          </button>
        </div>
      </div>
      {pickerOpen && task && (
        <AppPicker
          taskId={task.id}
          onClose={() => setPickerOpen(false)}
          onSelect={undefined}
        />
      )}
    </div>
  );
}
