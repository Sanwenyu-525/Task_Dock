// 生活待办反馈回归：任务成功落库后，提醒排期/重排失败只能作为警告返回，
// 不能让调用方显示「保存失败」或「更新待办失败」。
import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../../domain/types";
import {
  createLifeTaskWithReminder,
  LIFE_TASK_CATEGORY,
  toggleLifeTaskWithReminder,
} from "../taskActions";

function fakeTask(id = "task-1"): Task {
  return {
    id,
    title: "取快递",
    description: "",
    status: "pending",
    priority: 0,
    category: LIFE_TASK_CATEGORY,
    tags: [],
    dueAt: null,
    remindAt: null,
    advanceMinutes: 0,
    recurrenceRule: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    deletedAt: null,
    rev: 1,
    serverRev: 0,
  } as Task;
}

describe("生活待办反馈", () => {
  it("提醒排期抛错：任务仍保存成功，只返回提醒警告", async () => {
    const createTask = vi.fn(async () => fakeTask());
    const scheduleReminder = vi.fn(async () => {
      throw new Error("通知权限被关闭");
    });
    const result = await createLifeTaskWithReminder(
      { title: "取快递", remindAt: Date.now() + 60_000 },
      {
        createTask,
        getSetting: async () => null,
        scheduleReminder,
        snoozeSettingKey: "reminder_snooze",
      },
    );
    expect(result.task.id).toBe("task-1");
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "取快递", category: LIFE_TASK_CATEGORY }),
    );
    expect(result.reminderWarning).toContain("提醒排期失败");
  });

  it("通知权限未开启：返回可读警告，不抛错", async () => {
    const result = await createLifeTaskWithReminder(
      { title: "交电费", remindAt: Date.now() + 60_000 },
      {
        createTask: async () => fakeTask(),
        getSetting: async () => "0",
        scheduleReminder: async () => false,
        snoozeSettingKey: "reminder_snooze",
      },
    );
    expect(result.reminderWarning).toContain("提醒未开启");
  });

  it("无提醒时间时不调用排期，也不产生警告", async () => {
    const scheduleReminder = vi.fn(async () => true);
    const result = await createLifeTaskWithReminder(
      { title: "打扫房间" },
      {
        createTask: async () => fakeTask(),
        getSetting: async () => null,
        scheduleReminder,
        snoozeSettingKey: "reminder_snooze",
      },
    );
    expect(scheduleReminder).not.toHaveBeenCalled();
    expect(result.reminderWarning).toBeNull();
  });

  it("任务完成成功但重排失败：完成结果保留，只返回提醒警告", async () => {
    const task = fakeTask();
    const result = await toggleLifeTaskWithReminder("task-1", {
      toggleTask: async () => ({ task, advanced: null }),
      rescheduleAllReminders: async () => {
        throw new Error("通知服务不可用");
      },
    });
    expect(result.outcome.task?.id).toBe("task-1");
    expect(result.reminderWarning).toContain("提醒重排失败");
  });

  it("任务不存在时不重排提醒，也不产生成功提示", async () => {
    const reschedule = vi.fn(async () => undefined);
    const result = await toggleLifeTaskWithReminder("missing", {
      toggleTask: async () => ({ task: null, advanced: null }),
      rescheduleAllReminders: reschedule,
    });
    expect(result.outcome.task).toBeNull();
    expect(reschedule).not.toHaveBeenCalled();
    expect(result.reminderWarning).toBeNull();
  });
});
