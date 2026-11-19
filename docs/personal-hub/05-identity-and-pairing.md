# Personal Hub · 设备身份与二维码配对协议

- 日期：2026-11-19
- 阶段：P0 设计，**已按架构基线对齐**
- 唯一架构事实源：[ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md)
- 前置：[02-current-state-audit.md](02-current-state-audit.md)、[06-threat-model.md](06-threat-model.md)、[04-network-topology.md](04-network-topology.md)

> 对齐说明：密钥表移除 WireGuard 行（v1.0 不生成，基线 §6.1）；二维码内容按基线 §6.2 补齐 128-bit secret 与 Hub 指纹签名。

---

## 1. 设备身份体系

### 1.1 密钥用途分离（基线 §6.1：禁止复用同一密钥）

| 密钥 | 算法 | 用途 | 存储 |
|---|---|---|---|
| 设备身份私钥 | Ed25519 | 签名配对/会话请求 | Windows：DPAPI；Android：Keystore 包装的加密私钥 |
| 会话临时密钥 | X25519（每会话协商） | 单次会话密钥协商 | 内存，结束即销毁 |
| WebRTC DTLS 密钥 | WebRTC 实现管理 | WebRTC 传输加密 | WebRTC 实现管理 |
| WireGuard 私钥 | — | **v1.0 不生成**（D12 未来扩展） | — |

- 每台设备首次运行在本地生成 Ed25519 身份密钥（`device_id` 为随机 UUID，**不作为认证凭证**）；私钥不出设备，云端只有公钥（基线 §6.1/D8）。
- 哈希 SHA-256、KDF HKDF-SHA-256、AEAD AES-256-GCM 或已审计实现；**不自行实现密码算法**。
- Rust 侧优先验证 `ed25519-dalek` / `x25519-dalek` 工具链兼容；若构建/审计失败 → 停止并报告 BLOCKED，不得换算法或复用同步令牌（ADR-0006）。
- 现状差距：Windows 用随机 token + RSA-3072 自签 TLS 证书，Android 无设备私钥（[02](02-current-state-audit.md) §2）；Ed25519/X25519 身份体系为**待建设**。

### 1.2 设备身份记录

```text
DeviceIdentity {
  device_id, device_name, device_type (windows|android),
  identity_public_key, identity_fingerprint,
  created_at, revoked_at
}
```

- 指纹在配对确认界面展示，供用户肉眼核对（防 MITM，[06](06-threat-model.md) T5）。

---

## 2. 二维码配对协议

### 2.1 二维码内容（基线 §6.2：已锁定，绝不含敏感凭证）

```text
PairingInvitation {
  protocol_version,
  control_plane_address,   // Control Plane 地址
  invitation_id,
  invitation_secret,       // 128-bit 随机 secret（服务端只存哈希）
  nonce,
  expires_at,              // 默认 5 分钟
  hub_identity_fingerprint,// Hub 设备身份指纹
  hub_signature            // Hub 对邀请内容的签名
}
```

**绝对不能包含**：设备私钥、长期访问令牌、永久远控授权、系统密码、可无限重复使用的配对凭证。

### 2.2 邀请生命周期（基线 §6.2）

- 由 Windows Hub 生成，默认 **5 分钟 TTL、一次性、最多 5 次错误尝试**；过期/撤销/成功配对后立即失效。
- 状态：`ISSUED → CONSUMED / EXPIRED / REVOKED`，每次状态变更记审计。
- 配对只授予 `DEVICE_PAIRED` / `HUB_DISCOVERY`，**不授予 REMOTE_CONTROL**。
- 可复用现有配对基础：`PAIRING_TTL_SECS`、`MAX_PAIR_ATTEMPTS=5`、6 位配对码（[02](02-current-state-audit.md) §2.1）。

### 2.3 支持的配对入口

- 面对面扫码
- 远程分享二维码图片（需**独立确认步骤**）
- 邀请链接
- 一次性邀请码

---

## 3. 双向身份确认（规格 §3.3）

```
1. A（被扫方/电脑）出示二维码（含邀请签名 + 身份公钥指纹）
2. B（扫码方/手机）解析二维码，校验签名与有效期
3. B 验证 A 的身份（公钥指纹 + 证书 SPKI 固定，现有基础）
4. A 验证 B 的身份（B 提交配对请求含自身公钥 + 签名）
5. 双方界面显示：设备名称、设备类型、设备指纹
6. 用户双方确认后建立可信设备关系（远程分享二维码时增加独立确认步骤）
```

- **不能只凭服务器返回的设备 ID 就认为对方可信**；必须有公钥签名 + 用户肉眼核对指纹（防 MITM，[06](06-threat-model.md) T5）。
- 现有基础：二维码 `taskdock://pair?...&tls=<SPKI指纹>` 已做证书固定（fail-closed），Android `parsePairingUri()` 校验 64 hex pin（[02](02-current-state-audit.md)）。

---

## 4. 配对 ≠ 远控授权

- 配对成功只建立**可信设备关系**，授予 `NETWORK_JOIN` 能力。
- 远控能力（屏幕/输入/剪贴板/文件写/设备管理）必须在每次会话经本机认证单独授权（[08](08-permission-and-session.md) §1）。
- **二维码绝不直接授予远控权限**（规格开发纪律第 4 条）。

---

## 5. 撤销

- `PairingManager.revokePairing()` / `DeviceManager.revokeDevice()`：撤销后即时失效，每次请求校验撤销表。
- 同 uid 重新配对撤销旧授权（现有基础 `complete_pairing`）。
- 撤销敏感表不进备份明文（现有 `BACKUP_TABLES` 空 section 策略）。
