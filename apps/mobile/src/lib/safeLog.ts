// SafeLog：移动端 JS 侧统一日志入口（设计 docs/architecture/unified-observability-design.md §5）。
//
// 定位：本文件是生产代码唯一的日志调用面（生产 console 为 0 是本仓库红线）；
// 原生侧 modules/logger/android/src/main/java/.../SafeLog.kt 是 Logcat 的唯一入口，**双端脱敏规则互相引用，
// 改一处必须同步另一处**（本文件 REDACT 与 SafeLog.kt sanitizeText 一一对应）。
//
// 行为契约：
// - 级别过滤：默认 info 及以上；trace/debug 需 setMinLevel 显式开启（开发/排查用）；
// - 全部走脱敏：禁业务正文/完整路径/token/剪贴板内容/语音正文/图片；metadata 只收
//   「类型/大小/耗时/结果码」类最小化基本值字段，超限截断、非基本值丢弃；
// - JS 侧有界内存缓冲（默认 500 条，滚动丢弃最旧），并桥接原生 sink 写文件；
// - 原生不可用/异常时**静默降级**：绝不抛错、绝不导致 App 崩溃。
import { getTaskDockLogger } from "../../modules/logger";

export type SafeLogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** 最小化 metadata：只允许基本值；数组/对象/函数等一律丢弃。 */
export type SafeLogMetadata = Record<string, string | number | boolean | null>;

export interface SafeLogEntry {
  /** epoch ms */
  t: number;
  level: SafeLogLevel;
  tag: string;
  message: string;
  metadata: SafeLogMetadata | null;
}

/** 原生 sink 形状（与 modules/logger 的 TaskDockLoggerNative 一致，测试可注入替身）。 */
export interface SafeLogSink {
  write(level: string, tag: string, message: string, metadataJson: string | null): void;
  flush(): Promise<unknown>;
}

const LEVEL_WEIGHT: Record<SafeLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// 脱敏规则（与 modules/logger/.../SafeLog.kt sanitizeText 同套，**改一处必须同步另一处**，
// 双侧规则对照测试见 safeLog.test.ts 与 Kotlin SafeLogTest）：
// - Bearer 前缀、token/password/passwd/secret/apiKey/api_key/api-key/apikey/authorization/
//   auth/sig/key 赋值形态（含 URL 查询参数 ?key= / ?auth= / ?sig=）→ [redacted]；
// - 邮箱地址、≥32 位 hex（令牌/密钥形态）、sk- 前缀密钥 → [redacted]；
// - Windows 盘符路径 / file|content URI / 常见 POSIX 系统路径 → [path]。
// 16 位 traceId 与普通错误码不受影响。
// 每条规则自带替换标记：凭据类 → [redacted]，路径类 → [path]。
const REDACT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Bearer 先于 authorization 标记规则：否则 "Authorization: Bearer <token>" 的
  // token 值会被标记规则吃掉前缀后残留下来。
  [/\bBearer\s+\S+/gi, "[redacted]"],
  // authorization 排在 auth 前，避免前缀被短标记吃掉；key/auth/sig 覆盖 URL 查询参数。
  [/\b(?:authorization|token|password|passwd|secret|api[_-]?key|apikey|auth|sig|key)\s*[:=]\s*\S+/gi, "[redacted]"],
  // 邮箱地址（不依赖标记前缀，正文里出现即脱敏）。
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]"],
  [/\b[0-9a-f]{32,}\b/gi, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
  [/[A-Za-z]:\\\S*/g, "[path]"],
  [/(?:file|content):\/\/\S+/gi, "[path]"],
  [/\/(?:data|storage|system|proc|home|Users)\/\S*/g, "[path]"],
];

const MAX_MESSAGE_CHARS = 200;
const MAX_METADATA_VALUE_CHARS = 96;
const MAX_METADATA_KEYS = 8;
const MAX_KEY_CHARS = 32;

// metadata 键名本身就是凭据类别时（password/token/key/...），不能再把值当普通字符串处理：
// 无论值类型，统一落 [redacted]，与消息文本的凭据规则保持一致（原生 SafeLog.kt 同一张表）。
const SENSITIVE_METADATA_KEY =
  /^(?:authorization|token|password|passwd|secret|api[_-]?key|apikey|auth|sig|key)$/i;

export interface CreateSafeLogOptions {
  /** 原生 sink；null = 静默降级（只写内存缓冲）。 */
  sink?: SafeLogSink | null;
  now?: () => number;
  /** 内存缓冲上限（滚动丢弃最旧）。 */
  bufferLimit?: number;
  minLevel?: SafeLogLevel;
}

export interface SafeLog {
  trace(tag: string, message: string, metadata?: SafeLogMetadata): void;
  debug(tag: string, message: string, metadata?: SafeLogMetadata): void;
  info(tag: string, message: string, metadata?: SafeLogMetadata): void;
  warn(tag: string, message: string, metadata?: SafeLogMetadata): void;
  error(tag: string, message: string, metadata?: SafeLogMetadata): void;
  /** 调整级别阈值（默认 info）；传 "trace" 可放开全部级别。 */
  setMinLevel(level: SafeLogLevel): void;
  /** 当前内存缓冲快照（诊断导出/测试用）；不是原生文件的替代。 */
  getBuffer(): readonly SafeLogEntry[];
  /** 原生刷盘；true = 成功或原生不可用（无内容），false = 超时/失败。绝不 reject。 */
  flush(): Promise<boolean>;
}

