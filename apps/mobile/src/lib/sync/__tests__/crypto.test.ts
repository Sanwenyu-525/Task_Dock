// 同步加密测试：KDF 与桌面端规范逐字节一致（用 node:crypto 独立计算期望值，
// 不复用被测代码路径）、信封往返、AAD 绑定、防篡改。
// 注：本测试在 node 环境运行，expo-crypto 由 src/test/mocks 提供（同样走 node:crypto）。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AppError } from "../../errors";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";

import {
  AAD_PULL,
  AAD_PUSH,
  SYNC_ENVELOPE_VERSION,
  decryptEnvelope,
  deriveSyncKey,
  encryptEnvelope,
} from "../crypto";

/** 与桌面端 mobile_sync::sync::derive_key 相同的规范，独立实现作为交叉校验。 */
function expectedKey(token: string): Uint8Array {
  const tokenHashHex = createHash("sha256").update(token, "utf8").digest("hex");
  const digest = createHash("sha512")
    .update(`taskdock-sync-v1:${tokenHashHex}`, "utf8")
    .digest();
  return new Uint8Array(digest.subarray(0, 32));
}

describe("deriveSyncKey（跨端一致性）", () => {
  it("与独立实现的 KDF 逐字节一致", async () => {
    const token = "a".repeat(64);
    const key = await deriveSyncKey(token);
    expect(Array.from(key)).toEqual(Array.from(expectedKey(token)));
  });

  it("固定向量（桌面端同输入应得到同一密钥）", async () => {
    const token = "a".repeat(64);
    const key = await deriveSyncKey(token);
    const hex = Array.from(key)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    // 该向量由 node:crypto 独立计算；桌面端 cargo test 中的对应用例若不一致即失败。
    expect(hex).toBe(
      "282257e1912be9b743d7cb7eeab3056560492ab079a14bf613468fa30f0a5164",
    );
  });
});

describe("信封加解密", () => {
  it("往返：加密后可解回原文", async () => {
    const key = await deriveSyncKey("a".repeat(64));
    const envelope = encryptEnvelope(key, AAD_PULL, { hello: "世界", n: 1 });
    expect(envelope.v).toBe(SYNC_ENVELOPE_VERSION);
    const data = decryptEnvelope(key, AAD_PULL, envelope);
    expect(data).toEqual({ hello: "世界", n: 1 });
  });

  it("nonce 每次...随机（同明文不同密文）", async () => {
    const key = await deriveSyncKey("a".repeat(64));
    const first = encryptEnvelope(key, AAD_PULL, { x: 1 });
    const second = encryptEnvelope(key, AAD_PULL, { x: 1 });
    expect(first.d).not.toBe(second.d);
  });

  it("AAD 绑定：pull 密文不能解到 push", async () => {
    const key = await deriveSyncKey("a".repeat(64));
    const envelope = encryptEnvelope(key, AAD_PULL, { x: 1 });
    expect(() => decryptEnvelope(key, AAD_PUSH, envelope)).toThrow(AppError);
  });

  it("错误密钥解密失败（validation，不抛底层异常）", async () => {
    const key = await deriveSyncKey("a".repeat(64));
    const other = await deriveSyncKey("b".repeat(64));
    const envelope = encryptEnvelope(key, AAD_PULL, { x: 1 });
    expect(() => decryptEnvelope(other, AAD_PULL, envelope)).toThrow(AppError);
  });

  it("密文被篡改时解密失败", async () => {
    const key = await deriveSyncKey("a".repeat(64));
    const envelope = encryptEnvelope(key, AAD_PULL, { x: 1 });
    const bytes = decodeBase64(envelope.d);
    bytes[0] ^= 0xff;
    const tampered = { ...envelope, d: encodeBase64(bytes) };
    expect(() => decryptEnvelope(key, AAD_PULL, tampered)).toThrow(AppError);
  });

  it("非法信封（非对象/坏版本/坏 base64/nonce 长度）抛 validation", async () => {
    const key = await deriveSyncKey("a".repeat(64));
    expect(() => decryptEnvelope(key, AAD_PULL, "string")).toThrow(AppError);
    expect(() => decryptEnvelope(key, AAD_PULL, { v: 99, n: "", d: "" })).toThrow(AppError);
    expect(() =>
      decryptEnvelope(key, AAD_PULL, { v: 1, n: "!!!", d: encodeBase64(new Uint8Array(4)) }),
    ).toThrow(AppError);
    const envelope = encryptEnvelope(key, AAD_PULL, { x: 1 });
    expect(() =>
      decryptEnvelope(key, AAD_PULL, { ...envelope, n: encodeBase64(new Uint8Array(8)) }),
    ).toThrow(AppError);
  });
});
