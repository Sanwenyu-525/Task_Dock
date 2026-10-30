# Task Dock 性能与消息管线架构（v0.5）

> 本文描述 v0.5 性能专项后的真实实现。性能目标、测量方法与结果见
> [PERFORMANCE_TESTING.md](PERFORMANCE_TESTING.md) 与
> [PERFORMANCE_ACCEPTANCE_REPORT.md](PERFORMANCE_ACCEPTANCE_REPORT.md)。
> 所有阈值/默认值均可在代码中检索到对应常量或设置键。

## 1. 目标与边界

**目标**

- 事件接入有界、可背压、可观测；过载时显式降级/拒绝，绝不伪装成功。
- `waiting` / `failed` / `completed` / `disconnected`（以及 `idle`）等关键状态
  永不合并、永不静默丢弃；`running` 及高频进度允许按轮次合并。
- 高频事件不线性放大 SQLite 写入、托盘刷新和前端快照请求。
- 历史事件可归档、可清理、可分页读取，且清理不删除受保护状态。

**不做的事**

- 不关闭 Agent 监控、不降低事件校验、不降低安全限制来换取吞吐。
- 不修改第三方 Agent 的官方 Hook/插件协议；上报失败不得阻塞或杀死 Agent。
- 不承诺端到端 exactly-once：跨进程重试可能重复上报，服务端以
  `dedupe_key`（`eid:<source>:<event_id>` 或内容签名）保证幂等。
- Agent 轮次结束 ≠ 用户任务完成；任务完成仍由用户显式操作或提醒规则驱动。

## 2. 统一接入管线

代码：`src-tauri/src/agents/pipeline.rs`

```
HTTP / 文件投递 / Hook CLI / 插件桥接 / Mock
        │  submit(events, transport, submitter, wait)
        ▼
有界队列（事件计数信号量 + mpsc）
        │  合并缓冲（仅 running，按 来源/实例/会话/轮次/通道 键）
        ▼
单消费者：合并窗口内凑批（≤ batch_size）
        │  一个事务一批 → ingest_core（校验/幂等/状态机/事件/通知记录）
        ▼
提交后副作用：每批一次广播 + 一次托盘刷新 + 聚合通知（≤3 条弹窗 + 摘要）
```

### 2.1 配置

| 设置键 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- |
| `ingest_queue_capacity` | 1024 | 16 ~ 65536 | 有界队列容量（事件数） |
| `ingest_batch_size` | 100 | 1 ~ 1000 | 单事务最大事件数 |
| `ingest_coalesce_ms` | 250 | 100 ~ 500 | 合并窗口（首批到达后最多等待多久凑批） |
| `merge_buffer_capacity` | 4096 | 常量 | 队列满时非关键事件按轮次键覆盖的缓冲上限 |

`PipelineConfig::from_settings` 负责读取；`channel_capacity()` 再将 mpsc 通道
限制在 16 ~ 4096（信号量仍按 `queue_capacity` 计事件数）。

### 2.2 事件分级与合并规则

| 类别 | 状态 | 队列满时 | 合并 |
| --- | --- | --- | --- |
| 关键 | `waiting` / `failed` / `completed` / `disconnected` / `idle` | 返回 `Overloaded`（HTTP 503 + Retry-After），**可重试** | 永不合并 |
| 可合并 | `running`（含工具进度/心跳） | 进入合并缓冲；缓冲满则**显式采样**并计数 | 仅同一 `source_id + instance_id + session_id + run_id + transport` |

- 合并只发生在同一轮次键内，跨会话/跨轮次绝不互相覆盖。
- `events_merged` / `events_sampled` 分别计数；采样只作用于非关键事件，
  且在 HTTP 响应中返回 `sampled: 1`，调用方可感知。
- 关键事件在入队前先 `validate_event`，非法载荷直接 422/400，不进队列。

### 2.3 批处理、顺序屏障、失败隔离与生命周期

- **全局顺序**：每个事件在提交时分配单调递增的 `ingest_seq`；消费者每轮把
  主队列作业与合并缓冲中待冲刷的事件放在一起，按 `ingest_seq` 排序后写入。
  因此不同通道（HTTP/文件/Hook/插件）之间的迟到事件不会因批边界乱序。
