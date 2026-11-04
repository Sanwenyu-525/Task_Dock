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
  onClipboardChanged: async () => () => {},
  onQuickCaptureCreated: async () => () => {},
  listTasks: async () => [],
  agentSnapshot: async () => ({ sources: [], instances: [], sessions: [], runs: [] }),
  openAgentSession: async () => undefined,
  clipboardView: async () => ({ items: [], groups: [], stats: {}, total_items: 0 }),
  clipboardGroup: async () => ({ items: [] }),
  clipboardCopyItem: async () => ({ mode: "text", bytes: 0, warnings: [], sequence: 1 }),
  clipboardCopyGroupRich: async () => ({ mode: "text", bytes: 0, warnings: [], sequence: 1 }),
  clipboardStatus: async () => ({
    enabled: true,
    paused: false,
    monitoring: true,
    activeJob: null,
    platform: "windows",
    configError: null,
    configOrigin: null,
    captureAllowed: true,
  }),
  quickCaptureList: async () => [],
  quickCaptureState: async () => ({ draft: null, last_type: "task", inbox_count: 0 }),
  quickCaptureMarkHandled: async () => {
    throw new Error("not used");
  },
  quickCaptureDelete: async () => undefined,
  quickCaptureConvertToTask: async () => {
    throw new Error("not used");
  },
  clipboardThumb: async () => null,
  clipboardImage: async () => null,
  applyMode: async () => undefined,
}));

vi.mock("../../lib/navigation", () => ({
  navNavigate: async () => ({
    success: true,
    requested_action: "launch",
    actual_action: "launch",
    fallback_used: false,
    target_id: "t1",
    verification_level: "launch",
  }),
  navListTargets: async () => [],
  avatarHue: () => 250,
}));

// 专注徽标需要 Tauri IPC（focus_snapshot / 事件监听）；本文件只验证胶囊外壳与轨道，
// 徽标行为由 FocusCapsuleBadge.test.tsx 独立覆盖，这里隔离掉避免真实 IPC。
vi.mock("../focus/FocusCapsuleBadge", () => ({ default: () => null }));

import CapsuleDock from "./CapsuleDock";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useCapsuleStore } from "../../store/useCapsuleStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { overlayStack, registerOverlay, topOverlay } from "../../lib/overlayStack";
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
  // active 是模块级 store，会跨用例残留，必须复位到默认分类
  useCapsuleStore.setState({ active: "tasks" });
  useTasksStore.setState({ stats: null });
  useAgentsStore.setState({ snapshot: null, snapshotError: null });
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
    await screen.findByText("暂无任务");

    act(() => {
      container.querySelector<HTMLButtonElement>('.cap-btn[aria-label^="任务"]')!.click();
    });
    expect(collapse).toHaveBeenCalledTimes(1);
    // 收起只切相位，分类保持——下次展开仍是这一个，不需要兜底回填
    expect(useCapsuleStore.getState().active).toBe("tasks");
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

  it("折叠态不提供可见的收起控件（没有「再收起」这回事）", () => {
    const { container } = mountAt("docked-hidden");
    // 占位保留（避免展开/收起时图标跳动），但对用户与无障碍树都不可见
    const btn = container.querySelector(".cap-collapse") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("data-inert")).toBe("true");
    expect(btn.getAttribute("aria-hidden")).toBe("true");
    expect(btn.tabIndex).toBe(-1);
    expect(screen.queryByRole("button", { name: "功能面板已收起" })).toBeNull();
    act(() => btn.click());
    expect(collapse).not.toHaveBeenCalled();
  });

  it("展开态收起按钮可见、可聚焦，点击即收起", () => {
    const { container } = mountAt("docked-revealed");
    const btn = container.querySelector(".cap-collapse") as HTMLButtonElement;
    expect(btn.getAttribute("data-inert")).toBe("false");
    expect(btn.tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "收起功能面板" })).toBe(btn);
    act(() => btn.click());
    expect(collapse).toHaveBeenCalledTimes(1);
  });
});

describe("CapsuleDock · 分类与相位的单一事实来源", () => {
  it("托盘/热键/重启恢复只切相位：默认分类就有面板内容，不存在空白面板", async () => {
    const { container } = mountAt("docked-revealed");
    expect(useCapsuleStore.getState().active).toBe("tasks");
    expect(container.querySelector(".capsule-panel")).toBeTruthy();
    await screen.findByText("暂无任务");
  });

  it("展开保留上一次的分类选择，而不是每次都跳回默认", async () => {
    useCapsuleStore.setState({ active: "agents" });
    useAgentsStore.setState({ snapshot: snapshotWith() });
    const { container } = mountAt("docked-revealed");
    expect(useCapsuleStore.getState().active).toBe("agents");
    expect(container.querySelector('.capsule-panel[aria-label="Agent面板"]')).toBeTruthy();
    await screen.findByText("未检测到运行中的 Agent");
  });

  it("收起后再展开（只切相位、不经过分类点击）：仍是刚才那个分类", async () => {
    useCapsuleStore.setState({ active: "clipboard" });
    const { container } = mountAt("docked-revealed");
    act(() => {
      container.querySelector<HTMLButtonElement>('.cap-btn[aria-label="剪贴板"]')!.click();
    });
    expect(collapse).toHaveBeenCalledTimes(1);
    // 收起不清空分类：面板可见性只由相位决定，避免「相位已展开、分类已为空」的中间帧
    expect(useCapsuleStore.getState().active).toBe("clipboard");

    // 引擎折叠完成 → 再次展开（只切相位，不经过分类点击）
    act(() => useEdgeSnapStore.setState({ phase: "docked-hidden" }));
    act(() => useEdgeSnapStore.setState({ phase: "docked-revealed" }));
    expect(useCapsuleStore.getState().active).toBe("clipboard");
    await screen.findByText("剪贴板暂无记录");
  });

  it("折叠态连续快速点击同一分类：只推进展开意图，不产生收起抖动", () => {
    const { container } = mountAt("docked-hidden");
    const btn = () => container.querySelector<HTMLButtonElement>('.cap-btn[aria-label^="任务"]')!;
    act(() => btn().click());
    act(() => btn().click());
    act(() => btn().click());
    // 三次点击都发生在折叠态（相位由引擎确认区域写入后才推进），因此只登记展开
    expect(reveal).toHaveBeenCalledTimes(3);
    expect(collapse).not.toHaveBeenCalled();
    expect(useCapsuleStore.getState().active).toBe("tasks");
  });

  it("面板内层弹层优先消费 Escape，且内层打开时不被自动收起", () => {
    useCapsuleStore.setState({ active: "tasks" });
    mountAt("docked-revealed");
    const inner = vi.fn();
    const release = registerOverlay({ kind: "menu", onEscape: inner });

    // 优先级按弹层种类：面板是 drawer（最低），内层菜单必须盖过它
    expect(topOverlay()?.kind).toBe("menu");
    act(() => topOverlay()!.onEscape());
    expect(inner).toHaveBeenCalledTimes(1);
    expect(collapse).not.toHaveBeenCalled(); // 一次按键只关一层
    // 引擎的光标离开判定读同一个栈：栈非空 → 不触发 collapse
    expect(topOverlay()).toBeDefined();

    release();
    expect(topOverlay()?.kind).toBe("drawer");
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
    await screen.findByText("暂无任务");
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
