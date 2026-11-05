// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  // 组件测试默认按真实 Tauri 环境运行：桌面请求走 desktopRuntime，而不是浏览器降级分支。
  return { ...actual, isTauri: () => true };
});

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    activeReminders: vi.fn(async () => []),
    onReminderFired: vi.fn(async () => () => {}),
    onReminderSnoozed: vi.fn(async () => () => {}),
  };
});

import {
  activeReminders,
  onReminderFired,
  onReminderSnoozed,
  type ActiveReminder,
  type AgentRun,
  type AgentSnapshot,
  type Task,
  type TaskStats,
} from "../../lib/bridge";
import { defaultWidgetItems, type WidgetItem } from "../../lib/widgets/model";
import type { EfficiencySnapshot, FocusSnapshot, WidgetSource } from "../../lib/widgets/sources";
import { __resetLocaleForTests, setLocalePreference } from "../../i18n";
import { formatHM } from "../../lib/format";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import { useWidgetsStore } from "../../store/useWidgetsStore";
import WidgetsPanel from "./WidgetsPanel";

/**
 * 时间基准按「用例执行时」取，而不是模块加载时：全量并行跑测试时本文件可能排队数十秒，
 * 模块级 Date.now() 会让 65s 倒计时在断言前就过期（历史用例还把 01:04/01:05 写死）。
 */
const now = () => Date.now();

/** jsdom 不实现 DataTransfer，这里只提供 HTML5 DnD 需要的最小接口。 */
class DragDataStub {
  effectAllowed = "uninitialized";
  dropEffect = "none";
  private data = new Map<string, string>();

  setData(type: string, value: string) {
    this.data.set(type, value);
  }

  getData(type: string) {
    return this.data.get(type) ?? "";
  }
}

function makeTask(id: string, title: string, dueAt: string | null, status: Task["status"] = "pending"): Task {
  return {
    id,
    title,
    description: "",
    priority: 2,
    status,
    category: "",
    tags: [],
    due_at: dueAt,
    remind_at: null,
    advance_minutes: 0,
    recurrence: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    linked_agents: 0,
  };
}

function makeRun(id: string, status: string, taskTitle: string): AgentRun {
  const at = new Date(now() - 60_000).toISOString();
  return {
    id,
    session_id: "s1",
    source_id: "src",
    external_run_id: null,
    task_title: taskTitle,
    status,
    started_at: at,
    updated_at: at,
    ended_at: null,
    pending_items: [],
  };
}

const EMPTY_SNAPSHOT: AgentSnapshot = { sources: [], instances: [], sessions: [], runs: [] };

const STATS: TaskStats = {
  pending: 2,
  overdue: 1,
  due_today: 2,
  completed_today: 3,
  next_due_at: null,
};

function setLayout(items: WidgetItem[]) {
  useWidgetsStore.setState({ widgets: items, hydrated: true });
}

function enable(...types: WidgetItem["type"][]) {
  setLayout(defaultWidgetItems().map((item) => ({ ...item, enabled: types.includes(item.type) })));
}

function seedTasks() {
  useTasksStore.setState({
    tasks: [
      makeTask("t-overdue", "补交周报", new Date(now() - 3_600_000).toISOString()),
      makeTask("t-today", "评审设计稿", new Date(now() + 3_600_000).toISOString()),
      makeTask("t-done", "已完成任务", new Date(now() - 3_600_000).toISOString(), "completed"),
      makeTask("t-tomorrow", "明天的事", new Date(now() + 2 * 24 * 3_600_000).toISOString()),
    ],
    stats: STATS,
    statsError: null,
    loading: false,
  });
}

/** 每次挂载前生成快照，避免倒计时过期；useSyncExternalStore 要求 getSnapshot 返回稳定引用，故闭包复用。 */
function makeFocusSnapshot(): FocusSnapshot {
  return {
    phase: "focus",
    label: "专注",
    endsAt: new Date(now() + 65_000).toISOString(),
    cycle: { index: 1, total: 4 },
  };
}

