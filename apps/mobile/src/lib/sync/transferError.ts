// 文件传输的统一错误分类（P0-01）。
//
// 为什么必须集中在这里：
// - 上传前预检（GET /v1/files）与正式分块上传/暂存架导入必须用同一套判定，
//   否则「预检说离线、上传说授权失败」会互相矛盾；
// - 分类只能依赖**结构化信号**：HTTP 状态码、桌面端 JSON 里的 `error` 业务码、
//   原生模块的 `error.code`、AppError 的 kind/code。禁止匹配中文文案
//   （文案随版本变化，猜错会把「令牌被撤销」当成「电脑没开」而无限重试）。
//
// 判定结果直接决定三件事：
// 1) pending（保留可重试）还是 failed（停止并提示用户）；
// 2) 是否允许自动/手动重试；
// 3) 是否必须中止整批（授权/Safety 类错误继续发下一张只会产生更多误判）。

import { AppError, describeError, isAppError } from "../errors";

/** 文件传输被用户取消的稳定文案（与 isFileCancelled 配套，仅用于本地自造错误）。 */
export const FILE_CANCELLED_MESSAGE = "文件传输已取消";

export function createCancelledError(): AppError {
  return new AppError("network", FILE_CANCELLED_MESSAGE, undefined, "cancelled");
}

/**
 * 是否为「用户取消」。
 *
 * 兼容两种来源：新代码带 code=cancelled；旧调用点/测试构造的无 code 错误
 * 仍按固定哨兵文案识别（这是本模块自己产生的常量，不是对远端文案的猜测）。
 */
export function isFileCancelled(error: unknown): boolean {
  if (!isAppError(error)) return false;
  if (error.code === "cancelled") return true;
  return error.kind === "network" && error.message === FILE_CANCELLED_MESSAGE;
}

/** HTTP 层失败：保留真实状态码与桌面端业务错误码（不吞成一句「网络错误」）。 */
export class FileHttpError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null = null) {
    super(`文件请求失败：HTTP ${status}${code ? `（${code}）` : ""}`);
    this.name = "FileHttpError";
    this.status = status;
    this.code = code;
  }
}

export function isFileHttpError(value: unknown): value is FileHttpError {
  return value instanceof FileHttpError;
}

export type TransferFailureKind =
  | "cancelled"
  | "offline"
  | "timeout"
  | "server"
  | "rate_limited"
  | "auth"
  | "forbidden"
  | "not_supported"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "tls"
  | "insecure"
  | "local"
  | "unknown";

export interface TransferFailure {
  kind: TransferFailureKind;
  /** true = 电脑端/网络暂时不可用，目的地保持 pending，允许稍后重试。 */
  pending: boolean;
  /** true = 同一请求可以再试（服务端临时故障/限流/超时）。 */
  retryable: boolean;
  /** true = 本批次剩余文件必须停止：继续发只会重复失败或扩大安全问题。 */
  stopsBatch: boolean;
  status?: number;
  /** 桌面端 `error` 字段业务码（unauthorized / conflict / not_found / invalid_request…）。 */
  code?: string;
  message: string;
}

/** 用于 UI/数据库 last_error 的用户可读文案（分类决定，不拼远端原文前的兜底）。 */
export function transferFailureMessage(failure: TransferFailure): string {
  switch (failure.kind) {
    case "auth":
      return "设备令牌已失效或已被桌面端撤销，请重新扫码配对后再发送";
    case "forbidden":
      return "桌面端拒绝了本次请求（授权不足），请检查设备授权状态";
    case "not_supported":
      return "桌面端版本较低，不支持该接口；请升级桌面端后重试（文件仍保留在本机）";
    case "not_found":
      return "桌面端找不到该文件记录（可能已被删除或不属于当前设备），请重新发送文件后再导入暂存架";
    case "tls":
      return "与桌面端的安全校验失败（证书指纹不匹配或 TLS 握手失败），已停止发送；请重新扫码配对";
    case "insecure":
      return "桌面端连接必须使用 HTTPS（TLS v2），已拒绝发送；请重新扫码配对";
    case "rate_limited":
      return "桌面端请求过于频繁，稍后会自动/手动重试";
    case "server":
      return "桌面端暂时处理失败（服务端错误），文件保留在本机，可稍后重试";
    case "conflict":
      return "桌面端当前状态冲突（并发上传过多或传输已结束），请稍后重试";
    case "invalid_request":
      return "请求参数不被桌面端接受，请勿重复发送同一请求";
    case "timeout":
      return "请求超时，文件保留在本机，可稍后重试";
    case "offline":
      return "电脑端暂时不可达（未开机或不在同一网络），文件保留在本机，可稍后重试";
    case "cancelled":
      return FILE_CANCELLED_MESSAGE;
    case "local":
      return failure.message;
    default:
      return failure.message || "文件传输失败";
  }
}

