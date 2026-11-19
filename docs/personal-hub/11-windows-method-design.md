# Personal Hub · Windows 方法及类职责设计

- 日期：2026-11-19
- 阶段：P0 方法级设计，**已按架构基线对齐**（签名是目标设计，非已实现代码）
- 唯一架构事实源：[ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md)（方法签名以基线 §11.1 为准）
- 前置：[03-architecture.md](03-architecture.md)、[05-identity-and-pairing.md](05-identity-and-pairing.md)、[07-local-auth-design.md](07-local-auth-design.md)

> 规格第八节要求「实际类名、方法名、参数、返回值、异常类型和调用关系」。
> 所有类新建于 `src-tauri/src/personal_hub/`；错误类型统一 `HubError`。
> **对齐修订**：移除 WireGuardManager（基线 D5）；新增基线 §11.1 的 `PersonalHubService`、`SignalingClient`、`WebRtcSessionManager`；
> `LocalAuthManager` 改为严格系统凭据（无 App PIN 降级）。标注 **[复用]** 见 [02](02-current-state-audit.md)。

---

## 0. 统一错误类型

```rust
#[derive(Debug, thiserror::Error)]
pub enum HubError {
    #[error("invalid invitation: {0}")] InvalidInvitation(String),      // 过期/重复/签名错
    #[error("identity verification failed: {0}")] Identity(String),      // 身份/签名/指纹不匹配
    #[error("device revoked")] DeviceRevoked,
    #[error("local authentication required")] LocalAuthRequired,
    #[error("local authentication failed: {0}")] LocalAuthFailed(String),// 失败/取消/超时/不可用
    #[error("permission denied: {0}")] PermissionDenied(String),
    #[error("invalid session: {0}")] InvalidSession(String),             // 状态/身份/nonce/过期不符
    #[error("network error: {0}")] Network(String),
    #[error("storage error: {0}")] Storage(String),
}
pub type HubResult<T> = Result<T, HubError>;
```

---

## 0.1 PersonalHubService **[新建；基线 §11.1 首要类]**

> 独立普通用户进程 `taskdock-personal-hub` 的核心；不是 SYSTEM、不是 SCM 服务（D2）。

| 方法 | 参数 | 返回 | 异常 | 职责 |
|---|---|---|---|---|
| `start` | `config: HubConfig` | `HubResult<HubStatus>` | `Network`, `Storage` | 启动 Hub：初始化身份、Named Pipe（当前用户 ACL）、出站 WSS |
| `stop` | `reason: StopReason` | `HubResult<()>` | `Storage` | 显式停止（仅托盘/设置触发；关主窗口不调用） |
| `get_status` | — | `HubResult<HubStatus>` | `Storage` | 状态查询（本地 Named Pipe） |
| `run_health_check` | — | `HubResult<HealthReport>` | `Network`, `Storage` | 健康检查（WSS、Pipe、会话） |
| `recover_after_failure` | — | `HubResult<RecoveryResult>` | `Network`, `Storage` | 异常恢复；注销/休眠显示离线 |

---

## 1. DeviceManager **[部分复用 mobile_sync]**

| 方法 | 参数 | 返回 | 异常 | 职责 |
|---|---|---|---|---|
| `register_device` | `DeviceRegistration { name, type, identity_pubkey, fingerprint }` | `HubResult<DeviceId>` | `Identity`, `Storage` | 注册设备并落库（只存公钥） |
| `get_device_by_id` | `device_id: &str` | `HubResult<Option<PairedDevice>>` | `Storage` | 查询设备 |
| `list_paired_devices` | — | `HubResult<Vec<PairedDevice>>` | `Storage` | 列出配对设备 |
| `revoke_device` | `device_id: &str, reason: &str` | `HubResult<()>` | `Storage`, `Identity` | 软删除 + 主动终止其会话 **[复用 complete_pairing 撤销范式]** |
| `verify_device_signature` | `device_id, payload, signature` | `HubResult<bool>` | `Identity` | Ed25519 验签；失败即 `Identity` |

调用关系：`register_device` ← `PairingManager.finalize_pairing`；`revoke_device` → `SessionManager.revoke_session` + `WebRtcSessionManager.close_peer_connection` + 云端撤销状态同步（基线 §6.3）。

---

## 2. PairingManager **[部分复用 mobile_sync::start/complete_pairing]**

