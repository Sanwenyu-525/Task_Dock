# TaskDock Personal Hub v1.0

## PC-first 个人设备中枢：架构决策锁定与安全实施基线

-   文档版本：1.0
-   日期：2026-11-19
-   状态：**架构决策锁定；尚未实现**
-   适用项目：TaskDock Windows 桌面端 + Android 移动端
-   权威级别：本文件是 Personal Hub v1.0
    的唯一实施基线。与旧设计文档、Proposed ADR 冲突时，以本文件为准。
-   核心优先级：**安全 \> 稳定 \> 易用 \> 功能丰富度**

> 本文件由产品负责人/架构负责人预先确定。开发 Agent
> 是实现者，不是架构决策者。Agent
> 不得自行更换协议、认证规则、服务形态、数据边界或开发顺序。遇到技术阻塞必须停止受影响阶段并提交证据，不得擅自设计替代架构。

------------------------------------------------------------------------

# 0. 最终决策摘要（先读）

  ----------------------------------------------------------------------------------------------------------------------------------------------------------
  编号                    已锁定决策              v1.0 执行要求
  ----------------------- ----------------------- ----------------------------------------------------------------------------------------------------------
  D1                      PC-first                Windows 电脑是第一阶段 Personal Hub；Android 手机是接入端。v1.0 不支持脱离电脑的手机---手机独立组网。

  D2                      PC 服务形态             `PersonalHubService` 使用独立、普通用户权限的后台进程；登录自启；关闭主窗口不停止服务；不以 SYSTEM
                                                  权限运行。

  D3                      Android 技术栈          保留现有 Expo SDK 58 + React Native 0.88.1；新增 Kotlin Expo Modules，不另起 App。

  D4                      现有投屏                保留 ADB + scrcpy 作为本地/开发调试能力；新增独立的、强制本机认证的远程控制链路。scrcpy/ADB
                                                  不得成为公网远控通道。

  D5                      v1.0 网络形态           使用应用层私有加密覆盖通道：HTTPS/WSS + WebRTC P2P + STUN/TURN。**v1.0 不安装系统级 WireGuard
                                                  VPN，不分配虚拟网卡 IP。**

  D6                      云端                    必须有 TaskDock 管理的轻量设备发现/信令服务；TURN 作为直连失败的中继。普通用户不配置服务器、端口或公网
                                                  IP。

  D7                      控制数据                WebRTC 视频使用 DTLS-SRTP；控制/文件数据使用 DTLS 加密 DataChannel；TURN 只转发密文。

  D8                      设备身份                每台设备本地生成身份密钥；私钥不出设备。二维码只建立配对申请，不授予远控权。

  D9                      强制本机认证            每次新远控会话，必须在**被控设备本机**完成该设备的系统凭据验证。手机被控就验证手机；电脑被控就验证电脑。

  D10                     密码处理                TaskDock 永远不采集、保存或传输 Android 锁屏密码、Windows 登录密码。使用操作系统提供的设备凭据验证 UI。

  D11                     严格失败关闭            系统认证不可用、认证失败、用户取消、超时、身份不匹配时，拒绝远控；不允许自建密码框或跳过认证。

  D12                     未来扩展                预留 WireGuard 私有 IP 网络和无电脑手机互控接口，但不进入 v1.0，不得由 Agent 擅自提前实施。
  ----------------------------------------------------------------------------------------------------------------------------------------------------------

## 0.1 为什么 v1.0 不直接做 WireGuard 系统 VPN

本阶段的目标是让普通用户无需网络知识，就能安全访问自己的电脑服务、文件和远控能力。完整
WireGuard VPN 会增加 Windows 驱动/服务安装、Android `VpnService`
授权、VPN 冲突、路由与 DNS 管理、NAT 穿透及中继适配等系统级复杂度。

v1.0 先使用 WebRTC 构建**应用层私有加密覆盖通道**，只开放 TaskDock
明确授权的服务，不接管用户全部网络、不创建虚拟网卡、不暴露任意内网端口。它不是通用
IP 层 VPN，不得在产品文案中称为"完整虚拟局域网"。

未来如果用户明确需要 SSH、RDP、任意 TCP/UDP 服务等通用 IP 访问，再以独立
ADR 增加 WireGuard。该扩展必须使用成熟官方实现，不得自研加密协议。

------------------------------------------------------------------------

# 1. 当前项目基线与不可忽略的事实

根据工作区 2026-11-19 代码审计，当前项目事实如下：

  -------------------------------------------------------------------------------------------------------------
  部分                    当前事实                         对本项目的约束
  ----------------------- -------------------------------- ----------------------------------------------------
  Windows 桌面            Tauri 2 + Rust +                 Hub 核心放 Rust，不放 WebView
                          React/TypeScript                 

  Android                 Expo SDK 58 + React Native       系统能力通过 Kotlin Expo Module 桥接
                          0.88.1                           

  现有同步                已有局域网配对、TLS-only、SPKI   优先复用安全模式，不重复造一套同步系统
                          固定、令牌撤销、加密信封         

  现有投屏                ADB + scrcpy                     只保留本地/调试链路，不作为公网远控

  云端                    当前没有设备信令/发现/TURN 服务  需要新增独立 Control Plane

  VPN                     当前没有 WireGuard/VpnService    v1.0 不新增系统 VPN

  Windows 本机认证        当前无已验收 Windows Hello       必须先做 Windows Hello 桌面 PoC
                          远控门禁                         

  Android 本机认证        当前无已验收                     新增 Kotlin 原生模块
                          BiometricPrompt/Device           
                          Credential 门禁                  

  Android 发布签名        当前审计发现 release 使用 debug  生产发布前必须修复；内部开发包不能当正式安全发布包
                          keystore，R8 关闭                
  -------------------------------------------------------------------------------------------------------------

现有审计依据：`docs/personal-hub/02-current-state-audit.md`。所有 Agent
必须先阅读根
`AGENTS.md`、`apps/mobile/AGENTS.md`、`docs/personal-hub/README.md`
和本文件。

## 1.1 现有能力复用原则

复用而不是重写：

