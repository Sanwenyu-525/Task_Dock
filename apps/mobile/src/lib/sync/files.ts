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

import { AppError, isAppError, toAppError } from "../errors";

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

/** 分块请求可能比同步 JSON 慢，但仍需有界；超时后按退避重试。 */
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [600, 1_500, 3_000] as const;
const MAX_RETRIES = 3;

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
}

interface ActiveOperation {
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
    shelf_item_id: typeof record.shelf_item_id === "string" ? record.shelf_item_id : null,
    shelf_imported_at:
      typeof record.shelf_imported_at === "string" ? record.shelf_imported_at : null,
    shelf_group_id: typeof record.shelf_group_id === "string" ? record.shelf_group_id : null,
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

export function createFileClient(options: FileClientOptions): FileClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new AppError("validation", "同步服务地址不能为空");
  if (!options.token) throw new AppError("validation", "同步令牌不能为空");
  if (options.syncKey.length !== 32) {
    throw new AppError("validation", "文件传输密钥长度错误");
  }

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
  ): Promise<unknown> {
    if (operation.cancelled) throw cancelledError();

    const controller = new AbortController();
    operation.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

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
        throw new AppError("network", "文件请求超时（30s）", error, "request_timeout");
      }
      if (error instanceof FileHttpError) throw error;
      throw toAppError(error, "network");
    } finally {
      clearTimeout(timer);
      if (operation.controller === controller) operation.controller = null;
    }
  }

  async function request(
    method: "GET" | "POST",
    path: string,
    aad: string,
    payload: unknown,
  ): Promise<unknown> {
    const operation: ActiveOperation = { cancelled: false, controller: null };
    active.add(operation);
    try {
      let lastError: unknown = null;
      for (let attemptIndex = 0; attemptIndex <= MAX_RETRIES; attemptIndex += 1) {
        if (operation.cancelled) throw cancelledError();
        try {
          return await attempt(operation, method, path, aad, payload);
        } catch (error) {
          lastError = error;
          if (operation.cancelled) throw cancelledError();
          if (attemptIndex >= MAX_RETRIES || !isRetryable(error)) break;
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

  function list(): Promise<RemoteFile[]> {
    return request("GET", "/v1/files", AAD_FILES_LIST, undefined).then(parseListPayload);
  }

  function create(name: string, size: number): Promise<RemoteFile> {
    if (!name.trim()) throw new AppError("validation", "文件名不能为空");
    if (!Number.isInteger(size) || size <= 0) {
      throw new AppError("validation", "文件大小不合法");
    }
    return request("POST", "/v1/files", AAD_FILE_CREATE, { name, size }).then(
      parseFilePayload,
    );
  }

  function uploadChunk(id: string, index: number, bytes: Uint8Array): Promise<RemoteFile> {
    const aad = aadFileChunk("POST", id, index);
    return request("POST", `/v1/files/${id}/chunk/${index}`, aad, {
      data: encodeBase64(bytes),
    }).then(parseFilePayload);
  }

  function complete(id: string): Promise<RemoteFile> {
    return request("POST", `/v1/files/${id}/complete`, aadFileComplete(id), {}).then(
      parseFilePayload,
    );
  }

  async function downloadChunk(id: string, index: number): Promise<Uint8Array> {
    const aad = aadFileChunk("GET", id, index);
    const data = await request("GET", `/v1/files/${id}/chunk/${index}`, aad, undefined);
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
    return request("POST", `/v1/files/${id}/delete`, aadFileDelete(id), {}).then((data) => {
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
      });
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

  function shelfGroups(): Promise<RemoteShelfGroup[]> {
    return request("GET", "/v1/shelf/groups", AAD_SHELF_GROUPS, undefined).then(parseShelfGroups);
  }

  function cancel(): void {
    for (const operation of active) {
      operation.cancelled = true;
      operation.controller?.abort();
    }
    active.clear();
  }

  return { list, create, uploadChunk, complete, downloadChunk, remove, importToShelf, shelfGroups, cancel };
}
