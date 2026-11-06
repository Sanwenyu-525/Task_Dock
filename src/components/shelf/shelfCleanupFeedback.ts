import type { ToastKind } from "../../store/useUiStore";
import type { ShelfCleanupResult } from "../../store/useShelfStore";
import { formatBytes } from "../../lib/clipboardUi";

/**
 * 过期清理结果反馈：后端报告是唯一事实源。
 * 不把「记录已处理但托管文件失败」「执行成功但列表未同步」说成全部成功，
 * 也不把过期记录数与孤儿文件数相加虚报清理量。
 */
export function shelfCleanupFeedback(result: ShelfCleanupResult): {
  message: string;
  kind: ToastKind;
} {
  const { report } = result;
  const parts: string[] = [];

  if (report.candidates > 0) {
    parts.push(`已清理 ${report.candidates} 项，释放约 ${formatBytes(report.freed_bytes)}`);
  } else {
    parts.push("没有需要清理的过期条目");
  }
  if (report.skipped_protected > 0) {
    parts.push(`${report.skipped_protected} 项因收藏、置顶或场景引用而保留`);
  }
  if (report.orphan_files_removed > 0) {
    parts.push(`另外清理了 ${report.orphan_files_removed} 个无引用的托管残留文件`);
  }
  if (report.temporary_files_skipped > 0) {
    parts.push(`${report.temporary_files_skipped} 个临时文件正在使用中，已跳过`);
  }
  if (report.failed_files > 0) {
    parts.push(`部分托管文件清理失败（${report.failed_files} 个），磁盘可能仍有残留`);
  }
  if (!result.synced) {
    parts.push("清理操作已经执行，但列表状态尚未同步");
  }

  const kind: ToastKind =
    !result.synced || report.failed_files > 0
      ? "warning"
      : report.candidates === 0
        ? "info"
        : report.skipped_protected > 0 || report.temporary_files_skipped > 0
          ? "warning"
          : "success";

  return { message: `${parts.join("；")}。`, kind };
}
