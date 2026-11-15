//! 文件操作结果摘要（界面与诊断共用同一套稳定错误码语义）。
//!
//! 为什么单独抽出来：`FsOpReport` 的 `reason` 是给人读的中文/OS 文案，**不能**
//! 用来判定「这是权限问题还是被占用」；界面必须按 Rust 侧产出的 `FS_OP_*`
//! 稳定码分类，才能给出「下一步该怎么做」。这里是唯一的映射实现，避免面板里
//! 再抄一份字符串匹配。

import type { FsOpReport } from "../bridge";

/** 稳定错误码 → 分类（与 `src-tauri/src/file_workspace/mod.rs` 的 `fs_op_category` 一致）。 */
export const FS_OP_CATEGORY: Record<string, string> = {
  FS_OP_SOURCE_MISSING: "not_found",
  FS_OP_ACCESS_DENIED: "permission",
  FS_OP_FILE_BUSY: "io",
  FS_OP_IO: "io",
  FS_OP_CONFLICT: "conflict",
  FS_OP_VALIDATION: "validation",
  FS_OP_UNSUPPORTED: "unsupported",
  FS_OP_CANCELLED: "cancelled",
  FS_OP_MULTI_FAILURE: "unknown",
};

export type FsOpSummary = {
  attempted: number;
  ok: number;
  failed: number;
  skipped: number;
  partial: number;
  /** `failed + partial`：业务上未完整成功的条数。 */
  unsuccessful: number;
  /** 出现次数最多的失败码（同数量时按码字典序，保证确定性）。 */
  dominantCode: string | null;
  /** 主导失败码对应的分类（`permission` / `io` / `conflict`…），无失败为 null。 */
  category: string | null;
  /** 部分成功：既有成功也有未成功（不能提示「全部成功」）。 */
  isPartial: boolean;
};

/** 汇总一次文件操作的结果；不读取 `reason`、不输出任何路径。 */
export function summarizeOpReport(report: FsOpReport): FsOpSummary {
  const counts = new Map<string, number>();
  for (const entry of report.entries) {
    if (entry.status !== "failed" && entry.status !== "partial") continue;
    const code = entry.code || "FS_OP_UNKNOWN";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let dominantCode: string | null = null;
  let best = -1;
  for (const [code, count] of counts) {
    if (count > best || (count === best && dominantCode !== null && code < dominantCode)) {
      dominantCode = code;
      best = count;
    }
  }
  const failed = report.failed ?? 0;
  const partial = report.partial ?? 0;
  const unsuccessful = failed + partial;
  return {
    attempted: report.attempted ?? 0,
    ok: report.ok ?? 0,
    failed,
    skipped: report.skipped ?? 0,
    partial,
    unsuccessful,
    dominantCode,
    category: dominantCode ? (FS_OP_CATEGORY[dominantCode] ?? "unknown") : null,
    isPartial: unsuccessful > 0 && (report.ok ?? 0) > 0,
  };
}

/** 失败分类的 i18n 键后缀集合（`fw.reason.<后缀>` 全部存在，见 zh-CN/en-US）。 */
export type ReasonSuffix =
  | "not_found"
  | "permission"
  | "io"
  | "conflict"
  | "validation"
  | "unsupported"
  | "cancelled"
  | "unknown";

/** 分类 → i18n 键后缀（`fw.reason.*`）。未知分类回退 `unknown`。 */
export function reasonKeyForCategory(category: string | null): ReasonSuffix {
  switch (category) {
    case "not_found":
    case "permission":
    case "io":
    case "conflict":
    case "validation":
    case "unsupported":
    case "cancelled":
      return category;
    default:
      return "unknown";
  }
}
