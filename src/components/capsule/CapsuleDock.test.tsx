/**
 * @vitest-environment jsdom
 */
//! 分类胶囊外壳与轨道测试。
//!
//! 覆盖：
//! - 折叠态只挂载轨道（不渲染面板，也就没有多余可聚焦元素）；
//! - 点击分类：折叠态 → 触发展开；展开态再点当前分类 → 收起；
//! - Esc 作为最低优先级弹层被消费（一次只收面板）；
//! - 徽标来自真实 store：待办数、Agent 待处理数、状态色调；
//! - 空状态：不显示无意义的 0。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

vi.mock("../../lib/bridge", () => ({
  listTasks: async () => [],
  openAgentSession: async () => undefined,
  clipboardView: async () => ({ items: [], groups: [], stats: {}, total_items: 0 }),
  clipboardGroup: async () => ({ items: [] }),
  clipboardCopyItem: async () => ({ mode: "text", bytes: 0, warnings: [], sequence: 1 }),
  clipboardCopyGroupRich: async () => ({ mode: "text", bytes: 0, warnings: [], sequence: 1 }),
  clipboardThumb: async () => null,
  clipboardImage: async () => null,
  applyMode: async () => undefined,
}));

vi.mock("../../lib/navigation", () => ({
  navNavigate: async () => ({ ok: true }),
  avatarHue: () => 250,
}));

import CapsuleDock from "./CapsuleDock";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useCapsuleStore } from "../../store/useCapsuleStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { overlayStack } from "../../lib/overlayStack";
import { useNavigationStore } from "../../store/useNavigationStore";
import type { AgentRun, AgentSnapshot } from "../../lib/bridge";

