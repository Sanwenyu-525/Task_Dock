// 文本编解码纯函数层：URL / Base64 / Unicode 转义 / 换行格式。
//
// 为什么自己实现 Base64 与 UTF-8：Hermes 不保证有 btoa/atob，TextEncoder/TextDecoder
// 在部分构建里也不存在；为了避免引入 polyfill 依赖（体积与授权成本），这里用查表实现，
// 并且**严格校验**输入：
// - Base64 只接受标准字符（兼容 URL-safe 的 - _），长度与填充必须合法；
// - 解码后的字节必须是合法 UTF-8（拒绝截断/超长/代理区编码），不会把乱码当成功；
// - URL 解码遇到非法百分号编码直接报错，不静默替换成 �。
//
// 纯函数：不得 import react / react-native / expo / db。

export const MAX_CODEC_CHARS = 500_000;

export type TextResult = { ok: true; text: string } | { ok: false; message: string };

function tooLong(text: string): TextResult | null {
  if (text.length <= MAX_CODEC_CHARS) return null;
  return { ok: false, message: `文本 ${text.length} 字符，超过本机安全上限 ${MAX_CODEC_CHARS}` };
}

// ── UTF-8 ────────────────────────────────────────────────

/** 字符串 → UTF-8 字节。孤立代理项按 U+FFFD 处理（与浏览器 encodeURIComponent 行为一致）。 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 字节 → 字符串；非法序列返回错误而不是替换字符。 */
export function utf8Decode(bytes: Uint8Array): TextResult {
  let text = "";
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index];
    if (first < 0x80) {
      text += String.fromCharCode(first);
      index += 1;
      continue;
    }
    let count = 0;
    let codePoint = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      count = 1;
      codePoint = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      count = 2;
      codePoint = first & 0x0f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      count = 3;
      codePoint = first & 0x07;
    } else {
      return { ok: false, message: `第 ${index + 1} 个字节不是合法的 UTF-8 起始字节` };
    }
    if (index + count >= bytes.length) {
      return { ok: false, message: "UTF-8 序列被截断（末尾字节不完整）" };
    }
    for (let offset = 1; offset <= count; offset += 1) {
      const continuation = bytes[index + offset];
      if ((continuation & 0xc0) !== 0x80) {
        return { ok: false, message: `第 ${index + offset + 1} 个字节不是 UTF-8 续字节` };
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (
      (count === 2 && codePoint < 0x800) ||
      (count === 3 && codePoint < 0x10000) ||
      (count === 3 && codePoint > 0x10ffff) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return { ok: false, message: `第 ${index + 1} 个字节起是非法或超长的 UTF-8 序列` };
    }
    if (codePoint <= 0xffff) {
      text += String.fromCharCode(codePoint);
    } else {
      const value = codePoint - 0x10000;
      text += String.fromCharCode(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
    }
    index += count + 1;
  }
  return { ok: true, text };
}

// ── Base64 ───────────────────────────────────────────────

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  // 兼容 URL-safe 输入：- _ 与 + / 等价
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triple >> 18) & 0x3f];
    out += BASE64_ALPHABET[(triple >> 12) & 0x3f];
    out += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 0x3f] : "=";
    out += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 0x3f] : "=";
  }
  return out;
}

/** 严格 Base64 解码：拒绝非法字符、错误填充与长度。允许 ASCII 空白。 */
export function base64ToBytes(input: string): { ok: true; bytes: Uint8Array } | { ok: false; message: string } {
  const cleaned = input.replace(/[\s\r\n]+/g, "");
  if (cleaned.length === 0) return { ok: true, bytes: new Uint8Array(0) };
  if (cleaned.length % 4 !== 0) {
    return { ok: false, message: "Base64 长度必须是 4 的倍数（末尾可能缺少 = 填充）" };
  }
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  const body = padding > 0 ? cleaned.slice(0, -padding) : cleaned;
  if (body.includes("=")) return { ok: false, message: "Base64 的 = 只能出现在末尾" };

  const out: number[] = [];
  for (let index = 0; index < body.length; index += 4) {
    const chars = [0, 1, 2, 3].map((offset) => {
      const position = index + offset;
      if (position >= body.length) return 0;
      const code = body.charCodeAt(position);
      const value = code < 128 ? BASE64_LOOKUP[code] : -1;
      return value;
    });
    if (chars.some((value) => value < 0)) {
      return { ok: false, message: `第 ${index + 1} 个字符不是合法 Base64 字符` };
    }
    const triple = (chars[0] << 18) | (chars[1] << 12) | (chars[2] << 6) | chars[3];
    out.push((triple >> 16) & 0xff);
    if (index + 2 < body.length) out.push((triple >> 8) & 0xff);
    if (index + 3 < body.length) out.push(triple & 0xff);
  }
  return { ok: true, bytes: Uint8Array.from(out) };
}

