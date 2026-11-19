# P2 交付报告 — TaskDock Personal Hub Cloud Control Plane

- **任务 ID**：P2
- **负责人**：Cloud 实现 Agent
- **模块**：`services/personal-hub-control-plane/`（独立 Node 服务，全新目录）
- **架构事实源**：`docs/personal-hub/ARCHITECTURE_BASELINE_v1.0.md`（§3.A、§6.2、§7.4、§7.5、§11.3、§12、§13、§16、§18）
- **结论**：**通过**
- **是否偏离架构**：**无**

---

## 1. 精确文件列表

全部位于 `services/personal-hub-control-plane/`，未写任何 `src-tauri/`、`apps/mobile/`、根目录配置或 docs 文档。

```
package.json                         package-lock.json
tsconfig.json                        vitest.config.ts
.gitignore                           .env.example
Dockerfile                           docker-compose.yml
README.md                            REPORT.md（本文件）
scripts/test.mjs
schema/sql/001_init.sql
src/config.ts                        src/types.ts
src/services.ts                      src/app.ts
src/server.ts
src/crypto/signatures.ts             src/crypto/turn.ts
src/schema/canonical.ts              src/schema/validation.ts
src/core/errors.ts                   src/core/audit.ts
src/core/RateLimiter.ts              src/core/DeviceRegistry.ts
src/core/PresenceManager.ts          src/core/RevocationRegistry.ts
src/gateway/PairingInvitationStore.ts
src/gateway/TurnCredentialIssuer.ts  src/gateway/SignalingGateway.ts
src/store/interfaces.ts              src/store/memory/MemoryStores.ts
src/store/postgres/PostgresStores.ts
src/routes/errors.ts                 src/routes/http.ts
src/routes/websocket.ts
test/helpers.ts                      test/unit/core.test.ts
test/integration/api.test.ts         test/security/security-proofs.test.ts
```

> 协作说明：实现期间同一新目录出现并行写入（HTTP/WSS 路由有两套草稿）。已按唯一设计收敛为
> `createApp/createDeps` + `routes/http.ts` + `routes/websocket.ts`，并以最终 typecheck/test
> 全绿为准；未覆盖或删除他人范围外文件。

---

## 2. 对照基线完成项

| 基线要求 | 完成情况 |
|---|---|
| §7.4 技术栈锁定 | Node 22 LTS + TypeScript + Fastify 5 + `@fastify/websocket` + PostgreSQL(`pg`) + coturn + Docker Compose，全部落实，未更换 |
| §11.3 `DeviceRegistry` | `registerDevice` / `getDevice` / `revokeDevice` + `requireActiveDevice` / `verifyRequestSignature` |
| §11.3 `PairingInvitationStore` | `createInvitation` / `consumeInvitation`（secret 只存哈希、一次性、5 分钟、最多 5 次失败） |
| §11.3 `SignalingGateway` | `connectDevice` / `forwardSignedSignal`（签名绑定 + 密文哈希 + 重放/限流/过期 + 原样透传） |
| §11.3 `PresenceManager` | `updatePresence` / `getPresence`（均验签 + 审计） |
| §11.3 `TurnCredentialIssuer` | `issueEphemeralCredentials`（coturn REST API 短时凭证，TTL 30–600s，无私钥/长期密码） |
| §11.3 `RevocationRegistry` | `publishRevocation` / `isRevoked` / `listRevocations` |
| §11.3 `RateLimiter` | `checkPairingAttempt` / `checkSignalingRate` / nonce 去重 |
| §11.3 审计元数据 | `auditEvent` 脱敏设备 ID + 结果码 + UTC 时间 + 元数据，无凭据/正文 |
| §12 数据模型 | `devices` / `pairing_invitations` / `remote_sessions` / `presence` / `revocations` / `audit_metadata`；**云端不持久化 `LocalAuthGrant` 正文** |
| §6.2 邀请 | 一次性、默认 300s、最多 5 次错误尝试后 revoked |
| §7.5 数据保留 | 不留媒体/文件/SDP/ICE 正文；审计只写结果码 |
| §13 威胁模型 | 端到端密文不可读、签名绑定防 MITM、重放防护、fail-closed |
| schema 校验选型 | **zod**（`.strict()` 拒绝未声明字段，阻断 privateKey/grant/媒体字段进入云端） |

