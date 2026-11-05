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

import { useCallback, useEffect, useState } from "react";
import { AlarmClock, BellOff, Clock3, Timer, X } from "lucide-react";
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
 * 倒计时行：共享时钟的唯一订阅点。
 *
 * 拆成子组件是为了让「页面隐藏 → 不渲染 → 不订阅」成立：容器挂载在
 * TasksPanel（DeferredView 保活），停靠/切换模式时整体不可见，若容器自身
 * 订阅时钟，共享定时器会为隐藏页面每秒空转。行组件只在可见时挂载 ——
 * 最后一个消费者退出即释放时钟（sharedClock 语义），恢复可见时重新订阅，
 * 时钟首订阅者会重新对齐当前时间，倒计时不会滞后。
 */
function ReminderRows({
  items,
  busyTaskId,
  onSnooze,
  onCancel,
}: {
  items: ActiveReminder[];
  busyTaskId: string | null;
  onSnooze: (item: ActiveReminder, minutes: number) => void;
  onCancel: (item: ActiveReminder) => void;
}) {
  const { t } = useLocale();
  const now = useSharedClock();

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

export default function ActiveReminders() {
  const { t } = useLocale();
  const [items, setItems] = useState<ActiveReminder[] | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const showToast = useUiStore((s) => s.showToast);
  const refreshTasks = useTasksStore((s) => s.refresh);
  // 页面活跃态：TasksPanel 常驻挂载（DeferredView 保活），停靠/模式切换时
  // 本组件不可见 —— 不渲染行组件即不订阅共享时钟（见 ReminderRows）。
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

  if (!visible || items === null || items.length === 0) return null;

  return (
    <div className="active-reminders" role="region" aria-label={t("activeReminders.region")}>
      <div className="active-reminders-head">
        <Timer size={12} />
        <span>{t("activeReminders.title")}</span>
        <span className="endpoint-hint">
          {t("activeReminders.count", { count: items.length })}
        </span>
      </div>
      <ReminderRows
        items={items}
        busyTaskId={busyTaskId}
        onSnooze={(item, minutes) => void onSnooze(item, minutes)}
        onCancel={(item) => void onCancel(item)}
      />
    </div>
  );
}
