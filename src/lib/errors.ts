//! 前端统一错误模型。
//!
//! 后端（v0.11+）返回结构化错误：`{ code, category, severity, retryable, message, detail }`。
//! 旧后端、第三方插件与本地抛出仍是纯字符串/Error，因此这里做归一化，保证：
//! - 机器判断只依赖 `code`，不依赖用户文案；
//! - 展示文案安全（不含 SQL / 堆栈 / 剪贴板正文）；
//! - 所有 `String(err)` 仍输出可读文案（`AppError#toString`）。
//!
//! 本文件保持纯函数/纯数据，不依赖 store，便于单测与多窗口复用。

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "IO_ERROR",
  "DATABASE_ERROR",
  "DATABASE_BUSY",
  "CONFIG_ERROR",
  "IPC_ERROR",
  "SERVICE_UNAVAILABLE",
  "SERVICE_OVERLOADED",
  "AGENT_ERROR",
  "CONFLICT",
  "TIMEOUT",
  "UNSUPPORTED",
  "DATA_INTEGRITY_ERROR",
  "UNKNOWN_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorCategory =
  | "validation"
  | "not_found"
  | "permission"
  | "io"
  | "database"
  | "config"
  | "ipc"
  | "service"
  | "agent"
  | "conflict"
  | "timeout"
  | "unsupported"
  | "integrity"
  | "unknown";
export type ErrorSeverity = "warning" | "error" | "critical";

export interface BackendErrorPayload {
  code?: unknown;
  category?: unknown;
  severity?: unknown;
  retryable?: unknown;
  message?: unknown;
  detail?: unknown;
}

export interface AppErrorInit {
  code?: ErrorCode;
  category?: ErrorCategory;
  severity?: ErrorSeverity;
  retryable?: boolean;
  detail?: string;
  operation?: string;
  /** true = 由旧格式（字符串/Error）推断，分类仅供展示兜底 */
  legacy?: boolean;
}

/** 归一化后的错误：`toString()` 直接返回用户可读文案，兼容既有 `String(e)` 调用。 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly detail?: string;
  readonly operation?: string;
  readonly legacy: boolean;

  constructor(message: string, init: AppErrorInit = {}) {
    super(message);
    this.name = "AppError";
    this.code = init.code ?? "UNKNOWN_ERROR";
    this.category = init.category ?? "unknown";
    this.severity = init.severity ?? "error";
    this.retryable = init.retryable ?? false;
    this.detail = init.detail;
    this.operation = init.operation;
    this.legacy = init.legacy ?? false;
  }

  toString(): string {
    return this.message;
  }
}

/** 旧错误文案 → 分类的兜底映射（仅在缺少结构化 code 时使用，不作为正式判定依据）。 */
const LEGACY_RULES: Array<{
  re: RegExp;
  code: ErrorCode;
  category: ErrorCategory;
  retryable: boolean;
}> = [
  { re: /校验|不能为空|格式不正确|非法|无效/ , code: "VALIDATION_ERROR", category: "validation", retryable: true },
  { re: /未找到|不存在|找不到/ , code: "NOT_FOUND", category: "not_found", retryable: false },
  { re: /没有权限|无权限|拒绝访问|权限不足/ , code: "PERMISSION_DENIED", category: "permission", retryable: false },
  { re: /数据库被占用|database is locked|busy/i , code: "DATABASE_BUSY", category: "database", retryable: true },
  { re: /数据库|sqlite/i , code: "DATABASE_ERROR", category: "database", retryable: false },
  { re: /繁忙|队列已满|请稍后重试/ , code: "SERVICE_OVERLOADED", category: "service", retryable: true },
  { re: /暂不可用|未启动|未就绪/ , code: "SERVICE_UNAVAILABLE", category: "service", retryable: true },
  { re: /超时|timeout/i , code: "TIMEOUT", category: "timeout", retryable: true },
  { re: /冲突|正在运行|已有同类/ , code: "CONFLICT", category: "conflict", retryable: false },
  { re: /不支持|unsupported/i , code: "UNSUPPORTED", category: "unsupported", retryable: false },
  { re: /损坏|数据不一致|integrity/i , code: "DATA_INTEGRITY_ERROR", category: "integrity", retryable: false },
  { re: /IO 错误|文件操作|写入失败|读取失败/i , code: "IO_ERROR", category: "io", retryable: true },
];

function classifyLegacy(message: string): AppErrorInit {
  for (const rule of LEGACY_RULES) {
    if (rule.re.test(message)) {
      return {
        code: rule.code,
        category: rule.category,
        retryable: rule.retryable,
        severity: rule.code === "DATA_INTEGRITY_ERROR" ? "critical" : "error",
        legacy: true,
      };
    }
  }
  return { code: "UNKNOWN_ERROR", category: "unknown", retryable: false, legacy: true };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 把任意抛出值归一化为 `AppError`。
 * 支持：结构化后端 payload / Error、字符串 / 对象 `{ message }` / 其他值。
 */
export function normalizeError(raw: unknown, operation?: string): AppError {
  if (raw instanceof AppError) {
    if (operation && !raw.operation) {
      return new AppError(raw.message, {
        code: raw.code,
        category: raw.category,
        severity: raw.severity,
        retryable: raw.retryable,
        detail: raw.detail,
        operation,
        legacy: raw.legacy,
      });
    }
    return raw;
  }

  if (isRecord(raw)) {
    const payload = raw as BackendErrorPayload;
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    const code = typeof payload.code === "string" ? payload.code : "";
    if (message && code) {
      return new AppError(message, {
        code: code as ErrorCode,
        category: (typeof payload.category === "string"
          ? payload.category
          : "unknown") as ErrorCategory,
        severity: (typeof payload.severity === "string"
          ? payload.severity
          : "error") as ErrorSeverity,
        retryable: payload.retryable === true,
        detail: typeof payload.detail === "string" ? payload.detail : undefined,
        operation,
        legacy: false,
      });
    }
    if (raw instanceof Error) {
      const text = raw.message?.trim() || raw.name;
      return new AppError(text, { ...classifyLegacy(text), operation });
    }
    // 纯对象但没有 message：尝试字符串化，仍保证可读
    try {
      const text = JSON.stringify(raw);
      return new AppError(text.slice(0, 240) || "未知错误", { ...classifyLegacy(text), operation });
    } catch {
      return new AppError("未知错误", { operation, legacy: true });
    }
  }

  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return new AppError("未知错误", { operation, legacy: true });
    // 旧版后端字符串形如「未找到: xxx」/「校验失败: xxx」，去掉前缀避免重复
    const cleaned = text.replace(/^(校验失败|未找到|Agent 接入错误|操作冲突)\s*[:：]\s*/, "");
    return new AppError(cleaned, { ...classifyLegacy(text), operation });
  }

  const text = typeof raw === "undefined" || raw === null ? "未知错误" : String(raw);
  return new AppError(text, { ...classifyLegacy(text), operation });
}

/** 用户可读文案（安全展示）。 */
export function errorMessage(raw: unknown): string {
  return normalizeError(raw).message;
}

export function isRetryable(raw: unknown): boolean {
  return normalizeError(raw).retryable;
}

/**
 * 统一 IPC 调用入口：把后端结构化/旧字符串错误归一化后统一抛出 `AppError`。
 * 所有窗口的 invoke 都应经过这里，保证错误码稳定且 `String(e)` 可读。
 */
export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
  operation?: string,
): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (raw) {
    throw normalizeError(raw, operation);
  }
}
