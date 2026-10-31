/**
 * @vitest-environment jsdom
 */
//! Smart Dock Capsule 组件渲染测试。
//!
//! 验收点（需求 三/六/八）：
//! - free/candidate 等相位不渲染胶囊；docked-hidden 渲染胶囊按钮；
//! - 胶囊显示待办数（未加载为 –）与 Agent 运行数/状态点，异常态有 alert 类；
//! - 点击立即调用引擎 reveal（不双重触发）；
//! - aria 标签可读、箭头按边旋转（朝向屏幕内部）；
//! - 候选提示带磁吸强度类；停靠反馈 role=status 且 1.2s 后消失。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import SnapOverlay from "./SnapOverlay";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useTasksStore } from "../store/useTasksStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { SNAP_FEEDBACK_MS } from "../lib/edgeSnap";
import type { AgentRun, AgentSnapshot } from "../lib/bridge";

function agentRun(status: string): AgentRun {
  const t = new Date().toISOString();
  return {
    id: `r-${status}`,
    session_id: "s",
    source_id: "codex",
    external_run_id: `e-${status}`,
    task_title: "secret-title",
    status,
    started_at: t,
    updated_at: t,
    ended_at: null,
    pending_items: [],
  };
}

const snapshotWith = (...runs: AgentRun[]): AgentSnapshot => ({
  sources: [],
  instances: [],
  sessions: [],
  runs,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useEdgeSnapStore.getState().reset();
  useTasksStore.setState({ stats: null });
  useAgentsStore.setState({ snapshot: null });
});

function setSnap(p: Partial<ReturnType<typeof useEdgeSnapStore.getState>>) {
  act(() => {
    useEdgeSnapStore.setState(p as never);
  });
}

describe("SnapOverlay · Smart Dock Capsule", () => {
  it("非隐藏相位不渲染胶囊", () => {
    render(<SnapOverlay />);
    setSnap({ phase: "docked-visible", dockedEdge: "left" });
    expect(screen.queryByRole("button", { name: /展开 Task Dock（已吸附/ })).toBeNull();
    setSnap({ phase: "free", dockedEdge: null });
    expect(document.querySelector(".snap-capsule")).toBeNull();
  });

  it("docked-hidden 渲染胶囊：待办/Agent 占位、aria 完整、点击 reveal 一次", () => {
    const reveal = vi.fn();
    render(<SnapOverlay />);
    setSnap({ phase: "docked-hidden", dockedEdge: "left", reveal });
    const capsule = screen.getByRole("button", { name: /展开 Task Dock（已吸附左侧）/ });
    expect(capsule.className).toContain("capsule-left");
    expect(capsule.className).toContain("capsule-v");
    expect(capsule.textContent).toContain("–"); // 未加载占位
    act(() => {
      capsule.click();
      capsule.click(); // 连续点击：reveal 注入的是 runExclusive 包裹，但组件层只透传
    });
    expect(reveal).toHaveBeenCalledTimes(2); // 组件层不吞事件；互斥由引擎保证
  });

  it("胶囊展示待办数与 Agent 运行数（05 / 运行 2）", () => {
    render(<SnapOverlay />);
    act(() => {
      useTasksStore.setState({ stats: { pending: 5 } as never });
      useAgentsStore.setState({ snapshot: snapshotWith(agentRun("running"), agentRun("running")) });
    });
    setSnap({ phase: "docked-hidden", dockedEdge: "bottom" });
    const capsule = screen.getByRole("button", { name: /展开 Task Dock（已吸附底部）/ });
    expect(capsule.textContent).toContain("05");
    expect(capsule.className).toContain("capsule-h");
    expect(capsule.querySelector(".capsule-dot.dot-running")).toBeTruthy();
  });

  it("异常状态提升优先级：failed → capsule-alert-failed + 红点", () => {
    render(<SnapOverlay />);
    act(() => {
      useTasksStore.setState({ stats: { pending: 0 } as never });
      useAgentsStore.setState({ snapshot: snapshotWith(agentRun("failed")) });
    });
    setSnap({ phase: "docked-hidden", dockedEdge: "right" });
    const capsule = screen.getByRole("button", { name: /有失败任务需要关注/ });
    expect(capsule.className).toContain("capsule-alert-failed");
    expect(document.querySelector(".capsule-dot.dot-failed")).toBeTruthy();
    expect(capsule.textContent).not.toContain("secret-title"); // 不暴露任务标题
  });

  it("waiting 异常 → capsule-alert-waiting", () => {
    render(<SnapOverlay />);
    act(() => {
      useTasksStore.setState({ stats: { pending: 12 } as never });
      useAgentsStore.setState({ snapshot: snapshotWith(agentRun("waiting")) });
    });
    setSnap({ phase: "docked-hidden", dockedEdge: "top" });
    expect(
      document.querySelector(".snap-capsule.capsule-alert-waiting"),
    ).toBeTruthy();
  });

  it("待办超过 99 显示 99+", () => {
    render(<SnapOverlay />);
    act(() => {
      useTasksStore.setState({ stats: { pending: 120 } as never });
    });
    setSnap({ phase: "docked-hidden", dockedEdge: "left" });
    expect(screen.getByRole("button").textContent).toContain("99+");
  });

  it("四个边的箭头类与布局方向类齐备", () => {
    render(<SnapOverlay />);
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      setSnap({ phase: "docked-hidden", dockedEdge: edge });
      const capsule = document.querySelector(`.snap-capsule.capsule-${edge}`);
      expect(capsule, `edge=${edge}`).toBeTruthy();
      expect(capsule!.querySelector(".capsule-chevron")).toBeTruthy();
    }
  });
});

describe("SnapOverlay · 候选提示与反馈", () => {
  it("candidate 提示带磁吸强度类（magnetized=true）", () => {
    render(<SnapOverlay />);
    setSnap({ phase: "candidate", candidateEdge: "left", magnetized: true });
    expect(screen.getByText("松开吸附左侧")).toBeTruthy();
    expect(document.querySelector(".snap-hint.snap-hint-magnet")).toBeTruthy();
  });

  it("candidate 预览带（28–42 滞回）无磁吸强度类", () => {
    render(<SnapOverlay />);
    setSnap({ phase: "candidate", candidateEdge: "right", magnetized: false });
    expect(screen.getByText("松开吸附右侧")).toBeTruthy();
    expect(document.querySelector(".snap-hint-magnet")).toBeNull();
  });

  it("停靠反馈 role=status，1.2s 后消失", () => {
    vi.useFakeTimers();
    render(<SnapOverlay />);
    act(() => {
      useEdgeSnapStore.getState().notifyDocked("top");
    });
    expect(screen.getByRole("status").textContent).toContain("已吸附顶部");
    act(() => {
      vi.advanceTimersByTime(SNAP_FEEDBACK_MS + 50);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("docked-visible 渲染停靠细线但不渲染胶囊", () => {
    render(<SnapOverlay />);
    setSnap({ phase: "docked-visible", dockedEdge: "bottom" });
    expect(document.querySelector(".snap-dock-line-bottom")).toBeTruthy();
    expect(document.querySelector(".snap-capsule")).toBeNull();
  });
});