- **关键状态是合并屏障**：关键事件（waiting/failed/completed/disconnected/idle）
  到达时，先冲刷同一轮次已合并的 running，再写入关键事件；屏障之后到达的
  旧 running 不会覆盖终态。关键事件自身永不合并。
- 消费者在合并窗口内收拢最多 `batch_size` 个事件；同一批内重复 running
  按轮次槽位覆盖（被覆盖事件计入 `events_merged`）。
- 整批一个事务写入；若事务失败，按**原作业**逐个回退重试（每作业独立事务），
  隔离坏事件并保留单作业原子性（`commit_failures` / `fallback_jobs`）。
- `wait=true`：等待事务提交后返回（关键状态、批量 HTTP、需要确认的调用方）；
  `wait=false`：running 快速入队，不阻塞调用方。
- `start()` 幂等；`shutdown()` 先停止接收新提交，把队列与合并缓冲中的事件
  全部排空，再停止消费者；超时（默认 10s）后把剩余事件写暂存文件并如实报告
  `unfinished_events` / `timed_out`，不会无限挂起，也不会假装已落库。
- 退出报告写入数据目录 `last-shutdown-report.json`（生命周期、耗时、排队/排空数、
  未完成数、恢复说明），供下次启动与验收审计。
- 入队等待有 `enqueue_timeout`（1.5s）；等待落库有 `ack_timeout`（15s）。
  超时返回可重试错误，不会静默成功。

## 3. 接入通道

### 3.1 本地 HTTP（`src-tauri/src/agents/http_ingest.rs`）

- hyper 1.x 异步服务器，仅绑定 `127.0.0.1`；Bearer 令牌鉴权（未配置/不匹配 401）。
- 连接上限 64，活跃请求上限 32；超限直接 429 + `Retry-After: 1`。
- 请求头超时 5s、请求体读取超时 5s、整体请求超时 20s。
- 请求体上限 64 KiB（`MAX_BODY`），超限 413。
- `POST /api/v1/events` 接受单个对象或数组；**批量保持全成功/全失败**：
  任一事件非法整批 400，不产生部分写入。
- 管道过载 → 503 + `Retry-After`；关键事件绝不返回 200。
- `GET /api/v1/health` 无需令牌；`GET /api/v1/stats` 需要令牌。

### 3.2 文件投递（`src-tauri/src/agents/file_drop.rs`）

- 只处理稳定文件：mtime 超过 300ms，且排除 `.tmp` / `.partial`；
  写入方应先写临时文件再 rename（本应用与插件模板都遵循）。
- 扫描间隔自适应：有积压/刚处理过为 750ms，仅有待处理为 1s，空闲逐步退避到 5s；
  每轮最多读取 16 MiB；单文件最多 1000 条事件。
- 硬容量（`inbox.rs`）：**5000 个文件 / 256 MiB**；单文件上限 **8 MiB**；
  另为关键状态预留 **250 个文件 / 16 MiB**，普通 running 写入不得占用预留额度。
- 单文件大小上限 `agent_inbox_max_file_bytes`（默认 4 MiB）；
  每轮最多处理 `agent_inbox_max_files`（默认 200）个文件。
- 失败的稳定文件移动到 `failed/`，指数退避重试（最多 8 次），
  可通过「设置 → 性能诊断 → 重试失败投递」或 `agent_inbox_retry` 手动恢复。
- 处理成功后的投递文件会被删除（它是 Agent 侧事件的传输副本，不是用户历史）；
  失败文件保留，绝不因容量清理删除他人文件。入库失败超限的关键文件进入
  `failed/` 并写 `.inbox-failures.log`，可用手动重试恢复。
- 插件/HTTP 回退文件使用稳定 `event_id`，跨通道重复由 `dedupe_key` 吸收。

### 3.3 Hook CLI（`src-tauri/src/agents/hook_cli.rs`）

