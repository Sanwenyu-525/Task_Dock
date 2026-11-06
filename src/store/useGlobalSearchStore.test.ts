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
  });
  useUiStore.setState({ tab: "tasks", agentFocus: null });
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
