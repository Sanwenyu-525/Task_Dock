# 手机同步 v1.1（任务 / 收集箱 / 笔记）

> 状态：**任务、收集箱、笔记的双向增量同步均已实现**（2026-11-09）。后台同步、自动重试、
> 字段级自动合并与日志清理仍属下一轮。配对与连接见 [06-pairing.md](06-pairing.md)。

## 1. 范围

| 已实现（v1.1） | 未实现（下一轮） |
|---|---|
| 任务 pull（桌面 → 手机）与 push（手机 → 桌面） | 后台同步、仅 Wi-Fi 开关、前台自动同步 |
| 收集箱 pull/push（仅 `inbox`；handled/converted 视为墓碑） | 字段级三方合并、自动冲突消解 |
| 笔记 pull/push（整篇标题 / 正文 / 置顶 / 收藏） | 墓碑保留期与日志清理（当前无限增长） |
| 复合游标 `seq`、服务端版本 `rev`、本地 `server_rev` | 笔记的任务 / 工作现场关联同步（桌面字段保留，不下发） |
| 冲突检测、冲突落库与手机端「采用桌面端 / 保留本机」 | 远程/跨网同步、TLS 与证书固定 |
| 删除墓碑（桌面硬删除或收集箱已处理 → 手机软删除） | iOS |
| `op_id` 幂等（重放只 ack）、长笔记按体积分批 | |

同步是**手动触发**的：手机「同步」页点「立即同步」，按 pull → push → 再 pull 执行。
配对成功不等于已同步，首次同步会把桌面现有任务 / 笔记 / 收集箱条目作为基线拉下来。

文件互传是同一配对通道上的独立协议（不进入 `sync_changes`，不使用 pull/push 游标），
端点、分块与存储见 [08-file-transfer.md](08-file-transfer.md)。

## 2. 传输与加密

传输仍是局域网 HTTP（与配对同一监听），但业务字段不再明文上线：

1. 配对时桌面端只保存 `token_hash = SHA-256(token)`（hex）；手机端令牌在 SecureStore。
2. 两端各自计算同步密钥：
   `key = SHA-512("taskdock-sync-v1:" + token_hash_hex)[0..32]`。
   手机端用 `expo-crypto` 现算 SHA-256，再经 `tweetnacl` 的 SHA-512；桌面端用 `sha2`。
3. 信封：`{ "v": 1, "n": "<base64 24B nonce>", "d": "<base64 ciphertext>" }`。
   明文是 `{"aad": "<方法|路径>", "data": ...}`；AAD 不匹配时解密直接失败，
   防止把 pull 密文重放到 push。
4. 鉴权仍是 `Authorization: Bearer <token>`；撤销/过期返回 401。

边界（可信局域网假设）：

| 风险 | 现状 | 说明 |
|---|---|---|
| 同网段嗅探业务正文 | **已加密** | 看不到任务标题/正文/标签；能看到请求大小、时间、端点 |
| 数据库泄露 | 哈希即 KDF 输入 | 拿到 `token_hash` 可解密历史密文，但无法反推令牌、不能通过 Bearer 鉴权 |
| 中间人替换桌面端 | 依赖配对确认指纹（展示用途） | 未做密码学固定；与配对轮同一偏差 |
| 重放到另一端点 | AAD 阻止 | 同端点重放：pull 只读；push 由 `op_id` 幂等 |
| 公网暴露 | 默认关闭，只绑局域网 IPv4 | 不要把端口映射到公网 |

后续升级 TLS 时，保留信封可作为第二层；届时本文的「HTTP」偏差需改为「已消除」。

## 3. 桌面端

### 3.1 变更日志（SQLite v43 + v44）

```sql
sync_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,
             entity, id, deleted, changed_at)
sync_ops(op_id PRIMARY KEY, device_id, applied_at)
```

- v43 建表并覆盖 `tasks`；v44 追加 `notes`（entity=`note`）与 `quick_capture_items`
  （entity=`capture`）的 INSERT/UPDATE/DELETE 触发器，命令层与内部 SQL 都无需改；
  `seq` 即该记录的同步版本号，`rev` 是「该记录最新一条变更的 seq」。
- 删除没有软删除列，DELETE 触发器写墓碑（`deleted=1`）。
- 迁移时回填基线：全部任务、全部笔记、仍在 `inbox` 的收集箱条目；已 handled/converted
  的条目不入基线。
- 收集箱状态改为 handled/converted 时仍记录更新，pull 读取时映射为墓碑——手机端只保留
  `inbox` 条目，处理完的条目从手机列表消失。
