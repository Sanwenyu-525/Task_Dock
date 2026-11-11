// expo-sqlite 的 node 测试替身：基于 node:sqlite（真实 SQLite，内存库）实现
// 业务代码用到的 API 形状。业务逻辑（db/ 下所有 SQL 与事务）原样运行，
// 这里只替换「原生驱动」这一层——这是迁移与数据层测试的 harness，不是重写。
//
// 覆盖的 API（按 src/db 实际使用面）：
// - openDatabaseAsync(name) → SQLiteDatabase 形状的句柄
// - execAsync / runAsync / getFirstAsync / getAllAsync / withTransactionAsync / closeAsync
//
// 类型说明：业务代码 `import type { SQLiteDatabase } from "expo-sqlite"` 是纯类型导入，
// 运行时被擦除；类型检查由真实 expo-sqlite 包的 .d.ts 承担，此处无需（也不应）re-export。
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface RunResult {
  changes: number;
  lastInsertRowId?: number;
}

class HarnessDatabase {
  private native: DatabaseSync;
  private txDepth = 0;
  private closed = false;

  constructor() {
    this.native = new DatabaseSync(":memory:");
    this.native.exec("PRAGMA foreign_keys = ON");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("database is not open");
  }

  async execAsync(sql: string): Promise<void> {
    this.assertOpen();
    this.native.exec(sql);
  }

  async runAsync(sql: string, params: unknown[] = []): Promise<RunResult> {
    this.assertOpen();
    const stmt = this.native.prepare(sql);
    const info = stmt.run(...normalize(params));
    return { changes: Number(info.changes), lastInsertRowId: Number(info.lastInsertRowid) };
  }

  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.assertOpen();
    const stmt = this.native.prepare(sql);
    const row = stmt.get(...normalize(params));
    return (row as T | undefined) ?? null;
  }

  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.assertOpen();
    const stmt = this.native.prepare(sql);
    return stmt.all(...normalize(params)) as T[];
  }

  async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
    this.assertOpen();
    // expo-sqlite 的嵌套事务语义：已处于事务内则不再开新事务。
    if (this.txDepth > 0) {
      await fn();
      return;
    }
    this.txDepth += 1;
    try {
      this.native.exec("BEGIN");
      await fn();
      this.native.exec("COMMIT");
    } catch (error) {
      try {
        this.native.exec("ROLLBACK");
      } catch {
        // 事务可能已因错误自动回滚。
      }
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  async closeAsync(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.native.close();
  }

  /** 测试基建内部用：判断是否需要全新连接。 */
  isClosedForTest(): boolean {
    return this.closed;
  }
}

function normalize(params: unknown[]): SQLInputValue[] {
  // node:sqlite 不接受 undefined 绑定值；expo-sqlite 对 undefined 同样视为 NULL。
  return params.map((value) => (value === undefined ? null : value)) as SQLInputValue[];
}

let instance: HarnessDatabase | null = null;

export async function openDatabaseAsync(_name: string): Promise<HarnessDatabase> {
  // 与 expo-sqlite 一致：closeAsync 之后再次 open 是全新连接（内存库数据不保留）。
  if (!instance || instance.isClosedForTest()) instance = new HarnessDatabase();
  return instance;
}
