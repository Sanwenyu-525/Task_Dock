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
  /** 可展示的技术信息（已脱敏；不进入普通提示正文） */
  detail?: string;
  /** 后端给出的具体业务原因（已脱敏，供本地化文案拼接） */
  reason?: string;
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
  readonly reason?: string;
  readonly operation?: string;
  readonly legacy: boolean;

  constructor(message: string, init: AppErrorInit = {}) {
    // 构造即脱敏：任何不可信来源的错误对象都不能把原始文本带到界面。
    super(sanitizeForUser(message) || "未知错误");
    this.name = "AppError";
    this.code = init.code ?? "UNKNOWN_ERROR";
    this.category = init.category ?? "unknown";
    this.severity = init.severity ?? "error";
    this.retryable = init.retryable ?? false;
    this.detail = init.detail ? sanitizeForUser(init.detail) || undefined : undefined;
    this.reason = init.reason ? sanitizeForUser(init.reason) || undefined : undefined;
    this.operation = init.operation;
    this.legacy = init.legacy ?? false;
  }

  toString(): string {
    return this.message;
  }
}

const MAX_USER_TEXT = 240;

const ALLOWED_CATEGORIES: readonly ErrorCategory[] = [
  "validation",
  "not_found",
  "permission",
  "io",
  "database",
  "config",
  "ipc",
  "service",
  "agent",
  "conflict",
  "timeout",
  "unsupported",
  "integrity",
  "unknown",
];

const ALLOWED_SEVERITIES: readonly ErrorSeverity[] = ["warning", "error", "critical"];

/** 各错误码的默认元数据：payload 字段非法或缺省时的稳定回退。 */
const CODE_META: Record<
  ErrorCode,
  { category: ErrorCategory; severity: ErrorSeverity; retryable: boolean; fallback: string }
> = {
  VALIDATION_ERROR: { category: "validation", severity: "warning", retryable: true, fallback: "输入内容不合法" },
  NOT_FOUND: { category: "not_found", severity: "warning", retryable: false, fallback: "目标不存在" },
  PERMISSION_DENIED: { category: "permission", severity: "error", retryable: false, fallback: "没有操作权限" },
  IO_ERROR: { category: "io", severity: "error", retryable: true, fallback: "文件操作失败" },
  DATABASE_ERROR: { category: "database", severity: "error", retryable: false, fallback: "数据库操作失败" },
  DATABASE_BUSY: { category: "database", severity: "warning", retryable: true, fallback: "数据库正忙" },
  CONFIG_ERROR: { category: "config", severity: "error", retryable: false, fallback: "配置无效" },
  IPC_ERROR: { category: "ipc", severity: "error", retryable: true, fallback: "窗口通信失败" },
  SERVICE_UNAVAILABLE: { category: "service", severity: "error", retryable: true, fallback: "服务暂不可用" },
  SERVICE_OVERLOADED: { category: "service", severity: "warning", retryable: true, fallback: "服务繁忙" },
  AGENT_ERROR: { category: "agent", severity: "error", retryable: true, fallback: "Agent 接入失败" },
  CONFLICT: { category: "conflict", severity: "warning", retryable: false, fallback: "操作冲突" },
  TIMEOUT: { category: "timeout", severity: "warning", retryable: true, fallback: "操作超时" },
  UNSUPPORTED: { category: "unsupported", severity: "warning", retryable: false, fallback: "当前环境不支持" },
  DATA_INTEGRITY_ERROR: { category: "integrity", severity: "critical", retryable: false, fallback: "数据一致性异常" },
  UNKNOWN_ERROR: { category: "unknown", severity: "error", retryable: false, fallback: "未知错误" },
};

export function isKnownCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}

/** 错误码的通用兜底文案：本地化层据此区分「具体业务原因」与「通用回退」。 */
export function errorFallback(code: ErrorCode): string {
  return CODE_META[code].fallback;
}

/**
 * 用户提示文本脱敏（唯一入口）：堆栈/SQL 行、用户目录、凭证、超长文本。
 * 注意：这是“最小暴露”而不是内容审查，detail 字段在后端已按白名单生成。
 */