-   Windows `mobile_sync` 的配对/撤销/令牌校验流程作为实现参考。
-   Windows TLS + SPKI 固定作为本地服务安全模式参考。
-   Android `SecureHttpModule` 的 TLS/SPKI fail-closed 实现。
-   现有加密信封、Argon2id/HKDF/AES-GCM
    等安全实现作为参考，但不得直接把同步密钥当设备身份密钥。
-   现有 supervisor 生命周期、健康检查、取消/超时/退避机制。
-   现有 ADB + scrcpy 保留，不将其接入新的远控授权链路。

严禁把现有 `http_ingest`（只监听
`127.0.0.1`）改成公网或局域网监听来图省事。

------------------------------------------------------------------------

# 2. 产品范围

## 2.1 v1.0 必须交付

1.  Windows Personal Hub 独立后台进程。
2.  桌面端开启/关闭 Hub、显示状态、展示配对二维码。
3.  Android 扫码加入 Hub，显示可信设备列表。
4.  设备身份密钥、本地安全存储、双向身份验证。
5.  TaskDock 云端设备发现和信令。
6.  WebRTC P2P 连接；直连失败时 TURN 中继。
7.  电脑与手机之间的授权 RPC、文件传输能力。
8.  Android 与 Windows 的本机强制认证。
9.  远控会话状态机、权限矩阵、撤销和审计。
10. Android 被控端屏幕采集与输入控制。
11. Windows 被控端屏幕采集与输入控制。
12. 网络切换、断线恢复、服务异常恢复。
13. 真实设备、跨网络和安全测试报告。

## 2.2 v1.0 明确不做

-   手机 A 与手机 B 在没有 PC 的情况下独立组网/互控。
-   任意 IP 的通用 VPN、虚拟网卡、全局流量接管。
-   公网暴露 ADB、scrcpy、RDP、SSH 或本地 HTTP 端口。
-   无人值守远控、静默解锁、绕过锁屏。
-   通过远程控制端输入被控端系统密码。
-   读取或转发普通电话、微信电话、钉钉电话的通话音频。
-   未经授权的麦克风/摄像头/剪贴板采集。
-   远控 Windows 安全桌面、UAC 安全桌面或登录界面。
-   云端保存屏幕录像、密码、设备私钥或远控会话内容。

------------------------------------------------------------------------

# 3. 总体架构

``` mermaid
flowchart TB
  subgraph CLIENTS["用户设备"]
    PCUI["Windows TaskDock UI<br/>Tauri + React"]
    HUB["PersonalHubService<br/>独立 Rust 进程"]
    ANDROID["Android TaskDock<br/>Expo + RN"]
    NATIVE["Kotlin Native Modules<br/>Local Auth / Capture / Input"]
  end

  subgraph CLOUD["TaskDock 管理的轻量云端"]
    API["Control Plane API<br/>HTTPS + WSS"]
    DB["PostgreSQL<br/>公钥 / 设备元数据 / 邀请 / 会话状态"]
    TURN["coturn<br/>TURN 中继"]
  end

  PCUI <-->|"受 ACL 保护的本地 IPC"| HUB
  ANDROID <-->|"Expo Module Bridge"| NATIVE
  HUB <-->|"出站 WSS / HTTPS"| API
  ANDROID <-->|"出站 WSS / HTTPS"| API
  API <--> DB
  HUB <-->|"WebRTC P2P / TURN fallback"| ANDROID
  HUB -->|"本地受控服务"| PCUI
  NATIVE -->|"OS 授权能力"| ANDROID
  TURN -.->|"只转发加密媒体/数据"| HUB
  TURN -.->|"只转发加密媒体/数据"| ANDROID
```

## 3.1 三个平面

### A. 控制平面（Control Plane）

由 TaskDock 云端负责：

-   设备注册与公钥目录。
-   配对邀请状态。
-   设备在线状态与发现。
-   WebRTC 信令（SDP、ICE candidates）。
-   TURN 临时凭证签发。
-   会话元数据和限流。
-   设备撤销状态同步。

云端不得：

-   保存设备私钥。
-   收集系统密码。
-   生成或签发被控端本地认证授权。
-   直接执行远控指令。
-   解密 WebRTC 媒体或 DataChannel 内容。

### B. 数据平面（Data Plane）

设备之间优先 WebRTC P2P：

-   视频：WebRTC Media Track，DTLS-SRTP。
-   远控指令：独立可靠、有序 DataChannel。
-   文件：独立可靠、有序 DataChannel，分块传输、哈希校验、流控。
-   状态/鼠标轨迹：可使用低延迟通道，但不得承载授权状态。
-   直连失败：TURN relay，只转发加密包。

WebRTC 连接建立前，必须把 DTLS
证书指纹与双方已验证的设备身份绑定，避免信令服务器通过替换 SDP
实施中间人攻击。

### C. 本地执行平面（Execution Plane）

被控设备上的原生代码执行：

-   OS 本机认证。
-   屏幕采集。
-   输入事件注入。
-   文件读写。
-   权限校验。
-   会话撤销。

远端收到的指令不得直接调用系统输入 API；必须先经过本机 `SessionManager`
和 `PermissionManager` 校验。

------------------------------------------------------------------------

# 4. Windows Personal Hub 设计

## 4.1 进程形态

v1.0 采用独立普通用户进程，不使用自研 SYSTEM 权限 Windows Service。

目标：

-   新增独立可执行目标 `taskdock-personal-hub`。
-   核心实现位于 `src-tauri/src/personal_hub/`。
-   由 TaskDock 登录自启机制启动。
-   主窗口关闭后，Hub 进程可继续运行。
-   用户从托盘/设置显式退出 Hub 时，服务才停止。
-   以当前登录用户权限运行。
-   不监听公网网卡。
-   本地管理接口使用当前用户 ACL 保护的 Named Pipe；禁止无鉴权 localhost
    HTTP。
-   Hub 进程与 WebView2 分离，WebView 崩溃不能导致安全状态丢失。
-   Windows 用户注销或电脑休眠时，Hub 不承诺可用；UI
    必须显示离线/休眠状态。

原因：v1.0 远控必须在目标设备本机认证，不需要为了无人值守控制而以 SYSTEM
运行。最小权限优先。

## 4.2 Windows 认证 UI

Windows 本机认证必须由桌面交互层发起：

