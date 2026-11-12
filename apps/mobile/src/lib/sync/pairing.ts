// 配对载荷解析与桌面地址归一化（纯函数，不触网、不读写存储）。
//
// 二维码内容由桌面端 `mobile_sync::build_pairing_uri` 生成，v2 固定格式：
//   taskdock://pair?v=2&host=<IPv4>&port=<u16>&code=<6位>&name=<URL编码>
//             &instance=<id>&fp=<8位HEX展示指纹>&tls=<64位HEX SPKI SHA-256>
// 解析必须严格：字段缺失/越界/协议版本不兼容一律拒绝，不能带着半截目标去配网。
// v2 起 `tls` 是必需字段：手机端从首个字节起就按该 SPKI 指纹固定桌面端身份，
// 没有 tls 的二维码（v1 或被篡改）一律拒绝配对。

export interface PairingTarget {
  /** 桌面端局域网 IPv4 或主机名（二维码当前只发 IPv4） */
  host: string;
  port: number;
  /** 6 位十进制配对码 */
  code: string;
  /** 桌面端展示名（已解码，可能为空） */
  serverName: string;
  /** 桌面端持久实例 ID（非密钥） */
  instanceId: string;
  /** 桌面端短指纹（8 位十六进制，展示用） */
  fingerprint: string;
  /** 桌面端 TLS 证书 SPKI SHA-256（64 位十六进制，小写）；缺失/非法时解析整体失败 */
  tlsFingerprint: string;
  /** 原始二维码文本，便于诊断 */
  raw: string;
}

export interface DesktopAddress {
  host: string;
  port: number;
  /** 不含尾斜杠，例如 https://192.168.1.10:47822 */
  baseUrl: string;
}

export const DEFAULT_MOBILE_SYNC_PORT = 47822;
export const MOBILE_API_VERSION = 2;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const HOSTNAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,252}[a-zA-Z0-9])?$/;

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return "";
  }
}

/** 校验并归一化 TLS SPKI 指纹（64 位十六进制，统一转小写）。 */
export function normalizeTlsFingerprint(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** 严格解析桌面端二维码；任何不合法字段返回 null。 */
export function parsePairingUri(raw: string): PairingTarget | null {
  const text = raw.trim();
  const match = /^taskdock:\/\/pair\?(.+)$/i.exec(text);
  if (!match) return null;

  const params = new Map<string, string>();
  for (const part of match[1].split("&")) {
    if (!part) continue;
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index);
    params.set(key, decode(part.slice(index + 1)));
  }

  if ((params.get("v") ?? "") !== String(MOBILE_API_VERSION)) return null;

  const host = (params.get("host") ?? "").trim();
  if (!isValidHost(host)) return null;

  const port = Number(params.get("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const code = (params.get("code") ?? "").trim();
  if (!/^\d{6}$/.test(code)) return null;

  const serverName = (params.get("name") ?? "").trim();
  const instanceId = (params.get("instance") ?? "").trim();
  const fingerprint = (params.get("fp") ?? "").trim().toUpperCase();
  if (fingerprint && !/^[0-9A-F]{8}$/.test(fingerprint)) return null;

  // v2 硬要求：TLS 指纹缺失或非法的二维码不进入配对流程（fail-closed）。
  const tlsFingerprint = normalizeTlsFingerprint(params.get("tls") ?? "");
  if (!tlsFingerprint) return null;

  return {
    host,
    port,
    code,
    serverName,
    instanceId,
    fingerprint,
    tlsFingerprint,
    raw: text,
  };
}

export function isValidHost(host: string): boolean {
  return IPV4.test(host) || HOSTNAME.test(host);
}

/**
 * 把用户输入归一化为桌面地址。
 *
 * 支持 `192.168.1.10`、`192.168.1.10:47822`、`https://192.168.1.10:47822/`；
 * v2 起桌面端是 TLS-only，统一输出 `https://`（输入带 `http://` 也按 https 处理，
 * 明文服务已不存在）。不接受路径。
 */
export function normalizeDesktopAddress(
  raw: string,
  defaultPort = DEFAULT_MOBILE_SYNC_PORT,
): DesktopAddress | null {
  let text = raw.trim();
  if (!text) return null;
  text = text.replace(/^https?:\/\//i, "");

  const slash = text.indexOf("/");
  if (slash >= 0) {
    text = text.slice(0, slash);
  }

  let host = text;
  let port = defaultPort;
  const colon = text.lastIndexOf(":");
  if (colon > 0) {
    host = text.slice(0, colon);
    const parsed = Number(text.slice(colon + 1));
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
    port = parsed;
  }

  host = host.trim();
  if (!isValidHost(host)) return null;

  return { host, port, baseUrl: `https://${host}:${port}` };
}

export function targetToAddress(target: PairingTarget): DesktopAddress {
  return {
    host: target.host,
    port: target.port,
    baseUrl: `https://${target.host}:${target.port}`,
  };
}

/** 只保留 6 位数字，供受控输入框使用（粘贴带空格也能落位）。 */
export function normalizePairingCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}
