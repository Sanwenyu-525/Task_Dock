// 三态任务更新：从 tasks.ts 拆出，保持单文件可读。
// 对外仍从 src/db/tasks.ts 导出，调用方不需要知道实现文件。
import type { Task } from "../domain/types";
import { AppError } from "../lib/errors";
import { newId } from "../lib/id";
import { buildPatchPayload } from "../lib/sync/protocol";

import { getDatabase } from "./database";
import type { TaskPatch } from "./tasks";
import {
  clampPriority,
  mapTaskRow,
  normalizeTimestamp,
  requireFiniteNumber,
  TASK_COLUMNS,
  type BindValue,
  type TaskDbRow,
} from "./taskRows";

type PatchKey = keyof TaskPatch;

/** camelCase 补丁键 → 数据库列名（同一处维护，避免 SET 子句与 payload 漂移） */
const PATCH_COLUMNS: Record<PatchKey, string> = {
  title: "title",
  description: "description",
  priority: "priority",
  dueAt: "due_at",
  remindAt: "remind_at",
  advanceMinutes: "advance_minutes",
  recurrenceRule: "recurrence_rule",
  category: "category",
  tags: "tags",
};

/**
 * 三态更新任务：业务表修改与 outbox 入队在同一事务内完成。
 *
 * 返回更新后的 Task；任务不存在或已软删除时返回 null（不写 outbox）。
 * 只更新 patch 中出现的键，因此「只改标题」不会触碰 due_at / remind_at / recurrence_rule。
 */
export async function updateTask(id: string, patch: TaskPatch): Promise<Task | null> {
  const db = getDatabase();
  const now = Date.now();

  let updated: Task | null = null;

  await db.withTransactionAsync(async () => {
    // 在事务内读取当前行：base_rev 与业务字段必须来自同一快照。
    const currentRow = await db.getFirstAsync<TaskDbRow & { deleted_at: number | null }>(
      `SELECT ${TASK_COLUMNS}, deleted_at FROM tasks WHERE id = ?`,
      [id],
    );
    if (!currentRow || currentRow.deleted_at != null) return;

    const assignments: string[] = [];
    const values: BindValue[] = [];
    /** 供 outbox 使用的逻辑补丁：保持 camelCase 与三态（null 原样保留） */
    const applied: Partial<Record<PatchKey, unknown>> = {};

    const apply = (key: PatchKey, dbValue: BindValue, logicalValue: unknown): void => {
      assignments.push(`${PATCH_COLUMNS[key]} = ?`);
      values.push(dbValue);
      applied[key] = logicalValue;
    };

    // 逐个字段判断：undefined 视为「键缺失」，null 才是「清空」。
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string") throw new AppError("validation", "任务标题必须是字符串");
      const title = patch.title.trim();
      if (!title) throw new AppError("validation", "任务标题不能为空");
      apply("title", title, title);
    }

    if (patch.description !== undefined) {
      if (patch.description !== null && typeof patch.description !== "string") {
        throw new AppError("validation", "description 必须是字符串或 null");
      }
      const description = patch.description === null ? "" : patch.description.trim();
      apply("description", description, description);
    }

    if (patch.priority !== undefined) {
      if (
        patch.priority !== null &&
        (typeof patch.priority !== "number" || !Number.isFinite(patch.priority))
      ) {
        throw new AppError("validation", "priority 必须是有限数字或 null");
      }
      const priority = patch.priority === null ? 0 : clampPriority(patch.priority);
      apply("priority", priority, priority);
    }

    if (patch.dueAt !== undefined) {
      const dueAt = normalizeTimestamp(patch.dueAt, "dueAt");
      apply("dueAt", dueAt, dueAt);
    }

    if (patch.remindAt !== undefined) {
      const remindAt = normalizeTimestamp(patch.remindAt, "remindAt");
      apply("remindAt", remindAt, remindAt);
    }

    if (patch.advanceMinutes !== undefined) {
      let advanceMinutes: number | null = null;
      if (patch.advanceMinutes !== null) {
        const value = requireFiniteNumber(patch.advanceMinutes, "advanceMinutes");
        if (value < 0) throw new AppError("validation", "advanceMinutes 不能为负数");
        advanceMinutes = value;
      }
      apply("advanceMinutes", advanceMinutes, advanceMinutes);
    }

    if (patch.recurrenceRule !== undefined) {
      if (patch.recurrenceRule !== null && typeof patch.recurrenceRule !== "string") {
        throw new AppError("validation", "recurrenceRule 必须是字符串或 null");
      }
      const rule =
        patch.recurrenceRule === null || patch.recurrenceRule.trim() === ""
          ? null
          : patch.recurrenceRule;
      apply("recurrenceRule", rule, rule);
    }

    if (patch.category !== undefined) {
      if (patch.category !== null && typeof patch.category !== "string") {
        throw new AppError("validation", "category 必须是字符串或 null");
      }
      const category =
        patch.category === null || patch.category.trim() === "" ? null : patch.category.trim();
      apply("category", category, category);
    }

    if (patch.tags !== undefined) {
      if (patch.tags === null) {
        apply("tags", null, null);
      } else {
        if (!Array.isArray(patch.tags) || patch.tags.some((tag) => typeof tag !== "string")) {
          throw new AppError("validation", "tags 必须是字符串数组或 null");
        }
        const tags = patch.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
        apply("tags", JSON.stringify(tags), tags);
      }
    }

    // 空补丁不制造一次无意义的 updated_at 变更，也不污染 outbox。
    if (assignments.length === 0) {
      updated = mapTaskRow(currentRow);
      return;
    }

    assignments.push("updated_at = ?");
    values.push(now);
    // rev 自增：版本号是同步的冲突判定依据，任何写操作都必须推进，否则远端永远看到旧版本
    assignments.push("rev = rev + 1");

    await db.runAsync(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`, [...values, id]);

    const row = await db.getFirstAsync<TaskDbRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    if (!row) throw new AppError("storage", "更新后无法读回任务记录");

    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        newId("op"),
        "task",
        id,
        currentRow.server_rev,
        // buildPatchPayload 会丢弃 undefined、保留 null，确保「清空」不会在 JSON 里丢失
        JSON.stringify({ type: "update", patch: buildPatchPayload(applied) }),
        now,
      ],
    );

    updated = mapTaskRow(row);
  });

  return updated;
}
