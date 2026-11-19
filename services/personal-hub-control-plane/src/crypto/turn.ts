/**
 * coturn 短时凭证签发（基线 §7.4/§7.5：TURN 使用短时凭证，
 * 客户端不得内置长期 TURN 密码；TURN 只转发密文）。
 *
 * 采用 coturn 官方 TURN REST API 语义：
 *   username  = "<expiry_epoch>:<userId>"
 *   credential = base64(HMAC-SHA1(turnSecret, username))
 * 过期时间内嵌在 username，coturn 据此拒绝过期凭证；turnSecret 仅存于服务端。
 */
import { createHmac } from 'node:crypto';

export const TURN_DEFAULT_TTL_SECONDS = 300;
export const TURN_MAX_TTL_SECONDS = 600;

export interface TurnCredentials {
  username: string;
  credential: string;
  ttlSeconds: number;
  expiresAt: string;
  uris: string[];
}

export interface IssueTurnCredentialsParams {
  deviceId: string;
  /** 服务端共享密钥，来自环境变量，绝不下发为长期密码。 */
  turnSecret: string;
  ttlSeconds?: number;
  nowMs?: number;
  uris?: string[];
}

export function issueTurnCredentials(
  params: IssueTurnCredentialsParams,
): TurnCredentials {
  if (!params.turnSecret) {
    throw new Error('TURN_SECRET is not configured');
  }
  const requested = params.ttlSeconds ?? TURN_DEFAULT_TTL_SECONDS;
  const ttlSeconds = Math.min(
    TURN_MAX_TTL_SECONDS,
    Math.max(30, Math.floor(requested)),
  );
  const nowEpoch = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const expiryEpoch = nowEpoch + ttlSeconds;
  const username = `${expiryEpoch}:${params.deviceId}`;
  const credential = createHmac('sha1', params.turnSecret)
    .update(username)
    .digest('base64');
  return {
    username,
    credential,
    ttlSeconds,
    expiresAt: new Date(expiryEpoch * 1000).toISOString(),
    uris: params.uris ?? ['turn:127.0.0.1:3478?transport=udp'],
  };
}
