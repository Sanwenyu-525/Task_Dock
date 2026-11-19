# P3 共享接口契约（三端集成裁决）

- 日期：2026-11-19
- 状态：**P3 实施期契约**。由实现负责人（主 Agent）裁定，三端实现必须一致。
- 权威性：上位依据是 [ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md) §6（设备身份与配对）、§11（方法级）、§12（数据模型）。
  本文件只**细化**基线已确定的流程，不改变任何安全决定；若与基线冲突，以基线为准并立即上报。

---

## 0. 为什么需要本文件

基线 §6.2 规定配对是 **9 步流程**，其中第 4–8 步是服务端与 PC 的交互：

```
4. PC Hub 收到待配对申请。
5. PC UI 显示设备名称、设备类型、公钥指纹和申请时间。
6. 用户在 PC 本机确认。
7. 双方验证对方身份指纹。
8. 完成配对，消费邀请。
9. 配对只授予 DEVICE_PAIRED / HUB_DISCOVERY，不授予 REMOTE_CONTROL。
```

**结论（关键）**：`consumeInvitation` 不得由 Android 单方面调用即视为配对完成。必须存在
`awaiting_pc_approval` 中间状态，只有 **PC 本机批准**后才消费邀请并创建设备记录。
本契约补齐该状态机与端点，属基线 §6.2 的实现细化，不是新架构。

---

## 1. 密码学与编码基线（三端必须逐字节一致）

| 项目 | 规定 |
|---|---|
| 设备身份算法 | Ed25519（签名） |
| 公钥编码 | base64（标准字母表，含 `=` 填充），**raw 32 字节**（非 DER） |
| 指纹 | `SHA-256(raw 32-byte public key)` 的小写 hex，**取前 32 字符** |
| 签名编码 | base64，固定 64 字节 |
| 签名 payload | **canonical JSON**：剔除 `signature` 字段后，对象键按字典序排序、数组保序、剔除 `undefined`/`null` 之外的缺失键；UTF-8 字节 |
| timestamp | UTC ISO-8601（`2026-11-19T04:05:06.000Z`），允许 ±5 分钟时钟偏移 |
| nonce | UUID v4，服务端按 `(deviceId, nonce)` 去重防重放 |
| 设备 ID | UUID v4，**首次运行时本机生成**，不是服务端分配 |

> canonical JSON 的参考实现已在云端落地：`services/personal-hub-control-plane/src/schema/canonical.ts`。
> 三端必须能对同一 body 生成完全相同的字节串；P3 需各端提供**固定测试向量**（见 §5）。

---

## 2. 二维码内容（基线 §6.2）

UTF-8 JSON，Base64URL 编码后放进二维码（避免二维码模式转义问题）。字段：

```jsonc
{
  "v": 1,                          // protocol version
  "cp": "https://hub.example.com", // Control Plane base URL
  "iid": "<invitationId uuid>",    // 邀请 ID
  "sec": "<base64 16-byte secret>",// 一次性邀请密钥
  "nonce": "<uuid>",               // 邀请 nonce
  "exp": "2026-11-19T04:10:06.000Z",// 过期时间（默认 5 分钟）
  "hid": "<hub deviceId uuid>",    // Hub 设备 ID
  "hpk": "<base64 32B hub pubkey>",// Hub 身份公钥
  "hfp": "<hex32 hub fingerprint>",// Hub 指纹（供人工比对）
  "sig": "<base64 64B hub signature>"
}
```

- `sig` 覆盖：`{v, cp, iid, sec, nonce, exp, hid, hpk, hfp}` 的 canonical JSON（剔除 `sig`）。
- **绝对不包含**：设备私钥、长期令牌、远控授权、系统密码。
- 二维码自带 `hpk` 只用于「内容自洽性校验」，**不构成对 Hub 的可信证明**（攻击者可自造一对密钥）。
  真实防中间人依赖 §4 的**双端指纹人工比对** —— 这是基线的既定设计，不得省略该 UI。

---

## 3. 云端配对状态机与端点（P3 扩展）

### 3.1 状态机

```
PairingRequest.status:
  awaiting_pc_approval  --PC approved-->  approved
  awaiting_pc_approval  --PC rejected-->  rejected  (同时邀请置 revoked)
  awaiting_pc_approval  --超过邀请 exp--> expired
```

`PairingInvitation.status` 保持 P2 已实现的 `pending | consumed | expired | revoked`；
**只有 `approved` 才把邀请置 `consumed`**。

### 3.2 新增端点（Cloud Agent 实现）

所有端点沿用 P2 既有约定：`POST` + JSON body + zod `.strict()` + `timestamp`/`nonce`/`signature` +
限流 + 审计；响应错误码沿用 `SecurityError` 编码表。

#### (1) `POST /v1/pairing/request` — Android 提交配对申请

请求体（Android 自签名，签名覆盖除 `signature` 外全部字段）：

