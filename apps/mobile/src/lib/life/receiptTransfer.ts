// 生活票据原图 → 桌面端：只复用既有「文件互传」通道（/v1/files）与暂存架导入，
// 不新建连接、不复制图片字节进同步协议。
//
// 元数据同步与文件传输分开：同步成功不代表电脑已有原图；只有这里真正上传并
// 导入桌面暂存架成功后，才写入 remote_ref 并标记 transferred（本机来源保留）。
import { File } from "expo-file-system";

import { getDocumentLink, markDocumentUploaded, setDocumentLinkTransferState } from "../../db/life";
import { loadConnection, readToken } from "../../db/syncConnection";
import { AppError, describeError } from "../errors";

import { deriveSyncKey } from "../sync/crypto";
import { createFileClient } from "../sync/files";
import { uploadLocalFile } from "../sync/fileIo";
import { normalizeTlsFingerprint } from "../sync/pairing";
import { isFileHttpError } from "../sync/transferError";

export interface ReceiptTransferOutcome {
  linkId: string;
  shelfItemId: string;
  name: string;
}

async function resolveTransport(): Promise<{ baseUrl: string; token: string; pin: string }> {
  const [connection, token] = await Promise.all([loadConnection(), readToken()]);
  if (!connection) throw new AppError("network", "尚未配对桌面端，无法发送票据原图");
  if (!token) throw new AppError("network", "本机配对令牌不可用，请重新配对");
  const pin = normalizeTlsFingerprint(connection.tlsFingerprint);
  if (!pin) throw new AppError("network", "缺少桌面端 TLS 指纹，请重新扫码配对");
  return { baseUrl: connection.baseUrl, token, pin };
}

/**
 * 发送一条 capture_asset 票据到桌面暂存架。
 *
 * - 失败保留本地原文件与关联，用户可再次点击发送；
 * - 老桌面端不支持 `/shelf` 导入时，明确告知「文件已传到电脑但未入库」，
 *   关联保持 capture_asset + metadata_only，不伪造 transferred。
 */
export async function sendReceiptToDesktop(linkId: string): Promise<ReceiptTransferOutcome> {
  const link = await getDocumentLink(linkId);
  if (!link) throw new AppError("validation", "票据关联不存在或已解除");
  if (
    link.transferState === "transferred" &&
    link.remoteSource === "shelf_item" &&
    link.remoteRef
  ) {
    return { linkId, shelfItemId: link.remoteRef, name: link.documentName };
  }
  if (link.documentSource !== "capture_asset") {
    throw new AppError("validation", "只有手机采集的原图可以通过文件互传发送");
  }
  if (!link.localUri) {
    throw new AppError("storage", "原图尚未保存到本机，请先在素材库保存后再发送");
  }

  const file = new File(link.localUri);
  if (!file.exists) {
    throw new AppError("storage", "本机原图已缺失，无法发送；可重新拍照或导入");
  }

  const transport = await resolveTransport();
  const client = createFileClient({
    baseUrl: transport.baseUrl,
    token: transport.token,
    syncKey: await deriveSyncKey(transport.token),
  });

  try {
    const remote = await uploadLocalFile(client, file, () => undefined, undefined, link.documentName);
    try {
      const imported = await client.importToShelf(remote.id, null);
      const shelfItemId = (imported.shelf_item_id ?? "").trim();
      if (!shelfItemId) {
        await setDocumentLinkTransferState(link.id, "metadata_only");
        throw new AppError(
          "network",
          "电脑端已收到文件，但未返回暂存架条目；请在桌面文件互传页查看，或升级桌面端后重试",
        );
      }
      await markDocumentUploaded(link.id, {
        shelfItemId,
        name: imported.name || link.documentName,
        mime: link.mime,
        byteSize: imported.size,
      });
      return { linkId: link.id, shelfItemId, name: imported.name || link.documentName };
    } catch (error) {
      if (isFileHttpError(error) && error.code === "not_supported") {
        await setDocumentLinkTransferState(link.id, "metadata_only").catch(() => undefined);
        throw new AppError(
          "network",
          "电脑端已收到文件，但当前桌面版本不支持导入票据暂存；请升级桌面端后重新发送",
          error,
          "not_supported",
        );
      }
      // 上传已完成但导入失败：文件在电脑端，关联仍指向本机素材；状态诚实降级。
      await setDocumentLinkTransferState(link.id, "metadata_only").catch(() => undefined);
      throw new AppError(
        "network",
        `文件已传到电脑，但导入票据暂存失败：${describeError(error)}`,
        error,
      );
    }
  } finally {
    client.cancel();
  }
}
