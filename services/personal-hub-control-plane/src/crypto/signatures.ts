/**
 * Ed25519 签名验证与指纹工具（基线 §6.1：设备身份签名 Ed25519，SHA-256 指纹）。
 * 服务端仅持有公钥，无法签名、无法读取私钥。
 */
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

/** Ed25519 公钥的 DER SPKI 前缀（12 字节 + 算法标识）。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 由 base64 原始公钥（32 字节）计算身份指纹：SHA-256 十六进制前 32 字符。 */
export function fingerprintOfPublicKey(publicKeyBase64: string): string {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  return sha256Hex(raw).slice(0, 32);
}

function toSpkiDer(publicKeyBase64: string) {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length === 32) {
    return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  }
  // 若已是完整 DER SPKI，直接使用。
  return raw;
}

/** 校验 Ed25519 签名；任何解析失败一律 fail-closed 返回 false。 */
export function verifyEd25519Signature(
  publicKeyBase64: string,
  payload: string,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: toSpkiDer(publicKeyBase64),
      format: 'der',
      type: 'spki',
    });
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64) return false;
    // algorithm=null：Ed25519 由公钥类型确定算法。
    return verify(null, Buffer.from(payload, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

/** 定时安全比较十六进制字符串（用于 invitation secret hash）。 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** 判断字符串是否为合法 base64 且解码长度符合预期。 */
export function isBase64OfLength(value: string, byteLength: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').length === byteLength;
  } catch {
    return false;
  }
}
