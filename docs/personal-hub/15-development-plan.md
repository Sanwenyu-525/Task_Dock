# Personal Hub v1.0 · 分阶段开发计划

- 日期：2026-11-19
- 阶段：**P0 已完成；按基线 P1–P8 执行**
- 唯一架构事实源：[ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md)（阶段门以基线 §14 为准）
- 执行依据：根目录 `TaskDock_Personal_Hub_Agent_Execution_Prompt.md`

> 修订记录：阶段编号统一为基线 P0–P8；P3 由「加密虚拟网络（WireGuard）」改为「设备身份与二维码配对」；
> P4 改为 WebRTC 私有加密通道；移除 WireGuard 实施；C1–C5 已由基线锁定，不再是待决策项。

---

## 0. 阶段门铁律（基线 §14）

- **P5 本机认证未通过之前，禁止开发或启用 P6 远程输入控制。**
- P1/P2/P3 可在文件所有权不冲突的前提下并行；P4 依赖 P2/P3 接口稳定；P6 依赖 P5。
- 每阶段先验收再进入下一阶段；技术阻塞标 `BLOCKED` 并提交原始证据，不自行换方案。

---

## 1. 阶段总览（对齐基线 §14）

| 阶段 | 工作 | 完成门槛 | 当前状态 |
|---|---|---|---|
| P0 | 架构基线 + 旧 ADR 决策锁定 | 文档状态统一；无 Proposed 分叉 | **已完成** |
| P1 | Windows PersonalHubService 骨架、Named Pipe、进程生命周期 | UI/服务分离；无公网监听；服务异常恢复 | 未开始 |
| P2 | Cloud Control Plane、设备注册、信令、TURN 凭证 | 设备公钥验证、限流、无密码/私钥存储 | 未开始 |
| P3 | 设备身份、二维码配对、PC 本机批准 | 远程分享邀请也不能绕过 PC 批准 | 未开始 |
| P4 | WebRTC P2P、STUN/TURN、Hub RPC/文件 DataChannel | LAN/P2P/TURN 网络矩阵真实通过 | 未开始 |
| P5 | Android Device Credential + Windows Hello/设备 PIN PoC 与 SessionManager | 所有认证失败路径安全关闭 | 未开始 |
| P6 | Android/Windows 屏幕采集与输入控制 | **只有 P5 全通过才允许开发/启用** | 未开始（阻塞于 P5） |
| P7 | 撤销、断线恢复、审计、权限细化 | 撤销即时生效；会话超时销毁 | 未开始 |
| P8 | 安全回归、真机测试、正式构建 | 所有阻断测试通过；release 签名修复 | 未开始 |

---

## 2. 各阶段关键任务与文件所有权

### P1 — Windows Hub 服务（Windows Agent）
- 新建 `src-tauri/src/personal_hub/` 与独立普通用户进程 `taskdock-personal-hub`。
- 当前用户 ACL Named Pipe；主窗口退出不杀 Hub；状态/健康检查/启动/停止/异常恢复。
- 不以 SYSTEM 运行、不监听公网网卡；Rust 单测 + 进程生命周期测试。

### P2 — Cloud Control Plane（Cloud Agent）
- `services/personal-hub-control-plane/`：Node 22 + TS + Fastify 5 + WebSocket + PostgreSQL + coturn + Docker Compose。
- DeviceRegistry / PairingInvitationStore / SignalingGateway / PresenceManager / TurnCredentialIssuer / RevocationRegistry / RateLimiter / AuditMetadataStore。
- 证明服务端不能签发 LocalAuthGrant、不能读私钥或远控内容。

### P3 — 设备身份与配对（三端协同，主 Agent 集成）
- Windows/Android 本地生成 Ed25519 身份密钥；DPAPI / Android Keystore 包装。
- 二维码 5min/一次性/最多 5 次错误尝试；PC 本机批准；双向身份指纹确认。
- 配对只授予 DEVICE_PAIRED / HUB_DISCOVERY，不授予 REMOTE_CONTROL。

### P4 — WebRTC 加密通道（依赖 P2/P3）
- WSS 信令、SDP/ICE 签名绑定、DTLS fingerprint 验证；STUN 直连；TURN UDP 失败尝试 TCP/TLS 443。
- 控制 DataChannel 与文件 DataChannel 分离；TURN 只转密文；真实网络矩阵。

### P5 — 本机强制认证（最关键，阶段门）
- Android DEVICE_CREDENTIAL；Windows Hello/设备 PIN 桌面 PoC（真实 HWND）。
- 认证只在被控端本机、每个新会话要求；LocalAuthGrant 单次/≤60s/绑定 controller+target+session+nonce+scopes。
- 失败/取消/超时/不支持全拒绝；**不允许 App PIN 或远程输入系统密码替代**。
- 完成基线 §15.2 认证测试 + 替换/重放/锁屏测试。**未通过不得进入 P6。**

### P6 — 远控采集与输入（严格依赖 P5 通过）
- Android MediaProjection + 系统授权 + 活动会话前台服务；AccessibilityService 仅活动授权会话执行。
- Windows Graphics Capture + 当前交互桌面输入；禁止安全桌面/锁屏绕过。
- 远控开始/持续/停止入口可见；断线撤销 grant 关闭控制通道。

### P7 — 撤销、恢复、审计
- 设备撤销即时生效；断线重连重新验证会话；会话过期/闲置超时；密钥与凭证清理；审计脱敏。

### P8 — 安全回归与正式构建
- 全部安全/网络矩阵；修复 Android release debug keystore/R8（正式签名材料由用户安全提供，不生成伪生产密钥）。
- 只从集成快照构建正式测试包；报告真实设备/OS/网络/命令/退出码/证据路径/未验证项。

---

## 3. Agent 分工（主 Agent 负责集成，不重新架构）

- **Windows Agent**：仅 `src-tauri/src/personal_hub/`、独立进程、Named Pipe、桌面 IPC、Windows 认证 PoC。
- **Cloud Agent**：仅 `services/personal-hub-control-plane/`、PG schema、Fastify API、WSS 信令、coturn 配置。
- **Android Agent**：仅 `apps/mobile/modules/*`、`apps/mobile/src/lib/hub/*`、配对 UI、Android 认证 PoC。
- **主 Agent**：按基线调度、管理文件所有权、共享接口集成、端到端安全测试、统一构建与验收；跨 Agent 接口冲突按基线裁决。

---

## 4. 提交与集成纪律

- 遵守根 `AGENTS.md` §3：共享工作区、文件所有权、统一集成线；正式安装包只从集成快照构建。
- 开工前/交付前 `git status`；当前未跟踪与未提交文件默认属于其他任务，不覆盖、不清理。
- 不自动 commit/push；不用 `git clean`/`git reset --hard`；不绕过构建调度器。
- 每个阶段/Agent 交付报告含：任务 ID/负责人/模块、精确文件列表、对照基线完成项、真实命令与退出码、测试结果、安全证据、未验证项、BLOCKED 原始证据、依赖接口、**是否偏离架构（必须为"无"）**。
