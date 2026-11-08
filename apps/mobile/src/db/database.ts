// 数据库句柄管理：全局唯一实例，迁移只跑一次。
// 约束：打开失败必须抛出，不能静默降级成内存库（否则用户数据会「看起来丢了」）。
import * as SQLite from "expo-sqlite";

import { DATABASE_NAME, MIGRATIONS, SCHEMA_VERSION } from "./schema";

let handle: SQLite.SQLiteDatabase | null = null;

/**
 * 按 user_version 顺序执行未完成的迁移。
 *
 * 为什么整体放进一个事务：SQLite 的 DDL 也支持事务回滚，任一条迁移失败时
 * 用户数据停在升级前的完整状态，下次启动可以重试，而不是留下「新表建了、旧表没补列」的半成品。
 * 为什么不捕获异常：迁移失败属于数据安全隐患，必须让启动界面明确报错，不能带着旧 schema 继续跑。
 */
async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  const current = row?.user_version ?? 0;

  if (current > SCHEMA_VERSION) {
    // 用户装回了旧版本 App。继续写新区 schema 会破坏数据，直接拒绝打开。
    throw new Error(
      `数据库版本 ${current} 高于当前应用支持的版本 ${SCHEMA_VERSION}，请升级应用后再打开`,
    );
  }
  if (current === SCHEMA_VERSION) return;

  await db.withTransactionAsync(async () => {
    let expected = current + 1;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      if (migration.version !== expected) {
        throw new Error(`迁移序列不连续：期望 v${expected}，实际 v${migration.version}`);
      }
      await db.execAsync(migration.sql);
      expected += 1;
    }
    // 版本号与 DDL 同一事务提交：要么都生效，要么都回滚。
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (handle) return handle;

  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);

  try {
    // journal_mode / foreign_keys 不能在事务内切换，必须先于迁移执行。
    await db.execAsync("PRAGMA journal_mode = WAL;");
    await db.execAsync("PRAGMA foreign_keys = ON;");
    await migrate(db);
  } catch (error) {
    // 打开/迁移失败时释放句柄，避免下次重试拿到一个处于中间状态的连接。
    await db.closeAsync().catch(() => undefined);
    throw error;
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
