# TaskDock Personal Hub — Cloud Control Plane（P2 + P3 配对批准）

独立 Node.js 22 LTS 服务，实现基线 §3.A / §7.4 / §11.3 的云端控制平面。
**技术栈（锁定，不偏离）**：Node 22 + TypeScript + Fastify 5 + `@fastify/websocket` + PostgreSQL + coturn + Docker Compose。

## 启动

```bash
npm install
npm run typecheck
npm test
# 本地开发（无 DB 时用内存仓储，仅演示）：
TURN_SECRET=dev-only-secret-at-least-16 npm start
# 完整栈（需要本机有 Docker）：
cp .env.example .env  # 修改 TURN_SECRET
docker compose up -d --build
```

schema 校验选型：**zod**（与 TS 类型推断契合，`.strict()` 拒绝任何未声明字段，
阻断 privateKey / password / grant / 媒体正文进入云端）。

## 安全边界（不可破坏）

- 只存公钥与最小元数据：无私钥、无系统密码、无长期 TURN 密码、无 LocalAuthGrant 正文。
- 邀请 secret 只存 SHA-256 哈希；一次性、默认 5 分钟、最多 5 次错误尝试。
- **配对必须由 PC 本机批准**：Android 提交申请只进入 `awaiting_pc_approval`，
  批准前不消费邀请、不创建设备、不授予能力（基线 §6.2 第 4–8 步）。
- 所有数据接口必须签名（Ed25519）、schema 校验、限流、新鲜度检查、审计。
- 信令网关只转发签名绑定的不透明密文：不解析 SDP/ICE、不解密、不重写、不落库密文。
- 网关不能签发被控端授权、不能读取媒体或 Control DataChannel 内容。
- 审计只写脱敏设备 ID + 结果码 + 时间 + 元数据，不写凭据/正文。
- 时间全部 UTC。

## 接口契约摘要

- HTTP（POST + JSON，body 含 `timestamp`/`nonce`/`signature`）：
  `/v1/devices/register`、`/v1/devices/get`、`/v1/devices/revoke`、
  `/v1/invitations/create`、`/v1/pairing/request`、`/v1/pairing/requests/list`、
  `/v1/pairing/decide`、`/v1/pairing/status`、`/v1/turn/credentials`、
  `/v1/presence/update`、`/v1/presence/get`、`/v1/revocations/list`。
- P3 配对状态机：Android `POST /v1/pairing/request` 只产生 `awaiting_pc_approval`；
  PC 本机 `POST /v1/pairing/decide`（approved=true）才消费邀请并创建设备。
  **`POST /v1/invitations/consume` 已下线（410）**，Android 不能单方面完成配对。
- WSS `/v1/signaling`：首帧 `auth`，之后 `presence.update`/`presence.get`/
  `revocations.list`/`revocation.publish`/`signal.forward`。
- 签名规范：对请求体剔除 `signature` 后的规范化 JSON（键字典序）做 Ed25519 签名，base64 编码。

字段级契约见 `REPORT.md` 的「依赖接口」章节（P3 章节为最新）。
