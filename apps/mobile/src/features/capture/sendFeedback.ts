// 发送结果反馈：页面 Toast 只允许根据真实 business outcome 生成。
//
// 背景：sendToDesktop() 的 offline/stopBatch 只描述“传输层是否中断”，不能代表业务
// 成功；单条重试曾经只要 offline=false、stopBatch=false 就显示“已发送到电脑”，导致
// outcome=failed 却弹成功。本文件把决策抽成纯函数，页面与测试共用同一套规则。
import type { ToastTone } from "../../feedback/toastQueue";

import type { SendOutcome, SendResult, ShelfImportRetryResult } from "./service";

export type SendTarget = "inbox" | "shelf";

export interface SendCounts {
  done: number;
  pending: number;
  failed: number;
  cancelled: number;
  total: number;
}

export interface SendFeedback {
  message: string;
  tone: ToastTone;
}

function emptyCounts(): SendCounts {
  return { done: 0, pending: 0, failed: 0, cancelled: 0, total: 0 };
}

/**
 * 暂存架 done 必须带 remoteShelfId；没有真实 shelf_item_id 不能算成功。
 * 桌面收件箱的 done 只需要 remoteId/业务完成标记（remoteId 由调用方按需附带）。
 */
export function isSuccessfulOutcome(outcome: SendOutcome, target: SendTarget): boolean {
  if (outcome.state !== "done") return false;
  if (target === "shelf") return Boolean(outcome.shelfId);
  return true;
}

export function countOutcomes(
  outcomes: readonly SendOutcome[],
  target: SendTarget,
  total = outcomes.length,
): SendCounts {
  const counts = emptyCounts();
  counts.total = total;
  for (const outcome of outcomes) {
    if (isSuccessfulOutcome(outcome, target)) counts.done += 1;
    else if (outcome.state === "pending") counts.pending += 1;
    else if (outcome.state === "cancelled") counts.cancelled += 1;
    else counts.failed += 1;
  }
  return counts;
}

export function formatCounts(counts: SendCounts): string {
  const parts = [`成功 ${counts.done} 项`];
  if (counts.pending > 0) parts.push(`等待 ${counts.pending} 项`);
  if (counts.failed > 0) parts.push(`失败 ${counts.failed} 项`);
  if (counts.cancelled > 0) parts.push(`取消 ${counts.cancelled} 项`);
  if (counts.total > counts.done + counts.pending + counts.failed + counts.cancelled) {
    parts.push(`未执行 ${counts.total - counts.done - counts.pending - counts.failed - counts.cancelled} 项`);
  }
  return parts.join(" · ");
}

/** 单条 outcome 的反馈；调用方必须传真实 outcome，不得用“没有异常”代替。 */
export function feedbackForOutcome(outcome: SendOutcome | undefined, target: SendTarget): SendFeedback {
  if (!outcome) {
    return { message: "发送结束但未收到业务结果，请刷新后核对", tone: "danger" };
  }
  if (outcome.state === "done") {
    if (target === "shelf" && !outcome.shelfId) {
      return {
        message: "电脑端已接收，但未返回暂存架条目 ID；请刷新核对后再操作",
        tone: "danger",
      };
    }
    return {
      message: target === "shelf" ? "已加入暂存架" : "已发送到电脑",
      tone: "success",
    };
  }
  if (outcome.state === "pending") {
    return {
      message:
        outcome.message ??
        (target === "shelf"
          ? "文件已上传，暂存架导入等待重试"
          : "电脑端暂时不可达，已保留为待发送"),
      tone: "warn",
    };
  }
  if (outcome.state === "cancelled") {
    return { message: outcome.message ?? "已取消发送", tone: "warn" };
  }
  return { message: outcome.message ?? "发送失败，请重试", tone: "danger" };
}

/**
 * 批量/单条 SendResult 的反馈。规则：
 * - 任一 failed -> danger（不能出现“全部成功”）；
 * - 有 pending/cancelled -> warn；
 * - 全部 done -> success；
 * - stopBatch 优先展示授权/TLS 等安全错误。
 */
export function feedbackForSendResult(result: SendResult, target: SendTarget): SendFeedback {
  const counts = countOutcomes(result.outcomes, target);
  const firstFailure = result.outcomes.find(
    (outcome) => !isSuccessfulOutcome(outcome, target) && outcome.state === "failed",
  )?.message;
  const summary = formatCounts(counts);

  if (result.stopBatch) {
    return {
      message: [result.message, summary].filter(Boolean).join("；"),
      tone: "danger",
    };
  }
  if (counts.failed > 0) {
    return {
      message: [result.message ?? firstFailure, summary].filter(Boolean).join("；"),
      tone: "danger",
    };
  }
  if (result.offline || counts.pending > 0) {
    return {
      message: [result.message, summary].filter(Boolean).join("；"),
      tone: "warn",
    };
  }
  if (counts.cancelled > 0) {
    return { message: summary, tone: "warn" };
  }
  return {
    message: counts.done === counts.total && counts.total > 0 ? `发送完成：成功 ${counts.done} 项` : summary,
    tone: "success",
  };
}

/** 只重试暂存架的结果反馈：done 也必须有 remoteShelfId。 */
export function feedbackForShelfRetry(retry: ShelfImportRetryResult): SendFeedback {
  if (retry.state === "done") {
    if (!retry.remoteShelfId) {
      return {
        message: "电脑端已接收，但未返回暂存架条目 ID；请刷新核对后再操作",
        tone: "danger",
      };
    }
    return { message: "已加入暂存架", tone: "success" };
  }
  if (retry.state === "pending") return { message: retry.message, tone: "warn" };
  if (retry.state === "cancelled") return { message: retry.message, tone: "warn" };
  return { message: retry.message, tone: "danger" };
}