- `sync_changes` / `sync_ops` 属于本机同步状态：备份只写空 section，恢复忽略
  （`backup::is_local_transient_table`）。

### 3.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/changes?since=<seq>&limit=500` | 响应加密；`cursor` 为最后一条 seq |
| POST | `/v1/ops` | 请求/响应均加密；`{device_id, ops}` → `{ack, conflicts}` |

- 请求体上限 **1MB**（单条笔记正文上限 20 万字符，中文约 600KB），单批最多 100 条 op；
  Bearer 令牌鉴权并刷新 `last_seen_at/last_ip`。
- `since` 非法按 0；`limit` 限制在 1–500。
- push 在单事务内：`op_id` 幂等 → 版本比较 → 写入/墓碑 → 记 `sync_ops`。
- 未知实体跳过但推进游标，便于未来扩展。

### 3.3 字段映射（任务）

| 桌面 | 手机 | 规则 |
|---|---|---|
| `priority` 0–3 | `priority` 0–3 | 原样；桌面新建默认 2，手机默认 0 |
| `category` 非空字符串 | `category` 或 null | 空串 ↔ null |
| `tags` JSON 文本 | `tags: string[]` | 解析/序列化 |
| `due_at`/`remind_at` ISO | `dueAt`/`remindAt` epoch ms | RFC3339 ↔ 毫秒 |
| `advance_minutes` 0 表示不提醒 | `advanceMinutes` null | 0 ↔ null |
| `recurrence_rule_id` → `recurrence_rules` | `recurrenceRule` JSON | 展开为 freq/interval/by_weekday/by_monthday/by_setpos/anchor；`until` 暂不下发 |
| 硬删除 | `deleted_at` 软删除 | 墓碑 |

push 的补丁键使用手机 camelCase（`title/description/status/priority/category/tags/dueAt/
remindAt/advanceMinutes/recurrenceRule/completedAt/createdAt`），三态语义：
键缺失 = 不改，`null` = 清空，有值 = 写入。

### 3.3.1 字段映射（笔记）

| 桌面 `notes` | 手机 | 规则 |
|---|---|---|
| `title` | `title` | 原样；上限 200 字符 |
| `content` | `body` | 协议字段名为 `body`，上限 20 万字符 |
| `pinned` 0/1 | `pinned` boolean | |
| `favorite` 0/1 | `favorited` boolean | |
| `created_at` / `updated_at` ISO | `createdAt` / `updatedAt` epoch ms | |
| `revision` | 不下发 | 桌面并发编辑检测；同步更新会 `revision + 1` |
| `task_id` / `workspace_id` / `source_capture_id` | 不下发 | 手机端无对应字段；push 更新不触碰这些列 |
| 硬删除 | `deleted_at` 软删除 | 墓碑 |

### 3.3.2 字段映射（收集箱）

| 桌面 `quick_capture_items` | 手机 | 规则 |
|---|---|---|
| `id` / `client_id` | `id` / `clientId` | `client_id` 唯一索引继续做幂等键 |
| `content` | `content` | 上限 4000 字符；手机端本地先拦截超限 |
| `kind` | `kind` | 桌面五种 kind 原样下发；手机 UI 统一按纯文本展示 |
| `created_at` / `updated_at` ISO | `createdAt` epoch ms | 手机没有 `updated_at` 列 |
| `status != 'inbox'` | 墓碑 | handled/converted 不在手机展示 |
| 硬删除 | `deleted_at` 软删除 | 墓碑 |

### 3.4 冲突

- push 的 `base_rev` 必须等于该记录最新 `seq`；否则返回
  `{reason: "revision_mismatch", server_record}`，**不落库、不覆盖**。
- 记录不存在且 `base_rev>0` → `record_missing`；不存在且 `base_rev=0` → 创建。
- 本地删除与服务端修改同时发生：同样按版本冲突处理，墓碑不会静默吞掉远端新内容。
- 笔记的桌面 `revision` 与同步 `seq` 是两套版本：桌面编辑器仍用 `revision` 防覆盖；
  同步 push 只比较 `seq`，更新时递增 `revision`，避免桌面编辑器用旧 revision 静默覆盖。

## 4. 手机端

### 4.1 数据库 v5

- `tasks.server_rev`（v4）、`notes.server_rev`、`captures.server_rev`（v5）：
  桌面端最后一次下发的版本号；本地编辑入 outbox 时作为 `base_rev`。
