/**
 * @vitest-environment jsdom
 */
//! TasksPanel 三模式布局回归（2026-11-12「任务优先」重构）：
//! - 列表模式：固定页头 = 概览 → QuickAdd → 日期/工具行 → 搜索行，列表独立滚动；
//! - 工具行单行契约：日期分段 + 5 个工具入口，搜索/状态/排序各只有一层 flex 容器；
//! - 子视图（专注 / 统计）不带任何列表工具栏，返回与 Escape 都恢复筛选与滚动；
//! - 专注与统计互斥，同一时刻只渲染一个 `.tasks-panel[data-task-mode]`。
//!
//! 这里只做 DOM 结构断言，不验证 CSS 计算样式与真实窗口度量（见报告未验证项）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useTasksStore } from "../../store/useTasksStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import TasksPanel from "./TasksPanel";
import type { Task, TaskFilter } from "../../lib/bridge";

const { ALL_TASKS, filterTasks } = vi.hoisted(() => {
  function taskFix(p: Partial<Task> & Pick<Task, "id" | "title">): Task {
    return {
      description: "",
      priority: 1,
      status: "pending",
      category: "",
      tags: [],
      due_at: null,
      remind_at: null,
      advance_minutes: 0,
      recurrence: null,
      created_at: "2026-10-27T00:00:00Z",
      updated_at: "2026-10-27T00:00:00Z",
      completed_at: null,
      linked_agents: 0,
      ...p,
    };
  }
  const ALL_TASKS: Task[] = [
    taskFix({ id: "a", title: "买牛奶", due_at: "2026-10-28T09:00:00.000Z" }),
    taskFix({ id: "b", title: "写代码", due_at: "2026-10-29T09:00:00.000Z" }),
    taskFix({ id: "c", title: "旧任务", status: "completed", completed_at: "2026-10-27T00:00:00Z" }),
  ];
  /** 模拟后端 list_tasks：只实现本测试用到的 search / status / view 维度。 */
  const filterTasks = (f: TaskFilter): Task[] => {
    let list = ALL_TASKS;
    if (f.search?.trim()) list = list.filter((t) => t.title.includes(f.search!.trim()));
    if (f.status && f.status !== "all") list = list.filter((t) => t.status === f.status);
    if (f.view === "overdue") {
      list = list.filter(
        (t) => t.status === "pending" && !!t.due_at && new Date(t.due_at).getTime() < Date.now(),
      );
    }
    return list;
  };
  return { ALL_TASKS, filterTasks };
});

const STATS = {
  pending: 2,
  overdue: 0,
  due_today: 1,
  completed_today: 0,
  next_due_at: null,
};

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    listTasks: vi.fn(async (f: TaskFilter) => filterTasks(f)),
    toggleTask: vi.fn(),
    taskStats: vi.fn(async () => STATS),
    // 提醒摘要只保留数据入口的 mock：本文件不测试提醒行为，
    // 但组件挂载会拉取/订阅，避免真实 IPC 在 jsdom 里刷错误。
    activeReminders: vi.fn(async () => []),
    onReminderFired: vi.fn(async () => () => {}),
    onReminderSnoozed: vi.fn(async () => () => {}),
    parseQuickAdd: vi.fn(),
    createFromQuickAdd: vi.fn(),
    listTaskLinks: vi.fn(async () => []),
    clipboardTaskLinks: vi.fn(async () => []),
  };
});

vi.mock("../../lib/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/navigation")>()),
  navTaskTargets: vi.fn(async () => []),
}));

vi.mock("./analytics/TaskAnalyticsPanel", () => ({
  default: () => <div>analytics-panel</div>,
}));

// FocusWorkspace 挂载即订阅 focus 事件；jsdom 没有 Tauri 事件桥，必须桩掉，
// 否则 acquireFocusEvents 的 Promise.all 会以未处理 rejection 形式污染测试。
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

