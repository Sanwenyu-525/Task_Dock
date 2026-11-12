//! 进行中的提醒（倒计时面板）：智能日程提醒 2.0。
//!
//! - 数据源 `active_reminders`（未触发提醒 + 任务信息），只在挂载、
//!   reminder-fired / reminder-snoozed 事件与本地操作后拉取，无轮询；
//! - 倒计时用页面级共享时钟（useSharedClock）+ 绝对时间换算，
//!   不每卡片一个 setInterval、不缓存剩余秒数；
//! - 状态：计时中 / 已到期（调度器 1s 内领取）/ 已延后（chip 标注）；
//!   取消只对非重复任务开放（重复任务的 due 提醒是推进引擎输入）；
//! - 延后走真实后端 snooze_reminder，反馈 Toast（含撤销）由 App 的
//!   reminder-snoozed 统一处理，本组件不重复弹。
//!
//! 任务页默认只显示单行摘要（标题 + 条数 + 最近倒计时），展开后才渲染条目：
//! 提醒调度在后端，折叠状态不影响任何到期触发。

import { useCallback, useEffect, useId, useState } from "react";
import { AlarmClock, BellOff, ChevronDown, Clock3, Timer, X } from "lucide-react";
import {
  activeReminders,
  cancelReminders,
  onReminderFired,
  onReminderSnoozed,
  snoozeReminder,
  type ActiveReminder,
} from "../../lib/bridge";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { useSharedClock } from "../../lib/sharedClock";
import { formatCountdown, formatDue } from "../../lib/format";
import { useUiStore } from "../../store/useUiStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useFullViewVisible } from "../../hooks/useMainUiVisible";
import { DropdownMenu } from "../ui";
import { useLocale } from "../../hooks/useLocale";
import { localizedErrorMessage } from "../../i18n/errors";

const SNOOZE_MINUTES = [5, 10, 30, 60];

/**
 * 倒计时行：只消费父级传入的 `now`，自身不订阅时钟。
 *
 * 容器在「可见且有数据」时才渲染内部视图，内部视图是共享时钟的唯一订阅点：
 * 停靠/切换模式导致整体不可见时，视图卸载 → 最后一个消费者退出 → 共享
 * 定时器释放，不为隐藏页面每秒空转。恢复可见时重新订阅，时钟首订阅者会
 * 重新对齐当前时间，倒计时不会滞后。
 */
