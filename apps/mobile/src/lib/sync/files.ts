// 文件互传 v1 客户端：列表、创建上传、分块上传/下载、完成与删除。
//
// 与同步协议共用同一把设备密钥与加密信封；每个分块的 AAD 绑定
// 「方法 + /v1/files/{id}/chunk/{index}」，把密文换到别的文件/序号会解密失败。
// 本文件不读写本地文件系统：分块字节由调用方（fileIo.ts）提供/消费，
// 便于在无原生模块的环境里单独验证协议与重试逻辑。
//
// 传输默认走本地安全通道（secureFetch + 已配对连接里的 SPKI 指纹）：
// fetchImpl 缺省时惰性读取连接元数据（首请求时解析，之后缓存），
// 测试可注入纯内存 fetchImpl，不触网也不读库。

import { decodeBase64, encodeBase64 } from "tweetnacl-util";

import { AppError, describeError, isAppError, toAppError } from "../errors";

import { loadConnection } from "../../db/syncConnection";

import { decryptEnvelope, encryptEnvelope } from "./crypto";
import type { FetchLike, FetchInitLike, HttpResponseLike } from "./client";
import { normalizeTlsFingerprint } from "./pairing";
import { createLazyPinnedFetch } from "./secureFetch";
import {
  createCancelledError,
  FileHttpError,
  FILE_CANCELLED_MESSAGE,
  isAutoRetryableTransferFailure,
  isFileCancelled,
} from "./transferError";

/** 传输类请求（创建/分块上传/分块下载/完成/删除）保持原有 30s × 3 次语义。 */
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [600, 1_500, 3_000] as const;
const MAX_RETRIES = 3;

/**
 * 列表读取是只读探测：桌面端未运行时必须快速失败，落到页内错误态与重试入口，
 * 不能跟着传输类请求一起等 30s。独立于 REQUEST_TIMEOUT_MS，不要复用。
 */
const LIST_TIMEOUT_MS = 9_000;
/** 列表读取最多自动重试 1 次；TLS/授权/参数类不可重试错误按分类直接停止。 */
const LIST_MAX_RETRIES = 1;

export const AAD_FILES_LIST = "taskdock-sync-v1|GET|/v1/files";
export const AAD_FILE_CREATE = "taskdock-sync-v1|POST|/v1/files";

export function aadFileChunk(method: "GET" | "POST", id: string, index: number): string {
  return `taskdock-sync-v1|${method}|/v1/files/${id}/chunk/${index}`;
}

export function aadFileComplete(id: string): string {
  return `taskdock-sync-v1|POST|/v1/files/${id}/complete`;
}

export function aadFileDelete(id: string): string {
  return `taskdock-sync-v1|POST|/v1/files/${id}/delete`;
}

/** 导入暂存架：与服务端 files::aad_file_shelf 完全一致（跨文件重放会解密失败）。 */
export function aadFileShelf(id: string): string {
  return `taskdock-sync-v1|POST|/v1/files/${id}/shelf`;
}

/** 与服务端 files::AAD_SHELF_GROUPS 一致。 */
export const AAD_SHELF_GROUPS = "taskdock-sync-v1|GET|/v1/shelf/groups";

export type RemoteFileDirection = "to_phone" | "to_desktop";
export type RemoteFileStatus = "pending" | "ready" | "failed";

export interface RemoteFile {
  id: string;  direction: RemoteFileDirection;
  name: string;
  size: number;
  sha256: string;
  status: RemoteFileStatus;
  chunk_size: number;
  chunks: number;
  received_chunks: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** v51 桌面端：导入暂存架后的条目 ID；老桌面端不返回该字段（null）。 */
  shelf_item_id?: string | null;
  shelf_imported_at?: string | null;
  shelf_group_id?: string | null;
}

/** 桌面暂存分组（只读）：手机端只用来展示与回传 id。 */
export interface RemoteShelfGroup {
  id: string;
  name: string;
  builtin: boolean;
}

export interface FileClientOptions {
  baseUrl: string;
  token: string;
  /** deriveSyncKey(token) 的结果；长度必须是 32 */
  syncKey: Uint8Array;
  fetchImpl?: FetchLike;
  /** 列表读取超时（毫秒）；默认 9s，独立于传输类 30s 超时。 */
  listTimeoutMs?: number;
  /** 列表读取自动重试次数（首次尝试之外）；默认 1。 */
  listMaxRetries?: number;
}

