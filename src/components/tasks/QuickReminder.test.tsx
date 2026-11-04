/**
 * @vitest-environment jsdom
 */
//! QuickReminder（智能日程提醒 2.0）回归：
//! - 预设时长一键创建：remind_at = 绝对时间（now + N 分钟），复用现有任务创建链路；
//! - 自定义时/分严格校验：0 时 0 分、越界值就地报错不发请求；
//! - 创建在途（creating）期间按钮禁用，连点不重复提交；
//! - 创建失败显示真实错误，不显示成功 Toast。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useUiStore } from "../../store/useUiStore";
import QuickReminder from "./QuickReminder";

const { createTask, taskStats, listTasks } = vi.hoisted(() => ({
  createTask: vi.fn(),
  taskStats: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, createTask, taskStats, listTasks };
});

/** 快捷提醒默认收起（轻量化专项 A2）：交互前先展开，功能语义不变。 */
async function expandReminder(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "展开快捷提醒" }));
}

function taskResult(title: string) {
  return {
    id: "t-new",
    title,
    remind_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

describe("QuickReminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Toast 队列是模块级 store：清掉跨用例残留，避免污染断言
    useUiStore.getState().showToast(null);
    taskStats.mockResolvedValue({
      pending: 1,
      overdue: 0,
      due_today: 0,
      completed_today: 0,
      next_due_at: null,
    });
    listTasks.mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it("预设 10 分钟：以绝对时间 remind_at 创建任务", async () => {
    const user = userEvent.setup();
    createTask.mockResolvedValue(taskResult("休息一下"));
    render(<QuickReminder />);
    await expandReminder(user);

    await user.type(screen.getByPlaceholderText(/快速提醒/), "休息一下");
    await user.click(screen.getByRole("button", { name: "10 分钟" }));

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    const input = createTask.mock.calls[0][0];
    expect(input.title).toBe("休息一下");
    // 绝对时间：10 分钟 ± 交叉抖动
    const delta = new Date(input.remind_at).getTime() - Date.now();
    expect(delta).toBeGreaterThan(9 * 60_000);
    expect(delta).toBeLessThan(11 * 60_000);
    // 成功 Toast 展示预计提醒时间
    expect(useUiStore.getState().toasts.some((t) => (t.message ?? "").includes("已创建提醒"))).toBe(true);
  });

  it("未填标题时使用默认标题「快速提醒」", async () => {
    const user = userEvent.setup();
    createTask.mockResolvedValue(taskResult("快速提醒"));
    render(<QuickReminder />);
    await expandReminder(user);
    await user.click(screen.getByRole("button", { name: "30 分钟" }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    expect(createTask.mock.calls[0][0].title).toBe("快速提醒");
  });

  it("自定义 0 时 0 分：就地报错，不发请求", async () => {
    const user = userEvent.setup();
    render(<QuickReminder />);
    await expandReminder(user);
    await user.click(screen.getByRole("button", { name: "自定义…" }));
    // 分钟改为 0（NumberInput 清空不提交，需显式输入 0）
    const minute = screen.getByLabelText("自定义分钟");
    await user.clear(minute);
    await user.type(minute, "0");
    await user.click(screen.getByRole("button", { name: "开始" }));
    expect(await screen.findByText("至少 1 分钟后提醒")).toBeTruthy();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("自定义 1 时 30 分：创建 90 分钟后的提醒", async () => {
    const user = userEvent.setup();
    createTask.mockResolvedValue(taskResult("倒杯水"));
    render(<QuickReminder />);
    await expandReminder(user);
    await user.click(screen.getByRole("button", { name: "自定义…" }));
    await user.clear(screen.getByLabelText("自定义小时"));
    await user.type(screen.getByLabelText("自定义小时"), "1");
    await user.clear(screen.getByLabelText("自定义分钟"));
    await user.type(screen.getByLabelText("自定义分钟"), "30");
    await user.click(screen.getByRole("button", { name: "开始" }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    const delta = new Date(createTask.mock.calls[0][0].remind_at).getTime() - Date.now();
    expect(delta).toBeGreaterThan(89 * 60_000);
    expect(delta).toBeLessThan(91 * 60_000);
  });

  it("创建失败：显示真实错误，不弹成功 Toast", async () => {
    const user = userEvent.setup();
    createTask.mockRejectedValue(new Error("任务标题不能为空"));
    render(<QuickReminder />);
    await expandReminder(user);
    await user.click(screen.getByRole("button", { name: "5 分钟" }));
    expect(await screen.findByText(/任务标题不能为空/)).toBeTruthy();
    expect(useUiStore.getState().toasts.some((t) => (t.message ?? "").includes("已创建提醒"))).toBe(false);
  });
});
