// @vitest-environment jsdom
//! AgentOperationIndicator / AgentOperationHighlight 的展示契约：
//! 身份、状态、多 Agent、不拦截交互、无操作时不渲染。

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentOperation } from "../../../lib/bridge";
import { useAgentOperationsStore } from "../../../store/useAgentOperationsStore";
import { AgentOperationHighlight } from "./AgentOperationHighlight";
import { AgentOperationIndicator } from "./AgentOperationIndicator";

function op(overrides: Partial<AgentOperation> = {}): AgentOperation {
  return {
    id: "op-1",
    agentId: "codex",
    actorKind: "agent",
    interface: "mcp",
    action: "task.update",
    resourceKind: "task",
    resourceId: "t-1",
    projectId: "p-1",
    status: "running",
    phase: "writing",
    requestId: "",
    startedAt: "2026-11-21T01:00:00.000Z",
    updatedAt: "2026-11-21T01:00:00.000Z",
    errorCode: "",
    detail: "",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  useAgentOperationsStore.getState().reset();
});

describe("AgentOperationIndicator", () => {
  it("展示 Agent 身份与状态，多于上限时折叠为 +N", () => {
    const ops = [
      op({ id: "a", agentId: "codex" }),
      op({ id: "b", agentId: "claude" }),
      op({ id: "c", agentId: "gemini" }),
    ];
    render(<AgentOperationIndicator operations={ops} max={2} />);
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.queryByText("gemini")).toBeNull();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getAllByText("进行中").length).toBe(2);
  });

  it("没有操作时不渲染任何节点", () => {
    const { container } = render(<AgentOperationIndicator operations={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("AgentOperationHighlight", () => {
  it("自动查找资源操作，并把高亮类名挂到宿主元素上（不新增包裹层）", () => {
    useAgentOperationsStore.getState().ingest(op());
    const { container } = render(
      <AgentOperationHighlight resourceKind="task" resourceId="t-1">
        <div className="task-card">任务内容</div>
      </AgentOperationHighlight>,
    );
    const host = container.querySelector(".task-card");
    expect(host).toBeTruthy();
    expect(host?.className).toContain("agent-op-surface--running");
    expect(host?.getAttribute("data-agent-op")).toBe("running");
    // 宿主仍是唯一子节点：没有插入新的块级包裹层
    expect(container.firstChild).toBe(host);
    expect(host?.textContent).toContain("任务内容");
    expect(host?.textContent).toContain("codex");
  });

  it("其他资源的操作不会命中当前资源", () => {
    useAgentOperationsStore.getState().ingest(op({ resourceId: "t-2" }));
    const { container } = render(
      <AgentOperationHighlight resourceKind="task" resourceId="t-1">
        <div className="task-card">任务内容</div>
      </AgentOperationHighlight>,
    );
    const host = container.querySelector(".task-card");
    expect(host?.className).not.toContain("agent-op-surface--running");
    expect(screen.queryByText("codex")).toBeNull();
  });

  it("无宿主时退回内联指示器（用于表格/标题行）", () => {
    useAgentOperationsStore.getState().ingest(op());
    render(<AgentOperationHighlight resourceKind="task" resourceId="t-1" />);
    expect(screen.getByText("codex")).toBeTruthy();
  });
});
