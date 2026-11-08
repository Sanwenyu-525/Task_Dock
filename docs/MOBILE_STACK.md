# Task Dock Mobile 架构与共享边界（v1 设计稿）

> 状态：**验证阶段设计稿**（2026-11-07）。本文件只描述已论证的设计与边界，不包含尚未实现的
> 功能承诺。框架选型结论与实测数据见 `tmp/acceptance/mobile-stack-selection/report.md`。
>
> **实现现状以 [docs/mobile/](mobile/README.md) 为准。** 本稿中的 `notes` 表、`server_rev` /
> `dirty` 列、`tombstones` 表、配对与同步流程均**未实现**；已实现部分的实际字段与行为见
> `mobile/02-data-model.md` §9 的差异表。
>
> 前提事实（来自对本仓库真实代码的审计）：
> - 桌面端业务规则**都在 Rust/SQLite 层**，TypeScript 只承担展示与纯函数；
> - 现有 `http_ingest` 只绑定 `127.0.0.1`，**不能直接**作为手机接入点；
> - 桌面端**没有任何**多设备/配对/同步实现（`featureCatalog` 中 `eco.sync` 仍为 `planned`）；
> - `tasks` 表**没有** `version`/`revision` 列，更新是 last-write-wins；
> - `quick_capture_items.client_id` 已有唯一索引，是现成的幂等范式；
> - `notes.revision` 已有 CAS + `CONFLICT` 错误，是现成的乐观锁范式。

---

## 1. 职责划分

| 能力 | 桌面端（权威源） | 手机端 |
|---|---|---|
| 任务/笔记/收集箱的**权威数据** | 权威。SQLite 为唯一事实源 | 本地副本 + 离线可写，经同步合并 |
| 重复规则计算 | 权威（`recurrence.rs`，按本地墙钟） | 离线新建的重复任务只存规则参数，**由桌面端计算下一次发生时间** |
| Agent 事件接入 | 权威。`origin`/`ingest_seq`/`dedupe_key` 由服务端判定 | 只读展示 + 摘要；不参与事件判定 |
| 提醒触发 | 桌面端负责已开机场景 | 手机端本地通知负责「手机侧」提醒，二者需去重（见 §7） |
| 剪贴板历史 | 权威 | 默认**不同步**（隐私面最大、收益最低），仅显式「发送到手机」的单条传递 |
| 配对与设备授权 | 权威。桌面端是配对发起方与授权中心 | 被授权方 |
| 远程操作 | 默认**不开放** | 只读；写入/危险操作需单独授权（见 §8） |

**原则**：手机端不做第二权威。所有跨端写入都带操作 id，由桌面端幂等接收。

---

## 2. 代码共享边界

基于审计结果（`tmp/acceptance/mobile-stack-selection/report.md` §2.2），把现有 TS 拆成三层：

```
shared/                      # 纯 TS，零平台依赖，可被桌面与手机同时消费
  datetime.ts                # 直接搬（零 import）
  format/                    # 从 format.ts 拆出：注入 locale 与 t
  errors/model.ts            # 从 errors.ts 拆出纯错误模型（不含 invokeCommand）
  agentTree.ts               # 直接搬 + 类型抽取
  protocol/                  # 新增：同步协议类型与校验（本文件 §3）
  i18n/messages.ts           # 字典与插值（import.meta.env.DEV 需参数化）
apps/desktop-dock/           # 现有 src/（保留 Tauri 专属层）
apps/mobile/                 # 新增（框架待定）
```

**明确不共享**（桌面专属，禁止进入 `shared/`）：`bridge.ts`、`diagnostics.ts`、
`clipboard*.ts`、`audioNotification.ts`、`dragCursorSession.ts`、`fileDrop.ts`、
`navigation.ts`、`edgeTabActions.ts`、`widgets/desktopBridge.ts`、`edgeSnap.ts`、`capsule*`。

**业务规则不共享**：Task 校验/排序/重复计算目前在 Rust。若手机端需要离线新建重复任务，
必须在手机侧重写一份并保证与 Rust 语义一致，或者走 Rust 核心 FFI。二者成本见报告 §5。

---

## 3. 同步协议（v1）

### 3.1 传输

- 只在**局域网 + 已配对**下工作：桌面端新增独立监听（例如 `mobile_sync`），**不得复用**
  `http_ingest`，也不得监听 `0.0.0.0` 以外的默认值。