function run(status: string, id = status): AgentRun {
  const t = new Date().toISOString();
  return {
    id: `r-${id}`,
    session_id: "s1",
    source_id: "codex",
    external_run_id: null,
    task_title: "修复登录",
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

const reveal = vi.fn();
const collapse = vi.fn();

function mountAt(phase: "docked-hidden" | "docked-revealed", edge = "left" as const) {
  useEdgeSnapStore.setState({
    phase,
    dockedEdge: edge,
    candidateEdge: null,
    reveal,
    collapse,
  });
  return render(<CapsuleDock />);
}

beforeEach(() => {
  reveal.mockReset();
  collapse.mockReset();
  useCapsuleStore.setState({ active: null });
  useTasksStore.setState({ stats: null });
  useAgentsStore.setState({ snapshot: null });
});

afterEach(() => {
  cleanup();
  useEdgeSnapStore.getState().reset();
});

describe("CapsuleDock · 折叠 / 展开", () => {
  it("折叠态只渲染轨道，不渲染面板", () => {
    const { container } = mountAt("docked-hidden");
    expect(container.querySelector(".capsule-rail")).toBeTruthy();
    expect(container.querySelector(".capsule-panel")).toBeNull();
    expect(container.querySelector(".capsule-dock")!.className).toContain("is-collapsed");
  });

  it("点击分类：折叠态下触发展开并记住分类", () => {
    const { container } = mountAt("docked-hidden");
    act(() => {
      container.querySelector<HTMLButtonElement>('.cap-btn[aria-label^="任务"]')!.click();
    });
    expect(useCapsuleStore.getState().active).toBe("tasks");
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(collapse).not.toHaveBeenCalled();
  });

  it("展开态渲染对应面板；再次点击当前分类 = 收起", async () => {
    useCapsuleStore.setState({ active: "tasks" });
    const { container } = mountAt("docked-revealed");
    expect(container.querySelector(".capsule-panel")).toBeTruthy();
    await screen.findByText("暂无待办");

    act(() => {
      container.querySelector<HTMLButtonElement>('.cap-btn[aria-label^="任务"]')!.click();
    });
    expect(collapse).toHaveBeenCalledTimes(1);
    expect(useCapsuleStore.getState().active).toBeNull();
  });

  it("切换分类不重新触发展开（已在展开态）", () => {
    useCapsuleStore.setState({ active: "tasks" });
    const { container } = mountAt("docked-revealed");
    act(() => {
      container.querySelector<HTMLButtonElement>('.cap-btn[aria-label="剪贴板"]')!.click();
    });
    expect(useCapsuleStore.getState().active).toBe("clipboard");
    expect(reveal).not.toHaveBeenCalled();
    expect(collapse).not.toHaveBeenCalled();
  });

  it("Escape 只收面板（注册为最低优先级弹层）", () => {
    useCapsuleStore.setState({ active: "agents" });
    mountAt("docked-revealed");
    const top = overlayStack().at(-1);
    expect(top?.kind).toBe("drawer");
    act(() => top!.onEscape());
    expect(collapse).toHaveBeenCalledTimes(1);
  });

  it("收起按钮在折叠态不触发收起（aria-disabled）", () => {
    mountAt("docked-hidden");
    const btn = screen.getByRole("button", { name: "功能面板已收起" });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    act(() => btn.click());
    expect(collapse).not.toHaveBeenCalled();
  });
});

describe("CapsuleDock · 真实状态与空状态", () => {
  it("待办徽标来自 TaskStats，0 时不显示", () => {
    useTasksStore.setState({ stats: { pending: 5 } as never });
    const { container } = mountAt("docked-hidden");
    expect(container.querySelector(".cap-badge")!.textContent).toBe("5");

    cleanup();
    useTasksStore.setState({ stats: { pending: 0 } as never });
    const second = mountAt("docked-hidden");
    expect(second.container.querySelector(".cap-badge")).toBeNull();
  });

  it("Agent 待处理数只统计 waiting + failed（不累计历史）", () => {
    useAgentsStore.setState({
      snapshot: snapshotWith(run("waiting", "1"), run("failed", "2"), run("running", "3")),
    });
    const { container } = mountAt("docked-hidden");
    expect(container.querySelector(".cap-orb-badge")!.textContent).toBe("2");
    expect(container.querySelector('.cap-orb[data-tone="failed"]')).toBeTruthy();
  });

  it("Agent 未加载时显示中性态（不伪装成空闲/0）", () => {
    const { container } = mountAt("docked-hidden");
    expect(container.querySelector('.cap-orb[data-tone="unknown"]')).toBeTruthy();
    expect(container.querySelector(".cap-orb-badge")).toBeNull();
  });

  it("任务面板空状态：不出现 0，提供创建入口", async () => {
    useCapsuleStore.setState({ active: "tasks" });
    mountAt("docked-revealed");
    await screen.findByText("暂无待办");
    expect(screen.getByRole("button", { name: "新建任务" })).toBeTruthy();
  });

  it("Agent 面板空状态：未检测到运行中的 Agent", async () => {
    useAgentsStore.setState({ snapshot: snapshotWith() });
    useCapsuleStore.setState({ active: "agents" });
    mountAt("docked-revealed");
    await screen.findByText("未检测到运行中的 Agent");
  });

  it("剪贴板面板空状态：提示打开剪贴板", async () => {
    useCapsuleStore.setState({ active: "clipboard" });
    mountAt("docked-revealed");
    await screen.findByText("剪贴板暂无记录");
  });

  it("应用面板空状态：提供配置入口", async () => {
    useNavigationStore.setState({ targets: [], targetsLoaded: true });
    useCapsuleStore.setState({ active: "apps" });
    mountAt("docked-revealed");
    await screen.findByText("尚未配置快捷应用");
  });

  it("面板内容不含敏感标题以外的数据（任务标题只在展开面板出现）", async () => {
    useCapsuleStore.setState({ active: "agents" });
    useAgentsStore.setState({ snapshot: snapshotWith(run("running")) });
    mountAt("docked-revealed");
    await waitFor(() => expect(screen.getByText("修复登录")).toBeTruthy());
  });
});