1.  Hub 收到远控请求。
2.  Hub 验证控制端身份和签名。
3.  Hub 向 Tauri UI 发出 `LocalAuthRequired` 事件。
4.  Tauri UI 确认目标会话仍在当前登录用户交互桌面。
5.  UI 通过原生 Windows API 发起 Windows Hello/设备 PIN 验证。
6.  认证结果返回 Hub。
7.  Hub 本地签发一次性 `LocalAuthGrant`。
8.  Hub 才允许建立控制通道。

优先 PoC：桌面应用使用
`IUserConsentVerifierInterop::RequestVerificationForWindowAsync(HWND, message)`。必须用真实
HWND 验证，不得误用只适用于 UWP 的 `RequestVerificationAsync`。

**Windows 密码边界：** TaskDock 不得创建仿 Windows
登录框，不得收集或传输 Windows 账户密码。使用 Windows Hello/Windows 设备
PIN 的系统验证。若目标系统无法提供符合要求的本机凭据验证，Windows
远控功能必须关闭并报告阻塞，不允许退化成自建 App PIN。

## 4.3 本地服务访问

-   Hub 管理 API 仅通过 Named Pipe 暴露给当前用户。
-   远端请求先经已认证 WebRTC DataChannel 到 Hub，再由 Hub
    路由到受控服务。
-   本地 HTTP 服务如必须存在，只绑定 `127.0.0.1`，使用短时
    token、scope、限流和 Origin 检查。
-   不将 `0.0.0.0` 作为默认监听地址。
-   文件服务使用授权根目录，不允许任意路径访问；防止路径穿越、符号链接逃逸和
    TOCTOU。

------------------------------------------------------------------------

# 5. Android 客户端设计

## 5.1 技术载体

保留 `apps/mobile` 的 Expo SDK 58 + RN 0.88.1。

新增 Kotlin Expo Modules，JS/TS 只做编排，不在 JS 中模拟系统安全能力。

固定模块：

  ---------------------------------------------------------------------------
  模块                                责任
  ----------------------------------- ---------------------------------------
  `modules/local-auth`                Android 本机设备凭据验证

  `modules/screen-capture`            MediaProjection、前台采集服务

  `modules/input-control`             会话内 AccessibilityService 输入控制

  `modules/webrtc-transport`          WebRTC
                                      PeerConnection/DataChannel/MediaTrack
                                      原生桥接

  `modules/device-identity`           Android Keystore 包装的设备身份密钥

  `modules/secure-storage`            Hub 凭据、授权凭证安全存储
  ---------------------------------------------------------------------------

JS 业务层放在 `apps/mobile/src/lib/hub/`：

-   `identity.ts`
-   `pairing.ts`
-   `hubClient.ts`
-   `signaling.ts`
-   `webrtc.ts`
-   `localAuth.ts`
-   `session.ts`
-   `permissions.ts`
-   `remoteControl.ts`
-   `audit.ts`

## 5.2 Android 前台服务例外

现有 `apps/mobile/AGENTS.md`
默认禁止常驻前台服务。本功能获得**严格限定的例外**：

-   只允许在用户主动启动的 VPN/远控会话期间运行所需的前台服务。
-   必须显示持续通知，明确显示"TaskDock 正在远程控制/屏幕共享"。
-   用户可以从通知或 App 立即停止。
-   会话结束后立即停止服务并释放 MediaProjection、输入控制和 WebRTC
    资源。
-   不得用于通用后台同步、轮询或无关业务。
-   不得通过 `BOOT_COMPLETED` 自动恢复屏幕采集。
-   不得在用户未确认时启动屏幕采集。

Android MediaProjection
的系统授权与本机密码认证是两个独立门槛。每次新的屏幕采集会话必须遵循
Android 系统授权和前台服务生命周期。

## 5.3 Android 本机密码认证

用户要求的是被控手机本机输入该手机自己的设备凭据。

v1.0 默认使用 Android 系统 `DEVICE_CREDENTIAL`：

-   PIN
-   锁屏密码
-   图案（系统支持时）

默认不把指纹/人脸作为"输入密码"的替代；若将来允许生物识别，必须作为独立的用户显式选项，不能默认打开。

实现约束：

-   API 28+：优先 AndroidX BiometricPrompt，使用 DEVICE_CREDENTIAL-only
    的系统认证配置。
-   API 24--27：评估
    `KeyguardManager.createConfirmDeviceCredentialIntent()` 兼容路径。
-   每个 API 范围必须真机验证。
-   不自绘 PIN/密码输入框。
-   不读取输入内容。
-   不保存输入内容。
-   不上传认证凭据。
-   只返回成功/失败/取消/超时/不支持的结果码。

认证失败、取消、超时或不支持 → 拒绝会话。

## 5.4 AccessibilityService

-   只用于用户明确启用后的远程控制能力。
-   首次启用必须显示显著披露和用途说明。
-   不提供通用无障碍自动化功能。
-   每条输入指令必须绑定活动 `session_id`、设备 ID、权限
    scope、消息序号。
-   会话外拒绝所有输入。
-   认证 UI、系统安全 UI、受保护窗口不得被自动化点击或绕过。
-   会话结束立即关闭本次控制能力并清理状态。

------------------------------------------------------------------------

# 6. 设备身份与配对协议

## 6.1 设备身份

每台设备首次运行时本地生成：

-   `device_id`：随机 UUID，不作为认证凭证。
-   `identity_keypair`：设备身份签名密钥。
-   `identity_fingerprint`：公钥指纹。
-   `device_name`、`device_type`、`app_version`。

密钥用途必须分离：

  -----------------------------------------------------------------------
  密钥                    用途                    保存
  ----------------------- ----------------------- -----------------------
  设备身份私钥            签名配对/会话请求       Windows DPAPI；Android
                                                  Keystore 包装的加密私钥

  会话临时密钥            单次会话密钥协商        内存，结束即销毁

  WebRTC DTLS 密钥        WebRTC 传输加密         WebRTC 实现管理

  未来 WireGuard 私钥     未来可选 VPN            v1.0 不生成
  -----------------------------------------------------------------------

算法基线：

