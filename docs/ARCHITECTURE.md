# Task Dock 架构说明

## 一、总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  React 前端（src/）                                            │
│  TitleBar · MinimalView · CompactView · FullView              │
│  Zustand stores ── 类型化桥接层 lib/bridge.ts                   │
│     · 任务 Store    · Agent Store    · 设置 Store               │
│     · 贴边吸附 hook · 窗口持久化 hook                            │
└──────────────────────────┬───────────────────────────────────┘
                           │ invoke / emit（Tauri IPC）
┌──────────────────────────▼───────────────────────────────────┐
│  Rust 后端（src-tauri/src/）                                   │
│                                                               │
│  commands/        前端命令层（tasks / agents / settings / data / system /    │
│                   actions / workspace / context / clipboard）——输入校验     │
│        │                                                      │
│  db/               SQLite（rusqlite bundled）                  │
│    · 连接管理 · 版本迁移（PRAGMA user_version，v9）· 设置存储   │
│                                                               │
│  scheduler.rs      提醒调度引擎（1s 粒度，不依赖前端窗口）        │
│    · 到期触发 · 休眠唤醒补偿 · 重复任务推进 · 去重                │
│                                                               │
│  agents/           AI Agent 状态接入层（只观测，不导航）           │
│    · AgentHub     统一事件总线：校验→状态机→持久化→通知→广播     │
│    · Adapter      mock / file_drop / http_ingest（可扩展）      │
│    · codex.rs     Codex 生命周期钩子安装器                      │
│                                                               │
│  navigation/       统一导航系统（v0.4）                          │
│    · router       L1 启动→L2 唤醒→L3 打开→L4 会话恢复，         │
│                   按偏好降级并如实标注验证级别                    │
│    · app_discovery 软件发现（开始菜单/注册表/UWP/常用路径）      │
│    · window_manager 顶层窗口枚举 + 焦点控制（EnumWindows 等）    │
│    · target_resolver 目标持久化 + 任务关联 + 导航日志            │
│    · agent_navigation Agent 跳转能力（证据化）                  │
│                                                               │
│  clipboard/       智能剪贴板（v0.5，详见 docs/clipboard/）        │
│    · platform     Win32 监听/读写/快照/SendInput（唯一平台层）    │
│                   三线程 + 有界队列 + 锁内序列号校验               │
│    · engine       类型判定/哈希/敏感过滤/HTML 清洗/分组决策       │
│    · store        SQLite 持久化、资产文件、去重、清理             │
│    · paste        逐项状态机、分类型间隔、收尾、取消/继续、保护    │
│    · agent_bridge 本地 Agent 导入包（不上传、不自动发送）         │
│                                                               │
│  actions/         行动中心读模型（v0.5）                          │
│    · 只读 agent_events/runs/tasks/关联表，600 条扫描窗口          │
│    · 合并高频事件、分类/优先级、覆盖度；授权为关键词推断并标注     │
│                                                               │
│  workspace/       工作现场快照与恢复（v0.5）                     │
│    · 只存窗口标题/类名/exe、文件路径、URL；不存 HWND/PID          │
│    · 顺序恢复（默认 350ms 间隔，可取消），逐项验证级别             │
│                                                               │
│  quick_capture/   全局快速捕获（v0.7）                        │
│    · 常驻 capture 窗口、热键 toggle、定位与焦点恢复           │
│    · 单事务幂等提交、草稿、收集箱读写（SQLite v17）           │
│                                                               │
│  nlp.rs / recurrence.rs   中文自然语言解析 · 重复规则计算         │
│  lib.rs            窗口/托盘/热键/自启动装配                    │
└──────────────────────────────────────────────────────────────┘
```

设计原则：**UI、业务逻辑、存储、Agent Adapter 四层分离**。前端不直接访问数据库，
Agent 逻辑不写入 UI，Adapter 只产生事件、不感知存储。

## 二、模块职责

### 1. 数据层（db/）
- `Db`：单写连接 `Mutex<Connection>` + 3 个只读连接（WAL `query_only=ON`，round-robin）。
  读路径走 `with_read`，不占写锁；锁中毒时自动恢复。
- 迁移机制：`MIGRATIONS` 数组按 `PRAGMA user_version` 顺序应用，新增版本只追加不修改。
  - 2026-11-12 v47：修复历史库 `shelf_file_ops.op` 的单值 `CHECK (op IN ('move'))`。这类库由
    早期构建写入，`user_version` 已是 46，现行源码虽已改成 `('move','copy')`，但历史迁移不会
    重放，复制投递写日志必然触发 CHECK 失败。v47 在单事务内重建表、逐列复制未完成日志并恢复
    `idx_shelf_file_ops_created`；无法解释的 op/phase 会让迁移整体回滚（`user_version` 不变、
    不丢行）。新库同样重建一次，结果等价。诊断事件与错误码见
    [DIAGNOSTICS.md §21](DIAGNOSTICS.md#21-文件投递业务失败记录与旧库兼容2026-11-12)。
- 设置存储：`application_settings` 键值表 + `Settings` 强类型视图（`#[serde(default)]` 兜底）。
  - 2026-11-04：反序列化失败改为逐键定位（`salvage_invalid_settings`），仅类型损坏的字段
    各自回退默认，其他合法设置与数据库原始值不变；剪贴板安全配置继续 fail-closed；诊断只记录
    键名不记录值；读取不写库、无迁移。详见 `tmp/acceptance/navigation-blank-screen/reverify-report-20261104.md`。