- `sync_conflicts(op_id, entity, target_id, reason, server_json, created_at)`。
- 迁移时把旧 outbox 的 `base_rev` 从本地 `rev` 改写为 `server_rev`（从未同步过为 0），
  避免历史积压操作在首次同步时被误判为冲突。
- 收集箱的软删除与转任务现在也 `rev + 1`，base_rev 使用 `server_rev`（v5 一并修正）。
- 游标与最近结果存 `kv`：`sync.cursor.v1`、`sync.last_result.v1`。
- 解除配对时清空游标/冲突、把三种实体的 `server_rev` 与 outbox `base_rev` 归零，
  避免换一台桌面端后沿用不可比的旧版本号。

### 4.2 pull

- 按页拉取（500/页，最多 10 页）；按顺序应用。
- 本地存在未发送 outbox 的记录跳过：交给 push 的 `base_rev` 判定冲突，不静默覆盖。
- 墓碑只软删除本地副本（`deleted_at`），不写 outbox；收集箱 handled/converted 走同一路径。
- 应用到 `server_rev` 比本地旧的变更时跳过，避免分页重放回退版本。
- 收集箱插入前检查 `client_id` 唯一索引；撞到另一条本地记录时跳过而不是覆盖。

### 4.3 push

- outbox 按「实体 + `target_id`」合并：同一条记录的多次编辑只发一个 op，
  `base_rev` 取最早一次编辑时的 `server_rev`（更保守）。
- 本地已删除、收集箱已转任务（`promote`）→ `deleted: true` 的 op；
  否则发送当前完整字段补丁（笔记：title/body/pinned/favorited/createdAt；
  收集箱：clientId/content/kind/createdAt）。
- 按条数（50）与 UTF-8 体积（约 700KB）分批 push；服务端上限 1MB。
- ack：清理本批的 outbox；冲突：清理本批 outbox 并写 `sync_conflicts`。
- 同步期间用户继续编辑产生的新 outbox 行不会被本批结算误删（按 `created_at` 快照）。
- push 成功后立即再 pull 一次，把服务端新 `rev` 落回 `server_rev`，避免下次编辑自冲突。

### 4.4 冲突页

- 「采用桌面端」：把 `server_record` 应用到本地（或删除本地副本），删除冲突记录。
- 「保留本机」：把本地 `server_rev` 对齐到服务端版本，重新入队一次更新并立即同步；
  若期间桌面端又改过，会再次产生冲突。
- 不自动合并、不使用「最后写入者覆盖」。

## 5. 已知限制与风险

1. **元数据仍可见**：HTTP 头、端点、请求大小与时间未加密；敏感正文在密文内。
2. **冲突是整条记录级**：没有逐字段合并；用户选择一端。笔记冲突同样以整篇为单位。
3. **日志无清理**：`sync_changes` 随写操作增长；90 天保留期与清理任务未实现。
4. **无后台/自动同步**：需手动点「立即同步」；失败按客户端 5s 超时与退避重试，
   不会在后台轮询。
5. **笔记关联不同步**：桌面 `notes.task_id` / `workspace_id` / `source_capture_id`
   不下发也不被 push 覆盖；手机端暂无对应关联 UI。
6. **收集箱是单向状态机**：手机只展示 `inbox`；桌面标记 handled/converted 后手机删除本地副本。
   若桌面把状态改回 `inbox`，下一次 pull 会重新恢复该条目（服务端 seq 更新）。
7. **收集箱 4000 字符上限**：手机端在本地拦截超限内容，避免推上去变成 `invalid_patch`。
8. **设备去重依赖手机端标识**：新客户端发送安装级 `device_uid`，同一安装重新配对会替换
   旧授权；旧客户端不传该字段时仍会新增记录，需要手动撤销。

## 6. 验收证据（2026-11-09）

