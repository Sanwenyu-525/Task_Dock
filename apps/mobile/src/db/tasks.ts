// 任务仓储：所有 SQL 只出现在这一层，UI 不直接碰数据库。
// 每次写业务表与写 outbox 在同一事务内完成，保证「要么都成功，要么都不发生」。
import type { SQLiteDatabase } from "expo-sqlite";

import type { NewTaskInput, Priority, Task, TaskStatus } from "../domain/types";
import { newId } from "../lib/id";

import { getDatabase } from "./database";
import { clampPriority, mapTaskRow, TASK_COLUMNS, type TaskDbRow } from "./taskRows";

export { updateTask } from "./taskUpdate";

/**
 * 任务三态更新补丁（docs/MOBILE_STACK.md §3.3）：
 * - 键缺失（或显式 undefined）= 不改；
 * - null = 清空（NOT NULL 列落到该列默认值：description → ''，priority → 0）；
 * - 有值 = 写入。
 *
 * 为什么必须区分「缺失」与「null」：同步协议与桌面端 TaskInput 都用 Option<Option<T>>
 * 表达同样的语义。如果这里把 null 和缺失合并成「不改」，用户永远无法清空截止时间；
 * 如果合并成「清空」，一次只改标题的更新会静默抹掉提醒与重复规则。
 */
export interface TaskPatch {
  /** 空字符串会被拒绝：标题是任务的必填展示字段 */
  title?: string;
  /** null 等价于空字符串 */
  description?: string | null;
  /** null 等价于 0（无优先级） */
  priority?: Priority | null;
  dueAt?: number | null;
  remindAt?: number | null;
  /** null 表示不提前提醒；有值时必须是 >= 0 的整数分钟 */
  advanceMinutes?: number | null;
  recurrenceRule?: string | null;
  category?: string | null;
  /** null 表示清空标签；有值时逐项 trim 并丢弃空串 */
  tags?: string[] | null;
}

export async function listTasks(): Promise<Task[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<TaskDbRow>(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE deleted_at IS NULL`,
  );
  return rows.map(mapTaskRow);
}

export async function getTask(id: string): Promise<Task | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<TaskDbRow>(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return row ? mapTaskRow(row) : null;
}

export function buildTask(input: NewTaskInput, now = Date.now()): Task {
  return {
    id: newId("t"),
    title: input.title.trim(),
    description: input.description?.trim() ?? "",
    status: "pending",
    priority: clampPriority(input.priority ?? 0),
    category: null,
    tags: [],
    dueAt: input.dueAt ?? null,
    remindAt: input.remindAt ?? null,
    advanceMinutes: null,
    recurrenceRule: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    rev: 0,
  };
}

/**
 * 在调用方已开启的事务内插入任务并登记 outbox。
 * 单独暴露是为了让「收集箱转任务」这类跨实体操作保持单事务。
 */
export async function insertTaskInTx(db: SQLiteDatabase, task: Task, now: number): Promise<void> {
  await db.runAsync(
    `INSERT INTO tasks (${TASK_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.category,
      JSON.stringify(task.tags),
      task.dueAt,
      task.remindAt,
      task.advanceMinutes,
      task.recurrenceRule,
      task.createdAt,
      task.updatedAt,
      task.completedAt,
      task.rev,
    ],
  );
  await db.runAsync(
    `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId("op"), "task", task.id, 0, JSON.stringify({ type: "create", title: task.title }), now],
  );
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  const db = getDatabase();
  const now = Date.now();
  const task = buildTask(input, now);
  await db.withTransactionAsync(() => insertTaskInTx(db, task, now));
  return task;
}

/** 切换完成状态；完成时间只在「转为完成」时写入，恢复待办则清空 */
export async function toggleTask(id: string): Promise<Task | null> {
  const db = getDatabase();
  const current = await getTask(id);
  if (!current) return null;

  const now = Date.now();
  const nextStatus: TaskStatus = current.status === "pending" ? "completed" : "pending";
  const completedAt = nextStatus === "completed" ? now : null;

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [nextStatus, completedAt, now, id],
    );
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("op"), "task", id, current.rev, JSON.stringify({ type: "status", status: nextStatus }), now],
    );
  });

  return { ...current, status: nextStatus, completedAt, updatedAt: now };
}

/** 软删除：只置 deleted_at，保留行以便后续生成同步墓碑 */
export async function deleteTask(id: string): Promise<void> {
  const db = getDatabase();
  const current = await getTask(id);
  if (!current) return;

  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(`UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      id,
    ]);
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("op"), "task", id, current.rev, JSON.stringify({ type: "delete" }), now],
    );
  });
}

export async function countPendingOutbox(): Promise<number> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
  return row?.n ?? 0;
}
