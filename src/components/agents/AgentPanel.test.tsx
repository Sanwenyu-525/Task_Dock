/**
 * @vitest-environment jsdom
 */
//! Agent 面板 UI/UX 行为测试：接入管理搜索（名称/source_id、大小写、中文、清除、无结果）、
//! 搜索与状态筛选组合、详情展开、通知定位优先于筛选。
//! 后端发现扫描与导航命令全部 mock；store 用真实实例（共享状态语义）。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentsStore } from "../../store/useAgentsStore";
import { useUiStore } from "../../store/useUiStore";
import AgentPanel from "./AgentPanel";
import type { AgentSnapshot, DiscoveredAgent } from "../../lib/bridge";

const ipc = vi.hoisted(() => ({ discoveryScan: vi.fn() }));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    discoveryScan: ipc.discoveryScan,
    adapterPreview: vi.fn(async () => ({})),
    adapterInstall: vi.fn(async () => ({})),
    adapterVerify: vi.fn(async () => ({ ok: true })),
    adapterUninstall: vi.fn(async () => ({})),
    setSourceEnabled: vi.fn(async () => {}),
    getAgentInboxDir: vi.fn(async () => "C:\\inbox"),
    openAgentSession: vi.fn(async () => {}),
    pendingItemsToTasks: vi.fn(async () => 0),
    createSource: vi.fn(async () => {}),
    deleteSource: vi.fn(async () => {}),
  };
});

vi.mock("../../lib/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/navigation")>();
  return {
    ...actual,
    navAgentCapabilities: vi.fn(async () => null),
    navAgentAction: vi.fn(async () => ({ ok: true })),
  };
});

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function discovered(extra: Partial<DiscoveredAgent> & Pick<DiscoveredAgent, "source_id" | "display_name">): DiscoveredAgent {
  return {
    transport_kind: "transport",
    installed: true,
    version: "2.1.0",
    install_paths: [],
    config_homes: [],
    install_method: "config-home-or-executable",
    running_instances: [],
    capabilities: [],
    supported_events: ["session.started", "run.completed"],
    docs_url: "",
    limitations: [],
    registered: true,
    enabled: true,
    configured: true,
    verified: false,
    transport_verified: false,
    real_event_seen: false,
    last_event_at: null,
    last_real_event_at: null,
    health_state: "awaiting-first-event",
    connection_state: "unknown",
    ...extra,
  };
}

const SCAN: DiscoveredAgent[] = [
  discovered({ source_id: "codex", display_name: "Codex CLI", version: "1.2.3" }),
  discovered({ source_id: "trae", display_name: "Trae", version: "0.9.0" }),
  discovered({ source_id: "helper-1", display_name: "代码助手" }),
];

function snapshot(): AgentSnapshot {
  return {
    sources: [
      {
        id: "codex",
        display_name: "Codex CLI",
        kind: "transport",
        enabled: true,
        verified: false,
        homepage: "",
        note: "",
        config: {},
      },
      {
        id: "trae",
        display_name: "Trae",
        kind: "transport",
        enabled: true,
        verified: false,
        homepage: "",
        note: "",
        config: {},
      },
    ],
    instances: [],
    sessions: [
      {
        id: "s1",
        source_id: "codex",
        external_id: "e1",
        title: "Fix bug",
        status: "running",
        first_seen_at: ago(5),
        last_seen_at: ago(1),
        last_run_id: "r1",
        instance_id: null,
      },
    ],
    runs: [
      {
        id: "r1",
        session_id: "s1",
        source_id: "codex",
        external_run_id: null,
        task_title: "Fix bug",
        status: "running",
        started_at: ago(5),
        updated_at: ago(1),
        ended_at: null,
        pending_items: [],
        instance_id: null,
      },
    ],
  };
}

function cardFor(name: string): HTMLElement {
  const el = screen.getByText(name).closest(".discovery-card");
  if (!el) throw new Error(`没有找到 ${name} 的卡片`);
  return el as HTMLElement;
}

