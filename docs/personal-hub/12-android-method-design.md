# Personal Hub · Android 方法及类职责设计

- 日期：2026-11-19
- 阶段：P0 方法级设计，**已按架构基线对齐**（签名是目标设计，非已实现代码）
- 唯一架构事实源：[ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md)（方法签名以基线 §11.2 为准）
- 前置：[02-current-state-audit.md](02-current-state-audit.md) §2.2、[07-local-auth-design.md](07-local-auth-design.md) §4

> 对齐修订（基线 D3/D5/§5.1/§11.2）：
> 移除 VpnService/WireGuard/Tunnel，改为 `modules/webrtc-transport`；
> 固定 6 个 Kotlin 模块；认证默认 `DEVICE_CREDENTIAL`（非生物识别）；阶段编号统一为 P1–P8。

---

## 0. 实现载体与分层（基线 D3/§5.1）

`apps/mobile` 保留 Expo SDK 58 + RN 0.88.1；原生能力由 Kotlin Expo Modules 桥接，JS/TS 只编排。

| 固定 Kotlin 模块（基线 §5.1） | 职责 | 阶段 |
|---|---|---|
| `modules/local-auth` | Android 本机设备凭据验证 | P5 |
| `modules/device-identity` | Android Keystore 包装的设备身份密钥 | P3 |
| `modules/secure-storage` | Hub 凭据、授权凭证安全存储 | P3 |
| `modules/webrtc-transport` | WebRTC PeerConnection/DataChannel/MediaTrack 原生桥接 | P4 |
| `modules/screen-capture` | MediaProjection + 前台采集服务 | P6（依赖 P5） |
| `modules/input-control` | 会话内 AccessibilityService 输入控制 | P6（依赖 P5） |

JS 编排层 `apps/mobile/src/lib/hub/`：`identity.ts`、`pairing.ts`、`hubClient.ts`、`signaling.ts`、`webrtc.ts`、`localAuth.ts`、`session.ts`、`permissions.ts`、`remoteControl.ts`、`audit.ts`。

> **v1.0 无 VpnService / WireGuard / 虚拟网卡**（D5/D12）。网络连通由 WebRTC P2P + STUN/TURN 承担。

---

## 1. Kotlin `local-auth`（基线 §11.2，P5）

| 方法 | 参数 | 返回 | 职责 |
|---|---|---|---|
| `canAuthenticate` | — | `AuthCapability` | 检测设备凭据可用性（API 28+ BiometricPrompt DEVICE_CREDENTIAL；API 24–27 评估 KeyguardManager 路径） |
| `requestDeviceCredential` | `reason: String, sessionId: String` | `AuthResult` | 系统 `DEVICE_CREDENTIAL` 验证（PIN/密码/图案），只返回结果码 |
| `cancelAuthentication` | `sessionId: String` | `Unit` | 取消认证 |
| `getLastAuthResult` | `sessionId: String` | `AuthResult` | 读取最近结果码 |

> 默认仅设备凭据；生物识别非默认（基线 §5.3）。不自绘输入框、不读取/保存/上传输入内容。

## 2. Kotlin `device-identity`（基线 §11.2，P3）

| 方法 | 参数 | 返回 | 职责 |
|---|---|---|---|
| `createOrLoadIdentity` | — | `DeviceIdentityPublic` | Keystore 包装生成/加载 Ed25519 身份密钥 |
| `signPayload` | `payload: ByteArray` | `Signature` | 设备身份签名 |
| `getFingerprint` | — | `String` | 公钥指纹 |
| `deleteIdentityAfterExplicitReset` | — | `Unit` | 用户显式重置后删除 |

## 3. Kotlin `webrtc-transport`（基线 §11.2，P4，替代原 VpnService 模块）