---

## 3. 真实命令与退出码

工作目录均为 `D:/Develop/task_dock/services/personal-hub-control-plane`。

| 命令 | 工作目录 | 退出码 | 结果 |
|---|---|---|---|
| `npm install --no-audit --no-fund` | 上述目录 | **0** | 新增 123 个包，未污染根 `node_modules` |
| `npm run typecheck`（`tsc --noEmit -p tsconfig.json`） | 上述目录 | **0** | 无类型错误 |
| `npm test`（`vitest run`） | 上述目录 | **0** | 3 个测试文件，37 个测试全部通过 |
| `docker --version` | 仓库根 | — | `docker: command not found` → Docker 相关项标未验证 |

最终一次完整验证时间：2026-11-19 11:56:01（typecheck exit 0；test exit 0，37/37）。

> 环境说明：当前执行环境的系统临时目录对本沙箱不可写，Vitest 首次运行出现
> `EPERM ... AppData\Local\Temp\...\ssr\...`（在其它 Agent 并发运行根仓库测试时更容易触发）。
> 已在 `vitest.config.ts` 与 `scripts/test.mjs`（`npm test` 启动器）中把 TMPDIR/TEMP/TMP
> 与缓存目录重定向到服务目录内 `.tmp/`、`.vitest-cache/`，之后 `npm test` 稳定 exit 0
> （最终复跑 11:59:15，37/37，exit 0）。这是环境适配，不是安全降级，也未改动任何测试断言。

---

## 4. 单元 / 集成测试结果

- `test/unit/core.test.ts`：**23/23 通过**。覆盖 §11.3 全部类/方法：
  - 注册签名/指纹校验、重复注册拒绝、未知设备查询与审计；
  - 邀请 secret 只存哈希、只授予配对能力、一次性、5 次失败吊销、过期拒绝、限流；
  - Presence 验签、撤销后签名请求拒绝、限流窗口与 nonce 防重放；
  - TURN 短时凭证 TTL 边界与共享密钥不泄露；
  - 信令原样转发密文/签名、篡改哈希/签名字段/过期/目标撤销均拒绝。
- `test/integration/api.test.ts`：**6/6 通过**（Fastify `app.inject`）：健康检查、注册→TURN→在线全链路、配对全链路、越界字段 400、WSS mock socket 认证前拒绝与认证后签名密文转发。
- `test/security/security-proofs.test.ts`：**8/8 通过**（见下节）。

---

## 5. 安全测试证据

| 证明项 | 证据 |
|---|---|
| **服务端不能签发 LocalAuthGrant** | P1：剥离注释后扫描 `src/**/*.ts`，不存在 `issueLocalAuthGrant`/`createLocalAuthGrant`/`signLocalAuthGrant`/`grantId`/`localSignature` 等标识符，**且无任何 `sign(` 调用**（云端只验签，TURN 只用 HMAC）；`POST /v1/grants/issue` 返回 404；配对/凭证/消费响应经递归键扫描无任何含 `grant` 的键；`pairedCapabilities` 明确不含 `REMOTE_CONTROL` |
| **服务端不能读私钥** | P2：`validation.ts` 与 `001_init.sql` 无私钥/密码字段；zod `.strict()` 使携带 `privateKey` 的注册请求返回 400 `INVALID_SCHEMA`；设备记录递归扫描无 `private|secret|password` 键 |
| **不能读取/解密媒体或 Control DataChannel** | P3：`SignalingGateway.ts` 无 `createDecipher`/`decrypt` 等任何解密 API；把一段看似明文控制指令（`CONTROL_MOUSE_MOVE`）按 base64 塞入 `ciphertext`，转发结果、会话元数据、审计中均不出现该明文，网关只原样透传 |
| **只转发签名绑定的信令密文** | P4：换密钥签名、改 `toDeviceId`、改 `ciphertext`（签名未更新）均被拒；即使重新签名，`ciphertextHash` 与密文字节不符仍被拒（第二道完整性绑定）；签名覆盖 session/nonce/双方设备/DTLS 指纹/密文哈希/过期时间 |

