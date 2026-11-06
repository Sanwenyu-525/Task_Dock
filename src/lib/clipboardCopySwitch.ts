//! 「复制并切换到目标窗口」的共享业务封装（完整面板与停靠胶囊唯一实现）。
//!
//! 语义边界（必须与「复制」「逐项粘贴」区分）：
//! - 只做两件事：把指定历史条目写入系统剪贴板、激活用户选择的目标窗口；
//! - **绝不发送 Ctrl+V、不自动输入、不调用任何粘贴接口**；
//! - 复制失败不切换窗口；复制成功但切换失败时**不回滚、不重复复制**，
//!   调用方可只重试切换（`focusTargetOnly`）。
//!
//! 安全与一致性：
//! - 复制前先用 `clipboard_paste_precheck` 做无副作用的目标校验（存在性、
//!   HWND/PID 一致性、非本应用、权限）；
//! - 切换时 `clipboard_focus_target` 会再次校验身份与前台状态，校验规则完全由
//!   Rust 后端决定，前端不自行放宽；
//! - 部分成功沿用 `CopyReport` 语义：剪贴板写入成功但统计未落库时不得回退为失败，
//!   也不能在前端虚增使用次数；
//! - 纯函数 + 依赖注入，便于不触发真实系统剪贴板/窗口的单元测试。

import {
  clipboardCopyItem,
  clipboardFocusTarget,
  clipboardPastePrecheck,
  type CopyReport,
  type PasteTarget,
} from "./bridge";
import { errorMessage } from "./errors";

/** 目标窗口身份：HWND 会被系统复用，PID 必须与选择时一致。 */
export interface CopySwitchTarget {
  hwnd: number;
  pid: number;
}

/** 可注入的底层依赖；生产默认走 `bridge.ts`，测试注入假实现。 */
export interface CopySwitchDeps {
  precheck: (hwnd: number, pid: number) => Promise<PasteTarget>;
  copy: (itemId: string) => Promise<CopyReport>;
  focus: (hwnd: number, pid: number) => Promise<PasteTarget>;
}

export const defaultCopySwitchDeps: CopySwitchDeps = {
  precheck: (hwnd, pid) => clipboardPastePrecheck(hwnd, pid),
  copy: (itemId) => clipboardCopyItem(itemId),
  focus: (hwnd, pid) => clipboardFocusTarget(hwnd, pid),
};

export type CopySwitchFailureStage = "precheck" | "copy" | "focus";

export interface CopySwitchResult {
  /** 剪贴板写入是否成功（统计失败仍算写入成功）。 */
  copied: boolean;
  /** 写入成功但有降级：`stats_recorded === false` 或存在 warnings。 */
  partial: boolean;
  report: CopyReport | null;
  precheckTarget: PasteTarget | null;
  focusTarget: PasteTarget | null;
  failure: { stage: CopySwitchFailureStage; error: unknown } | null;
}

/** `CopyReport` → 是否部分成功（与既有单条复制提示同一口径）。 */
export function isPartialCopy(report: CopyReport | null): boolean {
  return !!report && (report.stats_recorded === false || report.warnings.length > 0);
}

/** 部分成功的具体原因（按后端顺序以「；」连接）；完全成功返回 null。 */
export function copyPartialDetail(report: CopyReport | null): string | null {
  if (!report) return null;
  const detail = [
    ...(report.stats_recorded === false ? ["使用次数未记录"] : []),
    ...report.warnings,
  ].join("；");
  if (detail) return detail;
  return isPartialCopy(report) ? "部分内容未完成" : null;
}

/**
 * 复制并切换：precheck → copy → focus。
 *
 * 不抛异常，所有失败都落在 `failure.stage`：
 * - `precheck`：目标不可用，**未复制**；
 * - `copy`：复制失败，**未切换**；
 * - `focus`：已复制但切换失败（`copied === true`），后续可只重试切换。
 */
export async function copyAndSwitchItem(
  itemId: string,
  target: CopySwitchTarget,
  deps: CopySwitchDeps = defaultCopySwitchDeps,
): Promise<CopySwitchResult> {
  const empty = {
    copied: false,
    partial: false,
    report: null,
    precheckTarget: null,
    focusTarget: null,
  } as const;

  let precheckTarget: PasteTarget;
  try {
    precheckTarget = await deps.precheck(target.hwnd, target.pid);
  } catch (error) {
    return { ...empty, failure: { stage: "precheck", error } };
  }

  let report: CopyReport;
  try {
    report = await deps.copy(itemId);
  } catch (error) {
    return { ...empty, precheckTarget, failure: { stage: "copy", error } };
  }

  const partial = isPartialCopy(report);
  try {
    const focusTarget = await deps.focus(target.hwnd, target.pid);
    return {
      copied: true,
      partial,
      report,
      precheckTarget,
      focusTarget,
      failure: null,
    };
  } catch (error) {
    return {
      copied: true,
      partial,
      report,
      precheckTarget,
      focusTarget: null,
      failure: { stage: "focus", error },
    };
  }
}

/**
 * 只重试窗口切换：不写剪贴板、不重复复制。
 * 返回 ok=false 时调用方保留「已复制」状态并展示具体原因。
 */
export async function focusTargetOnly(
  target: CopySwitchTarget,
  deps: CopySwitchDeps = defaultCopySwitchDeps,
): Promise<{ ok: boolean; target: PasteTarget | null; error: unknown }> {
  try {
    return { ok: true, target: await deps.focus(target.hwnd, target.pid), error: null };
  } catch (error) {
    return { ok: false, target: null, error };
  }
}

export type CopySwitchFeedback =
  | { kind: "success"; title: string; detail: string | null }
  | { kind: "partial"; title: string; detail: string }
  | { kind: "copy-failed"; title: string; detail: string }
  | { kind: "focus-failed"; title: string; detail: string };

/**
 * 统一的结果文案（两端必须一致）：
 * - 复制成功并切换成功 → success/partial；
 * - precheck 失败 → copy-failed（未复制）；
 * - 复制失败 → copy-failed（未切换）；
 * - 复制成功但切换失败 → focus-failed（不得显示为完全失败）。
 */
export function describeCopySwitchResult(
  result: CopySwitchResult,
  opts: {
    targetTitle: string;
    errorText?: (error: unknown) => string;
  },
): CopySwitchFeedback {
  const errorText = opts.errorText ?? errorMessage;
  const title = opts.targetTitle || "目标窗口";
  if (!result.failure) {
    const partialDetail = copyPartialDetail(result.report);
    if (result.partial) {
      return {
        kind: "partial",
        title: `已复制并切换到「${title}」`,
        detail: `部分成功：${partialDetail ?? "部分内容未完成"}`,
      };
    }
    return { kind: "success", title: `已复制并切换到「${title}」`, detail: null };
  }
  if (result.failure.stage === "focus") {
    return {
      kind: "focus-failed",
      title: "内容已复制，但未能切换窗口",
      detail: errorText(result.failure.error),
    };
  }
  if (result.failure.stage === "precheck") {
    return {
      kind: "copy-failed",
      title: "目标窗口已失效，未复制内容",
      detail: errorText(result.failure.error),
    };
  }
  return {
    kind: "copy-failed",
    title: "复制失败，未切换窗口",
    detail: errorText(result.failure.error),
  };
}