function ReminderRows({
  items,
  now,
  busyTaskId,
  onSnooze,
  onCancel,
}: {
  items: ActiveReminder[];
  now: number;
  busyTaskId: string | null;
  onSnooze: (item: ActiveReminder, minutes: number) => void;
  onCancel: (item: ActiveReminder) => void;
}) {
  const { t } = useLocale();

  return (
    <>
      {items.map((item) => {
        const remindMs = new Date(item.remindAt).getTime();
        const expired = Number.isFinite(remindMs) ? remindMs <= now : false;
        const remaining = Number.isFinite(remindMs) ? remindMs - now : 0;
        const busy = busyTaskId === item.taskId;
        return (
          <div
            key={item.reminderId}
            className={`active-reminder-card ${expired ? "expired" : ""}`}
          >
            <span className="reminder-countdown" aria-live="off">
              {expired ? t("activeReminders.expired") : formatCountdown(remaining)}
            </span>
            <div className="reminder-info">
              <span className="reminder-title" title={item.taskTitle}>
                {item.taskTitle}
              </span>
              <span className="reminder-meta">
                <Clock3 size={10} />{" "}
                {t("activeReminders.expected", { time: formatDue(item.remindAt) })} ·{" "}
                {item.kind === "advance"
                  ? t("activeReminders.kind.advance")
                  : item.kind === "custom"
                    ? t("activeReminders.kind.custom")
                    : t("activeReminders.kind.deadline")}
                {item.snoozed && (
                  <span className="chip reminder-snoozed-chip">{t("activeReminders.snoozed")}</span>
                )}
                {item.hasRecurrence && (
                  <span className="chip">{t("activeReminders.recurring")}</span>
                )}
              </span>
            </div>
            <DropdownMenu
              disabled={busy}
              trigger={({ ref, expanded, onClick, onKeyDown }) => (
                <button
                  ref={ref}
                  className="btn sm"
                  aria-expanded={expanded}
                  aria-haspopup="menu"
                  aria-label={t("activeReminders.snoozeAria", { title: item.taskTitle })}
                  disabled={busy}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                >
                  <AlarmClock size={12} /> {t("activeReminders.snooze")}
                </button>
              )}
              items={SNOOZE_MINUTES.map((minutes) => ({
                key: String(minutes),
                label: t("activeReminders.snoozeOption", {
                  label:
                    minutes >= 60
                      ? t("format.hours", { n: minutes / 60 })
                      : t("format.minutes", { n: minutes }),
                }),
                onSelect: () => onSnooze(item, minutes),
              }))}
              menuLabel={t("activeReminders.snoozeMenu")}
            />
            {!item.hasRecurrence && (
              <button
                className="icon-btn sm"
                data-tip={t("activeReminders.cancelTip")}
                aria-label={t("activeReminders.cancelAria", { title: item.taskTitle })}
                disabled={busy}
                onClick={() => onCancel(item)}
              >
                {busy ? <X size={12} className="spin" /> : <BellOff size={12} />}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * 可见且有数据时才挂载的提醒视图：共享时钟的唯一订阅点。
 * 折叠态只渲染摘要（同样需要 now 显示最近倒计时），因此时钟在两种
 * 展开状态下都只存在一份消费者。
 */
function ActiveRemindersView({
  items,
  expanded,
  onToggleExpanded,
  busyTaskId,
  onSnooze,
  onCancel,
}: {
  items: ActiveReminder[];
  expanded: boolean;
  onToggleExpanded: () => void;
  busyTaskId: string | null;
  onSnooze: (item: ActiveReminder, minutes: number) => void;
  onCancel: (item: ActiveReminder) => void;
}) {
  const { t } = useLocale();
  const now = useSharedClock();
  const rowsId = useId();

  // 摘要只展示最近一条（remindAt 最小）的倒计时；无效时间按「已到期」处理，
  // 与行内口径一致，避免出现 NaN 文案。
  const next = items.reduce((a, b) =>
    new Date(a.remindAt).getTime() <= new Date(b.remindAt).getTime() ? a : b,
  );
  const nextMs = new Date(next.remindAt).getTime();
  const nextExpired = !Number.isFinite(nextMs) || nextMs <= now;

  return (
    <div
      className={`active-reminders ${expanded ? "is-expanded" : "is-collapsed"}`}
      role="region"
      aria-label={t("activeReminders.region")}
    >
      <button
        type="button"
        className="active-reminders-summary"
        aria-expanded={expanded}
        aria-controls={rowsId}
        aria-label={
          expanded
            ? t("activeReminders.collapseSummary")
            : t("activeReminders.expandSummary")
        }
        onClick={onToggleExpanded}
      >
        <Timer size={12} aria-hidden="true" />
        <span className="active-reminders-summary-label">{t("activeReminders.title")}</span>
        <span className="active-reminders-summary-count">
          {t("activeReminders.count", { count: items.length })}
        </span>
        <span className="flex-spacer" />
        <span className="active-reminders-summary-next">
          {nextExpired ? t("activeReminders.expired") : formatCountdown(nextMs - now)}
        </span>
        <ChevronDown size={12} className="active-reminders-chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="active-reminders-rows" id={rowsId}>
          <ReminderRows
            items={items}
            now={now}
            busyTaskId={busyTaskId}
            onSnooze={onSnooze}
            onCancel={onCancel}
          />
        </div>
      )}
    </div>
  );
}

export interface ActiveRemindersProps {
  /**
   * 父级切到专注/统计子视图时置 true：组件**保持挂载**（保留已取回的 items
   * 与展开状态），但不渲染任何 DOM。这样返回列表时摘要行立即在位，
   * 列表高度不会因为提醒数据的异步回包再变一次，滚动位置才能精确恢复。
   */
  hidden?: boolean;
}

export default function ActiveReminders({ hidden = false }: ActiveRemindersProps = {}) {
  const { t } = useLocale();
  const [items, setItems] = useState<ActiveReminder[] | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  // 折叠状态放在容器：停靠/切模式期间视图卸载，恢复可见后仍保留用户的展开选择。
  const [expanded, setExpanded] = useState(false);
  const showToast = useUiStore((s) => s.showToast);
  const refreshTasks = useTasksStore((s) => s.refresh);
  // 页面活跃态：TasksPanel 常驻挂载（DeferredView 保活），停靠/模式切换时
  // 本组件不可见 —— 不渲染内部视图即不订阅共享时钟。
  // 数据事件订阅保留：reminder-fired/snoozed 仍会刷新 items，保证恢复可见
  // 时数据是新的；提醒「调度」在后端，与前端渲染无关，不受此影响。
  const visible = useFullViewVisible();

  const load = useCallback(() => {
    activeReminders()
      .then(setItems)
      .catch(() => {
        // 失败保留旧值（可能只是瞬时 IPC 抖动），不拿空列表冒充「无提醒」
      });
  }, []);

  useEffect(() => {
    load();
    // 事件驱动刷新：到期触发（行消失/换下一轮）与延后（时间变化）。
    // 这是本面板自己的数据源订阅，与 App 的任务刷新订阅各管各的数据。
    const scope = createSubscriptionScope();
    scope.add(onReminderFired(() => load()));
    scope.add(onReminderSnoozed(() => load()));
    return () => scope.dispose();
  }, [load]);

  async function onSnooze(item: ActiveReminder, minutes: number) {
    if (busyTaskId) return;
    setBusyTaskId(item.taskId);
    try {
      // 失败真实报错（后端会拒绝已完成/不存在任务）；成功反馈走
      // reminder-snoozed 事件的统一 Toast（含撤销），这里不重复弹。
      await snoozeReminder(item.taskId, minutes);
      load();
    } catch (e) {
      showToast(t("activeReminders.snoozeFailed", { error: localizedErrorMessage(e) }), {
        kind: "error",
      });
    } finally {
      setBusyTaskId(null);
    }
  }

  async function onCancel(item: ActiveReminder) {
    if (busyTaskId) return;
    setBusyTaskId(item.taskId);
    try {
      const n = await cancelReminders(item.taskId);
      showToast(t("activeReminders.cancelToast", { title: item.taskTitle, count: n }), {
        kind: "info",
      });
      await refreshTasks();
      load();
    } catch (e) {
      showToast(t("activeReminders.cancelFailed", { error: localizedErrorMessage(e) }), {
        kind: "error",
      });
    } finally {
      setBusyTaskId(null);
    }
  }

  if (hidden || !visible || items === null || items.length === 0) return null;

  return (
    <ActiveRemindersView
      items={items}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((v) => !v)}
      busyTaskId={busyTaskId}
      onSnooze={(item, minutes) => void onSnooze(item, minutes)}
      onCancel={(item) => void onCancel(item)}
    />
  );
}
