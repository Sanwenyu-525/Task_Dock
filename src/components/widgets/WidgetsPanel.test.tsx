// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { useAgentsStore } from "../../store/useAgentsStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useWidgetsStore } from "../../store/useWidgetsStore";
import WidgetsPanel from "./WidgetsPanel";

const NOW = Date.now();

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
  const at = new Date(NOW - 60_000).toISOString();
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
      makeTask("t-overdue", "补交周报", new Date(NOW - 3_600_000).toISOString()),
      makeTask("t-today", "评审设计稿", new Date(NOW + 3_600_000).toISOString()),
      makeTask("t-done", "已完成任务", new Date(NOW - 3_600_000).toISOString(), "completed"),
      makeTask("t-tomorrow", "明天的事", new Date(NOW + 2 * 24 * 3_600_000).toISOString()),
    ],
    stats: STATS,
    statsError: null,
    loading: false,
  });
}

const FOCUS_SNAPSHOT: FocusSnapshot = {
  phase: "focus",
  label: "专注",
  endsAt: new Date(NOW + 65_000).toISOString(),
  cycle: { index: 1, total: 4 },
};

const FOCUS_SOURCE: WidgetSource<FocusSnapshot> = {
  getSnapshot: () => FOCUS_SNAPSHOT,
  subscribe: () => () => {},
};

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
  useWidgetsStore.setState({ widgets: defaultWidgetItems(), hydrated: false });
  useAgentsStore.setState({ snapshot: EMPTY_SNAPSHOT, snapshotError: null });
  useTasksStore.setState({ tasks: [], stats: null, statsError: null, loading: false });
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
        tasks: [...state.tasks, makeTask("t-new", "新到期任务", new Date(NOW - 60_000).toISOString())],
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
      remindAt: new Date(NOW + 65_000).toISOString(),
      occurrence: "2026-06-18T09:00:00.000Z",
      kind: "deadline",
      snoozed: false,
      taskStatus: "pending",
      hasRecurrence: false,
    };
    vi.mocked(activeReminders).mockResolvedValue([reminder]);

    const { unmount } = render(<WidgetsPanel />);

    expect(await screen.findByText("提交报销单")).toBeTruthy();
    expect(screen.getByText(/01:0[45]/)).toBeTruthy();
    expect(vi.mocked(activeReminders)).toHaveBeenCalled();

    await waitFor(() => expect(vi.mocked(onReminderFired)).toHaveBeenCalled());
    unmount();
    await waitFor(() => {
      expect(unlistenFired).toHaveBeenCalled();
      expect(unlistenSnoozed).toHaveBeenCalled();
    });
  });

  it("微件库可停用微件并立即卸载卡片", () => {
    seedTasks();
    const { container } = render(<WidgetsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "微件库" }));
    fireEvent.click(screen.getByRole("switch", { name: "启用「快捷操作」" }));

    expect(container.querySelector('[data-widget-id="quick-actions"]')).toBeNull();
    expect(screen.getByText("已启用 3 / 6")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "启用「专注倒计时」" }));
    expect(container.querySelector('[data-widget-id="focus-timer"]')).toBeTruthy();
    expect(screen.getByText("专注倒计时未接入")).toBeTruthy();
  });

  it("上移/下移按钮与拖动都会改变卡片顺序", () => {
    seedTasks();
    const { container } = render(<WidgetsPanel />);
    const ids = () =>
      Array.from(container.querySelectorAll("[data-widget-id]")).map((el) =>
        el.getAttribute("data-widget-id"),
      );

    fireEvent.click(screen.getByRole("button", { name: "下移「今日任务」" }));
    expect(ids().slice(0, 2)).toEqual(["next-reminder", "today-tasks"]);

    const first = container.querySelector('[data-widget-id="next-reminder"]')!;
    const second = container.querySelector('[data-widget-id="today-tasks"]')!;
    const dataTransfer = new DragDataStub();
    fireEvent.dragStart(second, { dataTransfer: dataTransfer as unknown as DataTransfer });
    fireEvent.dragOver(first, { dataTransfer: dataTransfer as unknown as DataTransfer });
    fireEvent.drop(first, { dataTransfer: dataTransfer as unknown as DataTransfer });
    expect(ids()[0]).toBe("today-tasks");
  });

  it("全部停用时显示空态并可重新打开微件库", () => {
    enable();
    render(<WidgetsPanel />);

    expect(screen.getByText("还没有启用任何微件")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开微件库" }));
    expect(screen.getByRole("heading", { name: "微件库" })).toBeTruthy();
  });

  it("恢复默认布局会重新启用默认微件", () => {
    enable();
    render(<WidgetsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "恢复默认微件布局" }));
    expect(screen.queryByText("还没有启用任何微件")).toBeNull();
  });

  it("注入 A/C 数据源后显示真实倒计时与统计，而不是占位", () => {
    enable("focus-timer", "efficiency");
    render(<WidgetsPanel sources={{ focus: FOCUS_SOURCE, efficiency: EFFICIENCY_SOURCE }} />);

    expect(screen.getByText("专注")).toBeTruthy();
    expect(screen.getByText(/01:0[45]/)).toBeTruthy();
    expect(screen.getByText("第 1 / 4 轮")).toBeTruthy();
    expect(screen.getByText("60%")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByText("今日效率统计未接入")).toBeNull();
  });
});
