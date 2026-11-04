//! 下一条提醒微件：复用任务提醒调度读接口与 reminder 事件，不新建后台提醒系统。
//! 倒计时只在「确实存在提醒」时订阅共享时钟，空态不产生每秒刷新。

import { useCallback, useEffect, useRef, useState } from "react";
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
import { useLocale } from "../../hooks/useLocale";
import { openFullApp } from "../capsule/actions";

function Countdown({ remindAt }: { remindAt: string }) {
  const { t } = useLocale();
  const now = useSharedClock();
  const remaining = remainingMs(remindAt, now);
  if (remaining === null) return null;
  if (remaining <= 0) {
    return <span className="widget-countdown expired">{t("activeReminders.expired")}</span>;
  }
  return <span className="widget-countdown">{formatCountdown(remaining)}</span>;
}

function pickNext(items: ActiveReminder[]): ActiveReminder | null {
  let best: ActiveReminder | null = null;
  let bestMs = Infinity;
  for (const item of items) {
    const at = new Date(item.remindAt).getTime();
    if (!Number.isFinite(at)) continue;
    if (at < bestMs) {
      best = item;
      bestMs = at;
    }
  }
  return best;
}

export default function NextReminderWidget() {
  const { t } = useLocale();
  const [items, setItems] = useState<ActiveReminder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 只认最后一次请求：挂载读取与提醒事件刷新可能并发，旧响应不得覆盖新结果。
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    activeReminders()
      .then((next) => {
        if (seq !== loadSeq.current) return;
        setItems(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        // 保留上一次成功数据；错误单独展示，避免把失败伪装成「无提醒」。
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    load();
    const scope = createSubscriptionScope();
    scope.add(onReminderFired(() => load()));
    scope.add(onReminderSnoozed(() => load()));
    return () => {
      // 卸载后让在途响应失效，避免对已卸载组件写入状态。
      loadSeq.current += 1;
      scope.dispose();
    };
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
              <Clock3 size={11} aria-hidden="true" />{" "}
              {t("widgets.nextReminder.expected", { time: formatHM(new Date(next.remindAt)) })}
            </span>
            {next.snoozed && (
              <span className="widget-chip muted">{t("widgets.nextReminder.snoozed")}</span>
            )}
            {next.hasRecurrence && (
              <span className="widget-chip muted">{t("widgets.nextReminder.recurring")}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="widget-empty">
          <Timer size={20} aria-hidden="true" />
          <span>
            {items === null && !error
              ? t("widgets.nextReminder.loading")
              : error
                ? t("widgets.nextReminder.failed")
                : t("widgets.nextReminder.empty")}
          </span>
        </div>
      )}

      {error && (
        <div className="widget-status-line">
          <span className="widget-warn" data-tip={error}>
            {t("widgets.nextReminder.failed")}
          </span>
          <button
            className="widget-link"
            onClick={load}
            aria-label={t("widgets.nextReminder.retryAria")}
          >
            <RefreshCw size={11} aria-hidden="true" /> {t("widgets.nextReminder.retry")}
          </button>
        </div>
      )}

      <div className="widget-foot">
        <button className="widget-link" onClick={() => openFullApp("tasks")}>
          {t("widgets.nextReminder.manage")}
        </button>
      </div>
    </div>
  );
}
