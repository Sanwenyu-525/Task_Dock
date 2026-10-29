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

### 2.3 批处理、失败隔离与生命周期

- 消费者在合并窗口内收拢最多 `batch_size` 个事件；同一批内重复 running
  按轮次槽位覆盖（被覆盖事件计入 `events_merged`）。
- 整批一个事务写入；若事务失败，按**原作业**逐个回退重试（每作业独立事务），
  隔离坏事件并保留单作业原子性（`commit_failures` / `fallback_jobs`）。
- `wait=true`：等待事务提交后返回（关键状态、批量 HTTP、需要确认的调用方）；
  `wait=false`：running 快速入队，不阻塞调用方。
- `start()` 幂等；`shutdown()` 先停收，再排空队列/合并缓冲后退出（有超时上限，
  不会无限挂起）。
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
- 每 750ms 扫描一轮；每轮最多读取 16 MiB；单文件最多 1000 条事件。
- 单文件大小上限 `agent_inbox_max_file_bytes`（默认 4 MiB）；
  每轮最多处理 `agent_inbox_max_files`（默认 200）个文件。
- 失败的稳定文件移动到 `failed/`，指数退避重试（最多 8 次），
  可通过「设置 → 性能诊断 → 重试失败投递」或 `agent_inbox_retry` 手动恢复。
- 处理完成后重命名归档，不删除用户文件。
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

- JSON 导出在只读连接上取 WAL 快照，事件最多导出最近 20000 条
  （完整状态/审计在 `agent_runs`/`agent_sessions` 中全量导出）。
- 导出/备份/导入均放入 `spawn_blocking`，不阻塞 UI 事件循环。
- 导入前先自动备份；备份格式与旧版本兼容（`EXPORT_VERSION = 4`）。

## 6. 托盘与通知聚合

代码：`src-tauri/src/agents/mod.rs`（`after_batch`）、`src-tauri/src/lib.rs`

- 每批提交只执行一次副作用：一次 `agent-changed` 广播、一次托盘刷新、
  最多 3 条系统弹窗（其余合并为一条摘要，数据库仍逐条记录）。
- 托盘提示：单条 SQL 聚合查询；文本相同不更新；非图标变化时最多 5s 一次。
- 进度类 running 不触发系统弹窗；`waiting/failed/completed` 保持准确通知。

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
6. **性能验收范围**：自动化压测覆盖真实管线 + 真实 SQLite；WebView2 渲染、
   系统托盘、真实 Agent 进程的端到端指标需真机运行应用采集，见验收报告
   「未完成项」。

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
- **未测量**：WebView 帧率、空闲 CPU/内存、30 分钟长跑、大分组滚动、
  真实监听事件率与丢弃率。需要可交互桌面与性能计数器，见
  [clipboard/10-remediation-acceptance.md](clipboard/10-remediation-acceptance.md)。
