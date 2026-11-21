//! 资源高亮：把「该资源正被 Agent 修改」贴在业务组件上，且不新增布局节点。
//!
//! 用法：
//! - 有宿主元素（卡片/行）时把它作为唯一子元素传入 → 克隆宿主、追加
//!   `agent-op-surface` 类并在内部叠加一个绝对定位的状态徽标（不改布局、
//!   不拦截交互）；
//! - 没有宿主（表格单元格等）时直接渲染内联指示器。
//!
//! 不查询 DOM、不按标题匹配：只认真实 `resourceId`（新建时先用 projectId
//! 作为列表级临时目标，提交后再绑定真实 ID）。

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

import type { AgentOperation } from "../../../lib/bridge";
import { AgentOperationIndicator } from "./AgentOperationIndicator";
import { useResourceOperations } from "./useResourceOperations";
import "./operations.css";

export interface AgentOperationHighlightProps {
  resourceKind?: string;
  resourceId?: string;
  /** 新建资源尚无 ID 时，用所属项目列表作为临时定位目标。 */
  projectId?: string;
  /** 业务宿主元素；省略时只渲染内联指示器。 */
  children?: ReactElement;
  /** 是否叠加状态徽标（默认 true）。 */
  showIndicator?: boolean;
  className?: string;
}

type HostProps = {
  className?: string;
  children?: ReactNode;
  "data-agent-op"?: string;
};

export function AgentOperationHighlight({
  resourceKind,
  resourceId,
  projectId,
  children,
  showIndicator = true,
  className,
}: AgentOperationHighlightProps) {
  const { operations, hasRunning } = useResourceOperations(
    resourceKind,
    resourceId,
    projectId,
  );

  if (!children || !isValidElement(children)) {
    return <AgentOperationIndicator operations={operations} />;
  }

  const host = children as ReactElement<HostProps>;
  const surface = [
    "agent-op-surface",
    hasRunning ? "agent-op-surface--running" : "",
    operations.length > 0 ? "agent-op-surface--settled" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const mergedClass = [host.props.className, surface].filter(Boolean).join(" ");
  const badge =
    showIndicator && operations.length > 0 ? (
      <AgentOperationIndicator operations={operations} variant="overlay" />
    ) : null;

  return cloneElement(host, {
    className: mergedClass,
    "data-agent-op": operations.length > 0 ? (hasRunning ? "running" : "settled") : undefined,
    children: badge ? (
      <>
        {host.props.children}
        {badge}
      </>
    ) : (
      host.props.children
    ),
  });
}

export interface AgentOperationSurfaceProps {
  className: string;
  "data-agent-op"?: "running" | "settled";
}

/** 供非 React 宿主（如 <tr>）判断是否需要加类名时复用同一查询。 */
export function useAgentOperationSurface(
  resourceKind?: string,
  resourceId?: string,
  projectId?: string,
): {
  operations: AgentOperation[];
  hasRunning: boolean;
  surfaceProps: AgentOperationSurfaceProps;
} {
  const { operations, hasRunning } = useResourceOperations(
    resourceKind,
    resourceId,
    projectId,
  );
  const surfaceProps: AgentOperationSurfaceProps =
    operations.length > 0
      ? {
          className: hasRunning
            ? "agent-op-surface agent-op-surface--running"
            : "agent-op-surface agent-op-surface--settled",
          "data-agent-op": hasRunning ? "running" : "settled",
        }
      : { className: "" };
  return { operations, hasRunning, surfaceProps };
}

export type { AgentOperation };