- 原生 CLI 直接由 Agent 的 Hook 调用，避免每个事件启动 PowerShell 的进程开销。
- stdin 上限 1 MiB；连接超时 700ms、读写超时 1200ms。
- 优先 HTTP 上报；失败时写文件回退到 `agent-inbox/`（有界、原子 rename）。
- 事件 ID 由稳定内容哈希生成，HTTP 成功但客户端超时后的文件回退不会造成重复状态。

### 3.4 插件桥接（DSH / OpenCode）

模板见 `src-tauri/src/agents/dsh.rs`、`opencode.rs`：

- 队列上限 200；关键事件插队；非关键 running 按 `session_id + state` 合并。
- 单并发发送、2.5s `AbortController` 超时、指数退避（上限 30s）。
- 关键事件 HTTP 失败时写文件回退；仍失败则回队重试。
- 定时器 `unref()`；Task Dock 不可用不会卡住/退出 Agent。

## 4. 前端刷新调度

代码：`src/store/useAgentsStore.ts`、`src/App.tsx`、`src/components/history/HistoryPanel.tsx`

- 事件驱动：`agent-changed` / `notification` 只调用 `scheduleAgentRefresh()`，
  不直接发请求。
- 调度器：按优先级节流（critical 100ms / normal 400ms）+ **单飞**（最多 1 个
  在途快照）+ 脏标记（在途期间到达的事件只补拉一次）+ 失败指数退避。
- 窗口隐藏时只置脏、不刷新；`visibilitychange` 恢复可见时补一次。
- 前端诊断指标：`getAgentRefreshMetrics()` 提供快照请求数、应用数、合并数、
  隐藏跳过数、最大并发、最近延迟/错误；设置页「性能诊断」展示。
- 历史面板：首次只加载最近 100 条事件/通知；「加载更早的事件」用
  `list_agent_events(before=<最后一条 id>)` 做 keyset 分页；刷新采用增量合并，
  不会把已翻页内容截断；通知/事件到达后 500ms 防抖刷新，窗口隐藏时跳过。
- 三个视图常驻挂载，模式切换不丢状态；Zustand 使用细粒度选择器，
  Agent 树仅在其快照变化时重算。

## 5. SQLite 读写与保留

代码：`src-tauri/src/db/mod.rs`、`src-tauri/src/agents/retention.rs`、
`src-tauri/src/commands/data.rs`

### 5.1 连接与索引

- WAL；单写连接（`Mutex<Connection>`）+ 3 个只读连接（`query_only=ON`，
  round-robin）。读路径（快照/历史/统计/导出）使用 `with_read`，
  不占用写锁；写路径（`with_conn`）保持事务原子性。
- 读延迟统计：调用数、平均耗时、≥100ms 慢查询计数（`read_stats()`）。
- v0.5 迁移补充事件/通知/轮次/会话/提醒/关联索引：
  `idx_events_source_received`、`idx_events_session_received`、`idx_events_run`、
  `idx_events_state_received`、`idx_notifications_unread`、`idx_runs_updated`、
  `idx_sessions_last_seen`、`idx_reminders_task`、`idx_sources_visible`、
  `idx_links_session` 等。

### 5.2 历史查询

- `list_agent_events` 使用 `(received_at DESC, id DESC)` keyset 分页：
  先解析锚点 `received_at`，再以 `(received_at < ? OR (= ? AND id < ?))` 取下一页，
  结果稳定、无 OFFSET 扫描。
- 历史面板只在打开时加载；默认 100 条/页，可继续加载更早事件。
- **行动中心（v0.5）**同样使用 keyset/cursor 分页，且**全局计数与分页解耦**：
  - 三个独立分类各自一条查询：需介入（`origin='real'` 且轮次
    `status IN ('waiting','failed')`）、未确认通知（`notification_history` 中
    `origin='real'` 且 `is_read=0`）、历史事件（近 `HISTORY_LOOKBACK_DAYS=30` 天）；
  - `counts` 由**显式 SQL 聚合**得出（全库总数），`filtered_total` 是当前筛选
    条件下的总数，两者都**不随当前页截断**；首屏默认 `ITEM_LIMIT_DEFAULT=40`，
    上限 `ITEM_LIMIT_MAX=200`；
  - 新事件到来时列表按 `(created_at DESC, id DESC)` 稳定排序，配合
    「最新事件优先」语义刷新，不会出现跳条或重复；
  - 复合游标（时间戳 + 行 ID）在 v13 迁移中补齐了配套索引，
    保证深翻页不退化为全表扫描。
