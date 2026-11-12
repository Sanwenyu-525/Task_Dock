//! 错误文案本地化（最小兼容层）。
//!
//! 只按结构化 `code` 映射通用文案；旧格式错误没有稳定 code，原样返回其（已脱敏）
//! `message`，**绝不**用中文子串匹配来猜测错误类型。
//!
//! 具体业务原因（如「标题不能为空」「已有同类工作流正在运行」）来自后端的安全
//! `message`/`reason`：中文界面优先保留，避免错误码把具体原因抹掉；英文界面只输出
//! 本地化通用文案，不混入未翻译的中文技术文本。英文原文原因在中文界面也不直接
//! 拼接，避免中英混排。

import { errorFallback, normalizeError, type AppError, type ErrorCode } from "../lib/errors";
import { getLocale, t } from "./index";
import type { MessageKey } from "./messages";

export const ERROR_MESSAGE_KEYS: Record<ErrorCode, MessageKey> = {
  VALIDATION_ERROR: "errors.VALIDATION_ERROR",
  NOT_FOUND: "errors.NOT_FOUND",
  PERMISSION_DENIED: "errors.PERMISSION_DENIED",
  PERMISSION_REQUIRED: "errors.PERMISSION_REQUIRED",
  IO_ERROR: "errors.IO_ERROR",
  DATABASE_ERROR: "errors.DATABASE_ERROR",
  DATABASE_BUSY: "errors.DATABASE_BUSY",
  CONFIG_ERROR: "errors.CONFIG_ERROR",
  IPC_ERROR: "errors.IPC_ERROR",
  SERVICE_UNAVAILABLE: "errors.SERVICE_UNAVAILABLE",
  SERVICE_OVERLOADED: "errors.SERVICE_OVERLOADED",
  AGENT_ERROR: "errors.AGENT_ERROR",
  CONFLICT: "errors.CONFLICT",
  TIMEOUT: "errors.TIMEOUT",
  UNSUPPORTED: "errors.UNSUPPORTED",
  DATA_INTEGRITY_ERROR: "errors.DATA_INTEGRITY_ERROR",
  UNKNOWN_ERROR: "errors.UNKNOWN_ERROR",
};

/** 判断文本是否含中日韩字符（用于避免英文界面混入中文技术错误）。 */
function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}

/** 具体业务原因：安全、简短、与通用文案不同且为当前语言可读的文本。 */
function specificReason(error: AppError, base: string): string | null {
  const candidate = (error.reason ?? error.message).trim();
  // 通用回退（如「未知错误」「目标不存在」）不是具体业务原因，不能覆盖本地化文案
  if (!candidate || candidate === base || candidate === errorFallback(error.code)) return null;
  if (candidate.length > 120) return null;
  if (!hasCjk(candidate)) return null;
  return candidate;
}

/**
 * 把任意错误转成当前语言的用户可读文案。
 * - 结构化错误：中文界面优先保留后端具体原因（若是中文），否则用通用文案；
 *   英文界面只用本地化通用文案。
 * - 旧格式错误：保留原始（已脱敏）message。
 * - 未知 code：回退通用文案，绝不返回 `undefined` 导致界面空白。
 */
export function localizedErrorMessage(raw: unknown): string {
  const error = normalizeError(raw);
  if (error.legacy) return error.message;
  const key = ERROR_MESSAGE_KEYS[error.code];
  const base = (key ? t(key) : "") || t("errors.UNKNOWN_ERROR");
  if (getLocale() === "zh-CN") {
    const reason = specificReason(error, base);
    if (reason) return reason;
  }
  return base;
}
