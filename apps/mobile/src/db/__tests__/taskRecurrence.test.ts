// 重复任务完成后的数据契约：验收表 13 的数据库层部分。
// TaskDetailScreen 必须用 toggleTask 返回的 outcome.task 刷新页面，否则会停留在旧日期。
// 这里固定「返回值与库内一致」以及普通任务不受影响的基线。
import { beforeEach, describe, expect, it } from "vitest";

import { serializeRecurrence } from "../../domain/recurrence";
import { closeDatabase, openDatabase } from "../database";
import { createTask, getTask, toggleTask } from "../tasks";

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
});

function todayAt(hour: number, minute = 0): number {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

describe("重复任务：完成本期推进到下一期", () => {
  it("返回 outcome.task 携带新的截止时间与提醒时间，并与库内一致", async () => {
    const dueAt = todayAt(9);
    const task = await createTask({
      title: "每日站会",
      dueAt,
      remindAt: dueAt - 10 * 60_000,
      advanceMinutes: 10,
      recurrenceRule: serializeRecurrence({
        freq: "daily",
        interval: 1,
        by_weekday: [],
        by_monthday: null,
      }),
    });

    const outcome = await toggleTask(task.id);
    expect(outcome.task).not.toBeNull();
    expect(outcome.advanced).not.toBeNull();
    expect(outcome.advanced?.fromDueAt).toBe(dueAt);
    expect(outcome.advanced?.toDueAt).toBe(outcome.task?.dueAt);

    // 完成「本期」不是把任务标成已完成：仍待办、截止时间严格晚于当前时刻
    expect(outcome.task?.status).toBe("pending");
    expect(outcome.task?.completedAt).toBeNull();
    expect(outcome.task?.dueAt).toBeGreaterThan(Date.now());
    // 提醒偏移保持不变（10 分钟），不是凭空重置
    expect(outcome.task?.remindAt).toBe((outcome.task?.dueAt ?? 0) - 10 * 60_000);
    expect(outcome.task?.rev).toBe(task.rev + 1);

    // 详情页刷新用的快照必须与数据库真实行一致，不能只改内存
    const stored = await getTask(task.id);
    expect(stored?.dueAt).toBe(outcome.task?.dueAt);
    expect(stored?.remindAt).toBe(outcome.task?.remindAt);
    expect(stored?.rev).toBe(outcome.task?.rev);
  });

  it("原本没有提醒的重复任务：推进后仍然没有提醒", async () => {
    const dueAt = todayAt(8);
    const task = await createTask({
      title: "每日喝水",
      dueAt,
      remindAt: null,
      recurrenceRule: serializeRecurrence({
        freq: "daily",
        interval: 1,
        by_weekday: [],
        by_monthday: null,
      }),
    });

    const outcome = await toggleTask(task.id);
    expect(outcome.task?.dueAt).toBeGreaterThan(dueAt);
    expect(outcome.task?.remindAt).toBeNull();
  });
});

describe("普通任务：完成/恢复逻辑不受重复任务改动影响", () => {
  it("完成 → completed；再次切换 → pending，并清空完成时间", async () => {
    const task = await createTask({ title: "一次性任务", dueAt: todayAt(12) });

    const completed = await toggleTask(task.id);
    expect(completed.advanced).toBeNull();
    expect(completed.task?.status).toBe("completed");
    expect(completed.task?.completedAt).not.toBeNull();

    const restored = await toggleTask(task.id);
    expect(restored.advanced).toBeNull();
    expect(restored.task?.status).toBe("pending");
    expect(restored.task?.completedAt).toBeNull();
  });

  it("任务已不存在：返回 task=null，调用方据此回到列表或提示", async () => {
    const outcome = await toggleTask("missing-task-id");
    expect(outcome).toEqual({ task: null, advanced: null });
  });
});
