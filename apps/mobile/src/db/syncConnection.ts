// 已配对连接的本地存储：令牌进 SecureStore，其余非敏感元数据进 kv。
//
// 安全边界：
// - 令牌只存 SecureStore（Android Keystore 加密），绝不写 kv/SQLite 明文；
// - 元数据只含桌面端地址、设备名、实例 ID、指纹与时间，不含配对码；
// - 解除配对必须同时删除令牌与元数据；任一步失败都要让上层可见。

import * as SecureStore from "expo-secure-store";

import { deleteSetting, getSetting, setSetting } from "./kv";

const META_KEY = "sync.connection.v1";
const TOKEN_KEY = "taskdock.sync.token.v1";

export interface PairedConnection {
  /** 桌面端地址，例如 http://192.168.1.10:47822（无尾斜杠） */
  baseUrl: string;
  host: string;
  port: number;
  serverName: string;
  deviceId: string;
  platform: string;
  instanceId: string;
  fingerprint: string;
  pairedAt: string;
  /** 本机最后一次成功连接桌面端的时间（ISO） */
  lastSeenAt: string | null;
}

function parseMeta(raw: string | null): PairedConnection | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PairedConnection>;
    if (
      typeof value.baseUrl !== "string" ||
      !/^http:\/\/.+:\d+$/.test(value.baseUrl) ||
      typeof value.host !== "string" ||
      typeof value.port !== "number" ||
      typeof value.serverName !== "string" ||
      typeof value.deviceId !== "string" ||
      !value.deviceId ||
      typeof value.pairedAt !== "string"
    ) {
      return null;
    }
    return {
      baseUrl: value.baseUrl,
      host: value.host,
      port: value.port,
      serverName: value.serverName,
      deviceId: value.deviceId,
      platform: typeof value.platform === "string" ? value.platform : "android",
      instanceId: typeof value.instanceId === "string" ? value.instanceId : "",
      fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : "",
      pairedAt: value.pairedAt,
      lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : null,
    };
  } catch {
    return null;
  }
}

export async function loadConnection(): Promise<PairedConnection | null> {
  return parseMeta(await getSetting(META_KEY));
}

export async function readToken(): Promise<string | null> {
  try {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    return token && /^[0-9a-f]{64}$/i.test(token) ? token : null;
  } catch {
    // Keystore 不可用/数据损坏：按未配对处理，让用户重新配对，绝不回退明文存储。
    return null;
  }
}

export async function saveConnection(input: {
  token: string;
  meta: Omit<PairedConnection, "lastSeenAt">;
}): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, input.token);
  try {
    await setSetting(META_KEY, JSON.stringify({ ...input.meta, lastSeenAt: null }));
  } catch (error) {
    // 元数据写失败时清掉令牌，避免留下无法展示/无法解除的孤儿凭据。
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
    throw error;
  }
}

export async function touchConnection(at: string): Promise<void> {
  const meta = await loadConnection();
  if (!meta) return;
  await setSetting(META_KEY, JSON.stringify({ ...meta, lastSeenAt: at }));
}

export async function clearConnection(): Promise<void> {
  const results = await Promise.allSettled([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    deleteSetting(META_KEY),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure && failure.status === "rejected") {
    throw failure.reason;
  }
}
