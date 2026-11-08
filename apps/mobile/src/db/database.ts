// 数据库句柄管理：全局唯一实例，迁移只跑一次。
// 约束：打开失败必须抛出，不能静默降级成内存库（否则用户数据会「看起来丢了」）。
import * as SQLite from "expo-sqlite";

import { DATABASE_NAME, MIGRATION_1, SCHEMA_VERSION } from "./schema";

let handle: SQLite.SQLiteDatabase | null = null;

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (handle) return handle;

  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);

  // journal_mode / foreign_keys 不能在事务内切换，必须先于迁移执行。
  await db.execAsync("PRAGMA journal_mode = WAL;");
  await db.execAsync("PRAGMA foreign_keys = ON;");

  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  const current = row?.user_version ?? 0;

  if (current < SCHEMA_VERSION) {
    // 迁移必须整体成功或整体回滚，避免半张表的状态。
    await db.withTransactionAsync(async () => {
      if (current < 1) await db.execAsync(MIGRATION_1);
      await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  handle = db;
  return db;
}

export function getDatabase(): SQLite.SQLiteDatabase {
  if (!handle) throw new Error("数据库尚未打开：请先调用 openDatabase()");
  return handle;
}

export async function closeDatabase(): Promise<void> {
  if (!handle) return;
  await handle.closeAsync();
  handle = null;
}