---

## 6. 未验证项 / 环境阻塞

| 项目 | 状态 | 说明 |
|---|---|---|
| Docker Compose 真机启动（Postgres + coturn + 服务） | **未验证** | 本机 `docker: command not found`；`docker-compose.yml`、`Dockerfile`、`.env.example`、`001_init.sql` 已提供 |
| PostgreSQL 真实连接与迁移执行 | **未验证** | 本机无 DB 实例；仓储通过内存实现同接口测试，生产路径 `server.ts` 使用 `pg`，启动时 `SELECT 1` 探活 |
| coturn 真实 TURN 中继连通性 | **未验证** | 依赖 Docker；凭证签发逻辑已单测验证（HMAC-SHA1 REST API，TTL 有界） |
| 公网 HTTPS/WSS 与 TLS 终止层 | **未验证** | 服务按部署在 TLS 反向代理之后设计，本地为 HTTP/WSS |
| 真实 WebRTC P2P、媒体与 DataChannel 链路 | **不在 P2 范围** | 属端侧 P5/P6；云端按基线仅转发密文 |
| 多实例水平扩展 | **限制（非基线 v1.0 要求）** | 当前在线连接表为单实例内存 Map；多实例需接共享信令总线，代码注释与 REPORT 已标注 |

**BLOCKED 原始证据**：无安全降级型 BLOCKED。唯一环境事实为 `docker --version` → `docker: command not found`，对应上表“未验证”，未自行更换方案。

---

## 7. 依赖接口（端侧 API 契约）

### 7.1 通用签名规范（所有签名请求）

- 签名算法：**Ed25519**；设备私钥永远留在端侧，云端只持有注册时提交的 32 字节原始公钥。
- 规范化：取请求体**剔除 `signature` 键**后的对象，按**键名字典序**递归排序，JSON 序列化（无空格），UTF-8 字节，Ed25519 签名，结果 **base64**。
- 每个签名请求必须带：`timestamp`（UTC ISO-8601，服务端允许 ±5 分钟偏差）、`nonce`（UUID，单次使用防重放）、`signature`（base64 64 字节）。
- 时间戳过期 → `IDENTITY_MISMATCH`；nonce 重用 → `REPLAY_DETECTED`；限流 → `RATE_LIMITED`。

### 7.2 HTTP（POST + JSON，`Content-Type: application/json`）

