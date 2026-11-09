// 配对与连通性客户端：带超时、可注入 fetch、不落任何日志/存储。
//
// 职责边界：
// - 只调用桌面端 v1 的 `/v1/pair` 与 `/v1/ping`；
// - 不保存令牌（由 `db/syncConnection.ts` 写入 SecureStore）；
// - 错误携带稳定 code（invalid_code / pairing_closed / too_many_attempts /
//   unauthorized / network / invalid_response），界面据此给可操作提示。

import { AppError, toAppError } from "../errors";

import type { DesktopAddress } from "./pairing";

const PAIR_TIMEOUT_MS = 8_000;
const PING_TIMEOUT_MS = 5_000;

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<HttpResponseLike>;

export class PairingRequestError extends AppError {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(code === "invalid_request" ? "validation" : "network", message, cause);
    this.name = "PairingRequestError";
    this.code = code;
  }
}

export interface PairResponse {
  token: string;
  deviceId: string;
  serverName: string;
  apiVersion: number;
  pairedAt: string;
}

export interface PingResponse {
  ok: boolean;
  serverName: string;
  deviceId: string;
  /** 桌面端当前时间（ISO），仅用于展示/漂移诊断 */
  now: string | null;
}

function defaultFetch(): FetchLike {
  return (url, init) => fetch(url, init);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readBody(response: HttpResponseLike): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await response.json());
  } catch {
    return null;
  }
}

function errorMessage(body: Record<string, unknown> | null, status: number): string {
  const message = body?.message;
  if (typeof message === "string" && message.trim()) return message;
  const code = body?.error;
  if (typeof code === "string" && code.trim()) return code;
  return `HTTP ${status}`;
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: FetchInitLike,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return {
      status: response.status,
      ok: response.ok,
      body: await readBody(response),
    };
  } catch (error) {
    if (timedOut) {
      throw new PairingRequestError("network", timeoutMessage, error);
    }
    throw new PairingRequestError(
      "network",
      "无法连接桌面端：请确认手机与电脑在同一 Wi-Fi、地址正确且防火墙已允许",
      error,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 配对请求。成功返回一次性令牌与设备身份；桌面端只保存令牌哈希。
 *
 * 注意：请求体包含 6 位配对码（短时信道），不会写入本地日志；响应令牌只由调用方
 * 立刻写入 SecureStore。
 */
export async function pairWithDesktop(options: {
  address: DesktopAddress;
  code: string;
  deviceName: string;
  platform?: string;
  fetchImpl?: FetchLike;
}): Promise<PairResponse> {
  if (!/^\d{6}$/.test(options.code)) {
    throw new PairingRequestError("invalid_request", "配对码必须是 6 位数字");
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const payload = JSON.stringify({
    code: options.code,
    device_name: options.deviceName.slice(0, 64),
    platform: (options.platform ?? "android").slice(0, 32),
  });

  const result = await requestJson(
    fetchImpl,
    `${options.address.baseUrl}/v1/pair`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: payload,
    },
    PAIR_TIMEOUT_MS,
    "配对请求超时：请确认桌面端仍在等待配对，然后重试",
  );

  if (!result.ok || !result.body) {
    const code = typeof result.body?.error === "string" ? result.body.error : "network";
    throw new PairingRequestError(code, errorMessage(result.body, result.status));
  }

  const body = result.body;
  const apiVersion = body.api_version;
  const token = body.token;
  const deviceId = body.device_id;
  const serverName = body.server_name;
  const pairedAt = body.paired_at;

  if (
    typeof apiVersion !== "number" ||
    typeof token !== "string" ||
    !/^[0-9a-f]{64}$/i.test(token) ||
    typeof deviceId !== "string" ||
    !deviceId ||
    typeof serverName !== "string" ||
    typeof pairedAt !== "string"
  ) {
    throw new PairingRequestError("invalid_response", "桌面端返回的配对结果不完整，请升级双端版本");
  }
  if (apiVersion !== 1) {
    throw new PairingRequestError(
      "invalid_response",
      `协议版本不兼容（桌面端 v${apiVersion}），请升级双端到同一版本`,
    );
  }

  return { token, deviceId, serverName, apiVersion, pairedAt };
}

/** 连通性探测：验证令牌是否仍被桌面端接受，并刷新桌面端「最近连接」。 */
export async function pingDesktop(options: {
  address: DesktopAddress;
  token: string;
  fetchImpl?: FetchLike;
}): Promise<PingResponse> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const result = await requestJson(
    fetchImpl,
    `${options.address.baseUrl}/v1/ping`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.token}`,
      },
    },
    PING_TIMEOUT_MS,
    "连接超时：请确认桌面端正在运行并已开启手机接入",
  );

  if (!result.ok || !result.body?.ok) {
    const code = typeof result.body?.error === "string" ? result.body.error : "network";
    throw new PairingRequestError(code, errorMessage(result.body, result.status));
  }

  return {
    ok: true,
    serverName: typeof result.body.server_name === "string" ? result.body.server_name : "",
    deviceId: typeof result.body.device_id === "string" ? result.body.device_id : "",
    now: typeof result.body.now === "string" ? result.body.now : null,
  };
}

/** 把任意异常收敛为可展示文案（不猜 code 分类）。 */
export function pairingErrorMessage(error: unknown): string {
  if (error instanceof PairingRequestError) {
    switch (error.code) {
      case "invalid_code":
        return "配对码错误，请核对桌面端显示的 6 位数字";
      case "pairing_closed":
        return "配对已结束或过期，请在桌面端重新生成配对码";
      case "too_many_attempts":
        return "尝试次数过多，请在桌面端重新生成配对码";
      case "unauthorized":
        return "设备令牌已失效（桌面端可能已撤销），请重新配对";
      case "invalid_response":
        return error.message;
      default:
        return error.message;
    }
  }
  return toAppError(error, "network").message;
}
