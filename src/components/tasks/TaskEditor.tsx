//! 任务编辑器：新建/编辑、优先级、时间、重复规则、Agent 关联、导航目标关联。

import { useEffect, useRef, useState } from "react";
import {
  Trash2, Link2, Unlink, X, ArrowUp, ArrowDown, AppWindow, Star, ClipboardList, Layers,
} from "lucide-react";
import {
  clipboardTaskLinks,
  clipboardUnlinkTask,
  listTaskLinks,
  linkTaskAgent,
  unlinkTaskAgent,
  type ClipboardTaskLink,
  type RecurrenceRuleInput,
} from "../../lib/bridge";
import { kindLabel } from "../../lib/clipboardUi";
import {
  navTaskTargets, navUnlinkTask, navUpdateTaskLink, navForgetTaskWindow, navSetTaskWindowFallback,
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
import { DateTimePicker, NumberInput, Select } from "../ui";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function recurrenceKey(rule: RecurrenceRuleInput | null): string {
  if (!rule) return "";
  return JSON.stringify({
    freq: rule.freq,
    interval: rule.interval,
    by_weekday: rule.freq === "weekly" ? [...rule.by_weekday].sort((a, b) => a - b) : [],
    by_monthday: rule.freq === "monthly" ? rule.by_monthday : null,
  });
}

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
  const refreshTasks = useTasksStore((s) => s.refresh);
  const agents = useAgentsStore((s) => s.snapshot);
  const refreshNavLinks = useNavigationStore((s) => s.loadTaskLinks);
  const openClipboard = useUiStore((s) => s.openClipboard);
  const openContext = useUiStore((s) => s.openContext);
  const clipboardLinkVersion = useUiStore((s) => s.clipboardLinkVersion);
  const clipboardOpen = useUiStore((s) => s.clipboardOpen);

  const task = editor.task;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(2);
  const [category, setCategory] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [due, setDue] = useState("");
  const [remind, setRemind] = useState("");
  /**
   * 只有用户真正改过时间字段才提交它。
   *
   * 原因有两层：
   * 1) datetime-local 只能到分钟，回写会把原本的秒截断——不碰也要改数据；
   * 2) 后端把「未提供」当作「保持原值」、把「显式 null」当作「清空」，
   *    前端必须如实表达"我没动它"，否则独立提醒会被编辑动作抹掉。
   */
  const [dueTouched, setDueTouched] = useState(false);
  const [remindTouched, setRemindTouched] = useState(false);
  const [advance, setAdvance] = useState(0);
  const [freq, setFreq] = useState<"" | "daily" | "weekly" | "monthly">("");
  const [interval, setIntervalValue] = useState(1);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [monthday, setMonthday] = useState(1);
  const [links, setLinks] = useState<Awaited<ReturnType<typeof listTaskLinks>>>([]);
  const [linkSession, setLinkSession] = useState("");
  const [navLinks, setNavLinks] = useState<TaskNavLink[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLink, setPickerLink] = useState<TaskNavLink | null>(null);
  const [clipLinks, setClipLinks] = useState<ClipboardTaskLink[]>([]);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor.open) return;
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setPriority(task?.priority ?? 2);
    setCategory(task?.category ?? "");
    setTagsText((task?.tags ?? []).join(", "));
    setDue(toLocalInputValue(task?.due_at));
    setRemind(toLocalInputValue(task?.remind_at));
    setDueTouched(false);
    setRemindTouched(false);
    setAdvance(task?.advance_minutes ?? 0);
    const r = task?.recurrence;
    setFreq(r ? (r.freq as "daily" | "weekly" | "monthly") : "");
    setIntervalValue(r?.interval ?? 1);
    setWeekdays(r?.by_weekday ?? []);
    setMonthday(r?.by_monthday ?? 1);
    setNavLinks([]);
    setPickerOpen(false);
    setPickerLink(null);
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

  // 剪贴板关联（手动；抽屉关联后通过版本号触发重读）
  useEffect(() => {
    if (!editor.open || !task) {
      setClipLinks([]);
      return;
    }
    clipboardTaskLinks(task.id)
      .then((links) => setClipLinks(links ?? []))
      .catch(() => setClipLinks([]));
  }, [editor.open, task, clipboardLinkVersion]);

  // 弹层栈：任务编辑器是普通模态（--z-modal 70），不是确认框（--z-dialog 940）。
  // 编辑器里的日期/下拉弹层 z 更高，Escape 必须先关它们（见 KIND_PRIORITY）。
  // 关联剪贴板时抽屉盖在编辑器之上，弹层栈让给抽屉（它自己注册为 dialog）。
  useOverlayLayer("modal", editor.open && !clipboardOpen, closeEditor, modalRef);
  // 关联目标选择器是内层模态，Tab 焦点归它管——两层同时陷阱会把焦点放回外层
  useFocusTrap(editor.open && !pickerOpen && !clipboardOpen, modalRef);

  if (!editor.open) return null;

  async function reloadNav() {
    if (task) {
      setNavLinks(await navTaskTargets(task.id).catch(() => []));
    }
    await refreshNavLinks();
  }

  async function onNavDefault(id: string) {
    try {
      await navUpdateTaskLink(id, { isDefault: true });
      await reloadNav();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onNavBehavior(id: string, behavior: string) {
    try {
      await navUpdateTaskLink(id, { launchBehavior: behavior });
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
      await navUpdateTaskLink(a.id, { displayOrder: b.display_order });
      await navUpdateTaskLink(b.id, { displayOrder: a.display_order });
      await reloadNav();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onNavRemove(id: string) {
    try {
      await navUnlinkTask(id);
      await reloadNav();
      await refreshTasks();
    } catch (e) {
      showToast(String(e), { kind: "error" });
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
      advance_minutes: advance,
      // 只在规则确实发生变化时发送；缺失、null 和具体值分别表示保留、取消和修改。
      ...(!task || recurrenceKey(recurrence) !== recurrenceKey(task.recurrence)
        ? { recurrence }
        : {}),
      // 未改动 → 不提交该键（后端保持原值）；改动过 → 提交（null 表示清空）
      ...(dueTouched && due !== toLocalInputValue(task?.due_at) ? { due_at: fromLocalInputValue(due) } : {}),
      ...(remindTouched && remind !== toLocalInputValue(task?.remind_at) ? { remind_at: fromLocalInputValue(remind) } : {}),
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
      await refreshTasks();
      setLinkSession("");
    } catch (e) {
      showToast(String(e));
    }
  }

  async function onUnlink(id: string) {
    try {
      await unlinkTaskAgent(id);
      setLinks(await listTaskLinks(task!.id));
      await refreshTasks();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function onClipUnlink(id: string) {
    try {
      await clipboardUnlinkTask(id);
      setClipLinks((await clipboardTaskLinks(task!.id)) ?? []);
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  const sessions = (agents?.sessions ?? []).slice(0, 50);

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && closeEditor()}>
      <div className="modal" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true"
        aria-label={task ? "编辑任务" : "新建任务"} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{task ? "编辑任务" : "新建任务"}</span>
          <button className="icon-btn sm" onClick={closeEditor} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>标题</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus />
          </label>
          <label className="field">
            <span>描述</span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="field-row">
            <label className="field">
              <span>优先级</span>
              <Select
                ariaLabel="优先级"
                size="sm"
                value={String(priority)}
                options={[
                  { value: "0", label: "P0 紧急" },
                  { value: "1", label: "P1 高" },
                  { value: "2", label: "P2 中" },
                  { value: "3", label: "P3 低" },
                ]}
                onChange={(v) => setPriority(Number(v))}
              />
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
              <DateTimePicker
                ariaLabel="截止时间"
                value={due}
                onChange={(v) => {
                  setDue(v);
                  setDueTouched(true);
                }}
              />
            </label>
            <label
              className="field"
              title="独立提醒时间：可与截止时间不同，留空表示不单独提醒"
            >
              <span>提醒时间</span>
              <DateTimePicker
                ariaLabel="提醒时间"
                value={remind}
                onChange={(v) => {
                  setRemind(v);
                  setRemindTouched(true);
                }}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>提前提醒（分钟）</span>
              <NumberInput
                size="sm"
                min={0}
                max={1440}
                value={advance}
                ariaLabel="提前提醒（分钟）"
                onChange={setAdvance}
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
              <NumberInput
                size="sm"
                min={1}
                max={31}
                value={monthday}
                ariaLabel="每月几日"
                onChange={setMonthday}
              />
            </label>
          )}
          {freq && (
            <label className="field">
              <span>间隔（{freq === "daily" ? "天" : freq === "weekly" ? "周" : "个月"}）</span>
              <NumberInput
                size="sm"
                min={1}
                max={30}
                value={interval}
                ariaLabel="重复间隔"
                onChange={setIntervalValue}
              />
            </label>
          )}
          {recurrence && <div className="preview-matched">规则：{describeRecurrence(recurrence)}</div>}

          {task && (
            <div className="field">
              <span>
                <AppWindow size={12} /> 关联目标（软件 / 网址 / 文件 / 目录 / Agent 会话）
              </span>
              <div className="link-row">
                <button className="btn sm" onClick={() => { setPickerLink(null); setPickerOpen(true); }}>
                  <AppWindow size={12} /> 添加目标…
                </button>
                {navLinks.length >= 2 && (
                  <span className="endpoint-hint">多个目标可在任务卡「打开工作区」一键启动</span>
                )}
              </div>
              {navLinks.map((l, i) => {
                const badge = stateBadge(l.running_state);
                return (
                  <div key={l.id}>
                  <div className="nav-link-item">
                    <TargetAvatar link={l} size={18} />
                    <span className="nav-link-name" title={l.target.display_name}>
                      {l.target.display_name}
                    </span>
                    <span className={`nav-link-state tone-${badge.tone}`}>{badge.label}</span>
                    <Select
                      className="nav-link-behavior"
                      size="sm"
                      value={l.launch_behavior}
                      ariaLabel="跳转行为"
                      options={Object.entries(BEHAVIOR_LABELS).map(([v, label]) => ({
                        value: v,
                        label,
                      }))}
                      onChange={(v) => onNavBehavior(l.id, v)}
                    />
                    <button
                      className={`icon-btn sm ${l.is_default ? "default-on" : ""}`}
                      data-tip={l.is_default ? "默认目标（点击图标直接打开）" : "设为默认目标"}
                      aria-label={l.is_default ? `默认目标：${l.target.display_name}` : `设 ${l.target.display_name} 为默认`}
                      onClick={() => onNavDefault(l.id)}
                    >
                      <Star size={11} />
                    </button>
                    <button
                      className="icon-btn sm"
                      data-tip="上移"
                      aria-label={`上移 ${l.target.display_name}`}
                      disabled={i === 0}
                      onClick={() => onNavMove(i, -1)}
                    >
                      <ArrowUp size={11} />
                    </button>
                    <button
                      className="icon-btn sm"
                      data-tip="下移"
                      aria-label={`下移 ${l.target.display_name}`}
                      disabled={i === navLinks.length - 1}
                      onClick={() => onNavMove(i, 1)}
                    >
                      <ArrowDown size={11} />
                    </button>
                    <button
                      className="icon-btn sm"
                      data-tip="取消关联（不删除目标配置）"
                      aria-label={`取消关联 ${l.target.display_name}`}
                      onClick={() => onNavRemove(l.id)}
                    >
                      <Unlink size={11} />
                    </button>
                  </div>
                  {l.target.target_type === "application" && !!l.target.exe_path && (
                    <div className="link-row">
                      <span className="endpoint-hint" title={l.window_identity?.title}>
                        {l.window_identity ? `窗口：${l.window_identity.title}` : "未指定窗口"}
                      </span>
                      <button className="btn sm" onClick={() => { setPickerLink(l); setPickerOpen(true); }}>
                        {l.window_identity ? "重新选择窗口" : "选择窗口"}
                      </button>
                      {l.window_identity && <button className="btn sm" onClick={async () => {
                        try { await navForgetTaskWindow(l.id); await reloadNav(); }
                        catch (e) { showToast(String(e), { kind: "error" }); }
                      }}>清除窗口</button>}
                      {l.window_identity && (
                        <Select
                          size="sm"
                          ariaLabel={`窗口未找到时 ${l.target.display_name}`}
                          value={l.window_fallback ?? "reselect"}
                          options={[
                            { value: "reselect", label: "提示重新选择" },
                            { value: "focus_app", label: "降级唤醒应用" },
                            { value: "launch", label: "降级启动应用" },
                          ]}
                          onChange={async (v) => {
                            try { await navSetTaskWindowFallback(l.id, v); await reloadNav(); }
                            catch (err) { showToast(String(err), { kind: "error" }); }
                          }}
                        />
                      )}
                    </div>
                  )}
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
                <Select
                  ariaLabel="选择 Agent 会话"
                  size="sm"
                  value={linkSession}
                  options={[
                    { value: "", label: "选择会话…" },
                    ...sessions.map((s) => ({
                      value: `${s.source_id}::${s.external_id}`,
                      label: `[${s.source_id}] ${s.title || s.external_id}（${s.status}）`,
                    })),
                  ]}
                  onChange={setLinkSession}
                />
                <button className="btn sm" onClick={onLink} disabled={!linkSession}>
                  关联
                </button>
              </div>
              {links.map((l) => (
                <div key={l.id} className="link-item">
                  <span>
                    {l.source_id} · {l.session_external_id}
                    {l.run_external_id ? ` · ${l.run_external_id}` : ""}
                    {!l.available ? " · 已失效" : ""}
                  </span>
                  <button className="icon-btn sm" onClick={() => onUnlink(l.id)} title="取消关联">
                    <Unlink size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {task && (
            <div className="field">
              <span>
                <ClipboardList size={12} /> 关联剪贴板（手动）
              </span>
              <div className="link-row">
                <button className="btn sm" onClick={() => openClipboard({ linkTask: task })}>
                  <ClipboardList size={12} /> 从剪贴板选择条目或分组…
                </button>
              </div>
              <span className="endpoint-hint">不会自动绑定；删除任务不会删除剪贴板内容</span>
              {clipLinks.map((l) => (
                <div key={l.id} className="link-item">
                  <span title={l.label}>
                    {l.target_type === "group" ? "分组" : kindLabel(l.kind)} · {l.label || l.target_id}
                  </span>
                  <button
                    className="icon-btn sm"
                    onClick={() => onClipUnlink(l.id)}
                    title="取消剪贴板关联（不删除内容）"
                    aria-label="取消剪贴板关联"
                  >
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
          {task && (
            <button
              className="btn"
              onClick={() => {
                closeEditor();
                openContext(task);
              }}
              title="查看现场 / Agent / 关联目标 / 剪贴板 / 动作"
            >
              <Layers size={13} /> 上下文
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
          windowLink={pickerLink}
          taskId={task.id}
          onClose={() => setPickerOpen(false)}
          onSelect={undefined}
        />
      )}
    </div>
  );
}
