// 文件互传 v1 客户端：列表、创建上传、分块上传/下载、完成与删除。
//
// 与同步协议共用同一把设备密钥与加密信封；每个分块的 AAD 绑定
// 「方法 + /v1/files/{id}/chunk/{index}」，把密文换到别的文件/序号会解密失败。
// 本文件不读写本地文件系统：分块字节由调用方（fileIo.ts）提供/消费，
// 便于在无原生模块的环境里单独验证协议与重试逻辑。

import { decodeBase64, encodeBase64 } from "tweetnacl-util";

import { AppError, isAppError, toAppError } from "../errors";

import { decryptEnvelope, encryptEnvelope } from "./crypto";
import type { FetchLike, FetchInitLike } from "./client";

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

export type RemoteFileDirection = "to_phone" | "to_desktop";
export type RemoteFileStatus = "pending" | "ready" | "failed";

export interface RemoteFile {
  id: string;
  direction: RemoteFileDirection;
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
  /** 取消所有在途请求；取消后客户端仍可继续发起新请求（与同步客户端一致） */
  cancel(): void;
}

interface ActiveOperation {
  cancelled: boolean;
  controller: AbortController | null;
}

class FileHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`文件请求失败：HTTP ${status}`);
    this.name = "FileHttpError";
    this.status = status;
  }
}

export const FILE_CANCELLED_MESSAGE = "文件传输已取消";

function cancelledError(): AppError {
  return new AppError("network", FILE_CANCELLED_MESSAGE);
}

export function isFileCancelled(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.kind === "network" &&
    error.message === FILE_CANCELLED_MESSAGE
  );
}

function isRetryable(error: unknown): boolean {
  if (error instanceof FileHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (isAppError(error)) return error.kind === "network";
  return false;
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

export function createFileClient(options: FileClientOptions): FileClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new AppError("validation", "同步服务地址不能为空");
  if (!options.token) throw new AppError("validation", "同步令牌不能为空");
  if (options.syncKey.length !== 32) {
    throw new AppError("validation", "文件传输密钥长度错误");
  }

  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
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
      if (!response.ok) throw new FileHttpError(response.status);
      const body = await response.json();
      return decryptEnvelope(options.syncKey, aad, body);
    } catch (error) {
      if (operation.cancelled) throw cancelledError();
      if (timedOut) throw new AppError("network", "文件请求超时（30s）", error);
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
      if (isAppError(lastError)) throw lastError;
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

  function cancel(): void {
    for (const operation of active) {
      operation.cancelled = true;
      operation.controller?.abort();
    }
    active.clear();
  }

  return { list, create, uploadChunk, complete, downloadChunk, remove, cancel };
}