export type TransferEndpoint =
  | "list"
  | "create"
  | "upload"
  | "chunk"
  | "complete"
  | "shelf"
  | "groups"
  | "delete";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function failure(
  kind: TransferFailureKind,
  options: {
    pending?: boolean;
    retryable?: boolean;
    stopsBatch?: boolean;
    status?: number;
    code?: string;
    message: string;
  },
): TransferFailure {
  const base: TransferFailure = {
    kind,
    pending: options.pending ?? false,
    retryable: options.retryable ?? false,
    stopsBatch: options.stopsBatch ?? false,
    message: options.message,
  };
  if (options.status !== undefined) base.status = options.status;
  if (options.code !== undefined) base.code = options.code;
  return base;
}

function fromStatus(status: number, code: string | null, endpoint?: TransferEndpoint): TransferFailure {
  const detail = `HTTP ${status}${code ? ` / ${code}` : ""}`;
  if (status === 401) {
    return failure("auth", {
      status,
      code: code ?? undefined,
      stopsBatch: true,
      message: `设备未授权（${detail}）：令牌已失效或设备已被撤销`,
    });
  }
  if (status === 403) {
    return failure("forbidden", {
      status,
      code: code ?? undefined,
      stopsBatch: true,
      message: `桌面端拒绝访问（${detail}）`,
    });
  }
  if (status === 404) {
    // files.ts 在 shelf 404 时探测 GET /v1/shelf/groups：
    // - 探测也 404 → 能力不存在，标 not_supported；
    // - 探测成功 → 原 404 是记录不存在/无权访问，标 not_found。
    // 不能只看 endpoint 就把所有 shelf 404 都判成「桌面端版本过低」。
    if (code === "not_found") {
      return failure("not_found", {
        status,
        code,
        message: `桌面端找不到该文件记录（${detail}）`,
      });
    }
    const capability = endpoint === "shelf" || endpoint === "groups";
    return failure("not_supported", {
      status,
      code: code ?? undefined,
      // 能力接口缺失只影响该目的地（上传本身已成功），不终止整批；
      // 基础接口（list/create）缺失说明桌面端协议不兼容，必须停。
      stopsBatch: !capability,
      message: capability
        ? "桌面端不支持该功能（版本过低）"
        : `桌面端接口不存在（${detail}），请升级桌面端`,
    });
  }
  if (status === 405 || status === 501) {
    const capability = endpoint === "shelf" || endpoint === "groups";
    return failure("not_supported", {
      status,
      code: code ?? undefined,
      stopsBatch: !capability,
      message: capability
        ? "桌面端不支持该功能（版本过低）"
        : `桌面端接口不存在（${detail}），请升级桌面端`,
    });
  }
  if (status === 409) {
    return failure("conflict", {
      status,
      code: code ?? undefined,
      pending: true,
      // 409 是状态冲突，不应立即自动重复；保留 pending 等用户手动重试。
      retryable: false,
      message: `桌面端状态冲突（${detail}）`,
    });
  }
  if (status === 429) {
    return failure("rate_limited", {
      status,
      code: code ?? undefined,
      pending: true,
      retryable: true,
      message: `桌面端限流（${detail}）`,
    });
  }
  if (status === 408) {
    return failure("timeout", {
      status,
      code: code ?? undefined,
      pending: true,
      retryable: true,
      message: `桌面端读取请求超时（${detail}）`,
    });
  }
  if (status >= 500) {
    return failure("server", {
      status,
      code: code ?? undefined,
      pending: true,
      retryable: RETRYABLE_STATUS.has(status),
      message: `桌面端服务端错误（${detail}）`,
    });
  }
  return failure("invalid_request", {
    status,
    code: code ?? undefined,
    message: `桌面端不接受该请求（${detail}），请勿自动重复`,
  });
}

