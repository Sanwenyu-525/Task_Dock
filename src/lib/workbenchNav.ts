//! 主窗口 → 统一工作台的导航事务（U0）。
//!
//! 「invoke 返回成功」只代表请求已入队；真实结果只认工作台回执：
//! - `succeeded`：工作台已切到目标功能（窗口已唤醒并聚焦）；
//! - `pending`：工作台有未保存草稿，已弹出确认条，等用户确认/取消；
//! - `cancelled`：用户取消切换，原页面与草稿保留；
//! - `failed`：路由被拒绝/保存中/窗口不可用，附可读原因。
//!
//! requestId 由本模块**在发命令之前**生成并登记监听：工作台可能在命令响应
//! 返回之前就回执（窗口已存在时尤其常见），晚登记会丢掉早到的回执并假超时。
//!
//! 失败不伪造成功：超时、订阅失败、编号不一致都返回 `failed` 并写诊断；
//! 胶囊/主面板据此展示失败原因，而不是静默当作已打开。

import {
  onWorkbenchNavAck,
  workbenchOpenWindow,
  type WorkbenchNavAck,
  type WorkbenchNavStatus,
  type WorkbenchNavTarget,
} from "./bridge";
import { logEvent } from "./diagnostics";
import { errorMessage } from "./errors";

export type WorkbenchNavOutcomeStatus = WorkbenchNavStatus;

export interface WorkbenchNavOutcome {
  /** 已切到目标功能（pending 时为 false）。 */
  ok: boolean;
  /** 被未保存草稿拦截，等待用户在工作台确认（不是失败，也还不是成功）。 */
  pending: boolean;
  status: WorkbenchNavOutcomeStatus;
  /** 非 succeeded / pending 时的可读原因。 */
  error: string | null;
  requestId: number;
  /** 本次调用是否创建了工作台窗口（诊断用）。 */
  created: boolean;
}

export interface OpenWorkbenchOptions {
  /** 覆盖默认回执超时（测试用）。 */
  timeoutMs?: number;
  /** 注入请求编号（测试/重试用；正常由本模块生成）。 */
  requestId?: number;
}

const ACK_TIMEOUT_MS = 12_000;

let requestSeq = 0;

/** 客户端请求编号：Date.now()*1000 + 序号，进程内单调且与既有协议同口径。 */
export function nextWorkbenchRequestId(): number {
  requestSeq = (requestSeq + 1) % 1000;
  return Date.now() * 1000 + requestSeq;
}

function finish(
  status: WorkbenchNavOutcomeStatus,
  requestId: number,
  created: boolean,
  error: string | null,
): WorkbenchNavOutcome {
  return {
    ok: status === "succeeded",
    pending: status === "pending",
    status,
    error,
    requestId,
    created,
  };
}

function reportFailure(action: string, message: string): void {
  logEvent({
    level: "WARN",
    module: "workbench-nav",
    action,
    event: "navigate-failed",
    message,
  });
}

/**
 * 打开/唤醒工作台并导航到结构化目标。只应在主窗口（胶囊/完整面板）调用。
 */
export async function openWorkbench(
  target: WorkbenchNavTarget,
  options: OpenWorkbenchOptions = {},
): Promise<WorkbenchNavOutcome> {
  const requestId = options.requestId ?? nextWorkbenchRequestId();
  const timeoutMs = options.timeoutMs ?? ACK_TIMEOUT_MS;

  // 先登记回执监听，再发命令：工作台可能在命令响应之前就回执。
  let resolveAck: ((ack: WorkbenchNavAck | null) => void) | null = null;
  const ackPromise = new Promise<WorkbenchNavAck | null>((resolve) => {
    resolveAck = resolve;
  });
  let settled = false;
  const settle = (ack: WorkbenchNavAck | null): void => {
    if (settled) return;
    settled = true;
    resolveAck?.(ack);
  };

  let unlisten: (() => void) | null = null;
  try {
    unlisten = await onWorkbenchNavAck((ack) => {
      if (ack.requestId === requestId) settle(ack);
    });
  } catch (e) {
    const message = `无法订阅工作台回执：${errorMessage(e)}`;
    reportFailure("subscribe-ack", message);
    return finish("failed", requestId, false, message);
  }

  const timer = setTimeout(() => settle(null), timeoutMs);

  try {
    let created = false;
    try {
      const response = await workbenchOpenWindow({
        target,
        projectId: target.projectId ?? null,
        requestId,
      });
      created = response.created;
      if (response.requestId !== requestId) {
        const message = "工作台回执编号不一致，请重试";
        reportFailure("request-id-mismatch", message);
        return finish("failed", requestId, created, message);
      }
    } catch (e) {
      const message = `打开工作台失败：${errorMessage(e)}`;
      reportFailure("open-window", message);
      return finish("failed", requestId, false, message);
    }

    const ack = await ackPromise;
    if (!ack) {
      const message = `工作台未在 ${Math.round(timeoutMs / 1000)} 秒内回执（可能仍在启动或渲染失败）；窗口若已打开，请手动切换功能后重试`;
      reportFailure("ack-timeout", message);
      return finish("failed", requestId, created, message);
    }
    if (ack.status === "succeeded") {
      return finish("succeeded", requestId, created, null);
    }
    if (ack.status === "pending") {
      return finish(
        "pending",
        requestId,
        created,
        "工作台有未保存内容：已在工作台弹出确认条，确认前不会切换",
      );
    }
    if (ack.status === "cancelled") {
      return finish("cancelled", requestId, created, ack.error ?? "已在工作台取消切换");
    }
    return finish("failed", requestId, created, ack.error ?? "工作台导航失败");
  } finally {
    clearTimeout(timer);
    unlisten?.();
  }
}

/** 打开工作台首页（胶囊的完整工作台入口）。 */
export function openWorkbenchHome(options?: OpenWorkbenchOptions): Promise<WorkbenchNavOutcome> {
  return openWorkbench({ tab: "home" }, options);
}

/** 测试/诊断：重置请求序号。 */
export function __resetWorkbenchNavForTests(): void {
  requestSeq = 0;
}
