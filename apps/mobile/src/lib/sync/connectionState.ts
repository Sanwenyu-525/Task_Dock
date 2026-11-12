// v1 遗留连接判定（纯函数）。
//
// 桌面端自协议 v2 起 TLS-only 并强制 SPKI 指纹固定；手机端在缺少指纹时
// fail-closed。因此「连接元数据还在」不等于「还能用」：http:// 或缺少 64 位
// SPKI 指纹的已配对记录都必须提示重新配对，不能显示健康态。
//
// 设备页与同步页共用本判定，避免同一状态两处口径不一致。

export interface ConnectionLike {
  baseUrl: string;
  tlsFingerprint?: string;
}

const SPKI_HEX = /^[0-9a-f]{64}$/i;

/** true = 该连接是 v1 遗留记录或指纹缺失，当前协议下不可用。 */
export function isLegacyConnection(connection: ConnectionLike | null | undefined): boolean {
  if (!connection) return false;
  if (connection.baseUrl.startsWith("http://")) return true;
  return !SPKI_HEX.test((connection.tlsFingerprint ?? "").trim());
}