| 方法 | 参数 | 返回 | 异常 | 职责 |
|---|---|---|---|---|
| `create_pairing_invitation` | `ttl_secs: u64`（默认 300） | `HubResult<PairingInvitation>` | `Storage` | 生成 nonce + 过期 + 签名的一次性邀请 **[复用 generate_pairing_code]** |
| `validate_invitation` | `raw: &PairingInvitation` | `HubResult<InvitationId>` | `InvalidInvitation`, `Identity` | 校验签名/有效期/未使用 |
| `accept_pairing_request` | `req: PairRequest { invitation_id, device_info, pubkey, signature }` | `HubResult<PairSessionId>` | `InvalidInvitation`, `Identity` | 校验 + 建立待确认会话（尝试计数上限） |
| `confirm_peer_identity` | `pair_session_id, local_user_confirmed: bool` | `HubResult<PeerIdentity>` | `Identity`, `InvalidSession` | 双方指纹核对确认；未确认拒绝 |
| `finalize_pairing` | `pair_session_id` | `HubResult<PairedDevice>` | `Identity`, `Storage`, `InvalidSession` | 消费邀请 + 调 `DeviceManager.register_device` **[复用 complete_pairing 分段加锁+取消补偿]** |
| `revoke_pairing` | `pair_session_id / invitation_id` | `HubResult<()>` | `Storage` | 撤销邀请/配对 |

调用关系：`finalize_pairing` → `DeviceManager.register_device` → `NetworkManager.add_peer`（能力仅 NETWORK_JOIN）。

---

## 3. LocalAuthManager **[新建；依赖 Windows Hello PoC]**

| 方法 | 参数 | 返回 | 异常 | 职责 |
|---|---|---|---|---|
| `check_availability` | — | `HubResult<LocalAuthCapability>` | `LocalAuthFailed` | 检测 Hello/PIN/策略可用性（对应 `CheckAvailabilityAsync`） |
| `request_windows_hello_verification` | `hwnd: HWND, message: &str, session_id: &str` | `HubResult<AuthResult>` | `LocalAuthFailed` | 调 `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd, msg)`；映射结果枚举 |
| `verify_local_user_presence` | `session_id: &str` | `HubResult<bool>` | `LocalAuthFailed`, `Storage` | 检查锁屏状态（`WTS_SESSION_LOCK` 现有信号），锁屏返回 false **[复用锁屏信号]** |
| `issue_local_auth_grant` | `ctx: GrantContext { controller_id, session_id, nonce, permissions, auth_method }` | `HubResult<LocalAuthGrant>` | `LocalAuthFailed`, `Storage` | 认证成功后签发一次性短时凭证（本地授权私钥签名） |
| `validate_local_auth_grant` | `grant: &LocalAuthGrant, expected_session: &str` | `HubResult<()>` | `InvalidSession`, `PermissionDenied` | 校验绑定/过期/单次使用/签名 |
| `revoke_local_auth_grant` | `grant_id: &str` | `HubResult<()>` | `Storage` | 撤销授权凭证 |

调用关系：`SessionManager.require_local_authentication` → `LocalAuthManager.request_windows_hello_verification` → （成功）`issue_local_auth_grant`。降级路径见 [07](07-local-auth-design.md) §3.3，落到同一 `LOCAL_AUTH_REQUIRED` 状态。

---

## 4. SessionManager **[新建；集中状态机]**

| 方法 | 参数 | 返回 | 异常 | 职责 |
|---|---|---|---|---|
| `request_remote_session` | `req: SessionRequest`（见 [08](08-permission-and-session.md) §3） | `HubResult<SessionId>` | `Identity`, `InvalidSession` | 进入 `REQUEST_RECEIVED` |
| `validate_controller_identity` | `session_id, signature, identity_pubkey` | `HubResult<()>` | `Identity`, `DeviceRevoked` | 验签 + 撤销表校验 → `IDENTITY_VERIFIED` |
| `require_local_authentication` | `session_id` | `HubResult<AuthChallenge>` | `LocalAuthRequired` | 强制进入 `LOCAL_AUTH_REQUIRED`，不可跳过 |
| `authorize_session` | `session_id, grant: LocalAuthGrant` | `HubResult<PermissionSet>` | `PermissionDenied`, `InvalidSession` | 权限裁决 → `PERMISSION_GRANTED` |
| `create_session` | `session_id, transport_config` | `HubResult<SessionHandle>` | `Network`, `InvalidSession` | 建立加密通道 → `SESSION_ACTIVE` |
| `revoke_session` | `session_id, reason: &str` | `HubResult<()>` | `InvalidSession` | → `SESSION_REVOKED` + 关闭控制通道 |
| `expire_session` | `session_id` | `HubResult<()>` | `InvalidSession` | → `SESSION_EXPIRED` |
| `terminate_session` | `session_id, force: bool` | `HubResult<()>` | `InvalidSession` | → `SESSION_FAILED` / 强制终止 |

