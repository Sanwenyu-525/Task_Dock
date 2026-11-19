//! 加入工作篮的结果分类与提示文案（纯函数，不依赖 UI / IPC）。
//!
//! 目的：后端 `TransferAddReport` 的 `rejected` 不能再被丢弃；
//! 全成功 / 部分成功 / 全失败 必须有不同呈现，全部失败时不能显示绿色成功提示。

import type { AddOutcome, TransferAddResult, TransferRejection } from "./types";

export interface AddSummary {
  outcome: AddOutcome;
  added: number;
  duplicates: number;
  rejected: TransferRejection[];
  /** 是否为「什么都没加进去」——此时必须展示失败原因。 */
  empty: boolean;
}

export function classifyAdd(report: Pick<TransferAddResult, "added" | "duplicates" | "rejected">): AddOutcome {
  if (report.added > 0) {
    return report.rejected.length > 0 || report.duplicates > 0 ? "partial" : "success";
  }
  return "failed";
}

export function summarizeAdd(report: TransferAddResult): AddSummary {
  return {
    outcome: classifyAdd(report),
    added: report.added,
    duplicates: report.duplicates,
    rejected: report.rejected,
    empty: report.added === 0 && report.duplicates === 0 && report.rejected.length === 0,
  };
}

/** 失败原因的简短列表（最多 5 条，剩余以「等 N 项」表示）。 */
export function rejectionLines(rejected: TransferRejection[], limit = 5): string[] {
  const lines = rejected.slice(0, limit).map((entry) => `${entry.title}：${entry.message}`);
  if (rejected.length > limit) lines.push(`等 ${rejected.length} 项`);
  return lines;
}
