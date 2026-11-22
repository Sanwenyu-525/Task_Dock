//! 任务编辑器（页面内编辑态）：标题 / 描述 / 优先级 / 分类 / 标签 / 截止与提醒 /
//! 重复规则 / 关联目标 / 关联 Agent 会话 / 关联剪贴板。
//!
//! 由任务列表页切换进入，不再使用 `modal-mask` + Dialog：不新开窗口、不铺全局遮罩，
//! 编辑区与列表共用内容区的单一滚动容器（`.tab-content`）。
//! 返回列表时由 `TasksPanel` 恢复列表滚动位置；筛选状态存放在 `useTasksStore`，不丢失。
//! 未保存返回先在页内确认条上确认，保存失败保留全部表单内容。
//!
//! 关联目标选择器（`AppPicker`）复用其页内子视图（`variant="page"`）：替换编辑区内容、
//! 保留编辑草稿，选择或返回后回到原编辑上下文，不再叠一层弹窗。

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, ArrowUp, ArrowDown, Trash2, Link2, Unlink, AppWindow, Star, ClipboardList, Layers,
  AlarmClock, Loader2,
} from "lucide-react";
import {
  clipboardTaskLinks,
  clipboardUnlinkTask,
  listTaskLinks,
  linkTaskAgent,
  snoozeReminder,
  unlinkTaskAgent,
  type ClipboardTaskLink,
  type RecurrenceRuleInput,
  type Task,
  type TaskInput,
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
import { describeRecurrence, formatDue, fromLocalInputValue, toLocalInputValue } from "../../lib/format";
import { errorMessage } from "../../lib/errors";
import { useTabGuard } from "../../lib/tabGuard";
import AppPicker from "../navigation/AppPicker";
import { TargetAvatar } from "../navigation/TargetMenu";
import { DateTimePicker, NumberInput, Select } from "../ui";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const MONTHLY_NTH_LABELS = ["一", "二", "三", "四", "五"];

/** 每月模式：按日 / 第 N 个星期X / 最后一个星期X / 最后一个工作日 */
type MonthlyMode = "day" | "nth" | "lastWeekday" | "lastWorkday";

function isMonToFri(days: number[]): boolean {
  return days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
}

function recurrenceKey(rule: RecurrenceRuleInput | null): string {
  if (!rule) return "";
  return JSON.stringify({
    freq: rule.freq,
    interval: rule.interval,
    by_weekday: rule.freq === "weekly" || rule.by_setpos != null ? [...rule.by_weekday].sort((a, b) => a - b) : [],
    by_monthday: rule.freq === "monthly" && rule.by_setpos == null ? rule.by_monthday : null,
    by_setpos: rule.freq === "monthly" ? rule.by_setpos ?? null : null,
  });
}

const BEHAVIOR_LABELS: Record<string, string> = {
  default: "按偏好",
  focus_or_launch: "优先唤醒",
  launch: "总是启动",
  resume_session: "恢复会话",
  open: "打开",
};

const PRIORITY_OPTIONS = [
  { value: "0", label: "P0 紧急" },
  { value: "1", label: "P1 高" },
  { value: "2", label: "P2 中" },
  { value: "3", label: "P3 低" },
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface TaskEditorViewProps {
  /** 编辑的既有任务；null = 新建。 */
  task: Task | null;
  /** 返回列表（取消、保存成功或删除成功后由调用方收起编辑态）。 */
  onClose: () => void;
}

export default function TaskEditorView({ task, onClose }: TaskEditorViewProps) {
  const create = useTasksStore((s) => s.create);
  const update = useTasksStore((s) => s.update);
  const remove = useTasksStore((s) => s.remove);
  const refreshTasks = useTasksStore((s) => s.refresh);
  const agents = useAgentsStore((s) => s.snapshot);
  const refreshNavLinks = useNavigationStore((s) => s.loadTaskLinks);
  const showToast = useUiStore((s) => s.showToast);
  const openClipboard = useUiStore((s) => s.openClipboard);
  const openContext = useUiStore((s) => s.openContext);
  const clipboardLinkVersion = useUiStore((s) => s.clipboardLinkVersion);

  const isCreate = task === null;
  const initial = {
    title: task?.title ?? "",
    description: task?.description ?? "",
    priority: task?.priority ?? 2,
    category: task?.category ?? "",
    tagsText: (task?.tags ?? []).join(", "),
    due: toLocalInputValue(task?.due_at),
    remind: toLocalInputValue(task?.remind_at),
    advance: task?.advance_minutes ?? 0,
    recurrence: recurrenceKey(task?.recurrence ?? null),
  };

  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [priority, setPriority] = useState(initial.priority);
  const [category, setCategory] = useState(initial.category);
  const [tagsText, setTagsText] = useState(initial.tagsText);
  const [due, setDue] = useState(initial.due);
  const [remind, setRemind] = useState(initial.remind);
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
  const [advance, setAdvance] = useState(initial.advance);
  // 重复规则草稿：编辑器每次打开都重新挂载，直接从任务数据初始化一次（不做后续覆盖，
  // 否则首次渲染会先闪一下"未保存"）。
  const rule = task?.recurrence;
  const initialMonthlyMode: MonthlyMode = (() => {
    if (!rule || rule.freq !== "monthly" || rule.by_setpos == null || rule.by_weekday.length === 0) {
      return "day";
    }
    if (rule.by_setpos === -1) return isMonToFri(rule.by_weekday) ? "lastWorkday" : "lastWeekday";
    return "nth";
  })();
  const advancedRule = Boolean(
    (rule?.freq === "monthly" && rule.by_setpos != null) ||
      (rule && rule.interval > 1) ||
      (rule?.freq === "weekly" && !isMonToFri(rule.by_weekday) && (rule.by_weekday.length === 0 || rule.by_weekday.length > 1)),
  );
  const [freq, setFreq] = useState<"" | "daily" | "weekly" | "monthly">(
    rule ? (rule.freq as "daily" | "weekly" | "monthly") : "",
  );
  const [interval, setIntervalValue] = useState(rule?.interval ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(rule?.by_weekday ?? []);
  const [monthday, setMonthday] = useState(rule?.by_monthday ?? 1);
  /** 每月高级模式（渐进展开：默认按日） */
  const [monthlyMode, setMonthlyMode] = useState<MonthlyMode>(initialMonthlyMode);
  const [nthPos, setNthPos] = useState(
    Math.min(5, Math.max(1, rule?.by_setpos != null && rule.by_setpos > 0 ? rule.by_setpos : 1)),
  );
  const [nthWeekday, setNthWeekday] = useState(rule?.by_weekday[0] ?? 1);
  /** 自定义区（间隔 / 周几 / 高级每月）渐进展开，默认收起只显示常用项 */
  const [customOpen, setCustomOpen] = useState(advancedRule);
  const [ruleError, setRuleError] = useState("");
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [links, setLinks] = useState<Awaited<ReturnType<typeof listTaskLinks>>>([]);
  const [linkSession, setLinkSession] = useState("");
  const [navLinks, setNavLinks] = useState<TaskNavLink[]>([]);
  /** 关联读取失败 ≠ 没有关联：读取失败时给出可见提示与重试，不伪装成空列表 */
  const [navError, setNavError] = useState<string | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLink, setPickerLink] = useState<TaskNavLink | null>(null);
  const [clipLinks, setClipLinks] = useState<ClipboardTaskLink[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 有未保存修改时，返回入口先在页内确认条上确认，不弹模态。 */
  const [leaveGuard, setLeaveGuard] = useState(false);

  // 同步防重入：状态更新到下一次渲染之间，连点保存不能触发第二次请求。
  const busyRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 关联目标 / Agent 会话：打开编辑态时读取一次；卸载后到达的响应直接丢弃
  useEffect(() => {
    if (!task) {
      setLinks([]);
      setNavLinks([]);
      setNavError(null);
      setClipError(null);
      return;
    }
    let alive = true;
    listTaskLinks(task.id)
      .then((next) => {
        if (alive) setLinks(next);
      })
      .catch(() => {
        // Agent 会话关联失败不阻塞编辑；下方目标/剪贴板区仍可用
        if (alive) setLinks([]);
      });
    navTaskTargets(task.id)
      .then((next) => {
        if (alive) {
          setNavLinks(next);
          setNavError(null);
        }
      })
      .catch((e) => {
        // 读取失败不能当成「没有关联」：保留旧列表并给出可见错误
        if (alive) setNavError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [task]);

  // 应用选择器关闭后（可能在其中完成了关联）：重读本任务关联列表
  useEffect(() => {
    if (!pickerOpen && task) {
      let alive = true;
      navTaskTargets(task.id)
        .then((next) => {
          if (alive) {
            setNavLinks(next);
            setNavError(null);
          }
        })
        .catch((e) => {
          if (alive) setNavError(errorMessage(e));
        });
      return () => {
        alive = false;
      };
    }
  }, [pickerOpen, task]);

  // 剪贴板关联（手动；抽屉关联后通过版本号触发重读）
  useEffect(() => {
    if (!task) {
      setClipLinks([]);
      return;
    }
    let alive = true;
    clipboardTaskLinks(task.id)
      .then((next) => {
        if (alive) {
          setClipLinks(next ?? []);
          setClipError(null);
        }
      })
      .catch((e) => {
        // 剪贴板关联读取失败：旧列表保留，明确提示可能不是最新
        if (alive) setClipError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [task, clipboardLinkVersion]);

  /** 由编辑器状态组装规则草稿（非法组合先在此拦截，后端仍会兜底校验）。 */
  const recurrence: RecurrenceRuleInput | null = (() => {
    if (!freq) return null;
    if (freq === "weekly") {
      return {
        freq,
        interval,
        by_weekday: weekdays.length > 0 ? [...weekdays].sort((a, b) => a - b) : [1],
        by_monthday: null,
        by_setpos: null,
      };
    }
    if (freq === "monthly" && monthlyMode === "nth") {
      return {
        freq,
        interval,
        by_weekday: [nthWeekday],
        by_monthday: null,
        by_setpos: nthPos,
      };
    }
    if (freq === "monthly" && monthlyMode === "lastWeekday") {
      return {
        freq,
        interval,
        by_weekday: [nthWeekday],
        by_monthday: null,
        by_setpos: -1,
      };
    }
    if (freq === "monthly" && monthlyMode === "lastWorkday") {
      return {
        freq,
        interval,
        by_weekday: [1, 2, 3, 4, 5],
        by_monthday: null,
        by_setpos: -1,
      };
    }
    return {
      freq,
      interval,
      by_weekday: [],
      by_monthday: freq === "monthly" ? monthday : null,
      by_setpos: null,
    };
  })();

  const recurrenceDirty = recurrenceKey(recurrence) !== initial.recurrence;
  const dirty =
    title !== initial.title ||
    description !== initial.description ||
    priority !== initial.priority ||
    category !== initial.category ||
    tagsText !== initial.tagsText ||
    advance !== initial.advance ||
    (dueTouched && due !== initial.due) ||
    (remindTouched && remind !== initial.remind) ||
    recurrenceDirty;

  // 跨主 Tab 切换统一走 store 门禁：脏时先确认，保存中拒绝切换；放弃时关闭本编辑态。
  useTabGuard({
    id: "task-editor",
    label: isCreate ? "新建任务" : `编辑任务「${task?.title ?? ""}」`,
    dirty,
    busy,
    discard: onClose,
  });

  /** 返回列表：有未保存修改时先出页内确认条，不弹大窗。 */
  function requestLeave() {
    if (busyRef.current) return;
    if (leaveGuard) {
      setLeaveGuard(false);
      return;
    }
    if (dirty) {
      setLeaveGuard(true);
      return;
    }
    onClose();
  }

  function discardAndLeave() {
    if (busyRef.current) return;
    setLeaveGuard(false);
    onClose();
  }

  // Escape：日期/下拉弹层先由弹层栈消费（注册更早）；没有弹层时才回到列表。
  // preventDefault 阻止冒泡阶段的窗口级「隐藏到托盘」。
  const escapeRef = useRef(requestLeave);
  escapeRef.current = () => {
    // 页内选择器是最上层，Escape 先返回编辑区，不影响任务草稿。
    if (pickerOpen) {
      setPickerOpen(false);
      setPickerLink(null);
      return;
    }
    requestLeave();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      escapeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /** 前端严格校验：与后端 validate_rule 同口径，错误就地提示不发请求。 */
  function validateRecurrence(): string {
    if (!recurrence) return "";
    if (!(recurrence.interval >= 1 && recurrence.interval <= 30)) return "重复间隔需在 1-30 之间";
    if (recurrence.freq === "weekly" && recurrence.by_weekday.length === 0) return "请至少选择一个重复日";
    if (
      recurrence.freq === "monthly" &&
      recurrence.by_monthday != null &&
      !(recurrence.by_monthday >= 1 && recurrence.by_monthday <= 31)
    ) {
      return "每月几日需在 1-31 之间";
    }
    if (
      recurrence.by_setpos != null &&
      !(recurrence.by_setpos === -1 || (recurrence.by_setpos >= 1 && recurrence.by_setpos <= 5))
    ) {
      return "「第 N 个星期X」的 N 需在 1-5 之间";
    }
    return "";
  }

  /** 规则中文预览：规则 + 时刻（如「每 2 个月第二个周一 09:00」）。 */
  const rulePreview = (() => {
    if (!recurrence) return "";
    const time = due ? due.split("T")[1] : "";
    return time ? `${describeRecurrence(recurrence)} ${time}` : describeRecurrence(recurrence);
  })();

  async function reloadNav() {
    if (!task) return;
    try {
      const next = await navTaskTargets(task.id);
      if (aliveRef.current) {
        setNavLinks(next);
        setNavError(null);
      }
    } catch (e) {
      // 写入可能已成功；刷新失败保留旧列表并标注可能过期
      if (aliveRef.current) setNavError(errorMessage(e));
    }
    await refreshNavLinks();
  }

  async function onNavDefault(id: string) {
    try {
      await navUpdateTaskLink(id, { isDefault: true });
      await reloadNav();
    } catch (e) {
      showToast(errText(e), { kind: "error" });
    }
  }

  async function onNavBehavior(id: string, behavior: string) {
    try {
      await navUpdateTaskLink(id, { launchBehavior: behavior });
      await reloadNav();
    } catch (e) {
      showToast(errText(e), { kind: "error" });
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
      showToast(errText(e), { kind: "error" });
    }
  }

  async function onNavRemove(id: string) {
    try {
      await navUnlinkTask(id);
      await reloadNav();
      await refreshTasks();
    } catch (e) {
      showToast(errText(e), { kind: "error" });
    }
  }

  async function onSave() {
    if (busyRef.current) return;
    if (!title.trim()) {
      setError("标题不能为空");
      return;
    }
    const ruleErr = validateRecurrence();
    if (ruleErr) {
      setRuleError(ruleErr);
      return;
    }
    setRuleError("");
    setError(null);
    const input: TaskInput = {
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
      ...(isCreate || recurrenceDirty ? { recurrence } : {}),
      // 未改动 → 不提交该键（后端保持原值）；改动过 → 提交（null 表示清空）
      ...(dueTouched && due !== initial.due ? { due_at: fromLocalInputValue(due) } : {}),
      ...(remindTouched && remind !== initial.remind ? { remind_at: fromLocalInputValue(remind) } : {}),
    };
    busyRef.current = true;
    setBusy(true);
    try {
      if (task) await update(task.id, input);
      else await create(input);
      // 卸载（如切换页面）后到达的响应不再回调，避免无效更新
      if (aliveRef.current) onClose();
    } catch (e) {
      // 保存失败：保留表单内容，就地显示错误
      if (aliveRef.current) setError(errText(e));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }

  /** 任务详情内的延后：走真实后端；成功反馈由 reminder-snoozed 事件统一弹（含撤销）。 */
  async function onSnoozeDetail(minutes: number) {
    if (!task || snoozeBusy) return;
    setSnoozeBusy(true);
    try {
      await snoozeReminder(task.id, minutes);
      await refreshTasks();
    } catch (e) {
      showToast(`延后失败：${errText(e)}`, { kind: "error" });
    } finally {
      if (aliveRef.current) setSnoozeBusy(false);
    }
  }

  async function onDelete() {
    if (!task || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await remove(task.id);
      if (aliveRef.current) onClose();
    } catch (e) {
      if (aliveRef.current) setError(errText(e));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }

  async function onLink() {
    if (!task || !linkSession) return;
    const [sourceId, sessionId] = linkSession.split("::");
    try {
      await linkTaskAgent(task.id, sourceId, sessionId);
      const next = await listTaskLinks(task.id);
      if (aliveRef.current) {
        setLinks(next);
        setLinkSession("");
      }
      await refreshTasks();
    } catch (e) {
      showToast(errText(e));
    }
  }

  async function onUnlink(id: string) {
    if (!task) return;
    try {
      await unlinkTaskAgent(id);
      const next = await listTaskLinks(task.id);
      if (aliveRef.current) setLinks(next);
      await refreshTasks();
    } catch (e) {
      showToast(errText(e));
    }
  }

  async function onClipUnlink(id: string) {
    if (!task) return;
    try {
      await clipboardUnlinkTask(id);
      const next = (await clipboardTaskLinks(task.id)) ?? [];
      if (aliveRef.current) setClipLinks(next);
    } catch (e) {
      showToast(`取消关联失败：${errText(e)}`, { kind: "error" });
    }
  }

  const sessions = (agents?.sessions ?? []).slice(0, 50);

  // 关联目标选择是同一内容区的子视图：编辑器保持挂载，草稿不会因选择而丢失。
  if (pickerOpen && task) {
    return (
      <div className="task-editor task-editor-picker">
        <AppPicker
          variant="page"
          windowLink={pickerLink}
          taskId={task.id}
          onClose={() => {
            setPickerOpen(false);
            setPickerLink(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="task-editor">
      <header className="task-editor-head">
        <button
          type="button"
          className="icon-btn sm"
          aria-label="返回任务列表"
          data-tip="返回列表"
          onClick={requestLeave}
          disabled={busy}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <div className="task-editor-head-main">
          <h2 className="task-editor-title">{isCreate ? "新建任务" : "编辑任务"}</h2>
          <p className="task-editor-subtitle">
            {isCreate ? "填写任务信息，保存后回到列表。" : "修改任务信息，保存后回到列表。"}
          </p>
        </div>
        {dirty ? (
          <span className="task-editor-unsaved" role="status">
            未保存
          </span>
        ) : null}
      </header>

      {leaveGuard ? (
        <div className="task-editor-leave-guard" role="alert">
          <span>有未保存的修改，返回列表会丢失这些修改。</span>
          <div className="task-editor-leave-guard-actions">
            <button type="button" className="btn sm" onClick={() => setLeaveGuard(false)}>
              继续编辑
            </button>
            <button type="button" className="btn sm danger" onClick={discardAndLeave}>
              放弃修改
            </button>
          </div>
        </div>
      ) : null}

      <div className="task-editor-body">
        <label className="field">
          <span>标题</span>
          <input
            value={title}
            autoFocus={isCreate}
            onChange={(e) => setTitle(e.target.value)}
            data-autofocus
          />
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
              options={PRIORITY_OPTIONS}
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
        <div className="field-row field-row-datetime">
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
          <label className="field" data-tip="独立提醒时间：可与截止时间不同，留空表示不单独提醒">
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

        {/* 延后提醒（任务详情入口）：只对有待触发提醒的未完成任务显示，展示真实下次通知时间 */}
        {task && task.status === "pending" && task.next_remind_at && (
          <div className="field">
            <span>
              <AlarmClock size={12} /> 下次提醒
            </span>
            <div className="link-row">
              <span className="endpoint-hint">{formatDue(task.next_remind_at)}（延后只移动提醒，不改截止时间）</span>
              {[
                { m: 5, label: "5 分钟" },
                { m: 10, label: "10 分钟" },
                { m: 30, label: "30 分钟" },
                { m: 60, label: "1 小时" },
              ].map((o) => (
                <button
                  key={o.m}
                  className="btn sm"
                  disabled={snoozeBusy}
                  onClick={() => void onSnoozeDetail(o.m)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <span>重复</span>
          <div className="seg-group">
            <button className={`seg-btn ${freq === "" ? "active" : ""}`} onClick={() => setFreq("")}>
              不重复
            </button>
            <button className={`seg-btn ${freq === "daily" ? "active" : ""}`} onClick={() => setFreq("daily")}>
              每天
            </button>
            <button
              className={`seg-btn ${freq === "weekly" ? "active" : ""}`}
              onClick={() => {
                setFreq("weekly");
                // 默认给周一，避免空规则（后端空 by_weekday 不发生）
                if (weekdays.length === 0) setWeekdays([1]);
              }}
            >
              每周
            </button>
            <button className={`seg-btn ${freq === "monthly" ? "active" : ""}`} onClick={() => setFreq("monthly")}>
              每月
            </button>
            <button
              className={`seg-btn ${freq === "weekly" && isMonToFri(weekdays) && interval === 1 ? "active" : ""}`}
              data-tip="周一至周五（自然周工作日，不含法定节假日调整）"
              onClick={() => {
                setFreq("weekly");
                setWeekdays([1, 2, 3, 4, 5]);
                setIntervalValue(1);
              }}
            >
              工作日
            </button>
            <button
              className={`seg-btn ${customOpen ? "active" : ""}`}
              aria-expanded={customOpen}
              onClick={() => setCustomOpen((v) => !v)}
            >
              自定义…
            </button>
          </div>
        </div>
        {customOpen && freq === "weekly" && (
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
        {customOpen && freq === "monthly" && (
          <div className="field">
            <span>每月规则</span>
            <div className="seg-group">
              <button
                className={`seg-btn ${monthlyMode === "day" ? "active" : ""}`}
                onClick={() => setMonthlyMode("day")}
              >
                指定日
              </button>
              <button
                className={`seg-btn ${monthlyMode === "nth" ? "active" : ""}`}
                onClick={() => setMonthlyMode("nth")}
              >
                第 N 个星期X
              </button>
              <button
                className={`seg-btn ${monthlyMode === "lastWeekday" ? "active" : ""}`}
                onClick={() => setMonthlyMode("lastWeekday")}
              >
                最后一个星期X
              </button>
              <button
                className={`seg-btn ${monthlyMode === "lastWorkday" ? "active" : ""}`}
                data-tip="自然周工作日（周一至周五），不支持法定节假日/调休"
                onClick={() => setMonthlyMode("lastWorkday")}
              >
                最后一个工作日
              </button>
            </div>
          </div>
        )}
        {customOpen && freq === "monthly" && monthlyMode === "day" && (
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
        {customOpen && freq === "monthly" && monthlyMode === "nth" && (
          <div className="field-row">
            <label className="field">
              <span>第几个</span>
              <Select
                ariaLabel="第几个"
                size="sm"
                value={String(nthPos)}
                options={MONTHLY_NTH_LABELS.map((l, i) => ({ value: String(i + 1), label: `第${l}` }))}
                onChange={(v) => setNthPos(Number(v))}
              />
            </label>
            <label className="field">
              <span>星期</span>
              <Select
                ariaLabel="星期几"
                size="sm"
                value={String(nthWeekday)}
                options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: `周${d}` }))}
                onChange={(v) => setNthWeekday(Number(v))}
              />
            </label>
          </div>
        )}
        {customOpen && freq === "monthly" && monthlyMode === "lastWeekday" && (
          <label className="field">
            <span>星期</span>
            <Select
              ariaLabel="最后一个星期几"
              size="sm"
              value={String(nthWeekday)}
              options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: `周${d}` }))}
              onChange={(v) => setNthWeekday(Number(v))}
            />
          </label>
        )}
        {customOpen && freq && (
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
        {recurrence && <div className="preview-matched">规则：{rulePreview}</div>}
        {ruleError && (
          <div className="preview-hint error" role="alert">
            {ruleError}
          </div>
        )}

        {task && (
          <div className="field">
            <span>
              <AppWindow size={12} /> 关联目标（软件 / 网址 / 文件 / 目录 / Agent 会话）
            </span>
            <div className="link-row">
              <button
                className="btn sm"
                onClick={() => {
                  setPickerLink(null);
                  setPickerOpen(true);
                }}
              >
                <AppWindow size={12} /> 添加目标…
              </button>
              {navLinks.length >= 2 && (
                <span className="endpoint-hint">多个目标可在任务卡「打开工作区」一键启动</span>
              )}
            </div>
            {navError && (
              <div className="empty-hint error-text" role="status">
                关联目标读取失败：{navError}
                {navLinks.length > 0 ? "（当前显示上次结果，可能不是最新）" : ""}
                <button className="btn sm" onClick={() => void reloadNav()}>
                  重试
                </button>
              </div>
            )}
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
                      <Star size={11} fill={l.is_default ? "currentColor" : "none"} />
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
                      <button
                        className="btn sm"
                        onClick={() => {
                          setPickerLink(l);
                          setPickerOpen(true);
                        }}
                      >
                        {l.window_identity ? "重新选择窗口" : "选择窗口"}
                      </button>
                      {l.window_identity && (
                        <button
                          className="btn sm"
                          onClick={async () => {
                            try {
                              await navForgetTaskWindow(l.id);
                              await reloadNav();
                            } catch (e) {
                              showToast(errText(e), { kind: "error" });
                            }
                          }}
                        >
                          清除窗口
                        </button>
                      )}
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
                            try {
                              await navSetTaskWindowFallback(l.id, v);
                              await reloadNav();
                            } catch (err) {
                              showToast(errText(err), { kind: "error" });
                            }
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
                <button
                  className="icon-btn sm"
                  onClick={() => onUnlink(l.id)}
                  data-tip="取消关联"
                  aria-label={`取消关联 ${l.session_external_id}`}
                >
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
            {clipError && (
              <div className="empty-hint error-text" role="status">
                关联剪贴板读取失败：{clipError}
                {clipLinks.length > 0 ? "（当前显示上次结果，可能不是最新）" : ""}
              </div>
            )}
            {clipLinks.map((l) => (
              <div key={l.id} className="link-item">
                <span title={l.label}>
                  {l.target_type === "group" ? "分组" : kindLabel(l.kind)} · {l.label || l.target_id}
                </span>
                <button
                  className="icon-btn sm"
                  onClick={() => onClipUnlink(l.id)}
                  data-tip="取消剪贴板关联（不删除内容）"
                  aria-label="取消剪贴板关联"
                >
                  <Unlink size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {error ? (
          <p className="task-editor-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="task-editor-actions">
        {task && task.status !== "completed" && (
          <button className="btn danger" onClick={onDelete} disabled={busy}>
            <Trash2 size={13} /> 删除
          </button>
        )}
        {task && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              onClose();
              openContext(task);
            }}
            title="查看现场 / Agent / 关联目标 / 剪贴板 / 动作"
          >
            <Layers size={13} /> 上下文
          </button>
        )}
        <div className="flex-spacer" />
        <button className="btn" onClick={requestLeave} disabled={busy}>
          取消
        </button>
        <button className="btn primary" onClick={() => void onSave()} disabled={busy}>
          {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
          保存
        </button>
      </div>

    </div>
  );
}
