// 设备身份原生模块的 JS 边界（本地 Expo 模块 `modules/device-identity`）。
//
// 安全边界：原生模块只返回公钥/指纹/签名，**不返回 seed 或私钥**。
// 原生不可用（旧构建 / 非 Android / 单测）时 requireOptionalNativeModule 返回 null，
// 由 src/lib/hub/identity.ts 统一 fail-closed，绝不伪造签名或退回纯 JS 密钥。
import { NativeModule, requireOptionalNativeModule } from "expo-modules-core";

export interface DeviceIdentityPublic {
  deviceId: string;
  /** base64(raw 32 字节 Ed25519 公钥)，含 `=` 填充 */
  publicKeyBase64: string;
  /** hex(sha256(raw pubkey))[0..32] */
  fingerprint: string;
}

export type KeyProtectionLevel = "strongbox" | "tee" | "software";

interface DeviceIdentityNativeModule extends NativeModule {
  ensureIdentity(): Promise<DeviceIdentityPublic>;
  getIdentity(): Promise<DeviceIdentityPublic | null>;
  /** 入参/返回值都是标准 base64；签名为固定 64 字节。 */
  sign(payloadBase64: string): Promise<string>;
  getProtectionLevel(): Promise<KeyProtectionLevel>;
  deleteIdentity(): Promise<void>;
}

const native = requireOptionalNativeModule<DeviceIdentityNativeModule>("DeviceIdentity");

export const deviceIdentityAvailable = native != null;

export default native;