/**
 * 把任意异常收敛成可判定的失败描述。
 *
 * 优先级：取消 > HTTP 状态 > 结构化 AppError code > kind 兜底。
 */
export function classifyTransferFailure(
  error: unknown,
  options: { endpoint?: TransferEndpoint } = {},
): TransferFailure {
  if (isFileCancelled(error)) {
    return failure("cancelled", { message: FILE_CANCELLED_MESSAGE });
  }
  if (isFileHttpError(error)) {
    return fromStatus(error.status, error.code, options.endpoint);
  }
  if (isAppError(error)) {
    switch (error.code) {
      case "tls_pin_mismatch":
      case "tls_handshake":
        return failure("tls", { stopsBatch: true, message: "与桌面端的 TLS 安全校验失败" });
      case "insecure_transport":
        return failure("insecure", { stopsBatch: true, message: "拒绝使用非 HTTPS 通道" });
      case "request_timeout":
        return failure("timeout", {
          pending: true,
          retryable: true,
          message: "请求超时",
        });
      case "not_supported":
        return failure("not_supported", { message: "桌面端不支持该功能" });
      case "invalid_response":
        // 服务端返回 2xx 但缺少必要字段（例如 shelf_item_id）：按不可重试的协议
        // 错误处理，保留原始说明，不能因此把已完成的 desktop 回滚或写成 done。
        return failure("unknown", { message: describeError(error) });
      case "unknown":
        // 原生/通道未知异常：既不是明确的离线，也不是可判定业务错误。
        // 保持 failed 且不自动重试，避免把安全/协议问题掩盖成「等电脑」。
        return failure("unknown", { message: describeError(error) });
      default:
        break;
    }
    // 网络类但没有 TLS 语义：可能是电脑关闭、掉 Wi-Fi、DNS/路由失败。
    if (error.kind === "network") {
      return failure("offline", {
        pending: true,
        retryable: true,
        message: describeError(error),
      });
    }
    if (error.kind === "storage") {
      return failure("local", { message: describeError(error) });
    }
    return failure("invalid_request", { message: describeError(error) });
  }
  return failure("unknown", { message: describeError(error) || "未知错误" });
}

/**
 * 自动重试的唯一事实来源（files.ts 只能调用这里，不得再维护状态码白名单）。
 *
 * 注意：409 虽然保持 pending，但属于「需要先核对远端状态」的冲突，不自动重复；
 * 401/403/404/TLS/参数错误一律不自动重试。网络连接类错误才可自动重试。
 */
export function isAutoRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function isAutoRetryableTransferFailure(error: unknown): boolean {
  return classifyTransferFailure(error).retryable;
}

/**
 * 可重用的远端记录匹配键。
 *
 * 只认「本设备已就绪的 to_desktop 记录」：桌面端 `list` 已按设备过滤，
 * 因此这里不再重复校验设备归属。sha256 已知时忽略文件名（桌面端会把
 * `< > : " | ? *` 等字符清洗成 `_`，名字比对会因清洗规则漂移而失效）。
 */
export function reusableRemoteKey(input: {
  name: string;
  size: number;
  sha256?: string | null;
}): { withHash: string | null; byName: string } {
  const byName = `${input.name}\u0000${input.size}`;
  const withHash = input.sha256 ? `${input.sha256.trim().toLowerCase()}\u0000${input.size}` : null;
  return { withHash, byName };
}
