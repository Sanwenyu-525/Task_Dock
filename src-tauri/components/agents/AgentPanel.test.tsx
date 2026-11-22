/**
 * @vitest-environment jsdom
 */
//! Agent 面板 UI/UX 行为测试：接入管理搜索（名称/source_id、大小写、中文、清除、无结果）、
//! 搜索与状态筛选组合、详情展开、通知定位优先于筛选、健康短标签、扫描状态与折叠分组。
//! 后端发现扫描与导航命令全部 mock；store 用真实实例（共享状态语义）。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentsStore } from "../../store/useAgentsStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import AgentPanel from "./AgentPanel";
import type { AgentChangedEvent, AgentSnapshot, DiscoveredAgent } from "../../lib/bridge";

const ipc = vi.hoisted(() => ({
  discoveryScan: vi.fn(),
  historySessions: vi.fn(),
  historyRuns: vi.fn(),
  historySession: vi.fn(),
  historyGroups: vi.fn(),
  planningFeatureLinks: vi.fn(),
  onAgentChanged: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    discoveryScan: ipc.discoveryScan,
    agentHistorySessions: ipc.historySessions,
    agentHistoryRuns: ipc.historyRuns,
    agentHistorySession: ipc.historySession,
    agentHistoryGroups: ipc.historyGroups,
    planningListAgentFeatureLinks: ipc.planningFeatureLinks,
    onAgentChanged: ipc.onAgentChanged,
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

// ── agent-changed 可触发式监听器（P3-01 用例用）──
let agentChangedHandlers: ((payload: AgentChangedEvent) => void)[] = [];
let unlistenAgentChanged: ReturnType<typeof vi.fn>;

/** 派发一条后端批量聚合的 agent-changed 事件给当前所有订阅者。 */
function emitAgentChanged(
  payload: Partial<AgentChangedEvent> & Pick<AgentChangedEvent, "source_id">,
) {
  const full: AgentChangedEvent = {
    sources: [payload.source_id],
    session_id: "sess-x",
    states: {},
    batch: 1,
    changed: true,
    deduplicated: false,
    late: false,
    ...payload,
  };
  act(() => {
    for (const cb of [...agentChangedHandlers]) cb(full);
  });
}

beforeEach(() => {
  // 折叠偏好走 localStorage；每个用例从默认展开状态开始，避免跨用例串状态
  localStorage.clear();
  ipc.discoveryScan.mockResolvedValue(SCAN);
  // 历史查询默认空页；用例按需覆盖（后端分页与实时快照完全独立）。
  ipc.historySessions.mockResolvedValue({ items: [], total: 0, next_cursor: null });
  ipc.historyRuns.mockResolvedValue({ items: [], total: 0, next_cursor: null });
  ipc.historySession.mockResolvedValue(null);
  ipc.historyGroups.mockResolvedValue({ items: [], truncated: false });
  ipc.planningFeatureLinks.mockResolvedValue([]);
  // agent-changed：记录订阅回调；退订时调用 spy 并从列表移除。
  agentChangedHandlers = [];
  unlistenAgentChanged = vi.fn();
  ipc.onAgentChanged.mockImplementation((cb: (payload: AgentChangedEvent) => void) => {
    agentChangedHandlers.push(cb);
    return Promise.resolve(() => {
      unlistenAgentChanged();
      agentChangedHandlers = agentChangedHandlers.filter((h) => h !== cb);
    });
  });
  useAgentsStore.setState({ snapshot: snapshot(), snapshotError: null });
  useUiStore.setState({ agentFocus: null });
  useGlobalSearchStore.setState({ pendingLocate: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("运行监控 · 历史会话后端分页", () => {
  it("Agent 页面上下文帮助打开 Agent 接入教程", async () => {
    const user = userEvent.setup();
    render(<AgentPanel />);

    await user.click(screen.getByRole("button", { name: "查看帮助：接入 Agent：检测与 Hooks 安装" }));
    await user.click(await screen.findByRole("button", { name: "查看完整教程" }));

    expect(useUiStore.getState().tab).toBe("help");
    expect(useUiStore.getState().helpOpenRequest?.articleId).toBe("help.agents.hooks-onboarding");
  });

  it("展开真实 Agent 会话后可定位关联规划功能", async () => {
    ipc.planningFeatureLinks.mockResolvedValue([
      {
        id: "link-1",
        feature_id: "feature-1",
        feature_title: "Feature one",
        project_id: "project-1",
        project_name: "Project one",
        agent_source: "codex",
        agent_name: "Codex CLI",
        session_id: "e1",
        status: "linked",
        agent_status: "running",
        agent_session_id: "s1",
        last_seen_at: ago(1),
        last_execution_at: ago(5),
      },
    ]);
    render(<AgentPanel />);

    expect(ipc.planningFeatureLinks).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Codex CLI"));
    const session = screen.getByRole("button", { name: /Fix bug/ });
    fireEvent.click(session);

    expect(await screen.findByRole("button", { name: "定位规划功能 Feature one" })).toBeTruthy();
    expect(ipc.planningFeatureLinks).toHaveBeenCalledWith("codex", "e1");
    fireEvent.click(screen.getByRole("button", { name: "定位规划功能 Feature one" }));

    expect(useUiStore.getState().tab).toBe("roadmap");
    expect(useGlobalSearchStore.getState().pendingLocate).toMatchObject({
      category: "planning",
      id: "feature-1",
      kind: "feature",
      parentId: "project-1",
    });
  });

  type HistoryPage = Awaited<ReturnType<typeof import("../../lib/bridge").agentHistorySessions>>;

  function historyItem(i: number, overrides: Partial<AgentHistorySessionLike> = {}) {
    return {
      id: `hist-${i}`,
      source_id: "codex",
      external_id: `ext-hist-${i}`,
      title: `历史会话 ${i}`,
      status: "completed",
      first_seen_at: ago(600 + i),
      last_seen_at: ago(500 + i),
      last_run_id: null,
      instance_id: null,
      run_count: 1,
      ...overrides,
    };
  }
  type AgentHistorySessionLike = HistoryPage["items"][number];

  function historyRun(i: number, sessionId = "s1") {
    return {
      id: `h-run-${i}`,
      session_id: sessionId,
      source_id: "codex",
      external_run_id: null,
      task_title: `历史轮次任务 ${i}`,
      status: "completed",
      started_at: ago(700 + i),
      updated_at: ago(600 + i),
      ended_at: ago(600 + i),
      pending_items: [],
      instance_id: null,
    };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("折叠态显示后端准确总数，且不渲染历史列表 DOM", async () => {
    ipc.historyGroups.mockResolvedValue({
      items: [
        {
          source_id: "codex",
          instance_id: null,
          instance_key: null,
          display_name: null,
          count: 25,
        },
      ],
      truncated: false,
    });

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    fireEvent.click(screen.getByText("Codex CLI"));

    const toggle = screen.getByRole("button", { name: "历史会话分区" });
    await waitFor(() => expect(toggle.textContent).toContain("25"));
    // 准确数量来自后端分组 COUNT，不是快照切片，也不逐实例请求。
    expect(ipc.historyGroups).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "codex" }),
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // 折叠态不渲染历史会话与分页按钮。
    expect(screen.queryByText("历史会话 0")).toBeNull();
    expect(screen.queryByRole("button", { name: "显示更多历史" })).toBeNull();
  });

  it("展开历史分区按 10 条分页，显示更多使用 next_cursor", async () => {
    ipc.historyGroups.mockResolvedValue({
      items: [
        {
          source_id: "codex",
          instance_id: null,
          instance_key: null,
          display_name: null,
          count: 25,
        },
      ],
      truncated: false,
    });
    ipc.historySessions.mockImplementation(
      (opts: { limit?: number; cursor?: string } = {}) => {
        if (opts.cursor === "cursor-1") {
          return Promise.resolve({
            items: Array.from({ length: 10 }, (_, i) => historyItem(i + 10)),
            total: 25,
            next_cursor: null,
          });
        }
        return Promise.resolve({
          items: Array.from({ length: 10 }, (_, i) => historyItem(i)),
          total: 25,
          next_cursor: "cursor-1",
        });
      },
    );

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    fireEvent.click(screen.getByText("Codex CLI"));

    // 实时会话仍在快照层直接显示；折叠态数量来自分组 COUNT。
    expect(screen.getByText("Fix bug")).toBeTruthy();
    await waitFor(() => expect(ipc.historyGroups).toHaveBeenCalled());
    expect(screen.queryByText("历史会话 0")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "历史会话分区" }));
    expect(await screen.findByText("历史会话 0")).toBeTruthy();
    const pageCalls = () =>
      ipc.historySessions.mock.calls.filter((c) => c[0]?.limit === 10);
    expect(pageCalls()).toHaveLength(1);
    expect(pageCalls()[0][0]).toEqual(
      expect.objectContaining({ sourceId: "codex", unassigned: true, limit: 10 }),
    );
    expect(screen.getByText("历史会话 9")).toBeTruthy();
    expect(screen.queryByText("历史会话 10")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "显示更多历史" }));
    expect(await screen.findByText("历史会话 10")).toBeTruthy();
    expect(pageCalls()).toHaveLength(2);
    expect(pageCalls()[1][0]).toEqual(expect.objectContaining({ cursor: "cursor-1", limit: 10 }));
    expect(screen.getByText("历史会话 19")).toBeTruthy();
    // 没有更多时不再显示「显示更多」
    expect(screen.queryByRole("button", { name: "显示更多历史" })).toBeNull();
  });

  it("来源/实例没有近期快照会话时，仍按真实历史分组显示入口", async () => {
    // Trae 在快照里没有 sessions/instances（connected=false），但历史有真实实例与未关联记录。
    ipc.historyGroups.mockImplementation(async (query: { sourceId?: string } = {}) => {
      if (query.sourceId !== "trae") return { items: [], truncated: false };
      return {
        items: [
          {
            source_id: "trae",
            instance_id: "trae-inst-old",
            instance_key: "Trae 旧实例",
            display_name: "Trae 旧实例",
            count: 3,
          },
          {
            source_id: "trae",
            instance_id: null,
            instance_key: null,
            display_name: null,
            count: 2,
          },
        ],
        truncated: false,
      };
    });
    ipc.historySessions.mockResolvedValue({ items: [], total: 0, next_cursor: null });

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    // 默认「需关注」隐藏空闲 Trae；切到全部后展开。
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.click(await screen.findByText("Trae"));

    // 快照里没有这个实例，但历史分组给出真实 instance_key，不能丢入口。
    expect(await screen.findByText("Trae 旧实例")).toBeTruthy();
    expect(await screen.findByText("未关联实例")).toBeTruthy();

    fireEvent.click(screen.getByText("Trae 旧实例"));
    const toggles = await screen.findAllByRole("button", { name: "历史会话分区" });
    await waitFor(() => expect(toggles.some((el) => el.textContent?.includes("3"))).toBe(true));
    expect(toggles.some((el) => el.textContent?.includes("2"))).toBe(true);
  });

  it("历史数量与实时树一致：实时会话不进入历史 COUNT/第一页", async () => {
    const base = snapshot();
    // 一个实时会话 + 后端历史页只返回历史项；前端不得再按 liveIds 过滤 total。
    ipc.historyGroups.mockResolvedValue({
      items: [
        {
          source_id: "codex",
          instance_id: null,
          instance_key: null,
          display_name: null,
          count: 12,
        },
      ],
      truncated: false,
    });
    ipc.historySessions.mockResolvedValue({
      items: Array.from({ length: 10 }, (_, i) => historyItem(i)),
      total: 12,
      next_cursor: "history-cursor",
    });
    useAgentsStore.setState({ snapshot: base, snapshotError: null });

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    fireEvent.click(screen.getByText("Codex CLI"));
    expect(screen.getByText("Fix bug")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "历史会话分区" }));

    expect(await screen.findByText("历史会话 0")).toBeTruthy();
    expect(screen.getAllByText("历史会话 0")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "显示更多历史" })).toBeTruthy();
  });

  it("历史分区保留真实实例筛选（instanceId 而非伪造实例）", async () => {
    const base = snapshot();
    base.instances = [
      {
        id: "inst-a",
        source_id: "codex",
        instance_key: "VS Code",
        display_name: "实例 A",
        exe_path: "",
        first_seen_at: ago(10),
        last_seen_at: ago(5),
      },
    ];
    base.sessions = [
      { ...base.sessions[0], instance_id: "inst-a" },
    ];
    useAgentsStore.setState({ snapshot: base, snapshotError: null });
    ipc.historyGroups.mockResolvedValue({
      items: [
        {
          source_id: "codex",
          instance_id: "inst-a",
          instance_key: "VS Code",
          display_name: "实例 A",
          count: 1,
        },
      ],
      truncated: false,
    });
    ipc.historySessions.mockResolvedValue({
      items: [historyItem(0, { instance_id: "inst-a" })],
      total: 1,
      next_cursor: null,
    });

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    fireEvent.click(screen.getByText("Codex CLI"));
    fireEvent.click(screen.getByText("VS Code"));
    fireEvent.click(screen.getByRole("button", { name: "历史会话分区" }));

    await waitFor(() =>
      expect(ipc.historySessions).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: "codex", instanceId: "inst-a" }),
      ),
    );
    expect(await screen.findByText("历史会话 0")).toBeTruthy();
  });

  it("快照未命中时按会话 ID 走后端定位，展开真实历史分区并保留展开状态", async () => {
    const outside = historyItem(99, {
      id: "hist-outside",
      title: "快照外的历史会话",
      external_id: "ext-outside",
      instance_id: null,
      run_count: 2,
    });
    ipc.historySession.mockResolvedValue(outside);
    ipc.historyGroups.mockResolvedValue({
      items: [
        {
          source_id: "codex",
          instance_id: null,
          instance_key: null,
          display_name: null,
          count: 1,
        },
      ],
      truncated: false,
    });
    ipc.historySessions.mockResolvedValue({
      items: [outside],
      total: 1,
      next_cursor: null,
    });

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");

    act(() => {
      useUiStore.setState({
        agentFocus: { sourceId: "codex", sessionId: "hist-outside", refId: null, token: 7 },
      });
    });

    // 快照中没有该会话：必须用后端按 ID 精确定位，并出现在真实分类（未关联实例）下。
    expect(await screen.findByText("快照外的历史会话")).toBeTruthy();
    expect(ipc.historySession).toHaveBeenCalledWith("hist-outside");
    expect(ipc.historySessions).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "codex", unassigned: true, limit: 10 }),
    );
    const toggle = screen.getByRole("button", { name: "历史会话分区" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("1");

    // 清理 agentFocus 后，历史分区保持展开、定位行仍可见（展开状态不被清除）。
    await waitFor(() => expect(useUiStore.getState().agentFocus).toBeNull());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("快照外的历史会话")).toBeTruthy();
  });

  it("快照外实例的定位落在真实历史实例下，不误归未关联", async () => {
    const outside = historyItem(100, {
      id: "hist-inst",
      title: "快照外实例会话",
      instance_id: "inst-hist",
    });
    ipc.historySession.mockResolvedValue(outside);
    ipc.historyGroups.mockResolvedValue({
      items: [
        {
          source_id: "codex",
          instance_id: "inst-hist",
          instance_key: "deep-instance",
          display_name: "深层实例",
          count: 1,
        },
      ],
      truncated: false,
    });
    ipc.historySessions.mockImplementation(async (query) =>
      query && query.instanceId === "inst-hist"
        ? { items: [outside], total: 1, next_cursor: null }
        : { items: [], total: 0, next_cursor: null },
    );

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    act(() => {
      useUiStore.setState({
        agentFocus: { sourceId: "codex", sessionId: "hist-inst", refId: null, token: 8 },
      });
    });

    expect(await screen.findByText("快照外实例会话")).toBeTruthy();
    expect(screen.getByText("deep-instance")).toBeTruthy();
    expect(ipc.historySessions).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "codex", instanceId: "inst-hist", limit: 10 }),
    );
    expect(ipc.historySessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ unassigned: true }),
    );
  });

  it("搜索走后端分页并显示真实来源/实例；旧响应不得覆盖新筛选", async () => {
    const base = snapshot();
    base.instances = [
      {
        id: "inst-a",
        source_id: "codex",
        instance_key: "VS Code",
        display_name: "实例 A",
        exe_path: "",
        first_seen_at: ago(10),
        last_seen_at: ago(5),
      },
    ];
    useAgentsStore.setState({ snapshot: base, snapshotError: null });

    const oldResponse = deferred<HistoryPage>();
    const newResponse = deferred<HistoryPage>();
    ipc.historySessions.mockImplementation((opts: { keyword?: string } = {}) => {
      const keyword = opts.keyword;
      if (keyword === "old") return oldResponse.promise;
      if (keyword === "new") return newResponse.promise;
      return Promise.resolve({ items: [], total: 0, next_cursor: null });
    });

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");

    fireEvent.change(searchInput(), { target: { value: "old" } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 340));
    });
    expect(
      ipc.historySessions.mock.calls.some((c) => c[0]?.keyword === "old"),
    ).toBe(true);

    fireEvent.change(searchInput(), { target: { value: "new" } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 340));
    });

    // 新筛选先返回：显示新结果
    await act(async () => {
      newResponse.resolve({
        items: [historyItem(7, { title: "新筛选命中" })],
        total: 1,
        next_cursor: null,
      });
    });
    expect(await screen.findByText("新筛选命中")).toBeTruthy();

    // 旧筛选的迟到响应必须丢弃，不能覆盖当前搜索词
    await act(async () => {
      oldResponse.resolve({
        items: [historyItem(8, { title: "旧筛选迟到结果" })],
        total: 1,
        next_cursor: null,
      });
    });
    expect(screen.queryByText("旧筛选迟到结果")).toBeNull();

    const searchRegion = screen.getByRole("region", { name: "历史搜索结果" });
    expect(within(searchRegion).getByText("共 1 条")).toBeTruthy();
    expect(within(searchRegion).getByText("Codex CLI · 未关联实例")).toBeTruthy();
  });

  it("搜索结果按游标加载更多，总数仍取后端 total", async () => {
    ipc.historySessions
      .mockResolvedValueOnce({
        items: [historyItem(1, { title: "命中一" })],
        total: 3,
        next_cursor: "search-cursor",
      })
      .mockResolvedValueOnce({
        items: [
          historyItem(2, { title: "命中二" }),
          historyItem(3, { title: "命中三" }),
        ],
        total: 3,
        next_cursor: null,
      });

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    fireEvent.change(searchInput(), { target: { value: "命中" } });

    expect(await screen.findByText("命中一")).toBeTruthy();
    const searchRegion = screen.getByRole("region", { name: "历史搜索结果" });
    expect(within(searchRegion).getByText("共 3 条")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "显示更多结果" }));
    expect(await screen.findByText("命中二")).toBeTruthy();
    expect(screen.getByText("命中三")).toBeTruthy();
    expect(ipc.historySessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ keyword: "命中", cursor: "search-cursor" }),
    );
    expect(screen.queryByRole("button", { name: "显示更多结果" })).toBeNull();
  });

  it("会话展开才按需加载轮次，并按游标显示更多", async () => {
    ipc.historyRuns
      .mockResolvedValueOnce({
        items: [historyRun(0), historyRun(1)],
        total: 12,
        next_cursor: "run-cursor",
      })
      .mockResolvedValueOnce({
        items: Array.from({ length: 10 }, (_, i) => historyRun(i + 2)),
        total: 12,
        next_cursor: null,
      });

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    fireEvent.click(screen.getByText("Codex CLI"));

    // 会话未展开：不得提前拉轮次。
    expect(ipc.historyRuns).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Fix bug"));
    await waitFor(() => expect(ipc.historyRuns).toHaveBeenCalledWith("s1", null, 10, false, false));

    const runToggle = screen.getByRole("button", { name: "历史轮次分区" });
    expect(runToggle.textContent).toContain("12");
    fireEvent.click(runToggle);
    expect(screen.getByText("历史轮次任务 0")).toBeTruthy();
    expect(screen.queryByText("历史轮次任务 2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "显示更多轮次" }));
    expect(await screen.findByText("历史轮次任务 2")).toBeTruthy();
    expect(ipc.historyRuns).toHaveBeenLastCalledWith("s1", "run-cursor", 10, false, false);
    expect(screen.queryByRole("button", { name: "显示更多轮次" })).toBeNull();
  });
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
  it("搜索可越过「需关注」筛选命中空闲 Agent；清空后恢复当前筛选", async () => {
    render(<AgentPanel />);
    await screen.findByText("Codex CLI");

    // 默认「需关注」只显示有实时轮次的 Codex
    expect(screen.queryByText("Trae")).toBeNull();

    // 搜索是显式查找：空闲 Trae 也能被命中（便于找历史会话），Codex 被搜索过滤
    fireEvent.change(searchInput(), { target: { value: "trae" } });
    expect(screen.getByText("Trae")).toBeTruthy();
    expect(screen.queryByText("Codex CLI")).toBeNull();

    // 切到「全部」不影响当前搜索词
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

describe("历史分组截断的可访问性（P2-02）", () => {
  it("分组截断时说明可搜索访问全部历史，按钮聚焦面板搜索框", async () => {
    ipc.historyGroups.mockResolvedValue({
      items: Array.from({ length: 3 }, (_, i) => ({
        source_id: "codex",
        instance_id: `inst-${i}`,
        instance_key: `instance-${i}`,
        display_name: `实例 ${i}`,
        count: 1,
      })),
      truncated: true,
    });

    render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    fireEvent.click(screen.getByText("Codex CLI"));

    const hint = await screen.findByText(/历史实例过多/);
    expect(hint.textContent).toContain("3");
    expect(hint.textContent).toContain("可用搜索访问全部历史");
    const btn = screen.getByRole("button", { name: "搜索历史记录" });
    fireEvent.click(btn);
    // 不新增第二个输入框：焦点交给面板顶部既有的监控/历史搜索输入框
    expect(document.activeElement).toBe(searchInput());
  });
});

describe("历史列表更新反馈（agent-changed 轻量探测）", () => {
  function groupOf(count: number) {
    return {
      items: [
        { source_id: "codex", instance_id: null, instance_key: null, display_name: null, count },
      ],
      truncated: false,
    };
  }

  function histItem(i: number, overrides: Record<string, unknown> = {}) {
    return {
      id: `hist-${i}`,
      source_id: "codex",
      external_id: `ext-hist-${i}`,
      title: `历史会话 ${i}`,
      status: "completed",
      first_seen_at: ago(600 + i),
      last_seen_at: ago(500 + i),
      last_run_id: null,
      instance_id: null,
      run_count: 1,
      ...overrides,
    };
  }

  function pageOf(n: number, total = n) {
    return {
      items: Array.from({ length: n }, (_, i) => histItem(i)),
      total,
      next_cursor: null,
    };
  }

  const probes = () => ipc.historySessions.mock.calls.filter((c) => c[0]?.limit === 1);

  /** 展开 Codex → 展开未关联实例的历史分区，等首屏历史页落地。 */
  async function openHistorySection() {
    render(<AgentPanel />);
    await act(async () => {}); // 初始扫描等 promise 落地
    fireEvent.click(screen.getByText("Codex CLI"));
    fireEvent.click(screen.getByRole("button", { name: "历史会话分区" }));
    await act(async () => {}); // 首屏历史页落地
    expect(screen.getByText("历史会话 0")).toBeTruthy();
  }

  it("展开历史分区后同 source 事件触发一次去抖探测，头部不同则提示更新", async () => {
    vi.useFakeTimers();
    try {
      ipc.historyGroups.mockResolvedValue(groupOf(11));
      ipc.historySessions.mockImplementation((opts: { limit?: number } = {}) => {
        if (opts.limit === 1) {
          return Promise.resolve({
            items: [histItem(0, { id: "hist-new", title: "新完成的历史会话", last_seen_at: ago(1) })],
            total: 11,
            next_cursor: null,
          });
        }
        return Promise.resolve(pageOf(10, 11));
      });

      await openHistorySection();
      expect(screen.queryByRole("button", { name: /有新的历史记录/ })).toBeNull();

      emitAgentChanged({ source_id: "codex", session_id: "hist-new" });
      // 800ms 去抖：窗口内不探测
      await act(async () => {
        vi.advanceTimersByTime(799);
      });
      expect(probes()).toHaveLength(0);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      // 一批事件只发一次 limit=1 的轻量探测（不是全量刷新）
      expect(probes()).toHaveLength(1);
      expect(probes()[0][0]).toEqual(
        expect.objectContaining({ sourceId: "codex", unassigned: true, limit: 1 }),
      );
      await act(async () => {});
      expect(screen.getByRole("button", { name: /有新的历史记录/ })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("去抖窗口内的多次事件只探测一次", async () => {
    vi.useFakeTimers();
    try {
      ipc.historyGroups.mockResolvedValue(groupOf(11));
      ipc.historySessions.mockImplementation((opts: { limit?: number } = {}) =>
        opts.limit === 1
          ? Promise.resolve({
              items: [histItem(50, { id: "hist-new", title: "新完成的历史会话" })],
              total: 11,
              next_cursor: null,
            })
          : Promise.resolve(pageOf(10, 11)),
      );
      await openHistorySection();

      emitAgentChanged({ source_id: "codex", session_id: "x1" });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      emitAgentChanged({ source_id: "codex", session_id: "x2" });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      emitAgentChanged({ source_id: "codex", session_id: "x3" });
      await act(async () => {
        vi.advanceTimersByTime(799);
      });
      expect(probes()).toHaveLength(0);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(probes()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("点击「更新」按正常 pageSize 重拉，提示消失，已展开会话保留且不重复", async () => {
    vi.useFakeTimers();
    try {
      let pageLoads = 0;
      ipc.historyGroups.mockResolvedValue(groupOf(11));
      ipc.historySessions.mockImplementation((opts: { limit?: number } = {}) => {
        if (opts.limit === 1) {
          return Promise.resolve({
            items: [histItem(0, { id: "hist-new", title: "新完成的历史会话" })],
            total: 11,
            next_cursor: null,
          });
        }
        pageLoads += 1;
        if (pageLoads === 1) return Promise.resolve(pageOf(10, 11));
        // 更新后的新第一页不再包含 hist-3
        return Promise.resolve({
          items: Array.from({ length: 10 }, (_, i) =>
            histItem(100 + i, { title: `新页历史会话 ${i}` }),
          ),
          total: 11,
          next_cursor: null,
        });
      });
      await openHistorySection();

      // 展开一条历史会话（hist-3）
      fireEvent.click(screen.getByText("历史会话 3"));
      await act(async () => {});

      emitAgentChanged({ source_id: "codex", session_id: "hist-new" });
      await act(async () => {
        vi.advanceTimersByTime(800);
      });
      await act(async () => {});
      expect(screen.getByRole("button", { name: /有新的历史记录/ })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /有新的历史记录/ }));
      await act(async () => {});

      // 提示消失；以正常 pageSize（无 cursor）重新拉取
      expect(screen.queryByRole("button", { name: /有新的历史记录/ })).toBeNull();
      const reloads = ipc.historySessions.mock.calls.filter(
        (c) => c[0]?.limit === 10 && !c[0]?.cursor,
      );
      expect(reloads).toHaveLength(2);
      expect(reloads[1][0]).toEqual(
        expect.objectContaining({ sourceId: "codex", unassigned: true, limit: 10 }),
      );

      // 新第一页渲染；hist-3 不在新页但因已展开被保留在列表中，且只出现一次
      expect(screen.getByText("新页历史会话 0")).toBeTruthy();
      expect(screen.getAllByText("历史会话 3")).toHaveLength(1);
      expect(screen.queryByText("历史会话 0")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("其他 source 的事件不触发探测", async () => {
    vi.useFakeTimers();
    try {
      ipc.historyGroups.mockResolvedValue(groupOf(10));
      ipc.historySessions.mockImplementation((opts: { limit?: number } = {}) =>
        opts.limit === 1
          ? Promise.resolve({ items: [histItem(99)], total: 10, next_cursor: null })
          : Promise.resolve(pageOf(10, 10)),
      );
      await openHistorySection();

      emitAgentChanged({ source_id: "trae", sources: ["trae"], session_id: "t-1" });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      await act(async () => {});
      expect(probes()).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /有新的历史记录/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("探测头部相同则不提示", async () => {
    vi.useFakeTimers();
    try {
      ipc.historyGroups.mockResolvedValue(groupOf(10));
      ipc.historySessions.mockImplementation((opts: { limit?: number } = {}) =>
        opts.limit === 1
          ? Promise.resolve({ items: [histItem(0)], total: 10, next_cursor: null })
          : Promise.resolve(pageOf(10, 10)),
      );
      await openHistorySection();

      emitAgentChanged({ source_id: "codex", session_id: "hist-0" });
      await act(async () => {
        vi.advanceTimersByTime(800);
      });
      await act(async () => {});
      expect(probes()).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /有新的历史记录/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("组件卸载后退订 agent-changed，迟到事件不引发状态更新", async () => {
    ipc.historyGroups.mockResolvedValue(groupOf(10));
    ipc.historySessions.mockResolvedValue(pageOf(10, 10));
    const { unmount } = render(<AgentPanel />);
    await screen.findByText("Codex CLI");
    fireEvent.click(screen.getByText("Codex CLI"));
    fireEvent.click(screen.getByRole("button", { name: "历史会话分区" }));
    await screen.findByText("历史会话 0");
    expect(ipc.onAgentChanged).toHaveBeenCalled();
    expect(agentChangedHandlers.length).toBe(1);
    const staleCb = agentChangedHandlers[0];

    unmount();
    await waitFor(() => expect(unlistenAgentChanged).toHaveBeenCalled());
    expect(agentChangedHandlers).toHaveLength(0);

    // 卸载后再派发（队列残留回调 + 重新派发）：监听已移除/已置 disposed，无报错
    expect(() =>
      act(() => {
        staleCb?.({
          source_id: "codex",
          sources: ["codex"],
          session_id: "late",
          states: {},
          batch: 1,
          changed: true,
          deduplicated: false,
          late: false,
        });
      }),
    ).not.toThrow();
    expect(() => emitAgentChanged({ source_id: "codex", session_id: "late" })).not.toThrow();
  });
});

describe("实时监控容量续页", () => {
  it("显示超出快照的旧 waiting 会话，并可分页查看其实时轮次", async () => {
    const base = snapshot();
    const counts = {
      active_session_total: 201,
      session_total: 201,
      run_total: 301,
      running: 0,
      waiting: 301,
      failed: 0,
      disconnected: 0,
    };
    useAgentsStore.setState({
      snapshot: {
        ...base,
        live_summary: {
          ...counts,
          by_source: { codex: counts },
          sessions_truncated: true,
          runs_truncated: true,
          next_cursor: "snapshot-cursor",
        },
      },
      snapshotError: null,
    });
    ipc.historySessions.mockResolvedValue({
      items: [{
        id: "overflow-session",
        source_id: "codex",
        external_id: "old-waiting-session",
        title: "快照外的旧 waiting 会话",
        status: "idle",
        first_seen_at: ago(500),
        last_seen_at: ago(400),
        last_run_id: "overflow-run",
        instance_id: null,
        run_count: 301,
        live_state: "waiting",
        live_run_count: 301,
      }],
      total: 201,
      next_cursor: null,
    });
    ipc.historyRuns.mockResolvedValue({
      items: [{
        id: "overflow-run",
        session_id: "overflow-session",
        source_id: "codex",
        external_run_id: "run-301",
        task_title: "快照外等待任务详情",
        status: "waiting",
        started_at: ago(401),
        updated_at: ago(400),
        ended_at: null,
        pending_items: [],
        instance_id: null,
      }],
      total: 301,
      next_cursor: "run-cursor",
    });

    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("button", { name: "查看更多实时会话" }));
    await screen.findByText("快照外的旧 waiting 会话");
    expect(ipc.historySessions).toHaveBeenCalledWith({
      liveOnly: true,
      cursor: "snapshot-cursor",
      limit: 20,
    });

    fireEvent.click(screen.getByText("快照外的旧 waiting 会话"));
    await screen.findByText("快照外等待任务详情");
    expect(ipc.historyRuns).toHaveBeenCalledWith(
      "overflow-session",
      null,
      50,
      false,
      true,
    );
  });

  it("单个快照会话的实时轮次超量时提供有界分页入口", async () => {
    const base = snapshot();
    base.sessions[0].live_run_count = 2;
    useAgentsStore.setState({
      snapshot: {
        ...base,
        live_summary: {
          active_session_total: 1,
          session_total: 1,
          run_total: 2,
          running: 1,
          waiting: 1,
          failed: 0,
          disconnected: 0,
          by_source: {
            codex: {
              active_session_total: 1,
              session_total: 1,
              run_total: 2,
              running: 1,
              waiting: 1,
              failed: 0,
              disconnected: 0,
            },
          },
          sessions_truncated: false,
          runs_truncated: true,
          next_cursor: null,
        },
      },
      snapshotError: null,
    });
    ipc.historyRuns.mockResolvedValue({
      items: [{
        id: "r2",
        session_id: "s1",
        source_id: "codex",
        external_run_id: "run-2",
        task_title: "分页实时轮次",
        status: "waiting",
        started_at: ago(2),
        updated_at: ago(1),
        ended_at: null,
        pending_items: [],
        instance_id: null,
      }],
      total: 2,
      next_cursor: null,
    });

    render(<AgentPanel />);
    fireEvent.click(screen.getByText("Codex CLI"));
    fireEvent.click(screen.getByText("Fix bug"));
    fireEvent.click(await screen.findByRole("button", {
      name: "分页查看全部实时轮次（共 2 条）",
    }));

    await screen.findByText("分页实时轮次");
    expect(ipc.historyRuns).toHaveBeenCalledWith("s1", null, 50, false, true);
  });
});
