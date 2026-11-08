// 提醒排期仓储：reminder_schedule 是「手机侧已经排过哪些通知」的唯一事实记录。
// 幂等键为 (task_id, occurrence_at)：同一任务在同一绝对时刻只会有一条记录，
// 重新排期不会产生重复通知。
import { getDatabase } from "./database";

export interface ReminderTask {
  id: string;
  title: string;
  /** 绝对 epoch ms（UTC 存储；触发时由系统按设备本地时区换算） */
  remindAt: number;
}

export interface ReminderScheduleEntry {
  taskId: string;
  occurrenceAt: number;
  notificationId: string;
  scheduledAt: number;
}

interface ReminderTaskRow {
  id: string;
  title: string;
  remind_at: number;
}

interface ReminderScheduleRow {
  task_id: string;
  occurrence_at: number;
  notification_id: string;
  scheduled_at: number;
}

/**
 * 取出需要排期的任务：未完成、未删除、提醒时间严格晚于 now。
 * 按 remind_at 升序（同一时刻用 id 兜底，保证 64 条上限的淘汰结果稳定）。
 */
export async function listUpcomingReminderTasks(
  now: number,
  limit: number,
): Promise<ReminderTask[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<ReminderTaskRow>(
    `SELECT id, title, remind_at FROM tasks
     WHERE deleted_at IS NULL
       AND status = 'pending'
       AND remind_at IS NOT NULL
       AND remind_at > ?
     ORDER BY remind_at ASC, id ASC
     LIMIT ?`,
    [now, limit],
  );
  return rows.map((row) => ({ id: row.id, title: row.title, remindAt: row.remind_at }));
}

/** 只计数不取行：用于把 64 条上限之外的量准确记入 skipped */
export async function countUpcomingReminderTasks(now: number): Promise<number> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks
     WHERE deleted_at IS NULL
       AND status = 'pending'
       AND remind_at IS NOT NULL
       AND remind_at > ?`,
    [now],
  );
  return row?.n ?? 0;
}

/** 全量读取排期记录；行数上限由引擎控制（最多 64 条），不需要分页 */
export async function listReminderSchedules(): Promise<ReminderScheduleEntry[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<ReminderScheduleRow>(
    `SELECT task_id, occurrence_at, notification_id, scheduled_at
     FROM reminder_schedule
     ORDER BY occurrence_at ASC`,
  );
  return rows.map((row) => ({
    taskId: row.task_id,
    occurrenceAt: row.occurrence_at,
    notificationId: row.notification_id,
    scheduledAt: row.scheduled_at,
  }));
}

/** 幂等写入：同一 (task_id, occurrence_at) 重复调用只更新元数据，不新增行 */
export async function saveReminderSchedule(entry: ReminderScheduleEntry): Promise<void> {
  const db = getDatabase();
  await db.runAsync(
    `INSERT INTO reminder_schedule (task_id, occurrence_at, notification_id, scheduled_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id, occurrence_at) DO UPDATE SET
       notification_id = excluded.notification_id,
       scheduled_at = excluded.scheduled_at`,
    [entry.taskId, entry.occurrenceAt, entry.notificationId, entry.scheduledAt],
  );
}

export async function deleteReminderSchedule(
  taskId: string,
  occurrenceAt: number,
): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`DELETE FROM reminder_schedule WHERE task_id = ? AND occurrence_at = ?`, [
    taskId,
    occurrenceAt,
  ]);
}

export async function deleteReminderSchedulesForTask(taskId: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`DELETE FROM reminder_schedule WHERE task_id = ?`, [taskId]);
}

/** 清空排期记录：只给「整体重建」用（例如通知动作按钮需要重新注册到旧通知上） */
export async function deleteAllReminderSchedules(): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`DELETE FROM reminder_schedule`);
}
