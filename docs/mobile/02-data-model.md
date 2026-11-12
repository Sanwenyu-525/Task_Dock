# 手机端数据模型

> 权威：`apps/mobile/src/db/schema.ts` 与各表读写模块。本文解释**为什么这样设计**，
> 字段细节以代码为准。表字段名与桌面端 SQLite 对齐，便于将来同步直接对字段。

## 1. 表结构（SCHEMA_VERSION = 5）

### tasks

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 前缀 `t_` 的本地 ID |
| `title` | TEXT NOT NULL | 去空白后不得为空 |
| `description` | TEXT NOT NULL DEFAULT '' | 清空写 `''`，不写 `NULL` |
| `status` | TEXT NOT NULL | `pending` / `completed` |
| `priority` | INTEGER NOT NULL | 0 无 / 1 低 / 2 中 / 3 高（与桌面端一致） |
| `category` | TEXT NULL | 分类名 |
| `tags` | TEXT NULL | JSON 数组字符串；应用层暴露 `string[]` |
| `due_at` | INTEGER NULL | 截止时刻，epoch ms（UTC 存储） |
| `remind_at` | INTEGER NULL | 提醒时刻，epoch ms |
| `advance_minutes` | INTEGER NULL | 截止前 N 分钟提醒（与桌面端同义） |
| `recurrence_rule` | TEXT NULL | 重复规则 JSON，见 §6 |
| `created_at` / `updated_at` | INTEGER NOT NULL | epoch ms |
| `completed_at` | INTEGER NULL | 转为完成时写入，恢复待办清空 |
| `deleted_at` | INTEGER NULL | 软删除时间；非空即视为不存在 |
| `rev` | INTEGER NOT NULL DEFAULT 0 | 本地写操作计数器，每次写 +1 |
| `server_rev` | INTEGER NOT NULL DEFAULT 0 | v4：桌面端最后下发的版本号；push 的 `base_rev` 来源，0=从未同步 |

索引：`(status, due_at)`、`updated_at`、`due_at`。

### captures

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 前缀 `c_` |
| `client_id` | TEXT NOT NULL UNIQUE | 幂等键；重复提交只落一条 |
| `content` | TEXT NOT NULL | 原文，保留换行 |
| `kind` | TEXT NOT NULL DEFAULT 'text' | 手机创建固定 `text`；桌面下发的 kind 原样保留（UI 仍按纯文本展示） |
| `created_at` | INTEGER NOT NULL | |
| `deleted_at` | INTEGER NULL | 软删除 |
| `rev` | INTEGER NOT NULL DEFAULT 0 | 每次写 +1（含软删除 / 转任务） |
| `server_rev` | INTEGER NOT NULL DEFAULT 0 | v5：桌面端最后下发的版本号；push 的 `base_rev` 来源 |

### notes（v3 新增）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 前缀 `n_` |
| `title` | TEXT NOT NULL DEFAULT '' | 允许空串；列表展示回退摘要/「无标题」 |
| `body` | TEXT NOT NULL DEFAULT '' | 正文，保留换行 |
| `pinned` | INTEGER NOT NULL DEFAULT 0 | 置顶；列表排序 pinned DESC, updated_at DESC |
| `favorited` | INTEGER NOT NULL DEFAULT 0 | 收藏；筛选用 |
| `created_at` / `updated_at` | INTEGER NOT NULL | epoch ms |
| `deleted_at` | INTEGER NULL | 软删除 |
| `rev` | INTEGER NOT NULL DEFAULT 0 | 每次写 +1；写操作与 outbox 同事务（`entity="note"`） |
| `server_rev` | INTEGER NOT NULL DEFAULT 0 | v5：桌面端最后下发的版本号；push 的 `base_rev` 来源 |

索引：`updated_at`。

### outbox（本地写操作队列）

`op_id` PK、`entity`（task/capture/note）、`target_id`、`base_rev`、`payload`（JSON）、
`created_at`、`attempts`（v1 预留）、`state`（默认 `pending`；`sending`/`failed` 为重试状态；`conflict` 为 2026-11-12 新增的冲突守卫态：push 冲突后该记录的 outbox 行置此值——pull 继续跳过、`buildPendingOps`（只取 pending/failed）不重发，由冲突页「采用桌面端 / 保留本机」清理）、
`last_error`、`last_attempt_at`（v2）。

