// 同步编排：pull → push → 再 pull（取回本轮写入后的服务端版本）。
//
// 约束：
// - 单飞：并发触发共用同一个 Promise，避免重复请求与游标竞争；
// - 不自动重试冲突：冲突落库后交给冲突页；
// - 每次同步结束都写最近结果，UI 直接读 kv，不必自己拼状态；
// - 传输走本地安全通道（secureFetch + SPKI 指纹固定）；pull 落地后触发一次
//   系统提醒对账（桌面端改过的提醒时间要在手机通知里生效），对账失败不阻断同步。
import {
  applyPullChanges,
  buildPendingOps,
  loadSyncCursor,
  saveSyncCursor,
  saveSyncResult,
  settlePush,
  type PendingOp,
  type SyncLastResult,
} from "../../db/sync";
import { loadConnection, readToken, touchConnection } from "../../db/syncConnection";
import { rescheduleAllReminders } from "../../notifications/reminderEngine";
import { AppError } from "../errors";

import { createSyncClient, type FetchLike, type SyncClient } from "./client";
import { deriveSyncKey } from "./crypto";
import { normalizeTlsFingerprint } from "./pairing";
import { createSecureFetch } from "./secureFetch";

const PAGE_SIZE = 500;
/** 单次同步最多翻 10 页，防止异常服务端让客户端死循环。 */
const MAX_PAGES = 10;
/** 单批 push 上限：条数与 UTF-8 体积都要控制，长笔记会显著放大请求体。 */
const MAX_BATCH_OPS = 50;
/** 服务端请求体上限 1MB，客户端留出信封与 JSON 结构的余量。 */
const MAX_BATCH_BYTES = 700 * 1024;

let inFlight: Promise<SyncLastResult> | null = null;

/** `.length` 是 UTF-16 码元数，中文按 3 字节估算；代理对按 6 字节高估（安全方向）。 */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return bytes;
}

/** 按条数与体积切批；单条超过上限时独占一批，交给服务端 256KB 上限兜底。 */
function chunkPending(pending: readonly PendingOp[]): PendingOp[][] {
  const batches: PendingOp[][] = [];
  let current: PendingOp[] = [];
  let bytes = 0;

  for (const item of pending) {
    const size = utf8Bytes(JSON.stringify(item.op));
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_OPS || bytes + size > MAX_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function isSyncing(): boolean {
  return inFlight !== null;
}

/**
 * 触发一次同步；已有在途同步时复用同一结果。
 *
 * `fetchImpl` 仅供测试注入（默认走 secureFetch + 连接里钉住的 TLS 指纹）；
 * 生产代码不应传该参数。
 */
export function syncNow(options: { fetchImpl?: FetchLike } = {}): Promise<SyncLastResult> {
  if (inFlight) return inFlight;
  const task = execute(options).finally(() => {
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

async function execute(options: { fetchImpl?: FetchLike }): Promise<SyncLastResult> {
  const connection = await loadConnection();
  if (!connection) {
    throw new AppError("validation", "尚未配对，请先扫描桌面端二维码");
  }
  const token = await readToken();
  if (!token) {
    throw new AppError("validation", "本机配对令牌不可用，请重新配对");
  }

  const key = await deriveSyncKey(token);
  // v2 起桌面端身份由 SPKI 指纹固定：已配对连接必须带指纹。指纹缺失
  // （手动配对未观察到 / 元数据损坏 / v1 旧记录）时拒绝同步，绝不以首用信任
  // 静默降级——否则一次未固定的连接就能让中间人取得令牌并派生同步密钥。
  // fetchImpl 为测试注入（生产代码不传），此时由注入实现负责传输安全。
  const pin = normalizeTlsFingerprint(connection.tlsFingerprint);
  if (!pin && !options.fetchImpl) {
    throw new AppError("validation", "缺少桌面端 TLS 指纹，请重新扫码配对后再同步");
  }
  const client = createSyncClient({
    baseUrl: connection.baseUrl,
    token,
    deviceId: connection.deviceId,
    syncKey: key,
    fetchImpl: options.fetchImpl ?? createSecureFetch({ pin }),
  });

  try {
    const pull = await pullAll(client);
    const pending = await buildPendingOps();
    let pushed = 0;
    let conflicts = 0;

    if (pending.length > 0) {
      for (const batch of chunkPending(pending)) {
        const result = await client.push(batch.map((item) => item.op));
        pushed += result.ack.length;
        conflicts += result.conflicts.length;
        await settlePush(result, batch);
      }
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
    // pull 落地了新变更：桌面端可能改了/删了提醒时间，触发一次系统通知对账。
    // 对账失败（权限被撤等）不应让整轮同步报错，只留下次启动/前台恢复再对账。
    if (pull.applied > 0) {
      await rescheduleAllReminders().catch(() => undefined);
    }
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