| 项 | 通道 | 结果 |
|---|---|---|
| Rust 同步单测（加密/AAD、触发器、pull 游标、push 创建/幂等/冲突/墓碑） | A | **7/7 PASS** |
| 跨语言加密向量（tweetnacl → Rust 解密） | A | PASS |
| 手机端 crypto 模块独立测试（KDF、双向信封、AAD 拒绝） | A（esbuild + Node） | PASS |
| 手机端类型检查 | A | `npx tsc --noEmit` exit 0 |
| 协议级 pull/push（Node 加密客户端 → 隔离桌面端） | C（真实监听） | 基线 4 条、创建 ack、重放幂等、冲突不覆盖、墓碑删除 PASS |
| 手机端真实同步（vivo V2323A，Release APK） | D | 接收 4、发送 21、待发送 0；桌面端任务 4→22、`sync_ops=21`、`last_seen_at` 刷新 |
| 手机端冲突页真机复现 | D | PASS：手机完成任务、桌面改名后同步得到 1 条冲突；冲突页显示两端版本，「采用桌面端」后标题/状态回到桌面版本、冲突清空 |
| 笔记 push（手机 → 桌面） | D | PASS（0.1.6/vc13 真机）：手机待发送 16→0，实际发送 9 条 op；桌面 `notes` 出现「巧 review」，正文完整 |
| 收集箱 push（手机 → 桌面） | D | PASS：桌面 `quick_capture_items` 出现「Z」「B」，`status=inbox`、client_id 保留 |
| 笔记 pull（桌面改 → 手机） | D | PASS：桌面改标题为「巧 review（桌面改）」后手机同步，笔记页标题与 revision 更新；再改回「巧 review」并同步还原 |
| 收集箱 handled → 手机删除 | D | PASS：桌面把 Z 标为 handled，手机同步后收集箱只剩 B；桌面改回 inbox 后同步，Z 重新出现 |
| 收集箱 / 笔记协议级（导出/映射/冲突/墓碑） | A/C | PASS：基线只含 inbox、note content→body、冲突 server_record、handled 墓碑、client_id 重名拒绝 |
| 笔记冲突页（真机） | D | PASS：手机改正文 + 桌面改标题 → 同步得 1 条冲突；冲突页标「笔记 · 桌面端版本 39」，采用桌面端后手机标题更新、桌面 `revision` 不变 |
| 收集箱冲突页（真机） | D | PASS：手机删「B」+ 桌面改内容 → 冲突页标「收集箱 · 桌面端版本 40」；采用桌面端后本地条目恢复为桌面内容 |
| 收集箱 4000 字拦截（真机） | D | PASS：粘贴 4016 字保存提示「收集箱内容不能超过 4000 字」，列表不变、`outbox` 无新增 |
| 解除配对后版本清零（真机） | D | PASS（2026-11-09 20:00–20:12）：解除后「未配对」、待发送仍为 1（outbox 保留）、上次接收清空；重新配对后首次同步 **接收 39（全量基线）+ 冲突 1**（笔记 `base_rev=0` vs 服务端 44）、采用桌面端后收尾。若未清零，`base_rev=44` 会直接 ack 而不是冲突 |
| 后台/自动同步 | — | 未实现 |

证据（v1.1）：`tmp/acceptance/mobile-sync-v2/`（真机截图、协议脚本与结果、APK sha256）。
APK 0.1.6（versionCode 13）sha256 `ad349b80d657f7f8c031052dcfb123180d20723e61ed94e2c83513742c922a28`。

## 变更记录

- 2026-11-09 首版：任务 pull/push、加密信封、v43 变更日志、v4 手机 schema、冲突页与
  真机同步验证；明确收集箱/笔记、后台同步、日志清理与字段级合并未实现。
- 2026-11-09 v1.1：v44 变更日志覆盖 `notes` / `quick_capture_items`；手机 schema v5；
  笔记与收集箱双向同步、handled/converted 墓碑、长笔记分批、收集箱 4000 字本地拦截；
  真机验证 push/pull/墓碑与恢复。后台同步与日志清理仍未实现。
- 2026-11-09 文件互传 v1 作为同通道独立协议加入：v45 `mobile_files`、分块加密与
  AAD、桌面/手机文件页；不改变本文件的 pull/push 契约，详见
  [08-file-transfer.md](08-file-transfer.md)。
- 2026-11-09 补真机验证（v1.1 范围）：笔记冲突页与收集箱冲突页在物理机复现并「采用桌面端」
  解决；收集箱 4000 字由真机粘贴 4016 字触发本地拦截且不落库。解除配对后的版本清零仍未
  执行（需桌面端配对码），从「未验证」保持原状。
- 2026-11-09 解除配对真机验证：解除后重配同一桌面端，首次同步接收 39 条全量基线并让
  1 条遗留笔记 op 命中 `revision_mismatch`，证明游标与 `server_rev/base_rev` 均已清零；
  「采用桌面端」后冲突清空、待发送 0。设备上的 APK 在 19:59:40 被并行会话以同版本
  （0.1.6/13）覆盖安装，同步代码来自同一工作树。配对新设备时 vivo 输入法会把地址里的
  `.` 转成 `。`、且漏字符，需人工修正后再提交。
