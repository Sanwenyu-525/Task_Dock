// Personal Hub Control Plane 客户端（契约 §3.2，本阶段只用 Android 的两个端点）。
//
// 传输约束：
// - 只用 React Native 内置 `fetch`（OkHttp 默认 TLS 校验），**不**设置任何
//   trustManager / hostnameVerifier / 证书绕过；非 https 的 Control Plane 直接拒绝；
// - 每个请求体自动附加 timestamp / nonce / signature；签名覆盖
//   canonical(body 去掉 signature) 的 UTF-8 字节（契约 §1）；
// - timestamp 使用 UTC ISO-8601（毫秒），nonce 为 UUID v4，服务端按 (deviceId, nonce)
//   去重防重放；
// - 错误统一映射为 `HubApiError`，保留服务端稳定 code，UI 不展示 HTTP 细节。
import * as Crypto from "expo-crypto";

import { AppError } from "../errors";

import { canonicalStringify } from "./canonical";
import type { DeviceIdentityApi } from "./identity";

export const PAIRING_REQUEST_PATH = "/v1/pairing/request";
export const PAIRING_STATUS_PATH = "/v1/pairing/status";

export type PairingRequestStatus = "awaiting_pc_approval" | "approved" | "rejected" | "expired";

export interface HubPeer {
  deviceId: string;
  displayName: string;
  deviceType: string;
  identityFingerprint: string;
}

export interface PairingRequestAck {
  requestId: string;
  status: "awaiting_pc_approval";
  expiresAt: string;
}

export interface PairingStatusResult {
  status: PairingRequestStatus;
  peer?: HubPeer;
}

export class HubApiError extends Error {
  constructor(
    /** 服务端稳定 code，或本地传输错误码（NETWORK / TIMEOUT / CANCELLED / INSECURE_URL） */
    readonly code: string,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = "HubApiError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface HubClient {
  readonly baseUrl: string;
  submitPairingRequest(input: {
    invitationId: string;
    invitationSecret: string;
    displayName: string;
    signal?: AbortSignal;
  }): Promise<PairingRequestAck>;
  getPairingStatus(input: { requestId: string; signal?: AbortSignal }): Promise<PairingStatusResult>;
}

export interface CreateHubClientOptions {
  baseUrl: string;
  identity: DeviceIdentityApi;
  /** 测试注入；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
  newNonce?: () => string;
  timeoutMs?: number;
  /**
   * 仅本地开发控制面（`http://127.0.0.1` / `http://localhost`）需要的显式开关。
   * 生产路径（pairing.ts）不开启：二维码里的 cp 必须是 https。
   */
  allowLoopbackHttp?: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** 校验 Control Plane 基址；任何非 https（除显式允许的 loopback 开发地址）都拒绝。 */
export function assertSecureControlPlaneUrl(
  baseUrl: string,
  allowLoopbackHttp = false,
): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new HubApiError("INSECURE_URL", "Control Plane 地址不是合法 URL");
  }
  const normalized = baseUrl.replace(/\/+$/, "");
  if (parsed.protocol === "https:") return normalized;
  if (
    allowLoopbackHttp &&
    parsed.protocol === "http:" &&
    LOOPBACK_HOSTS.has(parsed.hostname)
  ) {
    return normalized;
  }
  throw new HubApiError(
    "INSECURE_URL",
    "Control Plane 必须使用 HTTPS；已拒绝明文或非法地址",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePeer(value: unknown): HubPeer | undefined {
  if (!isRecord(value)) return undefined;
  const { deviceId, displayName, deviceType, identityFingerprint } = value;
  if (
    typeof deviceId !== "string" ||
    typeof displayName !== "string" ||
    typeof deviceType !== "string" ||
    typeof identityFingerprint !== "string"
  ) {
    return undefined;
  }
  return { deviceId, displayName, deviceType, identityFingerprint };
}

function statusFromHttp(status: number): string {
  if (status === 401) return "INVALID_SIGNATURE";
  if (status === 403) return "DEVICE_REVOKED";
  if (status === 410) return "INVITATION_EXPIRED";
  if (status === 429) return "RATE_LIMITED";
  return "HTTP_ERROR";
}

export function createHubClient(options: CreateHubClientOptions): HubClient {
  const baseUrl = assertSecureControlPlaneUrl(options.baseUrl, options.allowLoopbackHttp);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const newNonce = options.newNonce ?? (() => Crypto.randomUUID());
  const timeoutMs = options.timeoutMs ?? 15_000;

  const post = async <T extends Record<string, unknown>>(
    path: string,
    fields: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (signal?.aborted) throw new HubApiError("CANCELLED", "请求已取消");

    const base = {
      ...fields,
      timestamp: new Date(now()).toISOString(),
      nonce: newNonce(),
    };
    const signature = await options.identity.signPayload(canonicalStringify(base));
    const body = { ...base, signature };

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new HubApiError("CANCELLED", "请求已取消", undefined, error);
      if (controller.signal.aborted) {
        throw new HubApiError("TIMEOUT", "连接 TaskDock 云端服务超时", undefined, error);
      }
      throw new HubApiError("NETWORK", "无法连接 TaskDock 云端服务", undefined, error);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortFromCaller);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      throw new HubApiError("SERVER_INVALID", "云端返回了无法解析的响应", response.status, error);
    }

    if (!response.ok || !isRecord(payload) || payload.ok !== true) {
      const errorRecord = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
      const code =
        typeof errorRecord?.code === "string" && errorRecord.code
          ? errorRecord.code
          : statusFromHttp(response.status);
      const message =
        typeof errorRecord?.message === "string" && errorRecord.message
          ? errorRecord.message
          : "云端拒绝了这次请求";
      throw new HubApiError(code, message, response.status);
    }

    return payload as T;
  };

