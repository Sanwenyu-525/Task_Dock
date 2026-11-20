// 采集附件 → 桌面端：复用既有「文件互传」通道（/v1/files），不新建协议。
//
// 为什么独立于同步：同步协议只传 task/note/capture 字段，附件是二进制；
// 两者生命周期不同（文本可能已同步而附件仍在途，反之亦然），状态必须分开表达。
//
// 安全边界：
// - 传输走 secureFetch（SPKI 指纹固定），缺少指纹直接 fail-closed，绝不以首用信任发令牌；
// - 只在用户显式「发送到电脑」或开启「自动传送附件」后执行，不在后台偷偷上传；
// - 每个附件单独状态：pending → uploading → sent / failed；失败保留本地文件可重试。
import { File } from "expo-file-system";

import {
  getAttachmentsByIds,
  listAttachmentsForTransfer,
  setAttachmentTransferState,
} from "../../db/attachments";
import { loadConnection, readToken } from "../../db/syncConnection";
import type { Attachment } from "../../domain/types";
import { AppError, describeError } from "../errors";
import { safeLog } from "../safeLog";

import { deriveSyncKey } from "./crypto";
import { createFileClient } from "./files";
import { uploadLocalFile } from "./fileIo";
import { normalizeTlsFingerprint } from "./pairing";
import { loadSyncStatus } from "./autoSync";

/** 单次最多处理的附件数：避免一次同步/保存把几十个文件排在网络里 */
export const TRANSFER_BATCH_LIMIT = 5;

export interface AttachmentTransferOutcome {
  sent: number;
  failed: number;
  /** 未具备传输条件（未配对 / 缺指纹 / 无令牌）时为 true */
  unavailable: boolean;
  message?: string;
  errors: string[];
  /** 实际处理过的附件 id（调用方可按 id 展示逐项结果） */
  handledIds: string[];
  /** 本批中已成功送达的附件 id */
  sentIds: string[];
}

export function emptyTransferOutcome(): AttachmentTransferOutcome {
  return { sent: 0, failed: 0, unavailable: false, errors: [], handledIds: [], sentIds: [] };
}

interface TransferTarget {
  items: Attachment[];
}

/** 读连接元数据并做 fail-closed 判定；不具备条件时直接返回原因。 */
async function resolveTransport(outcome: AttachmentTransferOutcome): Promise<{
  ready: false;
  outcome: AttachmentTransferOutcome;
} | {
  ready: true;
  baseUrl: string;
  token: string;
  pin: string;
}> {
  const [connection, token] = await Promise.all([loadConnection(), readToken()]);
  if (!connection) {
    return { ready: false, outcome: { ...outcome, unavailable: true, message: "尚未配对桌面端" } };
  }
  if (!token) {
    return {
      ready: false,
      outcome: { ...outcome, unavailable: true, message: "本机配对令牌不可用，请重新配对" },
    };
  }
  const pin = normalizeTlsFingerprint(connection.tlsFingerprint);
  if (!pin) {
    // v1 遗留连接 / 元数据损坏：与同步一致 fail-closed，不发送任何字节
    return {
      ready: false,
      outcome: { ...outcome, unavailable: true, message: "缺少桌面端 TLS 指纹，请重新扫码配对" },
    };
  }
  return { ready: true, baseUrl: connection.baseUrl, token, pin };
}

/** 串行传输给定附件；单条失败不影响后续。 */
async function transferAttachments(target: TransferTarget): Promise<AttachmentTransferOutcome> {
  let outcome = emptyTransferOutcome();
  if (target.items.length === 0) return outcome;

  const transport = await resolveTransport(outcome);
  if (!transport.ready) return transport.outcome;

  const client = createFileClient({
    baseUrl: transport.baseUrl,
    token: transport.token,
    syncKey: await deriveSyncKey(transport.token),
  });

  try {
    for (const item of target.items) {
      if (item.transferState === "sent") continue;
      await setAttachmentTransferState(item.id, "uploading");
      try {
        const file = new File(item.localUri);
        if (!file.exists) {
          throw new AppError("storage", "本机文件已缺失，请重新采集");
        }
        const remote = await uploadLocalFile(client, file, () => undefined);
        await setAttachmentTransferState(item.id, "sent", { remoteFileId: remote.id });
        outcome.sent += 1;
        outcome.sentIds.push(item.id);
        // 传输结果采集：只记类型/大小/结果，绝不记文件名正文或路径。
        safeLog.info("transfer", "附件已发送", { kind: item.kind, bytes: item.size });
      } catch (error) {
        const message = describeError(error);
        await setAttachmentTransferState(item.id, "failed", { error: message });
        outcome.failed += 1;
        outcome.errors.push(`${item.name || item.kind}：${message}`);
        safeLog.warn("transfer", "附件发送失败", {
          kind: item.kind,
          bytes: item.size,
          code: error instanceof AppError ? error.code ?? "" : "",
        });
      } finally {
        outcome.handledIds.push(item.id);
      }
    }
  } finally {
    client.cancel();
    await loadSyncStatus().catch(() => undefined);
  }

  return outcome;
}

/**
 * 发送「本次采集」的附件：按显式 id 精确选择，绝不读取全局时间队列。
 *
 * 这是「保存并发送到电脑」的唯一入口：用户刚拍的两张照片必须优先于历史积压的
 * 10 个待传附件；历史积压留给后台批量与同步页。
 */
export async function transferAttachmentsByIds(
  ids: readonly string[],
  options: { limit?: number } = {},
): Promise<AttachmentTransferOutcome> {
  const limit = Math.max(1, Math.min(options.limit ?? ids.length, 20));
  const items = await getAttachmentsByIds(ids.slice(0, limit));
  return transferAttachments({ items });
}

/**
 * 发送待传送附件（pending + failed，按时间取最早一批）。同步页/自动传送用。
 * 未配对/缺指纹/令牌不可用时不做任何请求，返回 unavailable 让 UI 解释原因。
 */
export async function transferPendingAttachments(
  options: { limit?: number } = {},
): Promise<AttachmentTransferOutcome> {
  const limit = Math.max(1, Math.min(options.limit ?? TRANSFER_BATCH_LIMIT, 20));
  const outcome = emptyTransferOutcome();
  // 先做传输条件预检，避免把「未配对」误显示成 0 个失败
  const transport = await resolveTransport(outcome);
  if (!transport.ready) return transport.outcome;
  const items = await listAttachmentsForTransfer(limit);
  return transferAttachments({ items });
}
