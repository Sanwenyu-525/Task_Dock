// 工具产物落盘：文本进系统下载目录、图片进系统相册。
//
// 复用采集中心已经在用的原生模块（MediaStore 分区存储 + 旧版本权限处理），
// 不新造第二条写盘路径：
// - Android 10+ 文本走 MediaStore.Downloads/TaskDock，图片走 Pictures/TaskDock；
// - Android 9 及以下由原生模块申请旧式存储权限后写入公共目录；
// - 返回的是系统真实的 content:// 或 file:// URI，不是「文件还在缓存里」。
import { saveToSystemGallery } from "../../capture/album";

export async function saveTextFileToDownloads(
  sourceUri: string,
  fileName: string,
): Promise<{ uri: string; displayName: string; size: number }> {
  return saveToSystemGallery(sourceUri, fileName, "text/plain");
}

export async function saveImageToGallery(
  sourceUri: string,
  fileName: string,
  mime: string,
): Promise<{ uri: string; displayName: string; size: number }> {
  return saveToSystemGallery(sourceUri, fileName, mime);
}