function seedTasks() {
  useTasksStore.setState({
    tasks: ALL_TASKS,
    loading: false,
    error: null,
    stats: STATS,
    filter: { view: "all", status: "all", sort: "due" },
    exitHolds: [],
  });
  useNavigationStore.setState({ linksByTask: {}, linksError: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ editor: { open: false, task: null } });
  // 页面活跃态：ActiveReminders / FocusWorkspace 都以「完整面板可见」为消费者门控
  useEdgeSnapStore.setState({ phase: "free", dockedEdge: null });
  useSettingsStore.setState({ settings: null });
  // jsdom 的 requestAnimationFrame 兜底：返回列表时恢复滚动位置 / 归还焦点都靠它
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("任务页列表模式结构", () => {
  it("页头顺序为概览 → QuickAdd → 日期/工具行 → 搜索行，列表是面板直接子元素且独立滚动", async () => {
    // 守的契约：任务列表占满页头之外的高度，页头四块固定不随列表滚动。
    seedTasks();
    render(<TasksPanel />);
    await screen.findByPlaceholderText(/搜索标题/);

    const panel = document.querySelector<HTMLElement>('.tasks-panel[data-task-mode="list"]')!;
    expect(panel).toBeTruthy();
    const head = panel.querySelector<HTMLElement>(".tasks-head")!;
    expect(head).toBeTruthy();

    const kindOf = (el: Element) => {
      if (el.classList.contains("tasks-overview")) return "overview";
      if (el.classList.contains("quick-add")) return "quick-add";
      if (el.classList.contains("tasks-viewbar")) return "viewbar";
      if (el.classList.contains("tasks-filterbar")) return "filterbar";
      return "other";
    };
    expect(Array.from(head.children).map(kindOf)).toEqual([
      "overview",
      "quick-add",
      "viewbar",
      "filterbar",
    ]);
    // 概览使用紧凑变体，仍是三张可下钻的卡
    expect(head.querySelector(".tasks-overview--compact")).toBeTruthy();

    const list = panel.querySelector<HTMLElement>(".task-list")!;
    expect(list).toBeTruthy();
    // 列表是面板直接子元素，且承担滚动（页头不在滚动容器内）
    expect(list.parentElement).toBe(panel);
    expect(list.classList.contains("page-scroll")).toBe(true);
    for (const sel of [".tasks-overview", ".quick-add", ".tasks-viewbar", ".tasks-filterbar"]) {
      expect(list.querySelector(sel)).toBeNull();
    }
  });

  it("工具行单行契约：日期分段 + 5 个入口；搜索/状态/排序各只有一层 flex 容器", async () => {
    // 守的契约：窄窗只允许日期分段横向滚动，工具图标不能折到第二行；
    // 搜索行不再被额外的 wrapper / flex-spacer 拆成多行。
    seedTasks();
    render(<TasksPanel />);
    await screen.findByPlaceholderText(/搜索标题/);

    const viewbar = document.querySelector<HTMLElement>(".tasks-viewbar")!;
    expect(viewbar).toBeTruthy();
    expect(viewbar.children).toHaveLength(3);
    expect(viewbar.children[0].classList.contains("tasks-views")).toBe(true);
    expect(viewbar.children[1].classList.contains("flex-spacer")).toBe(true);
    expect(viewbar.children[2].classList.contains("tasks-actions")).toBe(true);

    const actions = viewbar.querySelector<HTMLElement>(".tasks-actions")!;
    expect(actions.getAttribute("role")).toBe("group");
    const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>(":scope > button"));
    expect(buttons).toHaveLength(5);
    // 顺序与可访问名：提醒调度 / 帮助 / 专注 / 统计 / 更多
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "暂停提醒调度",
      "查看帮助：创建任务与自然语言提醒",
      "专注与休息",
      "任务统计",
      "更多操作",
    ]);
    for (const button of buttons) {
      expect(button.getAttribute("data-tip")).toBeTruthy();
    }

    const filterbar = document.querySelector<HTMLElement>(".tasks-filterbar")!;
    expect(filterbar).toBeTruthy();
    expect(filterbar.children).toHaveLength(3);
    expect(filterbar.children[0].classList.contains("search-box")).toBe(true);
    expect(filterbar.children[1].classList.contains("seg-group")).toBe(true);
    expect(filterbar.children[2].classList.contains("sort-select")).toBe(true);
    // 搜索行没有 spacer / 第二层容器（那会把控件挤成两行）
    expect(filterbar.querySelector(".flex-spacer")).toBeNull();
  });

  it("「更多操作」→「快捷提醒」可展开并保留创建能力，收起后卸载", async () => {
    // 守的契约：快捷提醒不再常驻占位，但入口仍可达、展开后预设创建能力完整。
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);
    await screen.findByPlaceholderText(/搜索标题/);

    await user.click(screen.getByRole("button", { name: "更多操作" }));
    const item = await screen.findByRole("menuitemradio", { name: "快捷提醒" });
    expect(item.getAttribute("aria-checked")).toBe("false");
    await user.click(item);

    expect(await screen.findByPlaceholderText(/快速提醒/)).toBeTruthy();
    // 预设时长入口仍在：快捷提醒的创建能力没有被菜单收纳破坏
    expect(screen.getByRole("button", { name: "5 分钟" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "自定义…" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "收起快捷提醒" }));
    await waitFor(() => expect(screen.queryByPlaceholderText(/快速提醒/)).toBeNull());
    expect(document.querySelector(".quick-reminder")).toBeNull();
  });
});