-   设备身份签名：Ed25519。
-   临时密钥协商：X25519。
-   哈希：SHA-256。
-   KDF：HKDF-SHA-256。
-   认证加密：AES-256-GCM 或已审计的 AEAD 实现。
-   不自行实现密码算法。
-   Rust 侧优先验证 `ed25519-dalek` / `x25519-dalek`
    与当前工具链兼容性。
-   若指定库构建/审计失败，停止并报告，不得自行换算法或复用同步令牌。

## 6.2 二维码邀请

二维码由 Windows Hub 生成，默认有效期 5 分钟、一次性、最多 5
次错误尝试。

内容仅包含：

-   协议版本
-   Control Plane 地址
-   invitation_id
-   128-bit 随机 invitation secret
-   nonce
-   expires_at
-   Hub 设备身份指纹
-   Hub 对邀请内容的签名

绝不包含设备私钥、系统密码、永久令牌或远控授权。

配对流程：

1.  PC Hub 生成一次性邀请并展示二维码。
2.  Android 扫码，生成自己的身份密钥。
3.  Android 通过 Control Plane 提交公钥、设备信息和签名。
4.  PC Hub 收到待配对申请。
5.  PC UI 显示设备名称、设备类型、公钥指纹和申请时间。
6.  用户在 PC 本机确认。
7.  双方验证对方身份指纹。
8.  完成配对，消费邀请。
9.  配对只授予 `DEVICE_PAIRED` / `HUB_DISCOVERY`，不授予
    `REMOTE_CONTROL`。

远程分享二维码允许作为邀请传递方式，但仍要求 PC Hub 在线并由 PC
本机批准。v1.0 不提供绕过 PC 批准的静默远程配对。

## 6.3 撤销

-   用户可在 PC 设备列表撤销任意手机。
-   撤销必须立即拒绝新请求。
-   当前会话主动终止。
-   清除该设备的短期会话凭证。
-   撤销状态写入本机持久化存储并同步云端。
-   离线设备在下次连接时必须先同步撤销状态，不得先恢复远控。

------------------------------------------------------------------------

# 7. 网络、信令与中继

## 7.1 用户体验

普通用户只需要：

1.  PC 点击"启用 Personal Hub"。
2.  手机扫描二维码。
3.  PC 本机批准。
4.  手机按系统提示授权必要权限。
5.  完成。

不得要求用户手动设置公网 IP、DDNS、路由器端口、VPN 配置或 TURN 凭证。

## 7.2 本地网络

同一局域网时：

-   优先使用 PC Hub 的本地 HTTPS 服务。
-   TLS-only。
-   SPKI pinning。
-   设备身份签名。
-   不改变现有 mobile_sync 协议边界。
-   不把原本只监听 loopback 的本地服务改成公网监听。

## 7.3 远程网络

跨城市时：

1.  PC Hub 和 Android 都主动连接 TaskDock Control Plane 的 WSS。
2.  云端验证设备身份和配对状态。
3.  双方交换签名绑定的 SDP/ICE 信息。
4.  使用 ICE/STUN 尝试 P2P。
5.  成功后建立 WebRTC。
6.  P2P 失败时使用 TURN。
7.  TURN 优先 UDP；必要时尝试 TCP/TLS 443。
8.  所有数据保持端到端加密。

电脑不需要公网 IP，也不需要开放家庭路由器入站端口。

## 7.4 Control Plane 技术栈锁定

新增目录：

`services/personal-hub-control-plane/`

技术：

-   Node.js 22 LTS
-   TypeScript
-   Fastify 5
-   WebSocket（Fastify WebSocket 插件）
-   PostgreSQL
-   coturn（独立 TURN 服务）
-   Docker Compose 用于本地开发与集成测试

服务职责：

-   `DeviceRegistry`
-   `PairingInvitationStore`
-   `SignalingGateway`
-   `PresenceManager`
-   `TurnCredentialIssuer`
-   `RevocationRegistry`
-   `RateLimiter`
-   `AuditMetadataStore`

Control Plane 不保存系统密码、设备私钥、媒体内容、文件内容或
`LocalAuthGrant` 明文。

TURN 使用短时凭证，客户端不得内置长期 TURN 密码。

## 7.5 数据保留

-   只保留必要设备公钥、设备元数据、邀请状态、撤销状态和最小会话元数据。
-   SDP/ICE 临时内容只在协商窗口内保存，完成/超时后清除。
-   不保存视频、音频、屏幕截图、文件正文。
-   日志不记录系统密码、私钥、完整 token、授权 grant 或屏幕内容。
-   为排障保留连接结果码、路径类型（LAN/P2P/TURN）、时间和脱敏设备 ID。

------------------------------------------------------------------------

# 8. 远控身份认证与授权（最高安全门槛）

## 8.1 规则

**每次新建远控会话，被控端必须在本机验证该设备自己的系统凭据。**

-   Android 手机被控：在 Android 手机本机输入该手机的锁屏
    PIN/密码/图案。
-   Windows 电脑被控：在 Windows 电脑本机使用 Windows Hello/Windows 设备
    PIN 完成系统验证。
-   不能由控制端远程输入被控端密码。
-   不能由云端代替被控端认证。
-   配对成功不等于远控授权。
-   加入私有连接不等于远控授权。
-   历史会话成功不等于本次授权。

Windows 说明：TaskDock 不收集 Windows 账户密码。Windows Hello/设备 PIN
是系统安全验证。如果当前 Windows
API/系统版本不能提供合规的本机凭据验证，必须关闭 Windows
远控并报告阻塞；不得改成仿系统密码框或自建 App PIN。

## 8.2 强制状态机

``` mermaid
stateDiagram-v2
  [*] --> IDLE
  IDLE --> REQUEST_RECEIVED
  REQUEST_RECEIVED --> IDENTITY_VERIFIED: 控制端签名和设备状态通过
  IDENTITY_VERIFIED --> LOCAL_AUTH_REQUIRED
  LOCAL_AUTH_REQUIRED --> LOCAL_AUTHENTICATING
  LOCAL_AUTHENTICATING --> LOCAL_AUTH_SUCCESS: 被控端系统认证成功
  LOCAL_AUTHENTICATING --> SESSION_FAILED: 失败/取消/超时/不支持
  LOCAL_AUTH_SUCCESS --> PERMISSION_GRANTED: 本机权限裁决
  PERMISSION_GRANTED --> SESSION_ESTABLISHING
  SESSION_ESTABLISHING --> SESSION_ACTIVE
  SESSION_ACTIVE --> SESSION_EXPIRED
  SESSION_ACTIVE --> SESSION_REVOKED
  SESSION_ACTIVE --> SESSION_FAILED
  SESSION_FAILED --> [*]
  SESSION_EXPIRED --> [*]
  SESSION_REVOKED --> [*]
```

