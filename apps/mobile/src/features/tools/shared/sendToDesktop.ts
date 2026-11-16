// 把工具产物（文本文件 / 压缩后的图片）发送到已配对电脑。
//
// 复用文件互传的既有 TLS 通道与设备令牌，不新造协议、不写设备同步 outbox：
// - 先 `captureAvailability()` 判断是否真的已配对（含旧版连接/令牌缺失的原因）；
// - 上传完成后调用 `importToShelf` 放进桌面暂存架；老桌面端返回 404 时，
//   文件仍在「文件互传」列表里，界面必须按真实结果说明落到哪里；
// - 失败分类沿用文件互传语义：电脑离线/超时 → 可稍后重试；证书/令牌失败 → 不可重试并停止。
import { AppError, describeError } from "../../../lib/errors";
import { loadConnection, readToken } from "../../../db/syncConnection";
import { deriveSyncKey } from "../../../lib/sync/crypto";
import { createFileClient, isFileCancelled } from "../../../lib/sync/files";
import { uploadLocalFile, uploadDisplayName } from "../../../lib/sync/fileIo";
import { File } from "expo-file-system";
import { captureAvailability } from "../../capture/service";

export interface ToolTransferResult {
  ok: boolean;
  message: string;
  /** 上传后在桌面端的文件名 */
  remoteName?: string;
  /** 是否已进入桌面暂存架；false 表示只进了文件互传列表（老桌面端） */
  importedToShelf: boolean;
}

export async function sendToolFileToDesktop(options: {
  uri: string;
  fileName: string;
  mime: string;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}): Promise<ToolTransferResult> {
  const availability = await captureAvailability();
  if (!availability.paired) {
    throw new AppError("validation", availability.reason ?? "尚未与电脑配对");
  }
  const connection = await loadConnection();
  const token = await readToken();
  if (!connection || !token) throw new AppError("validation", "配对信息不完整，请重新配对");

  const client = createFileClient({
    baseUrl: connection.baseUrl,
    token,
    syncKey: await deriveSyncKey(token),
  });

  const file = new File(options.uri);
  if (!file.exists) throw new AppError("storage", "文件不存在，无法发送");
  const size = Number(file.size ?? 0);

  try {
    const remote = await uploadLocalFile(
      client,
      file,
      (done, total) => options.onProgress?.(done, total),
      options.isCancelled,
      options.fileName || uploadDisplayName(file),
    );
    let imported = false;
    try {
      await client.importToShelf(remote.id, null);
      imported = true;
    } catch (error) {
      // 老桌面端没有托管导入接口：文件已上传，只是留在互传列表。
      if (!isFileCancelled(error)) imported = false;
    }
    return {
      ok: true,
      message: imported ? "已发送到电脑暂存架" : "已上传到电脑文件互传列表（桌面端版本较旧，未自动放入暂存架）",
      remoteName: remote.name,
      importedToShelf: imported,
    };
  } catch (error) {
    if (isFileCancelled(error)) {
      return { ok: false, message: "已取消发送", importedToShelf: false };
    }
    // 保留底层错误分类，不把 TLS/令牌失败伪装成「离线」。
    if (error instanceof AppError) throw error;
    throw new AppError("network", `发送失败：${describeError(error)}`);
  }
}
