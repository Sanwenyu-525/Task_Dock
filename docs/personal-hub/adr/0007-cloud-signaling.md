# ADR-0007：TaskDock 云端 Control Plane 与 STUN/TURN

- 日期：2026-11-19
- 状态：**Accepted**（按架构基线第 17 节锁定；基线 D6/D7）
- 决策人：产品/架构负责人
- 关联：[ARCHITECTURE_BASELINE_v1.0.md](../ARCHITECTURE_BASELINE_v1.0.md) D6/§3.A/§7.4、[04-network-topology.md](../04-network-topology.md)、[06-threat-model.md](../06-threat-model.md) T6/T7

## Context

基线 D6 锁定：**必须有 TaskDock 管理的轻量设备发现/信令服务；TURN 作为直连失败的中继**。普通用户不配置服务器、端口或公网 IP。
现状：项目无此云端；`docs/RELAY_INTEGRATION.md` 的 Relay 是本地 Agent 编排（Fastify + PostgreSQL sidecar，绑回环），与本云端无关。
原稿「是否自建云端」的待决项已由基线 D6 消除——云端为 v1.0 必需项。

## Decision（基线 D6/D7：Control Plane + STUN/TURN，已锁定）

1. 技术栈锁定（基线 §7.4）：`services/personal-hub-control-plane/`，Node.js 22 LTS + TypeScript + Fastify 5 + WebSocket 插件 + PostgreSQL + coturn + Docker Compose。
2. 职责：设备注册与公钥目录、配对邀请状态、在线状态与发现、WebRTC 信令（SDP/ICE）、TURN 临时凭证、会话元数据与限流、撤销状态同步、审计元数据。
3. 最小信任：只存公钥/最小元数据/邀请/撤销/最小会话元数据；**无签发授权能力**，不保存 `LocalAuthGrant`、系统密码、私钥、媒体/文件正文（基线 §3.A/§7.5/§12）。
4. WebRTC 视频 DTLS-SRTP、控制/文件 DataChannel DTLS；**TURN 只转发密文，无 DTLS/会话密钥，不得解密**（D7）。
5. SDP/ICE 临时内容只在协商窗口保存，完成/超时清除；日志只记结果码/路径类型/时间/脱敏设备 ID。
6. TURN 短时凭证，客户端不内置长期密码；TURN UDP 失败尝试 TCP/TLS 443。

## Considered Options

- 云端完全延后 / 用户自建服务器：基线否决（D6，普通用户零配置要求）。
- TaskDock 管理 Control Plane + STUN/TURN（采纳）。

## Consequences

- 云端是 v1.0 必需基础设施，P2 交付；需独立部署/运维与威胁模型。
- 信令服务器或 TURN 被攻破也不能签发被控端授权或解密远控内容（威胁模型 T6/T7）。
- 跨网真实连通依赖 P4 网络矩阵验证，未实测不得宣称远程连接成功。
