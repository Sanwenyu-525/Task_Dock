-- Control Plane 初始化迁移（幂等：IF NOT EXISTS）。
-- 安全约束：表中无私钥列、无系统密码列、无 LocalAuthGrant 列、无媒体/文件正文列。
-- 时间字段统一 TIMESTAMPTZ（UTC）。

CREATE TABLE IF NOT EXISTS devices (
  device_id            UUID PRIMARY KEY,
  device_type          TEXT        NOT NULL CHECK (device_type IN ('windows-hub', 'android')),
  display_name         TEXT        NOT NULL,
  identity_public_key  TEXT        NOT NULL,  -- base64 32B Ed25519 公钥（仅公钥）
  identity_fingerprint TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL,
  last_seen_at         TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pairing_invitations (
  invitation_id         UUID PRIMARY KEY,
  issuer_device_id      UUID        NOT NULL REFERENCES devices(device_id),
  invitation_secret_hash TEXT       NOT NULL, -- SHA-256(128-bit secret)，绝不存明文
  nonce                 TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ,
  failed_attempts       INTEGER     NOT NULL DEFAULT 0,
  status                TEXT        NOT NULL CHECK (status IN ('pending','consumed','expired','revoked'))
);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON pairing_invitations(status);

-- 最小会话元数据：不包含 LocalAuthGrant / grant_id / local_signature，
-- 也不存储 SDP/ICE/媒体/DataChannel 内容。
CREATE TABLE IF NOT EXISTS remote_sessions (
  session_id           UUID PRIMARY KEY,
  controller_device_id UUID        NOT NULL,
  target_device_id     UUID        NOT NULL,
  requested_scopes     TEXT[]      NOT NULL DEFAULT '{}',
  granted_scopes       TEXT[]      NOT NULL DEFAULT '{}',
  session_nonce        TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  status               TEXT        NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON remote_sessions(expires_at);

CREATE TABLE IF NOT EXISTS presence (
  device_id    UUID PRIMARY KEY REFERENCES devices(device_id),
  status       TEXT        NOT NULL CHECK (status IN ('online','offline')),
  connected_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS revocations (
  device_id  UUID        NOT NULL,
  reason     TEXT        NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (device_id, revoked_at)
);

-- 审计元数据：只含结果码、脱敏设备 ID、路径类型与时间，禁止凭据/正文。
CREATE TABLE IF NOT EXISTS audit_metadata (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT        NOT NULL,
  device_id   TEXT        NOT NULL,  -- 脱敏后的哈希 ID
  result_code TEXT        NOT NULL,
  path_type   TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_metadata(occurred_at);

-- 定期清理过期会话/邀请（§7.5 数据保留）：可由运维 cron 调用。
-- DELETE FROM remote_sessions WHERE expires_at < now() - interval '1 day';
-- DELETE FROM pairing_invitations WHERE expires_at < now() - interval '1 day';
