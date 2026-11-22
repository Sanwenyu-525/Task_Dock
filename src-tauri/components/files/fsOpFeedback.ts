//! 文件操作结果的**统一**用户反馈（文件工作区面板与单个分栏共用）。
//!
//! 为什么需要统一：同一份 `FsOpReport` 曾经在 `FilesWorkspacePanel` 与
//! `FilePane` 各写一套 Toast 文案，判定条件只用 `failed > 0`，因此
//! 「1 项失败 + 3 项成功」会被当成完全成功提示，也不显示失败原因与下一步。
//!
//! 这里只做「业务结果 → 一句人话」的映射：
//! - 只要 `failed + partial > 0` 就不提示「全部成功」；
//! - 失败原因取稳定错误码分类（权限 / 占用 / 同名冲突…），不展示路径；
//! - 明确指向「设置 · 诊断与日志」，因为权威事件由 Rust 按同一 operation_id 写入。

import type { FsOpReport } from "../../lib/bridge";
import type { MessageKey } from "../../i18n";
import {
  reasonKeyForCategory,
  summarizeOpReport,
  type FsOpSummary,
  type ReasonSuffix,
} from "../../lib/filesWorkspace/opReport";

export type FsOpEffect = "copy" | "move" | "deleteRecycle" | "deletePermanent";

// 必须与 `useLocale()` 的 `t` 双向兼容（`MessageKey` 是 zh-CN 的键字面量联合）：
// 只写 `key: string` 会在 strictFunctionTypes 下拒绝接收 `t`；把 vars 放宽到
// `MessageParams` 又会让测试桩（Record<string, string|number>）反而不兼容。
type Translator = (key: MessageKey, vars?: Record<string, string | number>) => string;
type ShowToast = (message: string, options?: { kind?: "success" | "error" | "warning" | "info" }) => void;

/** 成功提示的 i18n 键（未完整成功时不用）。 */
const OK_KEY: Record<FsOpEffect, MessageKey> = {
  copy: "fw.report.copyOk",
  move: "fw.report.moveOk",
  deleteRecycle: "fw.report.deleteOk",
  deletePermanent: "fw.report.deletePermanent",
};

/** 未完整成功时的标题键。 */
const FAIL_KEY: Record<FsOpEffect, MessageKey> = {
  copy: "fw.report.partialCopy",
  move: "fw.report.partialMove",
  deleteRecycle: "fw.report.partialDelete",
  deletePermanent: "fw.report.partialDelete",
};

/** 分类后缀 → 完整 i18n 键（编译期校验每个键都真实存在）。 */
const REASON_KEY: Record<ReasonSuffix, MessageKey> = {
  not_found: "fw.reason.not_found",
  permission: "fw.reason.permission",
  io: "fw.reason.io",
  conflict: "fw.reason.conflict",
  validation: "fw.reason.validation",
  unsupported: "fw.reason.unsupported",
  cancelled: "fw.reason.cancelled",
  unknown: "fw.reason.unknown",
};

/**
 * 展示一次文件操作的结果。
 *
 * 返回 `true` 表示「全部成功」，调用方不要再自行提示，避免两套文案。
 */
export function showFsOpOutcome(args: {
  effect: FsOpEffect;
  report: FsOpReport;
  t: Translator;
  showToast: ShowToast;
}): boolean {
  const { effect, report, t, showToast } = args;
  const summary = summarizeOpReport(report);
  if (summary.unsuccessful === 0) {
    showToast(t(OK_KEY[effect], { count: summary.ok }), { kind: "success" });
    return true;
  }
  showToast(
    t(FAIL_KEY[effect], {
      ok: summary.ok,
      failed: summary.failed,
      partial: summary.partial,
      skipped: summary.skipped,
      reason: t(REASON_KEY[reasonKeyForCategory(summary.category)]),
    }),
    { kind: "warning" },
  );
  return false;
}

/** 供测试与诊断面板复用：把报告压成一行摘要（不含路径）。 */
export function describeOpSummary(summary: FsOpSummary): string {
  return `ok=${summary.ok} failed=${summary.failed} partial=${summary.partial} skipped=${summary.skipped} code=${summary.dominantCode ?? "-"}`;
}
