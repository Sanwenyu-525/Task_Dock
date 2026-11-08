// 任务仓储：所有 SQL 只出现在这一层，UI 不直接碰数据库。
// 每次写业务表与写 outbox 在同一事务内完成，保证「要么都成功，要么都不发生」。
import type { SQLiteDatabase } from "expo-sqlite";

import type { NewTaskInput, Priority, Task, TaskStatus } from "../domain/types";
import { newId } from "../lib/id";

import { getDatabase } from "./database";

interface TaskDbRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  category: string | null;
  tags: string | null;
  due_at: number | null;
  remind_at: number | null;
  advance_minutes: number | null;
  recurrence_rule: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  rev: number;
}

const COLUMNS = `id, title, description, status, priority, category, tags,
  due_at, remind_at, advance_minutes, recurrence_rule,
  created_at, updated_at, completed_at, rev`;

function clampPriority(value: number): Priority {
  if (value >= 3) return 3;
  if (value <= 0) return 0;
  return value as Priority;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // 历史脏数据不应让整个列表崩溃
    return [];
  }
}

function mapRow(row: TaskDbRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status === "completed" ? "completed" : "pending",
    priority: clampPriority(row.priority),
    category: row.category,
    tags: parseTags(row.tags),
    dueAt: row.due_at,
    remindAt: row.remind_at,
    advanceMinutes: row.advance_minutes,
    recurrenceRule: row.recurrence_rule,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    rev: row.rev,
  };
}

export async function listTasks(): Promise<Task[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<TaskDbRow>(
    `SELECT ${COLUMNS} FROM tasks WHERE deleted_at IS NULL`,
  );
  return rows.map(mapRow);
}

export async function getTask(id: string): Promise<Task | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<TaskDbRow>(
    `SELECT ${COLUMNS} FROM tasks WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return row ? mapRow(row) : null;
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
    `INSERT INTO tasks (${COLUMNS})
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