export interface FileClient {
  list(): Promise<RemoteFile[]>;
  create(name: string, size: number): Promise<RemoteFile>;
  uploadChunk(id: string, index: number, bytes: Uint8Array): Promise<RemoteFile>;
  complete(id: string): Promise<RemoteFile>;
  downloadChunk(id: string, index: number): Promise<Uint8Array>;
  remove(id: string): Promise<void>;
  /** 把已完成的手机上传以托管副本导入桌面暂存架（v51；老桌面端返回 404）。 */
  importToShelf(id: string, groupId?: string | null): Promise<RemoteFile>;
  /** 桌面端有效暂存分组（老桌面端 404 时调用方退回默认分组）。 */
  shelfGroups(): Promise<RemoteShelfGroup[]>;
  /** 取消所有在途请求；取消后客户端仍可继续发起新请求（与同步客户端一致） */
  cancel(): void;
  /** 只取消在途的列表读取；上传/下载等分块请求不受影响。 */
  cancelList(): void;
}

interface ActiveOperation {
  kind: "list" | "transfer";
  cancelled: boolean;
  controller: AbortController | null;
}

function cancelledError(): AppError {
  return createCancelledError();
}

/** 取消语义、HTTP 错误类型与分类统一放在 transferError.ts，这里只保留兼容导出。 */
export { FILE_CANCELLED_MESSAGE, isFileCancelled };
export { FileHttpError, isFileHttpError } from "./transferError";

/**
 * 从错误响应里取桌面端业务码（`{"error":"unauthorized","message":"..."}`）。
 *
 * 错误响应是明文 JSON（与成功响应的加密信封不同），只取 `error` 字段；
 * 解析失败/非 JSON 不影响分类——HTTP 状态码本身就是可靠信号。
 */
async function readErrorCode(response: HttpResponseLike): Promise<string | null> {
  try {
    const body = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    const code = (body as Record<string, unknown>).error;
    return typeof code === "string" && code.trim() && code.length <= 64 ? code : null;
  } catch {
    return null;
  }
}

function isRetryable(error: unknown): boolean {
  // 自动重试规则只在 transferError 维护；这里不再保留第二份状态码白名单。
  return isAutoRetryableTransferFailure(error);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseRemoteFile(value: unknown): RemoteFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation", "文件记录不是对象");
  }
  const record = value as Record<string, unknown>;
  const direction = record.direction;
  const status = record.status;
  if (
    typeof record.id !== "string" ||
    record.id.length !== 32 ||
    (direction !== "to_phone" && direction !== "to_desktop") ||
    (status !== "pending" && status !== "ready" && status !== "failed") ||
    typeof record.name !== "string" ||
    !record.name ||
    !isFiniteNumber(record.size) ||
    typeof record.sha256 !== "string" ||
    !isFiniteNumber(record.chunk_size) ||
    !isFiniteNumber(record.chunks) ||
    !isFiniteNumber(record.received_chunks) ||
    typeof record.created_at !== "string" ||
    typeof record.updated_at !== "string"
  ) {
    throw new AppError("validation", "文件记录字段不完整或类型错误");
  }
  return {
    id: record.id,
    direction,
    name: record.name,
    size: record.size,
    sha256: record.sha256,
    status,
    chunk_size: record.chunk_size,
    chunks: record.chunks,
    received_chunks: record.received_chunks,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: typeof record.completed_at === "string" ? record.completed_at : null,
    // v51 字段的三种语义必须区分：
    // - 字段缺失：老桌面端，不能据此认为用户删除了暂存架条目；
    // - 显式 null：新桌面端明确表示当前没有有效 shelf 引用（删除/未导入）；
    // - 字符串：真实 ShelfItem.id。
    ...(Object.prototype.hasOwnProperty.call(record, "shelf_item_id")
      ? {
          shelf_item_id:
            typeof record.shelf_item_id === "string" ? record.shelf_item_id : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "shelf_imported_at")
      ? {
          shelf_imported_at:
            typeof record.shelf_imported_at === "string" ? record.shelf_imported_at : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "shelf_group_id")
      ? {
          shelf_group_id:
            typeof record.shelf_group_id === "string" ? record.shelf_group_id : null,
        }
      : {}),
  };
}

