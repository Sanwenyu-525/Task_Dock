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
import { useUiStore } from "../../store/useUiStore";
import { useScenarioStore } from "../../store/useScenarioStore";
import { useWorkflowsStore } from "../../store/useWorkflowsStore";

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
  it("输入法组合中的 Enter 只确认候选，不打开结果；组合结束后 Enter 正常打开", () => {
    openWithResults();
    render(<GlobalSearchDialog />);
    const input = screen.getByRole("textbox", { name: "搜索关键词" });
    const mask = document.querySelector(".gs-mask")!;

    fireEvent.compositionStart(input);
    fireEvent.keyDown(mask, { key: "Enter", isComposing: true });
    expect(useGlobalSearchStore.getState().open).toBe(true);
    expect(useGlobalSearchStore.getState().pendingLocate).toBeNull();

    fireEvent.compositionEnd(input);
    // Safari 顺序：compositionend 后 keydown 只剩 keyCode 229，仍需拦住
    fireEvent.keyDown(mask, { key: "Enter", keyCode: 229 });
    expect(useGlobalSearchStore.getState().pendingLocate).toBeNull();

    fireEvent.keyDown(mask, { key: "Enter" });
    expect(useGlobalSearchStore.getState().pendingLocate?.id).toBe("t1");
  });

  it("输入法组合中的 Escape 取消候选，不关闭弹窗", () => {
    openWithResults();
    render(<GlobalSearchDialog />);
    const input = screen.getByRole("textbox", { name: "搜索关键词" });
    fireEvent.compositionStart(input);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true }),
    );
    expect(useGlobalSearchStore.getState().open).toBe(true);

    fireEvent.compositionEnd(input);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(useGlobalSearchStore.getState().open).toBe(false);
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