payload 形态（当前实现）：

| entity | type | 附加字段 |
|---|---|---|
| task | `create` | `title` |
| task | `update` | `patch`（三态载荷，见 §4） |
| task | `status` | `status` |
| task | `advance` | `dueAt`、`remindAt` |
| task | `delete` | — |
| capture | `create` / `delete` / `promote` | — |
| note | `create` | `title` |
| note | `update` | `patch`（title/body/pinned/favorited，三态载荷） |
| note | `delete` | — |

### reminder_schedule

`(task_id, occurrence_at)` 复合主键、`notification_id`、`scheduled_at`。

用「任务 × 发生时刻」做幂等键：同一任务的同一提醒只会有一条记录；改时间产生新的 occurrence，
旧记录在下一轮对账时清理。

### kv

`key` PK、`value` TEXT。当前使用：`theme_mode`、`reminder_actions_version`、
`reminder_snooze_enabled`（「10 分钟后」动作开关，缺省 `1`）、
`reminder_dismiss_on_complete`（完成后收起通知开关，缺省 `1`）、`widget_prefs`（小组件配置页偏好 JSON）。

## 2. 迁移规则

1. **append-only**：只在 `MIGRATIONS` 末尾追加，不修改已发布迁移的 SQL，不插入、不重排。
2. 版本号写 `PRAGMA user_version`，与 DDL 在**同一事务**内提交：要么全生效，要么全回滚。
3. `database.ts` 校验迁移序列必须从 `current + 1` 连续递增，出现缺口直接抛错，
   避免「跳过某条迁移却把版本号推到最新」的静默损坏。
4. `user_version > SCHEMA_VERSION`（用户装回旧版）时拒绝打开并报错，不允许旧 schema 写新库。
5. `journal_mode=WAL` 与 `foreign_keys=ON` 必须在迁移**之前**执行（不能在事务内切换）。
6. v1 → v2 已在真机验证不丢数据：v2 只做 `CREATE TABLE` / `ALTER TABLE ADD COLUMN` /
   `CREATE INDEX`，旧行靠 `DEFAULT` 获得新列值，不需要回填。

新增表/列时必须同步：本文件、`docs/mobile/01-architecture.md` 的模块地图（如涉及新模块）、
以及验收报告中的迁移用例（旧库升级 + 新库直建两种）。

## 3. 三态补丁契约（硬约定）

`updateTask(id, patch)` 对每个字段按三种状态处理：

| 传入 | 含义 |
|---|---|
| 键不存在（`undefined`） | **不改**该列 |
| `null` | **清空**该列 |
| 有值 | 写入 |

这条不能含糊：少写 `null` 用户就清不掉截止时间；把「没填」误传成 `null` 会静默清空字段。
构造 patch 时不要用 `field ?? null` 抹平两种状态，也不要在对象展开时带上 `undefined`——
`buildPatchPayload` 会丢弃 `undefined`、保留 `null`，但前提是调用方真的传对了。

`PATCH_COLUMNS` 是 camelCase → 列名的唯一映射，SET 子句与 outbox payload 共用，
避免两处漂移。任何写入都会追加 `updated_at = ?` 与 `rev = rev + 1`。

## 4. `rev` 与 outbox

- 每次业务写入（新建 / 编辑 / 完成 / 推进期次 / 软删除）在**同一事务**内：
  改业务表（`rev + 1`）+ 写一条 outbox。
- **三种实体**（任务 v4，收集箱 / 笔记 v5）的 `base_rev` 取写入前的 `server_rev`
  （服务端版本），不是本地 `rev`；从未同步过为 0。`server_rev` 由 pull 应用时写入，
  push 成功后再 pull 回填。
- outbox 只累积不发送；同步消费 `task` / `note` / `capture` 三种实体。同步页的
  「待发送操作」与设置页「本地待发操作」统计这三类。
- 收集箱的软删除与转任务已 `rev + 1`，`base_rev` 使用 `server_rev`（v5 修正了此前的 P3 不一致）。