- 传输：HTTPS（自签证书 + 配对时固定公钥指纹，SPKI pinning），或 TLS 隧道；**不做纯明文**。
- 发现：mDNS 广播桌面端实例名 + 指纹摘要，手机端需用户确认指纹后建立信任。

> **开发者模式不是运行时依赖**：ADB（USB/无线调试）只用于验收时安装与驱动 UI；产品的局域网
> 传输是普通 App 的 TCP/TLS 连接，不需要开发者模式、root 或 USB（PoC 真机即直连桌面 LAN IP，
> 未用 `adb reverse`）。反过来，「同一 Wi-Fi」也不充分：需无 AP 隔离（公共 Wi-Fi 常见
> client isolation）、manifest 声明 `INTERNET`（Flutter release 的 main manifest 默认不含，
> PoC 已手工补）、并处理 Android 9+ 默认禁明文（正式版走 TLS）。

### 3.2 基线（pull）

```
GET /v1/changes?since=<cursor>&limit=500
→ {
    cursor: "<opaque string>",
    changes: [
      { entity: "task", id, rev, deleted, fields: {...}, updated_at },
      ...
    ]
  }
```

- `cursor` 不透明（服务端实现为 `updated_at + id` 的复合游标，避免时钟回拨重复/漏项）。
- 每条记录带 `rev`（服务端单调递增的版本号，**新增列**，不改已有语义）。

### 3.3 增量（push）

```
POST /v1/ops
{ device_id, ops: [ { op_id, entity, id, base_rev, patch } ] }
→ { ack: [op_id...], conflicts: [ {op_id, reason, server_record} ] }
```

- `op_id`：客户端生成的幂等键（UUID）。服务端按 `op_id` 去重，**重复提交只 ack 不重复落库**
  （与 `quick_capture_items.client_id` 同一思路，PoC 已实测：重放 3 条操作 → `ack=3, dup=3,`
  服务端记录数不变）。
- `patch` **必须支持三态**：键缺失 = 不改；`null` = 清空；有值 = 写入。桌面端 `TaskInput`
  已经是这个语义（`commands/tasks.rs:15-35`，`Option<Option<T>>`），协议必须原样传递，
  否则同步会静默清空用户的截止时间/提醒/重复规则。

### 3.4 冲突

| 场景 | 策略 |
|---|---|
| 两端都改同一字段 | `base_rev` 不匹配 → 返回 `conflicts`，客户端**不覆盖**，进入「冲突待处理」 |
| 一端删除、一端修改 | 保持墓碑 + 冲突标记，默认**保留数据**（恢复优先于删除） |
| 手机离线大量修改 | 按 op 顺序回放，冲突逐个上报，不做自动合并 |
| 任务完成状态 | 以「完成」为更保守值：若任一端标记完成且 `completed_at` 更早，保留完成并保留另一端的新字段 |

**永不**用「最后写入者覆盖」处理 `due_at`/`remind_at`/`recurrence` 这类三态字段。

### 3.5 删除墓碑

- 新增 `tombstones(entity, id, deleted_at, rev)`；删除只写墓碑，不同步物理删除。
- 保留期：90 天（可配置）；超过后由桌面端物理清理并推进 `cursor`。
- 手机端收到墓碑后只删本地副本，**不反推**为「重新创建」。

### 3.6 尝试与退避

- 单次请求超时 5s；失败按 1s/2s/4s/8s/16s 退避，最大 60s，最多 6 次。
- 用户可见「立即重试」；取消时立即释放 socket 与超时定时器（不允许悬挂请求）。
- 连接状态变化（亮屏/网络切换/前台恢复）触发一次「单飞」同步，不重复并发。

---

## 4. 本地数据库（手机端）

```sql
tasks(id TEXT PK, title, description, status, priority, category, tags,
      due_at, remind_at, advance_minutes, recurrence_rule,
      updated_at, completed_at, rev INTEGER, server_rev INTEGER, dirty INTEGER)
notes(id TEXT PK, title, content, pinned, favorite, revision, updated_at, dirty)
captures(id TEXT PK, client_id TEXT UNIQUE NOT NULL, content, created_at, dirty)
outbox(op_id TEXT PK, entity, target_id, base_rev, patch, created_at, attempts)
tombstones(entity, id, deleted_at, PRIMARY KEY(entity, id))
kv(key TEXT PK, value)
```

- 与桌面端 SQLite **字段名保持一致**，`rev`/`server_rev`/`dirty` 为手机端同步元数据，
  不进入桌面 schema。
