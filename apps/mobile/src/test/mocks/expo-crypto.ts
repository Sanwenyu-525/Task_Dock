// expo-crypto 的 node 测试替身：用 node:crypto 实现业务用到的两个能力。
// SHA-256 摘要返回小写 hex（与真机一致，跨端 KDF 依赖这一点）。
import { createHash, randomBytes } from "node:crypto";

export const CryptoDigestAlgorithm = {
  SHA256: "SHA-256",
} as const;

export async function digestStringAsync(
  _algorithm: string,
  value: string,
): Promise<string> {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function getRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

export function randomUUID(): string {
  return crypto.randomUUID();
}
