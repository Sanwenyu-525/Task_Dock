//! 错误 → 用户反馈的唯一入口。
//!
//! 设计原则：
//! 1. 复用 `useUiStore` 的 Toast 队列，不另起一套提示系统；
//! 2. 用户主动操作失败必须说明「哪个操作失败 + 原因 + 下一步」；
//! 3. 后台高频轮询失败不要每次弹 Toast（业务调用方用 `recordBackgroundError`）；
//! 4. 重试动作统一包一层安全壳，重试自身失败会再次走统一上报，不抛出第二个异常。
//! 5. 诊断日志归属：IPC 失败已由 `invokeCommand` 记录，这里不再重复写；本地抛出的
//!    错误（参数校验、状态检查等）在这里补一条，保证「一次失败只有一个主要事件」。

import { normalizeError, type AppError } from "./errors";
import { isLogged, logEvent, markLogged, reserveReport } from "./diagnostics";
import { localizedErrorMessage } from "../i18n/errors";
import { useUiStore } from "../store/useUiStore";

export interface ReportOptions {
  /** 用户视角的操作名，如「创建任务」「打开应用」 */
  operation?: string;
  /** 可安全重试时提供；失败会再次上报 */
  retry?: () => void | Promise<void>;
  /** warning 用于可降级/可忽略的失败 */
  kind?: "error" | "warning";
  /** 只归一化并返回，不弹提示（后台诊断、已有内联错误状态时使用） */
  silent?: boolean;
}

/** 错误码 → 下一步建议（简短、可执行；不承诺自动恢复）。 */
export function errorSuggestion(err: AppError): string {
  switch (err.code) {
    case "VALIDATION_ERROR":
      return "请检查填写内容后重试。";
    case "NOT_FOUND":
      return "目标可能已被移动或删除，请刷新后确认。";
    case "PERMISSION_DENIED":
      return "请检查访问权限，或改用其他位置。";
    case "DATABASE_BUSY":
      return "数据库正被其他操作占用，请稍后重试。";
    case "DATABASE_ERROR":
    case "DATA_INTEGRITY_ERROR":
      return "请勿继续写入；重启应用后如仍失败，请先备份数据。";
    case "SERVICE_UNAVAILABLE":
      return "依赖服务可能未启动，请稍后重试或重启应用。";
    case "SERVICE_OVERLOADED":
      return "任务较多，请稍后重试。";
    case "AGENT_ERROR":
      return "请检查 Agent 接入配置与运行状态。";
    case "CONFLICT":
      return "已有同类操作进行中，请等待结束或先取消。";
    case "TIMEOUT":
      return "操作超时，可稍后重试。";
    case "IO_ERROR":
      return "请检查磁盘空间、文件占用与路径是否可用。";
    case "UNSUPPORTED":
      return "当前系统或配置不支持该功能。";
    case "IPC_ERROR":
      return "窗口通信异常，请重试；若持续出现请重启应用。";
    default:
      return "";
  }
}

/** 拼装面向用户的完整文案：操作 + 具体原因（本地化） + 不重复的下一步。 */
export function formatErrorForUser(
  err: AppError,
  operation?: string,
): { title: string; message: string } {
  const reason = localizedErrorMessage(err);
  const head = operation ? `${operation}失败：${reason}` : reason;
  const suggestion = errorSuggestion(err);
  // 文案自身已带可执行建议时不再追加，避免“请稍后重试…请稍后重试”式重复。
  const alreadyActionable = /请[^。]{0,20}(重试|检查|确认|稍后|备份|等待|取消|刷新)/.test(reason);
  const message = suggestion && !alreadyActionable ? `${head} ${suggestion}` : head;
  return { title: operation ?? "操作", message };
}

function runRetrySafely(retry: () => void | Promise<void>, operation?: string): void {
  const reportAgain = (e: unknown) => {
    reportError(e, { operation, retry });
  };
  try {
    const result = retry();
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(reportAgain);
    }
  } catch (e) {
    reportAgain(e);
  }
}

/**
 * 记录一条“本地产生”的失败（非 IPC 抛出）。
 * 已被 `invokeCommand` 归属的错误直接跳过，避免同一失败写两条日志。
 */
function logOwnedError(
  err: AppError,
  operation: string | undefined,
  source: "report" | "background",
): void {
  try {
    if (isLogged(err)) return;
    // 同一失败可能已被 invokeCommand 或其它层归属（错误被重新包装后实例不同）：
    // 250ms 窗口内只抑制事件；被抑制次数在下一次实际写入时带回，不丢真实次数。
    const reservation = reserveReport(err.code, err.message);
    if (!reservation.emit) return;
    const level =
      err.severity === "critical" ? "CRITICAL" : err.severity === "warning" ? "WARN" : "ERROR";
    const metadata: Record<string, string | number | boolean> = { source };
    if (operation) metadata.operation = operation;
    if (reservation.suppressed > 0) metadata.suppressed_since_last = reservation.suppressed;
    logEvent({
      level,
      module: "ui",
      action: "report_error",
      event: "failed",
      status: "failed",
      error_code: err.code,
      error_category: err.category,
      message: err.message,
      // component 只放可读上下文；operation 是用户视角的中文名，不作为稳定标识符。
      component: operation,
      metadata,
    });
    markLogged(err);
  } catch {
    // 诊断失败不影响提示与重试。
  }
}

/**
 * 统一错误上报：归一化 + 弹 Toast（可选重试）。
 * 返回归一化错误，便于调用方继续设置内联错误状态或决定回退。
 */
export function reportError(raw: unknown, opts: ReportOptions = {}): AppError {
  const err = normalizeError(raw, opts.operation);
  // 即使只归一化不弹提示（silent），诊断仍然要记录：silent 只表示“不给用户看”。
  logOwnedError(err, opts.operation, "report");
  if (!opts.silent) {
    const { message } = formatErrorForUser(err, opts.operation);
    useUiStore.getState().showToast(message, {
      kind: opts.kind ?? "error",
      code: err.code,
      detail: err.detail,
      action: opts.retry
        ? { label: "重试", run: () => runRetrySafely(opts.retry!, opts.operation) }
        : undefined,
    });
  }
  return err;
}

/**
 * 后台任务失败：只归一化并返回文案，不主动弹 Toast。
 * 调用方应把它写入对应模块的错误状态（工具栏/面板内联提示）。
 */
export function recordBackgroundError(raw: unknown, operation?: string): AppError {
  const err = normalizeError(raw, operation);
  logOwnedError(err, operation, "background");
  return err;
}
