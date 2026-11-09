# 手机同步 v1（任务）

> 状态：**任务双向增量同步已实现**（2026-11-09）。收集箱、笔记、后台同步、自动重试与
> 字段级自动合并仍属下一轮。配对与连接见 [06-pairing.md](06-pairing.md)。

## 1. 范围

| 已实现（v1） | 未实现（下一轮） |
|---|---|
| 任务 pull（桌面 → 手机）与 push（手机 → 桌面） | 收集箱（captures）与笔记（notes）同步 |
| 复合游标 `seq`、服务端版本 `rev`、本地 `server_rev` | 后台同步、仅 Wi-Fi 开关、前台自动同步 |
| 冲突检测、冲突落库与手机端「采用桌面端 / 保留本机」 | 字段级三方合并、自动冲突消解 |
| 删除墓碑（桌面硬删除 → 手机软删除） | 墓碑保留期与日志清理（当前无限增长） |
| `op_id` 幂等（重放只 ack） | 远程/跨网同步、TLS 与证书固定 |
| 载荷加密（XSalsa20-Poly1305）与 AAD 绑定 | iOS |

同步是**手动触发**的：手机「同步」页点「立即同步」，按 pull → push → 再 pull 执行。
配对成功不等于已同步，首次同步会把桌面现有任务作为基线拉下来。

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

### 3.1 变更日志（SQLite v43）

```sql
sync_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,
             entity, id, deleted, changed_at)
sync_ops(op_id PRIMARY KEY, device_id, applied_at)
```

- 触发器覆盖 `tasks` 的 INSERT/UPDATE/DELETE，命令层与内部 SQL 都无需改；
  `seq` 即该记录的同步版本号，`rev` 是「该记录最新一条变更的 seq」。
- 删除没有软删除列，DELETE 触发器写墓碑（`deleted=1`）。
- 迁移时把现有任务按 `updated_at` 回填一次基线，手机首次 pull 即可看到全部任务。
- `sync_changes` / `sync_ops` 属于本机同步状态：备份只写空 section，恢复忽略
  （`backup::is_local_transient_table`）。

### 3.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/changes?since=<seq>&limit=500` | 响应加密；`cursor` 为最后一条 seq |
| POST | `/v1/ops` | 请求/响应均加密；`{device_id, ops}` → `{ack, conflicts}` |

- 请求体上限 256KB，单批最多 100 条 op；Bearer 令牌鉴权并刷新 `last_seen_at/last_ip`。
- `since` 非法按 0；`limit` 限制在 1–500。
- push 在单事务内：`op_id` 幂等 → 版本比较 → 写入/墓碑 → 记 `sync_ops`。
- 未知实体（未来 notes/captures）当前跳过但推进游标。

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

### 3.4 冲突

- push 的 `base_rev` 必须等于该任务最新 `seq`；否则返回
  `{reason: "revision_mismatch", server_record}`，**不落库、不覆盖**。
- 记录不存在且 `base_rev>0` → `record_missing`；不存在且 `base_rev=0` → 创建。
- 本地删除与服务端修改同时发生：同样按版本冲突处理，墓碑不会静默吞掉远端新内容。

## 4. 手机端

### 4.1 数据库 v4

- `tasks.server_rev`：桌面端最后一次下发的版本号；本地编辑入 outbox 时作为 `base_rev`。
- `sync_conflicts(op_id, entity, target_id, reason, server_json, created_at)`。
- 迁移时把旧 outbox 的 `base_rev` 从本地 `rev` 改写为 `server_rev`（从未同步过为 0），
  避免历史积压操作在首次同步时被误判为冲突。
- 游标与最近结果存 `kv`：`sync.cursor.v1`、`sync.last_result.v1`。

### 4.2 pull

- 按页拉取（500/页，最多 10 页）；按顺序应用。
- 本地存在未发送 outbox 的记录跳过：交给 push 的 `base_rev` 判定冲突，不静默覆盖。
- 墓碑只软删除本地任务（`deleted_at`），不写 outbox。
- 应用到 `server_rev` 比本地旧的变更时跳过，避免分页重放回退版本。

### 4.3 push

- outbox 按 `target_id` 合并：同一条任务的多次编辑只发一个 op，
  `base_rev` 取最早一次编辑时的 `server_rev`（更保守）。
- 本地已删除 → `deleted: true` 的 op；否则发送当前完整字段补丁。
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
2. **冲突是整条记录级**：没有逐字段合并；用户选择一端。
3. **日志无清理**：`sync_changes` 随写操作增长；90 天保留期与清理任务未实现。
4. **仅任务**：收集箱/笔记的 outbox 仍只存本机，同步页的「待发送任务」只统计任务。
5. **无后台/自动同步**：需手动点「立即同步」；失败按客户端 5s 超时与退避重试，
   不会在后台轮询。
6. **无设备去重**：重复配对会新增设备记录（旧令牌仍有效），需在桌面端撤销旧设备。

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
| 收集箱/笔记/后台同步 | — | 未实现 |

证据：`tmp/acceptance/mobile-sync/`（截图、Node 协议脚本、DB 元数据查询、APK sha256）。

## 变更记录

- 2026-11-09 首版：任务 pull/push、加密信封、v43 变更日志、v4 手机 schema、冲突页与
  真机同步验证；明确收集箱/笔记、后台同步、日志清理与字段级合并未实现。