| 路径 | 主要请求字段（除通用签名字段） | 成功响应 | 说明 |
|---|---|---|---|
| `GET /v1/health` | 无 | 200 `{status:"ok",...}` | 唯一无需签名的接口 |
| `POST /v1/devices/register` | `deviceId`(UUID), `deviceType`:`windows-hub`\|`android`, `displayName`, `identityPublicKey`(base64 32B), `identityFingerprint`(SHA256(pubkey) hex 前 32) | 201 `{ok:true,device}` | 自签名；指纹必须由公钥推导；禁止传 `privateKey` |
| `POST /v1/devices/get` | `deviceId` | 200 `{ok:true,device}` | 请求者须为已注册活跃设备（签名） |
| `POST /v1/devices/revoke` | `deviceId`, `reason` | 200 `{ok:true,revocation}` | 撤销并同步状态 |
| `POST /v1/invitations/create` | `issuerDeviceId`, `ttlSeconds?`(30–300, 默认 300) | 201 `{ok:true,invitation,invitationSecret}` | **secret 仅此一次返回**，用于生成二维码；云端只存 SHA-256 哈希 |
| `POST /v1/invitations/consume` | `invitationId`, `invitationSecret`(base64 16B), `deviceId`, `deviceType`, `displayName`, `identityPublicKey`, `identityFingerprint` | 200 `{ok:true,device,pairedCapabilities:["DEVICE_PAIRED","HUB_DISCOVERY"]}` | 一次性；**绝不返回 grant / REMOTE_CONTROL** |
| `POST /v1/turn/credentials` | `deviceId`, `ttlSeconds?`(30–600) | 200 `{ok:true,credentials}` | `username="<expiryEpoch>:<deviceId>"`，`credential=base64(HMAC-SHA1(TURN_SECRET,username))`，含 `expiresAt`/`uris`；**不下发共享密钥** |
| `POST /v1/presence/update` | `deviceId`, `status`:`online`\|`offline` | 200 `{ok:true,presence}` | |
| `POST /v1/presence/get` | `deviceId` | 200 `{ok:true,presence}` | |
| `POST /v1/revocations/list` | `deviceId`, `since?`(ISO) | 200 `{ok:true,revocations}` | 重连先同步撤销状态 |

错误响应统一为 `{ok:false,error:{code,message}}`，错误码：`INVALID_SCHEMA`、`IDENTITY_MISMATCH`、
`INVALID_INVITATION`、`DEVICE_REVOKED`、`RATE_LIMITED`、`REPLAY_DETECTED`、`SESSION_EXPIRED`、`DEVICE_NOT_FOUND`、`DEVICE_ALREADY_EXISTS`。

### 7.3 WSS `/v1/signaling`

- 帧：`{ id?:string, type:string, payload?:object }`；响应：`{ id?, ok:boolean, data?:object, error?:{code,message} }`。
- 首帧必须 `type:"auth"`，payload = `{deviceId,timestamp,nonce,signature}`；成功响应 `{id,ok:true,data:{deviceId}}`。未认证先发其它帧 → `AUTH_REQUIRED`。
- `type:"signal.forward"`，payload = `SignedSignal`：
  `type`(`offer`|`answer`|`ice-candidate`), `sessionId`, `fromDeviceId`, `toDeviceId`, `dtlsFingerprint`,
  `ciphertext`(base64 **端到端加密后的不透明密文**), `ciphertextHash`(SHA256(ciphertext 字节) hex),
  `expiresAt` + 通用签名字段。校验通过后服务端向目标设备发 `signal.deliver`（原样带 `ciphertext` 与 `signature`），
  并向发送方回 `{ok:true,data:<原样信封>}`（**不含任何 grant**）。
- 其它帧类型：`presence.update`、`presence.get`、`revocations.list`、`revocation.publish`。
- 端侧必须自行验证 `signal.deliver` 中的来源签名与 `dtlsFingerprint` 绑定，防止信令服务器替换 SDP 实施 MITM。

---

## 8. 交付前状态

- `git status --short`：开工前、交付前各执行一次；本次仅新增 `services/personal-hub-control-plane/`，
  仓库其他已修改/未跟踪目录均属其他任务，未触碰。
- 未执行任何 `git add` / `commit` / `push` / `clean` / `reset` / `stash` / 分支切换。
- 无用户数据库、密钥、剪贴板正文、个人路径或敏感日志写入任何可提交文件。

---
---

# P3 交付报告 — 配对批准状态机（PC 本机批准）