- `tasks` 的手机端表**不含** `recurrence_rule_id`（桌面端外键），改为内联 `recurrence_rule` JSON，
  同步时由桌面端转换。
- 所有本地写操作在**同一事务**里写业务表 + `outbox`，保证「要么两者都成功，要么都不发生」。

---

## 5. 目录组织方案

| 方案 | 适用条件 | 代价 | 结论 |
|---|---|---|---|
| A. 现有仓库内 `apps/mobile` | 需要共享 `shared/` 且希望一次 CI | 需要新增 workspace 配置；桌面构建产物目录需隔离 | **推荐**（前提：先完成 `shared/` 拆分） |
| B. 独立移动端仓库 | 移动端团队独立、发布节奏不同 | 共享层需发包（npm 私有源）；版本漂移 | 备选（若移动端由独立团队维护） |
| C. Monorepo + shared packages（Nx/Turborepo） | 多端 + 多层共享 | 引入新工具链与构建复杂度 | **不推荐**（当前只有两端、共享面 < 30%） |

选 A 的理由：本次审计确认可直接复用 23 个文件/4,744 行（严格口径），共享面不足以支撑
完整 Monorepo 改造成本；而 A 允许后续平滑升级到 C。

---

## 6. 设备标识与配对

1. 桌面端生成 `device_pairing_code`（6 位，5 分钟有效，一次性）。
2. 手机端扫码/输入 → 桌面端弹出「确认新设备 + 指纹」→ 用户确认后签发
   `device_token`（32 字节随机）+ `device_id`。
3. 手机端把 `device_token` 存入**系统安全存储**（iOS Keychain / Android Keystore），
   业务代码只拿句柄，日志与备份永不包含明文。
4. 桌面端保存 `device_id → token 哈希 + 权限位 + 最后活跃时间`，支持**单设备撤销**。
5. 撤销后：该 token 立即失效，手机端下次请求收到 `401` 并进入「已解除配对」状态，
   **不清空本地数据**（用户仍可离线查看）。

PoC 中已用系统安全存储保存 `device_id`（Flutter `flutter_secure_storage` / RN `expo-secure-store`），
两套均实测可用。

---

## 7. 通知与时区

- 提醒时间存储统一 **UTC**，展示与触发按设备本地时区计算（与桌面端 `tasks.rs:140-151` 一致）。
- 手机端与桌面端可能同时提醒：以 `(task_id, occurrence, device_id)` 生成通知去重键，
  桌面端在通知历史中记录已派发，手机端同步后**抑制**同键通知。
- 时区变化（跨时区飞行）时，以**绝对时刻**为准重算显示，不重算已存在的提醒记录。
- Android 13+ 必须显式请求 `POST_NOTIFICATIONS`；Android 12+ 定时通知需评估
  `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM` 的商店政策风险（本次真机实测：Android 16 上
  非精确定时通知会被系统延后，见报告 §4）。

---

## 8. 安全模型

| 面 | 要求 |
|---|---|
| 传输 | 仅局域网/隧道 + TLS + 证书指纹固定；拒绝降级 |
| 认证 | 每设备独立 token；constant-time 比较；请求体大小上限与并发上限 |
| 授权 | `read` 默认；`write` 需配对时勾选；`dangerous`（删除/批量/执行）**每次**二次确认 |
| 远程操作 | 默认**只读**；任何写操作带 `op_id` 审计日志（谁、何时、改了什么字段名，不记录正文） |
| 隐私 | 剪贴板正文/图片、文件路径、密钥永不进入同步载荷与日志 |
| 撤销 | 单设备撤销 + 全设备撤销；撤销即时生效 |
| 本机 | 手机端数据库可用 SQLCipher 或系统级加密；`device_token` 只进 Keychain/Keystore |

`http_ingest` 的既有约束（仅 127.0.0.1、Bearer token、64KB body、并发 32）**不适用于**移动端
监听，必须新建独立监听并沿用同等或更严格的限制。

---

## 9. 生命周期与资源

- 所有网络请求：可取消 + 超时 + 有界重试；页面销毁/应用退到后台时取消在途请求。
- 前台恢复：单飞同步（同一时刻最多一个），不做全量刷新。
- 后台任务：仅在「有待同步 op 且已配对」时注册，完成后注销；不使用常驻轮询。
- 本地通知：数量上限（例如 64 条排期），超出时按触发时间淘汰最远的一条。
- 大列表：虚拟化（Flutter `ListView.builder` / RN `FlatList`），实测均满足 300 条滚动
  （见报告 §4 的帧率数据）。

