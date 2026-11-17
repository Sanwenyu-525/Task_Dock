// 票据传输状态 → 用户可见文案与可执行动作。
//
// 不能只看 remoteRef 是否非空：上传成功但暂存架导入失败时，remoteRef 已存在，
// 仍需显示「继续导入」入口；只有 shelf_item + transferred 才是真正完成。
import type { LifeDocumentLink } from "../../domain/life";

export type ReceiptAction = "send" | "resume" | "transferred";

export function receiptCountText(link: LifeDocumentLink): string {
  if (link.transferState === "missing") return "原文件缺失";
  if (
    link.transferState === "transferred" &&
    link.remoteSource === "shelf_item" &&
    link.remoteRef
  ) {
    return "原图已导入电脑";
  }
  if (link.remoteRef && link.transferState === "metadata_only") {
    return "文件已传到电脑，尚未导入";
  }
  if (link.documentSource === "capture_asset") {
    if (!link.localUri) return "本机原图缺失";
    if (link.remoteRef) return "文件已传到电脑，尚未导入";
    return link.transferState === "metadata_only"
      ? "仅元数据，原图未到电脑"
      : "本机原图，未传电脑";
  }
  if (link.documentSource === "shelf_item") return "电脑文件引用";
  return "文件引用";
}

/** 按完整传输状态派生可执行动作，不能只看 remoteRef 是否非空。 */
export function receiptAction(link: LifeDocumentLink): ReceiptAction | null {
  if (link.transferState === "missing") return null;
  if (
    link.transferState === "transferred" &&
    link.remoteSource === "shelf_item" &&
    link.remoteRef
  ) {
    return "transferred";
  }
  // 文件已上传但导入失败：保留远端文件 ID，必须允许用户继续导入。
  if (link.transferState === "metadata_only" && link.remoteRef) return "resume";
  if (link.remoteRef && link.documentSource !== "shelf_item") return "resume";
  if (link.documentSource === "capture_asset" && link.localUri && !link.remoteRef) {
    return "send";
  }
  return null;
}
