//! 依赖 A（专注计时）/ C（效率统计）的微件。
//!
//! 接口未注入时只显示「等待接入」，绝不显示假倒计时或假统计；
//! 也不在本文件复制 A/C 的查询与 SQL 逻辑。数据源契约见 lib/widgets/sources.ts。

import { BarChart3, Hourglass, PlugZap } from "lucide-react";

import type { EfficiencySource, FocusSource } from "../../lib/widgets/sources";
import { formatCountdown } from "../../lib/format";
import { useSharedClock } from "../../lib/sharedClock";
import { remainingMs } from "../../lib/widgets/selectors";
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
  const now = useSharedClock();
  const remaining = remainingMs(endsAt, now);
  if (remaining === null) return <span className="widget-countdown">进行中</span>;
  if (remaining <= 0) return <span className="widget-countdown expired">即将结束</span>;
  return <span className="widget-countdown">{formatCountdown(remaining)}</span>;
}

export function FocusTimerWidget({ source }: { source?: FocusSource }) {
  const snapshot = useWidgetSource(source);

  if (!source) {
    return (
      <Unavailable
        title="专注倒计时未接入"
        hint="等待专注计时模块提供快照后自动显示，不伪造倒计时。"
      />
    );
  }

  if (!snapshot) {
    return (
      <div className="widget-empty">
        <Hourglass size={20} aria-hidden="true" />
        <span>等待专注模块数据…</span>
      </div>
    );
  }

  const running = snapshot.phase === "focus" || snapshot.phase === "break";

  return (
    <div className="widget-focus">
      <div className="widget-focus-phase">
        <span className={`widget-state-dot state-${snapshot.phase}`} aria-hidden="true" />
        <span>{snapshot.label || (running ? "专注中" : "未开始专注")}</span>
      </div>

      {running && snapshot.endsAt ? (
        <FocusCountdown endsAt={snapshot.endsAt} />
      ) : (
        <div className="widget-empty compact">
          <span>
            {snapshot.phase === "paused"
              ? "已暂停，等待专注模块恢复"
              : "未开始专注，请在专注模块启动"}
          </span>
        </div>
      )}

      {snapshot.cycle && (
        <div className="widget-status-line">
          <span className="widget-task-meta">
            第 {snapshot.cycle.index} / {snapshot.cycle.total} 轮
          </span>
        </div>
      )}
    </div>
  );
}

export function EfficiencyWidget({ source }: { source?: EfficiencySource }) {
  const snapshot = useWidgetSource(source);

  if (!source) {
    return (
      <Unavailable
        title="今日效率统计未接入"
        hint="等待统计模块提供聚合结果后自动显示，不显示假统计。"
      />
    );
  }

  if (!snapshot) {
    return (
      <div className="widget-empty">
        <BarChart3 size={20} aria-hidden="true" />
        <span>等待统计模块数据…</span>
      </div>
    );
  }

  const rate = snapshot.completionRate;
  return (
    <div className="widget-efficiency">
      {typeof rate === "number" && (
        <div className="widget-rate">
          <span className="widget-rate-value">{Math.round(rate)}%</span>
          <span className="widget-task-meta">今日完成率</span>
          <div className="widget-bar" role="img" aria-label={`今日完成率 ${Math.round(rate)}%`}>
            <span style={{ width: `${Math.min(100, Math.max(0, rate))}%` }} />
          </div>
        </div>
      )}
      <ul className="widget-stat-grid">
        <li>
          <strong>{snapshot.completedToday}</strong>
          <span>今日完成</span>
        </li>
        <li>
          <strong>{snapshot.dueToday}</strong>
          <span>今日到期</span>
        </li>
        <li>
          <strong>{snapshot.overdue}</strong>
          <span>已逾期</span>
        </li>
        <li>
          <strong>{snapshot.pending}</strong>
          <span>待办</span>
        </li>
      </ul>
    </div>
  );
}