---

## 10. 未验证项（明确列出，避免误读为已完成）

- iOS 侧全部能力（本机无 macOS/Xcode）：**未验证**。
- 远程推送（APNs/FCM）：**未验证**（无推送凭据）。
- 主屏小组件：仅核对官方文档状态（RN `expo-widgets` 为 ALPHA；Flutter `home_widget` 为第三方），
  **未做 PoC**。
- 后台任务/后台同步：**未验证**。
- 真实配对流（扫码/指纹固定）：**未实现**，仅设计。
- 冲突合并、墓碑、游标推进：PoC 只验证了幂等与离线队列，**未验证**冲突路径。

---

## 11. 远程模式（跨网络同步）—— 待定需求

> 本节回答一个当前设计**不支持**的场景：手机与电脑不在同一局域网（几公里到十几公里，
> 中间隔着运营商 NAT）。先把结论写清：**这不是「距离」问题，是「是否可达」问题。**
> 同一网段内 10 米和 100 米没区别；一旦跨网段，就必须有一个双方都能连上的中间点。

### 11.1 三种形态与是否需要服务器

| 形态 | 是否需要服务器 | 适用 | 代价 |
|---|---|---|---|
| **A. 同一 Wi-Fi（当前设计）** | **不需要** | 家里/办公室同网 | 换网即断；手机用流量就用不了 |
| **B. 自建中继（推荐用于远程）** | **需要，但很小** | 任意网络 | 一台最低配 VPS；只做密文转发，看不到明文 |
| **C. 第三方组网（Tailscale/ZeroTier/WireGuard）** | 不需要自建，但依赖第三方控制面 | 任意网络 | 用户要装客户端/登录；商用授权与 iOS Network Extension 集成成本 |
| **D. 纯 P2P 打洞（WebRTC/QUIC）** | **实际上仍然需要**（STUN/TURN 兜底） | 任意网络 | 移动网 CGNAT 下成功率不保证；没有 TURN 就是"有时能用" |
| **E. 路由器端口映射 / 公网 IP** | 不需要 | 有公网 IP 的少数家庭宽带 | **直接把桌面端暴露到公网，安全红线，不采纳** |

### 11.2 为什么 B 是可接受的

- 中继**只转发密文**：配对时双方交换并固定公钥，之后每条消息端到端加密（NaCl box / X25519 + ChaCha20）。
  中继即使被攻破也拿不到任务内容。
- 桌面端与手机都是**主动外连**中继（出站长连接），桌面端**不开放任何入站端口**——这正好符合
  「不要把 `http_ingest` 暴露出去」的红线。
- 断线重连即用，不需要 mDNS，也不需要知道对方 IP。
- 实现量级：一个 WebSocket 转发服务（几百行）+ 客户端侧的信封加密与重连。

### 11.3 推送是另一个独立问题（比同步更依赖第三方）

数据同步解决的是"内容到了"，**不等于"手机能收到提醒"**。App 被系统杀掉后要弹通知，必须走推送通道：

| 平台 | 通道 | 说明 |
|---|---|---|
| iOS | APNs | 必须有 Apple 开发者账号与服务端签名 |
| Android（有 GMS） | FCM | 需要 Firebase 项目 |
| **国内 Android（本机 vivo 实测无 GMS 可用）** | 厂商推送（vivo / 小米 / 华为 / OPPO） | 每套都要单独申请、单独服务端对接 |

因此「重要提醒」这个卖点在跨地域场景下，**服务器与推送账号是绕不过去的成本**，
与选 Flutter 还是 RN 无关。

### 11.4 对选型的影响

- **不改变框架选择**：中继服务与推送对接在两个框架下工作量相当。
- 惟一边际差异：RN 侧 `expo-notifications` 内置 Expo Push Service（FCM/APNs 一条通道），
  Flutter 侧需要自己接 `firebase_messaging` 或各厂商 SDK。国内设备两边都要另接厂商推送。
- 结论：远程模式应当作为**独立里程碑**，不阻塞「同 Wi-Fi 联动 + 本地独立」的第一版。

### 11.5 需要产品决策的三点

1. 是否接受「必须有网 + 一台小服务器」的成本，还是先只做同 Wi-Fi？
2. 中继放哪里（自建 VPS / 对象存储 + WebSocket / 云函数）？
3. 推送优先级：只做同 Wi-Fi 时的本地通知，还是第一版就要跨网推送？