function searchInput(): HTMLInputElement {
  return screen.getByLabelText("搜索 Agent 名称或来源 ID") as HTMLInputElement;
}

beforeEach(() => {
  ipc.discoveryScan.mockResolvedValue(SCAN);
  useAgentsStore.setState({ snapshot: snapshot(), snapshotError: null });
  useUiStore.setState({ agentFocus: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("接入管理搜索", () => {
  it("匹配名称与 source_id，大小写不敏感，清除后恢复全部", async () => {
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText("Codex CLI");

    fireEvent.change(searchInput(), { target: { value: "TRAE" } });
    expect(screen.getByText("Trae")).toBeTruthy();
    expect(screen.queryByText("Codex CLI")).toBeNull();
    expect(screen.queryByText("代码助手")).toBeNull();

    // 只按名称与 ID 匹配："code" 命中 Codex（id 含 code），不虚构「Code/Codex」别名
    fireEvent.change(searchInput(), { target: { value: " code " } });
    expect(screen.getByText("Codex CLI")).toBeTruthy();
    expect(screen.queryByText("Trae")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByText("Codex CLI")).toBeTruthy();
    expect(screen.getByText("Trae")).toBeTruthy();
    expect(screen.getByText("代码助手")).toBeTruthy();
  });

  it("中文连续关键词命中；无结果时给搜索专属提示而不是「没有安装 Agent」", async () => {
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText("Codex CLI");

    fireEvent.change(searchInput(), { target: { value: "代码" } });
    expect(screen.getByText("代码助手")).toBeTruthy();
    expect(screen.queryByText("Codex CLI")).toBeNull();

    fireEvent.change(searchInput(), { target: { value: "不存在的来源" } });
    expect(screen.getByText(/没有名称或 source_id 匹配/)).toBeTruthy();
    expect(screen.queryByText(/未发现已安装的 Agent/)).toBeNull();
    expect(screen.queryByText("代码助手")).toBeNull();
  });

  it("详情展开后才显示完整版本与 Hooks 信息", async () => {
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText("Codex CLI");

    const card = cardFor("Codex CLI");
    expect(within(card).queryByText("1.2.3")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "详情" }));
    expect(within(card).getByText("1.2.3")).toBeTruthy();
    expect(within(card).getByText(/已写入（Task Dock 管理）/)).toBeTruthy();
    expect(within(card).getByText(/session.started/)).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "详情" }));
    expect(within(card).queryByText("1.2.3")).toBeNull();
  });
});

describe("运行监控搜索", () => {
  it("搜索与状态筛选可组合；清空后恢复当前筛选范围内的全部", async () => {
    render(<AgentPanel />);
    await screen.findByText("Codex CLI");

    // 默认「需关注」只显示有实时轮次的 Codex
    expect(screen.queryByText("Trae")).toBeNull();

    fireEvent.change(searchInput(), { target: { value: "trae" } });
    expect(screen.getByText(/没有名称或来源 ID 匹配/)).toBeTruthy();

    // 切到「全部」后同一搜索词命中 Trae，Codex 被搜索过滤
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByText("Trae")).toBeTruthy();
    expect(screen.queryByText("Codex CLI")).toBeNull();
    expect(searchInput().value).toBe("trae");

    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByText("Codex CLI")).toBeTruthy();
    expect(screen.getByText("Trae")).toBeTruthy();
  });

  it("通知定位清除冲突的搜索条件，仍能显示目标会话", async () => {
    render(<AgentPanel />);
    await screen.findByText("Codex CLI");

    fireEvent.change(searchInput(), { target: { value: "trae" } });
    expect(screen.queryByText("Fix bug")).toBeNull();

    act(() => {
      useUiStore.setState({
        agentFocus: { sourceId: "codex", sessionId: "s1", refId: "r1", token: 1 },
      });
    });

    await waitFor(() => expect(screen.queryAllByText("Fix bug").length).toBeGreaterThan(0));
    expect(searchInput().value).toBe("");
  });
});