describe("专注 / 统计子视图", () => {
  it("专注模式只渲染返回头与 FocusWorkspace，不残留任何列表工具栏；返回后筛选不变", async () => {
    // 守的契约：子视图是独立工作视图，不是「列表上面盖一层」。
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);
    await screen.findByPlaceholderText(/搜索标题/);
    const filterBefore = { ...useTasksStore.getState().filter };

    await user.click(screen.getByRole("button", { name: "专注与休息" }));
    const focusPanel = document.querySelector<HTMLElement>('[data-task-mode="focus"]')!;
    expect(focusPanel).toBeTruthy();
    expect(focusPanel.classList.contains("tasks-subview")).toBe(true);
    expect(focusPanel.querySelector(".tasks-subview-head")).toBeTruthy();
    expect(focusPanel.querySelector(".tasks-subview-body.page-scroll")).toBeTruthy();
    expect(document.querySelector(".focus-workspace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始专注" })).toBeTruthy();

    for (const sel of [
      ".tasks-overview",
      ".quick-add",
      ".tasks-filterbar",
      ".tasks-viewbar",
      ".active-reminders",
      ".task-list",
    ]) {
      expect(document.querySelector(sel)).toBeNull();
    }
    // 子视图内没有「专注与休息 / 任务统计」这类切换按钮残留
    expect(screen.queryByRole("button", { name: "任务统计" })).toBeNull();
    expect(document.querySelector(".tasks-analytics-body")).toBeNull();

    await user.click(screen.getByRole("button", { name: "返回任务列表" }));
    await waitFor(() =>
      expect(document.querySelector('[data-task-mode="list"]')).toBeTruthy(),
    );
    expect(useTasksStore.getState().filter).toEqual(filterBefore);
    expect(screen.getByText("买牛奶")).toBeTruthy();
  });

  it("统计模式只渲染返回头与统计面板，Escape 返回列表", async () => {
    // 守的契约：统计与专注同构（同一返回头/互斥视图），Escape 与按钮等价。
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);
    await screen.findByPlaceholderText(/搜索标题/);

    await user.click(screen.getByRole("button", { name: "任务统计" }));
    const analyticsPanel = document.querySelector<HTMLElement>(
      '[data-task-mode="analytics"]',
    )!;
    expect(analyticsPanel).toBeTruthy();
    expect(analyticsPanel.classList.contains("tasks-subview")).toBe(true);
    expect(
      analyticsPanel.querySelector(".tasks-subview-body.tasks-analytics-body"),
    ).toBeTruthy();
    expect(screen.getByText("analytics-panel")).toBeTruthy();

    for (const sel of [
      ".tasks-overview",
      ".quick-add",
      ".tasks-filterbar",
      ".tasks-viewbar",
      ".active-reminders",
      ".task-list",
    ]) {
      expect(document.querySelector(sel)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "专注与休息" })).toBeNull();
    expect(document.querySelector(".focus-workspace")).toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.querySelector('[data-task-mode="list"]')).toBeTruthy(),
    );
    expect(screen.queryByText("analytics-panel")).toBeNull();
    expect(screen.getByText("买牛奶")).toBeTruthy();
  });

  it("返回列表后恢复搜索筛选与列表滚动位置", async () => {
    // 守的契约：子视图会卸载列表 DOM，筛选（store）与滚动（快照）都必须原样恢复。
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);

    await user.type(await screen.findByPlaceholderText(/搜索标题/), "牛奶");
    await waitFor(() => expect(screen.queryByText("写代码")).toBeNull());

    const list = document.querySelector<HTMLElement>(".task-list")!;
    list.scrollTop = 120;
    fireEvent.scroll(list);

    await user.click(screen.getByRole("button", { name: "任务统计" }));
    expect(document.querySelector('[data-task-mode="analytics"]')).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "返回任务列表" }));
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".task-list")).not.toBeNull(),
    );
    expect(useTasksStore.getState().filter.search).toBe("牛奶");
    expect(screen.getByText("买牛奶")).toBeTruthy();
    expect(screen.queryByText("写代码")).toBeNull();
    // rAF 回写滚动位置（stub 为 setTimeout 0），用 waitFor 等这一帧
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".task-list")!.scrollTop).toBe(120),
    );
  });

  it("专注与统计互斥：Escape 后进入统计不残留前一个子视图", async () => {
    // 守的契约：两种子视图共用单一 mode 状态，DOM 中永远只有一个 data-task-mode。
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);
    await screen.findByPlaceholderText(/搜索标题/);

    await user.click(screen.getByRole("button", { name: "专注与休息" }));
    expect(document.querySelectorAll(".tasks-panel[data-task-mode]")).toHaveLength(1);
    expect(document.querySelector('[data-task-mode="focus"]')).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.querySelector('[data-task-mode="list"]')).toBeTruthy(),
    );
    expect(document.querySelectorAll(".tasks-subview")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "任务统计" }));
    expect(document.querySelector('[data-task-mode="analytics"]')).toBeTruthy();
    expect(document.querySelector('[data-task-mode="focus"]')).toBeNull();
    expect(document.querySelectorAll(".tasks-subview")).toHaveLength(1);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.querySelector('[data-task-mode="list"]')).toBeTruthy(),
    );
    expect(document.querySelectorAll(".tasks-subview")).toHaveLength(0);
  });
});
