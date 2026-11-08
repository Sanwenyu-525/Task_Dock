//! useGlobalSearchStore 单测：防抖/乱序防护/最近搜索/分类过滤/跳转分发。
/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const globalSearchMock = vi.fn(
  (..._args: unknown[]) => Promise.resolve(undefined) as Promise<unknown>,
);
const navNavigateMock = vi.fn(
  (_id: unknown, _opts?: unknown) => Promise.resolve({ status: "launched" }),
);

vi.mock("../lib/globalSearchBridge", () => ({
  GLOBAL_SEARCH_CATEGORIES: [
    "tasks",
    "clipboard",
    "capture",
    "shelf",
    "apps",
    "agents",
    "workspace",
    "planning",
  ],
  GLOBAL_SEARCH_CATEGORY_LABELS: { all: "全部", tasks: "任务" },
  GLOBAL_SEARCH_KIND_LABELS: {},
  globalSearch: (q: unknown, c: unknown, l: unknown) => globalSearchMock(q, c, l),
  RECENT_SEARCH_KEY: "taskdock.global_search.recent",
  RECENT_SEARCH_MAX: 10,
  loadRecentSearches: () => [],
  saveRecentSearch: (q: string, existing: string[]) => [q, ...existing].slice(0, 10),
  persistRecentSearches: () => {},
  clearRecentSearches: () => {},
}));

vi.mock("../lib/navigation", () => ({
  navNavigate: (id: unknown, opts: unknown) => navNavigateMock(id, opts),
}));

import { useGlobalSearchStore, resetGlobalSearchTimers } from "./useGlobalSearchStore";
import { useUiStore } from "./useUiStore";
import { useScenarioStore } from "./useScenarioStore";
import { useWorkflowsStore } from "./useWorkflowsStore";
import { SETTINGS_SECTION_REVEAL_KEY } from "../lib/settingsSections";
import { buildStaticCommands, type CommandDef } from "../lib/commandRegistry";
import type { WorkflowRunDetail } from "../lib/bridge";

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetGlobalSearchTimers();
  useGlobalSearchStore.setState({
    open: false,
    query: "",
    activeCategory: "all",
    results: null,
    loading: false,
    error: null,
    activeIndex: 0,
    recent: [],
    pendingLocate: null,
    notice: null,
    commands: [],
  });
  useUiStore.setState({ tab: "tasks", agentFocus: null, toasts: [], toast: null });
  // 动态实体数据源：默认「已加载且为空」（不触发 IPC，水合走降级路径）。
  useScenarioStore.setState({ summaries: [], loaded: true, loading: false, enteringId: null, error: null });
  useWorkflowsStore.setState({ workflows: [], workflowsLoading: false, workflowsError: null, activeRun: null });
  globalSearchMock.mockReset();
  navNavigateMock.mockClear();
});

describe("查询与乱序防护", () => {
  it("setQuery 空白输入立即清结果且不发请求", () => {
    useGlobalSearchStore.getState().setQuery("   ");
    expect(globalSearchMock).not.toHaveBeenCalled();
    expect(useGlobalSearchStore.getState().results).toBeNull();
  });

  it("setQuery 防抖后发起一次查询", async () => {
    globalSearchMock.mockResolvedValue({ query: "登录", groups: [], total_returned: 0 });
    useGlobalSearchStore.getState().setQuery("登录");
    expect(globalSearchMock).not.toHaveBeenCalled(); // 未到防抖窗口
    await flush(320);
    expect(globalSearchMock).toHaveBeenCalledTimes(1);
    expect(globalSearchMock).toHaveBeenCalledWith("登录", null, null);
  });

  it("旧响应不覆盖新结果（seq 防乱序）", async () => {
    // 第一次查询响应挂起（旧），第二次查询立即返回（新）；旧响应迟到时必须被丢弃。
    let resolveStale: (v: unknown) => void = () => {};
    globalSearchMock.mockImplementationOnce(() => new Promise((r) => (resolveStale = r)));
    globalSearchMock.mockResolvedValueOnce({
      query: "登录页",
      groups: [{ category: "tasks", items: [{ id: "t1" }], has_more: false }],
      total_returned: 1,
    });
    useGlobalSearchStore.setState({ query: "登录" });
    void useGlobalSearchStore.getState().retry(); // 旧查询（挂起）
    useGlobalSearchStore.setState({ query: "登录页" });
    void useGlobalSearchStore.getState().retry(); // 新查询（立即返回）
    await flush(20);
    expect(useGlobalSearchStore.getState().results?.total_returned).toBe(1);
    // 迟到的旧响应
    resolveStale({ query: "登录", groups: [{ category: "tasks", items: [{ id: "old" }], has_more: false }], total_returned: 99 });
    await flush(20);
    expect(useGlobalSearchStore.getState().results?.total_returned).toBe(1);
  });

  it("查询失败保留旧结果并记录 error", async () => {
    globalSearchMock.mockResolvedValueOnce({ query: "登录", groups: [{ category: "tasks", items: [{ id: "t1" }], has_more: false }], total_returned: 1 });
    useGlobalSearchStore.getState().setQuery("登录");
    await flush(320);
    globalSearchMock.mockRejectedValueOnce(new Error(" boom"));
    useGlobalSearchStore.getState().setQuery("登录页");
    await flush(320);
    const s = useGlobalSearchStore.getState();
    expect(s.error).toBeTruthy();
    expect(s.results?.total_returned).toBe(1); // 旧数据保留
  });
});

