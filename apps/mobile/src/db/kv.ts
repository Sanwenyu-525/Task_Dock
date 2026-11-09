// 轻量键值设置表：主题偏好、通知开关等少量状态，不进业务表。
import { getDatabase } from "./database";

export async function getSetting(key: string): Promise<string | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** 删除设置键（解除配对时清理连接元数据；不存在的键视为成功）。 */
export async function deleteSetting(key: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync("DELETE FROM kv WHERE key = ?", [key]);
}
