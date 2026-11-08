// 本地数据自检：供设置页展示「数据库是否健康、各表有多少行、schema 版本」。
//
// 约定：无论数据库是否已打开、PRAGMA 是否失败，本函数都返回结构化结果而不是抛异常。
// 原因：诊断入口本身就是排障用的，抛异常会让设置页只显示一句「读取失败」，
// 反而丢掉了最有价值的 reason。
import { describeError } from "../lib/errors";

import { getDatabase } from "./database";
import { SCHEMA_VERSION } from "./schema";

export interface DiagnosticCounts {
  tasks: number;
  captures: number;
  outbox: number;
  reminderSchedule: number;
  kv: number;
}

export interface DiagnosticsResult {
  /** 仅当 quick_check 全部返回 ok 且所有计数查询都成功时为 true */
  ok: boolean;
  checkedAt: number;
  userVersion: number;
  schemaVersion: number;
  /** PRAGMA quick_check 的原始结果（通常为 "ok"） */
  quickCheck: string;
  counts: DiagnosticCounts;
  /** 首个异常的可展示文案；正常时为 null */
  error: string | null;
}

const COUNTED_TABLES: ReadonlyArray<readonly [keyof DiagnosticCounts, string]> = [
  ["tasks", "tasks"],
  ["captures", "captures"],
  ["outbox", "outbox"],
  ["reminderSchedule", "reminder_schedule"],
  ["kv", "kv"],
];

export async function quickCheck(): Promise<DiagnosticsResult> {
  const result: DiagnosticsResult = {
    ok: false,
    checkedAt: Date.now(),
    userVersion: -1,
    schemaVersion: SCHEMA_VERSION,
    quickCheck: "未执行",
    counts: { tasks: 0, captures: 0, outbox: 0, reminderSchedule: 0, kv: 0 },
    error: null,
  };

  try {
    const db = getDatabase();

    const version = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
    result.userVersion = version?.user_version ?? -1;

    // quick_check 发现损坏时会返回多行描述文本；只要出现非 "ok" 即判为不健康。
    const checkRows = await db.getAllAsync<Record<string, unknown>>("PRAGMA quick_check");
    const messages = checkRows
      .map((row) => {
        const first = Object.values(row)[0];
        return typeof first === "string" ? first : String(first ?? "");
      })
      .filter((message) => message.length > 0);

    result.quickCheck = messages.length > 0 ? messages.join("; ") : "unknown";
    const integrityOk =
      messages.length > 0 && messages.every((message) => message.toLowerCase() === "ok");

    for (const [key, table] of COUNTED_TABLES) {
      // table 来自模块内常量，不接受外部输入；这里不能用参数化表名。
      const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      result.counts[key] = row?.n ?? 0;
    }

    result.ok = integrityOk;
  } catch (error) {
    result.ok = false;
    result.error = describeError(error);
  }

  return result;
}