function parseFilePayload(value: unknown): RemoteFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation", "文件响应不是对象");
  }
  return parseRemoteFile((value as Record<string, unknown>).file);
}

function parseListPayload(value: unknown): RemoteFile[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation", "文件列表响应不是对象");
  }
  const files = (value as Record<string, unknown>).files;
  if (!Array.isArray(files)) {
    throw new AppError("validation", "文件列表响应缺少 files");
  }
  return files.map(parseRemoteFile);
}

function parseShelfGroups(value: unknown): RemoteShelfGroup[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation", "暂存分组响应不是对象");
  }
  const groups = (value as Record<string, unknown>).groups;
  if (!Array.isArray(groups)) {
    throw new AppError("validation", "暂存分组响应缺少 groups");
  }
  return groups.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AppError("validation", "暂存分组成员不是对象");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || typeof record.name !== "string") {
      throw new AppError("validation", "暂存分组成员字段不完整");
    }
    return {
      id: record.id,
      name: record.name,
      builtin: record.builtin === true,
    };
  });
}

/** 列表读取失败后的页内错误分类：决定落哪种持久错误态与操作入口。 */
export type ListErrorKind = "offline" | "repair" | "unpaired";

export interface ListErrorState {
  kind: ListErrorKind;
  message: string;
  /** true = 安全/授权类失败，普通重试无法恢复，必须走「重新配对」。 */
  needsRepair: boolean;
}

/** 安全校验类错误码：与 transferError 的分类口径一致，这里只做列表页路由。 */
const REPAIR_CODES = new Set(["tls_pin_mismatch", "tls_handshake", "insecure_transport"]);

/**
 * 把列表读取异常收敛成页内错误态。只依赖结构化信号（AppError code/kind、
 * HTTP 状态码），不匹配中文文案；分类规则仍以 transferError.ts 为准。
 */
export function classifyListError(error: unknown): ListErrorState {
  if (isAppError(error)) {
    const code = error.code ?? "";
    if (REPAIR_CODES.has(code)) {
      return { kind: "repair", needsRepair: true, message: describeError(error) };
    }
    if (code === "not_paired") {
      return { kind: "unpaired", needsRepair: false, message: "尚未配对，请先与桌面端配对" };
    }
    if (code === "request_timeout") {
      return {
        kind: "offline",
        needsRepair: false,
        message: "请求超时（桌面端可能未启动）",
      };
    }
    if (error.kind === "network") {
      return {
        kind: "offline",
        needsRepair: false,
        message:
          describeError(error) || "桌面端暂时不可达，请检查电脑是否已启动并处于同一局域网",
      };
    }
    // validation/其他本地错误：不可自动重试，落到离线错误态展示原文。
    return { kind: "offline", needsRepair: false, message: describeError(error) };
  }
  if (error instanceof FileHttpError) {
    if (error.status === 401 || error.status === 403) {
      return {
        kind: "repair",
        needsRepair: true,
        message: "设备令牌已失效或已被桌面端撤销，请重新扫码配对",
      };
    }
    return {
      kind: "offline",
      needsRepair: false,
      message: `桌面端响应异常（HTTP ${error.status}），请稍后重试`,
    };
  }
  return {
    kind: "offline",
    needsRepair: false,
    message: describeError(error) || "连接失败，请稍后重试",
  };
}

/**
 * 列表读取并发护栏：记录当前在途列表读取的序号。
 * 新一次刷新开始后，旧序号的响应/错误必须忽略；dispose 后全部过期。
 * 只做序号记账，不触碰传输类请求。
 */
export interface ListRunTracker {
  /** 开始一次新的列表读取，返回本次序号。 */
  begin(): number;
  /** 该序号是否已过期（被更新的刷新取代或已卸载）。 */
  stale(run: number): boolean;
  /** 页面卸载：标记全部序号过期。 */
  dispose(): void;
}

export function createListRunTracker(): ListRunTracker {
  let seq = 0;
  let disposed = false;
  return {
    begin() {
      seq += 1;
      return seq;
    },
    stale(run: number) {
      return disposed || run !== seq;
    },
    dispose() {
      disposed = true;
      seq += 1;
    },
  };
}

