//! Agent 操作指示器：一行内展示「谁正在改 / 改完了」。
//!
//! 只做展示：不拦截点击、不抢焦点、不改变父级布局（inline-flex，随内容换行）。
//! 状态来自统一 store，组件自身不订阅任何 Tauri 事件。

import type { AgentOperation } from "../../../lib/bridge";
import { AGENT_OPERATION_STATUS_LABELS, agentLabel } from "./labels";
import "./operations.css";

export interface AgentOperationIndicatorProps {
  operations: AgentOperation[];
  /** 最多展示几个主体；其余合并为 +N。 */
  max?: number;
  /** compact 只显示圆点与身份，不显示状态文字。 */
  variant?: "inline" | "compact" | "overlay";
  className?: string;
}

export function AgentOperationIndicator({
  operations,
  max = 2,
  variant = "inline",
  className,
}: AgentOperationIndicatorProps) {
  if (operations.length === 0) return null;
  const shown = operations.slice(0, Math.max(1, max));
  const rest = operations.length - shown.length;
  const classes = ["agent-op-indicator", `agent-op-indicator--${variant}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} data-agent-op-count={operations.length}>
      {shown.map((op) => {
        const status = AGENT_OPERATION_STATUS_LABELS[op.status];
        const agent = agentLabel(op);
        return (
          <span
            key={op.id}
            className={`agent-op-chip agent-op-chip--${op.status}`}
            data-agent-op-id={op.id}
            data-status={op.status}
            title={`${agent} · ${status}${op.detail ? ` · ${op.detail}` : ""}`}
          >
            <span className="agent-op-chip-dot" aria-hidden="true" />
            <span className="agent-op-chip-agent">{agent}</span>
            {variant !== "compact" && (
              <span className="agent-op-chip-status">{status}</span>
            )}
          </span>
        );
      })}
      {rest > 0 && (
        <span className="agent-op-chip agent-op-chip--more" title={`还有 ${rest} 个操作`}>
          +{rest}
        </span>
      )}
    </span>
  );
}