describe("分类筛选", () => {
  it("选择分类后只查询该类别", async () => {
    globalSearchMock.mockResolvedValue({ query: "登录", groups: [], total_returned: 0 });
    useGlobalSearchStore.getState().setQuery("登录");
    await flush(320);
    useGlobalSearchStore.getState().setActiveCategory("tasks");
    await flush(20);
    expect(globalSearchMock).toHaveBeenLastCalledWith("登录", ["tasks"], null);
  });
});

describe("openResult 跳转分发", () => {
  it("任务结果 → setTab(tasks) + pendingLocate", () => {
    useGlobalSearchStore.setState({ query: "登录" });
    useGlobalSearchStore.getState().openResult({
      id: "t1", category: "tasks", kind: "task", title: "", subtitle: "", snippet: "",
      occurred_at: null, status: null, priority: null, target_id: "t1", parent_id: null,
    });
    const s = useGlobalSearchStore.getState();
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(s.pendingLocate?.category).toBe("tasks");
    expect(s.pendingLocate?.id).toBe("t1");
    expect(s.open).toBe(false); // 弹窗关闭
  });

  it("Agent 轮次结果 → focusAgent(sourceId, sessionId, refId=runId)", () => {
    useGlobalSearchStore.setState({ query: "登录" });
    useGlobalSearchStore.getState().openResult({
      id: "run1", category: "agents", kind: "run", title: "", subtitle: "", snippet: "",
      occurred_at: null, status: null, priority: null, target_id: "sess1", parent_id: "src1",
    });
    const focus = useUiStore.getState().agentFocus;
    expect(useUiStore.getState().tab).toBe("agents");
    expect(focus?.sourceId).toBe("src1");
    expect(focus?.sessionId).toBe("sess1");
    expect(focus?.refId).toBe("run1");
  });

  it("应用结果 → navNavigate(focus_or_launch)；失败回显 notice", async () => {
    navNavigateMock.mockRejectedValueOnce(new Error("目标不可用"));
    useGlobalSearchStore.setState({ query: "登录" });
    useGlobalSearchStore.getState().openResult({
      id: "n1", category: "apps", kind: "application", title: "", subtitle: "", snippet: "",
      occurred_at: null, status: null, priority: null, target_id: "n1", parent_id: null,
    });
    await flush(20);
    expect(navNavigateMock).toHaveBeenCalledWith("n1", { action: "focus_or_launch" });
    expect(useGlobalSearchStore.getState().notice).toContain("启动失败");
  });

  it("结果点击记录最近搜索并去重置顶", () => {
    useGlobalSearchStore.setState({ query: "登录", recent: ["剪贴板"] });
    useGlobalSearchStore.getState().openResult({
      id: "t1", category: "tasks", kind: "task", title: "", subtitle: "", snippet: "",
      occurred_at: null, status: null, priority: null, target_id: "t1", parent_id: null,
    });
    expect(useGlobalSearchStore.getState().recent).toEqual(["登录", "剪贴板"]);
  });
});