```jsonc
{
  "invitationId": "uuid",
  "invitationSecret": "base64(16B)",
  "deviceId": "uuid",
  "deviceType": "android",              // 本阶段仅 android；windows-hub 预留
  "displayName": "Pixel 8",
  "identityPublicKey": "base64(32B)",
  "identityFingerprint": "hex32",
  "timestamp": "ISO",
  "nonce": "uuid",
  "signature": "base64(64B)"
}
```

行为：
1. zod schema 校验（`.strict()`，拒绝任何额外字段）。
2. `assertFresh(timestamp)`。
3. 指纹必须等于 `SHA-256(pubkey)[0..32]`，否则 `FINGERPRINT_MISMATCH`。
4. Ed25519 自签名校验失败 → `INVALID_SIGNATURE`。
5. 邀请必须存在且 `pending`，否则 `INVALID_INVITATION` / `INVITATION_NOT_PENDING`。
6. 邀请过期 → 置 `expired`，返回 `INVITATION_EXPIRED`。
7. `timingSafeEqual(SHA-256(secret), invitation.invitationSecretHash)` 失败 →
   `failedAttempts += 1`，达 `maxInvitationAttempts`(5) 则邀请置 `revoked`；返回 `INVALID_INVITATION`。
8. **限流**：`RateLimiter.checkPairingAttempt('invitation:'+invitationId)` 先于 secret 比对。
9. 同 `deviceId` 已有 pending 请求 → 幂等返回原 `requestId`（不新建）。
10. 创建 `PairingRequest(status='awaiting_pc_approval')`。
11. **不消费邀请、不创建设备、不授予任何能力、不签发任何 grant。**

响应 `201`：`{ ok: true, requestId, status: "awaiting_pc_approval", expiresAt }`

#### (2) `POST /v1/pairing/requests/list` — PC 拉取待批准申请

```jsonc
{ "issuerDeviceId": "uuid", "timestamp": "ISO", "nonce": "uuid", "signature": "base64(64B)" }
```

行为：校验请求者签名与设备存在/未撤销；返回**仅属于该 issuer 邀请**的
`awaiting_pc_approval` 且未过期的请求。

响应：`{ ok: true, requests: [ { requestId, deviceId, deviceType, displayName, identityFingerprint, identityPublicKey, requestedAt, expiresAt } ] }`

#### (3) `POST /v1/pairing/decide` — PC 本机批准/拒绝

```jsonc
{
  "requestId": "uuid",
  "issuerDeviceId": "uuid",
  "approved": true,
  "timestamp": "ISO",
  "nonce": "uuid",
  "signature": "base64(64B)"
}
```

行为：
- 校验请求者（PC）签名、设备未撤销。
- `request.issuerDeviceId` 必须等于 `issuerDeviceId`，否则 `IDENTITY_MISMATCH`。
- 请求必须仍在 `awaiting_pc_approval`，否则 `INVITATION_NOT_PENDING`。
- 邀请必须仍 `pending` 且未过期。
- `approved=true` → 邀请置 `consumed`、`consumedAt=now`；创建设备记录；请求置 `approved`；
  返回 `{ ok: true, status: "approved", device, pairedCapabilities: ["DEVICE_PAIRED","HUB_DISCOVERY"] }`。
- `approved=false` → 请求置 `rejected`、邀请置 `revoked`；返回 `{ ok: true, status: "rejected" }`。
- 两种情况都写审计（`PAIRING_APPROVED` / `PAIRING_REJECTED`），**审计只记 deviceId 与结果，不记公钥正文**。

> 安全红线：`pairedCapabilities` 固定为 `["DEVICE_PAIRED","HUB_DISCOVERY"]`，
> **永远不含 `REMOTE_CONTROL`**，且本端点**不得**产生任何 `LocalAuthGrant`。

#### (4) `POST /v1/pairing/status` — Android 轮询结果

```jsonc
{ "requestId": "uuid", "deviceId": "uuid", "timestamp": "ISO", "nonce": "uuid", "signature": "base64(64B)" }
```

行为：校验请求者签名；`request.deviceId` 必须等于 `deviceId`（否则 `IDENTITY_MISMATCH`）。

响应：
```jsonc
{ "ok": true, "status": "awaiting_pc_approval|approved|rejected|expired",
  "peer": { "deviceId":"uuid", "displayName":"...", "deviceType":"windows-hub", "identityFingerprint":"hex32" } }
```
`peer` 仅在 `approved` 时返回（供手机端展示 PC 指纹做人工比对）。

> 注：WSS 推送 `pairing-request` 事件为可选优化。**v1.0 先实现轮询**（Hub 2s 间隔，
> 仅在配对面板打开时轮询），WSS 事件留到 P4 信令阶段统一做，避免 P3 引入未验证的双通道复杂度。

### 3.3 数据模型（PostgreSQL，基线 §12）

