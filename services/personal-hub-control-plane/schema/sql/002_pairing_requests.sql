-- P3 配对申请中间状态（共享契约 §3.3）：Android 提交 → PC 本机批准/拒绝。
-- 幂等：IF NOT EXISTS；可与 001_init.sql 重复执行。
-- 安全约束：无私钥列、无系统密码列、无 LocalAuthGrant 列、无媒体/文件正文列；
-- identity_public_key 仅存 base64 32 字节公钥；时间统一 TIMESTAMPTZ（UTC）。
-- 该记录存在不等于已配对：只有 status='approved' 才表示 PC 已批准并已创建设备。

CREATE TABLE IF NOT EXISTS ph_pairing_requests (
  request_id           UUID PRIMARY KEY,
  invitation_id        UUID        NOT NULL REFERENCES pairing_invitations(invitation_id),
  issuer_device_id     UUID        NOT NULL,
  device_id            UUID        NOT NULL,
  device_type          TEXT        NOT NULL CHECK (device_type IN ('android', 'windows-hub')),
  display_name         TEXT        NOT NULL,
  identity_public_key  TEXT        NOT NULL,  -- base64 32B，仅公钥
  identity_fingerprint TEXT        NOT NULL,
  status               TEXT        NOT NULL
    CHECK (status IN ('awaiting_pc_approval','approved','rejected','expired')),
  requested_at         TIMESTAMPTZ NOT NULL,
  decided_at           TIMESTAMPTZ,
  decided_by           UUID
);

CREATE INDEX IF NOT EXISTS idx_pairing_requests_issuer_status
  ON ph_pairing_requests(issuer_device_id, status);
CREATE INDEX IF NOT EXISTS idx_pairing_requests_device_status
  ON ph_pairing_requests(device_id, status);
CREATE INDEX IF NOT EXISTS idx_pairing_requests_invitation
  ON ph_pairing_requests(invitation_id);

-- 数据保留（§7.5）：已决申请可在保留窗口后清理，由运维 cron 调用。
-- DELETE FROM ph_pairing_requests
--   WHERE status <> 'awaiting_pc_approval'
--     AND requested_at < now() - interval '30 days';
