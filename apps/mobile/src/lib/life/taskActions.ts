// 生活待办的保存/完成语义：任务写入与通知排期是两条独立链路。
//
// 任务保存成功后，提醒权限、排期或重排失败都只能返回「提醒异常」警告，
// 不能让调用方把已经成功的任务操作描述成失败。抽成纯函数便于回归测试。
import type { ToggleOutcome } from "../../db/tasks";
import type { NewTaskInput, Task } from "../../domain/types";
import { describeError } from "../errors";

export const LIFE_TASK_CATEGORY = "生活";

export interface LifeTaskCreateDeps {
  createTask: (input: NewTaskInput) => Promise<Task>;
  getSetting: (key: string) => Promise<string | null>;
  scheduleReminder: (
    taskId: string,
    title: string,
    atMs: number,
    snoozeEnabled: boolean,
  ) => Promise<boolean>;
  snoozeSettingKey: string;
}

export interface LifeTaskCreateResult {
  task: Task;
  /** null = 无需提醒或排期成功；非空 = 任务已保存，但提醒需要用户处理。 */
  reminderWarning: string | null;
}

export async function createLifeTaskWithReminder(
  input: NewTaskInput,
  deps: LifeTaskCreateDeps,
): Promise<LifeTaskCreateResult> {
  const task = await deps.createTask({ ...input, category: LIFE_TASK_CATEGORY });
  let reminderWarning: string | null = null;
  if (input.remindAt != null) {
    try {
      const snooze = (await deps.getSetting(deps.snoozeSettingKey)) !== "0";
      const scheduled = await deps.scheduleReminder(
        task.id,
        task.title,
        input.remindAt,
        snooze,
      );
      if (!scheduled) reminderWarning = "提醒未开启（系统通知权限未开启）";
    } catch (reason) {
      reminderWarning = `提醒排期失败：${describeError(reason)}`;
    }
  }
  return { task, reminderWarning };
}

export interface LifeTaskToggleDeps {
  toggleTask: (id: string) => Promise<ToggleOutcome>;
  rescheduleAllReminders: () => Promise<unknown>;
}

export interface LifeTaskToggleResult {
  outcome: ToggleOutcome;
  /** null = 任务状态与提醒都正常；非空 = 任务状态已落库，但提醒重排失败。 */
  reminderWarning: string | null;
}

export async function toggleLifeTaskWithReminder(
  taskId: string,
  deps: LifeTaskToggleDeps,
): Promise<LifeTaskToggleResult> {
  const outcome = await deps.toggleTask(taskId);
  if (!outcome.task) return { outcome, reminderWarning: null };
  let reminderWarning: string | null = null;
  try {
    await deps.rescheduleAllReminders();
  } catch (reason) {
    reminderWarning = `提醒重排失败：${describeError(reason)}`;
  }
  return { outcome, reminderWarning };
}