禁止任何跳过 `LOCAL_AUTH_REQUIRED` 的状态迁移。

## 8.3 LocalAuthGrant

认证成功后，只在被控端本机生成：

``` text
LocalAuthGrant {
  grant_id,
  controller_device_id,
  target_device_id,
  controller_identity_fingerprint,
  session_id,
  session_nonce,
  permission_scopes[],
  auth_method,
  issued_at,
  expires_at,
  single_use = true,
  local_signature
}
```

约束：

-   有效期不超过 60 秒，且必须在当前会话中消费。
-   单次使用。
-   绑定 controller、target、session、nonce 和权限。
-   不得发送到云端作为可复用凭证。
-   不得跨设备/跨会话复用。
-   认证成功后若控制端身份、会话 ID 或权限集合发生变化，grant 立即失效。
-   认证取消/失败不生成 grant。

## 8.4 会话时限

v1.0 默认策略：

-   一次本机认证只授权一个新会话。
-   单次会话最长 15 分钟。
-   连续无输入/无活动 5 分钟自动暂停并要求重新认证。
-   高风险权限（文件写入、剪贴板读取、设备管理）独立确认或再次认证。
-   被控端随时可以立即停止。
-   连接中断超过 30
    秒，关闭控制通道并销毁当前授权；恢复连接必须重新发起会话和本机认证。

------------------------------------------------------------------------

# 9. 权限矩阵

配对、网络连接、服务访问和远控权限必须分开。

  ---------------------------------------------------------------------------------------
  权限                默认              是否需要本机认证   说明
  ------------------- ----------------- ------------------ ------------------------------
  `DEVICE_PAIRED`     配对后允许        配对批准           只代表可信设备关系

  `HUB_STATUS_READ`   允许              否                 读取 Hub 状态

  `FILE_READ`         关闭              是/独立授权        仅授权目录

  `FILE_WRITE`        关闭              是/独立授权        写入需明确确认

  `SCREEN_VIEW`       关闭              **每次会话必须**   屏幕查看

  `INPUT_CONTROL`     关闭              **每次会话必须**   触摸/鼠标

  `KEYBOARD_INPUT`    关闭              **每次会话必须**   键盘输入

  `CLIPBOARD_READ`    关闭              是                 单独授权，不默认读取

  `CLIPBOARD_WRITE`   关闭              是                 单独授权

  `AUDIO_CAPTURE`     关闭              是                 v1.0 不作为默认远控能力

  `DEVICE_ADMIN`      关闭              不允许远程授予     不通过远控获取系统管理员权限
  ---------------------------------------------------------------------------------------

用户在 PC 和手机两端都能查看授权范围、撤销设备和终止会话。

------------------------------------------------------------------------

# 10. 远控实现边界

## 10.1 Android 被控端

-   屏幕采集：MediaProjection。
-   采集授权：每次新会话独立调用 Android 系统授权。
-   前台服务：仅在活动采集/远控会话期间运行，显示持续通知。
-   输入：用户显式启用 AccessibilityService 后，在活动 session 内执行。
-   锁屏：不得绕过。被控手机必须本机解锁并通过凭据验证。
-   `FLAG_SECURE`、DRM、安全界面等受保护内容可能不可采集/不可操作，必须显示限制。
-   系统认证 UI 不得被远程输入自动点击。

## 10.2 Windows 被控端

-   屏幕采集：优先 Windows Graphics Capture；先做目标 Windows 版本 PoC。
-   输入：仅在当前用户交互桌面内使用受控输入接口。
-   不提权运行输入注入。
-   不操作 UAC 安全桌面、登录桌面、Ctrl+Alt+Del 安全路径。
-   目标 PC 锁屏、用户注销或没有可交互桌面时，远控失败关闭。
-   Windows Hello/设备 PIN 本机认证必须先于屏幕和输入通道启动。

## 10.3 音频与电话

v1.0 不承诺远程接管普通电话、微信电话或钉钉电话的通话音频。

可以尝试在允许的应用界面中执行普通 UI
操作，但不得宣称能够捕获或转发系统通话音频、绕过 Android
音频策略或使用远端麦克风替代被控设备麦克风。

------------------------------------------------------------------------

# 11. 方法级模块设计

以下是固定职责和命名基线。Agent
可按现有代码风格调整私有辅助函数，但不得改变模块边界和安全语义。

## 11.1 Windows Rust

根目录：`src-tauri/src/personal_hub/`

### `PersonalHubService`

-   `start(config: HubConfig) -> HubResult<HubStatus>`
-   `stop(reason: StopReason) -> HubResult<()>`
-   `get_status() -> HubResult<HubStatus>`
-   `run_health_check() -> HubResult<HealthReport>`
-   `recover_after_failure() -> HubResult<RecoveryResult>`

### `DeviceManager`

-   `register_device(registration: DeviceRegistration) -> HubResult<DeviceId>`
-   `get_device_by_id(device_id: &DeviceId) -> HubResult<Option<PairedDevice>>`
-   `list_paired_devices() -> HubResult<Vec<PairedDevice>>`
-   `revoke_device(device_id: &DeviceId, reason: RevokeReason) -> HubResult<()>`
-   `verify_device_signature(device_id: &DeviceId, payload: &[u8], signature: &[u8]) -> HubResult<()>`

### `IdentityManager`

-   `initialize_identity() -> HubResult<DeviceIdentity>`
-   `load_identity() -> HubResult<DeviceIdentity>`
-   `sign_payload(payload: &[u8]) -> HubResult<Signature>`
-   `verify_peer_signature(public_key: &[u8], payload: &[u8], signature: &[u8]) -> HubResult<()>`
-   `get_fingerprint() -> HubResult<Fingerprint>`
-   `rotate_identity_key(reason: RotationReason) -> HubResult<()>`