调用关系：`request_remote_session` → `validate_controller_identity` → `require_local_authentication`（→ `LocalAuthManager`）→ `authorize_session`（→ `PermissionManager`）→ `create_session`（→ `WebRtcSessionManager`）。任何异常只能导向 `SESSION_FAILED`（安全失败关闭，[08](08-permission-and-session.md) §2.2）。

---

## 5. SignalingClient **[新建；基线 §11.1]**

| 方法 | 参数 | 返回 | 异常 | 职责 |
|---|---|---|---|---|
| `connect` | `control_plane: ControlPlaneConfig` | `HubResult<()>` | `Network` | 出站 WSS 连接（不监听公网） |
| `register_device` | — | `HubResult<()>` | `Identity`, `Network` | 用设备签名注册公钥 |
| `publish_presence` | — | `HubResult<()>` | `Network` | 上报在线状态 |
| `send_offer` | `session_id, offer: SignedSdp` | `HubResult<()>` | `Network`, `Identity` | 发送签名绑定的 SDP |
| `send_ice_candidate` | `session_id, candidate: SignedIceCandidate` | `HubResult<()>` | `Network`, `Identity` | 发送签名绑定的 ICE |
| `handle_signaling_message` | `message: SignalingMessage` | `HubResult<()>` | `Identity`, `Network` | 校验签名与绑定后分发 |
| `disconnect` | — | `HubResult<()>` | `Network` | 断开 WSS |

---

## 6. WebRtcSessionManager **[新建；基线 §11.1]**

| 方法 | 参数 | 返回 | 异常 | 职责 |
|---|---|---|---|---|
| `create_peer_connection` | `session_id, ice_config: IceConfig` | `HubResult<PeerConnectionHandle>` | `Network` | 建 PeerConnection；STUN 直连、TURN 回退（UDP→TCP/TLS 443） |
| `bind_dtls_fingerprint` | `session_id, peer_fingerprint: Fingerprint` | `HubResult<()>` | `Identity` | DTLS 指纹与已验证设备身份绑定，防信令 MITM |
| `open_control_data_channel` | `session_id` | `HubResult<DataChannelHandle>` | `Network` | 控制指令通道（有序可靠） |
| `open_file_data_channel` | `session_id` | `HubResult<DataChannelHandle>` | `Network` | 文件通道（与控制通道分离） |
| `attach_screen_track` | `session_id, track: ScreenTrack` | `HubResult<()>` | `Network` | 挂载屏幕轨道（仅 P5 通过后，P6） |
| `close_peer_connection` | `session_id` | `HubResult<()>` | `Network` | 断线/撤销时关闭通道 |

> v1.0 为 WebRTC 应用层加密覆盖：DTLS-SRTP 视频 + DTLS DataChannel，TURN 只转发密文（D7）。**无 WireGuard / 虚拟网卡 / 虚拟地址分配**（D5/D12）。

---

## 7. AuditLogger **[部分复用 mcp/audit.rs 范式]**

| 方法 | 参数 | 返回 | 异常 | 职责 |
|---|---|---|---|---|
| `log_pairing_event` | `event: PairingAuditEvent` | `HubResult<()>` | `Storage` | 配对审计 |
| `log_authentication_event` | `event: AuthAuditEvent`（只含结果码/方法，**不含 PIN/生物特征**） | `HubResult<()>` | `Storage` | 认证审计 |
| `log_authorization_event` | `event: AuthzAuditEvent` | `HubResult<()>` | `Storage` | 授权审计 |
| `log_session_event` | `event: SessionAuditEvent` | `HubResult<()>` | `Storage` | 会话审计 |
| `log_security_failure` | `event: SecurityFailureEvent`（脱敏） | `HubResult<()>` | `Storage` | 安全失败审计 |

---

## 8. IPC 命令暴露（新增，经 `bridge.ts`）

| 命令名（camelCase 参数） | 对应方法 | 说明 |
|---|---|---|
| `ph_hub_status` | HealthMonitor | 服务健康 |
| `ph_pairing_create / ph_pairing_confirm / ph_pairing_revoke` | PairingManager | 配对管理（UI 触发） |
| `ph_devices_list / ph_device_revoke` | DeviceManager | 设备管理 |
| `ph_session_request / ph_session_revoke` | SessionManager | 会话管理（本地 UI） |
| `ph_auth_capability` | LocalAuthManager.check_availability | 认证能力查询 |

> 所有命令在 `lib.rs::generate_handler!` 注册；前端类型同步；参数 camelCase（`AGENTS.md` §4.2）。**本地 IPC 仍需鉴权 + 限流**（[06](06-threat-model.md) T15），且本地调用也不能跳过被控端本机认证。