describe("命令面板（与数据结果同弹窗、独立分组）", () => {
  const scenarioSummary = {
    id: "s1", name: "开工场景", icon: null, appCount: 0, urlCount: 0,
    folderCount: 0, linkedWorkflowId: null, lastEnteredAt: null,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  };

  beforeEach(() => {
    // 动态实体数据源置为「已加载」，hydrate 不触发 IPC。
    useScenarioStore.setState({ summaries: [], loaded: true, loading: false, enteringId: null, error: null });
    useWorkflowsStore.setState({ workflows: [], workflowsLoading: false, workflowsError: null, activeRun: null });
    useUiStore.setState({ tab: "tasks", toasts: [], toast: null, quickAddToken: 0 });
  });

  it("空查询渲染默认命令列表：独立分组头 + 命令条目，最近搜索跟在后面", () => {
    useGlobalSearchStore.setState({ open: true, query: "", recent: ["历史搜索词"] });
    useGlobalSearchStore.getState().refreshCommands();
    render(<GlobalSearchDialog />);
    expect(screen.getByRole("listbox", { name: "命令" })).toBeTruthy();
    // 默认列表：新建任务 / 创建提醒在列
    expect(document.querySelector('[data-gs-cmd-id="create.task"]')).toBeTruthy();
    expect(document.querySelector('[data-gs-cmd-id="create.reminder"]')).toBeTruthy();
    // DOM 顺序：命令组在最近搜索之前
    const body = document.querySelector(".gs-body")!;
    const cmdIdx = body.querySelector(".gs-commands")!.compareDocumentPosition(
      body.querySelector(".gs-recent")!,
    );
    // eslint-disable-next-line no-bitwise
    expect(cmdIdx & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("命令组固定置于数据结果之前，且不与数据分组混淆", () => {
    useGlobalSearchStore.setState({
      open: true,
      query: "剪贴",
      results: {
        query: "剪贴", total_returned: 1,
        groups: [{
          category: "clipboard", has_more: false,
          items: [{
            id: "c1", category: "clipboard", kind: "text", title: "剪贴片段",
            subtitle: "", snippet: "", occurred_at: null, status: null,
            priority: null, target_id: "c1", parent_id: null,
          }],
        }],
      },
    });
    useGlobalSearchStore.getState().refreshCommands();
    render(<GlobalSearchDialog />);
    const body = document.querySelector(".gs-body")!;
    const pos = body.querySelector(".gs-commands")!.compareDocumentPosition(
      body.querySelector(".gs-results")!,
    );
    // eslint-disable-next-line no-bitwise
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 命令条目带专属 id（nav.clipboard），数据条目仍是 data-gs-id
    expect(document.querySelector('[data-gs-cmd-id="nav.clipboard"]')).toBeTruthy();
    expect(document.querySelector('[data-gs-id="c1"]')).toBeTruthy();
  });

  it("Enter 执行当前选中命令（quick-add → 任务页聚焦快速录入并关闭）", () => {
    useGlobalSearchStore.setState({ open: true, query: "" });
    useGlobalSearchStore.getState().refreshCommands();
    render(<GlobalSearchDialog />);
    const mask = document.querySelector(".gs-mask")!;
    expect(useGlobalSearchStore.getState().commands[0].id).toBe("create.task");
    fireEvent.keyDown(mask, { key: "Enter" });
    const s = useGlobalSearchStore.getState();
    expect(s.open).toBe(false);
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().quickAddToken).toBe(1);
    expect(s.pendingLocate).toBeNull(); // 命令不产生数据定位意图
  });

  it("键盘跨组移动：命令组之后继续进入数据结果并循环", () => {
    useGlobalSearchStore.setState({
      open: true,
      query: "剪贴",
      results: {
        query: "剪贴", total_returned: 2,
        groups: [{
          category: "clipboard", has_more: false,
          items: [
            {
              id: "c1", category: "clipboard", kind: "text", title: "片段一",
              subtitle: "", snippet: "", occurred_at: null, status: null,
              priority: null, target_id: "c1", parent_id: null,
            },
            {
              id: "c2", category: "clipboard", kind: "text", title: "片段二",
              subtitle: "", snippet: "", occurred_at: null, status: null,
              priority: null, target_id: "c2", parent_id: null,
            },
          ],
        }],
      },
    });
    useGlobalSearchStore.getState().refreshCommands();
    const cmdCount = useGlobalSearchStore.getState().commands.length;
    expect(cmdCount).toBeGreaterThanOrEqual(1);
    render(<GlobalSearchDialog />);
    const mask = document.querySelector(".gs-mask")!;
    fireEvent.keyDown(mask, { key: "ArrowDown" });
    expect(useGlobalSearchStore.getState().activeIndex).toBe(1);
    // 跳过剩余命令：直接定位到命令组末尾再下移一次应进入数据结果
    useGlobalSearchStore.setState({ activeIndex: cmdCount - 1 });
    fireEvent.keyDown(mask, { key: "ArrowDown" });
    expect(useGlobalSearchStore.getState().activeIndex).toBe(cmdCount); // 第一个数据结果
    fireEvent.keyDown(mask, { key: "ArrowDown" });
    expect(useGlobalSearchStore.getState().activeIndex).toBe(cmdCount + 1);
    // 循环回绕到命令组头部
    fireEvent.keyDown(mask, { key: "ArrowDown" });
    expect(useGlobalSearchStore.getState().activeIndex).toBe(0);
  });

  it("Enter 在数据结果上仍走 openResult（activeIndex 落在数据区）", () => {
    useGlobalSearchStore.setState({
      open: true,
      query: "剪贴",
      results: {
        query: "剪贴", total_returned: 1,
        groups: [{
          category: "clipboard", has_more: false,
          items: [{
            id: "c1", category: "clipboard", kind: "text", title: "片段一",
            subtitle: "", snippet: "", occurred_at: null, status: null,
            priority: null, target_id: "c1", parent_id: null,
          }],
        }],
      },
    });
    useGlobalSearchStore.getState().refreshCommands();
    const cmdCount = useGlobalSearchStore.getState().commands.length;
    useGlobalSearchStore.setState({ activeIndex: cmdCount });
    render(<GlobalSearchDialog />);
    const mask = document.querySelector(".gs-mask")!;
    fireEvent.keyDown(mask, { key: "Enter" });
    const s = useGlobalSearchStore.getState();
    expect(s.pendingLocate?.id).toBe("c1");
    expect(s.pendingLocate?.category).toBe("clipboard");
    expect(s.open).toBe(false);
  });

  it("动态实体命令：场景/工作流列表水合后出现；列表为空时降级缺席", async () => {
    useScenarioStore.setState({ summaries: [scenarioSummary] });
    useWorkflowsStore.setState({
      workflows: [{
        id: "w1", name: "晨间流程", description: "", enabled: true, sort_order: 0,
        step_count: 1, created_at: "", updated_at: "", last_run_at: null,
      }],
    });
    useGlobalSearchStore.setState({ open: true, query: "开工" });
    useGlobalSearchStore.getState().refreshCommands();
    render(<GlobalSearchDialog />);
    expect(document.querySelector('[data-gs-cmd-id="scenario.s1"]')).toBeTruthy();
    cleanup();
    // 列表清空 → 该动态命令降级缺席；关键词查无命令且无数据结果 → 空态
    useScenarioStore.setState({ summaries: [] });
    useGlobalSearchStore.getState().refreshCommands();
    render(<GlobalSearchDialog />);
    expect(document.querySelector('[data-gs-cmd-id="scenario.s1"]')).toBeNull();
    expect(screen.getByText("没有匹配的结果")).toBeTruthy();
    cleanup();
    // 清空查询 → 回到默认列表（静态命令始终可用）
    useGlobalSearchStore.setState({ query: "" });
    useGlobalSearchStore.getState().refreshCommands();
    render(<GlobalSearchDialog />);
    expect(document.querySelector('[data-gs-cmd-id="create.task"]')).toBeTruthy();
  });

  it("无命令且无数据结果时显示空态（不把命令缺席误判为有结果）", () => {
    useGlobalSearchStore.setState({
      open: true,
      query: "zzz不存在的关键词",
      commands: [],
      results: { query: "zzz不存在的关键词", groups: [], total_returned: 0 },
    });
    render(<GlobalSearchDialog />);
    expect(screen.getByText("没有匹配的结果")).toBeTruthy();
  });

  it("点击命令条目执行命令", () => {
    useGlobalSearchStore.setState({ open: true, query: "" });
    useGlobalSearchStore.getState().refreshCommands();
    render(<GlobalSearchDialog />);
    fireEvent.click(document.querySelector('[data-gs-cmd-id="nav.workflows"]')!);
    expect(useGlobalSearchStore.getState().open).toBe(false);
    expect(useUiStore.getState().tab).toBe("workflows");
  });
});
