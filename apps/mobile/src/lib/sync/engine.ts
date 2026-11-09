// 同步编排：pull → push → 再 pull（取回本轮写入后的服务端版本）。
//
// 约束：
// - 单飞：并发触发共用同一个 Promise，避免重复请求与游标竞争；
// - 不自动重试冲突：冲突落库后交给冲突页；
// - 每次同步结束都写最近结果，UI 直接读 kv，不必自己拼状态。
import {
  applyPullChanges,
  buildPendingTaskOps,
  loadSyncCursor,
  saveSyncCursor,
  saveSyncResult,
  settlePush,
  type SyncLastResult,
} from "../../db/sync";
import { loadConnection, readToken, touchConnection } from "../../db/syncConnection";
import { AppError } from "../errors";

import { createSyncClient, type SyncClient } from "./client";
import { deriveSyncKey } from "./crypto";

const PAGE_SIZE = 500;
/** 单次同步最多翻 10 页，防止异常服务端让客户端死循环。 */
const MAX_PAGES = 10;

let inFlight: Promise<SyncLastResult> | null = null;

export function isSyncing(): boolean {
  return inFlight !== null;
}

/** 触发一次同步；已有在途同步时复用同一结果。 */
export function syncNow(): Promise<SyncLastResult> {
  if (inFlight) return inFlight;
  const task = execute().finally(() => {
    inFlight = null;
  });
  inFlight = task;
  return task;
}

async function pullAll(client: SyncClient): Promise<{ pulled: number; applied: number }> {
  let cursor = await loadSyncCursor();
  let pulled = 0;
  let applied = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.pull(cursor, PAGE_SIZE);
    pulled += result.changes.length;
    const outcome = await applyPullChanges(result.changes);
    applied += outcome.applied + outcome.deleted;
    cursor = result.cursor || cursor;
    await saveSyncCursor(cursor);
    if (result.changes.length < PAGE_SIZE) break;
  }

  return { pulled, applied };
}

async function execute(): Promise<SyncLastResult> {
  const connection = await loadConnection();
  if (!connection) {
    throw new AppError("validation", "尚未配对，请先扫描桌面端二维码");
  }
  const token = await readToken();
  if (!token) {
    throw new AppError("validation", "本机配对令牌不可用，请重新配对");
  }

  const key = await deriveSyncKey(token);
  const client = createSyncClient({
    baseUrl: connection.baseUrl,
    token,
    deviceId: connection.deviceId,
    syncKey: key,
  });

  try {
    const pull = await pullAll(client);
    const pending = await buildPendingTaskOps();
    let pushed = 0;
    let conflicts = 0;

    if (pending.length > 0) {
      const result = await client.push(pending.map((item) => item.op));
      pushed = result.ack.length;
      conflicts = result.conflicts.length;
      await settlePush(result, pending);
      // 服务端对每个 ack 的操作都会写变更日志；再拉一次把新 rev 落到本地，
      // 否则下一次本地编辑仍用旧 base_rev，会立刻自己和自己冲突。
      await pullAll(client);
    }

    const outcome: SyncLastResult = {
      at: Date.now(),
      pulled: pull.pulled,
      applied: pull.applied,
      pushed,
      conflicts,
    };
    // 服务端在鉴权时已刷新 last_seen；本机元数据也同步更新，避免同步页还显示旧时间。
    await touchConnection(new Date().toISOString());
    await saveSyncResult(outcome);
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveSyncResult({
      at: Date.now(),
      pulled: 0,
      applied: 0,
      pushed: 0,
      conflicts: 0,
      error: message,
    }).catch(() => undefined);
    throw error;
  } finally {
    client.cancel();
  }
}
