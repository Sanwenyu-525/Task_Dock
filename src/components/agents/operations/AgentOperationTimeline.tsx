//! 操作时间线：活动面板与资源详情共用。
//!
//! - 默认读取统一 store（运行中 + 最近结束），不自己拉接口、不自己轮询；
//! - 行可点击时只调用 `locateAgentOperationResource`，不吞掉失败；
//! - 失败/冲突/中断明确展示原因（`errorCode` + 脱敏详情），不伪装成功。

import { useMemo } from "react";

import type { AgentOperation } from "../../../lib/bridge";
import { useAgentOperationsStore } from "../../../store/useAgentOperationsStore";
import { useUiStore } from "../../../store/useUiStore";
import {
  AGENT_OPERATION_STATUS_LABELS,
  actionLabel,
  agentLabel,
  operationTimeLabel,
  resourceLabel,
} from "./labels";
import { canLocateOperation, locateAgentOperationResource } from "./locate";
import "./operations.css";

export interface AgentOperationTimelineProps {
  /** 外部指定列表（如分页历史）；省略时用 store 的实时列表。 */
  items?: AgentOperation[];
  limit?: number;
  emptyHint?: string;
  /** 是否显示「定位」入口（默认自动判断资源类型是否可定位）。 */
  showLocate?: boolean;
  className?: string;
}

function sortDesc(a: AgentOperation, b: AgentOperation): number {
  const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return Number.isNaN(delta) || delta === 0 ? b.id.localeCompare(a.id) : delta;
}

export function AgentOperationTimeline({
  items,
  limit = 12,
  emptyHint = "暂无 Agent 操作",
  showLocate = true,
  className,
}: AgentOperationTimelineProps) {
  const active = useAgentOperationsStore((s) => s.active);
  const recent = useAgentOperationsStore((s) => s.recent);

  const rows = useMemo(() => {
    if (items) return items.slice(0, limit);
    const seen = new Set<string>();
    const merged: AgentOperation[] = [];
    for (const op of [...active, ...recent]) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      merged.push(op);
    }
    return merged.sort(sortDesc).slice(0, limit);
  }, [items, active, recent, limit]);

  if (rows.length === 0) {
    return <p className="agent-op-empty">{emptyHint}</p>;
  }

  return (
    <ul className={`agent-op-timeline ${className ?? ""}`.trim()}>
      {rows.map((op) => {
        const locatable = showLocate && canLocateOperation(op);
        const status = AGENT_OPERATION_STATUS_LABELS[op.status];
        const failed = op.status === "failed" || op.status === "conflict";
        return (
          <li key={op.id} className={`agent-op-row agent-op-row--${op.status}`} data-status={op.status}>
            <span className={`agent-op-row-dot agent-op-row-dot--${op.status}`} aria-hidden="true" />
            <span className="agent-op-row-main">
              <span className="agent-op-row-title">
                <strong>{agentLabel(op)}</strong>
                <span className="agent-op-row-action">{actionLabel(op)}</span>
                <span className={`agent-op-row-status agent-op-row-status--${op.status}`}>
                  {status}
                </span>
              </span>
              <span className="agent-op-row-meta">
                <span>{resourceLabel(op)}</span>
                <span>{op.interface}</span>
                <span>{operationTimeLabel(op.finishedAt ?? op.updatedAt)}</span>
                {op.revision !== undefined && <span>rev {op.revision}</span>}
              </span>
              {(failed || op.status === "interrupted") && (op.errorCode || op.detail) && (
                <span className="agent-op-row-error" title={op.detail}>
                  {op.errorCode ? `${op.errorCode} · ` : ""}
                  {op.detail}
                </span>
              )}
            </span>
            {locatable && (
              <button
                type="button"
                className="agent-op-row-locate"
                onClick={() => {
                  if (!locateAgentOperationResource(op)) {
                    useUiStore
                      .getState()
                      .showToast("资源已删除或暂不支持定位", { kind: "warning" });
                  }
                }}
              >
                定位
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
