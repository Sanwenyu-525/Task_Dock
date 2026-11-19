# TaskDock Personal Hub v1.0｜实现执行提示词（禁止 Agent 重新架构）

你现在是 TaskDock Personal Hub v1.0
的实现负责人。你不是本功能的产品架构师，也没有重新设计架构的权限。

## 一、先读取权威文件

必须先读取： 1. 根目录 `AGENTS.md` 2. `apps/mobile/AGENTS.md` 3.
`docs/personal-hub/README.md` 4.
`docs/personal-hub/02-current-state-audit.md` 5.
`docs/personal-hub/06-threat-model.md` 6.
`docs/personal-hub/07-local-auth-design.md` 7.
`docs/personal-hub/11-windows-method-design.md` 8.
`docs/personal-hub/12-android-method-design.md` 9.
`docs/personal-hub/14-test-plan.md` 10. 产品负责人提供的《TaskDock
Personal Hub v1.0 PC-first 架构决策锁定与安全实施基线》。

第 10 项是唯一架构事实源。旧文档与它冲突时，以第 10 项为准，并按其第 17
节更新旧 ADR/设计文档。不得让子 Agent 重新分析并选择架构。

## 二、你的权限边界

你可以： - 按架构实现代码。 - 编写单元、集成和安全测试。 -
做架构指定技术的可行性 PoC。 - 修复实现错误。 -
更新实现状态、测试证据和已知限制。 - 把无法完成的技术项标记 BLOCKED
并提交证据。

你不可以： - 重新设计产品架构。 - 更换 WebRTC/Control
Plane/本机认证策略。 - 将 v1.0 改成 WireGuard/Tailscale/VPN 方案。 -
取消或降级被控端本机凭据认证。 - 增加 App PIN 作为系统凭据的自动降级。 -
让云端签发本机认证授权。 - 让 TURN 解密远控数据。 - 把 ADB/scrcpy
暴露到公网。 - 为了开发方便放宽锁屏、MediaProjection 或
AccessibilityService 限制。 -
擅自改其他模块、依赖、构建配置或他人未提交文件。

遇到架构指定技术无法落地时：停止受影响任务，给出 PoC
命令、错误日志、环境信息、已尝试步骤和阻塞原因；不要自行换方案。

## 三、实现顺序

严格按基线阶段门执行：

### P0：文档决策锁定

-   将架构基线放入 `docs/personal-hub/` 并作为唯一决策源。
-   按基线第 17 节更新旧 ADR 状态和冲突段落。
-   不改写历史验收报告。
-   这一步只做文档对齐，不重新设计。

### P1：Windows PersonalHubService

-   新建 `src-tauri/src/personal_hub/` 模块。
-   建立独立普通用户进程。
-   Named Pipe 使用当前用户 ACL。
-   主窗口退出不杀 Hub。
-   实现状态查询、健康检查、启动、停止和异常恢复。
-   不以 SYSTEM 运行，不监听公网网卡。
-   完成 Rust 单测和进程生命周期测试。

### P2：Cloud Control Plane

-   在 `services/personal-hub-control-plane/` 建立 Node 22 +
    TypeScript + Fastify 5 服务。
-   实现
    DeviceRegistry、PairingInvitationStore、SignalingGateway、PresenceManager、TurnCredentialIssuer、RevocationRegistry、RateLimiter。
-   PostgreSQL 只保存公钥和最小元数据。
-   coturn 使用短时凭证。
-   实现 Docker Compose 本地开发环境。
-   测试服务端不能签发 LocalAuthGrant，不能读取私钥或远控内容。

### P3：设备身份与配对

-   Windows/Android 本地生成设备密钥。
-   私钥分别使用 DPAPI / Android Keystore 包装保护。
-   二维码一次性、短时有效。
-   PC 本机批准。
-   双向身份指纹确认。
-   配对只授予 DEVICE_PAIRED，不授予远控。
-   覆盖二维码泄露、过期、重放、暴力尝试和撤销测试。

### P4：WebRTC 私有加密通道

-   实现 WSS 信令、SDP/ICE 签名绑定、DTLS fingerprint 验证。
-   ICE/STUN 直连。
-   TURN UDP 失败后尝试 TCP/TLS 443。
-   控制 DataChannel 与文件 DataChannel 分离。
-   TURN 只转发密文。
-   真实测试 LAN、不同运营商、CGNAT、双 NAT、UDP 受限网络。
-   不宣称实现通用 IP VPN。

### P5：本机凭据认证与会话授权