## 5. 幂等

| 场景 | 机制 |
|---|---|
| 收集箱重复提交 | `captures.client_id` 唯一索引 + `INSERT OR IGNORE`，`changes === 0` 时读回已有行并返回 `duplicated: true` |
| 提醒重复排期 | `reminder_schedule` 复合主键 + 对账时按 `(task_id, occurrence_at)` 比对 |
| 通知动作重复点击 | `identifier` + `actionIdentifier` + `date` 三元组内存去重 |
| 转任务重复触发 | 事务内先查 `deleted_at IS NULL`，不存在返回 `null`；建任务 + 删条目同事务 |

## 6. 重复规则契约

`recurrence_rule` 存 JSON，字段与桌面端 `recurrence_rules` 一致：

```json
{
  "freq": "daily | weekly | monthly",
  "interval": 1,
  "by_weekday": [1, 2, 3, 4, 5],
  "by_monthday": 15,
  "by_setpos": null,
  "anchor": "2026-11-08"
}
```

- `by_weekday`：1=周一 … 7=周日（不是 JS 的 0=周日）。越界值在解析时丢弃。
- `by_monthday`：1–31；当月没有该日时收敛到月末（`min(day, 当月天数)`）。
- `by_setpos`：桌面端「每月第 N 个星期 X / 最后一个」（`-1`）扩展。手机端**解析并参与推进**，
  但编辑器不提供创建入口——避免做出桌面端不支持的规则组合。
- `anchor`：相位原点（`YYYY-MM-DD`）。weekly 的第几周 = `(目标日 - anchor) 的周数 % interval`；
  monthly 的候选月 = 锚点月 + k × interval。缺失时退回基准日。
- `nextOccurrence(rule, after)` 返回**严格晚于** `after` 的下一次发生；`advanceOccurrence`
  从 `fromDue ?? now` 起逐期推进到 `now` 之后（补偿休眠期错过的期次），上限 2000 步。
- 一律按设备本地时区、保留墙钟时分计算；跨时区不重算已排定的绝对时刻。
- 解析容错：坏 JSON、未知 `freq`、非法星期 → 退化为「不重复」或清洗后规则，不得抛错。
  历史脏数据不能让列表或完成操作崩溃。

完成重复任务的语义（与桌面端 `toggle_task` 一致）：

- **不**把任务标成已完成，而是把 `due_at` / `remind_at` 推进到下一次，任务保持待办。
- 提醒偏移优先用 `advance_minutes`；没有该字段才退回旧的 `due_at - remind_at`；
  原本没有提醒（`remind_at == null`）就保持没有，不凭空造提醒。
- 规则存在但算不出下一次（字段组合异常）时退回普通完成，至少让用户能关掉这条任务。

## 7. 提醒时间口径

- 存储一律 epoch ms（UTC），展示与触发按设备本地时区。
- 相对提醒（「提前 10 分钟」）落库同时写 `advance_minutes = 10` 并令
  `remind_at = due_at - 10min`；两处必须同时写，否则推进期次时算不准。
- 绝对提醒（「明天 9 点」）只写 `remind_at`，`advance_minutes` 置 `null`
  （这里 `null` 是有意义的「不是相对提醒」，不是「没改」）。
- 排期表记录的是绝对时刻，跨时区不重排。

## 8. 删除与墓碑

- 当前所有删除都是软删除（`deleted_at`），行保留，读取处一律过滤。
- 手机端不建墓碑表：本地删除写 outbox 的 `delete` 操作；桌面端 `tasks` 的 DELETE 触发器
  写墓碑，手机 pull 收到 `deleted=true` 后只软删除本地副本，不反推重建。
- 软删除同时 `rev + 1`（tasks），保证本地写路径可追踪。

## 9. 与 `docs/MOBILE_STACK.md` 设计稿的差异

设计稿写于实现之前，以下条目**没有按稿实现**，以本文为准：

