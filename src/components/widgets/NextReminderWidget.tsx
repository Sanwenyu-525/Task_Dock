//! 下一条提醒微件：复用任务提醒调度读接口与 reminder 事件，不新建后台提醒系统。
//! 倒计时只在「确实存在提醒」时订阅共享时钟，空态不产生每秒刷新。

import { useCallback, useEffect, useState } from "react";
import { BellRing, Clock3, RefreshCw, Timer } from "lucide-react";

import {
  activeReminders,
  onReminderFired,
  onReminderSnoozed,
  type ActiveReminder,
} from "../../lib/bridge";
import { formatCountdown, formatHM } from "../../lib/format";
import { useSharedClock } from "../../lib/sharedClock";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { remainingMs } from "../../lib/widgets/selectors";
import { openFullApp } from "../capsule/actions";

function Countdown({ remindAt }: { remindAt: string }) {
  const now = useSharedClock();
  const remaining = remainingMs(remindAt, now);
  if (remaining === null) return null;
  if (remaining <= 0) return <span className="widget-countdown expired">即将触发</span>;
  return <span className="widget-countdown">{formatCountdown(remaining)}</span>;
}

function pickNext(items: ActiveReminder[]): ActiveReminder | null {
  let best: ActiveReminder | null = null;
  let bestMs = Infinity;
  for (const item of items) {
    const t = new Date(item.remindAt).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < bestMs) {
      best = item;
      bestMs = t;
    }
  }
  return best;
}

export default function NextReminderWidget() {
  const [items, setItems] = useState<ActiveReminder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    activeReminders()
      .then((next) => {
        setItems(next);
        setError(null);
      })
      .catch((e: unknown) => {
        // 保留上一次成功数据；错误单独展示，避免把失败伪装成「无提醒」。
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    load();
    const scope = createSubscriptionScope();
    scope.add(onReminderFired(() => load()));
    scope.add(onReminderSnoozed(() => load()));
    return () => scope.dispose();
  }, [load]);

  const next = items ? pickNext(items) : null;

  return (
    <div className="widget-reminder">
      {next ? (
        <div className="widget-reminder-main">
          <div className="widget-reminder-head">
            <BellRing size={14} aria-hidden="true" />
            <span className="widget-task-title">{next.taskTitle}</span>
          </div>
          <div className="widget-reminder-meta">
            <Countdown remindAt={next.remindAt} />
            <span>
              <Clock3 size={11} aria-hidden="true" /> 预计 {formatHM(new Date(next.remindAt))}
            </span>
            {next.snoozed && <span className="widget-chip muted">已延后</span>}
            {next.hasRecurrence && <span className="widget-chip muted">重复任务</span>}
          </div>
        </div>
      ) : (
        <div className="widget-empty">
          <Timer size={20} aria-hidden="true" />
          <span>
            {items === null && !error
              ? "读取中…"
              : error
                ? "提醒读取失败"
                : "暂无进行中的提醒"}
          </span>
        </div>
      )}

      {error && (
        <div className="widget-status-line">
          <span className="widget-warn" data-tip={error}>
            提醒读取失败
          </span>
          <button className="widget-link" onClick={load} aria-label="重试读取提醒">
            <RefreshCw size={11} aria-hidden="true" /> 重试
          </button>
        </div>
      )}

      <div className="widget-foot">
        <button className="widget-link" onClick={() => openFullApp("tasks")}>
          管理提醒
        </button>
      </div>
    </div>
  );
}