### `PairingManager`

-   `create_pairing_invitation(ttl: Duration) -> HubResult<PairingInvitation>`
-   `validate_invitation(invitation: &PairingInvitation) -> HubResult<InvitationClaims>`
-   `accept_pairing_request(request: PairRequest) -> HubResult<PairSessionId>`
-   `confirm_peer_identity(session_id: &PairSessionId, approved: bool) -> HubResult<()>`
-   `finalize_pairing(session_id: &PairSessionId) -> HubResult<PairedDevice>`
-   `revoke_invitation(invitation_id: &InvitationId) -> HubResult<()>`

### `PermissionManager`

-   `get_device_permissions(device_id: &DeviceId) -> HubResult<PermissionSet>`
-   `authorize_scope(device_id: &DeviceId, scope: PermissionScope) -> HubResult<()>`
-   `grant_scopes(session_id: &SessionId, scopes: &[PermissionScope]) -> HubResult<PermissionSet>`
-   `revoke_scopes(session_id: &SessionId, scopes: &[PermissionScope]) -> HubResult<()>`

### `LocalAuthManager`

-   `check_windows_auth_capability(hwnd: HWND) -> HubResult<LocalAuthCapability>`
-   `request_windows_device_credential(hwnd: HWND, reason: &str, session_id: &SessionId) -> HubResult<AuthResult>`
-   `issue_local_auth_grant(context: GrantContext) -> HubResult<LocalAuthGrant>`
-   `validate_local_auth_grant(grant: &LocalAuthGrant, expected: &GrantContext) -> HubResult<()>`
-   `consume_local_auth_grant(grant_id: &GrantId) -> HubResult<()>`
-   `revoke_local_auth_grant(grant_id: &GrantId) -> HubResult<()>`

### `SessionManager`

-   `request_remote_session(request: SessionRequest) -> HubResult<SessionId>`
-   `validate_controller_identity(session_id: &SessionId) -> HubResult<()>`
-   `require_local_authentication(session_id: &SessionId) -> HubResult<AuthChallenge>`
-   `authorize_session(session_id: &SessionId, grant: LocalAuthGrant) -> HubResult<PermissionSet>`
-   `create_session(session_id: &SessionId) -> HubResult<SessionHandle>`
-   `revoke_session(session_id: &SessionId, reason: RevokeReason) -> HubResult<()>`
-   `expire_session(session_id: &SessionId) -> HubResult<()>`
-   `terminate_session(session_id: &SessionId, reason: TerminationReason) -> HubResult<()>`

### `SignalingClient`

-   `connect(control_plane: ControlPlaneConfig) -> HubResult<()>`
-   `register_device() -> HubResult<()>`
-   `publish_presence() -> HubResult<()>`
-   `send_offer(session_id: &SessionId, offer: SignedSdp) -> HubResult<()>`
-   `send_ice_candidate(session_id: &SessionId, candidate: SignedIceCandidate) -> HubResult<()>`
-   `handle_signaling_message(message: SignalingMessage) -> HubResult<()>`
-   `disconnect() -> HubResult<()>`

### `WebRtcSessionManager`

-   `create_peer_connection(session_id: &SessionId, ice_config: IceConfig) -> HubResult<PeerConnectionHandle>`
-   `bind_dtls_fingerprint(session_id: &SessionId, peer_fingerprint: Fingerprint) -> HubResult<()>`
-   `open_control_data_channel(session_id: &SessionId) -> HubResult<DataChannelHandle>`
-   `open_file_data_channel(session_id: &SessionId) -> HubResult<DataChannelHandle>`
-   `attach_screen_track(session_id: &SessionId, track: ScreenTrack) -> HubResult<()>`
-   `close_peer_connection(session_id: &SessionId) -> HubResult<()>`

### `AuditLogger`

-   `log_pairing_event(event: PairingAuditEvent) -> HubResult<()>`
-   `log_authentication_event(event: AuthAuditEvent) -> HubResult<()>`
-   `log_authorization_event(event: AuthorizationAuditEvent) -> HubResult<()>`
-   `log_session_event(event: SessionAuditEvent) -> HubResult<()>`
-   `log_security_failure(event: SecurityFailureEvent) -> HubResult<()>`

## 11.2 Android Kotlin + JS

Kotlin modules under `apps/mobile/modules/`:

### `local-auth`

-   `canAuthenticate(): AuthCapability`
-   `requestDeviceCredential(reason: String, sessionId: String): AuthResult`
-   `cancelAuthentication(sessionId: String): Unit`
-   `getLastAuthResult(sessionId: String): AuthResult`

### `device-identity`

-   `createOrLoadIdentity(): DeviceIdentityPublic`
-   `signPayload(payload: ByteArray): Signature`
-   `getFingerprint(): String`
-   `deleteIdentityAfterExplicitReset(): Unit`

### `webrtc-transport`

-   `createPeerConnection(config: IceConfig): PeerConnectionId`
-   `createOffer(sessionId: String): SessionDescription`
-   `setRemoteDescription(sessionId: String, sdp: SessionDescription): Unit`
-   `addIceCandidate(sessionId: String, candidate: IceCandidate): Unit`
-   `createDataChannel(sessionId: String, label: String, options: DataChannelOptions): Unit`
-   `closePeerConnection(sessionId: String): Unit`

### `screen-capture`

-   `requestMediaProjection(sessionId: String): CapturePermissionResult`
-   `startCapture(sessionId: String, config: CaptureConfig): CaptureStatus`
-   `stopCapture(sessionId: String): Unit`

### `input-control`

-   `checkAccessibilityEnabled(): Boolean`
-   `requestAccessibilitySetup(): Unit`
-   `startSessionInput(sessionId: String, scopes: List<String>): Unit`
-   `dispatchTouch(sessionId: String, event: TouchCommand): InputResult`
-   `dispatchKey(sessionId: String, event: KeyCommand): InputResult`
-   `stopSessionInput(sessionId: String): Unit`

JS/TS orchestration methods:

### `PairingRepository`