| 设计稿 | 现状 | 原因 |
|---|---|---|
| `notes` 表 | v3 已建；v5 接入同步 | 2026-11-08 按原型落地；2026-11-09 接同步 |
| `server_rev` / `dirty` 列 | **task / note / capture 均已建 `server_rev`** | 三实体同步都需要服务端版本 |
| `tombstones` 表 | 手机端未建；桌面端由 `sync_changes` 记录墓碑 | 手机只消费墓碑并软删除本地副本 |
| `outbox.patch` 列 | 实际列名 `payload` | 与桌面端命名习惯统一 |
| `tasks.dirty` | 无 | 用 outbox 是否存在待发操作表达 |

### 9.1 同步元数据（v4 任务 / v5 收集箱与笔记，2026-11-09）

| 数据 | 位置 | 说明 |
|---|---|---|
| `server_rev` | `tasks`（v4）、`notes`、`captures`（v5） | 桌面端最后下发的版本号；push 的 `base_rev` |
| `sync_conflicts` | 手机 SQLite | `op_id`、`entity`、`target_id`、`reason`、`server_json`、`created_at`；冲突页读取 |
| 同步游标 | `kv['sync.cursor.v1']` | 服务端 `seq`，pull 原样回传 |
| 最近结果 | `kv['sync.last_result.v1']` | 时间、接收/发送/冲突数、错误摘要 |

旧 outbox 在 v4（任务）/ v5（收集箱、笔记）迁移时把 `base_rev` 从本地 `rev` 改写为
`server_rev`（从未同步为 0），避免历史积压操作首次同步时被误判冲突。解除配对时把三种实体
的 `server_rev` 与 outbox `base_rev` 归零（对端可能换成另一台桌面端，seq 不可比）。

## 10. 配对凭据与连接元数据（2026-11-08）

配对不新增 SQLite 表，也不改业务表结构：

| 数据 | 位置 | 键/字段 | 说明 |
|---|---|---|---|
| 设备令牌（64 位十六进制） | `expo-secure-store` | `taskdock.sync.token.v1` | 只存本机 Keystore；绝不进 kv/SQLite/日志 |
| 安装级设备标识 | `kv` | `device.uid.v1` | 首次配对生成 UUID；解除配对不清除，重装/清数据后重建 |
| 连接元数据 | `kv` | `sync.connection.v1` | `baseUrl/host/port/serverName/deviceId/platform/instanceId/fingerprint/pairedAt/lastSeenAt` |

- `kv` 是既有设置表，无需迁移；`deleteSetting` 只服务于解除配对时的清理。
- 元数据解析失败按「未配对」处理，不猜测字段；令牌读取失败（Keystore 不可用/格式不符）
  同样按未配对处理，绝不回退明文存储。
- 桌面端的设备授权表在桌面 SQLite（v42 `mobile_devices`；v46 增加可选 `device_uid`），
  不在手机端；同一 uid 重新配对会撤销旧授权。详细协议与安全边界见
  [06-pairing.md](06-pairing.md)。

## 变更记录

- 2026-11-08 首版：对齐 schema v2 与代码实际字段；登记 `captures` 未自增 `rev` 的已知不一致。
- 2026-11-08 v3：追加 `notes` 表（原型 notes/note_editor 两屏）；登记 note 的 outbox 载荷与
  提醒/小组件相关 kv 键。
- 2026-11-08 配对：新增 §10（SecureStore 令牌 + kv 连接元数据），明确不新增表、不改业务表。
- 2026-11-09 v5：`notes` / `captures` 增加 `server_rev` 并接入同步；收集箱软删除与转任务
  补 `rev + 1`；更新 §4 base_rev 语义与 §9 差异表。
- 2026-11-09 配对去重：手机端新增 `kv.device.uid.v1`；桌面端 v46 给 `mobile_devices`
  增加可选 `device_uid`（NULL 兼容旧记录/旧客户端），同 uid 重配对撤销旧授权。

## 变更记录

- 2026-11-12 outbox `state` 新增 `'conflict'` 守卫态（TEXT 列，无 schema 迁移）：
  push 冲突后保留该记录的 outbox 行并阻断 pull 覆盖，冲突页两条解决路径负责清理；
  同时删除墓碑应用补上 `rev <= server_rev` 比较旧墓碑跳过语义。见
  [07-sync.md](07-sync.md) 变更记录。
