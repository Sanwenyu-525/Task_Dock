// 同步载荷加密：XSalsa20-Poly1305（tweetnacl secretbox），与桌面端 Rust
// `xsalsa20poly1305` 使用同一算法与密钥派生。
//
// 密钥：桌面端只保存 SHA-256(令牌) 的十六进制哈希，手机端用 expo-crypto 现算同一个哈希，
// 再对 "taskdock-sync-v1:"+哈希 做 SHA-512 并截断 32 字节。这样两端不需要额外下发密钥，
// 也不会把明文令牌写进请求体。
//
// 明文内嵌 AAD（方法与路径），解密后必须完全一致，防止把 pull 的密文重放到 push。
import * as Crypto from "expo-crypto";
import nacl from "tweetnacl";
import { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } from "tweetnacl-util";

import { AppError } from "../errors";

export const SYNC_ENVELOPE_VERSION = 1;
export const AAD_PULL = "taskdock-sync-v1|GET|/v1/changes";
export const AAD_PUSH = "taskdock-sync-v1|POST|/v1/ops";

export interface SyncEnvelope {
  v: number;
  /** base64(24 字节 nonce) */
  n: string;
  /** base64(ciphertext + tag) */
  d: string;
}

/** 派生同步密钥；令牌本身不进日志、不落盘。 */
export async function deriveSyncKey(token: string): Promise<Uint8Array> {
  const tokenHashHex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    token,
  );
  // nacl.hash 是 SHA-512，输出 64 字节；取前 32 字节作为 secretbox 密钥。
  const digest = nacl.hash(decodeUTF8(`taskdock-sync-v1:${tokenHashHex}`));
  return digest.slice(0, 32);
}

export function encryptEnvelope(key: Uint8Array, aad: string, data: unknown): SyncEnvelope {
  const nonce = Crypto.getRandomBytes(24);
  const plaintext = decodeUTF8(JSON.stringify({ aad, data }));
  const ciphertext = nacl.secretbox(plaintext, nonce, key);
  if (!ciphertext) {
    throw new AppError("storage", "同步载荷加密失败");
  }
  return {
    v: SYNC_ENVELOPE_VERSION,
    n: encodeBase64(nonce),
    d: encodeBase64(ciphertext),
  };
}

/** 解密并校验 AAD；失败一律抛 validation，不把底层原因暴露到 UI。 */
export function decryptEnvelope(key: Uint8Array, aad: string, envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new AppError("validation", "同步响应不是加密信封");
  }
  const record = envelope as Record<string, unknown>;
  if (
    record.v !== SYNC_ENVELOPE_VERSION ||
    typeof record.n !== "string" ||
    typeof record.d !== "string"
  ) {
    throw new AppError("validation", "同步响应信封版本或字段不合法");
  }

  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    nonce = decodeBase64(record.n);
    ciphertext = decodeBase64(record.d);
  } catch {
    throw new AppError("validation", "同步响应信封不是合法 base64");
  }
  if (nonce.length !== 24) {
    throw new AppError("validation", "同步响应 nonce 长度错误");
  }

  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
  if (!plaintext) {
    throw new AppError("validation", "同步响应解密失败（密钥或载荷不匹配）");
  }

  let parsed: { aad?: unknown; data?: unknown };
  try {
    parsed = JSON.parse(encodeUTF8(plaintext)) as { aad?: unknown; data?: unknown };
  } catch {
    throw new AppError("validation", "同步响应明文不是 JSON");
  }
  if (parsed.aad !== aad) {
    throw new AppError("validation", "同步响应 AAD 不匹配");
  }
  return parsed.data;
}
