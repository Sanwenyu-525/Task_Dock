//! 资源维度查询：页面只声明「我在展示哪个资源」，不各自监听事件。
//!
//! 选择器只取该资源 key 的数组引用：其他资源的状态变化不会让本组件重渲染，
//! 也不会触发任何 DOM 查询或轮询。

import { useMemo } from "react";

import type { AgentOperation } from "../../../lib/bridge";
import {
  selectResourceOperations,
  useAgentOperationsStore,
} from "../../../store/useAgentOperationsStore";

export interface ResourceOperations {
  /** 资源索引 key（`task:<id>` / `project:<id>`），空串表示无法关联。 */
  key: string;
  operations: AgentOperation[];
  running: AgentOperation[];
  /** 优先展示运行中的操作；没有则展示最近结束的那条。 */
  primary: AgentOperation | undefined;
  hasRunning: boolean;
  /** 同一资源上的不同 Agent 数量（运行中）。 */
  agentCount: number;
}

export function useResourceOperations(
  resourceKind?: string,
  resourceId?: string,
  projectId?: string,
): ResourceOperations {
  const key =
    resourceKind && resourceId
      ? `${resourceKind}:${resourceId}`
      : projectId
        ? `project:${projectId}`
        : "";
  // 引用稳定：未受影响的资源保持同一数组，避免整列表重渲染。
  const operations = useAgentOperationsStore((state) => selectResourceOperations(state, key));
  return useMemo(() => {
    const running = operations.filter((op) => op.status === "running");
    const agents = new Set(running.map((op) => op.agentId));
    return {
      key,
      operations,
      running,
      primary: running[0] ?? operations[0],
      hasRunning: running.length > 0,
      agentCount: agents.size,
    };
  }, [key, operations]);
}
