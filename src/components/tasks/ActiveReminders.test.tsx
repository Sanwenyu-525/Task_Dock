/**
 * @vitest-environment jsdom
 */
//! ActiveReminders（智能日程提醒 2.0）回归：
//! - 只在有未触发提醒时渲染；倒计时按绝对时间换算（共享时钟）；
//! - >1h 显示时:分、<1h 显示分:秒、到期显示「已到期」；
//! - 延后走真实 snooze_reminder；失败弹真实错误不显示成功；
//! - 重复任务不提供「取消」（due 提醒是推进引擎输入）；
//! - 卸载后释放 reminder-fired / reminder-snoozed 订阅。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useUiStore } from "../../store/useUiStore";
import ActiveReminders from "./ActiveReminders";
import type { ActiveReminder } from "../../lib/bridge";

const {
  activeReminders,
  snoozeReminder,
  cancelReminders,
  onReminderFired,
  onReminderSnoozed,
  taskStats,
  listTasks,
  toggleTask,
  firedOffs,
  snoozedOffs,
} = vi.hoisted(() => {
  // 记录每次订阅返回的反订阅函数，卸载后逐一断言被调用
  const firedOffs: Array<ReturnType<typeof vi.fn>> = [];
  const snoozedOffs: Array<ReturnType<typeof vi.fn>> = [];
  return {
    activeReminders: vi.fn(),
    snoozeReminder: vi.fn(),
    cancelReminders: vi.fn(),
    onReminderFired: vi.fn(async () => {
      const off = vi.fn();
      firedOffs.push(off);
      return off;
    }),
    onReminderSnoozed: vi.fn(async () => {
      const off = vi.fn();
      snoozedOffs.push(off);
      return off;
    }),
    taskStats: vi.fn(),
    listTasks: vi.fn(),
    toggleTask: vi.fn(),
    firedOffs,
    snoozedOffs,
  };
});

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    activeReminders,
    snoozeReminder,
    cancelReminders,
    onReminderFired,
    onReminderSnoozed,
    taskStats,
    listTasks,
    toggleTask,
  };
});

function item(p: Partial<ActiveReminder> & Pick<ActiveReminder, "taskId" | "taskTitle" | "remindAt">): ActiveReminder {
  return {
    reminderId: `r-${p.taskId}`,
    occurrence: p.remindAt,
    kind: "due",
    snoozed: false,
    taskStatus: "pending",
    hasRecurrence: false,
    ...p,
  };
}

describe("ActiveReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 反订阅收集器是模块级的：清空，避免把上个用例已释放的 off 算进来
    firedOffs.length = 0;
    snoozedOffs.length = 0;
    // Toast 队列是模块级 store：清掉跨用例残留，避免污染断言
    useUiStore.getState().showToast(null);
    taskStats.mockResolvedValue({ pending: 0, overdue: 0, due_today: 0, completed_today: 0, next_due_at: null });
    listTasks.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
  });

  it("无提醒时不渲染", async () => {
    activeReminders.mockResolvedValue([]);
    const { container } = render(<ActiveReminders />);
    await vi.waitFor(() => expect(activeReminders).toHaveBeenCalled());
    expect(container.querySelector(".active-reminders")).toBeNull();
  });

  it("倒计时口径：>1h 时:分，<1h 分:秒，到期显示已到期", async () => {
    activeReminders.mockResolvedValue([
      item({ taskId: "t1", taskTitle: "一小时以上", remindAt: new Date(Date.now() + 90 * 60_000).toISOString() }),
      item({ taskId: "t2", taskTitle: "不足一小时", remindAt: new Date(Date.now() + 30_000).toISOString() }),
      item({ taskId: "t3", taskTitle: "过期提醒", remindAt: new Date(Date.now() - 5_000).toISOString() }),
    ]);
    render(<ActiveReminders />);
    expect(await screen.findByText("一小时以上")).toBeTruthy();
    expect(screen.getByText("1:30")).toBeTruthy();
    expect(screen.getByText("00:30")).toBeTruthy();
    const expiredText = screen.getByText("已到期");
    expect(expiredText).toBeTruthy();
    // 项目未引入 jest-dom：用原生 classList 断言，避免依赖额外匹配器
    expect(expiredText.closest(".active-reminder-card")?.classList.contains("expired")).toBe(true);
  });

  it("延后走真实 snooze_reminder，失败弹真实错误", async () => {
    const user = userEvent.setup();
    activeReminders.mockResolvedValue([
      item({ taskId: "t1", taskTitle: "写周报", remindAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
    ]);
    render(<ActiveReminders />);
    await screen.findByText("写周报");
    // DropdownMenu 触发器打开菜单
    await user.click(screen.getByRole("button", { name: /延后「写周报」/ }));
    await user.click(await screen.findByRole("menuitem", { name: "10 分钟后再提醒" }));
    await waitFor(() => expect(snoozeReminder).toHaveBeenCalledWith("t1", 10));
    // 成功反馈由 reminder-snoozed 事件的统一 Toast 处理（App 层），组件内不弹成功
    expect(useUiStore.getState().toasts.some((t) => t.message.includes("已延后"))).toBe(false);
  });

  it("延后失败：显示后端返回的真实原因", async () => {
    const user = userEvent.setup();
    activeReminders.mockResolvedValue([
      item({ taskId: "t1", taskTitle: "过期任务", remindAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
    ]);
    snoozeReminder.mockRejectedValue(new Error("任务已完成，无法延后提醒（当前状态: completed）"));
    render(<ActiveReminders />);
    await screen.findByText("过期任务");
    await user.click(screen.getByRole("button", { name: /延后「过期任务」/ }));
    await user.click(await screen.findByRole("menuitem", { name: "5 分钟后再提醒" }));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.message.includes("任务已完成"))).toBe(true),
    );
  });

  it("重复任务不提供取消按钮，非重复任务可取消", async () => {
    const user = userEvent.setup();
    activeReminders.mockResolvedValue([
      item({ taskId: "rec", taskTitle: "每日站会", remindAt: new Date(Date.now() + 30 * 60_000).toISOString(), hasRecurrence: true }),
      item({ taskId: "one", taskTitle: "一次性提醒", remindAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
    ]);
    cancelReminders.mockResolvedValue(1);
    render(<ActiveReminders />);
    await screen.findByText("每日站会");
    expect(screen.queryByRole("button", { name: /取消「每日站会」/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /取消「一次性提醒」/ }));
    await waitFor(() => expect(cancelReminders).toHaveBeenCalledWith("one"));
  });

  it("已延后的提醒带「已延后」标记", async () => {
    const remindAt = new Date(Date.now() + 30 * 60_000).toISOString();
    activeReminders.mockResolvedValue([
      item({ taskId: "t1", taskTitle: "被延后的", remindAt, occurrence: new Date(Date.now() + 20 * 60_000).toISOString(), snoozed: true }),
    ]);
    render(<ActiveReminders />);
    expect(await screen.findByText("已延后")).toBeTruthy();
  });

  it("卸载后释放事件订阅", async () => {
    activeReminders.mockResolvedValue([]);
    const { unmount } = render(<ActiveReminders />);
    await vi.waitFor(() => expect(onReminderFired).toHaveBeenCalled());
    expect(onReminderSnoozed).toHaveBeenCalled();
    unmount();
    await vi.waitFor(() => {
      expect(firedOffs.length).toBeGreaterThan(0);
      expect(snoozedOffs.length).toBeGreaterThan(0);
      for (const off of firedOffs) expect(off).toHaveBeenCalled();
      for (const off of snoozedOffs) expect(off).toHaveBeenCalled();
    });
  });
});