- **任务 ID**：P3-C（Cloud 侧）
- **负责人**：Cloud 实现 Agent（P3 阶段）
- **模块**：`services/personal-hub-control-plane/`（仅本目录内写入）
- **规格书**：[P3-SHARED-CONTRACT.md](../../docs/personal-hub/P3-SHARED-CONTRACT.md) §1 / §3 / §3.3 / §7
- **上位依据**：`ARCHITECTURE_BASELINE_v1.0.md` §6.2（第 4–8 步 PC 本机批准）、§7.4、§11.3、§12、§13
- **结论**：**通过**
- **是否偏离架构**：**无**
- **P2 章节保持不变**（上文 §1–§8 原文保留；P3 仅追加本节，并修正 P2 章节里已被安全修复取代的旧接口描述——见 §9.3 注记）。

---

## 9. 变更清单

### 9.1 新增文件

| 文件 | 作用 |
|---|---|
| `src/gateway/PairingRequestStore.ts` | 配对批准状态机：`submitRequest` / `listPendingRequests` / `decideRequest` / `getRequestStatus` / `expireStaleRequests` |
| `schema/sql/002_pairing_requests.sql` | `ph_pairing_requests` 建表 DDL + 3 个索引（契约 §3.3 逐字字段） |
| `test/pairing/pairing-approval.test.ts` | 17 个攻击面测试（见 §11） |

### 9.2 修改文件

| 文件 | 改动 |
|---|---|
| `src/types.ts` | 新增 `PairingRequestStatus`、`PairingRequestRecord` |
| `src/schema/validation.ts` | 新增 4 个 `.strict()` schema；**删除** `ConsumeInvitationSchema`（其路由已下线） |
| `src/store/interfaces.ts` | 新增 `PairingRequestRepo`，并加入 `Stores` 集合 |
| `src/store/memory/MemoryStores.ts` | 新增 `MemoryPairingRequestStore`（接口与 Postgres 一致） |
| `src/store/postgres/PostgresStores.ts` | 新增 `PostgresPairingRequestStore` + 行映射 |
| `src/gateway/PairingInvitationStore.ts` | `consumeInvitation` 改为**内部方法**，入参改为已落库的 `PairingRequestRecord`，文档明确「只能由 PC 批准路径调用」；移除 secret 比对与限流（已前移到 submit，安全语义不变） |
| `src/app.ts` / `src/services.ts` | 装配 `pairingRequests` 依赖 |
| `src/routes/http.ts` | 新增 4 个端点；`POST /v1/invitations/consume` 改为 **410 显式下线**；错误码表补 `REQUEST_NOT_FOUND` |
| `src/routes/errors.ts` | 全局错误映射补 `REQUEST_NOT_FOUND` |
| `README.md` | 接口摘要同步（consume 下线 + 4 个 pairing 端点 + 安全边界） |
| `test/helpers.ts` | 新增 `pairingRequestBody` / `decideRequestBody` / `pairingStatusBody` / `listRequestsBody` |
| `test/unit/core.test.ts` | 邀请语义断言**等价迁移**到 request→decide 路径（断言条数与强度不变） |
| `test/integration/api.test.ts` | 配对全链路改为 request→decide；新增「旧 consume 路由已下线」用例（6→7） |
| `test/security/security-proofs.test.ts` | 安全证明改用新流程；SQL 扫描扩展到 `002_pairing_requests.sql`；新增 consume 路由下线断言 |

> `scripts/test.mjs`（含 `--no-file-parallelism`）**未改动**。
> DDL 位置说明：仓库既有约定是 `schema/sql/001_init.sql`，故新建 `schema/sql/002_pairing_requests.sql`，
> 未另建 `db/migrations/`（保持单一迁移目录，避免两套迁移源）。

### 9.3 接口契约（端侧对接）

所有端点：`POST` + JSON + zod `.strict()` + `timestamp/nonce/signature` + `assertFresh` + 限流 + 审计。

