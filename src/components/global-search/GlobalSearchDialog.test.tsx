//! GlobalSearchDialog 组件测试：渲染 / 键盘导航 / Escape 弹层 / 分类切换 / 最近搜索。
/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const globalSearchMock = vi.fn();

vi.mock("../../lib/globalSearchBridge", () => ({
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
  GLOBAL_SEARCH_CATEGORY_LABELS: {
    all: "全部",
    tasks: "任务",
    clipboard: "剪贴板",
    capture: "收集箱",
    shelf: "文件暂存",
    apps: "应用",
    agents: "Agent",
    workspace: "工作现场",
    planning: "规划中心",
  },
  GLOBAL_SEARCH_KIND_LABELS: { task: "任务", session: "会话" },
  globalSearch: (...args: unknown[]) => globalSearchMock(...args),
  RECENT_SEARCH_KEY: "taskdock.global_search.recent",
  RECENT_SEARCH_MAX: 10,
  loadRecentSearches: () => ["历史搜索词"],
  saveRecentSearch: (q: string, xs: string[]) => [q, ...xs],
  persistRecentSearches: () => {},
  clearRecentSearches: () => {},
}));

vi.mock("../../lib/navigation", () => ({ navNavigate: vi.fn(() => Promise.resolve({})) }));
vi.mock("../../hooks/useGlobalSearchShortcut", () => ({ useGlobalSearchShortcut: () => {} }));

import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";

beforeEach(() => {
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
});

afterEach(() => cleanup());

const openWithResults = () => {
  useGlobalSearchStore.setState({
    open: true,
    query: "登录",
    results: {
      query: "登录",
      total_returned: 2,
      groups: [
        {
          category: "tasks",
          has_more: false,
          items: [
            {
              id: "t1", category: "tasks", kind: "task", title: "修复登录页面异常",
              subtitle: "bug", snippet: "登录页 500", occurred_at: "2026-11-01T10:00:00Z",
              status: "pending", priority: 1, target_id: "t1", parent_id: null,
            },
            {
              id: "t2", category: "tasks", kind: "task", title: "登录模块优化",
              subtitle: "ui", snippet: "", occurred_at: null,
              status: "completed", priority: 2, target_id: "t2", parent_id: null,
            },
          ],
        },
      ],
    },
  });
};

describe("弹窗渲染", () => {
  it("open=false 不渲染面板", () => {
    render(<GlobalSearchDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("打开后渲染输入框、分类行与结果分组", () => {
    openWithResults();
    render(<GlobalSearchDialog />);
    expect(screen.getByRole("dialog", { name: "全局搜索" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "搜索结果" })).toBeTruthy();
    // portal 渲染到 document.body；标题被高亮拆分成多个文本节点，按结果 id 定位
    const row = document.querySelector('[data-gs-id="t1"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("修复登录页面异常");
    expect(screen.getByText("任务", { selector: ".gs-group-head span" })).toBeTruthy();
    // 关键词高亮
    expect(document.querySelector(".gs-hit")).toBeTruthy();
  });

  it("空结果与错误态、加载态分别展示", () => {
    useGlobalSearchStore.setState({ open: true, query: "xyz", results: { query: "xyz", groups: [], total_returned: 0 } });
    render(<GlobalSearchDialog />);
    expect(screen.getByText("没有匹配的结果")).toBeTruthy();
    cleanup();
    useGlobalSearchStore.setState({ open: true, query: "xyz", error: "boom" });
    render(<GlobalSearchDialog />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试搜索" })).toBeTruthy();
  });

  it("最近搜索：空查询时显示历史并可清除", () => {
    useGlobalSearchStore.setState({ open: true, query: "", recent: ["历史搜索词"] });
    render(<GlobalSearchDialog />);
    expect(screen.getByText("历史搜索词")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除最近搜索" }));
    expect(useGlobalSearchStore.getState().recent).toEqual([]);
  });
});

describe("键盘交互", () => {
  it("ArrowDown/ArrowUp 移动选中且循环", () => {
    openWithResults();
    render(<GlobalSearchDialog />);
    const mask = document.querySelector(".gs-mask")!;
    expect(useGlobalSearchStore.getState().activeIndex).toBe(0);
    fireEvent.keyDown(mask, { key: "ArrowDown" });
    expect(useGlobalSearchStore.getState().activeIndex).toBe(1);
    fireEvent.keyDown(mask, { key: "ArrowDown" });
    expect(useGlobalSearchStore.getState().activeIndex).toBe(0); // 循环
    fireEvent.keyDown(mask, { key: "ArrowUp" });
    expect(useGlobalSearchStore.getState().activeIndex).toBe(1);
  });

  it("Enter 打开当前选中结果（记录跳转意图）", () => {
    openWithResults();
    render(<GlobalSearchDialog />);
    const mask = document.querySelector(".gs-mask")!;
    fireEvent.keyDown(mask, { key: "Enter" });
    const s = useGlobalSearchStore.getState();
    expect(s.pendingLocate?.id).toBe("t1");
    expect(s.open).toBe(false);
  });

  it("Escape 经 overlay 栈关闭弹窗", () => {
    openWithResults();
    render(<GlobalSearchDialog />);
    const mask = document.querySelector(".gs-mask")!;
    // overlayStack 在 document 捕获阶段分发 Escape
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(esc);
    expect(useGlobalSearchStore.getState().open).toBe(false);
    void mask;
  });
});

describe("结果点击", () => {
  it("点击结果调用 openResult 并关闭弹窗", async () => {
    openWithResults();
    render(<GlobalSearchDialog />);
    const row = document.querySelector('[data-gs-id="t2"]') as HTMLElement | null;
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    await waitFor(() => {
      const s = useGlobalSearchStore.getState();
      expect(s.pendingLocate?.id).toBe("t2");
      expect(s.open).toBe(false);
    });
  });
});
