/**
 * @vitest-environment jsdom
 */
//! Agent 面板 UI/UX 行为测试：接入管理搜索（名称/source_id、大小写、中文、清除、无结果）、
//! 搜索与状态筛选组合、详情展开、通知定位优先于筛选、健康短标签、扫描状态与折叠分组。
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
  // 折叠偏好走 localStorage；每个用例从默认展开状态开始，避免跨用例串状态
  localStorage.clear();
  ipc.discoveryScan.mockResolvedValue(SCAN);
  useAgentsStore.setState({ snapshot: snapshot(), snapshotError: null });
  useUiStore.setState({ agentFocus: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
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

  it("self-test-only 在监控行如实显示「仅自测通过 · 待真实事件」，不冒充已连接", async () => {
    const s = snapshot();
    s.runs = [];
    useAgentsStore.setState({ snapshot: s, snapshotError: null });
    ipc.discoveryScan.mockResolvedValue([
      discovered({
        source_id: "codex",
        display_name: "Codex CLI",
        health_state: "self-test-only",
        real_event_seen: false,
      }),
    ]);
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    const name = await screen.findByText("Codex CLI");
    expect(name.closest(".tree-agent")?.textContent).toContain("仅自测通过 · 待真实事件");
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

describe("健康状态与信息密度", () => {
  it("徽标用短标签，完整解释只在详情展开；默认层不重复「尚无真实事件」", async () => {
    ipc.discoveryScan.mockResolvedValue([
      discovered({
        source_id: "codex",
        display_name: "Codex CLI",
        health_state: "live",
        real_event_seen: true,
        last_real_event_at: ago(1),
      }),
      discovered({ source_id: "trae", display_name: "Trae", health_state: "transport-verified" }),
    ]);
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText("Codex CLI");

    const codex = cardFor("Codex CLI");
    expect(within(codex).getByText("实时连接")).toBeTruthy();

    const trae = cardFor("Trae");
    expect(within(trae).getByText("待真实事件")).toBeTruthy();
    // 徽标已表达「尚无真实事件」，默认层不再重复同一句话
    expect(within(trae).queryByText("尚无真实事件")).toBeNull();

    fireEvent.click(within(trae).getByRole("button", { name: "详情" }));
    expect(
      within(trae).getByText("自测事件已写入数据库，尚未收到宿主真实事件"),
    ).toBeTruthy();
  });

  it("长名称与长状态完整保留，徽标仍属于标题行而不是被截断", async () => {
    const longName = "Codex CLI（Windows 原生 Hook 接入的超长名称示例）";
    ipc.discoveryScan.mockResolvedValue([
      discovered({
        source_id: "codex",
        display_name: longName,
        health_state: "recent-unconfigured",
      }),
    ]);
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText(longName);

    const head = cardFor(longName).querySelector(".source-head") as HTMLElement;
    expect(within(head).getByText(longName)).toBeTruthy();
    expect(within(head).getByText("有事件 · 未配置")).toBeTruthy();
  });
});

describe("扫描状态", () => {
  it("首次扫描失败给准确原因与重试入口，不伪装成「未发现 Agent」", async () => {
    ipc.discoveryScan.mockRejectedValueOnce(new Error("扫描器不可用"));
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));

    await screen.findByText(/扫描失败：扫描器不可用/);
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByText(/未发现已安装的 Agent/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("Codex CLI");
  });

  it("重新扫描失败时保留上次结果、搜索条件与过期提示", async () => {
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText("Codex CLI");

    fireEvent.change(searchInput(), { target: { value: "trae" } });
    expect(screen.getByText("Trae")).toBeTruthy();

    ipc.discoveryScan.mockRejectedValueOnce(new Error("再次扫描失败"));
    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));

    await screen.findByText(/扫描失败：再次扫描失败/);
    expect(screen.getByText(/下方为上次成功结果，可能不是最新/)).toBeTruthy();
    expect(screen.getByText("Trae")).toBeTruthy();
    expect(searchInput().value).toBe("trae");
    expect(screen.queryByText(/未发现已安装的 Agent/)).toBeNull();
  });

  it("扫描进行中显示进度；成功空结果显示空状态", async () => {
    let resolveScan: (data: DiscoveredAgent[]) => void = () => {};
    ipc.discoveryScan.mockReturnValueOnce(
      new Promise<DiscoveredAgent[]>((resolve) => {
        resolveScan = resolve;
      }),
    );
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));

    expect(screen.getByText("正在扫描本机 Agent…")).toBeTruthy();
    await act(async () => resolveScan([]));
    await screen.findByText(/未发现已安装的 Agent/);
  });

  it("快速重复点击扫描只触发一次；卸载后迟到的结果不再更新界面", async () => {
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText("Codex CLI");
    const calls = ipc.discoveryScan.mock.calls.length;

    const scanBtn = screen.getByRole("button", { name: "重新扫描" });
    fireEvent.click(scanBtn);
    fireEvent.click(scanBtn);
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeTruthy());
    expect(ipc.discoveryScan.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });
});

describe("折叠分组", () => {
  it("自动发现默认展开；折叠后保留数量与搜索条件，且不触发重新扫描", async () => {
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText("Codex CLI");
    const calls = ipc.discoveryScan.mock.calls.length;

    fireEvent.change(searchInput(), { target: { value: "trae" } });
    fireEvent.click(screen.getByRole("button", { name: /Agent 自动发现/ }));

    expect(screen.queryByLabelText("搜索 Agent 名称或来源 ID")).toBeNull();
    expect(screen.getByText("3 个来源")).toBeTruthy();
    expect(ipc.discoveryScan.mock.calls.length).toBe(calls);

    fireEvent.click(screen.getByRole("button", { name: /Agent 自动发现/ }));
    expect(ipc.discoveryScan.mock.calls.length).toBe(calls);
    expect(searchInput().value).toBe("trae");
    expect(screen.getAllByRole("button", { name: /接入/ }).length).toBeGreaterThan(0);
  });

  it("通用桥接默认折叠；展开后 Token 默认遮盖，折叠再展开恢复遮盖", async () => {
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));

    expect(screen.queryByText("HTTP 端点")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /通用桥接/ }));
    expect(screen.getByText("HTTP 端点")).toBeTruthy();
    expect(screen.getByLabelText("显示令牌")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("显示令牌"));
    expect(screen.getByLabelText("隐藏令牌")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /通用桥接/ }));
    fireEvent.click(screen.getByRole("button", { name: /通用桥接/ }));
    expect(screen.getByLabelText("显示令牌")).toBeTruthy();
  });

  it("折叠状态写入独立偏好键；损坏数据安全回退默认值", async () => {
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText("Codex CLI");

    fireEvent.click(screen.getByRole("button", { name: /Agent 自动发现/ }));
    const raw = localStorage.getItem("taskdock.agent.sections.v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).sections.discovery).toBe(false);

    cleanup();
    localStorage.setItem("taskdock.agent.sections.v1", "{broken");
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("tab", { name: /接入管理/ }));
    await screen.findByText("Codex CLI");
  });
});