export function sanitizeForUser(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^at\s+\S/.test(t)) return false;
      if (/^(caused by|stack trace|error:|note:|help:)/i.test(t)) return false;
      if (
        /\b(select\s+[\w*]+|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table|alter\s+table|drop\s+table|pragma\s+\w+)/i.test(
          t,
        )
      ) {
        return false;
      }
      return true;
    });

  let text = lines.join(" ").replace(/\s+/g, " ").trim();
  // Windows 用户目录（任意盘符 + 旧版 Documents and Settings）
  text = text.replace(/[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s]+/gi, (m) =>
    m.slice(0, m.lastIndexOf("\\")) + "\\<用户>",
  );
  // macOS / Linux / root 用户目录
  text = text.replace(/\/Users\/[^/\s]+/g, "/Users/<用户>");
  text = text.replace(/\/home\/[^/\s]+/g, "/home/<用户>");
  text = text.replace(/\/root\/[^/\s]+/g, "/root/<用户>");
  // URL 内嵌凭证
  text = text.replace(/\/\/[^/@\s]+@/g, "//<已隐藏>@");
  // Bearer / token / password 等显式凭证（含 `Authorization: Bearer xxx` 与裸 `token=xxx`）
  text = text.replace(
    /\b(authorization|bearer|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd)\b\s*[:=]?\s*(?:bearer\s+)?[A-Za-z0-9._~+/=-]{6,}/gi,
    "$1 <已隐藏>",
  );

  if (text.length > MAX_USER_TEXT) {
    text = text.slice(0, MAX_USER_TEXT).trimEnd() + "…";
  }
  return text;
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
 *
 * 安全约束：只信任白名单 `code`；未知 code / 未知对象一律回退通用文案，
 * 原始文本最多进入已脱敏的 `detail`，不直接展示。
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
        reason: raw.reason,
        operation,
        legacy: raw.legacy,
      });
    }
    return raw;
  }

  if (isRecord(raw)) {
    if (raw instanceof Error) {
      const text = sanitizeForUser(raw.message?.trim() || raw.name) || "未知错误";
      return new AppError(text, { ...classifyLegacy(text), operation });
    }

    const payload = raw as BackendErrorPayload;
    const rawCode = typeof payload.code === "string" ? payload.code.trim() : "";
    const rawMessage = typeof payload.message === "string" ? payload.message : "";
    const detail = typeof payload.detail === "string" ? sanitizeForUser(payload.detail) : "";

    if (rawCode) {
      if (!isKnownCode(rawCode)) {
        // 后端先于前端新增错误码：不展示未审查的 message，只保留白名单化 detail。
        return new AppError(CODE_META.UNKNOWN_ERROR.fallback, {
          code: "UNKNOWN_ERROR",
          category: "unknown",
          severity: "error",
          retryable: false,
          detail: detail || undefined,
          operation,
          legacy: false,
        });
      }
      const meta = CODE_META[rawCode];
      const message = sanitizeForUser(rawMessage) || meta.fallback;
      const category =
        typeof payload.category === "string" &&
        (ALLOWED_CATEGORIES as readonly string[]).includes(payload.category)
          ? (payload.category as ErrorCategory)
          : meta.category;
      const severity =
        typeof payload.severity === "string" &&
        (ALLOWED_SEVERITIES as readonly string[]).includes(payload.severity)
          ? (payload.severity as ErrorSeverity)
          : meta.severity;
      const retryable = typeof payload.retryable === "boolean" ? payload.retryable : meta.retryable;
      return new AppError(message, {
        code: rawCode,
        category,
        severity,
        retryable,
        detail: detail || undefined,
        reason: sanitizeForUser(rawMessage) || undefined,
        operation,
        legacy: false,
      });
    }

    // 纯对象但没有稳定 code：不猜测、不展示序列化文本。
    // legacy=false，让本地化层统一回退到当前语言的「未知错误」，避免英文界面混入中文。
    return new AppError(CODE_META.UNKNOWN_ERROR.fallback, {
      code: "UNKNOWN_ERROR",
      category: "unknown",
      severity: "error",
      retryable: false,
      detail: detail || undefined,
      operation,
      legacy: false,
    });
  }

  if (typeof raw === "string") {
    const text = sanitizeForUser(raw);
    if (!text) return new AppError("未知错误", { operation, legacy: true });
    // 旧版后端字符串形如「未找到: xxx」/「校验失败: xxx」，去掉前缀避免重复
    const cleaned = text.replace(/^(校验失败|未找到|Agent 接入错误|操作冲突)\s*[:：]\s*/, "");
    return new AppError(cleaned, { ...classifyLegacy(text), operation });
  }

  // 数字/布尔/Symbol 等无可读业务含义的抛出值：稳定回退，不展示 String(raw)。
  return new AppError("未知错误", {
    code: "UNKNOWN_ERROR",
    category: "unknown",
    retryable: false,
    operation,
    legacy: false,
  });
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