export function encodeBase64(text: string): TextResult {
  const limit = tooLong(text);
  if (limit) return limit;
  return { ok: true, text: bytesToBase64(utf8Encode(text)) };
}

export function decodeBase64(text: string): TextResult {
  const limit = tooLong(text);
  if (limit) return limit;
  const decoded = base64ToBytes(text);
  if (!decoded.ok) return decoded;
  return utf8Decode(decoded.bytes);
}

// ── URL ──────────────────────────────────────────────────

/** 组件级 URL 编码（encodeURIComponent）。保留 RFC 3986 的非法字符处理交给浏览器实现。 */
export function encodeUrl(text: string): TextResult {
  const limit = tooLong(text);
  if (limit) return limit;
  try {
    return { ok: true, text: encodeURIComponent(text) };
  } catch {
    return { ok: false, message: "文本包含无法编码的字符（孤立代理项）" };
  }
}

/**
 * URL 解码。默认按组件语义（+ 不转空格）；表单/查询串里的 + 语义需要显式开启，
 * 不做「猜用户想按哪种解码」的静默处理。
 */
export function decodeUrl(text: string, options: { plusAsSpace?: boolean } = {}): TextResult {
  const limit = tooLong(text);
  if (limit) return limit;
  const source = options.plusAsSpace ? text.replace(/\+/g, " ") : text;
  // 先检查百分号后面确实是两位十六进制：decodeURIComponent 对 "%zz" 会抛
  // URIError，但错误信息不含位置，自己给出位置更利于手机上排查。
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "%") continue;
    const hex = source.slice(index + 1, index + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      return { ok: false, message: `第 ${index + 1} 个字符起是无效的百分号编码（需要 % 后跟两位十六进制）` };
    }
    index += 2;
  }
  try {
    return { ok: true, text: decodeURIComponent(source) };
  } catch {
    return { ok: false, message: "百分号编码不是合法的 UTF-8 字节序列" };
  }
}

// ── Unicode 转义 ─────────────────────────────────────────

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * 转义非 ASCII 字符为 \uXXXX（BMP 以外的字符拆成代理对，与 JSON/Java 习惯一致）。
 * `escapeAscii` 为 true 时连 ASCII 可见字符也转义（适合嵌入只允许 ASCII 的字段）。
 */
export function encodeUnicodeEscapes(text: string, options: { escapeAscii?: boolean } = {}): TextResult {
  const limit = tooLong(text);
  if (limit) return limit;
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80 && !options.escapeAscii) {
      out += text[index];
      continue;
    }
    out += `\\u${hex4(code)}`;
  }
  return { ok: true, text: out };
}

/** 解析 \uXXXX 与 \u{1F600}；其他字符原样保留，非法转义报错。 */
export function decodeUnicodeEscapes(text: string): TextResult {
  const limit = tooLong(text);
  if (limit) return limit;
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\" || text[index + 1] !== "u") {
      out += text[index];
      continue;
    }
    if (text[index + 2] === "{") {
      const end = text.indexOf("}", index + 3);
      if (end < 0) return { ok: false, message: "\\u{…} 缺少右花括号" };
      const hex = text.slice(index + 3, end);
      if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) {
        return { ok: false, message: `\\u{${hex}} 不是合法的码点` };
      }
      const codePoint = parseInt(hex, 16);
      if (codePoint > 0x10ffff) return { ok: false, message: `码点 U+${hex} 超出 Unicode 范围` };
      out += String.fromCodePoint(codePoint);
      index = end;
      continue;
    }
    const hex = text.slice(index + 2, index + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      return { ok: false, message: `第 ${index + 1} 个字符起：\\u 后需要 4 位十六进制` };
    }
    out += String.fromCharCode(parseInt(hex, 16));
    index += 5;
  }
  return { ok: true, text: out };
}

// ── 换行与空白 ───────────────────────────────────────────

export type NewlineStyle = "lf" | "crlf" | "cr";

export function convertNewlines(text: string, target: NewlineStyle): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (target === "lf") return normalized;
  if (target === "cr") return normalized.replace(/\n/g, "\r");
  return normalized.replace(/\n/g, "\r\n");
}

export function trimWhitespace(text: string): string {
  return text.replace(/^\s+/, "").replace(/\s+$/, "");
}

export interface TextStats {
  chars: number;
  /** UTF-8 字节数（与接口/文件大小口径一致） */
  bytes: number;
  lines: number;
}

export function describeText(text: string): TextStats {
  return {
    chars: Array.from(text).length,
    bytes: utf8Encode(text).length,
    lines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length,
  };
}
