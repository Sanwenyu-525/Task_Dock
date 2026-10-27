/**
 * @vitest-environment jsdom
 */
//! TasksPanel 真实 DOM 交互测试：搜索框输入与状态筛选点击 → store.setFilter →
//! bridge listTasks 重查 → 任务列表更新。
//!
//! bridge mock：listTasks 按内存 fixture 过滤（模拟后端查询），taskStats 返回固定值；
//! store 用真实实例（走真实 setFilter → load 链路）。fixtures 放在 vi.hoisted 里，
//! 因为 vi.mock 工厂会被提升到模块顶部执行。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useTasksStore } from "../../store/useTasksStore";
import { useNavigationStore } from "../../store/useNavigationStore";
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
  /** 模拟后端 list_tasks：按 search / status 过滤（其余维度与本测试无关）。 */
  const filterTasks = (f: TaskFilter): Task[] => {
    let list = ALL_TASKS;
    if (f.search?.trim()) list = list.filter((t) => t.title.includes(f.search!.trim()));
    if (f.status && f.status !== "all") list = list.filter((t) => t.status === f.status);
    return list;
  };
  return { ALL_TASKS, filterTasks };
});

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    listTasks: vi.fn(async (f: TaskFilter) => filterTasks(f)),
    taskStats: vi.fn(async () => ({
      pending: 2,
      overdue: 0,
      due_today: 1,
      completed_today: 0,
      next_due_at: null,
    })),
    parseQuickAdd: vi.fn(),
    createFromQuickAdd: vi.fn(),
  };
});

function seedTasks() {
  useTasksStore.setState({
    tasks: ALL_TASKS,
    loading: false,
    stats: { pending: 2, overdue: 0, due_today: 1, completed_today: 0, next_due_at: null },
    filter: { view: "all", status: "all", sort: "due" },
  });
  useNavigationStore.setState({ linksByTask: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom 的 requestAnimationFrame 兜底（搜索按钮展开后用 rAF 聚焦输入框）
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TasksPanel 筛选交互", () => {
  it("点击搜索按钮展开输入框，输入关键词过滤任务列表", async () => {
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);

    expect(screen.getByText("买牛奶")).toBeTruthy();
    expect(screen.getByText("写代码")).toBeTruthy();
    expect(screen.getByText("旧任务")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "搜索任务" }));
    const searchInput = await screen.findByPlaceholderText(/搜索标题/);
    await user.type(searchInput, "牛奶");

    await waitFor(() => expect(screen.queryByText("写代码")).toBeNull());
    expect(screen.queryByText("旧任务")).toBeNull();
    expect(screen.getByText("买牛奶")).toBeTruthy();
    expect(useTasksStore.getState().filter.search).toBe("牛奶");
  });

  it("清空搜索恢复全部；点击状态按钮过滤任务列表", async () => {
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);

    // 展开搜索并过滤
    await user.click(screen.getByRole("button", { name: "搜索任务" }));
    await user.type(await screen.findByPlaceholderText(/搜索标题/), "牛奶");
    await waitFor(() => expect(screen.queryByText("写代码")).toBeNull());

    // 清空搜索 → 三条全部回来
    await user.click(await screen.findByRole("button", { name: "清空搜索" }));
    await waitFor(() => expect(screen.getByText("写代码")).toBeTruthy());
    expect(screen.getByText("旧任务")).toBeTruthy();

    // 状态筛选：已完成 → 只剩"旧任务"
    await user.click(screen.getByRole("button", { name: "已完成" }));
    await waitFor(() => expect(screen.queryByText("买牛奶")).toBeNull());
    expect(screen.queryByText("写代码")).toBeNull();
    expect(screen.getByText("旧任务")).toBeTruthy();
    expect(useTasksStore.getState().filter.status).toBe("completed");
  });
});
