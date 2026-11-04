//! 错误文案本地化（最小兼容层）。
//!
//! 只按结构化 `code` 映射文案；旧格式错误没有稳定 code，原样返回其 `message`，
//! **绝不**用中文子串匹配来猜测错误类型。错误核心模块（`lib/errors.ts`）保持不变。

import { normalizeError, type ErrorCode } from "../lib/errors";
import { t } from "./index";
import type { MessageKey } from "./messages";

export const ERROR_MESSAGE_KEYS: Record<ErrorCode, MessageKey> = {
  VALIDATION_ERROR: "errors.VALIDATION_ERROR",
  NOT_FOUND: "errors.NOT_FOUND",
  PERMISSION_DENIED: "errors.PERMISSION_DENIED",
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

/**
 * 把任意错误转成当前语言的用户可读文案。
 * 结构化错误 → 本地化文案；旧格式错误 → 保留原始 message（不改写、不猜测）。
 * 后端可能先于前端新增错误码（`normalizeError` 会按字符串原样接收），未知 code
 * 必须回退到通用错误，不能返回 `undefined` 导致界面空白。
 */
export function localizedErrorMessage(raw: unknown): string {
  const error = normalizeError(raw);
  if (error.legacy) return error.message;
  const key = ERROR_MESSAGE_KEYS[error.code];
  const text = key ? t(key) : "";
  return text || t("errors.UNKNOWN_ERROR");
}