- WAL 模式 + `busy_timeout`，外键约束开启；v0.5 补充事件/通知/轮次/会话查询索引。
- 读延迟诊断：调用数、平均耗时、≥100ms 慢查询计数（`read_stats()`）。
- 事件保留：仅清理 `running`/`idle`，先归档 JSONL 再分块删除；受保护状态永不自动删除。
  详见 [PERFORMANCE_ARCHITECTURE.md](PERFORMANCE_ARCHITECTURE.md#5-sqlite-读写与保留)。

### 2. 提醒调度（scheduler.rs）
- 独立 tokio 任务，**每秒按挂钟时间**比对 `task_reminders`，与前端窗口是否打开无关。
- 休眠/唤醒：不做定时器累加，每次 tick 重新查询「到期且未触发」，唤醒后自然补触发。
- 过期补偿：超过 `overdue_grace_hours`（默认 24h）的提醒只记历史不发通知，避免远古提醒轰炸。
- 去重：`UNIQUE(task_id, occurrence)` + `fired` 标志 + 通知历史唯一约束，三重保障。
- 重复推进：仅「截止」类提醒触发推进，删除旧未触发提醒并生成下一轮；**不改变任务完成状态**。
- **通知限频（v0.5）**：一个 tick 内到期的提醒**不再逐条弹系统通知**——本轮全部到期项先收集起来，
  一次性交给 `AgentHub::notify_reminder_popups`，与 Agent 事件共用**同一个** `NotifyGate`
  窗口预算（跨批次生效）；多条提醒合并为一条「任务提醒汇总」，
  等待/失败类通知优先占用额度；UI 广播也合并为一条 `reminder-fired`（携带 `task_ids`）。
  `notify_reminder` / `notify_muted` 开关对提醒与 Agent 通知分别生效。
- **通知可靠性修订（2026-11-02）**：
  - `NotifyGate` 改为**双额度限流**：等待/失败/断连等关键通知与完成/提醒等普通通知各持
    一份独立的 `burst_max` 窗口额度。普通通知（跨批次）刷满自己的额度后，关键通知仍能弹出，
    不再被挤进摘要；两类额度均有上界（每窗口最多 2×burst_max 条弹窗）。
  - **业务状态与弹窗权限分离**：`fire_reminder_core` 只要领取成功且任务存活即返回
    （`FiredNotify.popup=false` 表示只记历史不弹系统通知）。静音/关闭提醒时
    `reminder-fired` 广播照常发出（前端任务状态及时刷新）、重复任务照常推进、
    通知历史照常入库——静音只影响打扰行为。
  - 停靠胶囊的 Agent 异常提示音受三层开关约束：`agent_alert_sound`、`notify_muted`、
    `notify_agent` 任一关闭即不发声（胶囊声音不绕过通知总开关）。
    **更正（2026-11-04）**：v0.13 起提示音与 TTS 改由统一音频服务调度，开关为
    `audio_sound_enabled` / `tts_enabled`，只服从 `notify_muted`，**不再受**系统通知显示开关
    `notify_agent` / `notify_reminder` 影响；单事件开关与缓存策略见
    [docs/audio/audio-notifications.md](audio/audio-notifications.md)。旧
    `agent_alert_sound` 仅作为兼容键读取，`false` 映射为关闭 waiting/failed 提示音。
    **补充（2026-11-04 第二轮）**：`audio-event` 一律 `emit_to("main", ...)`，只由主窗口的
    唯一音频服务消费，停靠胶囊/通知窗/微件窗不订阅、不重复播；提醒过期策略与弹窗分离——
    超出 `overdue_grace_hours` 的提醒仍入库并推进重复任务，但不再发声（`FiredNotify.audio=false`），
    `notify_reminder=false` 只关弹窗、不关声音。
  - OS 通知发送失败从 `debug` 升为 `warn` 日志（含错误原文），结果可通过
    `notification_stats()`（attempted/succeeded/failed）复核；失败不影响通知历史提交，不重试。

### 智能日程提醒 2.0（2026-11-03）

- **快速提醒**：任务页快捷入口（5/10/15/30 分钟、1 小时、自定义时/分，校验 1..=1440 分钟），
  复用 `tasks` + `task_reminders` 持久化；只存绝对 `remind_at`，**不把剩余秒数写库**。
  2026-11-12：入口收进任务页工具行「更多操作」菜单（`QuickReminder` 支持受控 `open/onClose`），
  不再常驻占一行；创建与校验逻辑未变。
- **进行中的提醒**：任务页默认折叠为单行摘要（标题 + 条数 + 最近一条倒计时），展开后才渲染
  条目；切到专注/统计视图时组件**隐藏但不卸载**（`hidden` prop），保留已取回的 items 与展开
  状态，避免返回列表时列表高度二次变化（滚动位置因此能精确恢复）。
- **倒计时**：前端页面级共享时钟（`useSyncExternalStore` + 模块级订阅集合，首个订阅启动 1s
  interval、最后一个退订释放），只用绝对时间换算；>1h 显示「时:分」，≤1h 显示「分:秒」。
- **延后**：`snooze_reminder_inner` 在单事务内先读「未触发行」再条件更新，保留 `kind` 与
  `occurrence`；与调度器 `UPDATE ... WHERE fired=0` 领取串行化。已完成/已取消任务显式拒绝
  （不补建幽灵提醒）；无未触发提醒时补一条 `custom`，并返回 `inserted_id` 供撤销。
- **撤销**：`undo_snooze_inner` 以 `(id, snoozed_to, fired=0)` 版本约束恢复原时间；再次延后、
  编辑或触发后旧撤销自动失效；`inserted_id` 只在本次补建且仍未触发时删除。
- **通知联动**：任务提醒通知带 `ref_id`（任务 id），卡片提供「查看任务 / 稍后提醒（10 分钟）/
  完成任务」，全部走真实命令；系统通知无按钮时由应用内通知窗口降级。触发时若
  `remind_at != occurrence`，body 标注「（已延后）」。
- **重复规则**：新增 `by_setpos`（1..=5 第 N 个，-1 最后一个）。工作日 = `weekly` +
  `by_weekday=[1..5]`（自然周，不接节假日 API）；「每月最后一个工作日」= `monthly` +
  `[1..5]` + `by_setpos=-1`。monthly 以锚点月为相位按 `k*interval` 步进，修复「每两个月」退化为每月。
- **旧数据兼容**：`by_setpos` 可空，旧规则读回为 null 且行为不变，不静默改写旧设置。

### 工具面板后端复用与 list_tasks limit（2026-11-04）

- 停靠坞四个工具面板与收集箱 Lite 全部复用既有命令与 Store（`list_tasks`/
  `create_task`/`toggle_task`、`agent_snapshot`、`nav_list_targets`/`nav_navigate`、
  `quick_capture_list`/`quick_capture_state`、`clipboard_view`/`clipboard_status`），
  未新增第二套持久化、Agent 监控器或导航引擎。
- 例外（v35，收集箱「文件投递」）：新增 7 个 `shelf_drop_target_*` /
  `shelf_drop_to_directory` 命令与 `shelf_drop_targets` 表，用于「把拖入的文件直接
  落到用户配置的真实目录」。它复用 `shelf/fsops.rs` 的复制/移动/冲突/校验实现，不建
  第二套文件管理系统，也不向暂存架写记录；Webview 拖放事件由 `src/lib/fileDrop.ts`
  单一订阅并仲裁所有权，避免暂存架与胶囊互抢事件。详见 `docs/shelf/README.md` §12。
- `list_tasks` 的 `TaskFilter` 新增可选 `limit`（u32，1..=200，越界收敛；缺省行为
  完全不变），在 filter+sort 之后应用 SQL LIMIT；胶囊任务 Lite 传 `limit: 12`，
  完整页不传保持全量。
- `list_tasks` 的 `view` 新增 `due_today`（本地今天 0 点 ≤ due_at < 本地明天 0 点）
  与 `scheduled`（due_at IS NOT NULL），`sort` 新增 `completed`（completed_at DESC，
  NULL 殿后）。既有 view/sort 分支行为不变。胶囊任务 Lite 的分段因此各自按真实条件
  查询：全部 = status=all + sort=created、待办 = status=pending + sort=due、
  今日 = view=due_today + status=pending、日程 = view=scheduled + status=pending、
  已完成 = status=completed + sort=completed；后端先过滤/排序再 LIMIT 12，
  修掉「20 条逾期占满前 12 条、今天到期项被截断」的误判。
  （2026-11-04 补充：`sort` 再新增 `scheduled`（未逾期/未来在前、逾期在后，组内仍按
  due 升序）；胶囊「日程」改用该排序，成员定义不变——逾期仍属日程，只调整顺序，
  避免逾期积压把今天与未来计划挤出 LIMIT 12。）
- 胶囊分类栏小 Agent 入口由「收集箱」取代：`RAIL_CATEGORIES =
  ["tasks","inbox","clipboard","apps","roadmap"]`，顶部状态球仍打开 Agent 面板
  （`CapsuleCategory = RailCategory | "agents"`）；收集箱 Lite 复用
  `quick_capture_list("inbox",8,0)` + `quick_capture_state`，事件刷新共用
  App 层既有的单条 `quick-capture-created` 监听。
  （2026-11-07 新增 `roadmap`「规划中心」Lite 面板：复用一个 `usePlanningStore`，
  展示当前项目功能 / 步骤勾选，重型编辑仍进完整规划中心；为容纳第 5 个分类，
  轨道外框 400→446，容器垂直 404×446 / 水平 446×504，三端同步见
  `docs/ui-themes/13-capsule-redesign.md` §十八。）

### 3. Agent 接入层（agents/）
- 统一接入管线（`pipeline.rs`）：HTTP / 文件投递 / Hook CLI / 插件桥接 / Mock 的事件
  先进入有界队列。队列容量、批大小、合并窗口可配置；队列满时关键状态返回可重试错误
  （`Overloaded`），`running` 按轮次键合并或显式采样；单消费者一个事务一批写入 SQLite。
- `ingest_core` 是事务内状态机（可在内存库测试），事务内完成：
  1. 校验（来源已注册且启用、ID 字符集、长度上限、时间格式）；
  2. 会话 upsert（`agent_sessions`，按 source+external_id 唯一）；
  3. 轮次状态机（`agent_runs`：running/waiting → completed/failed/disconnected，记 ended_at）；
  4. 事件流水（`agent_events`，仅元数据）；
  5. 状态跃迁通知（waiting/completed/failed，按 run+state+序号去重）。
- **历史补录（2026-11-07）**：事件时间比受理时间早超过 5 分钟（`BACKFILL_MAX_AGE_MINUTES`）
  视为离线积压重放（Hook 文件兜底 / spool 重放的旧事件）：仍写事件流水与轮次历史，
  活跃状态（running/waiting）按失联语义落为 `disconnected`，但**不产生桌面通知/语音**，
  也不写通知收件箱，因此不会在启动后把几小时前的积压逐条弹成新通知、再被 stale 清理
  补一遍「连接中断」。5 分钟窗口内的延迟事件保持原有实时语义。
  积压停止 3 秒后（`BACKFILL_DIGEST_QUIET`）只弹**一张**「离开期间补录」摘要卡
  （复用 `digest` 摘要模板：会话数 / 完成 / 失败 / 等待 / 事件数，动作只到通知中心），
  并写一条通知历史；关闭 Agent 通知或静音时整批丢弃，不消耗弹窗额度。
  真实终态（completed/failed）之后的积压活跃事件仍落独立轮次，保留多轮历史。
- 提交后副作用每批只执行一次：一次前端广播、一次托盘刷新、聚合桌面通知
  （≤3 条弹窗 + 摘要），绝不放进事务。
- **桌面通知展示（2026-11-03）**：放行的弹窗优先送入独立常驻通知窗口
  （`notification_window.rs`，label `notification`：透明、无焦点 `WS_EX_NOACTIVATE`、
  光标所在显示器工作区右下角、前端六状态液态玻璃模板渲染、`fit` 回传收放高度、
  空栈自动隐藏）；窗口不存在或发送失败才回退 WinRT toast（两路互斥，不重复展示，
  历史入库与展示成败无关）。执行中（`agent_running`，running 首跳，occurrence 幂等）
  /等待/完成/失败/断连/提醒共用同一骨架模板；等待卡支持「稍后提醒」（内存暂存、
  调度器每秒到期重放）；用户点击「查看详情/通知中心」才激活主窗口并跳转标签页。
  多窗口能力清单见 `src-tauri/capabilities/`（通知窗口需 `core:event:default`）。
  **轮次协议与展开同步（2026-11-04）**：`notification-show` 载荷为
  `{ round, cards }`，每批通知分配唯一轮次；前端 `fit_notification_window`
  原样回传 `round + seq`，后端只接受当前轮次且序号单调递增的请求，迟到/乱序的
  上一轮尺寸请求直接丢弃；`hide_notification_window` 同样携带 `round`，若在途
  期间已有新批次则忽略隐藏，避免丢通知。fit 返回工作区/最大高度钳制后的
  `applied` 高度，前端据此判定 WebView 视口就绪并把超出内容交给栈内滚动。
  展开详情不会先于窗口长高而可见：详情先以零高度影子节点参与测量，窗口达到
  目标高度且视口同步后再进入正常布局并播放入场动画（400ms 超时安全退化）。
- 过期清理：超过 `stale_run_minutes`（默认 15min）无更新的活跃轮次 → `disconnected`，**不推断任务成败**。
- 事件保留（`retention.rs`）：启动 20s 后运行一次、此后每 6 小时；默认保留 30 天或
  最多 20 万行，仅 `running`/`idle` 可清理，归档失败则中止删除。
- Adapter trait：`spawn(Box<Self>, Arc<AgentHub>)`，新增 Agent 只需新增一个 Adapter。
- **v0.5 最终可靠性补强（2026-10-30）**：
  - **来源可信分类（origin）**：`EventOrigin{Real,Selftest,Benchmark,Mock,Manual}` 由**服务端**判定，
    只依据三个客户端无法伪造的输入——来源注册表的 `category`、摄取入口判定的 `Transport`、
    以及保留的自测会话前缀。事件载荷里**没有** `origin` 字段，客户端声明的 `transport` 会被忽略；
    `agent_events / agent_sessions / agent_runs / agent_instances / notification_history`
    都落 origin 列（迁移 v12），压测来源 `bench` 由服务端注册为隐藏来源。
    只有 `Real` 能改真实状态、进入行动中心、产生系统通知；非 real 轮次不参与失联判定。
  - 事件顺序：`submit` 在入口、任何等待之前分配全局 `ingest_seq`；消费者把主队列与合并缓冲
    稳定排序后统一落库；waiting/failed/completed 等关键状态形成合并屏障；数据库层用
    `last_ingest_seq` 与 `last_event_at` 阻止终态被迟到 running 回退。
  - 退出：`QUIESCING → DRAINING → STOPPED`；排空队列、合并缓冲与在途事务。超时把未落库事件
    原子写入 spool（`.tmp` + fsync + rename），重启幂等重放，并在报告中区分
    `spooled_events` 与 `unsaved_events`，不伪报持久化。
  - 文件投递：目录上限 5,000 文件 / 256MiB、单文件 8MiB、单轮读取 16MiB / 1,000 事件；
    关键状态预留 250 文件 / 16MiB；失败隔离到 `failed/`，不删除他人文件。
- **历史分页（2026-11-05，P1-02）**：实时快照 `snapshot_query` 仍只取最近 200 个会话 /
  300 个轮次，用于监控树与状态聚合；历史数据不再由快照承载。`agents/history.rs` 提供
  keyset 分页（会话 `last_seen_at DESC, id DESC`；轮次 `updated_at DESC, id DESC`）
  与独立 `COUNT(*)`：命令 `agent_history_sessions`（来源/实例/状态/关键词筛选、
  按会话 ID 定位）、`agent_history_runs`（会话内轮次，默认排除实时轮次）、
  `agent_history_session`（精确定位）。迁移 v36 只追加复合索引，不改表与数据；
  游标由后端签发，非法游标返回校验错误。前端历史分区/搜索结果/轮次展开均按需调用，
  与实时快照刷新分离；通知定位在快照未命中时改用 `agent_history_session` 按会话 ID
  定位，再展开真实来源/实例分区（未知实例不伪造）。
- **历史入口与实时口径（2026-11-05，Round 3）**：
  - `agent_history_groups({ sourceId })` 用一条分组 `COUNT` 返回来源下每个真实实例
    （含快照中已消失、历史仍存在的实例）与「未关联实例」的历史会话数，供监控树补出
    历史入口；只含实例标识与计数，不加载历史明细；`truncated` 表示超过分组上限
    （确定序返回：计数降序 + 实例键/实例行 ID，2026-11-06 Round 4；截断时界面提供
    「搜索历史记录」入口，关键词搜索与按 ID 定位不依赖分组，可访问被截掉分组的
    全部历史；展开的历史分区另有「有新的历史记录 · 更新」轻量提示，事件合并去抖后
    仅做 `limit=1` 头部探测，不轮询、不自动刷新）。
  - `agent_history_sessions` 默认 `include_live=false`，在 SQL 中按轮次语义排除实时
    会话（存在 `origin='real'` 且 `running`/`waiting`，或 1 小时内
    `failed`/`disconnected` 的轮次），与前端 `liveState` 同一口径；`agent_history_session`
    定位使用 `include_live=true`。`COUNT(*)` 与分页在同一读事务内执行，保证总数与页
    内容一致；隐藏来源（`hidden=1`）不进入历史查询/分组/关键词搜索。
  - `agent_history_sessions` / `agent_history_runs` / `agent_history_session` /
    `agent_history_groups` 均为 async 命令，数据库工作经 `spawn_blocking` 执行，
    不阻塞 Tauri 主线程；前端分组查询 150ms 去抖，历史查询不轮询。

- 性能设计与边界见 [PERFORMANCE_ARCHITECTURE.md](PERFORMANCE_ARCHITECTURE.md)。

### 4. Adapter 清单
| Adapter | 机制 | 状态 |
|---|---|---|
| MockAdapter | 内置模拟会话（UI 明确标注「模拟」） | 已实现，默认开启 |
| FileDropAdapter | 轮询 `%APPDATA%/com.taskdock.desktop/agent-inbox/*.json`（大小/数量/重试上限） | 已实现，常开 |
| HttpIngestAdapter | 127.0.0.1 HTTP + Bearer + 并发/超时/64KB 上限 + 429/503 重试提示 | 已实现，可配置 |
| Codex 钩子 | 原生 Hook CLI（`task-dock --agent-hook`）+ HTTP 优先、文件兜底 | 已实现，已用真实 Codex 会话验证（自动事件落库） |
| DSH 插件 | 宿主 **profile bundle**：`package.json` 声明 `dsh.bundle.patch` + 安装到 `<profile>/node_modules/` + 登记进 `dependencies` 与 `dsh.profile.bundles` | 已实现，已用真实 DSH 会话验证（`[task-dock-bridge] loaded`） |
| OpenCode 插件 | 宿主插件桥接：有界队列、2.5s 超时、running 合并、指数退避 | 已实现，已用真实 OpenCode 会话验证（自动事件落库） |
| Qoder / WorkBuddy | 官方接口未核实 → stub 来源，通过通用接入上报 | 未验证（见 AGENT_ADAPTERS.md） |

> **DSH 安装形态的坑（2026-10-30 验收发现并修复）**：`~/.dsh/plugins/` 只是**客户端**插件位，
> 把包放进去宿主不会加载。DSH 的宿主插件必须以 **profile bundle** 形式安装：
> `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，包放进
> `<DSH_HOME>/profiles/<profile>/node_modules/`，并在 profile 的 `package.json` 里登记
> `dependencies["task-dock-bridge"]` 与 `dsh.profile.bundles`。
> `src-tauri/src/agents/dsh.rs` 只改这两处，保留第三方 dependency/bundle 与其它顶层字段；
> `DSH_HOME` 可整体改写，使安装/卸载与验收可在隔离目录完成。

### 5. 统一导航系统（navigation/，v0.4）
与 Agent 观测层完全解耦：agents/ 只产生事件，navigation/ 只负责「把用户送到正确的窗口/页面/会话」。

- `router.rs`：`navigate(db, app, target_id, options)` 唯一入口。按目标类型分发 L1~L4 动作；
  每次执行从数据库重读目标配置并**重新校验**（安装路径可能已失效）；结果携带
  `verification_level`（window-confirmed / process-spawned / launch-requested / delegated /
  requested-unverified）与 `fallback_used`，不允许把「进程已启动」报告成「窗口已确认」。
- `window_manager.rs`：EnumWindows 枚举可见顶层窗口（排除工具窗口与 UWP cloaked），
  `QueryFullProcessImageNameW` 关联进程身份；**进程身份优先、标题仅作同款多窗口二次过滤**
  （`windows_for_identity`：exe 路径直接命中 + Toolhelp 进程树覆盖微信/QQ/酷狗等
  多进程宿主；跨应用同名标题不会进入候选集，HWND 失效/路径变化不会唤醒旧软件）。
  **启动器身份兜底（2026-11-11）**：配置指向版本化安装的 `... Launcher.exe` 时，启动器
  拉起主程序后自身退出，窗口与常驻进程只属于主程序（如 `Qoder CN Launcher.exe` →
  `Qoder CN.exe`）；身份匹配在 exe 路径与进程树之外增加「Launcher/ScLauncher 词尾 →
  主程序家族名」兜底（`QQScLauncher.exe` → `qq`），运行态、窗口定位与退出/结束动作共用
  同一套判定，家族名只做完整文件名干比较，不做子串匹配。
  **UWP 身份（2026-11-11）**：WindowsApps 安装目录名含版本与架构
  （`<Name>_<Version>_<Arch>__<PublisherId>`），族名子串永远不命中；窗口匹配改为解析标准
  包目录得到 `Name_PublisherId`，并对窗口进程查询 `GetApplicationUserModelId` 取得
  `Family!App` 权威身份补判。系统组件窗口（如设置）拿不到 AUMID 时保持不猜测。
  若后续发现其他启动器/更新器命名形态，按同样方式补词尾规则并补真机回归。
  焦点控制「IsWindow 核验 → SW_RESTORE → SetForegroundWindow →（被拒时把**调用线程与目标
  窗口线程**都 AttachThreadInput 到当前前台线程 + BringWindowToTop 后重试，不注入 ALT 按键）→
  前台句柄轮询核实」。桌面没有前台窗口（锁屏/无输入会话）时系统无法授予前台资格，此时如实返回
  `foreground-denied`，不把 API 调用成功当作已置前。HWND/PID 只作运行时身份，绝不落库。
  枚举带 1.2s TTL 缓存；进程树查询只在直接命中不到窗口时发生。
- `app_discovery.rs`：开始菜单 .lnk（优先 Windows Shell `IShellLinkW` 解析
  LinkTargetIDList，避免 LinkInfo 中过期路径导致漏检；失败回退 lnk crate，
  catch_unwind 隔离畸形文件）+ 卸载注册表（winreg，`DisplayIcon` 只接受 .exe，
  过滤卸载器/更新补丁）+ App Paths 注册表（HKCU/HKLM 32/64 位视图）+
  UWP（Get-StartApps 单次调用、8s 超时）+ 常用软件路径探测。
  **候选分层（2026-11-04）**：各来源统一走 `candidate_tier` —— `normal` 默认展示、
  `advanced`（更新器 / 崩溃报告 / 后台服务 / 维护工具等）默认折叠、可由用户
  「显示高级项」展开、`invalid`（卸载/安装例程）不进入扫描结果。判定只认独立文件名
  语义与完整短语，不做任意子串删除，避免误伤开发工具/终端/软件管理器；过滤只作用于
  **新扫描候选**，绝不修改、隐藏或删除用户已保存的快捷应用。
  扫描改为**用户主动触发**：进入应用中心/胶囊应用面板/添加子页都不自动扫描，
  会话内结果可直接展示并标注上次扫描时间，失败保留旧结果并可重扫；
  `AppScanResult.diagnostics` 如实标记开始菜单预算/深度截断、UWP 失败或条目上限，
  不把「没有匹配」说成「扫描完整」。
  只扫明确位置，绝不全盘搜索；浏览器渲染进程等子进程不构成独立应用
  （窗口层只枚举顶层窗口，天然排除）。自动发现覆盖不到的类型（绿色版/便携软件、
  无开始菜单入口的自定义程序）通过「手动添加」登记 EXE / 网址 / 文件夹。
  **渐进扫描（2026-11-05）**：`nav_scan_apps` 仍是用户主动触发的单一请求，但后端按来源
  （startmenu → known → app_paths → registry → uwp）通过 Tauri 事件
  `nav-scan-batch` 推送新增批次，缓存命中即时返回、不推送批次；
  最终 `invoke` 返回的 `AppScanResult` 仍是权威结果。
  事件负载 `{ scan_id, source, apps, discovered, sources_done, sources_total }`：
  `scan_id` 由前端请求生成、后端原样回传，前端按代际丢弃过期批次；每批只含新增且
  `app_key` 唯一的条目，累计数与最终结果一致。渐进阶段只登记本批图标身份
  （`register_discovered_batch` 不清空旧登记），扫描完成后 `register_discovered` 整体收敛；
  不引入轮询、无界队列或百分比估算，进度只显示「已发现 N 个 / 已扫描来源 x/y」。
  **扫描取消与细粒度分批（2026-11-06）**：扫描期间可用 `nav_cancel_scan(scan_id)` 置取消标志，
  后端在来源边界、快捷方式/注册表条目、PowerShell 轮询点检查并提前退出（PowerShell 子进程
  `kill` 后 `wait` 回收，不放任其跑到超时）；取消先于 `nav_scan_apps` 到达时按 `scan_id`
  记为待取消（上限 64 条），扫描注册后立即生效，不丢取消信号。取消结果 `cancelled = true`
  + `diagnostics.scan_cancelled`，`apps` 只含取消前已发现的部分结果，**不写入扫描缓存**
  （下一次扫描必须重新执行），图标身份只追加不整体收敛。前端状态机新增 `cancelled` 态
  （与 `complete` / `partial` / `failed` 区分），已有一份完整结果时回退到它并提示「显示上次结果」。
  扫描结果订阅者通过 `useNavigationStore.attachScanViewer()` 引用计数登记，**最后一个查看者
  离开才取消**，关闭单个面板不会误取消其他入口仍在使用的共享扫描；前端不得用隐藏 Loading
  代替取消，必须以后端返回的 `cancelled` 为准。
  批次改为「来源内每 60 条一片」：同来源中间批次 `sources_done` 不前进，只有最后一片
  （或空来源的完成片）才推进；**来源被取消时不发送完成片**（已发现的真实条目照常补发，
  因此取消不会丢数据，也不会虚增完成来源数），最终结果按「名称（忽略大小写）+ app_key」稳定排序。
  诊断分两类：影响完整性的 `startmenu_dir_unreadable` / `startmenu_truncated` /
  `startmenu_lnk_unreadable`（仅诊断）/ `registry_unreadable` / `app_paths_unreadable` /
  `uwp_scan_timeout` / `uwp_scan_failed` / `uwp_truncated` 参与 `partial` 判定；
  **可选来源正常不存在（NotFound）不计诊断**（如 HKCU 没有对应注册表项、精简系统没有公共
  开始菜单目录），权限拒绝、I/O 错误、枚举中途失败才计入，不能把「读不到」伪装成「没有应用」；
  仅影响进度展示的 `batch_event_failed` **不参与**，完整权威结果成功返回时扫描仍为 `complete`，
  界面只给低干扰说明「部分扫描进度未能实时更新，以最终结果为准」——不对结果完整性作绝对承诺，
  与「应用发现可能不完整」横幅可同时出现。
  **取消按钮状态（2026-11-06 第三轮）**：`idle`（取消扫描，可点击）→ `requesting`
  （正在请求取消…，禁用）→ `accepted`（正在取消…，保持禁用直到后端返回真实结果）；
  请求失败恢复 `idle` 允许重试，扫描自然结束静默退出，新一轮扫描复位；同一 `scan_id`
  已接受取消后 store 不再重复发送取消 IPC（多个面板共享同一次扫描），**首个 IPC 在途期间的
  并发调用复用同一个 Promise**（2026-11-07 第四轮），失败后释放占位并可重试。
  应用身份与去重：`app_key` 仍是 exe 绝对路径（小写）或 AUMID；同一 exe 的多个快捷方式
  只保留先到的一条（含其启动参数），不同 exe 即使同名也各自保留；同身份下先到 `advanced`
  随后发现 `normal` 时由普通项顶替（避免「卸载 Foo」遮蔽主入口）。不修改数据库唯一约束。
- `app_icons.rs`：真实应用图标提取（`SHGetFileInfoW`/`ExtractIconExW`/UWP
  `IShellItemImageFactory` → HICON → RGBA PNG data URL）。扫描与图标提取解耦，
  前端按需调用 `nav_app_icon`；HICON/HBITMAP/DC 全部释放，`spawn_blocking` +
  全局并发上限 2，内存缓存按「应用身份 + 文件更新时间/大小」失效。
  只接受已保存目标 id 或本次扫描登记过的 app_key，绝不把前端任意路径当文件目标。
  **对比度提示（2026-11-05）**：`nav_app_icon` 返回 `{ url, light }`；`light` 由后端在编码前
  用原始 RGBA 统计可见像素平均亮度（≥200）得到，零额外解码。前端只对 `light` 图标加
  主题语义色轻底衬与低透明度深色描边，彩色/深色图标保持原始形状与比例；PNG 保留
  RGBA 透明通道（有真实图标单测校验），白色 logo 不因提取被铺白底。
- 控制台工具（`tasklist`/`reg`/`where`/`powershell`/opencode 探测）统一经
  `winproc::hidden()` 启动并设置 `CREATE_NO_WINDOW`：Release 为 `windows` 子系统，
  不隐藏控制台会在每次 Agent/应用扫描时闪出终端窗口。
- `target_resolver.rs`：`navigation_targets`（用户确认过的可信启动配置）、
  `task_navigation_targets`（任务关联：display_order /
  is_default / launch_behavior，UNIQUE(task_id, target_id)）、`navigation_log`（执行流水）。
  与既有 `task_agent_links` 并存互补，旧表与历史数据不动。
  **快捷方式类型（v33 迁移，2026-11-04）**：`shortcut_kind` 区分 `app`（普通应用，
  按 app_key+target_type 去重）与 `window`（指定窗口，同程序可多条，按稳定窗口身份去重）；
  `bound_window_identity` 保存类名+标题+EXE 的稳定身份，**绝不保存 HWND**。旧行迁移为
  `app` + 空绑定，行为与升级前一致；任务窗口记忆解析优先任务记忆 → 绑定身份 → 目标记忆。
  **配置保护（2026-11-03）**：再次扫描/重复关联同一 app_key 只复用现有目标，
  `save_target` 默认不覆盖 launch_args / working_dir / window_title_hint / icon / category；
  只有 `overwrite_config=true`（用户确认）或 `update_target` 显式补丁（新增
  launch_args/working_dir）才能改配置。
- `agent_navigation.rs`：每个 Agent 的启动/唤醒/工作区/会话恢复能力全部**证据化**
  （exe-found / cli-help-probed / baseline-verified / unsupported-interface / not-installed）；
  无官方接口的 Agent 诚实降级为启动/唤醒并标注 fallback，不臆造 Deep Link。
  Codex/OpenCode 属交互式 CLI：必须在 `CREATE_NEW_CONSOLE` 的**新控制台窗口**中启动，
  并用新进程树的窗口核实；没有可交互窗口的后台子进程不计为成功。OpenCode 仅按
  `--help` 实测支持时使用 `opencode --session <id>`（官方文档核验），不再依赖未验证的
  `resume <id>`；CLI 帮助探测 5s 超时、并发消费 stdout/stderr、1h 缓存。

### 6. 前端（src/）
- 三种显示模式对应三套视图；完整模式六标签页（任务/Agent/行动/剪贴板/历史/设置）。
- **开发工作台（2026-11）**：完整模式新增「工作台」入口（`Tab: workbench`，默认可见、
  位于侧栏最前，**不占 Ctrl+数字**；`TAB_ORDER` 不变）。页面按任务优先布局四区域：
  当前开发任务 / Agent 运行 / 需要处理 / 快速继续（`components/workbench/DevWorkbenchPanel.tsx`）。
  数据全部复用既有读模型：任务↔Agent 会话（`task_agent_links`）、任务↔现场
  （`workspace_snapshots.task_id`）、任务↔场景（`task_reminder_links`）经既有
  `task_context` 聚合命令读取；Agent 状态复用 `agent_snapshot` + `liveSummary`
  （只统计真实上报事件，已安装/已接入状态仍由 Agent 页的接入管理负责，不在工作台推断）；
  待处理事项复用行动中心 intervention 分区 + 当前任务的未读重要提醒
  （notification 分区，`hasActionsFeedConsumer` 已纳入工作台，计数刷新与徽标同口径）。
  「当前开发任务」是**显式设置键** `workbench_current_task`
  （`application_settings`，空 = 未设置，随备份迁移；不自动推断、不按标题相似度绑定）。
  Agent 完成一轮不改变任务状态：完成只经 `toggle_task` 由用户确认（两段式确认 + 可撤销）。
  现场恢复复用 `workspace_restore` 单飞与逐项回执事件，成功/失败/已在恢复中就地反馈；
  「继续工作」的真实优先级为最新现场 → 最近关联 Agent 会话（外部会话 ID，失败如实回执）
  → 打开任务上下文；页头「快速记录」直接唤起既有快速捕获窗口（`quick_capture_show`）。
- UI 基元层（v0.6）：`components/ui/` 提供 Select / Combobox / DropdownMenu / Popover /
  DateTimePicker / Dialog / Checkbox / Switch / NumberInput / Tooltip，
  项目内**不再有原生 `<select>`**；浮层定位统一交给 `@floating-ui/react`（只做定位，
  不引入整套 UI 框架），Escape 由 `lib/overlayStack.ts` 全局栈统一分发，
  优先级 确认框 > 子弹层 > 菜单 > 抽屉 > 主窗口，一次按键只关一层。
  规范与 API 见 [ui-themes/08-interaction-spec.md](ui-themes/08-interaction-spec.md)、
  [ui-themes/09-component-api.md](ui-themes/09-component-api.md)。
- 刷新调度（v0.5）：`useAgentsStore` 单飞 + 节流（critical 100ms / normal 400ms）+
  脏标记追赶；窗口隐藏只置脏，恢复可见补一次；100 条事件不再触发 100 次全量快照。
- 应用内反馈（2026-11-02 修订）：
  - Toast 改为**有界队列**（`useUiStore.toasts`，容量 3）：连续消息排队展示不再相互覆盖，
    相同消息 2s 内去重，错误/警告优先保留并停留更久（8s）；四态 info/success/warning/error；
    关闭走带 `aria-label` 的按钮（点击正文不关闭），hover/聚焦暂停自动消失计时器；
    Toast 只是瞬时操作反馈，业务通知历史以 `notification_history` 为准。
  - 设置面板危险操作（清理测试/压测数据、恢复备份）由原生 `confirm` 统一改为
    `components/ui/Dialog.tsx` 的 `ConfirmDialog`（危险标识、执行中禁用重复提交、
    Escape/焦点管理走既有 overlay 栈）；原生文件选择器保留。
- 统一错误模型（2026-11-04）：
  - 后端 `src-tauri/src/error.rs` 的 `AppError` 序列化为结构化 payload：
    `{ code, category, severity, retryable, message, detail? }`。`code` 是稳定机器码
    （见下表），`message` 为可直接展示的安全文案，`detail` 仅放可核验技术信息
    （sqlite 错误码、OS 错误类型），**不含 SQL、堆栈、剪贴板正文与账户名**。
  - 前端 `src/lib/errors.ts` 的 `invokeCommand` 是所有窗口的 IPC 统一入口：
    把结构化 payload / 旧字符串 / `Error` 归一化为 `AppError`（`toString()` 返回可读
    文案，兼容既有 `String(e)`）；`legacy` 标记表示分类来自旧文案兜底，仅用于展示。
  - 用户反馈唯一入口 `src/lib/errorReport.ts`：`reportError` 负责「操作名 + 原因 +
    下一步建议 + 可选重试」，复用现有 Toast 队列（按 `code + message` 2s 去重，
    悬停显示错误码与详情）；`recordBackgroundError` 只归一化不弹窗，后台失败写入
    对应模块的内联错误状态。后台轮询失败禁止逐次 Toast。
  - 模块约定：读取失败 ≠ 空数据（任务/应用/Agent/工作流/设置页均显示真实错误 +
    重试，并保留旧数据标记「可能不是最新」）；写入成功但刷新失败必须分两阶段说明；
    正常取消、用户暂停、明确不支持的可选效果不算错误。
  - 刷新结果契约（2026-11-06 第二轮）：`RefreshOutcome` 的 `ok / stale / cancelled / error`
    分别对应「本次完成 / 被更新请求取代或已有在途任务 / 被主动取消 / 失败」。
    多请求聚合（设置页「重新扫描」并行刷新目标与扫描）只有**两项都 `ok`** 才能提示整体成功；
    `stale` / `cancelled` 只陈述事实（哪一项由其他入口处理或被取消），不得折算成成功；
    重试只重跑失败的那一项，不重复发起已成功的请求。
  - 渲染异常由 `src/components/ErrorBoundary.tsx` 兜底（不白屏、用户点击才重试）；
    未处理 Promise rejection 由 `src/lib/globalErrors.ts` 兜底，同一根因 30s 内只提示一次。
  - 内容区独立边界（2026-11-05 第四轮）：完整面板在 `.tab-content` 内再包一层
    `ErrorBoundary variant="compact" resetKey={tab}`。单个页面渲染异常只替换内容区，
    标题栏与左侧导航保持可用，切页（resetKey 变化）或点重试即恢复，不需要重载窗口；
    根边界仍是最后一道防线，不按页面复制第二套错误边界。设置写入类失败（如语音开关
    保存失败）走结构化 Toast（含原因并说明原值保持不变），不进入渲染异常通道。
  - 设置写入并发契约（2026-11-05 第五轮，取代第四轮「全局写入序号」）：
    1) **串行 + 合并**：`useSettingsStore` 内任意时刻最多一个 `update_settings` 在途，
       期间到达的补丁合并为一笔待发（同键后值覆盖、不同键累加）。不同字段不会互相
       吞掉；同字段按用户操作顺序**落库**（最后操作优先），而不只是界面看起来正确；
       突发变更最多 1 在途 + 1 待发，不会形成无界队列；我方响应因此不可能乱序。
    2) **字段级裁决**：快照缺失/`undefined` 的键保留现值；请求发起后被外部事件
       （`apply_mode` / 托盘 / 右键菜单）改写过的字段保留外部值——**即使本次补丁包含
       该字段**（外部事件更晚）。
    3) **有界终态核对**：发生裁决丢弃时，在队列尾部重读数据库，仅对被压制过的字段
       重新下发界面值（`mode` 走 `apply_mode`，同时修正窗口尺寸），保证 UI / 数据库 /
       原生窗口一致；每次冲突最多一次，不循环。
    4) **失败隔离**：失败只影响该批次，已成功批次不回滚；随后按数据库真值对齐一次
       （覆盖极端部分写入），错误照常回传给调用方提示。
  - 用户提示与内部诊断分层（2026-11-04 第二轮）：界面只使用后端白名单 `message`/`detail`
    经前端再脱敏后的文本；SQL 行、堆栈、凭证（`token`/`bearer`/`password`）、
    Windows/macOS/Linux 用户目录在前后端各脱敏一次，`detail` 仅进 Toast 的 `data-tip`
    与 `console`，不进入提示正文。未知 `code`/未知对象稳定回退通用文案，绝不展示未审查原文。
  - 独立悬浮窗口（快速捕获/通知/右键菜单）使用 `ErrorBoundary variant="compact"` 与
    `installGlobalErrorHandlers({ toast:false })`：按窗口尺寸内联轻量兜底，不安装主窗口
    完整错误页，异常只进诊断日志，不把提示发到用户看不见的窗口，也不改变业务数据。

  错误码与分类对照（`category` 用于展示策略，不用于文案匹配）：

  | code | category | severity | retryable | 典型场景 |
  |---|---|---|---|---|
  | VALIDATION_ERROR | validation | warning | true | 输入/参数校验失败 |
  | NOT_FOUND | not_found / io | warning | false | 任务、文件、窗口不存在 |
  | PERMISSION_DENIED | permission | error | false | 文件/目录权限不足 |
  | PERMISSION_REQUIRED | permission | warning | true | 需用户先在系统设置开启的隐私/权限开关（如在线语音识别） |
  | IO_ERROR | io | error | true | 磁盘、文件占用、写入失败 |
  | DATABASE_ERROR | database | error | false | SQLite 读写失败 |
  | DATABASE_BUSY | database | warning | true | 数据库被占用/锁等待 |
  | IPC_ERROR | ipc | error | true | 窗口/Tauri 调用失败 |
  | SERVICE_UNAVAILABLE / SERVICE_OVERLOADED | service | error/warning | true | 依赖服务未启动 / 队列满 |
  | AGENT_ERROR | agent | error | true | Agent 接入、扫描、适配器异常 |
  | CONFLICT | conflict | warning | false | 已有运行中的同类长任务 |
  | TIMEOUT | timeout | warning | true | 操作超时 |
  | UNSUPPORTED | unsupported | warning | false | 系统不支持的可选效果 |
  | DATA_INTEGRITY_ERROR | integrity | critical | false | 数据损坏/格式异常 |
  | UNKNOWN_ERROR | unknown | error | false | 未归类（含旧格式兜底） |
- 历史面板：默认加载 100 条，`list_agent_events(before=...)` keyset 分页加载更早事件，
  刷新增量合并；新通知/事件 500ms 防抖刷新。
- 规划中心（v0.7）：roadmap Tab 升级为双数据源入口
  （`components/roadmap/PlanningCenterPanel.tsx`，Tab 身份/快捷键不变）：
  - 「我的项目」：用户自建多项目（SQLite `planning_*` 五表，见数据模型），
    `store/usePlanningStore.ts` 统一管理（每类列表带请求代际防乱序，变更命令返回
    后端权威实体就地替换，无轮询）；视图层 `ProjectsView`（项目切换/概览统计/
    里程碑分组卡片）+ `PlanningFeatureCard`（步骤清单/状态修改/进度历史）+
    `PlanningEditors`（项目/功能/里程碑表单，页面内编辑态：在主内容区切换、不铺遮罩，
    与工作流/任务编辑同一交互语言；删除等破坏性操作仍走 `ConfirmDialog`）。
  - 进度口径：功能进度 = 已完成步骤/总步骤（无步骤显示「未拆分步骤」，不产出
    百分比）；项目进度 = 已完成功能/总功能（无功能显示空态，不显示 0%）；功能状态
    与进度相互独立，不由完成率推断。功能状态变化与步骤勾选在后端同一事务写入
    `planning_activity`（status_change / step_done / note 三类显式区分）。
  - 「内置路线图」：Task Dock 自身 31 项功能规划（`lib/featureCatalog.ts` 静态目录）
    经 `FeatureRoadmapPanel` 原样只读展示，不入库、不被用户项目编辑覆盖。
- 任务编辑交互（2026-11-04，模态清理第二批）：原 `TaskEditor.tsx`（`modal-mask` + Dialog）
  删除，改为 `src/components/tasks/TaskEditorView.tsx` 的**页面内编辑态**；`TasksPanel.tsx`
  在主内容区做列表 ↔ 编辑切换，与工作流/规划中心共用同一交互语言：
  - 不新开窗口、不铺全局遮罩、无固定底栏；操作区随内容流式排布。2026-11-09 起列表页改为
    页头固定 + 列表独立滚动（`.page-fill` / `.page-scroll`），编辑态改由 `.task-editor-page`
    自身滚动（不再依赖 `.tab-content` 整页滚动）。
  - 返回列表恢复列表滚动位置（列表可见时记录 `.task-list` 的 `scrollTop`，退出编辑后
    `requestAnimationFrame` 回写）；筛选状态本就在 `useTasksStore.filter`，切换不丢失。
  - 有未保存修改时返回先出页内确认条（继续编辑 / 放弃修改）；保存失败保留表单内容并就地
    显示错误；同步防重入保证连点保存只提交一次；组件卸载后丢弃迟到响应，不再回调。
  - 打开入口统一经 `useUiStore.openEditor`（会切到任务页），微件等页面因此有编辑态宿主。
  - 任务数据结构、SQLite、提醒调度与 Rust 命令不变；关联目标选择器 `AppPicker` 保持既有
    模态行为。未保存草稿不跨主 Tab 持久化（切换 Tab 卸载面板，与工作流页面内编辑一致）。
- 贴边吸附（v0.6 重写为 Smart Dock Capsule）：判定在 `lib/edgeSnap.ts`（纯函数），
  副作用在 `hooks/useEdgeSnap.ts`。五相状态机 free/candidate/docked-visible/docked-hidden/
  docked-revealed；磁吸滞回（进入 28px / 退出 42px）；隐藏时留 32 CSS px 状态胶囊
  （物理宽 = round(32×DPI)，与隐藏坐标严格一致），展示待办数与 Agent 运行状态。
  防抖全部为时间积分：唤出驻留 180ms、展开保护期 500ms、连续离开确认 450ms、
  程序移动后 150ms 坐标静默期；隐藏相位的几何使用 hide 时记录的停靠显示器
  （修复 currentMonitor 在多屏下按重叠最大取错屏的问题）；松手确认 = 移动静默 +
  （光标出窗 ∨ DOM 指针事件恢复）。状态与窗口矩形持久化（程序移动/屏外矩形不写入）。
- 吸附胶囊真实显示修复（v0.6 · 2026-10-31 第二轮）：区域裁剪改为**提交协议**——
  隐藏 = 移动 → waitForPosition 有界轮询（50ms×≤600ms，等坐标落定）→ 裁剪
  （await + 返回值检查）→ 才提交 docked-hidden 与持久化，任一步失败回滚到原
  可见位；展开 = 移动 → 落定 → 清裁剪（一次重试）→ 提交 revealed，清除失败回滚
  隐藏位。区域操作带序号，过期响应作废并按最新期望重同步。后端
  `apply_window_capsule` 在 SetWindowRgn 后用 GetWindowRgn 回读验证包围盒
  （±1px），返回值代表真实生效；自愈判定加 500ms 宽限窗（`capsule_heal_allowed`），
  防止"移动未落定时单次位置读取撤销胶囊"（真机长条残留根因）。胶囊区域矩形为
  显式 `CapsuleRegionRect{x,y,width,height,radius}`：left/right 纵向 32×120、
  top/bottom 横向 120×32，窗口尺寸不足时钳制；真实 HWND 测试覆盖四边回读。
- 吸附系统性修复（v0.6 · 2026-10-31）：①**胶囊区域裁剪**——隐藏时经
  `apply_window_capsule` 把主窗口 Win32 区域收窄为停靠边上的短胶囊
  （区域外不绘制、不接收鼠标；hwnd 绑定不影响右键菜单弹窗；窗口大部分可见时后端自愈清除），
  消除整窗切片在胶囊外露出内容/残留命中区的结构性问题；②**多屏接缝安全降级**——
  停靠边外侧紧贴邻屏（内部接缝）时允许停靠但禁止自动隐藏（`findAdjacentMonitorAcrossEdge`），
  邻屏断连 3s 重检恢复，隐藏中接缝形成由健康检查（每 20 tick）立即安全展开；
  ③**唤回**——托盘/快捷键经 `show_and_focus` 检测窗口"可见但大部分在屏外"时下发
  `snap-recall`，引擎安全展开；④持久化写串行（promise 链）+ 恢复兜底（restore 失效按
  停靠显示器记忆齐平位展开）；⑤IPC 收敛——free 相位 0 次轮询 IPC，停靠/隐藏相位用
  停靠显示器记忆替代每 tick currentMonitor；⑥唤出命中以**胶囊区段**为准（居中 120 CSS px
  ±24px），不再把整条屏幕边缘当唤出区。隐藏实现策略取舍见
  `tmp/acceptance/edge-snap-system-remediation/architecture-decision.md`。
- 停靠态极简 + 拖拽解除（v0.6 · 2026-10-31）：删除标题栏磁铁按钮与拖拽时的
  「松开吸附」提示胶囊，吸附反馈只保留一条**整窗描边细线**——`inset:0` +
  `border-radius: var(--radius-window)` 使描边沿窗口圆角弯曲，四边各自向窗口内侧
  18px 渐隐（candidate 相位 opacity 0.95 = hot，停靠相位 0.5；`styles.css`
  `.snap-dock-line`）。解除吸附不再有按钮路径：停靠可见/唤出相位的 tick 检测
  窗口偏离 `clampDockedPosition` 齐平位 > `SNAP_UNDOCK_DRAG_PX`(24 CSS px) 且
  `snapMoveGuard` 判定非程序移动时，走 `undockCore` 清停靠/持久化并记录当前位置
  （不做 48px 内推）；≤24px 仍由 `realignDocked` 拉回齐平（`moveWindow` 的
  force 参数跳过目标缓存，修复实测偏离被缓存短路、拉回不生效的问题）。
  隐藏态解除仍走「胶囊唤出 → 拖离」，`undock` store 字段随按钮一并删除。
- 解除几何恢复脱离引擎互斥区（2026-11-06，capsule-redock 根因修复）：`undockCore` 的
  busy 互斥只保护「区域 off + 相位提交」；尺寸恢复（等拖拽循环退出 ≥220ms + 稳定回读
  400–600ms）改为带世代令牌（`restoreGen`）的后台事务，期间 `restoreInFlight` 延迟
  candidate 确认/超时，避免恢复与停靠两路几何写入交错。此前恢复占住 busy 时所有
  onMoved 评估被丢弃、`lastSeenRect` 冻结在解除触发位，用户立即反向拖动的新手势起点
  被污染，`hasDockIntentAlongTrail` 净位移不足 → 永远进不了 candidate（「拖离后无法
  重新吸附」根因）。配套：①停靠→free 提交时重置手势起点/轨迹/按压起点（解除后的
  首次再吸附与普通自由窗口同一口径）；②free 相位把 `snapMoveGuard` 命中的程序性移动
  排除出手势轨迹与意图评估（恢复事务搬运窗口不得凭空进候选）；③解除后用户按下过
  窗口（`undockUserInteracted`）则跳过「锚定未应用」的兜底重定位；④`cursorPosition`
  失败（受限会话 GetCursorPos 被拒）不再中止 candidate/docked-visible 拍内后续判定——
  确认退化为「静默 + DOM 指针哨兵」口径。真机（125% DPI 隔离实例）：拖离 → 150ms 内
  重抓反向拖回 → 重新吸附为胶囊，区域/尺寸/持久化正确。
  （原 2026-10-31 记录中「48px 内推」「realignDocked」为旧实现描述，以本条为准。）
- 停靠形态切换的快速尺寸恢复（2026-11-07）：胶囊「完整面板」按钮/右键菜单的
  本次会话切换（`applyDockForm` → `dockFull(fastSizeRestore=true)`）跳过
  `restoreModeSize` 的 600ms 稳定二次回读。该窗口防的是解除/再吸附场景的原生
  拖拽循环把窗口恢复成拖拽起始尺寸、松手再回弹（v0.7 真机复现）；按钮切换无
  拖拽循环参与、事务全程持有引擎互斥且提交后相位为 docked-full（无尺寸收敛），
  回弹源不存在，等待纯属固定延迟（真机感知为点击后数秒才变完整面板）。首读
  仍是容器尺寸时仍走 300/600/900ms 重试梯子；`dockTo`（重启恢复/拖拽后再吸附）、
  `undockCore`、`restoreUserSize` 维持原加固行为不变。集成测试：A8（切换在
  <600ms 虚拟时间内完成）、A9（首次 applyMode 尺寸被吞仍经重试成功）。
- 候选边判定的越出轴遮蔽修复（2026-11-08，capsule-redock 复核）：`detectCandidateEdge`
  （前端）与 `magnetic.rs::nearest_edge`（原生拖拽磁吸，同口径）的「四边距离 argmin +
  总出口守卫」存在结构缺陷——恢复矩形底部越出工作区时（停靠位靠下 + 用户自由矩形
  较高，拖离恢复后常态），越出轴的负距离（< −EXIT）在 argmin 中恒占优、随后被总守卫
  整体判 null，用户真正逼近的边（左/右）被遮蔽、永远进不了候选。修复：明显越出
  （前端 `d < -SNAP_CANDIDATE_EXIT_DIST`、原生 `d < -ATTRACT_RANGE_CSS`）的轴在选边时
  直接跳过，滞回带内（−EXIT..0）的轻微越出语义不变；`nearestDockEdge`（标题栏
  「吸附为…」按钮入口）维持「明显越出 → null 不猜边」契约。同轮修复：candidate
  相位的换边更新（拖过角落）补 `!programmaticMove` 守卫——解除恢复/工作区钳制的
  程序性搬运不得翻转用户已选定的候选边。回归：edgeSnap.test.ts「越出轴不遮蔽可达边」、
  集成 D11/D12、`magnetic::nearest_edge_ignores_far_poked_axis`。
- 完整面板双击标题栏收缩为胶囊（2026-11-07）：`TitleBar` 拦截拖拽面上的
  `mousedown detail≥2`（仅 `docked-full` 相位）→ `formSwitch("capsule")` 并
  `stopPropagation`，替代 Tauri drag-region 脚本对双击的默认
  `internal_toggle_maximize`——该默认是程序化最大化（`SW_MAXIMIZE`），不受停靠期
  清除的 `WS_MAXIMIZEBOX` 限制，停靠窗口被最大化后引擎按法向偏离判定拖离、
  自动解除停靠（双击 = 被顶出停靠的混乱体验）。自由窗口双击最大化不受影响；
  单击拖拽路径不变；菜单/窗口按钮等交互子元素按 drag-region bare 语义不误触。
  元素级 React 监听先于 Tauri 挂在 document 的脚本监听，`stopPropagation` 在
  React 根容器处终止原生冒泡即可挡住后者。
- 主窗圆角与滚动条（2026-10-31）：液态玻璃预设 `--radius-window: 20px` 与
  `PRESET_WINDOW_RADIUS` / Win32 区域半径（逻辑像素，按 DPI 换算）对齐，消除
  dream/glass 18px 时 CSS 填充到不了区域边缘留下的圆角缝隙带；主窗滚动容器改用
  透明轨道 + 6px thumb（`styles.css` `.dock-window ::-webkit-scrollbar`，与右键
  菜单同款），窄窗导航轨间距在 ≤384px 断点收紧，消除 340px 高时只滚 2px 的幽灵
  滚动条。
- glass 圆角暗楔修复（2026-10-31 晚）：Win11 + 区域裁剪时原生 Mica/Acrylic 与
  legacy `ACCENT_ENABLE_BLURBEHIND` 都会按整窗矩形绘制，`SetWindowRgn` 裁不到，
  圆角外留下暗/亮楔（真机：blur 角部 [1,11,1]、acrylic [84,84,84]。默认后端改为
  **css**——不挂任何原生材质，玻璃由 CSS 半透明 `--window-fill` 承担；圆角外
  直接透出桌面（真机复测角点与背景逐像素一致，暗楔消失）。liquid 的 tint 本就
  76–86% 不透明，停用原生模糊的视觉损失有限。显式 `TASK_DOCK_GLASS_BACKEND=
  mica|acrylic|blur|css|none` 仍保留供矩阵对照。
- 主题：CSS 变量 + `data-theme`，跟随系统时监听 `prefers-color-scheme`。
- 导航（v0.4）：`lib/navigation.ts` 类型化桥接 + `useNavigationStore`（扫描缓存/任务关联映射，
  运行状态按需刷新不轮询）；任务卡最多直列 3 个目标图标，其余折叠进快捷菜单（键盘可操作）；
  `AppPicker` 应用选择器（搜索/分类/当前窗口/手动登记）；`WorkspaceLauncher` 工作区
  顺序批量启动（可取消、部分成功明确）；设置页新增「应用与快捷方式」管理区。
  v0.5（2026-11-04）起 `AppPicker` 支持两种独立模式：**任务关联模式**（保存目标 + 关联任务）
  与**独立配置模式**（`standalone`，只保存目标、不要求任务 ID、不写任务关联，保存后刷新
  `useNavigationStore` 目标清单），两模式共用同一 `navSaveTarget` 后端接口；
  工具面板「应用」页的添加/管理入口经 `useUiStore` 的一次性 `appConfig` 意图进入完整窗口
  设置页（胶囊的 Win32 区域裁剪内不挂载大型弹层），意图消费后清除。
  系统级窗口控制全部在 Rust 后端，React 不触碰 Win32。
- 导航自定义（2026-11-04）：新增 `lib/navigationRegistry.ts` 作为入口元数据唯一来源
  （稳定 ID、名称、图标、默认顺序/可见性、支持的界面、覆盖的 Tab、快捷键、系统锁定标记），
  `RAIL_ENTRIES` / 胶囊轨道均由 registry 派生，页面组件保持 `React.lazy` + `DeferredView`
  首次激活挂载，不因导航动态渲染退回静态导入。用户偏好收敛为 SQLite 设置
  `navigation_layout`（`lib/navVisibility.ts` 归一化：未知/重复/缺失 ID 丢弃计数、新入口按默认
  合并、损坏回退默认、版本不符按 ID 迁移而不清空偏好）；完整面板与停靠胶囊各自独立的
  可见性与排序。`lib/navigationLayout.ts` 串行化写入并做一次旧
  `localStorage["taskdock.nav.visibility.v1"]` 迁移：新配置有效前不删旧键，失败保留旧键重试，
  胶囊不继承左侧旧隐藏项。「设置」为 `locked` 系统入口：不可隐藏/排序，归一化时补回底部。
  完整面板隐藏入口收进底部「更多」：仅在存在隐藏项时出现，当前页被隐藏时**不插回侧栏**，
  选中态由「更多」按钮（`aria-current="page"`）承担，菜单项以单选勾选显示当前页；菜单复用
  `Popover`/`DropdownMenu` 的视口翻转与外部关闭，不自算坐标；底部「自定义导航」经
  `settingsSections.requestSettingsSectionReveal` 展开并滚动到设置页「导航自定义」分区。
  （2026-11-04 补充）胶囊入口扩展原则：Lite 面板型（高频、轻量、复用现有后端）才进胶囊；
  完整配置页 / 复杂编辑 / 大量历史等重型界面走快捷跳转进完整工作区。轨道固定几何决定
  当前只支持「状态球 + 4 个分类」，新增第 5 类需同步改 `styles.css`、`capsuleLayout.ts` 与
  `window_shape.rs`；两类入口判定、改动清单与可见性边界见
  [docs/ui-themes/13-capsule-redesign.md](ui-themes/13-capsule-redesign.md)。
- 导航显隐与资源生命周期（2026-11-05）：三层语义严格分离——
  ①**导航可见性**（`navigation_layout`，只影响入口渲染）；②**页面活跃状态**
  （`hooks/useMainUiVisible.ts`：`useMainUiVisible()` = 未停靠胶囊期；`useFullViewVisible()`
  = mode=full 且未停靠；均从既有 store 派生，无第二状态源、无定时器）；③**后台业务启用**
  （各模块既有设置开关）。隐藏导航入口 ≠ 停用后台能力：任务提醒调度、Agent 关键事件、
  剪贴板采集、工作流执行、桌面微件不受任何门控影响。
  DeferredView 保活的隐藏页面按「消费者」门控可选刷新：行动中心聚合以
  `useActionsStore.hasActionsFeedConsumer()` 判定（入口可见 / tab=actions 且主界面可见），
  启动加载与事件 countsOnly 刷新经 `shouldRefreshActions()` 门控，恢复消费者时由
  FullView 徽标 effect 与 `ActionCenterPanel` 补刷新；剪贴板页/抽屉的加载、实时订阅
  （`setFullLive`）、监听状态读取与弹层注册以 `uiActive = active && 主界面可见` 门控
  （组件保持挂载，恢复可见自动补一次加载；停靠期 liveFullRefs 归零 → 无胶囊消费者时
  全局监听整体拆除——只停 UI 刷新，不停采集）；历史页事件合并刷新与恢复可见补刷、
  任务倒计时（`ActiveReminders`）的共享时钟订阅同样按 `useFullViewVisible()` 挂起，
  隐藏期最后一个时钟消费者退出即释放定时器。核心事件驱动刷新（Agent 快照调度、
  任务/导航合并刷新、采集计数）不参与门控。测试：`useMainUiVisible.test.tsx`、
  `useActionsStore.test.ts`（门控矩阵）、`ActiveReminders.test.tsx`（停靠停钟）、
  `ClipboardWorkspace.suspend.test.tsx`（页面挂起/恢复）。
  （2026-11-06 补充）专注工作台 `FocusWorkspace` 也纳入同一门控：`useSharedClock(visible)`
  在页面不可见时退订共享时钟，`acquireFocusEvents()` 只在可见期持有；恢复可见时重新
  拉取快照并补订阅。隐藏页面仍保持挂载，编辑草稿与子视图状态不丢。
- **功能生命周期契约（v0.15，2026-11-06）**：在「导航显隐 / 页面活跃 / 后台启用」三层
  之上，补齐「模块能否独立暂停、暂停是否真的释放资源」的统一语义。
  ①**单一事实源**：用户意图只写既有 SQLite 设置键（`clipboard_enabled` / `clipboard_paused` /
  `shelf_auto_cleanup_enabled` / `reminders_paused` / `actions_enabled` / `actions_paused` /
  `tts_enabled`），不新增独立暂停 API；实际运行状态由 `src-tauri/src/lifecycle.rs` 的只读探针
  批量返回（`lifecycle_status`）。前端 `store/useLifecycleStore.ts` 只缓存快照与串行操作队列：
  模块按钮的暂停意图**永远从设置派生**，不读取可能过期的快照 `intent`；设置 Store 中相关键
  变化时推进 revision 并标记快照 `stale`，响应返回时复核 revision，旧结果不覆盖新设置。
  写库成功但状态查询失败时返回 `unconfirmed`，UI 只提示「配置已更新、运行状态未确认」。
  ②**状态机**：`running / pausing / stopping / paused / stopped / idle / error / unsupported`。
  `paused`/`stopped` 只在线程确实退出后成立；已接受暂停/停用但监听、维护或异步回收线程仍在
  收尾时分别返回 `pausing`/`stopping`，禁止用设置值冒充资源已释放。停用（`stopped`）优先于
  暂停；`error` 表示意图为运行但探针发现线程未运行（不降级成 running）。
  ③**模块分类**：resident（clipboard / shelf_cleanup / reminders / voice，可独立暂停）、
  task（actions / workflows / focus / backup / workspace，暂停属于具体任务或前端聚合）、
  shared（agents / diagnostics / hotkeys / tasks，停止会丢其他业务数据，不提供模块级暂停）、
  ondemand（ocr / apps / history / planning / widgets / collection，无常驻后台，不造无效按钮）。
  ④**剪贴板线程解耦**：`ClipboardRuntime::stop_capture()` 只回收监听线程 + 维护线程；
  `stop()` = 同步 `stop_capture_sync()` + `paste.cancel_all()`，仅用于长期停用/退出。暂停
  不清空粘贴队列、不打断用户已发起的逐项粘贴。暂停的采集回收是**异步**的：先同步
  `begin_stop()`（关闭事件队列、摘除全局事件槽、通知消息循环退出，不 join），再交给
  `clipboard-stop` 线程 `finish_stop()` join；`capture_draining()` 计数与
  `maintenance_running()` 计数共同保证「paused 只在线程真正退出后成立」。恢复重建监听
  （`start_monitor` 幂等；`begin_stop` 已同步摘槽，因此暂停后立刻恢复不会因旧实例占用
  槽位而启动失败；世代检查防止启动期间被暂停留下孤儿线程），维护等待用「停止位 + 世代」
  双条件唤醒，旧线程不会睡满 30 秒。采集实例被丢弃（例如回收线程创建失败）时
  `ClipboardMonitor::Drop` 同步兜底收尾，不留下已摘槽却仍在监听的线程。暂停期间新复制
  不补录：恢复后监听只在下一次系统剪贴板事件上读取，Windows 不为新监听回放暂停期事件；
  已经越过队列边界、正在 `record_capture` 的一次入库允许完成（数据完整性），但暂停后
  队列中的未处理内容随队列关闭丢弃，不会在恢复后回放。
  ⑤**暂存架自动清理**：`ShelfState::apply_auto_cleanup(enabled)` 真正创建/停止
  `shelf-auto-cleanup` 线程（Condvar 可立即唤醒），关闭时不再每小时醒来空转；
  停止不 join（清理可能正在写文件/SQL），期间状态为 `pausing`。手动清理、已暂存文件
  与文件操作闸不受影响。
  ⑥**提醒暂停**：共享 1 秒调度循环**不停止**（Agent 过期清理、通知摘要、稍后提醒、
  专注/久坐继续）；只在 `tick` 的提醒分支前检查 `reminders_paused`：暂停期间到期提醒
  保持 `fired=0`、不写通知历史、不推进重复任务；恢复后按既有过期补偿补触发
  （>60s 标注「补触发」；超过 `overdue_grace_hours` 仍入库历史但不弹窗/出声）。
  ⑦**UI**：模块页标题栏/工具区提供 Pause/Play 图标按钮（`components/lifecycle/ModuleRunControl.tsx`，
  loading / disabled / aria-pressed / `data-tip` 说明暂停范围）；资源管理新增
  「功能运行」分区（`components/resource/RuntimeModulesSection.tsx`），按 resident/task/
  shared/ondemand 分组展示实际状态、后台活动标记、暂停范围与真实错误。隐藏导航入口后
  模块仍出现在该分区并可独立暂停；恢复运行不改变导航显隐，反之亦然。分区活跃 = 当前分区
  可见 **且** 完整面板可见（`useFullViewVisible`）；分区首次访问后保持挂载，但隐藏期不因设置
  变化发查询，重新显示时补一次。长期停用模块（`clipboard_enabled=false` /
  `actions_enabled=false`）的按钮禁用并明确提示「先在设置中启用」，不存在只改暂停字段的
  假恢复。
  ⑧**兼容**：`reminders_paused` / `actions_paused` 为带默认值的新键（旧库/旧备份缺键 =
  false），设置备份仍走 `application_settings` 全量规则；未改动迁移历史与命令签名；
  `clipboard_paused` 的持久化语义不变，但重启时不再「先启动再拒绝采集」——
  暂停状态启动直接不创建监听与维护线程。
  ⑨**行动中心暂停与停用分离（2026-11-07 复查）**：`actions_enabled` 保持长期停用语义
  （后端 `actions::feed` 返回空 Feed、徽标归零）；新增 `actions_paused` 只停前端自动聚合
  刷新与徽标更新。暂停时 feed 查询仍可用，页面手动刷新/历史/通知照常读取，Agent 原始事件
  继续入库；`shouldRefreshActions()` 同时检查停用与暂停，`useActionsStore.load()` 不门控
  （手动查看）。目标模块控制键登记为 `actions_paused`，不再复用 `actions_enabled`。
  ⑩**真实探针（2026-11-07 复查）**：生命周期不再对已有运行时事实的模块固定报 `idle`——
  OCR 用 `OcrService::is_busy()`（执行中为 `running` + `ocr-task`）；工作流读引擎全局活动槽
  （`active_run()`，运行/暂停/取消），专注读后端权威快照（无会话 idle，会话暂停为 paused）；
  应用扫描读取消注册表活跃数；微件统计真实存在的 `widget-<kind>` WebView 窗口；Agent 同时
  检查 Hub 与接入管线消费者线程（`IngestPipeline::is_running()`），仅 Hub 存在不足以报
  running。探针只读内存/既有快照，不新增进程扫描或轮询；无法可靠读取时返回 `error` 而不是
  `idle`。状态与 `background` 字段保持一致（有活动标记才可能 running）。
- 导航排序与固定入口（2026-11-05）：排序与可见性彻底分离，排序只改顺序、不改成员。
  入口分两类：**普通入口**（可隐藏、可排序）与**固定入口**——`locked`（设置，完整面板）
  与胶囊面 `kind="agent-status"`（Agent 状态球）。判定唯一入口为
  `navigationRegistry.isEntrySortable(entry, surface)` / `lockedEntryIds(surface)`，UI 不自行猜测：
  固定入口不渲染上下移动按钮（此前 Agent 状态球有按钮但排序无效），设置入口显示「固定位置」
  徽标。不变量：①`moveEntryInList(ids, id, delta, isFixed)` 对固定项本身或固定目标一律拒绝
  交换，普通项不能借交换「跨过」固定项；②`normalizeNavigationLayout` 把 `locked` 项收敛到
  可见数组末尾（旧配置自愈）；③隐藏项不参与排序，恢复可见时按默认顺序插回；④排序沿用
  `navigationLayout` 的串行写入链，连续点击不产生乱序写入；⑤写入失败保留 UI 原顺序并报错，
  不做乐观假成功。完整面板侧栏三区域：顶部新建、中部可排序入口（`.rail-items`，独立滚动）、
  底部固定区（`.rail-foot`：存在隐藏项时的「更多」+ 设置），固定区不随中部列表滚动且有分隔线。
  （2026-11-06 更正）固定区不再只有设置：新增常驻一级入口「资源管理」（`resource`，
  `locked: true`，默认顺序 10.8，位于设置 11 之前）。两个锁定入口按注册中心默认顺序
  收敛到可见数组末尾（资源管理 → 设置），仍不可隐藏/排序；底部固定区因此渲染两个入口，
  中部 `.rail-items` 依旧是唯一滚动区域，340px 最小高度下溢出入口靠滚动可达。
  同时修正隐藏当前入口后的落点：`safeTabForHiddenEntry` 只在**可排序**入口中选择，
  避免把系统页（资源管理）当作默认首页；只剩锁定入口时仍回退设置。
  （2026-11-07 更正）「资源管理」取消 `locked`，回归**默认可见的普通入口**（默认顺序 10.8
  不变）：可隐藏/排序，底部固定区恢复为「更多 + 设置」；隐藏后仍可从「更多」与设置页
  「数据与资源 → 资源管理」入口卡片进入，不存在导航自锁风险。`safeTabForHiddenEntry`
  因此把它视为正常落点（但仍只在可排序入口中选择，设置保持兜底）。
  停靠胶囊仍可隐藏 Agent 状态球，隐藏只影响入口渲染，不影响 Agent 事件监控与徽标计数。
  原生几何契约：停靠形态完全由 `SetWindowRgn` 决定，`docked-full` 对应
  `set_capsule(hwnd, None)`（整窗圆角区域，`GetWindowRgn` 包围盒等于窗口矩形，**不是**
  「无区域」）；四向吸附后窗口保持用户模式尺寸并沿停靠边齐平，沿边位置由持久化
  `centerRatio` 决定；点击命中与区域一致（`WindowFromPoint` 面板内命中主窗、面板外不命中）。
  四向真机证据见 `tmp/acceptance/navigation-layout-fix/native-summary.json`。
  （2026-11-06 更正）排序算法从「相邻交换、固定项不可跨越」改为**可排序子序列内相邻交换**：
  `moveEntryInList` 的 `isFixed` 谓词只决定谁不可移动，固定入口不再是普通入口之间的障碍——
  普通入口可以跨过固定项排序（固定项原地不动）。此前「固定项不可跨越」会让夹在普通分类之间的
  Agent 状态球挡住一侧全部排序操作，与 UI 禁用逻辑叠加成「点了没反应」。配套变化：
  ①`moveNavigationEntry` 的固定谓词与 UI 共用 `isEntrySortable`（此前只认 `locked`，胶囊
  Agent 状态球可被底层 API 交换）；②`normalizeNavigationLayout` 把胶囊 `agent-status` 收敛到
  可见数组**端头**（与 locked 收敛到末尾并列），旧配置（Agent 夹中间/末尾）读取即自愈，
  普通分类相对顺序保留，隐藏的 Agent 不被重新显示；③设置页上/下按钮的可用性按
  「可排序子序列内是否还有前/后邻居」判定，与底层语义一致。复验证据：
  `tmp/acceptance/navigation-layout-fix/repro-final-summary.json`、`native2-summary.json`
  （2026-11-06，EXE sha256 `DA61A842…`）。
- 导航路由恢复、写入串行与启动加载门（2026-11-06，导航/页面生命周期专项）：
  ①**隐藏当前入口后的安全恢复只有一个实现点**——`FullView` 以「导航配置变更」驱动：
  记录当前页所属入口的 `{id, hidden}`，仅在**可见 → 隐藏**这一次迁移上调用一次
  `safeTabForHiddenEntry` + `setTab`。因此「从更多/快捷键/通知/深链主动打开本来就隐藏的页面」
  没有该迁移，不会被强制重定向（隐藏 ≠ 禁止访问）；也不存在「持续检查 tab 是否可见并纠正」
  的 Effect（那会让隐藏功能无法通过「更多」进入）。旧实现只写在设置页的局部操作路径里，
  且用写入前的旧快照计算安全页，连续操作时可能选到刚被隐藏的页面，已删除。
  安全页优先级：仍可见的任务页 → 左侧第一个可见入口覆盖的页面（合并入口按
  `collectionSub` 落在 inbox/shelf，`notes` 子页在切页成功后恢复）→ 设置页。
  ②**草稿门禁不因恢复而绕过**：`setTab` 的 `switched/pending/blocked` 语义原样生效——
  未保存草稿只记录 `pendingTab`（用户确认才切、取消则留在原页继续编辑），保存中直接
  `blocked` 并就地提示；恢复不会强制切页、不会丢弃编辑内容，入口已隐藏的页面仍可保存/退出。
  ③**写入串行 + 进行中状态**：`navigation_layout` 的读-改-写在 `navigationLayout` 串行链内完成
  （每次都读最新已落库配置，不基于渲染快照），设置页在写库期间把**全部**开关/排序/恢复按钮
  一致禁用、列表 `aria-busy`、显示「正在保存…」——「可点击」与「会被执行」严格等价，
  不再出现旧实现「其它行仍可点但处理函数直接 return」的静默丢弃；在途点击不排队
  （不产生无界请求），失败就地显示真实错误且保留上次配置。
  ④**消费者门控补全**：`useActionsStore.hasActionsFeedConsumer()` 改用
  `hooks/useMainUiVisible.isFullViewVisible()`（mode=full 且未停靠）——极简/紧凑模式下侧栏与
  行动页都不渲染，不再被误判成有消费者；`scheduleActionsRefresh` 的去抖回调**执行前重新验证**
  消费者（窗口内切走即放弃本次聚合，恢复时由 FullView/ActionCenterPanel 的恢复路径补刷新）。
  历史页的两个事件监听是页面独占资源：`useFullViewVisible()` 为 false 时不注册、恢复可见时
  重新注册并补一次 merge 刷新（异步 `listen()` 迟到兑现由 `subscriptions` 作用域立即反订阅），
  隐藏期间的筛选变化也不再发三条历史查询。
  ⑤**启动加载门**：`mode` 与 `navigation_layout` 都来自设置，设置未就绪时外壳只渲染中性占位
  （`ShellBootState`，`.shell-boot`），不按默认值渲染完整面板与默认导航（消除启动闪烁）；
  占位**不计入一次视图激活**（`DeferredView.active` 仍要求 `settingsReady`），真实模式是
  极简/紧凑时不会把 `FullView` 白挂载进隐藏槽。读取失败由 `useSettingsStore.loadError`
  驱动占位显示原因 + 重试（重试成功自动进入正常界面），不会变成永久空白。
  测试：`NavigationVisibility.integration.test.tsx`（安全恢复/草稿 pending/cancel/blocked/合并子页/
  主动打开隐藏页不重定向）、`NavigationVisibilitySection.test.tsx`（在途全禁用 + 后续操作生效 +
  失败恢复）、`useActionsStore.test.ts`（mode 门控 + 调度前复验）、`HistoryPanel.test.tsx`
  （隐藏不注册/恢复重注册/20 次往返净监听不增长）、`App.shell.test.tsx`（加载门/失败重试/
  紧凑模式不误挂载）、`navVisibility.test.ts`（安全页子页语义）。
- 设置页信息架构（2026-11-06，一级分类 + 查找定位）：设置页从「十几个分组纵向堆叠」
  改为**六个一级分类**（通用与外观 / 功能与应用 / 通知与语音 / 数据与资源 / 接入与诊断 /
  帮助与教程），同一时刻只渲染当前分类的分组。
  ①**注册表唯一事实源**：`lib/settingsCategories.ts` 的 `SETTINGS_SECTION_META` 声明每个稳定
  分组的标题 Key、所属分类与搜索别名，`SETTINGS_CATEGORIES` 声明分类标题/说明/图标/顺序；
  设置页与「查找设置」都从这里派生，**不再维护第二份手写索引**——历史缺陷（新增
  `diagnostics-logs` 时漏加跳转索引）由 `settingsCategories.test.ts` 的完整性断言拦住：
  分组漏归类、重复归属、分类为空、标题 Key 在中英词典缺失、`diagnostics-logs` 不可定位
  都会直接失败。分类身份一律用稳定英文 ID，不按中文标题匹配。
  ②**分类导航**：`SettingsCategoryNav` 是紧凑 tablist（`role=tablist/tab/tabpanel`、
  `aria-selected` + `aria-labelledby/controls`、漫游 tabindex、方向键/Home/End 移动并激活）；
  默认 3 列 × 2 行，窗口收窄按 `@media` 降为 2 列 / 1 列（标签换行不截断），
  选中态只用边框 + `--accent-soft` + 文字对比度表达，不加阴影。
  ③**状态与持久化分离**：分组展开偏好仍存 `taskdock.settings.sections.v1`（结构未变，
  旧偏好继续有效）；分类选中态单独存 `taskdock.settings.category.v1`（版本化、未知/损坏
  回退首个分类），互不影响，也不进业务配置/备份/IPC。
  ④**跨模块定位**：`requestSettingsSectionReveal(id)` 语义扩展为「切分类 → 展开分组 → 两帧后
  滚动定位」，覆盖设置页尚未挂载（sessionStorage 意图）与已挂载（window 事件）两条路径；
  「更多 → 自定义导航」、工具面板 → 应用管理、剪贴板页「剪贴板设置」均复用该入口，
  不再只切到设置页而不定位。分类切换回调保持引用稳定，避免跨模块监听被反复注册。
  ⑤**按需加载**：设置页挂载时不再并发读取备份列表与剪贴板统计/状态；`loadPanelData` 拆成
  `backups` / `clipboard` 两个切片，只在对应分组首次展开时读取（成功后标记，失败解除标记
  以便重试），分类切换本身不产生查询。
  ⑥**状态保护**：切换分类会先提交「输入后需失焦才提交」的剪贴板排除名单草稿（失败仍走原有
  Toast），避免卸载输入框丢草稿；危险操作确认框与添加应用子页面是面板级状态，切分类不丢。
  测试：`lib/settingsCategories.test.ts`（完整性/持久化/匹配）、`SettingsPanel.test.tsx`
  （分类切换只渲染目标内容、跨分类展开保持、查找定位、按需加载与重试、键盘与 aria 关联、
  草稿提交）。
- 智能剪贴板（v0.6 起进入侧边栏）：完整模式为**第 4 个导航入口**（任务 / Agent /
  行动 / 剪贴板 / 历史 / 设置），**完整模式标题栏不再保留剪贴板入口按钮**；
  任务关联场景仍以
  次级抽屉呈现（`openClipboard({ linkTask })`），紧凑/最小模式因没有侧栏，
  标题栏保留临时抽屉入口（`TitleBar.test.tsx` 锁定该行为）。
  业务内容抽到 `ClipboardWorkspace`，页面与抽屉共用同一份加载 / 订阅 / 操作逻辑，
  `useClipboardStore` 用全局引用计数保证**整个应用只有一条 `clipboard-changed` 监听**；
  列表 DTO 只含预览，完整正文/大图按需读取；所有粘贴与 Agent 导出均为显式操作。
  模块与边界见 [clipboard/02-architecture.md](clipboard/02-architecture.md)，
  导航迁移说明见 [ui-themes/10-clipboard-navigation.md](ui-themes/10-clipboard-navigation.md)。
- 行动中心（v0.5）：`useActionsStore` 去抖单飞刷新（1200ms），事件批量到达只唤醒一次；
  `ActionCenterPanel` 提供 kind/来源/任务/优先级筛选、覆盖度披露、ack/unack、
  跳转 Agent 会话或任务上下文。
- 任务上下文抽屉（v0.5）：`TaskContextDrawer` 复用次级抽屉视觉，按需加载
  `task_context`；现场恢复进度订阅 `workspace-restore-progress`，与剪贴板抽屉互斥。
- 应用中心（v0.10）：左侧「应用」入口位于 Agent 与行动之间（`RAIL_ORDER` 视觉顺序；
  **不占 Ctrl+数字**，快捷键仍严格按 `TAB_ORDER`）。`AppsPanel` 与胶囊应用面板、设置
  应用管理三端共用 `useNavigationStore` + `navigation_targets`：添加复用
  `AppPicker standalone`、编辑复用共享 `TargetEditForm`、启动/聚焦复用 `navNavigate`。
  运行态来自 `nav_target_running_states`（复用 `app_discovery::running_states` 的真实
  窗口枚举 + 进程快照），只在打开页面 / 启动成功后按需查询一次，**不轮询**；
  `has_window/process_only` 才算运行中，`unavailable` 表示配置失效，不作推断；保存的 exe
  路径随版本升级失效但同类进程仍在运行时，按实际运行态显示，只有确实未运行才报
  `unavailable`（2026-11-11）。
- 应用搜索与图标（v0.11）：`lib/appSearch.ts` 统一搜索（中文连续子串、英文大小写不敏感、
  身份绑定别名、完全匹配 → 前缀 → 包含 → 别名排序）；选择器搜索「已发现集合」，
  应用中心/胶囊搜索「已配置集合」。`components/ui/AppIcon.tsx` 按需异步取真实 Windows 图标
  （扫描先出文字、图标补充，失败统一回退字母，不阻塞选择）。`AppPicker` 新增
  `variant="page"`：工具面板/应用管理/设置页的「添加应用」改为内容区子页面（返回、搜索、
  分类横向滚动、多选批量添加、手动添加、当前窗口选择均在同一页面内切换），任务关联场景仍用
  模态选择器。
  **搜索未命中受控补扫（2026-11-06）**：添加页搜索先从当前索引（`searchApps`）取结果；
  关键词无匹配时防抖 500ms、冷却 60s 后强制触发一次扫描（`loadApps(true)` 绕过 5 分钟 TTL，
  用于发现扫描后新安装的应用）。扫描在途不叠加请求，分类筛选不是「全部」时不补扫
  （分类是本地过滤，补扫不改变命中）；首次扫描失败交给显式重试。补扫完成后仍无匹配时
  提示「已重新扫描，仍未找到」，与「正在继续扫描，暂未发现」明确区分；代际由 `scan_id`
  隔离，旧批次不污染新请求。图标缓存采用「容量上限 + 淘汰最旧一批」（前端 512/64，
  后端 512/64），不再整体清空，避免在视图标整批重新走 IPC。
- 应用添加入口与快捷方式类型（2026-11-04，v33）：胶囊「+」与应用中心「添加应用」写入一次性
  `useUiStore.appsAddRequest` 后展开完整窗口并切到「应用」页，由已挂载的 `AppsPanel` 消费一次
  并打开 `AppPicker` 添加子页面；保存/批量完成后回到应用中心并立即刷新，**不再绕经设置页**，
  设置页内发起的添加仍停留在设置上下文。同一程序可同时存在一条普通应用快捷方式（程序身份、
  启动或聚焦）与多条指定窗口快捷方式（稳定窗口身份、优先聚焦该窗口）；窗口选择页改为
  「单选窗口 → 选快捷方式类型 → 确认添加」，添加动作本身不切换用户当前窗口，激活时窗口不存在
  按既有策略降级并如实反馈，不宣称恢复原窗口。
- 应用内快捷键：Ctrl+1…9 与 Ctrl+0 切换标签（顺序取自 `useUiStore` 的 `TAB_ORDER`，
  与视觉顺序 `RAIL_ORDER` 分离；「应用」不分配快捷键，既有 Ctrl+语义不漂移）、
  Ctrl+K 快速添加、Ctrl+Shift+C 剪贴板
  （完整模式切到剪贴板页，紧凑/最小模式开关临时抽屉）；
  输入框内不拦截，窗口聚焦时生效。实现见 `src/hooks/useGlobalShortcuts.ts`。
- 导航显示配置与低频页懒加载（2026-11-04，轻量化专项）：左侧导航支持按入口显示/隐藏
  （`src/lib/navVisibility.ts` + `useNavVisibilityStore` + 设置页「导航显示」区块，
  持久化在 localStorage `taskdock.nav.visibility.v1`，不进备份与 SQLite）。隐藏只影响
  侧栏渲染：页面仍按 tab 渲染，Ctrl+数字语义不变，「设置」始终可见，隐藏项可从导航底部
  「更多」菜单重新打开；隐藏当前入口时自动切到安全页；配置损坏/版本不兼容回退为全部可见。
  完整模式低频页（应用/微件/工作流/历史/规划中心/设置）改为 `React.lazy` 按需加载，
  任务/Agent/行动/剪贴板/收集仍同步加载；新增面板若为低频页应加入 `FullView.tsx` 的
  lazy 列表，并在测试里使用 `findBy*` 等待异步渲染。
- 视觉系统（v0.6）：三个正交维度——视觉预设 `visual_preset`
  （dream-gradient / liquid-glass）、明暗 `theme`、材质 `material`；
  统一在 `useSettingsStore` 一条管道里落到 `html[data-preset|data-theme|data-material]`，
  老组件只认 `--surface-*` 等语义变量，因此两套皮肤共用一套组件代码。
  界面材质跟随**实际生效值**（`materialInfo.resolved`），原生 Mica/Acrylic 失败时自动回退 solid；
  每次重算都重新探测原生材质，系统「减少透明效果」关闭后能真正恢复。
  完整模式改为**左侧垂直导航**（62px，窄窗收敛为 46px 图标轨）。
  **2026-11-01 晚更正（主窗不再用圆角区域）**：真机像素证明 DWM 的圆角裁剪（约 8 DIP）
  与 `SetWindowRgn` 的圆角区域（CSS 物理半径 − 2px）在同一窗口矩形上相交，二者之间露出
  一条透明月牙；区域硬边还会切进 WebView 的抗锯齿弧线，形成「外圈平滑 + 内圈阶梯」。
  现在**完整主窗**改为：`SetWindowRgn` 只设整窗矩形 + `DWMWCP_DONOTROUND`，可见轮廓完全
  由 WebView2 CSS 的 18/20px 抗锯齿弧定义（渐变覆盖到边缘，无月牙、无 GDI 硬边）。
  透明角由 `WM_NCHITTEST` 子类化按 CSS 圆角判定（`point_in_rounded_rect`）；WebView2 的
  真实鼠标命中走子窗口，实际行为与原生 Win11 圆角窗口一致（见验收报告「遗留问题」）。
  区域仍按 hwnd/尺寸/DPI/缓存并用 `GetWindowRgn` 回读校验；胶囊与右键菜单弹窗继续使用
  圆角区域（各自独立的几何）。
  **2026-11-01 深夜二轮更正（恢复原生圆角区域）**：整窗矩形方案在非激活态被真机推翻——
  灰底 200 下窗口矩形四角为纯白 255，CSS 圆角外出现矩形三角（WebView2 失焦回填默认底色，
  矩形区域不裁它）。主窗改为**逐行像素支撑区域** `main_region_rgn()`（`css_support_left`
  按行取 CSS 圆角触及的首个像素，合并为矩形并集）+ `DWMWCP_DONOTROUND`：区域恰好覆盖
  CSS 抗锯齿支撑形状、不覆盖透明像素，定义真实原生圆角，CSS 只负责抗锯齿边缘；删除
  `WM_NCHITTEST` 子类化（圆角区域即命中区）。DWM 原生圆角固定 8 DIP，无法满足 18/20px
  设计半径，故不使用。证据见 `tmp/acceptance/window-corner-unification/report.md` 二轮章节。
  **2026-11-03 更正（四角缩放 + 角热区光标）**：真机反馈四条边可缩放、四角不可拖。根因是
  圆角像素支撑区域把 tauri-runtime-wry `TAURI_DRAG_RESIZE_BORDERS` 的角方块（物理 4×4px）
  裁在区域外，Windows 按区域路由命中，角点消息根本不派发（tao 的四角 HT 分支本身完整）。
  修复：前端 `WindowResizeGrips` 在**区域内的最靠角像素**上接住缩放意图并调用
  `startResizeDragging(NorthWest/NorthEast/SouthWest/SouthEast)`（12 CSS px，跨端契约见下），
  停靠胶囊期不渲染；不给窗口加命中区域、不改几何/吸附/裁剪。
  **2026-11-08 更正（停靠期系统白边）**：深色系统主题下 Windows 11 会沿带边框窗口绘制
  1px 近白系统边框；胶囊翼片尖端半透明，边框会从尖端透出成「锯齿白边」。
  `DWMWA_BORDER_COLOR = NONE` 在本机 23H2 上是 no-op（改色后真机像素不变），因此在
  `window_shape::apply` 的停靠形态清除 `WS_CAPTION | WS_THICKFRAME`，解除停靠后精确还原；
  窗口矩形与客户区尺寸不变，完整窗的原生缩放保留。
  同一处的后续真机反馈（松手后光标回退成普通箭头）根因在**光标层**：系统模态缩放循环退出后
  Windows 重设默认光标，指针静止时不再派发 `WM_SETCURSOR`，WebView2 的 CSS `cursor` 没有机会重新
  生效。修复：`window_cursor.rs` 在 `WM_EXITSIZEMOVE` 后延后一拍（`PostMessageW`）按
  `GetDpiForWindow` 折算的 12 CSS px 热区补 `SetCursor(IDC_SIZENWSE/IDC_SIZENESW)`，并在
  `WM_SETCURSOR` 的 `lParam` LOWORD 为命中测试值（HTCLIENT=客户区），`wParam` 才是窗口句柄；
  命中角热区前用 `WindowFromPoint` 校验像素归属（圆角区域外的角点属于下层窗口，不越权改写）。
  热区边长 12 CSS px 是前端 `.resize-grip` 与 `window_cursor::GRIP_CSS` 的跨端契约，两端单测锁定。
  证据见 `tmp/acceptance/window-corner-resize/report.md`。

  **CSS 光标与 Windows 原生窗口拖拽光标的技术边界（2026-11-06）：**
  - CSS `cursor: grab/grabbing` 仅在 WebView2 控制鼠标时生效（悬停、非拖动态、应用网格 HTML5 拖放、
    Edge Tab 手动指针拖动）；Tauri `data-tauri-drag-region` 触发的原生 `startDragging` 进入 Win32
    模态移动/缩放循环期间，系统光标由 OS 拥有，CSS 不会反映到系统鼠标。
  - `magnetic.rs` 子类化 WndProc 在 `WM_SETCURSOR`（命中测试值在 `lParam` 的 LOWORD，`wParam` 为
    窗口句柄）按 `WindowFromPoint` 归属校验后补 `SetCursor`，仅用于缩放角热区光标恢复；原生拖动
    期间不强制握拳，接受 OS 默认光标。不新增 `.cur` 资源、全局 Hook、轮询。
  - Edge Tab（极简吸附标签）的光标**完全交还 WebView2**：`grab` / `grabbing` 由 CSS 表达，
    `EdgeTab` 摘掉 `.is-dragging` 后 Blink 重算并 `SetCursor`，鼠标静止也能立即恢复。
    原 `refresh_edge_tab_cursor`（`WM_CURSOR_EDGE_TAB` → `SetCursor(IDC_HAND/ARROW)`）已移除：
    Win32 没有与 `grab/grabbing` 等价的系统光标，强制写入只会在松手后留下手形/箭头，
    并覆盖 CSS 结果。
  - 多入口共享打包 CSS（`cssCodeSplit: false`）时，**弹窗入口不得写无作用域的
    `html / body / #root` 布局规则**：它们会同时作用到主窗（历史故障：tab-hint 页的
    `#root{display:flex}` 把主窗压成 0 宽）。页面级规则一律挂各入口的页面根 class；
    由 `src/styles-entry-scope.test.ts` 与 `scripts/check-entry-css.mjs` 双层守卫。
    逗号分组选择器**逐项判定**（`html, body, #root`、`:is(html, body)` 都算裸根，
    不因同组另有已限定作用域的选择器而放行）。
  - 跨窗口浮层（`tab-hint` 悬停提示）的显示是**可取消的三段式会话**（show → 测量 → fit → 真显），
    以单调代次管理：hide/新 show 使在途 fit 失效，过期 fit 不得重新显示窗口。
  - tab-hint 的**就绪握手**：前端先建立 `tab-hint-show` 订阅、成功后才调用 `tab_hint_ready`；
    未就绪期间的 show 只在后端排队，ready 时补发一次（Tauri 事件无缓冲，提前 emit 会丢）。
    订阅失败/组件卸载不报 ready；窗口销毁复位为未就绪。后端可区分「窗口不存在 /
    监听未就绪 / 已就绪」三态，不用固定延迟或轮询掩盖时序。
  - tab-hint 四个命令（show/hide/fit/ready）必须保持**同步命令**：它们只更新状态并投递
    窗口 API（不创建 WebView、不在命令内阻塞等待消息循环）。Tauri 在 WebView2 消息线程
    （Windows 主线程）内联执行同步命令，show/hide/fit 与 `Destroyed` 事件严格串行，
    reveal 的提交门不会与 hide 交错；改成 `async fn` 会转到 async runtime 线程池，
    必须另行引入提交序号/主线程封送。**窗口创建**命令（如 `show_widget_window`）仍必须
    async（`build()` 依赖消息循环继续运转，见微件章节），两者不矛盾。
  - 悬停提示随真实 Agent 状态更新：只在「提示已显示 + 鼠标仍在标签上 + 文案真正变化」时
    原地推进代次（不 hide、不闪烁），并按单飞/合并限制 IPC 频率；拖动、右键菜单、
    形态过渡、离开标签期间一律不显示。
  - 前端 `useWindowDragCursor/useRailDragCursor/useWidgetDragCursor` 的 120ms 起始守卫只抑制启动扰动
    导致的 DOM 类闪烁，不试图控制 OS 光标；`pointerup/pointercancel/visibilitychange` 为可靠结束信号。
  详见 [ui-themes/](ui-themes/) 目录。

### 7. 智能剪贴板（clipboard/，v0.5）
- `platform.rs` 是唯一的 Win32 层：`AddClipboardFormatListener` 消息窗口监听，
  读取 CF_UNICODETEXT / HTML Format / PNG / DIB / CF_HDROP，快照与恢复、
  `SendInput` Ctrl+V、系统敏感标记检查；非 Windows 为明确降级桩。
  32bpp BI_RGB DIB 合成出的“全透明 PNG”经 `image::normalize_clipboard_png`
  归一化为不透明（仅当所有像素 Alpha=0），避免历史与粘贴结果不可见。
- 剪贴板设置读取 fail-closed：键缺失可用默认值；JSON/类型/范围/数据库读取失败时
  停止自动采集并在抽屉显示“配置异常，自动记录已暂停”，修复需用户显式操作并备份原值。
- 采集分三个线程：`clipboard-monitor` 只把序列号入队（64 条，丢最旧），
  `clipboard-capture` 合并最新序列号/读取/过滤/图片编码，`clipboard-worker` 入库；
  内容队列 8 条 / 128 MB，丢弃计数经 `clipboard_status.monitor` 暴露。
  Windows 剪贴板不可回放，丢弃即丢失，不宣称零丢失。
- 写入统一走进程级 `ACCESS_LOCK` + 内容守卫：本进程所有 `OpenClipboard → 读/写 →
  CloseClipboard` 串行化，修复同进程线程互踩句柄；锁内比较内容后再
  `EmptyClipboard`，不匹配绝不覆盖；恢复仅在内容仍等于本任务最后写入时进行，
  否则保留用户新内容。
- `engine.rs` 纯逻辑：类型优先级（files > image > URL > html > text）、SHA-256 去重、
  预览、高置信敏感特征、来源未知时的保守凭据模式、HTML 消毒、CF_HTML、
  整组富文本、自动分组/恢复决策。
- `store.rs` 持久化：文字入库、图片/缩略图落文件（相对路径），引用安全删除、
  收藏/置顶保护、保留期/条数/容量清理、分页搜索。
- `paste.rs` 逐项粘贴：单活动任务互斥、目标窗口预检（UIPI）、焦点重试、
  条目状态机（`pending → … → settling → unverified`，`confirmed` 无可靠信号不启用）、
  分类型间隔与独立收尾、取消保留未处理项、写入后不盲目重发；只报告“按键已发送”，
  不冒充目标已接收。
- `agent_bridge.rs` 只生成本地导出包（Markdown + 图片 + manifest），无网络上传；
  能力矩阵区分直接发送（不支持）/文件导入（未验证）/桌面粘贴（需窗口、手动）/
  本地导出（可用）。
- 详细设计、测试与限制见 [docs/clipboard/](clipboard/01-requirements.md)，
  整改分类证据见 [clipboard/10-remediation-acceptance.md](clipboard/10-remediation-acceptance.md)。

#### 2026-11-04 采集可靠性加固（工具面板联检轮）

- **读取占用有界重排**：`open_clipboard` 120ms 重试仍被独占（Office 延迟渲染、剪贴板
  管理器等场景）时，事件不再永久丢弃——重排回事件队列（上限 3 次，总等待约 480ms），
  超限才 `read_failed++`；不引入无限重试或无界队列。
- **清空→复制竞态修复**：`clipboard_clear_history` 先记 `clear_seq` 再推进
  `capture_epoch`，两步之间到达的复制旧实现被旧代数误杀；改由
  `cleared_stale_gate`（旧代数**且**序列号不晚于清空水位才丢）判定，序列号为内容
  先后权威证据；事件层与内容层（`QueuedCapture.sequence`）统一。
- **监听盲区计数**：启动/看门狗重启间隙到达的 `WM_CLIPBOARDUPDATE` 此前静默消失，
  现计入 `clipboard_status.monitor.unobserved_events`（新增诊断字段，向后兼容）。
- **IPC 契约归一化（bridge 层）**：Rust `ClipboardFilter.favorite` 为非可选 `bool`
  （无 serde default），bridge `clipboard_view` 在 IPC 边界统一补齐全部字段默认值；
  修复轻量列表只传 `limit` 时被 serde 以「missing field favorite」拒绝的问题
  （此前表现为停靠坞剪贴板面板「读取失败/暂无记录」而完整页正常）。

### 8. 行动中心（actions/，v0.5）
`actions::feed` 是**只读读模型**，与写路径完全分离：确认操作只写 `action_acks` 与通知已读位，
**绝不修改 `agent_runs` / `agent_sessions`**，更晚的事件可以让同一条目重新出现。

- **三个互不影响的类别**（前端分区展示，各自独立分页与计数）：
  - `intervention`（需介入）：`agent_runs.status IN ('waiting','failed')` 且 `origin='real'`；
    状态**只读轮次当前值**，采用「最新事件胜出」，不从事件窗口推断。
  - `notification`（未确认通知）：`notification_history` 中 `is_read=0` 且 `agent_origin='real'`
    的提醒类通知，以及**尚未被行动中心覆盖**的失败通知（同一轮次已是 failed 时不重复占位）。
  - `history`（历史事件）：近 30 天内更新过的真实轮次；完成/断连**只进历史、不进徽标**。
- **来源可信隔离**：所有查询都带 `origin='real'` 条件；自测（`taskdock-selftest-*`）、
  压测（`bench` 来源 / `http-perf-*`）与模拟来源不进入行动中心，也不改变真实状态、不弹系统通知。
- **分类与优先级**：failed=P0、waiting=P1（命中授权关键词时标记 `authorization` 且
  `authorization_inferred=true`，UI 必须标注「推断」）、disconnected/running=P2、completed=P3。
- **覆盖度**：`enabled && transport_verified` 才算「监控中」，并给出 `live/stale/no-events/
  disabled/not-configured` 与一句话解释；不支持的状态不伪造。
- **确认**：`ack(ids)` 幂等持久化到 `action_acks`（ID 形如 `run:<轮次行 ID>` / `notification:<通知 ID>`），
  提醒类同时标记已读；可撤销；历史条目被确认后仍保留在历史里。
- **计数与分页口径分离**：`counts` 走**显式 SQL 聚合**，与筛选条件、分页游标无关（全局总数）；
  列表用 **keyset 复合游标**（只接受服务端下发的 `next_cursor`），单页默认 40 条、上限 200，
  `filtered_total` 为全局筛选总数、`loaded` 为本次加载条数——三者含义不同，前端分别展示，
  新事件到达时不会丢条目、重复或重排。
- 配套：`commands/audit.rs` 提供**测试/压测数据审计**（先 dry-run 预览 → 二次确认 → 自动快照 →
  事务化删除 → 外键校验），只删除「可证明」的测试数据，无法证明归属的数据只报数不删除。

### 9. 工作现场与统一上下文（workspace/、commands/context.rs，v0.5）
- 捕获：任务已关联目标一键成快照（`source=task`），或枚举当前可见窗口勾选
  （`source=manual`）。只记录窗口标题/类名/exe 路径、文件路径、URL；**不读取窗口文本、
  不截图、不存 HWND/PID**。
- 恢复：按项顺序执行，项间默认 350ms；每项独立 try/catch，可取消；
  先尝试复用现有窗口，再按目标类型启动/打开；验证级别如实标注
  （window-confirmed/window-visible/process-spawned/launch-requested/delegated/none）。
- 上限：单快照 30 项、全局 100 个快照；删除任务只把快照降级为手动（`ON DELETE SET NULL`）。
- 统一上下文：`task_context(task_id)` 聚合任务、快照、Agent 会话、关联目标、
  剪贴板素材与待处理动作，前端以单一抽屉呈现；各模块可独立启停。
- 剪贴板素材绑定现场：`clipboard_snapshot_links` 只存关联，不复制内容。

### 10. 分类胶囊（v0.7）

停靠期主窗口**不移动、不缩放**，只切换 Win32 区域（轨道 / 轨道 ∪ 面板），
这是"鼠标在吸附条与悬浮窗口之间来回跳动"的结构性修复。细节见
[docs/ui-themes/13-capsule-redesign.md](ui-themes/13-capsule-redesign.md)。

- 几何唯一来源：`src/lib/capsuleLayout.ts`（前端布局与命中判定）与
  `src-tauri/src/window_shape.rs::capsule_regions`（区域裁剪），两端单测锁定同一组常量
  （轨道 56×446、面板默认 340×440、间隙 8）。
- 面板宽度可拖拽（2026-11-09）：设置键 `capsule_panel_width`（280–480，默认 340）由面板
  内侧边拖拽调整并持久化；窗口在停靠时按**最大宽度**预留容器（垂直 544×446 / 水平
  480×504），拖拽只改 Win32 区域与 CSS 变量，不触发原生 resize。旧库缺键按默认 340
  兼容；六类面板统一按自身宽度做容器查询，应用网格 1–5 列自适应。
- 区域：折叠 = 轨道圆角矩形；展开 = `CombineRgn(RGN_OR)` 合并两块圆角矩形，
  应用后 `GetWindowRgn` 回读验证（包围盒 + 中心点 + 间隙点）。胶囊仍由区域定义可见外形
  （区域外的容器部分不绘制、不接收鼠标）；区域半径比 CSS 圆角小 2 物理像素
  （`REGION_AA_INSET`）。主窗也使用同一内收口径（2026-11-01 深夜二轮更正，
  见 §6）。
- 几何事务：停靠时窗口**归一**为容器尺寸（大于容器也收拢，覆盖 Aero Snap 的半屏
  尺寸）；尺寸/移动/区域任一步失败都回滚到进入停靠前的用户矩形，并抑制
  `window_rect` 持久化 2.5s。区域写入失败时先校准回当前相位形态；仍失败则保持
  相位、置 `regionUnsynced` 并有界退避重试，绝不把「off 请求已发出」当成已解除。
- 状态：`useEdgeSnap` 仍是唯一写入方（五相状态机 + `docked-visible → docked-revealed`
  新转移）；`useCapsuleStore` 只保存"当前分类"这一纯 UI 选择，且**恒有值**——
  收起面板不清空分类，面板可见性只由相位决定（避免两处状态源的提交时机差）。
- 数据：任务/Agent/剪贴板/应用全部读既有 store 与既有命令，不新增轮询、不新增状态源；
  Agent 徽标只统计 waiting + failed。
- 兼容：`snap_state` 新增可选 `center`；停靠期不写 `window_rect`；
  解除吸附按模式尺寸恢复。
- 稳定性修复（2026-11-04，窗口定位 / 状态机 / Win32 裁剪）：
  - `capsule_regions` 在面板矩形越界或零尺寸时返回 `None`（整次应用显式失败并记 warn），
    不再退化成「只裁轨道」却报告成功；前端展开前先回读容器尺寸并按可用宽度收敛，区域写入
    后仍以 `GetWindowRgn` 真实几何校验。展开请求失败时 `App.tsx` 只按相位判定胶囊模式
    （`isCapsuleMode`），缺边宁可不渲染内容，也不回退完整主界面把控件泄露进翼片。
  - 拖拽期（原生合成层）：`magnetic::in_size_move` 标记 `WM_ENTERSIZEMOVE` 窗口，
    `window_shape::apply` 在拖拽循环内跳过 `GetWindowRgn` 回读与 `apply_dwm` 写入，
    只在尺寸/DPI 真变时重建区域；松手由 `WM_EXITSIZEMOVE → flush_deferred` 一次性回读补写。
    诊断开关 `TASK_DOCK_DRAG_DIAG=1` 以 ≥500ms 低频记录原生事实（前端拖拽期无 CSS 状态写入）。
    该路径的真实拖拽观感验收未在本次授权范围内执行（见验收报告）。
  - 形态切换事务：`formSwitchSeq` 令牌 + 有界 `runExclusiveResult`；只有回读成功才确认新偏好，
    失败回滚到最后确认成功的 `snap_display_mode`，快速连续切换只落最后一次；引擎忙碌导致的
    「延后」不算失败，不回滚偏好。
  - 用户尺寸：完整面板解除吸附前把用户矩形写入 `window_rect`（胶囊容器尺寸永不写入），
    解除后从 `window_rect` 恢复；无记录时回退模式默认尺寸。
  - 工作区/DPI：`refreshDockedMonitor` 每 20 tick 检查真实显示器几何变化并按比例锚定重贴，
    应用失败时回退记忆值，避免「记了新显示器但几何没跟上」。
  - `snap_state` 兼容扩展：新增可选 `center_ratio` 与 `display`（name / bounds / workArea /
    scaleFactor）；旧记录缺字段仍按绝对 `center` 与窗口所在屏恢复，顺序为
    name → bounds → workArea → 窗口所在屏，比例优先于越界的绝对中心。
  - 形态语义分离（2026-11-05）：`snap_display_mode` 只代表**用户长期偏好**，由设置页 /
    右键菜单 / 托盘经 `requestDockForm` 更新；胶囊轨道「完整面板」与完整面板「收缩为
    胶囊」按钮走 `requestSessionForm`，只切换**本次停靠会话**（`sessionFormOverride`），
    不写 `snap_display_mode`。解除停靠或换边后临时覆盖自动失效，`dockTo` 按
    「临时覆盖 → 持久化偏好」选形态，因此「胶囊 → 临时完整 → 拖离 → 再吸附」回胶囊；
    临时切换失败只回滚几何与相位，不回写偏好；临时形态期间用户明确修改默认偏好时，
    新设置优先并清掉旧临时覆盖。重启恢复不读临时状态，只按持久化偏好与既有安全恢复协议。
  - 沿边拖动（2026-11-05）：自由窗口进入候选除几何命中外，还要求本次手势内相对起点
    有真实的「向边」净位移（`SNAP_DOCK_INTENT_CSS`，大于磁力领先上限
    `SNAP_MAGNET_MAX_LEAD`），沿边平行拖动或仅被磁力吸进吸附区都不再吸附收缩；
    已停靠窗口跨边切换必须先真正离开当前边磁吸区（`shouldSwitchDockEdge`，阈值
    与 `SNAP_CANDIDATE_EXIT_DIST` 一致），避免齐平窗口在角落处因距离平手被判成
    换边——换边会解除停靠并按默认偏好重新吸附，完整面板因此意外变回胶囊。
  - 极简吸附态 Edge Tab（2026-11-05）：停靠形态扩为三态——完整面板 / 胶囊 / 极简标签
    （`SnapPhase` 新增 `docked-tab`），仍由 `useEdgeSnap` 单一状态机 + `canTransition`
    守卫写入；标签几何 `10×46 CSS`（水平边镜像为 `46×10`）由 `capsuleLayout.ts` 与
    `window_shape.rs::edge_tab_regions` 双端锁定，区域为贴屏直边 + 内侧 8px 圆角的圆角矩形，
    另加缺口探针验证不误拦其他应用。收起/恢复复用同一套 `tabTransition` 过渡（
    `to-tab` / `from-tab`）：轨道 `transform` 侧滑 + `clip-path` 收成 46px 高条 + 标签
    38% 起交叉渐显，300ms `cubic-bezier(.22,1,.36,1)`，reduced-motion 直接提交；过渡中
    `tabAnimating` 防重入，窗口区域只在过渡结束提交一次（`setRegionThenPhase`），不每帧
    发窗口命令。持久化在既有 `snap_state` 上追加可选 `form`（`capsule` / `tab`），重启按
    偏好直接恢复标签；自由态 → 标签的转移仅用于重启恢复。标签点击恢复、垂直拖动只改
    纵向中心（`beginTabDrag/dragTabBy/endTabDrag` + `tabAlongDelta`），明显向内拖动按
    `TAB_RESTORE_DRAG_CSS` 阈值恢复且拖动结束不再触发点击恢复。面板展开态收起额外有一段
    160ms 离场（`panelExiting` + `PANEL_EXIT_MS`）：面板先淡出再写轨道区域，避免相位推进
    当拍卸载面板造成「突然消失」。
  - 构建溯源（2026-11-05；触发条件于 2026-11-06 修正）：`build.rs` 注入 `TASK_DOCK_GIT_COMMIT` / `TASK_DOCK_GIT_DIRTY` / `TASK_DOCK_BUILD_TIME`，
    `performance_diagnostics` 在 `build` 段返回 commit、dirty（`true`/`false`/`unknown`，轻量
    `status --porcelain --untracked-files=no`）、构建时间（Unix 秒）、debug/release
    profile 与当前 exe 路径；构建脚本监听 Git `HEAD`、当前分支 ref 与 `packed-refs`，
    分支提交前进也会刷新诊断。Git 路径通过 `git rev-parse --git-path` 解析，兼容 worktree
    的 `.git` 指针文件；不新增依赖、不写用户路径到公开日志。

### 11. 快速捕获（quick_capture/，v0.7）

任意界面按 `Ctrl+Shift+Space` 打开独立的常驻捕获窗口，主窗口不展开；提交后内容按类型进入任务
或临时收集箱。窗口与命令在 `src-tauri/src/quick_capture/mod.rs`，数据与校验在 `store.rs`；
前端窗口在 `capture.html` + `src/capture/`，收集箱面板在 `src/components/inbox/` +
`src/store/useCaptureStore.ts`。

**静态窗口**（`src-tauri/tauri.conf.json`，全部 `decorations=false`、`transparent=true`、
`shadow=false`、`alwaysOnTop=true`、`skipTaskbar=true`、默认 `visible=false`；主窗只保留托盘/
热键/第二实例唤回入口，不占任务栏（2026-11-09 按用户选择恢复，取代 2026-11-08 的进任务栏
方案）；详细能力见 `src-tauri/capabilities/`）：

| 窗口 | 用途 | 尺寸（逻辑像素） | 关闭语义 |
|---|---|---|---|
| `main` | 托盘主窗（极简/紧凑/完整） | 400×560，可缩放 | 隐藏，可贴边吸附/胶囊区域 |
| `context-menu` | 托盘/右键菜单 | 250×620，固定 | 失焦隐藏 |
| `notification` | 桌面通知 | 400×400，固定 | 隐藏后复用 |
| `capture` | 快速捕获（v0.7） | 640×360，固定、不占任务栏 | `prevent_close` + hide 复用同一 WebView |

捕获窗口 capability 为 `core:default` + `core:event:default` + `core:window:allow-start-dragging`
（`src-tauri/capabilities/capture.json`），业务调用走自定义命令，不在窗口内直接调 Tauri
window API；唯一的窗口 API 是 drag-region 触发的原生拖动（2026-11-11）。

**生命周期**：
- `Ctrl+Shift+Space` 与托盘/右键菜单「快速捕获」都调用 `quick_capture::toggle`：隐藏时记录
  唤起前前台 HWND（仅进程内存），按「前台窗口显示器 → 光标显示器 → 主显示器」的 work_area
  物理像素居中并收敛，必要时缩小窗口，`show` + `set_focus` 后发 `quick-capture-summoned`；
  已可见未聚焦只聚焦；已可见且聚焦则 toggle 隐藏。窗口只创建一次，热键不重复注册。
- 统一隐藏入口 `hide_capture(app, restore_focus)`：hide → 若隐藏前捕获窗口是前台，单次尽力
  `focus_window` 恢复唤起前窗口（失败静默、不重试）→ 发 `quick-capture-hidden` → 清 HWND。
  失焦时先通知前端 flush 草稿再隐藏，不抢回焦点；`Alt+F4` 走 `prevent_close` + hide。
- 退出路径：窗口可见时发 `capture-flush-draft` 并最多等 300ms 让前端落草稿，再走原有退出排空；
  隐藏后无轮询。
- 前端收到 `quick-capture-summoned` 后重读 `quick_capture_state`，恢复草稿与上次类型
  （设置键 `quick_capture_last_type`）。

**头部拖拽（2026-11-11）**：标题、类型标签与空白区声明 `data-tauri-drag-region`（关闭按钮不声明），
由 Tauri drag-region 进入 Win32 系统移动循环；`src/capture/main.tsx` 安装
`installNativeDragBridge()`，后端 `drag_watch::install` 监听 `WM_ENTERSIZEMOVE`/`WM_EXITSIZEMOVE`
并发 `window-drag {phase, generation}`，前端据此切换 `grabbing` 光标会话（与主窗/微件同一协议）。
捕获窗固定 640×360，拖拽只改位置不改尺寸；双击拖拽面被前端拦截，避免默认
`internal_toggle_maximize` 把卡片撑满屏幕。

**语音输入（2026-11-11）**：`quick_capture/voice.rs` 封装
`Windows.Media.SpeechRecognition.SpeechRecognizer`（听写主题约束）的连续识别会话。
- 专用常驻线程只初始化一次 MTA COM（与 `audio::tts` 同一理由：避免 windows-core 激活工厂
  缓存在套间拆除后失效）；任务队列有界（8），满载返回可重试 busy；启动/停止全部带超时轮询，
  命令层 `spawn_blocking`，不阻塞 UI。
- 首次 `start` 才创建线程与会话；`stop`、窗口隐藏/失焦、提交、应用退出都会停止会话并
  `Close` 识别器，麦克风不后台常驻。自然静音超时（初始 10s、连续 30s）由 WinRT 结束会话。
- 语言优先中文听写语言；系统无中文识别包时回退系统语音语言并通过
  `VoiceStartResult.language` 如实上报，前端提示「系统未提供中文语音包」。
- 事件只发 capture 窗口：`capture-voice-partial`（临时假设，仅展示）、`capture-voice-final`
  （定稿片段，追加正文，草稿防抖落盘）、`capture-voice-status`
  （`{status: idle|error, code, message}`）。识别正文不进日志、不进错误文案。
- 识别引擎由 Windows 语音服务提供；是否走在线识别取决于系统「在线语音识别」设置，
  Task Dock 自身不保存、不上传音频。
- **隐私开关未开启（2026-11-11 增补）**：WinRT 返回隐私策略未接受
  （`0x80045509` / `0x800455A0`）时映射为结构化 `PERMISSION_REQUIRED`（不再把英文系统
  原文直接暴露给用户），前端展示中文说明与「打开设置」入口，经
  `quick_capture_open_speech_settings` 打开 `ms-settings:privacy-speech`；应用不代替用户
  修改系统隐私设置。Windows 按进程缓存该判定，运行期间才开启设置的旧进程仍会失败，
  因此文案明确要求重启 Task Dock 后重试。`StartAsync`/`CompileConstraintsAsync` 的异步
  失败现在读取 `GetResults()` 的真实 HRESULT 再分类，不再退化成无原因的通用错误。
- **停止时补发最后一句（2026-11-11 增补）**：
  `SpeechContinuousRecognitionSession.StopAsync` 会把待定音频交给 `ResultGenerated`
  （`CancelAsync` 才丢弃）。停止收尾期间后端保持结果通道打开，把片段改道到有界缓冲
  （上限 64 条）并随 `quick_capture_voice_stop` 回包返回；前端新增 `stopping` 相位，期间
  继续接收 `capture-voice-final`，用户主动停止时收到回包后追加片段再回 idle。
  停止完成前把 `active` 置 false 会吞掉最后一句，相关命令与事件契约同步为返回片段数组。

**提交与数据流**：`quick_capture_submit` 在单事务内完成「按 `client_id` 查重 → 插入
`quick_capture_items` → task/todo 在同一事务用 `commands::tasks::create_task_tx` 建任务并回写
`task_id`/`status='converted'` → 删除 active 草稿 → 提交」；唯一索引冲突时回查并返回
`duplicate=true`。任务/待办复用现有任务创建链路与中文 NLP 解析，不建第二套任务系统。
`quick-capture-created` 事件只带 `kind/id/task_id/status`，不含正文。收集箱是完整模式新增的
第 5 个 tab（导航共 8 个，Ctrl+5），主窗口订阅该事件后合并刷新任务列表与未处理计数。

**数据表**：SQLite v17 追加 `quick_capture_items`（kind 五值、status
inbox/handled/converted、可选 url/note/task_id、`client_id` 唯一索引）与
`quick_capture_draft`（单行 `id='active'` 草稿），两表均登记 `BACKUP_TABLES`（core 组）。

**隐私**：捕获内容只来自用户显式输入，不读剪贴板、不采集密码/凭据；日志与错误信息不记录
正文，错误不拼接内容；无任何外网请求。语音输入仅在用户点击麦克风后录音，音频交给 Windows
语音识别服务，Task Dock 不保存音频与识别中间结果（只把定稿片段写入正文/草稿）。功能与用户
说明见 [quick-capture/README.md](quick-capture/README.md)。

### 12. 任务统计 / 快速笔记 / 自定义快捷键 / Agent 工作时间统计（v0.9，2026-11-04）

四个模块各自独立（`task_analytics/`、`notes/`、`hotkeys/`、`agent_stats/`），共用同一套
数据层与命令层，不新建平行任务系统，也不在前端重复聚合。
- **任务统计（`task_analytics/`）**：迁移 v24 新增 `task_completion_events`（完成事实表，
  `origin` 仅 `user|backfill`、`kind` 仅 `once|recurring`），并补 `tasks(due_at)` 索引。
  普通任务完成时写入事件；重复任务每一期各写一条。升级时只用既有 `tasks.completed_at`
  回填 `origin='backfill'`，**不推断、不伪造历史期次**。命令 `task_analytics(range)` 只读，
  range ∈ `day|week|month`（默认 day），趋势按本地自然日/周/月分桶。取消完成会按
  `(task_id, completed_at)` 删除对应事件，保证统计可回退。
  **期次原子性与幂等（迁移 v28）**：重复任务完成时「期次推进（含提醒重建）+ 写入本期完成
  事件」在同一事务提交，任一步失败整体回滚；推进以进入命令时读到的 `due_at` 作为期次身份
  做 `UPDATE ... WHERE due_at IS ?` 乐观并发控制，并发/重放请求返回 `Conflict`，不会把同一
  周期推进两次。迁移 v28 清理历史重复并建立部分唯一索引
  `(task_id, kind, due_at) WHERE due_at IS NOT NULL`；`due_at` 为 NULL 的期次不参与去重
  （否则重复任务的无截止期次会被永久吞掉），并发保护由事务内期次 CAS 负责。调度器自动到期
  推进**不写**完成事件（不是用户完成），但照常写通知历史。
- **快速笔记（`notes/`）**：迁移 v25 建 `notes` 表（`NOTES_SCHEMA` 常量，正文仅本地存储），
  与任务 / 工作现场为弱关联（`ON DELETE SET NULL`）；`notes_convert_capture` 只把捕获箱
  条目复制为笔记（原条目不改、不删除；同一 `capture_id` 重试幂等返回已有笔记）。搜索为本地
  `LIKE` 截断（limit 1~200，默认 50），无外网、无向量索引。全局搜索以 `notes` 分类接入，
  复用 `notes::store::search_in_conn`；定位走「收集与暂存 → 笔记」子页。
- **自定义快捷键（`hotkeys/`）**：不新增迁移，注册状态存本机 `hotkeys.json`（应用数据目录），
  旧设置 `hotkey_enabled` 仅作为「系统级默认启用」种子。管理器在启动时按动作注册，
  **只记录实际注册成功的组合**；失败原因写入快照供 UI 展示，不静默失败。按键分发统一走
  `tauri-plugin-global-shortcut` 单一 handler → `hotkeys::handle_shortcut`，未匹配即返回。
  应用内（`app_local`）按键由 `useHotkeysRuntime` 在渲染进程分发；系统级（`system_global`）
  按键不在前端重复监听。`hotkeys.json` 随备份迁移；恢复时逐项重新校验/注册，冲突则降级
  或禁用并保留原配置为待解决项（见「v0.10 用户配置备份」）。
- **Agent 工作时间统计（`agent_stats/`）**：迁移 v26 只补两个索引
  （`agent_runs(origin, started_at)`、`agent_events(source_id, session_external_id, ingest_seq)`），
  **不新增表、不写回运行状态**；按本机自然日切窗聚合运行时长与事件量，未观测到的空闲时间
  不计入。命令 `agent_work_time_stats({ from, to, origin? })` 只读（阻塞查询在线程池执行），
  不做轮询。
- 两张新表 `task_completion_events`、`notes` 均登记 `BACKUP_TABLES`（class=core，
  快速备份全量）与 `EXTENDED_TABLES`（通用行格式，旧备份缺段按缺表跳过）。

### 13. 专注与休息（core.focus-timer，v0.10，2026-11-04）

模块位于 `focus/`（`core` / `model` / `store`），前端为 `components/focus/` 与
`store/useFocusStore.ts`。状态由 Rust 侧权威维护，前端只读快照并用共享时钟推算展示。

- **时间模型**：有效时长只由单调时钟 `Instant` 增量累加，墙钟时间仅作锚点与持久化。
  两次 tick 间隔 **≥10 秒**视为进程被挂起/休眠，会话转「已暂停（unconfirmed_gap）」且
  **不补记**该区间。落库只发生在状态变化、完成与每 30 秒恢复点，**绝不每秒写库**。
- **调度复用**：`focus::tick` 由既有 `scheduler.rs` 的 1 秒循环调用，**不新增第二套常驻
  定时器**；通知复用 `AgentHub` 提醒通道，事件为 `focus-changed/completed/sedentary`。
- **单活跃会话**：数据库部分唯一索引 `idx_focus_single_active(active) WHERE active=1` 与
  内存守卫双重保证；暂停态仍算活跃；重复开始/暂停/结束均为幂等空操作。
- **启动恢复**：`lib.rs` setup 在调度器启动后调用 `focus::restore_on_startup`，把上次退出时
  仍在运行的会话转「已暂停（app_restart）」，不补记退出区间。数据导入/备份恢复成功后调用
  `focus::reset_runtime` 丢弃进程内缓存，避免旧偏好或幽灵会话写回新库。
- **数据**：迁移 v27 建 `focus_sessions`（保留 `task_title` 快照、无外键，任务删除后历史仍
  可读）与 `focus_daily_stats`（按本地日期聚合）；两表登记 `BACKUP_TABLES`（class=focus，
  快速备份全量）与 `EXTENDED_TABLES`。偏好存 `application_settings` 的 `focus_*` 键。
- **入口**：任务页「专注与休息」子视图（按需挂载，关闭即卸载），胶囊面板顶部状态徽标
  （无活动会话返回 null，不占位、不新增轮询）。
  2026-11-12：改为**独立工作视图**（`TasksPanel` 单一 `mode` 状态：list / focus / analytics）。
  进入后只保留「← 返回任务 + 专注模式」头部与 `FocusWorkspace`，任务列表专用工具栏
  （概览 / 快速添加 / 日期 / 搜索 / 状态 / 排序 / 提醒摘要）全部不渲染；返回按钮与 Escape
  走同一 `backToList()`，筛选与列表滚动位置恢复。计时状态在 store 与后端，切视图不重置。

### 14. 桌面微件独立窗口（v0.10，2026-11-04）

微件可从主窗内看板升级为独立桌面窗口，**复用既有微件组件、Store 与数据源**，不复制业务层。

- **宿主入口**：`widget.html` + `src/widgets/main.tsx` 是独立前端入口，**不挂载 `App.tsx`**，
  因此不启动主窗全局监听、刷新调度、贴边吸附与偏好镜像。宿主只做「读快照 → 渲染 → 上报几何」；
  主窗内的 `components/widgets/WidgetDesktopBridge.tsx` 是唯一窗口创建/销毁调度方。
- **窗口与权限**：Rust `widget_windows.rs` 用 `WebviewWindowBuilder` 动态创建 label
  `widget-<type>`，透明无边框、关闭即 `destroy`（不保留隐藏 WebView）。权限单独收口在
  `capabilities/widgets.json`（`windows: ["widget-*"]`，仅 `core:default`、`core:event:default`
  与 `core:window:allow-start-dragging`），**不继承主窗能力集**。
- **层级与焦点**：默认普通层级，用户可开「始终置顶」；窗口 `set_focusable(false)`，不抢键盘焦点；
  首版不做 WorkerW 桌面嵌入与复杂吸附/自动隐藏。
- **跨 WebView 状态**：Zustand 不跨窗口共享。主窗是唯一数据所有者，微件只读带 `revision` 的快照，
  按 `revision` 丢弃旧消息；事件协议 `widget-snapshot` / `widget-snapshot-request` /
  `widget-action` / `widget-bounds-changed` / `widget-window-dismissed`。专注与效率数据仅在窗口
  打开期间订阅，提醒仅在提醒窗口打开时读取，Agent 复用既有监控快照（**不新增扫描器**）。
- **位置与 DPI**：配置存归一化锚点 `nx/ny`（相对显示器工作区）+ 显示器名称快照 + 逻辑尺寸 +
  `topmost`，不存物理像素坐标；Rust 按当前显示器 `scale_factor` 换算，显示器缺失/越界/插拔时
  回落主屏并 `clamp` 回工作区，**永不永久留在屏外**。拖动/缩放结束去抖后上报，主窗写盘一次，
  **不逐帧写**。跨设备恢复不盲用原显示器坐标。
- **配置模型**：扩展现有 `taskdock.widgets.layout.v1` 与 `preferences.json` 镜像的 `widgets` 镜像
  （`WidgetDesktopState`），旧数据缺字段按「不显示/不置顶」安全默认补齐；`enabled`（看板卡片）
  与 `desktop.visible`（桌面窗口）相互独立。恢复默认会同时关闭桌面窗口并清位置，管理页已明示。
- **材质与圆角**：独立窗口不启用原生 Mica/Acrylic，统一使用 CSS 半透明表面（`solid` 材质回退
  不透明）；Win32 圆角裁剪复用 `window_shape::apply_with_radius` 的独立窗口路径，DPI 变化时重裁。
- **证据边界**：单元/构建验证覆盖迁移、状态独立、坐标归一化与协议；真实多窗口拖动、多显示器插拔、
  100–200% DPI 与资源回收需真机验收，不作为自动化结论。

**复验修正（2026-11-04，review-fix）**

- **尺寸三态**：`size`（sm/md/lg）决定窗口预设；`desktop.width/height` 只保存**用户手动缩放**后的
  自定义尺寸，切换预设时清空。Rust 记录每个类型最后一次 `set_size` 的逻辑尺寸，几何上报时
  与之比较判定 `customSize`；程序缩放、DPI 换算、首次创建测量值都不得写成自定义尺寸。
- **今日任务**：桌面微件不读任务页 `tasks`（会受筛选/排序/分页影响），改由主窗调用
  `list_tasks({ view: "due_today_or_overdue", status: "pending", sort: "due", limit })`，
  后端只查「今日到期 + 已逾期且未完成」并在排序后限量；失败保留上次成功数据并显式标记过期。
  点击条目时若当前列表不含该任务，主窗调用 `fetch_task(id)` 取回后打开编辑器，任务页仅是最终失败兜底。
- **窗口生命周期对账**：主窗按类型串行窗口命令，创建完成后再次校验 `desktop.visible`，期间被关闭
  则立即销毁；Rust `Destroyed` 事件补发 `widget-window-dismissed`（幂等），避免幽灵窗口。
  `desktopRuntime`（hidden/creating/shown/failed，仅内存）区分配置期望与实际窗口，管理页分别统计
  「桌面 N」与「已显示 N」，失败可重试。
- **可见性判定**：不再以「与显示器有任意交集」算可见；要求任一显示器工作区内至少保留
  `120×48` 逻辑像素的可操作区域，否则收进当前屏或回落默认层叠位。
- **窗口表面可读性**：独立微件窗口直接叠在壁纸上，表面透明度收紧到接近不透明（≥0.975），
  仅保留高光/渐变；不改主窗与胶囊材质。

**真机修正（2026-11-04，real-run）**

- **窗口创建命令必须 async**：`show_widget_window` 原为同步命令，在 IPC/Windows 消息线程内执行，
  而 `WebviewWindowBuilder::build()` 创建 WebView2 控制器依赖消息循环继续运转，同线程阻塞等待
  会互锁——前端永久停在「正在创建」，桌面不出现任何窗口。改为 `async fn` 后创建、尺寸、置顶、
  关闭重开、退出回收全部恢复正常。
- **隔离实例即独立应用身份**：`instance_identifier`（`lib.rs`）在设置 `TASK_DOCK_DATA_DIR` 时把
  AUMID 派生为 `com.taskdock.desktop.iso.<hash>`。并行验收同时启动多个隔离实例时，系统任务栏 /
  应用列表会把它们视为多个独立应用（同名图标）。这是隔离设计的有意行为，不是应用条目重复。

## 三、数据模型（SQLite）

```
tasks ──┬── recurrence_rules (1:0..1)
        ├── task_reminders (1:N，UNIQUE(task_id, occurrence))
        ├── task_agent_links (1:N，v0.1~0.3 Agent 会话关联，保留)
        └── task_navigation_targets (1:N，v0.4 通用目标关联)

agent_sources (codex/qoder/workbuddy/mock/bench …，v0.5 起带 category=real/mock/benchmark)
agent_sessions (UNIQUE(source_id, external_id)；v0.5 起带 origin)
agent_runs     (UNIQUE(source_id, external_run_id) WHERE NOT NULL；v0.5 起带 origin)
agent_events   (流水，仅元数据；v0.5 起带 origin + (origin, received_at) 复合索引)
agent_instances(v0.5 起带 origin)

navigation_targets        （用户确认的目标；普通应用按 app_key+target_type 去重，
                            v33 起指定窗口按 shortcut_kind+bound_window_identity 区分）
navigation_log            （导航执行流水，供失败回看）

clipboard_items           （内容哈希唯一；文字/元数据；图片/文件引用）
clipboard_assets          （图片原图/缩略图文件路径，role=image/thumb）
clipboard_groups          （auto/manual；collecting/closed）
clipboard_group_items     （组内 position 顺序，双外键级联）
clipboard_task_links      （任务↔条目/分组；任务删除只删关联）
clipboard_paste_jobs      （逐项粘贴审计：sent/remaining/status/restored）
clipboard_snapshot_links  （v0.5 工作现场↔素材，只存关联）

voice_packs               （v39 自定义语音包元数据）
voice_assets              （v39 SHA-256 去重的 MP3/WAV 资产元数据）
voice_pack_assets         （v39 语音包↔共享音频资源，保存显示名）
voice_bindings            （v39 每包每事件至多一条固定语音绑定）

workspace_snapshots       （任务现场/手动现场；任务删除 SET NULL 降级）
workspace_snapshot_items  （≤30 项；窗口身份字段，无 HWND/PID）
action_acks               （行动中心已处理，按 event_id 幂等）

quick_capture_items       （v0.7 捕获记录；client_id 唯一索引幂等；kind 五值；status inbox · handled · converted）
quick_capture_draft       （v0.7 单行草稿 id='active'；提交成功在同一事务内删除）

planning_projects         （v0.7 规划中心「我的项目」；status planning/in_progress/paused/completed；archived 独立）
planning_milestones       （v0.7 项目内里程碑；删除时功能关联 SET NULL）
planning_features         （v0.7 功能规划；状态六值与步骤进度相互独立；completed_at 随状态维护）
planning_feature_steps    （v0.7 开发步骤；done/completed_at；功能删除级联）
planning_activity         （v0.7 进度历史：note/status_change/step_done 三类；项目/功能删除级联）

task_categories · notification_history (UNIQUE(kind, ref_id, occurrence)) · application_settings
task_reminder_links        （v41 任务提醒联动：一任务一条；target_kind workspace|scene；删任务级联）
```

时间一律以 UTC ISO8601 字符串存储，展示层转本地时区。

### v0.4 缺陷整改：规则与任务窗口身份（2026-10-29）

- 编辑请求中 recurrence 缺失表示保留，null 表示取消；修改已有规则原位更新，保留 ID、until、anchor。仅修改截止时间不改变周期锚点；普通字段编辑不重建提醒行。
- SQLite v6 在 task_navigation_targets 增加 window_identity（可空 JSON）及 window_fallback（reselect / focus_app / launch，默认 reselect）。身份包含 EXE、类名、标题和 user 来源，不保存 HWND。应用目标继续复用。
- 任务卡与工作区通过 task_link_id 传递关联上下文；后端核对关联与目标。显式身份只接受唯一完整匹配，标题变化或窗口关闭默认要求重新选择，降级结果明确标注。
- 应用自动记忆在同一数据库锁内检查来源并写入，不能覆盖 user 记忆。任务窗口选择与关联创建事务化保存。
- Agent 徽标按旧关联与导航关联的 source/session 并集计数。手工关联将 auto 影子升级为 user；解除导航只删除 auto，手工列表只展示 user，失效引用保留。
- 备份格式 v4 保存任务窗口配置并兼容导入 v1～v3；旧程序应拒绝新版本文件，避免静默丢失窗口配置。SQLite schema 版本与备份格式版本分别维护。

### v0.5 备份与恢复架构（2026-10-30）

**统一注册表**：`src-tauri/src/commands/backup.rs` 的 `BACKUP_TABLES` 声明全部用户业务表
（v0.7 规划、v0.8 货架/工作流、v0.9 笔记/专注/任务完成事件以及 v39 语音包均在同一注册表中
登记）、恢复顺序与外键依赖；`EXTENDED_TABLES` 标记剪贴板、工作现场、行动中心与语音包等
v0.5 扩展表。新增迁移表若未登记，`backup_registry_covers_every_schema_table` 会直接失败，
防止“新模块数据从未进入备份却无人发现”。

**完整与快速备份**：

- full：全量业务表 + 事件归档 JSONL + 全部剪贴板原图/缩略图；不静默截断。
- quick：事件最近 20000 行 + 全部 running/waiting 保护行，通知 500、导航流水 500、
  剪贴板条目 2000、粘贴作业 500；header 记录数据库总量、`partial=true`、
  `partial_reasons` 与 `truncated_tables`。快速备份不打包事件归档，并只打包被导出条目
  引用的剪贴板/暂存架资产，避免恢复出“有数据库行、无图片文件”的半套数据；语音包属于用户
  托管资产，quick/full 均全量保存语音元数据、事件绑定与去重音频文件。
- bundle 为流式 JSONL（header/section/archive/asset/integrity），表行 500 行/块，
  归档 1 MiB/块，资产 512 KiB/块；先写临时文件再原子替换，已有目标轮换为 `.previous`。
- header 声明 `manifest_version`、`registry`、`excluded_settings` 与
  `device_specific_settings`；integrity 行是此前全部字节的 SHA-256，读取时逐行重算。

**设置分类**：

- 普通用户设置：外观、提醒、导航偏好、剪贴板策略、工作现场与 Agent 接入参数等，随 full 导出；
- 设备相关设置：`window_rect`、`snap_state`、`nav_window_memory`、`autostart`，允许导出，
  但恢复后按本机窗口/自启动状态重新校验；
- 本机安全项：`http_token` 与恢复内部标记 `restore_commit_id` **绝不进入任何导出文件**；
  恢复后 `http_token` 在本机重新生成，验收比较时按设计排除。

**恢复原子性**：`src-tauri/src/commands/restore.rs` 使用会话目录（staging / vault）与
`restore-journal.json` 状态机：
`preparing → validated → ready_to_commit → committing → completed`；
失败进入 `rollback_required → rolling_back → rolled_back`，回滚失败为
`failed_unrecovered`（保留 pre-backup、vault 与日志作为证据）。
数据库替换与 `restore_commit_id` 标记在同一 SQLite 事务提交；资产/归档在提交前先留底，
逐个原子替换，回滚按逆序还原并删除新建文件。进程在任意时刻退出，启动时由
`recover_pending` 依据标记决定续跑还是回滚。旧版 JSON/bundle 恢复使用
`allow_extended=false`，保留库内剪贴板、工作现场与行动中心数据。

**兼容性**：旧版 JSON 导出仍可导入；旧 bundle 缺少扩展模块时不会删除新模块数据；
新程序拒绝高于 `MANIFEST_VERSION` 的备份，避免静默丢失未知模块。

### v0.10 用户配置备份与恢复（2026-11-04）

`hotkeys.json`、语言偏好（`taskdock.locale`）与微件布局原本只在数据目录 / localStorage，
换机或恢复备份会丢失。现复用既有 bundle，在 **header 增加可选 `config` 字段**，不新增
顶层 record：旧读取器会忽略 header 未知字段，因此「旧版本读新备份」与「新版本读旧备份」
双向都不因配置被拒；缺失即旧备份语义（不改本机配置）。`BUNDLE_VERSION` / `MANIFEST_VERSION`
与 SQLite schema 均未变，配置自身 `version=1`。

- **偏好镜像**：前端变更经 `set_user_preferences` 原子写 `preferences.json`（300ms 防抖）；
  启动时 `get_user_preferences` 对账，localStorage 缺失才用文件补齐，冲突时 localStorage
  优先并回写。恢复后写 `preferences.restore-pending.json` 并广播
  `user-preferences-restored`；前端以文件为准覆盖 localStorage，再以 `restoreId` 回执清除。
- **应用网格排序（2026-11-05）**：`taskdock.apps.grid.order.v1` 与语言/微件共用同一份
  `preferences.json` 镜像与备份 header；数组包含普通应用 ID 和加号伪项
  `__taskdock_app_add__`。Rust 与前端使用同一归一化规则（去重、空/超长 ID 丢弃、上限 500、
  空数组视为无手动排序）。旧备份缺该字段、字段损坏或版本不符时保留本机排序；恢复时只覆盖
  明确携带的字段，未知/已删除应用 ID 由前端 `buildAppGrid` 安全跳过。
- **校验**：语言仅接受 `zh-CN|en-US|system`，非法回退 `zh-CN`；微件按
  `WIDGET_DEFAULTS` 白名单过滤未知类型、重复 ID 与非法尺寸，保留支持项顺序/启用状态；
  配置损坏只跳过该字段并返回 warning，不阻断数据恢复。
- **快捷键**：恢复后逐项重新校验组合合法性、重复项与系统占用；成功才标记已注册，
  失败降级默认组合或禁用并保留 `hotkeys.restore-pending.json`。管理器尚未初始化时只写
  文件并提示「下次启动注册」，不伪装成功。
- **顺序与失败策略**：数据库事务 → 资产/归档 → 用户配置；配置是次要数据，写失败只产生
  warning，不回滚已恢复的任务数据；恢复点 bundle 同样包含恢复前配置。
- **列表/确认**：`bundle_meta` 与 `list_backups` 返回 `config_included`，恢复确认与备份列表
  据此提示是否携带用户配置。

### v0.7 规划中心数据与备份兼容（2026-11-03）

- 迁移 v18 新增 `planning_*` 五表（项目/里程碑/功能/步骤/进度历史），全部登记
  `BACKUP_TABLES`（class=planning）与 `EXTENDED_TABLES`（依赖序：项目 → 里程碑 →
  功能 → 步骤/历史）；完整与快速备份均**全量保存规划数据，不做截断**。
- 扩展模块完整性校验改为以**备份文件自带的 registry 头**为准（v0.5 起每个 bundle
  都写入了导出时的表注册表）：文件 registry 声明且属于当前 `EXTENDED_TABLES` 的表
  必须提供 section；新版本新增扩展表后，**旧备份不会因缺新表被误判为不完整**。
  无 registry 头的极老文件按 `PRE_PLANNING_EXTENDED_TABLES` 兜底校验。
- 恢复语义不变：整体替换用户数据。旧备份（无规划数据）恢复会清空当前规划数据
  （与其余业务表行为一致）；规划中心导入按 `EXTENDED_TABLES` 顺序插入满足外键依赖。

### v39 自定义语音包与资产备份（2026-11-06）

- 迁移 v39 追加 `voice_packs`、`voice_assets`、`voice_pack_assets`、`voice_bindings` 四表；
  `BACKUP_TABLES` 按包定义 → 全局资源 → 包资源关联 → 事件绑定排序，quick/full 都完整备份这四表。
- 托管音频位于 `app_data_dir/audio/voice-packs/`，使用 SHA-256 文件名；同一内容可跨包引用。
  backup bundle 使用 `voice/<sha256>.<mp3|wav>` 资源路径，写入前校验文件真实大小和哈希，读入时再与
  数据行摘要/大小核对。quick backup 与 full backup 均包含所有语音音频。
- 备份/导入/恢复通过共享语音资产门禁串行化。restore 按既有 staging/vault/journal 流程留底与回滚，
  音频和数据库提交期间不会并发删除或导入同一资产；恢复完成后清理无引用的托管文件。
- 向后兼容：旧 registry 没有 voice 表时保留本机语音包及当前设置；registry 声明 voice 表但缺 section
  时拒绝；明确给出空 section 才按整体替换语义清空语音包。SQLite v39 升级默认关闭语音包功能，保留旧
  TTS 行为。`BUNDLE_VERSION` / `MANIFEST_VERSION` 不变。

### 通用 Agent 覆盖扩展迁移 v21（2026-11-03）

- 迁移 v21 仅追加 `agent_sources` 初始来源行（`INSERT OR IGNORE`），不改表结构、
  不覆盖用户已有启用/验证/配置状态；新增 Claude Code、Cursor、Gemini CLI（官方 Hooks）
  与一批仅安装/运行发现的来源（Windsurf、Cline、Roo Code、Copilot、Antigravity、Kiro、
  Continue、Aider、Augment、OpenHands、OpenClaw）。
- `agents/` 新增 `claude.rs`、`cursor.rs`、`gemini.rs`、`discovery_only.rs`；仍复用
  `ManagedAdapter` + `AgentHub` + 有界事件管线，不新增监控架构。
- Hooks 多文件安装改为事务化：全部预检查 → 统一快照 → 写入 → 语义校验 →
  任一失败按快照恢复全部文件；Windows 使用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING |
  MOVEFILE_WRITE_THROUGH)` 原子替换，消除「先删后改名」窗口期。

### v0.7 智能日程提醒 2.0 迁移 v20（2026-11-03）

- 迁移 v20 为 `recurrence_rules` 追加可空列 `by_setpos INTEGER`；旧库升级后旧规则
  `by_setpos = NULL`，`daily` / `weekly(by_weekday)` / `monthly(by_monthday)` 行为不变。
- `Task.next_remind_at` **不落库**：查询时由
  `MIN(task_reminders.remind_at) WHERE fired = 0` 子查询计算，避免把调度状态物化成第二份真值。
- 备份/导出与数据导入同步读写 `by_setpos`；旧备份缺该列时按 null 处理，向前兼容。

### 任务提醒联动迁移 v41（2026-11-08）

- 迁移 v41 新增 `task_reminder_links`：`task_id`（PK，FK→tasks ON DELETE CASCADE）、
  `target_kind`（CHECK `workspace|scene`）、`target_id`（目标 UUID；场景/现场为软引用，
  不落窗口标题、路径、HWND/PID）、`created_at` / `updated_at`。**一个任务最多一条联动**
  （通知卡不堆多个启动按钮）；重复 set 走 `ON CONFLICT(task_id) DO UPDATE` 覆盖。
- 命令三个（`commands/tasks.rs`，参数 camelCase，`lib.rs` 注册）：
  `task_reminder_link_get`（目标已删除返回 null，对上层等于未关联）、
  `task_reminder_link_set`（校验任务存在、kind 白名单、目标存在，任一不满足拒绝写入）、
  `task_reminder_link_clear`（幂等）。前端入口在任务上下文抽屉「提醒联动」区
  （`scenario_list` 全量 / `workspace_list(taskId)` 按任务过滤候选）。
- 通知载荷 additive：`NotifyItem` / `Popup` / `NotificationCardPayload` 新增
  `link_kind` / `link_target_id` / `link_label`（serde camelCase + `skip_serializing_if`），
  仅关联过且目标仍存在的提醒卡携带；合并摘要卡不带联动。稍后提醒往返
  （`Popup` ↔ `NotificationCardPayload`）保留三字段，snooze 后重新展示动作仍在。
- 调度器每 tick 按 `task_ids` **一次批量解析**（`resolve_reminder_links`，
  label 用相关子查询取目标当前名称，`label IS NULL ⇔ 目标已删除 → 不附加`），
  避免 N+1；沿用现有 1s tick 与通知管线，无新线程/无界队列。
- **安全语义：提醒触发绝不自动执行联动**——「进入场景 / 恢复现场」只由用户在
  通知卡显式点击触发（`scenario_enter` / `workspace_restore`），失败保留卡片并给
  `role=alert` 反馈；`workspace_restore` 返回 false（恢复进行中）如实提示可重试。
  与导航安全红线「任务提醒触发时不自动打开任何软件」一致。
- 删除清理（双保险之一）：`scenario_delete` / `workspace_delete` /
  `workspace_prune` 在同事务删除匹配联动；读取时再校验目标存在（双保险之二）；
  删除任务经外键级联。备份：登记 `BACKUP_TABLES`（class=core、restore_order=410、
  depends_on tasks/scenarios/workspace_snapshots）与 `EXTENDED_TABLES` +
  快速备份 SQL 白名单（全量保存）；完整/快速备份均包含，恢复逐行还原，
  旧备份缺该段按「缺表即跳过」。

## 四、安全设计

- 本地 HTTP 接入：仅绑 `127.0.0.1`；Bearer 令牌（首次启动随机生成，存本地设置）；
  请求体 ≤64KB；日志只记方法/路径/状态/对端/耗时，**绝不记录请求体**。
- 命令层全部做输入校验；跳转 Agent 会话使用白名单程序 + 受限字符参数，不经过 shell。
- 前端能力收敛：Tauri capability 仅授权必要权限（窗口控制/光标位置/通知/对话框等）。
- 无任何外网请求代码；不上传 Prompt、聊天内容、代码、密钥。
- 导航安全（v0.4）：
  - 跳转只读数据库中用户确认过的目标配置，执行前重新校验；前端只传目标 ID；
  - exe 必须绝对路径 + 存在 + 非解释器黑名单（cmd/PowerShell/wscript/cscript/mshta/rundll32 等）；
  - URL 仅 http/https（file:/javascript:/ms-settings: 等一律拒绝）；UWP AUMID 白名单字符集；
  - 全部走结构化进程 API（`Command::new` + args 数组），不拼接 shell 字符串；
  - Agent 事件携带的路径/命令属不可信数据，永不直接执行；恢复会话要求会话存在于本地观测库；
  - UWP 经 `explorer shell:AppsFolder` 启动；指定浏览器失败按偏好回退系统默认；
  - 工作区批量启动有数量上限（默认 8，设置可调 1~20）；
  - 任务提醒触发时不自动打开任何软件（无该自动化路径）。
- 剪贴板安全（v0.5）：
  - 纯本地；日志只记类型/大小/计数/原因，**绝不记录正文、完整图片、文件路径、密码/令牌**；
  - 尊重系统/密码管理器的排除标记；支持应用排除名单（按 exe basename 匹配）与全局暂停/停用；
  - 高置信敏感特征过滤默认开启；来源未知时额外启用保守凭据模式；明确不承诺识别全部密码
    （边界见 04 文档）；
  - 粘贴只由用户显式触发；进程级 `ACCESS_LOCK` 串行化本进程全部剪贴板访问，
    `OpenClipboard` 持锁期间比较内容后再写入；不匹配绝不覆盖；恢复仅在内容仍等于
    本任务最后写入时进行，用户中途复制的新内容不会被覆盖；
  - 逐项状态机区分“按键已发送”与“目标已确认”；无可靠信号时 `confirmed` 恒 0；
  - 自身写入的最终序列号在写入锁内原子登记，采集线程在同一把锁内复核，不产生自记录；
  - 采集有界（事件 64 / 内容 8 条 /128 MB），丢弃计数可查，不伪装零丢失；
  - Agent 导出只写本地文件，不调用网络、不写入 Agent 会话；直接发送明确标注不支持。
- 快速捕获安全（v0.7）：
  - 捕获内容只来自用户显式输入；不读剪贴板、不做后台采集，不采集密码/凭据；
  - 日志与错误信息只记录类型/计数/耗时，**绝不记录捕获正文**，校验错误不回显内容；
  - 无任何外网请求；草稿与捕获记录只存本地 SQLite，随备份策略处理；
  - 唤起前前台 HWND 只存进程内存、不落库；焦点恢复单次尽力，失败静默降级；
  - 捕获窗口 capability 仅 `core:default` + `core:event:default`，业务命令走自定义 IPC。

### v0.9 一键工作流（2026-11-04）

- 迁移 v23 新增四表：`workflows`（定义）→ `workflow_steps`（编排，`step_type`
  CHECK 白名单 + params JSON）→ `workflow_runs`（运行头，只存稳定态）→
  `workflow_run_steps`（逐步骤回执，含副作用前落库的 `operation_id`）。
  全部登记 `BACKUP_TABLES`（class=workflow；定义/步骤快速备份全量，运行/回执按
  最近 20 次截断）与 `EXTENDED_TABLES`（依赖序如上）。
- 步骤类型白名单：`open_app / open_url / open_path`（引用 `navigation_targets.id`，
  执行时由 router 重新校验目标）、`create_task`（复用 `create_task_inner`）、
  `restore_workspace`（显式选择快照，走统一恢复门禁）、`enter_scene`（场景工作区
  未集成，校验层拒绝执行，仅保留类型）。**无任意 Shell / PowerShell / 脚本执行面**；
  前端不能透传可执行路径，参数保存与执行双重校验。
- 执行引擎（`src-tauri/src/workflows/engine.rs`）：顺序执行；进程内全局单槽保证
  同一时刻最多一个工作流（槽锁内只做内存读写与建运行事务，无 IO/窗口操作）；
  暂停/取消经 `RunControl` 原子位 + Condvar，取消不强制终止系统操作；会抢焦点的
  步骤在工作现场恢复运行期间等待（有界 30s，超时如实失败）；单步 panic 由
  `catch_unwind` 隔离为步骤失败。进度经 `workflow-run-progress` 事件推送完整运行
  详情，前端不做轮询。
- 幂等与恢复：连续运行请求被槽拒绝；`operation_id` 在副作用前持久化；启动时把
  遗留 running/paused 运行标为 `interrupted`（running 步骤标 failed、pending 标
  cancelled），**绝不自动重放有副作用的步骤**。运行历史每工作流保留最近 50 条
  （`prune_runs` 只删运行记录，不碰定义）。
- 新命令 16 个（`commands/workflows.rs`，`workflow_*` 前缀），参数 camelCase；
  详细数据模型、状态机与接口边界见 [docs/workflows/README.md](workflows/README.md)。
- 前端编辑交互（2026-11-04）：工作流「新建/编辑」由 `Dialog lg` 改为**页面内编辑态**
  （`src/components/workflows/WorkflowEditorView.tsx`，列表在 `WorkflowsPanel.tsx` 内切换）。
  不新开窗口、不铺全局遮罩；操作按钮随内容流式排布、不使用固定底栏。2026-11-09 起列表页
  页头固定、列表独立滚动；编辑态由 `.workflows-panel.wf-editor-page` 自身滚动。「添加步骤」复用
  `Select/Popover` 锚定菜单；未保存返回为页内确认条。执行链路、数据模型与命令不变。

## 资源管理与智能清理（2026-11-06）

- 资源清理按 `ResourceCleanupSection → Bridge → Tauri command → ResourceCleanupState` 分层；类别固定为临时文件、TTS 缓存、无引用缩略图，不接受任意文件路径。
- TTS 操作复用 `AudioService` 缓存锁；剪贴板操作复用采集闸并检查活跃粘贴；缩略图引用复查在 SQLite `BEGIN IMMEDIATE` 事务内执行。Shelf producer、过期孤儿回收和资源清理共享一个写入/维护闸，避免文件先写入、数据库后登记时误删。
- 不变更数据库 schema、备份 manifest 或持久设置。资源快照与清理预览都按需执行；详细路径白名单、文件句柄验证、限制与剩余缺口见 [docs/RESOURCE_CLEANUP.md](RESOURCE_CLEANUP.md)。

## 诊断日志（diagnostics/，2026-11-06）

统一诊断日志基础设施：**本机 JSONL 持久化 + 有界队列 + 单写线程 + 轮转保留 + 异常聚合 +
脱敏报告导出**，完整技术说明见 [DIAGNOSTICS.md](DIAGNOSTICS.md)。

- `src-tauri/src/diagnostics/`：事件模型（`DiagnosticEvent`）、单写线程（追加/轮转/保留/
  聚合）、查询与摘要、字段白名单脱敏、`tracing` 桥接层。写入端唯一，读写线程分离。
- `src-tauri/src/commands/diagnostics.rs`：`diagnostics_record` / `diagnostics_status` /
  `diagnostics_set_mode` / `diagnostics_query` / `diagnostics_summary` / `diagnostics_export` /
  `diagnostics_clear` / `diagnostics_open_dir`。
- 启动顺序：`.setup()` 先确定数据目录 → 初始化诊断日志 → 挂载 `EnvFilter + fmt +
  DiagnosticsLayer` → 再创建窗口；退出在 `request_exit` 中先记录 `system/shutdown` 并
  `shutdown()` 写线程（刷出尾部与聚合摘要）。
- 前端：`src/lib/diagnostics.ts`（有界队列 + 批量 IPC + 错误归属去重 + `startOperation`）、
  `invokeCommand` 统一记录 IPC 失败、`ErrorBoundary`/`globalErrors` 记录渲染与未捕获异常。
- 界面分工：左侧独立「诊断中心」`DiagnosticsCenterPanel` 负责异常列表（默认 WARN+）、
  按 `operation_id` 的全级别操作链时间线、筛选、导出与带确认的清理；设置页
  `DiagnosticsLogsSection` 只保留状态/容量/详细模式开关/最近异常摘要与「打开诊断中心」，
  不再维护第二套事件列表。操作链查询必须关闭 `anomaliesOnly` 且不带级别/时间过滤。
- 噪声控制：HTTP 接入的 401 按 10s 窗口聚合为累计 WARN（`rejected_auth` 计数保留），
  非 401 请求降为 DEBUG；端口绑定失败只在首次与每 30 次（约 5 分钟）记录一次。
- 一致性校验：`update_settings` 写入后逐键回读（`settings/persist_verify`，只记键名），
  `src/lib/consistencyChecks.ts` 在设置首次加载后校验导航布局孤儿项（一次性，不轮询）。
- 诊断日志**不进入 SQLite**，也不替代工作流回执、备份 manifest、文件投递恢复记录等业务
  审计数据；清理只删诊断目录内的 JSONL 与导出报告。

## 手机配对与局域网连接（v0.16，2026-11-08）

- 分层：`src-tauri/src/mobile_sync/`（配对会话/令牌/设备表）→ `server.rs`（hyper，
  `/v1/health`、`/v1/pair`、`/v1/ping`，以及同步的 `/v1/changes`、`/v1/ops`）→
  `commands/mobile_sync.rs` → `src/lib/bridge.ts` → 左侧导航「手机互传」
  `MobileTransferPanel`（复用 `MobileSyncSection`）+ 全局 `MobilePairingDialog`。
  手机端为 `apps/mobile`（协议纯函数 + expo-camera 扫码 + SecureStore 令牌）。
- 配对入口：左侧导航「手机互传」，以及标题栏「配对新设备（手机）」快捷按钮（完整/紧凑模式）。
  v0.17 起从「设置 → 手机与同步」提到一级导航；设置页不再承载配对/文件列表。
  两处共用 App 根部唯一弹层实例（`src/lib/mobilePairing.ts` 管理开合）；服务未开启时弹层内
  可直接开启并生成配对码。
- 默认关闭：设置键 `mobile_sync_enabled=false` / `mobile_sync_port=47822`；只有显式开启后
  主管任务才绑定 `0.0.0.0:<port>`，关闭、端口变更或应用退出时监听循环在 2s 内退出。
- 配对：一次性 6 位码 + 120s TTL + 最多 5 次尝试；成功后签发 256 位令牌，SQLite
  `mobile_devices`（迁移 v42）只存 SHA-256 哈希；撤销写 `revoked_at`，令牌立即失效。
- 数据边界：配对轮只做配对与连通性探测，不传业务数据；同步在 v1/v1.1 单独实现（见下节），
  传输为局域网 HTTP + 应用层加密，威胁模型与 TLS 计划见
  [docs/mobile/06-pairing.md](mobile/06-pairing.md)、[docs/mobile/07-sync.md](mobile/07-sync.md)。
- 兼容性：新增表 `mobile_devices` 已登记 `BACKUP_TABLES` 并按设备本地瞬时状态处理（备份只写
  空 section，不迁移令牌哈希）；新增设置键带默认值，旧库/旧备份无需迁移。

## 手机同步（v1.1，2026-11-09）

- 分层：`mobile_sync/sync.rs`（加密信封、任务/笔记/收集箱映射、pull/push 数据层）→
  `server.rs`（`GET /v1/changes`、`POST /v1/ops`）→ SQLite v43/v44 `sync_changes` / `sync_ops`；
  手机端 `src/lib/sync/{crypto,client,engine}.ts` + `src/db/sync.ts` + schema v4/v5。
- 变更日志：v43 触发器覆盖 `tasks`，v44 追加 `notes`（entity=`note`）与
  `quick_capture_items`（entity=`capture`）的 INSERT/UPDATE/DELETE；`seq` 既是同步游标也是
  记录版本，DELETE 写墓碑；升级时回填任务、笔记与 `inbox` 收集箱基线。
  `sync_changes` / `sync_ops` 属于本机瞬时状态，备份只写空 section、恢复忽略。
- 传输：局域网 HTTP + 载荷加密（XSalsa20-Poly1305）。密钥由 `SHA-256(令牌)` 再做
  `SHA-512("taskdock-sync-v1:" + hash)[0..32]` 派生；信封 `{v,n,d}`，明文内嵌 AAD
  （方法 + 路径），跨端点重放解密失败；Bearer 鉴权与撤销语义不变。
- 语义：pull 应用服务端变更（本地有未发送 outbox 时跳过）；push 按「实体 + 记录」合并
  outbox，`base_rev` 与最新 `seq` 不一致返回冲突、不覆盖；`op_id` 幂等；push 后再 pull
  回填 `server_rev`。笔记正文映射为 `body`（桌面列名 `content`），收集箱 handled/converted
  在 pull 时映射为墓碑；手机端按条数/UTF-8 体积分批 push。冲突逐条选择「采用桌面端 / 保留本机」。
- 范围：任务、收集箱、笔记三种实体已同步。后台/自动同步、字段级合并、笔记的任务/工作现场
  关联同步、墓碑保留期清理未实现。详见 [docs/mobile/07-sync.md](mobile/07-sync.md)。

## 手机文件互传（v1，2026-11-09）

- 分层：`mobile_sync/files.rs`（记录、分块落盘、SHA-256、路径安全）→ `server.rs`
  （`GET/POST /v1/files`、`/v1/files/{id}/chunk/{index}`、`.../complete`、`.../delete`）→
  `commands/mobile_sync.rs`（offer/list/delete/reveal/open inbox）→ `bridge.ts` →
  左侧导航「手机互传」页 `MobileTransferPanel`；手机端 `src/lib/sync/{files,fileIo}.ts` +
  `FilesScreen`（入口：底部「设备」Tab → 文件互传）。
- 存储：`data_dir/mobile_files/{outbox,inbox,tmp}`；SQLite v45 `mobile_files`
  （本机瞬时状态，不进备份）。单文件 200MB、分块 192KB，完成时校验大小/分块数/SHA-256，
  原子改名到 `inbox/`；删除只允许 `mobile_files` 根目录内普通文件。
- 传输：与同步共用 Bearer 令牌与 XSalsa20-Poly1305 信封；分块 AAD 绑定文件 id 与序号，
  换文件/换序号/跨端点重放都会解密失败。`stored_path` 不下发给手机。
- 手机端使用 `expo-file-system` 58 的 `File.pickFileAsync`、SAF 目录授权、
  `FileHandle` 分块读写与 `File.preview`，不新增原生依赖；接收目录 URI 存 kv。
- 兼容性：新增表 `mobile_files` 已登记本机瞬时表；无新增设置键，旧库升级只追加迁移 v45。
  详见 [docs/mobile/08-file-transfer.md](mobile/08-file-transfer.md)。