| 方法 | 参数 | 返回 | 职责 |
|---|---|---|---|
| `createPeerConnection` | `config: IceConfig` | `PeerConnectionId` | 建 PeerConnection；STUN 直连、TURN 回退（UDP→TCP/TLS 443） |
| `createOffer` | `sessionId: String` | `SessionDescription` | 生成 SDP（签名绑定由 JS+控制面完成） |
| `setRemoteDescription` | `sessionId, sdp: SessionDescription` | `Unit` | 设置远端 SDP + DTLS 指纹绑定校验 |
| `addIceCandidate` | `sessionId, candidate: IceCandidate` | `Unit` | 添加 ICE candidate（签名绑定校验） |
| `createDataChannel` | `sessionId, label, options` | `Unit` | 控制通道与文件通道分离 |
| `closePeerConnection` | `sessionId` | `Unit` | 断线/撤销时关闭 |

## 4. Kotlin `screen-capture`（基线 §11.2，P6，依赖 P5）

| 方法 | 参数 | 返回 | 职责 |
|---|---|---|---|
| `requestMediaProjection` | `sessionId: String` | `CapturePermissionResult` | 每次会话独立系统授权 `createScreenCaptureIntent()` |
| `startCapture` | `sessionId, config: CaptureConfig` | `CaptureStatus` | 启动采集 + 活动会话前台服务（持续通知，可立即停止） |
| `stopCapture` | `sessionId: String` | `Unit` | 会话结束立即停止并释放资源 |

## 5. Kotlin `input-control`（基线 §11.2，P6，依赖 P5）

| 方法 | 参数 | 返回 | 职责 |
|---|---|---|---|
| `checkAccessibilityEnabled` | — | `Boolean` | 检测无障碍服务是否已显式启用 |
| `requestAccessibilitySetup` | — | `Unit` | 首次启用显示显著披露与用途说明 |
| `startSessionInput` | `sessionId, scopes: List<String>` | `Unit` | 仅活动授权会话激活 |
| `dispatchTouch` | `sessionId, event: TouchCommand` | `InputResult` | 每条指令绑定 session_id/设备 ID/scope/消息序号 |
| `dispatchKey` | `sessionId, event: KeyCommand` | `InputResult` | 同上；会话外拒绝；系统认证 UI 不得被自动点击 |
| `stopSessionInput` | `sessionId` | `Unit` | 会话结束立即关闭控制能力 |

---

## 6. JS 编排（基线 §11.2）

### PairingRepository（`pairing.ts`）
`scanInvitation(qrPayload)` · `submitPairingRequest(invitation)` · `confirmPeer(peer)` · `completePairing(pairSessionId)` · `revokeDevice(deviceId)`。
配对后只授予 `DEVICE_PAIRED`/`HUB_DISCOVERY`，不授予 REMOTE_CONTROL；PC 本机批准不可绕过。

### RemoteControlService（`remoteControl.ts`，P6 依赖 P5）
`requestSession(targetDeviceId, scopes)` · `verifyControllerIdentity(sessionId)` · `requireLocalDeviceCredential(sessionId)` · `requestScreenCapturePermission(sessionId)` · `startRemoteSession(sessionId)` · `sendControlCommand(sessionId, command)` · `stopRemoteSession(sessionId, reason)`。
**只有 P5 本机认证通过后才允许 startRemoteSession / sendControlCommand。**

---

## 7. 与现有客户端能力的关系

- **复用**：`src/lib/sync/pairing.ts`、`pairClient.ts`、`secureFetch.ts`、`SecureHttpModule.kt`（SPKI 固定）、`src/lib/sync/crypto.ts`、`autoSync.ts`（网络判定）、`src/db/syncConnection.ts`（Keystore 令牌）。
- **新建**：6 个 Kotlin 模块（local-auth/device-identity/secure-storage/webrtc-transport/screen-capture/input-control）+ JS 编排层 `src/lib/hub/`（基线 §5.1）。
- **发布阻断项 R5**：release 用 debug keystore、R8 关闭须在 P8 前修复；正式签名材料由用户安全提供，Agent 不生成伪生产密钥。
- **前台服务例外**（基线 §5.2）：仅活动远控/屏幕采集会话允许持续通知的前台服务，不扩大到普通同步。