| 端点 | 请求（除通用签名字段） | 成功响应 |
|---|---|---|
| `POST /v1/pairing/request` | `invitationId`, `invitationSecret`(base64 16B), `deviceId`, `deviceType:"android"`, `displayName`, `identityPublicKey`, `identityFingerprint` | **201** `{ok, requestId, status:"awaiting_pc_approval", expiresAt}` |
| `POST /v1/pairing/requests/list` | `issuerDeviceId` | 200 `{ok, requests:[{requestId,deviceId,deviceType,displayName,identityFingerprint,identityPublicKey,requestedAt,expiresAt}]}` |
| `POST /v1/pairing/decide` | `requestId`, `issuerDeviceId`, `approved` | 200 `{ok,status:"approved",device,pairedCapabilities:["DEVICE_PAIRED","HUB_DISCOVERY"]}` 或 `{ok,status:"rejected"}` |
| `POST /v1/pairing/status` | `requestId`, `deviceId` | 200 `{ok,status,peer?}`；`peer` 仅 `approved` 时返回 `{deviceId,displayName,deviceType,identityFingerprint}` |

实现要点（与契约一致，且为对接必须知道的细节）：

- **`/v1/pairing/status` 的签名用申请记录内的公钥校验**：批准前该设备尚未进入设备公钥目录
  （「未批准不建设备」），因此不能按已注册设备验签；同时强制 `request.deviceId === deviceId`，
  越权一律 `IDENTITY_MISMATCH`。
- 错误码与 HTTP 状态：`INVALID_SCHEMA`400、`FINGERPRINT_MISMATCH`/`INVALID_SIGNATURE`/`IDENTITY_MISMATCH`401、
  `INVALID_INVITATION`400、`INVITATION_EXPIRED`410、`INVITATION_NOT_PENDING`409、`REPLAY_DETECTED`409、
  `RATE_LIMITED`429、`REQUEST_NOT_FOUND`404。
- **补充错误码（契约未覆盖的边界，属新增不改语义）**：`REQUEST_NOT_FOUND`(404) 用于未知 `requestId`；
  `ENDPOINT_GONE`(410) 用于已下线的 `/v1/invitations/consume`。端侧按「非 2xx 即失败」处理即可。
- 旧契约的 `POST /v1/invitations/consume` **已下线**（P2 报告 §7.2 表中该行已失效，以本节为准）。

---

## 10. 对照契约完成项

| 契约要求 | 完成情况 |
|---|---|
| §3.1 状态机 `awaiting_pc_approval → approved/rejected/expired` | 已实现；**只有 approved 才把邀请置 consumed**；rejected 同时把邀请置 revoked；超时置双方 expired |
| §3.2(1) submit 11 步行为 | 限流先于 secret 比对、fresh、指纹、验签、nonce 去重、邀请存在/pending/过期、secret 定时安全比对 + 5 次吊销、同设备幂等、**不消费/不建设备/无能力/无 grant** |
| §3.2(2) list 仅返回本 issuer 且未过期 | 已实现（邀请非 pending 或已过期的不展示，避免「不可批准的僵尸申请」） |
| §3.2(3) decide 越权/状态/过期校验 + 审计 | 已实现；审计 `PAIRING_APPROVED` / `PAIRING_REJECTED`，只记 deviceId（脱敏）与结果码 |
| §3.2(4) status 只能查自己 + peer 仅 approved | 已实现；`peer` 不含公钥正文以外的敏感内容（本来就只给指纹） |
| §3.3 数据模型 | `ph_pairing_requests` 字段与索引逐字落地（memory + postgres 双实现，接口一致） |
| §3.2 安全红线：能力固定两项、无 grant | 硬编码 `['DEVICE_PAIRED','HUB_DISCOVERY']`；代码中不存在任何授权签发标识符（安全证明 P1 继续通过） |
| 基线 §6.2 第 4–8 步 | 补齐：申请 → PC 列表 → 本机批准 → 消费邀请 → 建记录 |
| 移除 Android 单方面消费 | `POST /v1/invitations/consume` → 410；`consumeInvitation` 仅由 `decideRequest(approved=true)` 调用（已 grep 验证唯一调用点） |

---

## 11. 真实命令与退出码

