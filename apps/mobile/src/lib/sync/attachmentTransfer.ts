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

import { listAttachmentsForTransfer, setAttachmentTransferState } from "../../db/attachments";
import { loadConnection, readToken } from "../../db/syncConnection";
import { AppError, describeError } from "../errors";

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
}

export function emptyTransferOutcome(): AttachmentTransferOutcome {
  return { sent: 0, failed: 0, unavailable: false, errors: [] };
}

/**
 * 发送待传送附件（pending + failed）。逐条串行，单条失败不影响后续。
 * 未配对/缺指纹/令牌不可用时不做任何请求，返回 unavailable 让 UI 解释原因。
 */
export async function transferPendingAttachments(
  options: { limit?: number } = {},
): Promise<AttachmentTransferOutcome> {
  const limit = Math.max(1, Math.min(options.limit ?? TRANSFER_BATCH_LIMIT, 20));
  const outcome = emptyTransferOutcome();

  const [connection, token] = await Promise.all([loadConnection(), readToken()]);
  if (!connection) {
    return { ...outcome, unavailable: true, message: "尚未配对桌面端" };
  }
  if (!token) {
    return { ...outcome, unavailable: true, message: "本机配对令牌不可用，请重新配对" };
  }
  const pin = normalizeTlsFingerprint(connection.tlsFingerprint);
  if (!pin) {
    // v1 遗留连接 / 元数据损坏：与同步一致 fail-closed，不发送任何字节
    return { ...outcome, unavailable: true, message: "缺少桌面端 TLS 指纹，请重新扫码配对" };
  }

  const items = await listAttachmentsForTransfer(limit);
  if (items.length === 0) return outcome;

  const client = createFileClient({
    baseUrl: connection.baseUrl,
    token,
    syncKey: await deriveSyncKey(token),
  });

  try {
    for (const item of items) {
      await setAttachmentTransferState(item.id, "uploading");
      try {
        const file = new File(item.localUri);
        if (!file.exists) {
          throw new AppError("storage", "本地附件已不存在，无法发送");
        }
        const remote = await uploadLocalFile(client, file, () => undefined);
        await setAttachmentTransferState(item.id, "sent", { remoteFileId: remote.id });
        outcome.sent += 1;
      } catch (error) {
        const message = describeError(error);
        await setAttachmentTransferState(item.id, "failed", { error: message });
        outcome.failed += 1;
        outcome.errors.push(`${item.name || item.kind}：${message}`);
      }
    }
  } finally {
    client.cancel();
    await loadSyncStatus().catch(() => undefined);
  }

  return outcome;
}
