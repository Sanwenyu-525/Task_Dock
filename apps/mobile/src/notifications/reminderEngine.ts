// 提醒引擎：负责「哪些任务需要本地通知、排几条、何时清理」，
// 通知通道本身仍由 reminders.ts 提供，这里不重复实现权限/通道逻辑。
//
// 时间语义：tasks.remind_at 与 reminder_schedule.occurrence_at 都是绝对 epoch ms（UTC 存储），
// 系统按设备当前时区把它换算成本地触发时刻。设备跨时区后绝对时刻不变，
// 因此这里绝不按本地墙钟重算已有记录 —— 那会让用户在飞机上把提醒推迟/提前。
import {
  countUpcomingReminderTasks,
  deleteAllReminderSchedules,
  deleteReminderSchedule,
  deleteReminderSchedulesForTask,
  listReminderSchedules,
  listUpcomingReminderTasks,
  saveReminderSchedule,
} from "../db/reminderSchedule";
import { cancelReminder, listScheduledNotificationIds, reminderId, scheduleReminder } from "./reminders";

/** 与 docs/MOBILE_STACK.md §9 一致：本地通知最多排 64 条，超出按最远触发时间淘汰 */
export const MAX_SCHEDULED_REMINDERS = 64;

export interface RescheduleResult {
  /** 本次真正写入系统通知的数量 */
  scheduled: number;
  /** 因超出上限、已排期或系统未授权而跳过的数量 */
  skipped: number;
}

let inFlight: Promise<RescheduleResult> | null = null;

const scheduleKey = (taskId: string, occurrenceAt: number): string => `${taskId}@${occurrenceAt}`;

/**
 * 全量重建提醒排期。幂等：已有 (task_id, occurrence_at) 记录且时刻仍在未来的任务直接跳过，
 * 不会被重复排期；过期记录、已完成/已删除任务的记录会被清理。
 *
 * 单飞：应用前台恢复等场景可能同时触发多次，这里复用同一轮结果，避免并发重复调用通知 API。
 */
export async function rescheduleAllReminders(): Promise<RescheduleResult> {
  if (inFlight) return inFlight;

  const run = runReschedule();
  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

async function runReschedule(): Promise<RescheduleResult> {
  const now = Date.now();
  const [total, tasks, schedules] = await Promise.all([
    countUpcomingReminderTasks(now),
    listUpcomingReminderTasks(now, MAX_SCHEDULED_REMINDERS),
    listReminderSchedules(),
  ]);
  // 系统现状：读取失败时退回「只信本地记录」，避免对账本身把提醒全清一遍
  const systemIds = await listScheduledNotificationIds().catch(() => null);

  // 本次允许保留的键：taskId → occurrenceAt（同一任务只保留当前 remind_at 这一条）
  const desired = new Map<string, number>();
  for (const task of tasks) desired.set(task.id, task.remindAt);

  // 先清理不再需要的排期记录。
  // 关键：通知 identifier 只由 taskId 派生，若任务仍在本次排期集合内（只是改了发生时刻），
  // 绝不能调用 cancelReminder —— 那会把随后要用的同名新通知一起取消。只删旧记录即可。
  const cancelled = new Set<string>();
  for (const entry of schedules) {
    if (desired.get(entry.taskId) === entry.occurrenceAt) continue;
    if (!desired.has(entry.taskId) && !cancelled.has(entry.taskId)) {
      cancelled.add(entry.taskId);
      await cancelReminder(entry.taskId);
    }
    await deleteReminderSchedule(entry.taskId, entry.occurrenceAt);
  }

  const scheduledKeys = new Set(
    schedules.map((entry) => scheduleKey(entry.taskId, entry.occurrenceAt)),
  );

  // 超出 64 条的部分按「最远触发时间」淘汰；SQL 已按 remind_at 升序取前 64 条。
  let scheduled = 0;
  let skipped = Math.max(0, total - tasks.length);

  for (const task of tasks) {
    const key = scheduleKey(task.id, task.remindAt);
    // 记录存在不代表系统里还在：重启、应用更新、被系统清理都会丢闹钟。
    // 系统侧找不到这条通知时重新排一次，否则提醒会静默消失。
    const stillScheduled = systemIds ? systemIds.has(reminderId(task.id)) : true;
    if (scheduledKeys.has(key) && stillScheduled) {
      // 已在 reminder_schedule 中且未过期：幂等跳过，不重复调用系统通知
      skipped += 1;
      continue;
    }

    const ok = await scheduleReminder(task.id, task.title, task.remindAt);
    if (!ok) {
      // 权限未授权或时间已过去：不写记录，下次重建时会再次尝试
      skipped += 1;
      continue;
    }

    await saveReminderSchedule({
      taskId: task.id,
      occurrenceAt: task.remindAt,
      notificationId: reminderId(task.id),
      scheduledAt: now,
    });
    scheduled += 1;
  }

  return { scheduled, skipped };
}

/**
 * 取消并清理单个任务的全部排期记录。
 * 若此刻有一轮 reschedule 在跑，先等它结束再清理，否则它可能在本函数返回后把记录写回来。
 */
export async function clearTaskReminder(taskId: string): Promise<void> {
  const running = inFlight;
  if (running) {
    // 重建失败不应阻止清理动作，因此这里吞掉错误；调用方仍会拿到清理本身的异常
    await running.catch(() => undefined);
  }

  await cancelReminder(taskId);
  await deleteReminderSchedulesForTask(taskId);
}

/**
 * 整体重建：先取消所有已排期通知、清空记录，再重新排一遍。
 *
 * 为什么需要它：通知上的动作按钮属于「排期时」就固定下来的内容（categoryIdentifier），
 * 老版本排下的通知即使升级了应用也不会长出按钮。只在通知能力版本变化时调用一次，
 * 避免每次启动都把 64 条通知全部重排。
 */
export async function rebuildAllReminders(): Promise<RescheduleResult> {
  const running = inFlight;
  if (running) await running.catch(() => undefined);

  const schedules = await listReminderSchedules();
  const cancelled = new Set<string>();
  for (const entry of schedules) {
    if (cancelled.has(entry.taskId)) continue;
    cancelled.add(entry.taskId);
    await cancelReminder(entry.taskId);
  }
  await deleteAllReminderSchedules();

  return rescheduleAllReminders();
}