```sql
ph_pairing_requests (
  request_id           uuid primary key,
  invitation_id        uuid not null references ph_pairing_invitations(invitation_id),
  issuer_device_id     uuid not null,
  device_id            uuid not null,
  device_type          text not null,
  display_name         text not null,
  identity_public_key  text not null,   -- base64 32B，仅公钥
  identity_fingerprint text not null,
  status               text not null,   -- awaiting_pc_approval|approved|rejected|expired
  requested_at         timestamptz not null,
  decided_at           timestamptz,
  decided_by           uuid
)
```

索引：`(issuer_device_id, status)`、`(device_id, status)`、`(invitation_id)`。
不得存储：私钥、系统密码、grant 正文、屏幕内容。

---

## 4. PC 本机批准的实现边界（Windows Agent）

- `PairingManager` 必须暴露 `list_pending_requests()` 与 `decide_pairing_request(request_id, approved)`，
  由 Hub 的 Named Pipe API 提供给桌面 UI。
- **P3 不写 Tauri 前端 UI 代码**（`src/` 属共享工作树，由主 Agent 在集成阶段接入）。
  PC 批准能力通过 Named Pipe 可调用即有测试价值；UI 接入在 P3 报告中标「未接入」。
- 批准动作必须记录：`requestId`、`deviceId`、指纹、时间、结果。**不记录公钥正文以外的敏感内容**。

---

## 5. 三端必须产出的测试向量（防止跨端签名不一致）

各端在自己的测试里固化下列向量，字节必须完全一致（用同一份 `contract-vectors.json` 派生）：

```jsonc
{
  "canonicalExample": {
    "input": { "b": 1, "a": "x", "nested": { "z": true, "y": [3,2,1] } },
    "expected": "{\"a\":\"x\",\"b\":1,\"nested\":{\"y\":[3,2,1],\"z\":true}}"
  },
  "fingerprintRule": "hex(sha256(rawPubkey))[0..32]",
  "signatureEncoding": "base64(64 bytes)"
}
```

- Windows（Rust）与 Android（Kotlin）各写一个单测：用固定私钥（seed 全 0x01）签名固定
  payload，断言 signature 的 base64 与云端 `node:crypto` 对同一输入的结果一致。
- 云端已用 `node:crypto` 实现；若三端签名结果不一致，**以 RFC 8032 Ed25519 标准为准**，
  排查 canonical JSON 序列化差异。

---

## 6. Android 设备身份密钥的落地方案（语言/版本事实约束）

**事实**：`AndroidKeyStore` 的 `KeyProperties.KEY_ALGORITHM_ED25519` 仅 API 33+ 提供，
而本项目 `minSdk = 24`。因此不能直接「Keystore 里生成 Ed25519 私钥」。

**裁定的实现路径（信封加密，安全等价，不是降级）**：

1. 在 `AndroidKeyStore` 生成 **AES-256-GCM** 密钥（`setUserAuthenticationRequired(false)`，
   优先 TEE/StrongBox；`setRandomizedEncryptionRequired(true)`）。
2. 在应用进程内生成 Ed25519 密钥对（BouncyCastle / Conscrypt 的 `Ed25519KeyPairGenerator`）。
3. 用 Keystore AES 密钥加密 Ed25519 私钥（32 字节 seed），密文 + IV + 公钥存
   `EncryptedSharedPreferences`（或应用私有文件）。
4. 签名时：Keystore 解密 → 内存中签名 → `Arrays.fill(seed, 0)` 清零。
5. **私钥 seed 绝不出现在 JS 层**：Kotlin 模块只暴露 `sign(payloadBase64)` / `getPublicKey()` /
   `getFingerprint()`，不暴露原始私钥。
6. 密钥不得进入 Android 备份（`android:allowBackup="false"` 已确认需核对；或用
   `android:fullBackupContent` 排除该文件）。

若某设备上 StrongBox/TEE 不可用，AES 密钥退化为软件密钥（仍在 Keystore 保护下），
**必须在报告中标注该设备的实际保护等级**，不得声称硬件保护。

---

## 7. P3 完成定义（DoD）

| 项 | 判定标准 |
|---|---|
| 身份 | 三端均能生成/持久化 Ed25519 身份，私钥不出设备；重启后同一身份 |
| 二维码 | 一次性、5 分钟、5 次错误尝试后失效；过期/重复使用/伪造签名全部拒绝 |
| PC 批准 | 未批准时 Android 停留 `awaiting_pc_approval`；批准后才创建设备；拒绝后邀请失效 |
| 能力边界 | 配对成功返回的能力**不含** `REMOTE_CONTROL`；无任何 grant 产生 |
| 指纹比对 | 双端 UI/协议均提供指纹字段，且测试断言指纹算法三端一致 |
| 撤销 | PC 撤销设备后，该设备后续请求立即被拒 |
| 测试 | 各端单测通过；跨端签名向量一致；云端集成测试覆盖 8 类配对攻击（泄露/过期/重放/暴力/伪造/越权/重复/未批准） |

**未完成即不得进入 P4。**