工作目录均为 `D:/Develop/task_dock/services/personal-hub-control-plane`。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck`（`tsc --noEmit -p tsconfig.json`） | **0** | 无类型错误（2026-11-19 12:55） |
| `npm test`（`node scripts/test.mjs` → vitest `--no-file-parallelism`） | **0** | **4 个文件 / 55 个测试全部通过**（2026-11-19 12:56:01） |

测试分布：

| 文件 | 数量 | 说明 |
|---|---|---|
| `test/pairing/pairing-approval.test.ts` | **17** | 新增：契约攻击面全覆盖 |
| `test/unit/core.test.ts` | 23 | P2 的 23 条断言全部保留（邀请 6 条等价迁移到新流程） |
| `test/security/security-proofs.test.ts` | 8 | P1–P5 全部保留并通过 |
| `test/integration/api.test.ts` | 7 | P2 的 6 条 + 1 条「旧路由下线」 |
| **合计** | **55** | 无任何既有断言被删除或弱化 |

`test/pairing/pairing-approval.test.ts` 用例与契约 §7 / 任务 A–E 的对应：

1. 正常流程（submit → PC pending → approve → 建设备 + 能力恰为两项）
2. 未批准不建设备（设备目录仍只有 Hub；状态仍 awaiting；未知 requestId 404）
3. PC 拒绝 → rejected + 邀请 revoked + 设备不存在 + 其他设备无法复用邀请
4. 邀请过期 → `INVITATION_EXPIRED`(410) + 邀请标 expired
5. 错误 secret 5 次 → revoked；第 6 次（secret 正确）仍 409 失败
6. 同一邀请第二个设备 → 409 拒绝
7. 设备 B 批准发给 A 的请求 → `IDENTITY_MISMATCH`(401)，邀请仍 pending
8. 越权查询：B 的 list 为空；陌生设备/B 查询 A 的申请 → `IDENTITY_MISMATCH`
9. 同一 nonce 重放 → `REPLAY_DETECTED`(409)，不产生第二条申请
10. 换私钥签名 / 改字段不重签 → `INVALID_SIGNATURE`(401)；指纹不符 → `FINGERPRINT_MISMATCH`；越界字段 → `INVALID_SCHEMA`
11. `/v1/invitations/consume` → 非 2xx（410），且邀请未消费、设备未创建
12. request 响应键**恰为** `ok/requestId/status/expiresAt`，无 grant/私钥/能力字段；reject 与 status 拒绝路径同样无能力字段
- 附加：9b 幂等提交返回同一 `requestId`；13 惰性过期后 PC 也无法再批准

---

## 12. 安全证据

| 证明项 | 证据（可复核） |
|---|---|
| **未批准不得创建设备** | 测试 2：submit 后 `deps.devices.getDevice(phone)` 为 `null`，`stores.devices.list()` 仅含 Hub；测试 7/13 同样断言设备不存在。静态核查：`stores.devices.create` 仅出现在 `DeviceRegistry.registerDevice`（自注册公钥目录）与 `PairingInvitationStore.consumeInvitation`（仅 PC 批准路径） |
| **邀请只能被 PC 批准消费** | `grep -rn "consumeInvitation(" src` 仅 1 处调用：`PairingRequestStore.ts:338`（`decideRequest` 的 approved 分支）；`src/routes/http.ts` 不再引用 `deps.pairings.consumeInvitation` |
| **公开 consume 路由已关闭** | `POST /v1/invitations/consume` → **410** `ENDPOINT_GONE`；测试 11 + 集成测试 + 安全证明 P1 三处断言非 2xx，且断言副作用为零（邀请 pending、无设备） |
| **能力集不含 REMOTE_CONTROL** | 测试 1 断言 `pairedCapabilities` **恰等于** `["DEVICE_PAIRED","HUB_DISCOVERY"]`；安全证明 P1 对 request/submit/decide/turn 全部响应递归键扫描，无任何含 `grant` 的键 |
| **无 grant / 私钥进入请求或响应** | `PairingRequestSchema` 等 4 个 schema 均 `.strict()`；测试 10c 断言携带 `grant`/`privateKey`/`pairedCapabilities` 的请求 400；测试 12 断言响应键集合精确匹配 |
| **越权与重放** | 测试 7/8（`IDENTITY_MISMATCH`）、测试 9（`REPLAY_DETECTED`）、测试 10（`INVALID_SIGNATURE`） |
| **审计最小化** | 新增事件 `PAIRING_REQUESTED` / `PAIRING_LIST` / `PAIRING_APPROVED` / `PAIRING_REJECTED` / `PAIRING_STATUS` / `PAIRING_ATTEMPT`，只写脱敏 deviceId、结果码、计数；不写公钥、指纹、secret 或正文 |
| **数据表无敏感列** | `002_pairing_requests.sql` 与 001 均为「公钥 + 元数据」；安全证明 P2 已把 SQL 扫描扩展到新表（`private_key`/`password` 均不存在） |

---

## 13. 未验证项 / 环境限制

| 项目 | 状态 | 说明 |
|---|---|---|
| 真实 PostgreSQL 执行 `002_pairing_requests.sql` | **未验证** | 本机无 DB 实例（P2 同样结论）；`PostgresPairingRequestStore` 与 memory 实现同接口，但未经真实 DB 驱动执行 |
| Docker Compose 全栈 | **未验证** | `docker` 不可用（P2 已记录）；`docker-compose.yml` 未改动 |
| PC 端 UI / Named Pipe 接入 | **不在本任务范围** | 契约 §4 明确 P3 不写 Tauri 前端；本 Agent 只保证云端端点可用 |
| 跨端签名一致性（Rust/Kotlin 测试向量） | **不在本任务范围** | 云端沿用 P2 的 canonical JSON + Ed25519；向量由端侧 Agent 固化 |
| WSS `pairing-request` 推送 | **刻意未实现** | 契约 §3.2 注：v1.0 先轮询，WSS 事件留到 P4 |

### 遗留风险（如实记录，不在本任务范围）

- `POST /v1/devices/register`（P2 既有，自签名公钥目录）仍允许设备在未配对情况下写入公钥目录。
  它**不授予任何配对能力、不产生 grant、不创建设备信任关系**（`pairedCapabilities` 只在 decide 响应中
  出现，Hub 侧配对列表才是权威）。但该端点与配对状态机在语义上重叠，建议 P4 收紧信令/TURN 授权时
  一并要求「已配对」标记。本阶段不改动它，因为改动会破坏 P2 契约与既有端侧流程，属架构决策。
- 云端 `ph_pairing_requests` 与 `pairing_invitations` 的两步更新不是单事务（仓储抽象无事务接口）。
  顺序为「设备冲突预检 → 消费邀请 → 建设备 → 更新申请」，失败方向是 fail-closed（宁可留下不可批准的
  申请，也不会出现「未批准却建设备」）。生产化建议在 Postgres 实现中加 `withTransaction`。

---

## 14. 交付前状态（P3）

- 写入范围仅 `services/personal-hub-control-plane/**`；未触碰仓库根、`src-tauri/**`、`apps/**`、`docs/**`。
- 未执行任何 `git add` / `commit` / `push` / `clean` / `reset` / `stash` / 分支操作。
- 无密钥、私钥、secret 明文、个人路径或敏感日志写入可提交文件（测试 secret 全为运行时随机生成）。
- `scripts/test.mjs` 的 `--no-file-parallelism` 加固保持不变。
- **是否偏离架构：无。** 技术栈、端点语义、能力边界、失败关闭策略均按基线与契约执行；
  新增的 `REQUEST_NOT_FOUND` / `ENDPOINT_GONE` 仅填补契约未定义的边界，未改变任何既有安全语义。

