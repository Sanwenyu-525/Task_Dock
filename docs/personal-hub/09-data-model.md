# Personal Hub · 数据模型

- 日期：2026-11-19
- 阶段：P0 设计，**已按架构基线对齐**
- 唯一架构事实源：[ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md)（实体定义以基线 §12 为准）
- 前置：[03-architecture.md](03-architecture.md)、[05-identity-and-pairing.md](05-identity-and-pairing.md)、[08-permission-and-session.md](08-permission-and-session.md)

> 对齐说明：v1.0 不存虚拟网卡地址、不生成 WireGuard 私钥（D5/D12）；云端实体见基线 §12（Device/PairingInvitation/RemoteSession/LocalAuthGrant）。
> LocalAuthGrant 字段以 [07-local-auth-design.md](07-local-auth-design.md) §2.1 的基线版为准（≤60s、绑定 target/scopes）。

> 持久化遵循 `AGENTS.md` §4.3：只在 `src-tauri/src/db/mod.rs` 的 `MIGRATIONS` **末尾追加**，不改已发布迁移；新表登记 `BACKUP_TABLES`。
> Android 侧在 `apps/mobile/src/db/schema.ts` 的 `MIGRATIONS` append-only 追加（`PRAGMA user_version`）。
> **所有敏感列（令牌哈希、授权凭证、私钥）不进备份明文、不进日志。**

---

## 1. 设备与身份（Windows 主，Android 镜像）

```text
ph_devices
  device_id TEXT PRIMARY KEY
  device_name TEXT
  device_type TEXT            -- windows | android
  identity_public_key BLOB    -- Ed25519 公钥（只存公钥）
  identity_fingerprint TEXT   -- 指纹，UI 展示
  created_at TEXT
  last_seen_at TEXT
  revoked_at TEXT NULL
  -- v1.0 不分配虚拟网卡 IP（基线 D5）；WebRTC 连接地址不落库

ph_device_keys (本机私钥，受 DPAPI 保护，不备份)
  key_purpose TEXT PRIMARY KEY -- identity（v1.0）；local_auth 若适用
  encrypted_private_key BLOB   -- DPAPI / Keystore 密文
  public_key BLOB
  created_at TEXT
  -- v1.0 不生成 wireguard 私钥（D12）；WebRTC DTLS 密钥由 WebRTC 实现管理
```

---

## 2. 配对邀请

```text
ph_pairing_invitations
  invitation_id TEXT PRIMARY KEY
  nonce TEXT
  discovery_address TEXT
  protocol_version TEXT
  signature BLOB
  expires_at TEXT
  state TEXT                  -- ISSUED | CONSUMED | EXPIRED | REVOKED
  created_at TEXT
```

> 二维码只编码邀请字段，**不含私钥/令牌/永久授权**（[05](05-identity-and-pairing.md) §2.1）。

---

## 3. 权限与授权凭证

```text
ph_local_auth_grants
  grant_id TEXT PRIMARY KEY
  controller_device_id TEXT
  controller_identity_fp TEXT
  session_id TEXT
  session_nonce TEXT
  permissions TEXT (JSON)     -- 能力位子集
  auth_method TEXT
  signature BLOB
  issued_at TEXT
  expires_at TEXT
  single_use INTEGER          -- 1
  consumed_at TEXT NULL
  revoked_at TEXT NULL
```

> 不存 PIN/密码/生物特征；grant 短时有效、单次使用（[07](07-local-auth-design.md) §2.1）。

---

## 4. 会话

```text
ph_sessions
  session_id TEXT PRIMARY KEY
  controller_device_id TEXT
  target_device_id TEXT
  state TEXT                  -- 12 态之一（[08](08-permission-and-session.md) §2.1）
  requested_permissions TEXT (JSON)
  granted_permissions TEXT (JSON)
  session_nonce TEXT
  replay_sequence INTEGER
  expires_at TEXT
  created_at TEXT
  ended_at TEXT NULL
  end_reason TEXT NULL
```

---

## 5. 审计

```text
ph_audit_log
  id INTEGER PRIMARY KEY AUTOINCREMENT
  event_type TEXT             -- pairing | authentication | authorization | session | security_failure
  device_id TEXT NULL
  session_id TEXT NULL
  outcome TEXT                -- success | failure
  detail TEXT (JSON)          -- 脱敏：结果码/方法/原因，不含密码/私钥/完整令牌/生物特征
  created_at TEXT
```

---

## 6. 备份与敏感数据处理

- `ph_devices` / `ph_pairing_invitations` / `ph_sessions` / `ph_audit_log` 可登记 `BACKUP_TABLES`（只含元数据与脱敏 detail）。
- `ph_device_keys` **不进备份**（参照现有 `mobile_tls/{cert,key}.pem` 与 `BACKUP_TABLES` 敏感表空 section 策略）。
- `ph_local_auth_grants` 短时凭证无备份价值，**不进备份**。
- Android 侧令牌继续用 `expo-secure-store`（Keystore），连接元数据脱敏存 SQLite `kv`。
- 隐私规则遵循 `AGENTS.md` §7：密钥/令牌/个人路径/本机敏感日志不写可提交文件。

---

## 7. 迁移策略

- Windows：新增迁移一次性 append 到 `MIGRATIONS` 末尾（当前最高版本 77，见 [02](02-current-state-audit.md)），不改历史版本；新表补 `BACKUP_TABLES` 规则。
- Android：`schema.ts` 的 `MIGRATIONS` append-only， bump `user_version`；现有 `kv` 结构兼容。
- 旧库/旧备份：新表可空，缺省视为无 Hub 数据；不改变现有 `mobile_devices`/`sync_*` 语义（Personal Hub 与现有数据同步面并存）。
