//! 「复制并切换 / 粘贴到目标窗口」的共享业务封装（完整面板与停靠胶囊唯一实现）。
//!
//! 两个动作语义严格区分：
//! - **复制并切换**：只把指定历史条目写入系统剪贴板、激活目标窗口，
//!   **绝不发送 Ctrl+V**；复制失败不切换，复制成功但切换失败时
//!   **不回滚、不重复复制**，调用方可只重试切换（`focusTargetOnly`）；
//! - **粘贴到目标窗口**：完全交给后端既有粘贴队列（`clipboard_paste_items`
//!   单条任务）执行受控写入 → 聚焦 → 发送一次 Ctrl+V → 观察 → 尝试恢复剪贴板；
//!   前端不自行合成按键、不新增第二套粘贴实现，也不把「按键已发送」说成
//!   「目标已接收」。
//!
//! 安全与一致性：
//! - 复制前先用 `clipboard_paste_precheck` 做无副作用的目标校验（存在性、
//!   HWND/PID 一致性、非本应用、权限）；
//! - 切换时 `clipboard_focus_target` 会再次校验身份与前台状态，校验规则完全由
//!   Rust 后端决定，前端不自行放宽；
//! - 部分成功沿用 `CopyReport` 语义：剪贴板写入成功但统计未落库时不得回退为失败，
//!   也不能在前端虚增使用次数；
//! - 粘贴结果只以后端任务快照/结束事件为准，未收到结束状态时如实标记未知；
//! - 纯函数 + 依赖注入，便于不触发真实系统剪贴板/窗口的单元测试。

import {
  clipboardCopyItem,
  clipboardFocusTarget,
  clipboardPastePrecheck,
  type ClipboardPasteEvent,
  type CopyReport,
  type PasteJob,
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
  | { kind: "focus-failed"; title: string; detail: string }
  /** 粘贴动作已发送（后端未收到可验证的接收信号，detail 必须保留原始说明）。 */
  | { kind: "paste-sent"; title: string; detail: string }
  | { kind: "paste-failed"; title: string; detail: string };

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

// ── 切换到目标窗口并粘贴（复用后端粘贴队列，单条任务） ──

/**
 * 粘贴任务的归一化结果。
 *
 * 只保留「后端真实说过的事实」：状态、已发送条数、说明与是否恢复剪贴板；
 * 不推断目标应用是否接收（当前第三方应用普遍没有可靠接收信号）。
 */
export interface PasteSwitchOutcome {
  status: string;
  sent: number;
  total: number;
  message: string | null;
  restored: boolean | null;
}

export function pasteOutcomeFromJob(job: PasteJob): PasteSwitchOutcome {
  return {
    status: job.status,
    sent: job.sent,
    total: job.total,
    // 后端 message 是空串时与「没有说明」等价，统一成 null 供文案判空。
    message: job.message?.trim() ? job.message : null,
    restored: job.restored,
  };
}

export function pasteOutcomeFromEvent(event: ClipboardPasteEvent): PasteSwitchOutcome {
  return {
    status: event.status,
    sent: event.sent,
    total: event.total,
    message: event.message?.trim() ? event.message : null,
    restored: event.restored ?? null,
  };
}

/**
 * 粘贴动作的结果：
 * - `ok=false`：任务没有启动（目标失效、已有其它粘贴任务、条目已删除等），未写入任何内容；
 * - `ok=true, outcome=null`：任务已启动，但等待超时仍未收到结束状态；
 * - `ok=true, outcome=…`：任务已结束（completed / cancelled / failed）。
 *
 * 绝不因为「任务已启动」就当作粘贴成功：是否发送过按键、是否被取消都以 outcome 为准。
 */
export type PasteSwitchResult =
  | { ok: true; outcome: PasteSwitchOutcome | null }
  | { ok: false; error: unknown };

/**
 * 粘贴动作的统一文案（两端一致）：
 * - completed → paste-sent（详情必须保留后端「目标是否接收无法自动验证」的原话）；
 * - cancelled / failed → paste-failed，不显示为成功；
 * - 未启动或等待超时 → paste-failed，说明真实原因。
 */
export function describePasteSwitchResult(
  result: PasteSwitchResult,
  opts: {
    targetTitle: string;
    errorText?: (error: unknown) => string;
  },
): CopySwitchFeedback {
  const errorText = opts.errorText ?? errorMessage;
  const title = opts.targetTitle || "目标窗口";
  if (!result.ok) {
    return {
      kind: "paste-failed",
      title: `未能粘贴到「${title}」`,
      detail: errorText(result.error),
    };
  }
  const outcome = result.outcome;
  if (!outcome) {
    return {
      kind: "paste-failed",
      title: "未确认粘贴任务结束",
      detail: "已请求切换到目标窗口并粘贴，但未收到任务结束状态；任务可能仍在后台进行，请到剪贴板页确认。",
    };
  }
  const detail =
    outcome.message ?? "粘贴动作已发送；目标应用是否接收无法自动验证。";
  if (outcome.status === "completed") {
    return { kind: "paste-sent", title: `已向「${title}」发送粘贴`, detail };
  }
  if (outcome.status === "cancelled") {
    return { kind: "paste-failed", title: "粘贴已取消", detail };
  }
  return { kind: "paste-failed", title: "粘贴未完成", detail };
}