export function createSafeLog(options: CreateSafeLogOptions = {}): SafeLog {
  const sink: SafeLogSink | null = options.sink ?? null;
  const now = options.now ?? (() => Date.now());
  const bufferLimit = Math.max(1, options.bufferLimit ?? 500);
  let minLevel = LEVEL_WEIGHT[options.minLevel ?? "info"];
  let buffer: SafeLogEntry[] = [];

  function redact(raw: string): string {
    let text = raw;
    for (const [pattern, replacement] of REDACT_RULES) {
      text = text.replace(pattern, replacement);
    }
    return text;
  }

  function sanitizeText(raw: string, maxChars: number): string {
    // 单行化 + 脱敏 + 截断：日志必须是单行、无正文、无路径、无凭据。
    const text = redact(String(raw).replace(/[\r\n\t]+/g, " ").trim());
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  function sanitizeMetadata(metadata: SafeLogMetadata | undefined): SafeLogMetadata | null {
    if (!metadata || typeof metadata !== "object") return null;
    const out: SafeLogMetadata = {};
    for (const [rawKey, rawValue] of Object.entries(metadata)) {
      if (rawValue === undefined) continue;
      const key = rawKey.slice(0, MAX_KEY_CHARS);
      // 截断后撞键的后续条目丢弃；被丢弃的非基本值也不占名额。
      if (Object.prototype.hasOwnProperty.call(out, key)) continue;
      if (Object.keys(out).length >= MAX_METADATA_KEYS) break;
      if (SENSITIVE_METADATA_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      if (typeof rawValue === "string") {
        out[key] = sanitizeText(rawValue, MAX_METADATA_VALUE_CHARS);
      } else if (typeof rawValue === "number") {
        // NaN/Infinity 序列化会变 null，会被误读成「清空」：直接归 null。
        out[key] = Number.isFinite(rawValue) ? rawValue : null;
      } else if (typeof rawValue === "boolean" || rawValue === null) {
        out[key] = rawValue;
      } else {
        // 数组/对象/函数/bigint/symbol：非最小化字段，丢弃。
        continue;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  function normalizeTag(rawTag: string): string {
    const slug = rawTag.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return slug.slice(0, 23) || "app";
  }

  function log(level: SafeLogLevel, rawTag: string, message: string, metadata?: SafeLogMetadata): void {
    try {
      if (LEVEL_WEIGHT[level] < minLevel) return;
      const entry: SafeLogEntry = {
        t: now(),
        level,
        tag: normalizeTag(rawTag),
        message: sanitizeText(message, MAX_MESSAGE_CHARS),
        metadata: sanitizeMetadata(metadata),
      };
      buffer.push(entry);
      if (buffer.length > bufferLimit) {
        buffer = buffer.slice(buffer.length - bufferLimit);
      }
      try {
        sink?.write(level, entry.tag, entry.message, entry.metadata ? JSON.stringify(entry.metadata) : null);
      } catch {
        // 原生桥异常（模块缺失/桥接崩溃）：静默降级为仅内存缓冲，绝不影响业务。
      }
    } catch {
      // 日志基础设施自身的任何异常都不允许上抛：SafeLog 永不抛错。
    }
  }

  return {
    trace: (tag, message, metadata) => log("trace", tag, message, metadata),
    debug: (tag, message, metadata) => log("debug", tag, message, metadata),
    info: (tag, message, metadata) => log("info", tag, message, metadata),
    warn: (tag, message, metadata) => log("warn", tag, message, metadata),
    error: (tag, message, metadata) => log("error", tag, message, metadata),
    setMinLevel(level) {
      minLevel = LEVEL_WEIGHT[level];
    },
    getBuffer() {
      return buffer;
    },
    async flush() {
      try {
        if (!sink) return true;
        await sink.flush();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * 生产单例：sink 懒解析本地原生模块 modules/logger（不可用/未注册时静默降级）。
 * 原生模块的注册可能晚于 JS 首次加载，不能把模块单例固化在模块顶层；每次写日志
 * 重新 get 一次，模块可用后自动接管。OnCreate 仍负责安装 CrashHandler 与文件 sink。
 */
const lazyNativeSink: SafeLogSink = {
  write(level, tag, message, metadataJson) {
    getTaskDockLogger()?.write(level, tag, message, metadataJson);
  },
  async flush() {
    const native = getTaskDockLogger();
    if (!native) return true;
    return native.flush();
  },
};

export const safeLog: SafeLog = createSafeLog({
  sink: lazyNativeSink,
});

/** 判定原生 sink 是否可用（诊断/测试辅助；不可用时 flush 恒为 true）。 */
export const safeLogNativeAvailable = getTaskDockLogger() != null;
