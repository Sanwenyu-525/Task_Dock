// 任务行的列定义与映射：tasks.ts（列表/新建/状态/删除）与 taskUpdate.ts（三态更新）共用，
// 避免两处各写一份 SELECT 列名或 camelCase 映射后漂移。
import type { Priority, Task } from "../domain/types";
import { AppError } from "../lib/errors";

export interface TaskDbRow {
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

export const TASK_COLUMNS = `id, title, description, status, priority, category, tags,
  due_at, remind_at, advance_minutes, recurrence_rule,
  created_at, updated_at, completed_at, rev`;

export type BindValue = string | number | null;

export function clampPriority(value: number): Priority {
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

export function mapTaskRow(row: TaskDbRow): Task {
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

/** epoch ms 必须是有限数：NaN/Infinity 绑定进 SQLite 会得到不可预期结果 */
export function requireFiniteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new AppError("validation", `${field} 必须是有限数值`);
  }
  return Math.trunc(value);
}

export function normalizeTimestamp(value: number | null, field: string): number | null {
  return value === null ? null : requireFiniteNumber(value, field);
}