export function createFileClient(options: FileClientOptions): FileClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new AppError("validation", "同步服务地址不能为空");
  if (!options.token) throw new AppError("validation", "同步令牌不能为空");
  if (options.syncKey.length !== 32) {
    throw new AppError("validation", "文件传输密钥长度错误");
  }

  const listTimeoutMs =
    Number.isFinite(options.listTimeoutMs) && (options.listTimeoutMs as number) > 0
      ? (options.listTimeoutMs as number)
      : LIST_TIMEOUT_MS;
  const listMaxRetries =
    Number.isInteger(options.listMaxRetries) && (options.listMaxRetries as number) >= 0
      ? (options.listMaxRetries as number)
      : LIST_MAX_RETRIES;

  const fetchImpl: FetchLike =
    options.fetchImpl ??
    createLazyPinnedFetch(async () => {
      // 文件分块携带设备令牌：与同步一致，已配对连接必须有已钉住的 SPKI 指纹，
      // 缺失时 fail-closed（拒绝以首用信任发令牌），提示重新配对。
      const connection = await loadConnection();
      const pin = normalizeTlsFingerprint(connection?.tlsFingerprint ?? "");
      if (!pin) {
        throw new AppError("validation", "缺少桌面端 TLS 指纹，请重新扫码配对后再传文件");
      }
      return pin;
    });
  const active = new Set<ActiveOperation>();

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function attempt(
    operation: ActiveOperation,
    method: "GET" | "POST",
    path: string,
    aad: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (operation.cancelled) throw cancelledError();

    const controller = new AbortController();
    operation.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const init: FetchInitLike = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.token}`,
      },
      signal: controller.signal,
    };
    if (payload !== undefined) {
      init.body = JSON.stringify(encryptEnvelope(options.syncKey, aad, payload));
      init.headers = { ...init.headers, "Content-Type": "application/json" };
    }

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, init);
      if (!response.ok) throw new FileHttpError(response.status, await readErrorCode(response));
      const body = await response.json();
      return decryptEnvelope(options.syncKey, aad, body);
    } catch (error) {
      if (operation.cancelled) throw cancelledError();
      // 超时是本端计时器触发的 abort，不是用户取消：带上 code 让上层分类为可重试。
      if (timedOut) {
        throw new AppError(
          "network",
          `文件请求超时（${Math.round(timeoutMs / 1_000)}s）`,
          error,
          "request_timeout",
        );
      }
      if (error instanceof FileHttpError) throw error;
      throw toAppError(error, "network");
    } finally {
      clearTimeout(timer);
      if (operation.controller === controller) operation.controller = null;
    }
  }

  interface RequestConfig {
    kind: "list" | "transfer";
    timeoutMs: number;
    maxRetries: number;
  }

  async function request(
    method: "GET" | "POST",
    path: string,
    aad: string,
    payload: unknown,
    config: RequestConfig,
  ): Promise<unknown> {
    const operation: ActiveOperation = {
      kind: config.kind,
      cancelled: false,
      controller: null,
    };
    active.add(operation);
    try {
      let lastError: unknown = null;
      for (let attemptIndex = 0; attemptIndex <= config.maxRetries; attemptIndex += 1) {
        if (operation.cancelled) throw cancelledError();
        try {
          return await attempt(operation, method, path, aad, payload, config.timeoutMs);
        } catch (error) {
          lastError = error;
          if (operation.cancelled) throw cancelledError();
          if (attemptIndex >= config.maxRetries || !isRetryable(error)) break;
          const delay =
            RETRY_DELAYS_MS[Math.min(attemptIndex, RETRY_DELAYS_MS.length - 1)];
          await sleep(delay);
        }
      }
      // 保留 HTTP 层错误对象：状态码/业务码是上层分类的唯一可靠依据，
      // 包成 AppError("network") 会让 401/404 全部退化成「电脑不可达」。
      if (isAppError(lastError) || lastError instanceof FileHttpError) throw lastError;
      throw toAppError(lastError, "network");
    } finally {
      active.delete(operation);
    }
  }

  /** 传输类请求配置：30s × 3 次，大文件传输与取消行为不变。 */
  const transferConfig: RequestConfig = {
    kind: "transfer",
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  };
  /** 列表读取与只读分组探测配置：9s × 1 次，独立快速失败。 */
  const listConfig: RequestConfig = {
    kind: "list",
    timeoutMs: listTimeoutMs,
    maxRetries: listMaxRetries,
  };

  function list(): Promise<RemoteFile[]> {
    return request("GET", "/v1/files", AAD_FILES_LIST, undefined, listConfig).then(
      parseListPayload,
    );
  }

  function create(name: string, size: number): Promise<RemoteFile> {
    if (!name.trim()) throw new AppError("validation", "文件名不能为空");
    if (!Number.isInteger(size) || size <= 0) {
      throw new AppError("validation", "文件大小不合法");
    }
    return request("POST", "/v1/files", AAD_FILE_CREATE, { name, size }, transferConfig).then(
      parseFilePayload,
    );
  }

  function uploadChunk(id: string, index: number, bytes: Uint8Array): Promise<RemoteFile> {
    const aad = aadFileChunk("POST", id, index);
    return request("POST", `/v1/files/${id}/chunk/${index}`, aad, {
      data: encodeBase64(bytes),
    }, transferConfig).then(parseFilePayload);
  }

  function complete(id: string): Promise<RemoteFile> {
    return request("POST", `/v1/files/${id}/complete`, aadFileComplete(id), {}, transferConfig).then(
      parseFilePayload,
    );
  }

  async function downloadChunk(id: string, index: number): Promise<Uint8Array> {
    const aad = aadFileChunk("GET", id, index);
    const data = await request("GET", `/v1/files/${id}/chunk/${index}`, aad, undefined, transferConfig);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new AppError("validation", "文件分块响应不是对象");
    }
    const record = data as Record<string, unknown>;
    if (record.index !== index || typeof record.data !== "string") {
      throw new AppError("validation", "文件分块响应字段不完整");
    }
    return decodeBase64(record.data);
  }

  function remove(id: string): Promise<void> {
    return request("POST", `/v1/files/${id}/delete`, aadFileDelete(id), {}, transferConfig).then((data) => {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new AppError("validation", "文件删除响应不是对象");
      }
      if ((data as Record<string, unknown>).deleted !== true) {
        throw new AppError("validation", "文件删除未生效");
      }
    });
  }

  /**
   * 导入暂存架。
   *
   * 404 有二义性：旧桌面端根本没有该路由，或传输记录已被删除/不属于本设备。
   * 只有错误路径才多用一次只读探测（GET /v1/shelf/groups）：
   * - 探测也 404 → 明确是「版本不支持」，上层提示升级而不是「记录不存在」；
   * - 探测给出 401/403/TLS → 用更具体的原因覆盖 404（授权问题优先暴露）；
   * - 探测成功 → 说明接口存在，404 就是记录本身的问题。
   */
  async function importToShelf(id: string, groupId?: string | null): Promise<RemoteFile> {
    try {
      const data = await request("POST", `/v1/files/${id}/shelf`, aadFileShelf(id), {
        group_id: groupId ?? null,
      }, transferConfig);
      return parseFilePayload(data);
    } catch (error) {
      if (error instanceof FileHttpError && error.status === 404) {
        try {
          await shelfGroups();
        } catch (probeError) {
          if (probeError instanceof FileHttpError && probeError.status === 404) {
            throw new FileHttpError(404, "not_supported");
          }
          throw probeError;
        }
        // 分组接口存在且可访问：说明暂存架能力可用，原始 404 不是版本问题。
        throw new FileHttpError(404, "not_found");
      }
      throw error;
    }
  }

  // 只读分组探测与列表同轨：桌面端离线时快速失败，不跟着传输类请求等 30s × 3。
  // 写操作（importToShelf 的 POST）仍走 transferConfig。
  function shelfGroups(): Promise<RemoteShelfGroup[]> {
    return request("GET", "/v1/shelf/groups", AAD_SHELF_GROUPS, undefined, listConfig).then(
      parseShelfGroups,
    );
  }

  function cancel(): void {
    for (const operation of active) {
      operation.cancelled = true;
      operation.controller?.abort();
    }
    active.clear();
  }

  function cancelList(): void {
    for (const operation of active) {
      if (operation.kind !== "list") continue;
      operation.cancelled = true;
      operation.controller?.abort();
    }
  }

  return {
    list,
    create,
    uploadChunk,
    complete,
    downloadChunk,
    remove,
    importToShelf,
    shelfGroups,
    cancel,
    cancelList,
  };
}