  return {
    baseUrl,

    async submitPairingRequest(input) {
      const identity = await options.identity.ensureIdentity();
      const payload = await post<Record<string, unknown>>(
        PAIRING_REQUEST_PATH,
        {
          invitationId: input.invitationId,
          invitationSecret: input.invitationSecret,
          deviceId: identity.deviceId,
          deviceType: "android",
          displayName: input.displayName,
          identityPublicKey: identity.publicKeyBase64,
          identityFingerprint: identity.fingerprint,
        },
        input.signal,
      );
      if (
        typeof payload.requestId !== "string" ||
        payload.status !== "awaiting_pc_approval" ||
        typeof payload.expiresAt !== "string"
      ) {
        throw new HubApiError("SERVER_INVALID", "云端配对申请响应字段不完整");
      }
      return {
        requestId: payload.requestId,
        status: "awaiting_pc_approval",
        expiresAt: payload.expiresAt,
      };
    },

    async getPairingStatus(input) {
      const identity = await options.identity.ensureIdentity();
      const payload = await post<Record<string, unknown>>(
        PAIRING_STATUS_PATH,
        {
          requestId: input.requestId,
          deviceId: identity.deviceId,
        },
        input.signal,
      );
      const status = payload.status;
      if (
        status !== "awaiting_pc_approval" &&
        status !== "approved" &&
        status !== "rejected" &&
        status !== "expired"
      ) {
        throw new HubApiError("SERVER_INVALID", "云端配对状态不受支持");
      }
      const peer = parsePeer(payload.peer);
      if (status === "approved" && !peer) {
        // 批准后必须能展示 PC 指纹供人工比对；缺失即视为不可信响应。
        throw new HubApiError("SERVER_INVALID", "配对已批准但未返回电脑身份指纹");
      }
      return peer ? { status, peer } : { status };
    },
  };
}

/** 把底层异常收敛为带 code 的 HubApiError；身份模块缺失等 AppError 原样保留 code。 */
export function toHubApiError(error: unknown): HubApiError {
  if (error instanceof HubApiError) return error;
  if (error instanceof AppError) {
    return new HubApiError(error.code ?? "UNKNOWN", error.message, undefined, error);
  }
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code?: string }).code)
      : "UNKNOWN";
    return new HubApiError(code, error.message, undefined, error);
  }
  return new HubApiError("UNKNOWN", "配对请求失败", undefined, error);
}
