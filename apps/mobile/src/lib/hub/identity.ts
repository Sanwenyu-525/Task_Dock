// 设备身份 JS 包装（基线 §5.1 / 契约 §6）：业务层唯一入口，原生模块之外不出现私钥概念。
//
// 安全约束：
// - 原生模块只暴露公钥、指纹与签名；本文件不缓存、不推导、不持久化 seed；
// - 原生返回的公钥/指纹在 JS 侧再做一次一致性校验（SHA-256 规则），防止桥接层错配；
// - 模块缺失时抛明确错误，绝不退回纯 JS 生成密钥或伪造签名。
import {
  deviceIdentityAvailable,
  type DeviceIdentityPublic as NativeIdentity,
  type KeyProtectionLevel,
} from "../../../modules/device-identity";
import nativeModule from "../../../modules/device-identity";
import { decodeUTF8, encodeBase64, decodeBase64 } from "tweetnacl-util";

import { AppError } from "../errors";
import { sha256Hex } from "../sync/sha256";

import { canonicalStringify } from "./canonical";

/** 对外身份视图：与原生返回一致，额外字段一律不暴露。 */
export interface LocalHubIdentity {
  deviceId: string;
  publicKeyBase64: string;
  fingerprint: string;
}

export interface DeviceIdentityNative {
  ensureIdentity(): Promise<NativeIdentity>;
  getIdentity(): Promise<NativeIdentity | null>;
  sign(payloadBase64: string): Promise<string>;
  getProtectionLevel(): Promise<KeyProtectionLevel>;
  deleteIdentity(): Promise<void>;
}

export interface DeviceIdentityApi {
  ensureIdentity(): Promise<LocalHubIdentity>;
  getIdentity(): Promise<LocalHubIdentity | null>;
  /** 对 UTF-8 字符串签名，返回 base64(64B)；供 canonical payload 使用。 */
  signPayload(payload: string): Promise<string>;
  signCanonical(body: Record<string, unknown>): Promise<string>;
  getFingerprint(): Promise<string>;
  getProtectionLevel(): Promise<KeyProtectionLevel>;
  deleteIdentity(): Promise<void>;
}

function identityUnavailable(): AppError {
  return new AppError(
    "validation",
    "当前构建不含 Personal Hub 设备身份模块，请安装最新版 APK",
    undefined,
    "identity_unavailable",
  );
}

function invalidNativeIdentity(message: string): AppError {
  return new AppError("validation", message, undefined, "identity_invalid");
}

/** 校验原生返回值：公钥必须 32 字节，指纹必须等于 SHA-256(公钥) 前 32 位。 */
function validateIdentity(identity: NativeIdentity): LocalHubIdentity {
  if (
    typeof identity.deviceId !== "string" ||
    typeof identity.publicKeyBase64 !== "string" ||
    typeof identity.fingerprint !== "string"
  ) {
    throw invalidNativeIdentity("设备身份返回值不完整");
  }
  const publicKey = (() => {
    try {
      return decodeBase64(identity.publicKeyBase64);
    } catch {
      throw invalidNativeIdentity("设备身份公钥不是合法 base64");
    }
  })();
  if (publicKey.length !== 32) {
    throw invalidNativeIdentity("设备身份公钥长度不是 32 字节");
  }
  const expected = sha256Hex(publicKey).slice(0, 32);
  if (identity.fingerprint.toLowerCase() !== expected) {
    throw invalidNativeIdentity("设备身份指纹与公钥不一致，已拒绝使用");
  }
  return {
    deviceId: identity.deviceId,
    publicKeyBase64: identity.publicKeyBase64,
    fingerprint: identity.fingerprint.toLowerCase(),
  };
}

/**
 * 构造身份 API；`native` 可注入，单测无需真机。
 * 默认使用 autolinking 的 `DeviceIdentity` 模块。
 */
export function createDeviceIdentityApi(native: DeviceIdentityNative | null): DeviceIdentityApi {
  const requireNative = (): DeviceIdentityNative => {
    if (!native) throw identityUnavailable();
    return native;
  };

  const ensureIdentity = async (): Promise<LocalHubIdentity> => {
    const identity = await requireNative().ensureIdentity();
    return validateIdentity(identity);
  };

  const getIdentity = async (): Promise<LocalHubIdentity | null> => {
    const identity = await requireNative().getIdentity();
    return identity ? validateIdentity(identity) : null;
  };

  const signPayload = async (payload: string): Promise<string> => {
    const signatureBase64 = await requireNative().sign(encodeBase64(decodeUTF8(payload)));
    let signature: Uint8Array;
    try {
      signature = decodeBase64(signatureBase64);
    } catch {
      throw invalidNativeIdentity("设备签名不是合法 base64");
    }
    if (signature.length !== 64) {
      throw invalidNativeIdentity("设备签名长度不是 64 字节");
    }
    return signatureBase64;
  };

  return {
    ensureIdentity,
    getIdentity,
    signPayload,
    signCanonical: (body) => signPayload(canonicalStringify(body)),
    getFingerprint: async () => (await ensureIdentity()).fingerprint,
    getProtectionLevel: async () => {
      const level = await requireNative().getProtectionLevel();
      if (level !== "strongbox" && level !== "tee" && level !== "software") {
        // 未知保护等级按最低等级上报，不冒称硬件保护。
        return "software";
      }
      return level;
    },
    deleteIdentity: async () => {
      await requireNative().deleteIdentity();
    },
  };
}

const defaultApi = createDeviceIdentityApi(
  deviceIdentityAvailable ? (nativeModule as DeviceIdentityNative) : null,
);

/** 供编排层注入的完整 API（配对流程只需要 getIdentity/ensureIdentity/signPayload）。 */
export const deviceIdentityApi = defaultApi;

export const ensureIdentity = defaultApi.ensureIdentity;
export const getIdentity = defaultApi.getIdentity;
export const signPayload = defaultApi.signPayload;
export const signCanonical = defaultApi.signCanonical;
export const getFingerprint = defaultApi.getFingerprint;
export const getProtectionLevel = defaultApi.getProtectionLevel;
export const deleteIdentity = defaultApi.deleteIdentity;
