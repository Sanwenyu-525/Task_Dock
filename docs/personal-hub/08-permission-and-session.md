# Personal Hub · 权限矩阵与会话状态机

- 日期：2026-11-19，**已按架构基线对齐**
- 唯一架构事实源：[ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md)（权限定义以基线 §9 为准）
- 前置：[07-local-auth-design.md](07-local-auth-design.md)
- 配套：[06-threat-model.md](06-threat-model.md)、[11-windows-method-design.md](11-windows-method-design.md)

> 对齐修订：配对态能力名按基线改为 `DEVICE_PAIRED` / `HUB_DISCOVERY`（不授予 REMOTE_CONTROL）；技能范围 scopes 用基线命名。

---

## 1. 权限矩阵（能力级独立授权）

### 1.1 能力位定义

基线 §9 要求区分以下能力，且每项**独立授权**（不是配对成功即全开）。配对态能力按基线为 `DEVICE_PAIRED` / `HUB_DISCOVERY`：

| 能力位 | 名称 | 风险等级 | 是否需本机认证 | 是否需再次认证(高风险) | 独立授权 |
|---|---|---|---|---|---|
| `DEVICE_PAIRED` / `HUB_DISCOVERY` | 设备配对 / Hub 发现（配对态，**非远控**） | 中 | 否（配对已含） | 否 | 是 |
| `FILE_READ` | 访问文件服务（读） | 中 | 视策略 | 否 | 是 |
| `FILE_WRITE` | 访问文件服务（写） | 高 | 是 | 是 | 是 |
| `SCREEN_VIEW` | 查看屏幕 | 高 | **是（强制）** | 否（会话内已认证） | 是 |
| `INPUT_TOUCH` | 控制鼠标/触摸 | 高 | **是（强制）** | 否 | 是 |
| `INPUT_KEYBOARD` | 键盘输入 | 高 | **是（强制）** | 否 | 是 |
| `CLIPBOARD` | 剪贴板访问 | 高 | **是（强制）** | 是（双向同步高风险） | 是 |
| `AUDIO` | 音频访问 | 中 | 是 | 否 | 是 |
| `DEVICE_MANAGE` | 设备管理（撤销/配置） | 极高 | **是（强制）** | **是** | 是 |

### 1.2 授权裁决规则

- 会话请求携带 `requested_permissions[]`；被控端经本机认证后签发 `LocalAuthGrant.permissions`（请求的子集），**不能放大**。
- 配对/入网只授予 `DEVICE_PAIRED` / `HUB_DISCOVERY`；**绝不授予 REMOTE_CONTROL**。`SCREEN_VIEW` / `INPUT_*` / `CLIPBOARD` / `DEVICE_MANAGE` 必须在每次远控会话经本机认证单独授予（基线 §6.4/§9）。
- `reauth_required = true` 的能力（FILE_WRITE / CLIPBOARD / DEVICE_MANAGE）在执行前需再次触发本机认证。
- 权限不足 → 该项操作被拒并记审计，不降级、不静默放行。

---

## 2. 会话状态机（强制）

### 2.1 状态定义（规格 §2.3 全部 12 态）

| 状态 | 含义 | 进入条件 | 允许的主要迁出 |
|---|---|---|---|
| `IDLE` | 空闲，无会话 | 初始 / 会话结束 | `REQUEST_RECEIVED` |
| `REQUEST_RECEIVED` | 收到会话请求 | 收到含 controller/session/权限/nonce/过期/签名的请求 | `IDENTITY_VERIFIED` / `SESSION_FAILED` |
| `IDENTITY_VERIFIED` | 身份与撤销校验通过 | 验签 + 设备身份 + 撤销表通过 | `LOCAL_AUTH_REQUIRED` / `SESSION_FAILED` |
| `LOCAL_AUTH_REQUIRED` | 强制生成本机认证要求 | 身份校验通过（不可跳过） | `LOCAL_AUTHENTICATING` / `SESSION_FAILED` |
| `LOCAL_AUTHENTICATING` | 系统认证界面进行中 | 唤起 OS 认证 UI | `LOCAL_AUTH_SUCCESS` / `SESSION_FAILED` |
| `LOCAL_AUTH_SUCCESS` | 本机认证成功 | OS 返回成功 | `PERMISSION_GRANTED` / `SESSION_FAILED` |
| `PERMISSION_GRANTED` | 授权凭证签发 + 权限裁决完成 | 签发 LocalAuthGrant | `SESSION_ESTABLISHING` / `SESSION_REVOKED` |
| `SESSION_ESTABLISHING` | 建立加密通道 | 开始协商会话密钥 | `SESSION_ACTIVE` / `SESSION_FAILED` |
| `SESSION_ACTIVE` | 会话活跃 | 通道就绪 | `SESSION_EXPIRED` / `SESSION_REVOKED` / `SESSION_FAILED` |
| `SESSION_EXPIRED` | 会话过期 | grant/会话超时 | 终态 |
| `SESSION_REVOKED` | 会话被撤销 | 用户撤销/设备撤销/断线 | 终态 |
| `SESSION_FAILED` | 安全失败 | 认证失败/权限不足/超时/身份不匹配 | 终态 |

### 2.2 安全失败关闭规则（不可协商）

- 任何认证失败、权限不足、超时、设备身份不匹配 → 直接进入 `SESSION_FAILED` / `SESSION_REVOKED` 终态。
- **不得通过异常处理自动跳过认证**：catch 块不得把 `LOCAL_AUTH_*` 状态推进到 `PERMISSION_GRANTED`；异常只能导向 `SESSION_FAILED`。
- 状态迁移集中在一个 `SessionStateMachine`（被控端），不允许分散在 UI 或网络层各自判断。
- 每次迁移写审计事件（脱敏，见 [06](06-threat-model.md) §2）。

### 2.3 会话生命周期规则

- 断线 → 立即关闭控制通道 + 撤销会话授权（→ `SESSION_REVOKED`），重连需重建会话并重新认证。
- 超时 → `SESSION_EXPIRED`，grant 消费失效。
- 被控端始终拥有最高优先级停止权：用户一键撤销所有授权 → `SESSION_REVOKED`。
- 高风险操作再次认证失败 → 该项操作拒绝（不必终止整个会话，但记审计并可升级为 `SESSION_REVOKED`）。

---

## 3. 会话请求/授权数据结构

```text
SessionRequest {
  controller_device_id, target_device_id, session_id,
  requested_permissions: string[],
  session_nonce, expires_at, controller_signature,
  replay_guard: { sequence, monotonic_counter }
}

LocalAuthGrant {
  grant_id, controller_device_id, controller_identity_fp,
  session_id, session_nonce, permissions: string[],
  auth_method, issued_at, expires_at,
  single_use: true, signature
}
```

> 字段语义与防重放见 [07-local-auth-design.md](07-local-auth-design.md) §2.1、[06-threat-model.md](06-threat-model.md) T11。