function makeFocusSource(): WidgetSource<FocusSnapshot> {
  const snapshot = makeFocusSnapshot();
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}

const EFFICIENCY_SNAPSHOT: EfficiencySnapshot = {
  completedToday: 3,
  dueToday: 5,
  overdue: 1,
  pending: 6,
  completionRate: 60,
};

const EFFICIENCY_SOURCE: WidgetSource<EfficiencySnapshot> = {
  // 必须返回稳定引用，否则 useSyncExternalStore 会判定快照无限变化。
  getSnapshot: () => EFFICIENCY_SNAPSHOT,
  subscribe: () => () => {},
};

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  __resetLocaleForTests();
  useWidgetsStore.setState({
    widgets: defaultWidgetItems(),
    hydrated: false,
    desktopRuntime: {},
    desktopRetrySeq: {},
    persistError: null,
  });
  useUiStore.setState({ toast: null, toasts: [] });
  useAgentsStore.setState({ snapshot: EMPTY_SNAPSHOT, snapshotError: null });
  useTasksStore.setState({ tasks: [], stats: null, error: null, statsError: null, loading: false });
  vi.mocked(activeReminders).mockResolvedValue([]);
  vi.mocked(onReminderFired).mockResolvedValue(() => {});
  vi.mocked(onReminderSnoozed).mockResolvedValue(() => {});
});

