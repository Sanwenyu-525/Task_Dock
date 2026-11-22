import type { ToastKind } from "../../store/useUiStore";
import type { ShelfMutationResult } from "../../store/useShelfStore";

export function shelfDeleteFeedback(
  result: ShelfMutationResult,
  action: "delete" | "clear",
): { message: string; kind: ToastKind } {
  const { deleted, skipped, failed_files: failedFiles } = result.report;
  let message: string;

  if (action === "clear") {
    if (!result.synced && deleted > 0 && skipped === 0) {
      message = `已清理 ${deleted} 项，暂存架剩余状态待同步`;
    } else if (!result.synced && deleted === 0 && skipped === 0) {
      message = "未报告删除条目，暂存架状态待同步";
    } else if (deleted === 0 && skipped === 0 && result.remainingTotal === 0 && result.synced) {
      message = "暂存架已经为空";
    } else if (deleted === 0 && skipped > 0) {
      message = `没有清理普通条目，保留 ${skipped} 项收藏/置顶/场景引用条目`;
    } else if (deleted > 0 && skipped > 0) {
      message = `已清理 ${deleted} 项，保留 ${skipped} 项收藏/置顶/场景引用条目`;
    } else if (deleted > 0 && result.remainingTotal && result.remainingTotal > 0) {
      message = `已清理 ${deleted} 项，暂存架还剩 ${result.remainingTotal} 项`;
    } else if (deleted > 0) {
      message = `已清空暂存架，共删除 ${deleted} 项`;
    } else {
      message = "没有删除任何条目";
    }
  } else if (deleted === 0 && skipped > 0) {
    message = "没有删除任何条目，所选内容受到收藏、置顶或场景引用保护";
  } else if (deleted > 0 && skipped > 0) {
    message = `已删除 ${deleted} 项，保留 ${skipped} 项收藏、置顶或场景引用内容`;
  } else if (deleted > 0) {
    message = `已删除 ${deleted} 项`;
  } else {
    message = "没有删除任何条目";
  }

  if (failedFiles > 0) {
    message += `；${failedFiles} 个托管文件或缩略图清理失败，暂存记录已删除，磁盘可能有残留`;
  }
  if (!result.synced) {
    message += "；列表刷新失败，请重试同步";
  }

  const kind: ToastKind =
    skipped > 0 || failedFiles > 0 || !result.synced || deleted === 0 ? "warning" : "success";
  return { message, kind };
}