-   `scanInvitation(qrPayload: string): Promise<PairingInvitation>`
-   `submitPairingRequest(invitation: PairingInvitation): Promise<PairingRequestResult>`
-   `confirmPeer(peer: PeerIdentity): Promise<void>`
-   `completePairing(pairSessionId: string): Promise<PairedDevice>`
-   `revokeDevice(deviceId: string): Promise<void>`

### `RemoteControlService`

-   `requestSession(targetDeviceId: string, scopes: PermissionScope[]): Promise<SessionId>`
-   `verifyControllerIdentity(sessionId: string): Promise<void>`
-   `requireLocalDeviceCredential(sessionId: string): Promise<LocalAuthResult>`
-   `requestScreenCapturePermission(sessionId: string): Promise<CapturePermissionResult>`
-   `startRemoteSession(sessionId: string): Promise<void>`
-   `sendControlCommand(sessionId: string, command: ControlCommand): Promise<void>`
-   `stopRemoteSession(sessionId: string, reason: string): Promise<void>`

## 11.3 Cloud TypeScript

Directory：`services/personal-hub-control-plane/src/`

-   `DeviceRegistry.registerDevice()`
-   `DeviceRegistry.getDevice()`
-   `DeviceRegistry.revokeDevice()`
-   `PairingInvitationStore.createInvitation()`
-   `PairingInvitationStore.consumeInvitation()`
-   `SignalingGateway.connectDevice()`
-   `SignalingGateway.forwardSignedSignal()`
-   `PresenceManager.updatePresence()`
-   `PresenceManager.getPresence()`
-   `TurnCredentialIssuer.issueEphemeralCredentials()`
-   `RevocationRegistry.publishRevocation()`
-   `RateLimiter.checkPairingAttempt()`
-   `RateLimiter.checkSignalingRate()`

所有云端接口必须有 schema 校验、设备签名校验、速率限制、过期时间和审计。

------------------------------------------------------------------------

# 12. 数据模型与接口约束

核心实体：

``` text
Device {
  device_id,
  device_type,
  display_name,
  identity_public_key,
  identity_fingerprint,
  created_at,
  last_seen_at,
  revoked_at
}

PairingInvitation {
  invitation_id,
  issuer_device_id,
  invitation_secret_hash,
  nonce,
  created_at,
  expires_at,
  consumed_at,
  failed_attempts,
  status
}

RemoteSession {
  session_id,
  controller_device_id,
  target_device_id,
  requested_scopes,
  granted_scopes,
  session_nonce,
  created_at,
  expires_at,
  status
}

LocalAuthGrant {
  grant_id,
  controller_device_id,
  target_device_id,
  session_id,
  session_nonce,
  granted_scopes,
  auth_method,
  issued_at,
  expires_at,
  consumed_at,
  local_signature
}
```

数据约束：

-   不存私钥。
-   不存系统密码。
-   不存生物特征。
-   不存明文 invitation secret；只存哈希。
-   不存可长期复用的 TURN 密码。
-   不把 LocalAuthGrant 存成永久授权。
-   所有时间使用 UTC。
-   所有撤销记录可审计。
-   SQLite 迁移 append-only；不修改已发布迁移。
-   新表必须登记备份策略；私钥和敏感授权数据不得进入普通备份。

------------------------------------------------------------------------

# 13. 安全威胁模型与强制防护

至少覆盖以下攻击：

  ---------------------------------------------------------------------------------
  攻击                                必须防护
  ----------------------------------- ---------------------------------------------
  网络监听                            TLS 1.3、WebRTC DTLS-SRTP、DataChannel
                                      DTLS、设备身份签名

  中间人替换 SDP                      签名绑定 SDP/DTLS fingerprint/双方设备
                                      ID/session nonce

  二维码泄露                          5 分钟 TTL、一次性、最多 5 次尝试、PC
                                      本机批准

  第三台设备冒充                      私钥签名、设备公钥绑定、撤销表

  历史会话重放                        nonce、单调序号、session_id、短期单次 grant

  信令服务器被攻破                    无私钥、无授权签发能力、无法解密 WebRTC 内容

  TURN 被攻破                         只转发密文，无 DTLS/会话密钥

  控制端被盗                          被控端每次会话强制本机认证、设备撤销

  被控端被盗                          OS 锁屏凭据、本机认证、撤销

  IPC 被本机恶意程序调用              Named Pipe ACL、scope、签名校验、限流

  AccessibilityService 滥用           仅活动 session、会话绑定、会话外拒绝

  断线后继续控制                      断线关闭通道、grant 销毁、重连重新认证

  日志泄密                            禁止记录密码、私钥、完整令牌、屏幕/文件正文
  ---------------------------------------------------------------------------------

安全失败关闭（Fail
Closed）是硬要求：任何无法确认身份、权限、会话或认证状态的情况，都拒绝执行。

------------------------------------------------------------------------

# 14. 分阶段开发计划与阶段门

  ------------------------------------------------------------------------------------------------
  阶段                    工作                             完成门槛
  ----------------------- -------------------------------- ---------------------------------------
  P0                      本架构文档、旧 ADR 决策锁定      文档状态统一；无 Proposed 架构分叉

  P1                      Windows PersonalHubService       UI/服务分离；无公网监听；服务异常恢复
                          骨架、Named Pipe、生命周期       

  P2                      Cloud Control                    设备公钥验证、限流、无密码/私钥存储
                          Plane、设备注册、信令、TURN 凭证 

  P3                      Android 设备身份、二维码配对、PC 远程分享邀请也不能绕过 PC 批准
                          批准                             

  P4                      WebRTC P2P、STUN/TURN、Hub       LAN/P2P/TURN 网络矩阵真实通过
                          RPC/文件 DataChannel             

  P5                      Android Device Credential +      所有认证失败路径安全关闭
                          Windows Hello/设备 PIN PoC 与    
                          SessionManager                   

  P6                      Android/Windows                  只有 P5 全通过才允许开发/启用
                          屏幕采集与输入控制               

  P7                      撤销、断线恢复、审计、权限细化   撤销即时生效；会话超时销毁

  P8                      安全回归、真机测试、正式构建     所有阻断测试通过；release 签名修复
  ------------------------------------------------------------------------------------------------

**阶段门铁律：P5 本机认证未通过之前，不得开发或启用 P6 远程输入控制。**