describe("定位意图消费", () => {
  it("consumeLocate 清除意图", () => {
    useGlobalSearchStore.setState({
      pendingLocate: { category: "tasks", id: "t1", kind: "task", parentId: null, keyword: "登录", token: 1 },
    });
    useGlobalSearchStore.getState().consumeLocate();
    expect(useGlobalSearchStore.getState().pendingLocate).toBeNull();
  });

  it("Agent 会话关联 → 切换规划中心并定位真实功能", () => {
    const request = useGlobalSearchStore.getState().requestPlanningFeatureLocate;
    request("feature-1", "project-1");
    const first = useGlobalSearchStore.getState().pendingLocate;
    expect(useUiStore.getState().tab).toBe("roadmap");
    expect(first).toMatchObject({
      category: "planning",
      id: "feature-1",
      kind: "feature",
      parentId: "project-1",
    });

    request("feature-1", "project-1");
    expect(useGlobalSearchStore.getState().pendingLocate?.token).toBeGreaterThan(first?.token ?? 0);
  });
});

describe("命令面板（全局搜索内的命令能力层）", () => {
  it("refreshCommands：空查询组装默认命令（创建类在前，无设置分组/动态实体）", () => {
    useGlobalSearchStore.getState().refreshCommands();
    const cmds = useGlobalSearchStore.getState().commands;
    expect(cmds[0].id).toBe("create.task");
    expect(cmds[1].id).toBe("create.reminder");
    expect(cmds.some((c) => c.group === "page")).toBe(true);
    expect(cmds.some((c) => c.group === "settings")).toBe(false);
    expect(cmds.some((c) => c.group === "scenario" || c.group === "workflow")).toBe(false);
  });

  it("setQuery 即时刷新命令（本地匹配，不等数据搜索防抖、不发请求）", () => {
    useGlobalSearchStore.getState().setQuery("剪贴");
    expect(useGlobalSearchStore.getState().commands.map((c) => c.id)).toContain("nav.clipboard");
    expect(globalSearchMock).not.toHaveBeenCalled();
    // 清空查询回到默认列表
    useGlobalSearchStore.getState().setQuery("  ");
    expect(useGlobalSearchStore.getState().commands[0].id).toBe("create.task");
  });

  it("hydrateCommands：动态列表水合后出现场景/工作流命令；列表为空时降级为静态命令", async () => {
    // 空列表：降级
    useGlobalSearchStore.getState().hydrateCommands();
    await flush(20);
    let cmds = useGlobalSearchStore.getState().commands;
    expect(cmds.some((c) => c.id === "create.task")).toBe(true);
    expect(cmds.some((c) => c.group === "scenario" || c.group === "workflow")).toBe(false);

    // 真实列表：动态命令出现（loaded=true / workflows 非空 → 不触发 load IPC）
    useScenarioStore.setState({
      summaries: [
        {
          id: "s1", name: "开工场景", icon: null, appCount: 0, urlCount: 0,
          folderCount: 0, linkedWorkflowId: null, lastEnteredAt: null,
          createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
        },
      ],
    });
    useWorkflowsStore.setState({
      workflows: [
        {
          id: "w1", name: "晨间流程", description: "", enabled: true, sort_order: 0,
          step_count: 1, created_at: "", updated_at: "", last_run_at: null,
        },
        {
          id: "w2", name: "停用流程", description: "", enabled: false, sort_order: 1,
          step_count: 1, created_at: "", updated_at: "", last_run_at: null,
        },
      ],
    });
    useGlobalSearchStore.setState({ query: "" });
    useGlobalSearchStore.getState().hydrateCommands();
    await flush(20);
    cmds = useGlobalSearchStore.getState().commands;
    // 空查询默认列表不含动态实体；输入名称才命中
    expect(cmds.some((c) => c.id === "scenario.s1")).toBe(false);
    useGlobalSearchStore.getState().setQuery("开工");
    expect(useGlobalSearchStore.getState().commands.map((c) => c.id)).toContain("scenario.s1");
    useGlobalSearchStore.getState().setQuery("晨间");
    expect(useGlobalSearchStore.getState().commands.map((c) => c.id)).toContain("workflow.w1");
    // 停用工作流不可运行：不进命令列表
    useGlobalSearchStore.getState().setQuery("停用流程");
    expect(useGlobalSearchStore.getState().commands.some((c) => c.id === "workflow.w2")).toBe(false);
  });

  it("moveActive 覆盖命令+数据的统一 flat 序（命令在前）", () => {
    useGlobalSearchStore.getState().refreshCommands(); // 默认命令 > 2 条
    const cmdCount = useGlobalSearchStore.getState().commands.length;
    useGlobalSearchStore.setState({
      results: {
        query: "登录",
        total_returned: 2,
        groups: [
          {
            category: "tasks",
            has_more: false,
            items: [
              {
                id: "t1", category: "tasks", kind: "task", title: "a", subtitle: "",
                snippet: "", occurred_at: null, status: null, priority: null,
                target_id: "t1", parent_id: null,
              },
              {
                id: "t2", category: "tasks", kind: "task", title: "b", subtitle: "",
                snippet: "", occurred_at: null, status: null, priority: null,
                target_id: "t2", parent_id: null,
              },
            ],
          },
        ],
      },
    });
    const s = useGlobalSearchStore.getState();
    expect(s.activeIndex).toBe(0);
    s.moveActive(cmdCount); // 跳到第一个数据结果
    expect(useGlobalSearchStore.getState().activeIndex).toBe(cmdCount);
    useGlobalSearchStore.getState().moveActive(1);
    expect(useGlobalSearchStore.getState().activeIndex).toBe(cmdCount + 1);
    // 循环回绕到命令组头部
    useGlobalSearchStore.getState().moveActive(1);
    expect(useGlobalSearchStore.getState().activeIndex).toBe(0);
  });

  it("moveActive 在指定数据分类下不计命令（与弹窗 showCommands 判定一致）", () => {
    useGlobalSearchStore.getState().refreshCommands();
    useGlobalSearchStore.setState({ activeCategory: "tasks" });
    useGlobalSearchStore.setState({
      results: {
        query: "登录",
        total_returned: 1,
        groups: [
          {
            category: "tasks",
            has_more: false,
            items: [
              {
                id: "t1", category: "tasks", kind: "task", title: "a", subtitle: "",
                snippet: "", occurred_at: null, status: null, priority: null,
                target_id: "t1", parent_id: null,
              },
            ],
          },
        ],
      },
    });
    const s = useGlobalSearchStore.getState();
    s.moveActive(1); // total=1：回绕仍在 0
    expect(useGlobalSearchStore.getState().activeIndex).toBe(0);
  });

  it("executeCommand open-tab：切页并关闭弹窗", () => {
    useGlobalSearchStore.setState({ open: true });
    useGlobalSearchStore.getState().refreshCommands();
    const cmd = useGlobalSearchStore.getState().commands.find((c) => c.id === "nav.clipboard");
    expect(cmd).toBeTruthy();
    useGlobalSearchStore.getState().executeCommand(cmd!);
    expect(useGlobalSearchStore.getState().open).toBe(false);
    expect(useUiStore.getState().tab).toBe("clipboard");
  });

  it("executeCommand quick-add：任务页 + 聚焦快速录入（草稿类，不写数据）", () => {
    useGlobalSearchStore.setState({ open: true });
    useGlobalSearchStore.getState().refreshCommands();
    const cmd = useGlobalSearchStore.getState().commands.find((c) => c.id === "create.task");
    useGlobalSearchStore.getState().executeCommand(cmd!);
    const ui = useUiStore.getState();
    expect(ui.tab).toBe("tasks");
    expect(ui.quickAddToken).toBe(1);
    expect(useGlobalSearchStore.getState().open).toBe(false);
  });

  it("executeCommand open-settings-section：切设置页并下发分区展开定位意图", () => {
    useGlobalSearchStore.setState({ open: true });
    // 设置分组命令不在默认列表：从全量静态注册表取一条
    const settingsCmd = buildStaticCommands().find((c) => c.id === "settings.appearance");
    expect(settingsCmd).toBeTruthy();
    useGlobalSearchStore.getState().executeCommand(settingsCmd as CommandDef);
    expect(useGlobalSearchStore.getState().open).toBe(false);
    expect(useUiStore.getState().tab).toBe("settings");
    expect(sessionStorage.getItem(SETTINGS_SECTION_REVEAL_KEY)).toBe("appearance");
  });

  it("executeCommand run-workflow：切工作流页、发起运行并给出成功反馈", async () => {
    const runDetail = {
      id: "r1",
      workflow_id: "w1",
      workflow_name: "晨间流程",
      status: "running",
      current_step_index: 0,
      total_steps: 1,
      completed_steps: 0,
      started_at: "2026-11-08T00:00:00Z",
      finished_at: null,
      error: null,
      steps: [],
    } as WorkflowRunDetail;
    const runWorkflowMock = vi.fn(() => Promise.resolve(runDetail));
    useWorkflowsStore.setState({ runWorkflow: runWorkflowMock, workflows: [
      {
        id: "w1", name: "晨间流程", description: "", enabled: true, sort_order: 0,
        step_count: 1, created_at: "", updated_at: "", last_run_at: null,
      },
    ] });
    useGlobalSearchStore.setState({ open: true, query: "晨间" });
    useGlobalSearchStore.getState().refreshCommands();
    const cmd = useGlobalSearchStore
      .getState()
      .commands.find((c) => c.id === "workflow.w1");
    expect(cmd).toBeTruthy();
    useGlobalSearchStore.getState().executeCommand(cmd!);
    expect(useGlobalSearchStore.getState().open).toBe(false);
    expect(useUiStore.getState().tab).toBe("workflows");
    await flush(20);
    expect(runWorkflowMock).toHaveBeenCalledWith("w1");
    const toasts = useUiStore.getState().toasts;
    expect(toasts.some((t) => t.kind === "success" && t.message.includes("晨间流程"))).toBe(true);
  });

  it("executeCommand run-workflow 失败：错误 toast 如实回显，不伪装成功", async () => {
    const runWorkflowMock = vi.fn(() => Promise.reject(new Error("已有运行在执行")));
    useWorkflowsStore.setState({ runWorkflow: runWorkflowMock, workflows: [
      {
        id: "w1", name: "晨间流程", description: "", enabled: true, sort_order: 0,
        step_count: 1, created_at: "", updated_at: "", last_run_at: null,
      },
    ] });
    useGlobalSearchStore.setState({ open: true, query: "晨间" });
    useGlobalSearchStore.getState().refreshCommands();
    const cmd = useGlobalSearchStore.getState().commands.find((c) => c.id === "workflow.w1");
    useGlobalSearchStore.getState().executeCommand(cmd!);
    await flush(20);
    const toasts = useUiStore.getState().toasts;
    expect(toasts.some((t) => t.kind === "error" && t.message.includes("晨间流程"))).toBe(true);
  });

  it("executeCommand open-scenario：单飞占用时拒绝并提示；空闲时发起并汇总结果", async () => {
    const enterMock = vi.fn(() =>
      Promise.resolve({
        items: [
          { kind: "app" as const, label: "a", status: "ok" as const },
          { kind: "app" as const, label: "b", status: "failed" as const },
        ],
        startedAt: "2026-11-08T00:00:00Z",
        total: 2,
        cancelled: false,
        timedOut: false,
      }),
    );
    useScenarioStore.setState({
      enteringId: "s-other",
      enter: enterMock,
      summaries: [
        {
          id: "s1", name: "开工场景", icon: null, appCount: 0, urlCount: 0,
          folderCount: 0, linkedWorkflowId: null, lastEnteredAt: null,
          createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
        },
      ],
    });
    useGlobalSearchStore.setState({ open: true, query: "开工" });
    useGlobalSearchStore.getState().refreshCommands();
    const cmd = useGlobalSearchStore.getState().commands.find((c) => c.id === "scenario.s1");
    expect(cmd).toBeTruthy();
    useGlobalSearchStore.getState().executeCommand(cmd!);
    await flush(20);
    expect(enterMock).not.toHaveBeenCalled(); // 单飞占用：不发起、不排队
    expect(useUiStore.getState().toasts.some((t) => t.kind === "warning")).toBe(true);

    // 空闲：发起进入，完成后的 toast 汇总成功/未成功数量（1 成功 + 1 失败 → warning）
    useScenarioStore.setState({ enteringId: null });
    useUiStore.setState({ toasts: [], toast: null });
    useGlobalSearchStore.setState({ open: true });
    useGlobalSearchStore.getState().executeCommand(cmd!);
    expect(enterMock).toHaveBeenCalledWith("s1");
    await flush(20);
    const done = useUiStore.getState().toasts.find((t) => t.message.includes("进入完成"));
    expect(done).toBeTruthy();
    expect(done!.message).toContain("开工场景");
    expect(done!.message).toContain("成功 1 项，未成功 1 项");
    expect(done!.kind).toBe("warning");
  });
});
