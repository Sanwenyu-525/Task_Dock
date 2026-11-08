// 同步协议 v1：类型与纯函数（docs/MOBILE_STACK.md §3）。
//
// 这里的字段名保持协议线上格式（snake_case），不跟随应用内 camelCase：
// 协议是跨端契约，不能在客户端为了「好看」改名；否则桌面端收到的 patch 会整体失效。
// 本文件不发起任何网络请求，也不依赖 React Native / SQLite，可在任意环境单测。
import { AppError } from "../errors";

export type SyncEntity = "task" | "capture" | "note";

/** pull 返回的单条变更；deleted 为 true 时表示墓碑，fields 可能只有标识字段 */
export interface Change {
  entity: SyncEntity;
  id: string;
  /** 服务端单调递增版本号，push 时作为 base_rev 的回执基准 */
  rev: number;
  deleted: boolean;
  fields: Record<string, unknown>;
  updated_at: number;
}

export interface PullResult {
  /** 不透明游标；客户端原样保存，下一次 pull 原样回传 */
  cursor: string;
  changes: Change[];
}

/**
 * 三态补丁值：null 表示「清空」，缺失表示「不改」，其余表示「写入」。
 * 不允许 undefined 进入协议层——JSON.stringify 会直接丢掉它，等价于静默降级成「不改」。
 */
export type PatchValue = string | number | boolean | null | string[];
export type SyncPatch = Record<string, PatchValue>;

export interface Op {
  /** 客户端生成的幂等键；服务端重复收到同一 op_id 只 ack 不重复落库 */
  op_id: string;
  entity: SyncEntity;
  id: string;
  base_rev: number;
  patch: SyncPatch;
}

export type ConflictReason =
  | "revision_mismatch"
  | "deleted_on_server"
  | "record_missing"
  | "invalid_patch"
  | "permission_denied"
  | "unknown";

export interface Conflict {
  op_id: string;
  reason: ConflictReason;
  server_record: Change | null;
}

export interface PushResult {
  ack: string[];
  conflicts: Conflict[];
}

const CONFLICT_REASONS: readonly ConflictReason[] = [
  "revision_mismatch",
  "deleted_on_server",
  "record_missing",
  "invalid_patch",
  "permission_denied",
  "unknown",
];

const SYNC_ENTITIES: readonly SyncEntity[] = ["task", "capture", "note"];

function isSyncEntity(value: unknown): value is SyncEntity {
  return typeof value === "string" && (SYNC_ENTITIES as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * 把应用层补丁对象转成协议补丁。
 *
 * 三态处理是硬要求：键缺失 → 不写入结果；值为 null → 保留 null；有值 → 原样写入。
 * 显式 undefined 按「缺失」处理（与 updateTask 的语义一致），因为 JSON 无法表达 undefined。
 * 数值必须是有限数：NaN/Infinity 经 JSON.stringify 会变成 null，读者会误以为「清空」。
 */
export function buildPatchPayload(patch: object): SyncPatch {
  const payload: SyncPatch = {};

  for (const [key, value] of Object.entries(patch) as Array<[string, unknown]>) {
    if (value === undefined) continue;

    if (value === null || typeof value === "string" || typeof value === "boolean") {
      payload[key] = value;
      continue;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new AppError("validation", `补丁字段 ${key} 不是有限数值`);
      }
      payload[key] = value;
      continue;
    }

    if (isStringArray(value)) {
      // 复制一份，避免调用方后续修改数组影响已构造的 payload
      payload[key] = [...value];
      continue;
    }

    throw new AppError("validation", `补丁字段 ${key} 的类型不受同步协议支持`);
  }

  return payload;
}

/**
 * 根据本地 op 与服务端当前记录判定冲突类型。
 * 服务端已给出明确 reason 时以服务端为准；服务端只返回通用冲突时，这个函数负责归类。
 */
export function classifyConflict(op: Op, serverRecord: Change | null): ConflictReason {
  if (serverRecord === null) return "record_missing";
  if (serverRecord.deleted) return "deleted_on_server";
  if (serverRecord.rev !== op.base_rev) return "revision_mismatch";
  return "unknown";
}

function isConflictReason(value: unknown): value is ConflictReason {
  return typeof value === "string" && (CONFLICT_REASONS as readonly string[]).includes(value);
}

/** 协议字段校验：服务端返回结构不符合 v1 时按 validation 错误处理，不猜测缺省值 */
function parseChange(value: unknown): Change {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation", "同步变更记录不是对象");
  }
  const record = value as Record<string, unknown>;

  if (
    !isSyncEntity(record.entity) ||
    typeof record.id !== "string" ||
    !isFiniteNumber(record.rev) ||
    typeof record.deleted !== "boolean" ||
    typeof record.fields !== "object" ||
    record.fields === null ||
    Array.isArray(record.fields) ||
    !isFiniteNumber(record.updated_at)
  ) {
    throw new AppError("validation", "同步变更记录字段不完整或类型错误");
  }

  return {
    entity: record.entity,
    id: record.id,
    rev: record.rev,
    deleted: record.deleted,
    fields: record.fields as Record<string, unknown>,
    updated_at: record.updated_at,
  };
}

export function parsePullResult(value: unknown): PullResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation", "pull 响应不是对象");
  }
  const record = value as Record<string, unknown>;

  if (typeof record.cursor !== "string" || !Array.isArray(record.changes)) {
    throw new AppError("validation", "pull 响应缺少 cursor 或 changes");
  }

  return {
    cursor: record.cursor,
    changes: record.changes.map(parseChange),
  };
}

function parseConflict(value: unknown, opsById: Map<string, Op>): Conflict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation", "冲突记录不是对象");
  }
  const record = value as Record<string, unknown>;

  if (typeof record.op_id !== "string") {
    throw new AppError("validation", "冲突记录缺少 op_id");
  }

  const serverRecord =
    record.server_record === undefined || record.server_record === null
      ? null
      : parseChange(record.server_record);

  const op = opsById.get(record.op_id);
  const reason =
    (isConflictReason(record.reason) ? record.reason : null) ??
    (op ? classifyConflict(op, serverRecord) : "unknown");

  return { op_id: record.op_id, reason, server_record: serverRecord };
}

export function parsePushResult(value: unknown, ops: readonly Op[]): PushResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation", "push 响应不是对象");
  }
  const record = value as Record<string, unknown>;

  if (!Array.isArray(record.ack) || !Array.isArray(record.conflicts)) {
    throw new AppError("validation", "push 响应缺少 ack 或 conflicts");
  }
  if (record.ack.some((item) => typeof item !== "string")) {
    throw new AppError("validation", "push 响应的 ack 必须是字符串数组");
  }

  const opsById = new Map(ops.map((op) => [op.op_id, op]));
  return {
    ack: record.ack as string[],
    conflicts: record.conflicts.map((conflict) => parseConflict(conflict, opsById)),
  };
}