P1/P2/P3 可在文件所有权不冲突的前提下并行；P4 依赖 P2/P3；P6 依赖 P5。

------------------------------------------------------------------------

# 15. 强制验收清单

## 15.1 配对

-   同一局域网扫码。
-   远程分享二维码。
-   过期二维码。
-   重复二维码。
-   邀请码猜测/暴力尝试。
-   第三台设备抢先消费邀请。
-   PC 未批准时配对失败。
-   撤销设备后旧设备无法重连。

## 15.2 本机认证

Android： - 正确设备 PIN/密码/图案。 - 错误凭据。 - 用户取消。 -
超时。 - 无设备凭据。 - 手机锁屏时发起请求。 - MediaProjection
拒绝授权。 - AccessibilityService 未启用。 - 认证后更换 session_id 或
controller_id。

Windows： - Windows Hello/设备 PIN 正常。 - 认证取消。 - 未配置
Hello/PIN。 - API 不可用。 - 目标电脑锁屏。 - 用户注销。 -
UAC/安全桌面。 - 认证后替换控制端或会话 ID。

**任何本机认证未通过的测试，都必须证明没有产生可用的控制通道。**

## 15.3 通信安全

-   抓包确认没有明文系统密码。
-   日志和数据库扫描确认无私钥/密码/完整 grant。
-   信令服务伪造 SDP。
-   TURN 注入/篡改数据。
-   历史控制指令重放。
-   nonce 重复。
-   消息序号回退。
-   已撤销设备发起请求。
-   控制端身份中途替换。
-   会话过期后继续发指令。
-   网络断开后旧 DataChannel 不再执行指令。

## 15.4 网络

-   同一 Wi-Fi。
-   不同 Wi-Fi。
-   家庭宽带 + 4G/5G。
-   CGNAT。
-   双 NAT。
-   不同运营商。
-   IPv4。
-   IPv6。
-   UDP 受限。
-   TURN UDP。
-   TURN TCP/TLS 443。
-   Wi-Fi 与 5G 切换。
-   PC 休眠/唤醒。
-   PC 重启。
-   云端不可用。

每项必须记录设备型号、OS
版本、网络类型、连接路径、成功/失败、延迟、日志和时间。未实测不得标记通过。

------------------------------------------------------------------------

# 16. Agent 执行纪律（不可越权）

1.  本文件是架构唯一事实源；Agent 不得重新规划。
2.  不得将 v1.0 WebRTC 应用层覆盖通道改成 WireGuard/Tailscale/其他 VPN。
3.  不得改成用户自建服务器或要求普通用户手动配置公网 IP。
4.  不得取消被控端本机凭据认证。
5.  不得增加 App PIN 作为 Windows/Android 系统凭据的自动降级。
6.  不得把生物识别默认替代用户要求的设备 PIN/密码。
7.  不得让云端签发 LocalAuthGrant。
8.  不得让 TURN 解密数据。
9.  不得暴露 ADB/scrcpy 或本地 API 到公网。
10. 不得为了兼容性绕过锁屏、MediaProjection 或 AccessibilityService
    用户授权。
11. 不得在 P5 未通过时实现/启用 P6 输入控制。
12. 技术 PoC 只验证本文件指定方案；PoC 失败时标记 `BLOCKED`
    并提交证据，不得自行替换架构。
13. 不得更改其他 Agent 未声明拥有的文件；遵守根 `AGENTS.md`
    的共享工作区、Git、Worktree、构建调度和集成流程。
14. 不得自动 commit/push，不得 `git reset --hard`、`git clean`
    或覆盖他人未提交文件。
15. 每个阶段提交代码路径、真实命令、退出码、测试结果、未验证项、风险和证据路径。
16. 文档只能更新"实现状态/测试证据/已知限制"；任何架构变更必须由用户明确批准并新增
    ADR。

------------------------------------------------------------------------

# 17. 现有文档的处理规则

工作区已有 `docs/personal-hub/`
文档集。保留其代码审计、威胁模型、方法级设计和测试细节。

本文件新增后，按以下方式统一：

-   本文件为最终架构决策源。
-   `00-phase0-verdict.md` 不再要求用户回答
    C1--C5；改为记录本文件已锁定的决策。
-   `03-architecture.md`、`04-network-topology.md`、`07-local-auth-design.md`、`15-development-plan.md`
    的冲突内容必须按本文件修订。
-   ADR-0001：Accepted，保持。
-   ADR-0002：改为 Accepted 的严格系统凭据策略；删除 `TD_LOCAL_GRANT`
    自动降级路径。
-   ADR-0003：Accepted，保留 scrcpy 本地/调试栈并新增认证远控栈。
-   ADR-0004：Accepted，保留 Expo/RN，新增 Kotlin
    Modules；生产签名为发布阻断项。
-   ADR-0005：Accepted，v1.0 使用普通用户独立进程，不自建 SYSTEM Windows
    Service。
-   ADR-0006：标记为 Superseded/Deferred；WireGuard 不属于 v1.0。
-   ADR-0007：Accepted，TaskDock Control Plane +
    STUN/TURN；云端只协调/中继，不持有私钥和授权权力。

不要删除已有审计证据或历史验收报告。

------------------------------------------------------------------------

# 18. 完成定义

只有满足以下条件，才能宣称 Personal Hub v1.0 完成：

-   普通用户无需配置公网 IP、端口或 VPN。
-   Windows PC 可以作为独立后台 Personal Hub。
-   Android 可扫码安全加入。
-   远程网络可通过 P2P 或 TURN 建立加密连接。
-   云端和 TURN 无法解密设备之间的远控内容。
-   每次远控都必须在被控设备本机通过设备凭据认证。
-   不输入被控设备本机凭据就无法执行任何远控操作。
-   设备撤销、会话过期、断线后旧授权立即失效。
-   现有同步、剪贴板、文件、scrcpy 等功能没有被破坏。
-   安全测试、网络测试和真实设备测试都有证据。
-   所有未验证项如实列出，没有用"理论上可行"冒充完成。

**最终产品承诺：TaskDock
让普通用户轻松连接自己的设备，但绝不让二维码、IP、设备
ID、云端账户或历史配对关系变成远程控制的万能钥匙。**