-   Android：系统 DEVICE_CREDENTIAL。
-   Windows：Windows Hello/设备 PIN 桌面 PoC。
-   认证只在被控端本机完成。
-   每个新会话都要求认证。
-   LocalAuthGrant 单次、短时、绑定
    controller/target/session/nonce/scopes。
-   失败/取消/超时/不支持全部拒绝。
-   不允许 App PIN 或远程输入系统密码替代。
-   完成 A1--A10 和身份替换/重放/锁屏测试。

**P5 未通过之前，禁止开发或启用 P6 远控输入控制。**

### P6：远控采集与输入

-   Android MediaProjection + 用户系统授权 + 活动会话前台服务。
-   AccessibilityService 仅在活动授权会话执行。
-   Windows Graphics Capture + 当前交互桌面输入。
-   禁止安全桌面/锁屏绕过。
-   远控开始/持续状态/停止入口必须可见。
-   连接中断后撤销 grant、关闭控制通道。

### P7：撤销、恢复、审计

-   设备撤销即时生效。
-   断线重连必须重新验证会话。
-   会话过期、闲置超时。
-   密钥和授权凭证清理。
-   审计不记录密码、私钥、屏幕内容、完整令牌。

### P8：安全回归与正式构建

-   完成全部安全矩阵和网络矩阵。
-   修复 Android release debug keystore/R8
    问题；正式签名材料由项目负责人安全提供，不得生成或提交伪生产密钥。
-   只从集成快照构建正式测试包。
-   报告真实设备、OS、网络、命令、退出码、证据路径和未验证项。

## 四、Agent 分工（主 Agent 负责集成，不负责重新架构）

在文件所有权明确且阶段依赖允许时，最多并行三个实现 Agent：

1.  **Windows Agent**：仅负责
    `src-tauri/src/personal_hub/`、PersonalHubService 独立进程、Named
    Pipe、桌面 IPC 接口和 Windows 本机认证 PoC。不得改
    Android、云端或共享架构文档。
2.  **Cloud Agent**：仅负责
    `services/personal-hub-control-plane/`、PostgreSQL schema、Fastify
    API、WSS 信令、coturn 配置与云端测试。不得改桌面或 Android
    业务代码。
3.  **Android Agent**：仅负责
    `apps/mobile/modules/*`、`apps/mobile/src/lib/hub/*`、配对 UI 和
    Android 本机认证 PoC。不得改 `src-tauri/` 或云端服务。

主 Agent： - 按基线调度任务，不重新规划。 - 管理文件所有权和阶段依赖。 -
负责共享接口集成、端到端安全测试、统一构建和验收。 - 发现跨 Agent
接口冲突时按基线裁决，不允许各 Agent 私自改协议。 - 不得让子
Agent"先研究并提出架构方案"。

P1/P2/P3 可在不冲突的情况下并行；P4 等待接口稳定；P5 必须先于 P6；P6
不得提前开发控制执行能力。

## 五、仓库协作和构建要求

严格遵循根 `AGENTS.md`： - 开工前与交付前检查 `git status`。 -
当前未跟踪和未提交文件默认属于其他任务，不覆盖、不清理。 -
按精确路径声明写入范围。 - 不使用
`git clean`、`git reset --hard`、无路径限制 stash。 - 不自动
commit/push。 - 不绕过构建调度器。 - 正式构建只使用集成快照。 - 不因一个
Agent 完成就重复构建；尽量合并验收任务。 -
移动端原生代码改动后按规范运行 Expo prebuild 和 Gradle 验证。 -
`apps/mobile/AGENTS.md`
的后台服务禁令只为本功能增加窄范围例外：仅活动远控/屏幕采集会话期间允许有持续通知的前台服务；不得扩大到普通同步。

## 六、每个 Agent 必须提交的交付报告

每个阶段/Agent 报告必须包含：

1.  任务 ID、负责人、模块。
2.  修改文件精确列表。
3.  对照架构基线完成的事项。
4.  实际执行命令和退出码。
5.  单元/集成/真机测试结果。
6.  安全测试证据。
7.  未验证项。
8.  BLOCKED 项及原始证据。
9.  依赖其他模块的接口。
10. 是否出现偏离架构（必须为"无"；如有，立即停止并报告）。

不得使用"代码已写好""理论可行""应该没问题"作为验收结论。

## 七、最终验收底线

没有被控设备本机系统凭据认证，就不能建立远控控制通道；没有真实跨网络证据，就不能宣称远程连接成功；没有安全测试证据，就不能宣称安全完成。

你负责把已经确定的架构实现出来，不负责重新发明架构。
