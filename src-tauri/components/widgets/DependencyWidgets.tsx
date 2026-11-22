//! 依赖 A（专注计时）/ C（效率统计）的微件。
//!
//! 接口未注入时只显示「等待接入」，绝不显示假倒计时或假统计；
//! 也不在本文件复制 A/C 的查询与 SQL 逻辑。数据源契约见 lib/widgets/sources.ts。

import { AlertTriangle, BarChart3, Hourglass, PlugZap } from "lucide-react";

import type { EfficiencySource, FocusSource } from "../../lib/widgets/sources";
import { formatCountdown } from "../../lib/format";
import { useSharedClock } from "../../lib/sharedClock";
import { remainingMs } from "../../lib/widgets/selectors";
import { useLocale } from "../../hooks/useLocale";
import { useWidgetSource } from "./useWidgetSource";

function Unavailable({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="widget-unavailable">
      <PlugZap size={18} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{hint}</span>
    </div>
  );
}

function FocusCountdown({ endsAt }: { endsAt: string }) {
  const { t } = useLocale();
  const now = useSharedClock();
  const remaining = remainingMs(endsAt, now);
  if (remaining === null) return <span className="widget-countdown">{t("widgets.focusTimer.running")}</span>;
  if (remaining <= 0) {
    return <span className="widget-countdown expired">{t("widgets.focusTimer.ending")}</span>;
  }
  return <span className="widget-countdown">{formatCountdown(remaining)}</span>;
}

export function FocusTimerWidget({ source }: { source?: FocusSource }) {
  const { t } = useLocale();
  const snapshot = useWidgetSource(source);

  if (!source) {
    return (
      <Unavailable
        title={t("widgets.focusTimer.connectingTitle")}
        hint={t("widgets.focusTimer.connectingHint")}
      />
    );
  }

  if (!snapshot) {
    return (
      <div className="widget-empty">
        <Hourglass size={20} aria-hidden="true" />
        <span>{t("widgets.focusTimer.waiting")}</span>
      </div>
    );
  }

  const running = snapshot.phase === "focus" || snapshot.phase === "break";

  return (
    <div className="widget-focus">
      <div className="widget-focus-phase">
        <span className={`widget-state-dot state-${snapshot.phase}`} aria-hidden="true" />
        <span>
          {snapshot.label ||
            (running ? t("widgets.focusTimer.focusing") : t("widgets.focusTimer.idleLabel"))}
        </span>
      </div>

      {running ? (
        // 契约要求进行中提供 endsAt；万一缺失也只显示「进行中」，不退化成
        // 「未开始专注」这种错误状态。
        snapshot.endsAt ? (
          <FocusCountdown endsAt={snapshot.endsAt} />
        ) : (
          <span className="widget-countdown">{t("widgets.focusTimer.running")}</span>
        )
      ) : (
        <div className="widget-empty compact">
          <span>
            {snapshot.phase === "paused"
              ? t("widgets.focusTimer.paused")
              : t("widgets.focusTimer.idle")}
          </span>
        </div>
      )}

      {snapshot.cycle && (
        <div className="widget-status-line">
          <span className="widget-task-meta">
            {t("widgets.focusTimer.cycle", {
              index: snapshot.cycle.index,
              total: snapshot.cycle.total,
            })}
          </span>
        </div>
      )}
    </div>
  );
}

export function EfficiencyWidget({ source }: { source?: EfficiencySource }) {
  const { t } = useLocale();
  const snapshot = useWidgetSource(source);

  if (!source) {
    return (
      <Unavailable
        title={t("widgets.efficiency.connectingTitle")}
        hint={t("widgets.efficiency.connectingHint")}
      />
    );
  }

  if (!snapshot) {
    return (
      <div className="widget-empty">
        <BarChart3 size={20} aria-hidden="true" />
        <span>{t("widgets.efficiency.waiting")}</span>
      </div>
    );
  }

  const rate = snapshot.completionRate;
  const rounded = typeof rate === "number" ? Math.round(rate) : null;
  return (
    <div className="widget-efficiency">
      {rounded !== null && (
        <div className="widget-rate">
          <span className="widget-rate-value">{rounded}%</span>
          <span className="widget-task-meta">{t("widgets.efficiency.completionRate")}</span>
          <div
            className="widget-bar"
            role="img"
            aria-label={t("widgets.efficiency.completionRateAria", { percent: rounded })}
          >
            <span style={{ width: `${Math.min(100, Math.max(0, rate ?? 0))}%` }} />
          </div>
        </div>
      )}
      <ul className="widget-stat-grid">
        <li>
          <strong>{snapshot.completedToday}</strong>
          <span>{t("widgets.efficiency.completed")}</span>
        </li>
        <li>
          <strong>{snapshot.dueToday}</strong>
          <span>{t("widgets.efficiency.due")}</span>
        </li>
        <li>
          <strong>{snapshot.overdue}</strong>
          <span>{t("widgets.efficiency.overdue")}</span>
        </li>
        <li>
          <strong>{snapshot.pending}</strong>
          <span>{t("widgets.efficiency.pending")}</span>
        </li>
      </ul>
      {snapshot.stale && (
        // 刷新失败：保留上一次数字，明确标记可能过期，并提供重试入口。
        <div className="widget-status-line widget-stale" role="status">
          <span className="widget-stale-label">
            <AlertTriangle size={11} aria-hidden="true" />
            {t("widgets.efficiency.stale")}
          </span>
          {source?.retry && (
            <button type="button" className="widget-stale-retry" onClick={() => source.retry?.()}>
              {t("widgets.efficiency.retry")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