- **归属隔离（v0.5）**：压测/自测事件的 `origin` 由服务端判定，
  不进入真实分类、不产生系统通知，也不计入「需介入」徽标，
  见 [AGENT_ADAPTERS.md](AGENT_ADAPTERS.md)。

### 5.3 事件保留与归档

- 仅 `running` / `idle` 可自动清理；`waiting/failed/completed/disconnected`
  永不自动删除（`protected_rows` 单独统计）。
- 触发条件：`agent_event_retention_days`（默认 30 天，0 关闭）或
  `agent_event_max_rows`（默认 200000，0 关闭），单轮最多 5000 条。
- 删除前先写 JSONL 归档（带文件头）；归档失败 → **本次不删除**，
  报告 `archive_error`。写入使用临时文件 + fsync + 原子 rename。
- 删除按 500 条分块提交，避免长事务锁住主路径。
- 后台任务：启动 20s 后执行一次，此后每 6 小时一次；结果通过
  `agent-retention` 事件上报（设置页也可手动触发）。
- 归档文件可用 `agent_archive_list` 列出；恢复方式见
  [PERFORMANCE_TESTING.md](PERFORMANCE_TESTING.md#归档恢复)。

### 5.4 导出/备份

- **统一注册表**：`BACKUP_TABLES` 声明 25 张用户业务表及恢复顺序/外键依赖；
  `EXTENDED_TABLES` 标记剪贴板、工作现场与行动中心表。schema 新增表未登记时
  `backup_registry_covers_every_schema_table` 失败，避免漏备新模块。
- **完整备份（full）**：流式 JSONL bundle（header/section/archive/asset/integrity），
  表行 500 行/块；全量业务表 + 事件归档 JSONL + 全部被引用的剪贴板原图/缩略图；
  事件与通知可到十万级；header 的 `manifest_version`/`registry`/`counts` 可核验。
- **快速备份（quick）**：始终 `partial=true`，事件保留最近 20000 条 + 全部
  running/waiting 保护行；通知 500、导航日志 500、剪贴板条目 2000、粘贴作业 500。
  header 记录数据库总量、`partial_reasons` 与 `truncated_tables`，**不静默截断**；
  只打包被导出条目引用的资产，避免恢复出无文件的剪贴板行。
- 备份先写临时文件，完成后原子替换；目标已存在时先轮换为 `.previous`，
  替换失败恢复旧文件，绝不覆盖有效备份。bundle 的 `sha256` 是内容链
  （integrity 行之前所有字节）的摘要，不是整个文件字节的摘要；导入会逐行重算校验。
- 读取端校验：完整性哈希、header 版本/格式、未登记表拒绝、每表行数与 counts 一致、
  资产路径结构/大小/SHA-256/引用集合一致、归档分块顺序与总大小一致；
  不满足则在写入数据库前拒绝。
- 恢复（`restore_bundle`）先校验完整性/结构/引用，自动生成 pre-restore 完整备份，
  再单事务替换数据库并写提交标记；资产与归档先落会话 staging，提交前把原文件复制到
  vault，逐个原子替换；失败按逆序回滚并删除本次新建文件。
- 恢复日志状态机 `preparing → validated → ready_to_commit → committing → completed`，
  失败 `rollback_required → rolling_back → rolled_back`；回滚失败保留证据为
  `failed_unrecovered`，启动时继续尝试。旧版 bundle/JSON 恢复保留库内扩展模块数据。
- 备份/恢复/导出均放入 `spawn_blocking`，不阻塞 UI 事件循环；备份使用只读快照连接，
  `Db::with_read` 的 try-lock 会跳过该长快照连接，普通查询不再等待整个备份结束。
- **内存边界（诚实记录）**：备份是流式写入，100k 事件 + 10k 通知 + 5k 剪贴板条目 +
  500 张真实 PNG 的 bundle 为 61.9 MB，最终源码复跑备份峰值约 27.4 MB WS；
  但恢复端 `read_bundle` 仍会把表行 materialize 为 JSON 与强类型行，
  同一夹具恢复观测峰值 **619.0 MB WS**，不是常量内存流式恢复，详见
  [PERFORMANCE_FINAL_ACCEPTANCE.md](PERFORMANCE_FINAL_ACCEPTANCE.md) §7 与 §13。

## 6. 托盘与通知聚合

代码：`src-tauri/src/agents/mod.rs`（`after_batch`）、`src-tauri/src/lib.rs`、
`src-tauri/src/agents/notify.rs`

- 每批提交只执行一次副作用：一次 `agent-changed` 广播、一次托盘刷新、
  最多 3 条系统弹窗（其余合并为一条摘要，数据库仍逐条记录）。
- 托盘提示：单条 SQL 聚合查询；文本相同不更新；非图标变化时最多 5s 一次。
- 进度类 running 不触发系统弹窗；`waiting/failed/completed` 保持准确通知。
- **跨批次全局限频（v0.5，`NotifyGate`）**：限流状态是**跨批次**持有的，
  不随一次 `after_batch` 重置：
  - 窗口内最多 `notify_burst_max` 条独立弹窗（1~20，默认 3），
    窗口长度 `notify_rate_window_secs`（10~3600 s，默认 60 s）；
  - 等待/失败优先占用额度，先于完成弹出；
  - `agent_done` 与 `reminder` 属于**可合并**类型，同窗口内多条合并为一条
    摘要，避免高频完成刷屏；
  - 被抑制的通知在窗口结束时由调度器每秒调用的 `flush` 汇总为一条摘要，
    摘要本身每窗口最多一条；
  - 静音/免打扰时**不进入** `plan`，因此不消耗额度；
  - 数据库中的通知历史逐条保留（同事务提交），限流只影响「是否弹到桌面」，
    **不丢数据**。
- 调度器到期的任务提醒同样走 `NotifyGate`：一个 tick 收集全部到期提醒 →
  `notify_reminder_popups` → 合并为一条「任务提醒汇总」，
  并只广播一次带 `task_ids` 的 `reminder-fired` 事件（避免事件风暴）。

## 7. 诊断指标

- 后端 `performance_diagnostics` 命令（受 `perf_diagnostics_enabled` 控制）返回：
  - 管线：队列深度/容量、批次数、合并/采样/拒绝/提交失败、接入与写库 p50/p95/p99；
  - HTTP：连接/活跃请求/接受/拒绝/解析失败/过载；
  - 文件投递：待处理文件数/字节、失败数、最老文件年龄；
  - SQLite：读池大小、读调用数、平均读耗时、慢查询数；
  - 事件保留：可清理/受保护行数、最近归档；
  - Hub 规模：来源/会话/轮次数与最差状态。
- 前端刷新指标由前端自行上报（`getAgentRefreshMetrics()`），后端不伪造。
- 诊断关闭后仅保留最小计数，不采样延迟分位。

## 8. 可靠性边界（诚实声明）

1. **合并会丢失 running 的中间过程**：同一轮次在合并窗口内的重复 running
   只保留最新一条（计数可观测）。关键状态从不合并。
2. **不是 exactly-once**：HTTP 客户端超时但服务端已提交时，客户端重试依赖
   `event_id`/内容签名幂等吸收；未提供 `event_id` 且内容完全相同的两次上报
   也会被视为重复。
3. **过载时非关键事件可能被采样丢弃**（显式计数）；关键事件得到可重试错误。
4. **前端窗口隐藏时不刷新**，恢复可见后补一次；隐藏期间的中间状态不逐一播放。
5. **保留策略只清理可重建的过程事件**；受保护状态与审计记录不自动删除。
6. **性能验收范围**：v0.5 已完成真机全链路（真实 Tauri 进程 + WebView2 + 托盘 +
   SQLite）的 500/s×10min、200/s×60s、3 个真实安装 Agent 的 Hook 协议投递
   （实时会话未验证）、30 分钟分进程采样与故障注入；
   未覆盖磁盘写满、8 小时以上长跑、WebView2 逐帧帧率与真实鼠标交互延迟（见
   [PERFORMANCE_FINAL_ACCEPTANCE.md](PERFORMANCE_FINAL_ACCEPTANCE.md) §8、§11、§13）。
7. **压测数据与真实状态隔离（v0.5）**：压测脚本默认写入 `bench` 来源，
   服务端判定为 `benchmark` 归属——不进入真实 Agent 状态、行动中心「需介入」，
   也不触发系统通知；历史压测/自测数据的清理走「设置 → 数据审计」的
   预览→确认流程，**只删除可证明的测试数据，不确定的数据保留并标记人工复核**，
   清理前自动生成数据库快照。
8. **长跑与内存稳定性**：30 分钟采样证据对应的是当时的 release 二进制；
   第二轮复核在**当前源码**上重跑了行动中心与剪贴板性能采样
   （`actions_perf` p95 3.22 ms、`clipboard_perf` 2/2 通过），
   但**长跑内存稳定性在最终二进制上未重跑**，不得据此宣称「已证明无泄漏」。
   详见 [V05_FINAL_ACCEPTANCE.md](V05_FINAL_ACCEPTANCE.md) §5.4。

## 9. 智能剪贴板采集与渲染（v0.5）

代码：`src-tauri/src/clipboard/platform.rs`、`store.rs`、`src/store/useClipboardStore.ts`、
`src/components/clipboard/Media.tsx`。

### 9.1 有界采集链路

| 队列 | 容量 | 超限 |
| --- | --- | --- |
| 事件队列（monitor → capture） | 64 | 丢最旧，`dropped_events` 计数 |
| 内容队列（capture → worker） | 8 条 / 128 MB | 丢最旧，`dropped_contents` 计数 |

- `clipboard-monitor` 只入队，读取/图片编码在 `clipboard-capture`，SQLite 写入在
  `clipboard-worker`；消息线程不会被磁盘或编码阻塞。
- capture 线程合并队列，只处理最新序列号（`merged_events`），避免处理过期快照。
- 诊断计数与峰值延迟经 `clipboard_status.monitor` 暴露，只含计数不含内容。
- Windows 剪贴板不可回放：过载丢弃即永久丢失，明确计数而不是假装零丢失。

### 9.2 前端渲染

- 列表 DTO 只含预览（正文/HTML 已压实），分页 80；完整内容仅详情读取。
- 搜索 260 ms 防抖；`clipboard-changed` 300 ms 合并刷新；筛选变化清空多选。
- 缩略图 LRU 240 + 并发去重；大图只在详情打开时以 data URL 加载；
  图片缺失显示占位，不阻塞列表。
- 分组详情按需加载，不在抽屉打开时拉取全部正文。

### 9.3 实测（release，20 逻辑 CPU）

| 指标 | 结果 |
| --- | --- |
| 300 条历史（100 图）列表 80 条 p95 | 1.001 ms（预算 120 ms） |
| 同上列表 200 条 p95 | 1.185 ms |
| 200 张 1920×1080 连拍入库 | 2.730 s（总 2.799 s，预算 8 s） |
| 配额清理到 32 MB | 30.215 MB，删除 187 条 |
| PNG 编码 / 解码 | 95.4 / 13.2 ms（1920×1080） |
| 图片完整入库 | 14.1 ms |

原始记录：`docs/performance/results/CLIP-20261029-080326.json`。

### 9.4 边界

- 截图 PNG 编码 95–191 ms/张属于采集阶段，未计入入库预算；真实截图节奏受此限制。
- 默认 512 MB 配额约容纳 220 张 1080p 截图，长期使用会触发清理。
- **已补充测量（2026-10-30，release）**：30 分钟空闲资源采样、95 秒 Agent 并发、
  1000+ 条历史/大分组滚动、抽屉与清理；结果见
  [clipboard/11-final-release-acceptance.md](clipboard/11-final-release-acceptance.md) §五。
- **仍未测量**：WebView2 逐帧帧率、真实监听事件率与丢弃率、多显示器/DPI 组合；
  图文混合像素级复验在锁屏会话下为 ENVIRONMENT BLOCKED，见同一文档 §4.3。