describe("微件面板", () => {
  it("默认只挂载已启用微件，依赖未就绪的微件不出现", () => {
    seedTasks();
    const { container } = render(<WidgetsPanel />);

    expect(container.querySelectorAll("[data-widget-id]")).toHaveLength(4);
    expect(container.querySelector('[data-widget-id="focus-timer"]')).toBeNull();
    expect(container.querySelector('[data-widget-id="efficiency"]')).toBeNull();
    expect(screen.getByText("今日到期 2 · 逾期 1")).toBeTruthy();
  });

  it("今日任务只显示今天到期/逾期的待办，并与任务 Store 同步更新", () => {
    seedTasks();
    render(<WidgetsPanel />);

    expect(screen.getByRole("button", { name: "打开任务「补交周报」" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开任务「已完成任务」" })).toBeNull();
    expect(screen.queryByRole("button", { name: "打开任务「明天的事」" })).toBeNull();

    act(() => {
      useTasksStore.setState((state) => ({
        tasks: [...state.tasks, makeTask("t-new", "新到期任务", new Date(now() - 60_000).toISOString())],
      }));
    });
    expect(screen.getByRole("button", { name: "打开任务「新到期任务」" })).toBeTruthy();
  });

  it("Agent 状态跟随快照更新，失败轮次优先展示", () => {
    useAgentsStore.setState({
      snapshot: {
        ...EMPTY_SNAPSHOT,
        runs: [makeRun("r-fail", "failed", "失败的轮次"), makeRun("r-run", "running", "运行中的轮次")],
      },
      snapshotError: null,
    });
    render(<WidgetsPanel />);

    expect(screen.getByText("失败 1")).toBeTruthy();
    expect(screen.getByText("失败的轮次")).toBeTruthy();
    expect(screen.getByText("运行中的轮次")).toBeTruthy();
    expect(screen.queryByText("当前没有活跃轮次")).toBeNull();

    act(() => {
      useAgentsStore.setState({ snapshot: EMPTY_SNAPSHOT });
    });
    expect(screen.getByText("当前没有活跃轮次")).toBeTruthy();
    expect(screen.getByText("失败 0")).toBeTruthy();
  });

  it("下一条提醒读取现有调度并在卸载时释放事件订阅", async () => {
    const unlistenFired = vi.fn();
    const unlistenSnoozed = vi.fn();
    vi.mocked(onReminderFired).mockImplementation(async () => unlistenFired);
    vi.mocked(onReminderSnoozed).mockImplementation(async () => unlistenSnoozed);
    const reminder: ActiveReminder = {
      reminderId: "rem-1",
      taskId: "t-1",
      taskTitle: "提交报销单",
      remindAt: new Date(now() + 65_000).toISOString(),
      occurrence: "2026-06-18T09:00:00.000Z",
      kind: "deadline",
      snoozed: false,
      taskStatus: "pending",
      hasRecurrence: false,
    };
    vi.mocked(activeReminders).mockResolvedValue([reminder]);

    const { unmount } = render(<WidgetsPanel />);

    expect(await screen.findByText("提交报销单")).toBeTruthy();
    // 期望时间取自真实的 remindAt（当前 + 65s），不能写死某个时刻。
    expect(screen.getByText(new RegExp(formatHM(new Date(reminder.remindAt))))).toBeTruthy();
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toBeTruthy();
    expect(vi.mocked(activeReminders)).toHaveBeenCalled();

    await waitFor(() => expect(vi.mocked(onReminderFired)).toHaveBeenCalled());
    unmount();
    await waitFor(() => {
      expect(unlistenFired).toHaveBeenCalled();
      expect(unlistenSnoozed).toHaveBeenCalled();
    });
  });

  it("提醒并发读取时以最后一次请求为准", async () => {
    let fireCb: (() => void) | null = null;
    vi.mocked(onReminderFired).mockImplementation(async (cb) => {
      fireCb = cb;
      return () => {};
    });
    const resolvers: Array<(next: ActiveReminder[]) => void> = [];
    vi.mocked(activeReminders).mockImplementation(
      () => new Promise<ActiveReminder[]>((resolve) => resolvers.push(resolve)),
    );

    render(<WidgetsPanel />);
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await waitFor(() => expect(fireCb).not.toBeNull());

    act(() => fireCb!());
    await waitFor(() => expect(resolvers).toHaveLength(2));

    const base: ActiveReminder = {
      reminderId: "rem-new",
      taskId: "t-new",
      taskTitle: "新的提醒",
      remindAt: new Date(now() + 120_000).toISOString(),
      occurrence: new Date(now()).toISOString(),
      kind: "deadline",
      snoozed: false,
      taskStatus: "pending",
      hasRecurrence: false,
    };
    const older: ActiveReminder = { ...base, reminderId: "rem-old", taskTitle: "旧的提醒" };

    await act(async () => {
      resolvers[1]([base]);
      resolvers[0]([older]);
    });

    expect(screen.getByText("新的提醒")).toBeTruthy();
    expect(screen.queryByText("旧的提醒")).toBeNull();
  });

  it("卡片停用立即卸载，库中可重新添加且不再重复展示", () => {
    seedTasks();
    const { container } = render(<WidgetsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "停用「快捷操作」" }));
    expect(container.querySelector('[data-widget-id="quick-actions"]')).toBeNull();
    expect(screen.getByText("已启用 3 / 6")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    const addQuick = screen.getByRole("button", { name: "将「快捷操作」添加到工作台" });
    fireEvent.click(addQuick);

    expect(container.querySelector('[data-widget-id="quick-actions"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "将「快捷操作」添加到工作台" })).toBeNull();
    expect(screen.getByText("已启用 4 / 6")).toBeTruthy();
  });

  it("桌面显示开关与看板启用相互独立", () => {
    seedTasks();
    render(<WidgetsPanel />);
    const item = () =>
      useWidgetsStore.getState().widgets.find((entry) => entry.widget_id === "today-tasks")!;

    const desktopToggle = screen.getByRole("button", { name: "在桌面显示「今日任务」" });
    expect(desktopToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(desktopToggle);

    expect(item().desktop.visible).toBe(true);
    expect(screen.getByRole("button", { name: "停用「今日任务」" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "停用「今日任务」" }));
    expect(item().enabled).toBe(false);
    // 停用看板卡片不得连带关闭桌面窗口。
    expect(item().desktop.visible).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    fireEvent.click(screen.getByRole("button", { name: "将「今日任务」添加到工作台" }));
    fireEvent.click(screen.getByRole("button", { name: "在桌面显示「今日任务」" }));
    expect(item().desktop.visible).toBe(false);
  });

  it("从库添加后立即出现在工作台并给出完成反馈", () => {
    seedTasks();
    const { container } = render(<WidgetsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    fireEvent.click(screen.getByRole("button", { name: "将「专注倒计时」添加到工作台" }));

    expect(container.querySelector('[data-widget-id="focus-timer"]')).toBeTruthy();
    expect(useWidgetsStore.getState().widgets.find((entry) => entry.widget_id === "focus-timer")!.enabled).toBe(true);
    expect(screen.queryByRole("button", { name: "将「专注倒计时」添加到工作台" })).toBeNull();
    expect(
      useUiStore.getState().toasts.some((toast) => toast.message === "已添加「专注倒计时」到工作台"),
    ).toBe(true);
  });

  it("从库添加到桌面一次写盘，真正 shown 后才提示成功", () => {
    seedTasks();
    const { container } = render(<WidgetsPanel />);
    const item = () =>
      useWidgetsStore.getState().widgets.find((entry) => entry.widget_id === "efficiency")!;

    // 桌面窗口已存在（卡片停用但桌面仍显示）且正在创建：用于验证创建态与成功时机。
    useWidgetsStore.setState({ desktopRuntime: { efficiency: { phase: "creating" } } });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    fireEvent.click(
      screen.getByRole("button", { name: "将「今日效率统计」添加到工作台并显示到桌面" }),
    );

    // 启用 + 请求桌面显示是同一个原子提交，只允许写一次布局。
    expect(
      setItem.mock.calls.filter(([key]) => key === "taskdock.widgets.layout.v1"),
    ).toHaveLength(1);
    setItem.mockRestore();

    expect(container.querySelector('[data-widget-id="efficiency"]')).toBeTruthy();
    expect(item().enabled).toBe(true);
    expect(item().desktop.visible).toBe(true);
    // 请求发出后只进入创建态：不得提前宣称窗口已显示。
    expect(screen.getByText("正在创建…")).toBeTruthy();
    expect(
      useUiStore.getState().toasts.some((toast) => toast.message === "已添加「今日效率统计」并显示到桌面"),
    ).toBe(false);

    act(() => {
      useWidgetsStore.setState({
        desktopRuntime: { efficiency: { phase: "shown" } },
      });
    });
    expect(
      useUiStore.getState().toasts.some((toast) => toast.message === "已添加「今日效率统计」并显示到桌面"),
    ).toBe(true);
  });

  it("桌面创建失败时不提示已显示，卡片保留错误与重试入口", () => {
    seedTasks();
    render(<WidgetsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    fireEvent.click(
      screen.getByRole("button", { name: "将「今日效率统计」添加到工作台并显示到桌面" }),
    );

    act(() => {
      useWidgetsStore.setState({
        desktopRuntime: { efficiency: { phase: "failed", error: "窗口创建失败" } },
      });
    });

    expect(screen.getByText("窗口异常")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "重试创建「今日效率统计」桌面微件" }),
    ).toBeTruthy();
    // 失败提示由桌面桥统一发出；面板不得再补一条成功 Toast。
    expect(
      useUiStore.getState().toasts.some((toast) => toast.message.includes("并显示到桌面")),
    ).toBe(false);
  });

  it("只添加到工作台不会改动桌面显示状态", () => {
    seedTasks();
    render(<WidgetsPanel />);
    const item = () =>
      useWidgetsStore.getState().widgets.find((entry) => entry.widget_id === "focus-timer")!;

    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    fireEvent.click(screen.getByRole("button", { name: "将「专注倒计时」添加到工作台" }));

    expect(item().enabled).toBe(true);
    expect(item().desktop.visible).toBe(false);
  });

  it("持久化失败时不提示添加成功", () => {
    seedTasks();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    try {
      render(<WidgetsPanel />);
      fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
      fireEvent.click(screen.getByRole("button", { name: "将「专注倒计时」添加到工作台" }));

      expect(
        useUiStore.getState().toasts.some((toast) => toast.message.includes("已添加")),
      ).toBe(false);
      expect(useUiStore.getState().toasts.some((toast) => toast.kind === "error")).toBe(true);
      expect(useWidgetsStore.getState().persistError).toBeTruthy();
    } finally {
      setItem.mockRestore();
    }
  });

  it("全部添加后只显示简洁完成态，不再列出管理表单", () => {
    enable(
      "today-tasks",
      "next-reminder",
      "agent-status",
      "quick-actions",
      "focus-timer",
      "efficiency",
    );
    const { container } = render(<WidgetsPanel />);
    expect(container.querySelectorAll("[data-widget-id]")).toHaveLength(6);

    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    expect(screen.getByText("全部微件已添加")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /添加到工作台/ })).toHaveLength(0);
  });

  it("库中只列出尚未启用的微件", () => {
    seedTasks();
    render(<WidgetsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    expect(screen.getByRole("button", { name: "将「专注倒计时」添加到工作台" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "将「今日效率统计」添加到工作台" })).toBeTruthy();
    // 已启用的默认四项不应再占用库空间。
    expect(screen.queryByRole("button", { name: "将「今日任务」添加到工作台" })).toBeNull();
    expect(screen.queryByRole("button", { name: "将「快捷操作」添加到工作台" })).toBeNull();
  });

  it("从库添加后只挂载一次且只订阅一次，卸载时释放", () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const snapshot = makeFocusSnapshot();
    const source: WidgetSource<FocusSnapshot> = { getSnapshot: () => snapshot, subscribe };
    const { container, unmount } = render(<WidgetsPanel sources={{ focus: source }} />);

    expect(container.querySelector('[data-widget-id="focus-timer"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    fireEvent.click(screen.getByRole("button", { name: "将「专注倒计时」添加到工作台" }));

    expect(container.querySelectorAll('[data-widget-id="focus-timer"]')).toHaveLength(1);
    expect(subscribe).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("卡片配置可切换尺寸与条目上限，且不影响桌面开关状态", () => {
    seedTasks();
    render(<WidgetsPanel />);
    const item = () =>
      useWidgetsStore.getState().widgets.find((entry) => entry.widget_id === "today-tasks")!;

    fireEvent.click(screen.getByRole("button", { name: "「今日任务」配置" }));
    fireEvent.click(screen.getByRole("combobox", { name: "「今日任务」尺寸" }));
    fireEvent.click(screen.getByRole("option", { name: "宽" }));
    expect(item().size).toBe("lg");
    expect(item().desktop.visible).toBe(false);

    fireEvent.click(screen.getByRole("combobox", { name: "「今日任务」条目数量" }));
    fireEvent.click(screen.getByRole("option", { name: "8 条" }));
    expect(item().config.maxItems).toBe(8);
    expect(item().desktop.visible).toBe(false);
  });

  it("桌面窗口失败时卡片显示异常并可直接重试", () => {
    seedTasks();
    useWidgetsStore.setState({
      desktopRuntime: {
        "today-tasks": { phase: "failed", error: "窗口创建失败" },
      },
    });
    render(<WidgetsPanel />);

    expect(screen.getByText("窗口异常")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试创建「今日任务」桌面微件" }));
    expect(useWidgetsStore.getState().desktopRetrySeq["today-tasks"]).toBe(1);
    expect(
      useWidgetsStore.getState().widgets.find((entry) => entry.widget_id === "today-tasks")!.enabled,
    ).toBe(true);
  });

  it("停用微件会卸载组件并释放数据源订阅", () => {
    enable("focus-timer");
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const snapshot = makeFocusSnapshot();
    const source: WidgetSource<FocusSnapshot> = {
      getSnapshot: () => snapshot,
      subscribe,
    };
    const { container } = render(<WidgetsPanel sources={{ focus: source }} />);

    expect(container.querySelector('[data-widget-id="focus-timer"]')).toBeTruthy();
    expect(subscribe).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "停用「专注倒计时」" }));

    expect(container.querySelector('[data-widget-id="focus-timer"]')).toBeNull();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("添加微件只在数据源未注入时标记「等待模块接入」", () => {
    const { unmount } = render(<WidgetsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    expect(screen.getAllByText("等待模块接入")).toHaveLength(2);
    unmount();

    render(<WidgetsPanel sources={{ focus: makeFocusSource(), efficiency: EFFICIENCY_SOURCE }} />);
    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    expect(screen.queryByText("等待模块接入")).toBeNull();
  });

  it("任务列表读取失败时不把失败显示成「今天没有到期任务」", () => {
    useTasksStore.setState({
      tasks: [],
      stats: null,
      error: "任务列表读取失败",
      statsError: null,
      loading: false,
    });
    render(<WidgetsPanel />);

    expect(screen.getByText("操作失败")).toBeTruthy();
    expect(screen.queryByText("今天没有到期任务")).toBeNull();
  });

  it("运行中切换语言会立即更新文案，失败态仍保持失败语义", () => {
    enable();
    render(<WidgetsPanel />);
    expect(screen.getByRole("heading", { name: "微件" })).toBeTruthy();
    expect(screen.getByText("还没有启用任何微件")).toBeTruthy();

    act(() => setLocalePreference("en-US"));

    expect(screen.getByRole("heading", { name: "Widgets" })).toBeTruthy();
    expect(screen.getByText("No widgets enabled")).toBeTruthy();
    expect(screen.queryByText("还没有启用任何微件")).toBeNull();

    const addButtons = screen.getAllByRole("button", { name: "Add widgets" });
    fireEvent.click(addButtons[addButtons.length - 1]);
    // 全部停用时六项都可添加；只有依赖未注入的两项标记等待模块接入。
    expect(screen.getByText("Today's tasks")).toBeTruthy();
    expect(screen.getByText("Focus countdown")).toBeTruthy();
    expect(screen.getByText("Today's efficiency")).toBeTruthy();
    expect(screen.getAllByText("Waiting for module")).toHaveLength(2);
  });

  it("en-US 下列表读取失败仍显示失败文案而不是空态", () => {
    act(() => setLocalePreference("en-US"));
    useTasksStore.setState({
      tasks: [],
      stats: null,
      error: "boom",
      statsError: null,
      loading: false,
    });
    render(<WidgetsPanel />);

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByText("Nothing due today")).toBeNull();
  });

  it("上移/下移按钮与拖动都会改变卡片顺序", () => {
    seedTasks();
    const { container } = render(<WidgetsPanel />);
    const ids = () =>
      Array.from(container.querySelectorAll("[data-widget-id]")).map((el) =>
        el.getAttribute("data-widget-id"),
      );

    fireEvent.click(screen.getByRole("button", { name: "「今日任务」配置" }));
    fireEvent.click(screen.getByRole("button", { name: "下移「今日任务」" }));
    expect(ids().slice(0, 2)).toEqual(["next-reminder", "today-tasks"]);

    const first = container.querySelector('[data-widget-id="next-reminder"]')!;
    const second = container.querySelector('[data-widget-id="today-tasks"]')!;
    const dataTransfer = new DragDataStub();
    const grip = second.querySelector(".widget-grip")!;
    fireEvent.dragStart(grip, { dataTransfer: dataTransfer as unknown as DataTransfer });
    fireEvent.dragOver(first, { dataTransfer: dataTransfer as unknown as DataTransfer });
    fireEvent.drop(first, { dataTransfer: dataTransfer as unknown as DataTransfer });
    expect(ids()[0]).toBe("today-tasks");
  });

  it("只有拖动手柄会启动拖动，卡内按钮不触发排序", () => {
    seedTasks();
    const { container } = render(<WidgetsPanel />);
    const card = container.querySelector('[data-widget-id="next-reminder"]')!;
    const dataTransfer = new DragDataStub();

    // 整卡不再是拖动源；手柄才是。
    expect(card.getAttribute("draggable")).toBeNull();
    const grip = card.querySelector(".widget-grip")!;
    expect(grip.getAttribute("draggable")).toBe("true");

    fireEvent.dragStart(screen.getByRole("button", { name: "「今日任务」配置" }), {
      dataTransfer: dataTransfer as unknown as DataTransfer,
    });
    expect(card.className).not.toContain("dragging");

    fireEvent.dragStart(grip, { dataTransfer: dataTransfer as unknown as DataTransfer });
    expect(card.className).toContain("dragging");

    fireEvent.dragEnd(grip, { dataTransfer: dataTransfer as unknown as DataTransfer });
    expect(card.className).not.toContain("dragging");
  });

  it("全部停用时显示空态并可展开添加微件", () => {
    enable();
    render(<WidgetsPanel />);

    expect(screen.getByText("还没有启用任何微件")).toBeTruthy();
    const addButtons = screen.getAllByRole("button", { name: "添加微件" });
    fireEvent.click(addButtons[addButtons.length - 1]);
    expect(screen.getByRole("heading", { name: "添加微件" })).toBeTruthy();
  });

  it("恢复默认布局会重新启用默认微件", () => {
    enable();
    render(<WidgetsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "恢复默认微件布局" }));
    expect(screen.queryByText("还没有启用任何微件")).toBeNull();
  });

  it("恢复默认会关闭桌面显示，且页面与微件库不重复出现入口", () => {
    const items = defaultWidgetItems().map((item) => ({ ...item, enabled: true }));
    const today = items.find((item) => item.widget_id === "today-tasks")!;
    today.desktop = {
      visible: true,
      topmost: true,
      width: 360,
      height: 240,
      nx: 0.5,
      ny: 0.5,
      monitor: "DISPLAY1",
    };
    useWidgetsStore.setState({ widgets: items, hydrated: true });

    render(<WidgetsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "添加微件" }));
    // 全部启用后库只显示完成态；恢复默认只保留页头一个入口。
    expect(screen.getByText("全部微件已添加")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "恢复默认微件布局" }),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "恢复默认微件布局" }));

    const target = useWidgetsStore
      .getState()
      .widgets.find((item) => item.widget_id === "today-tasks")!;
    expect(target.desktop.visible).toBe(false);
    expect(target.desktop.topmost).toBe(false);
    expect(target.desktop.width).toBeUndefined();
    expect(useWidgetsStore.getState().desktopRuntime).toEqual({});
    expect(
      useUiStore.getState().toasts.some(
        (toast) => toast.message.includes("关闭桌面显示") && toast.kind === "info",
      ),
    ).toBe(true);
  });

  it("注入 A/C 数据源后显示真实倒计时与统计，而不是占位", () => {
    enable("focus-timer", "efficiency");
    render(<WidgetsPanel sources={{ focus: makeFocusSource(), efficiency: EFFICIENCY_SOURCE }} />);

    expect(screen.getByText("专注")).toBeTruthy();
    // 65s 倒计时必须是真实的 mm:ss，而不是固定占位；不写死 01:04/01:05。
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toBeTruthy();
    expect(screen.getByText("第 1 / 4 轮")).toBeTruthy();
    expect(screen.getByText("60%")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByText("今日效率统计未接入")).toBeNull();
  });
});
