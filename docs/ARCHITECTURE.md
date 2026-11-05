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
  ["tasks","inbox","clipboard","apps"]`，顶部状态球仍打开 Agent 面板
  （`CapsuleCategory = RailCategory | "agents"`）；收集箱 Lite 复用
  `quick_capture_list("inbox",8,0)` + `quick_capture_state`，事件刷新共用
  App 层既有的单条 `quick-capture-created` 监听。

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
  - 渲染异常由 `src/components/ErrorBoundary.tsx` 兜底（不白屏、用户点击才重试）；
    未处理 Promise rejection 由 `src/lib/globalErrors.ts` 兜底，同一根因 30s 内只提示一次。
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
  - 「内置路线图」：Task Dock 自身 28 项功能规划（`lib/featureCatalog.ts` 静态目录）
    经 `FeatureRoadmapPanel` 原样只读展示，不入库、不被用户项目编辑覆盖。
- 任务编辑交互（2026-11-04，模态清理第二批）：原 `TaskEditor.tsx`（`modal-mask` + Dialog）
  删除，改为 `src/components/tasks/TaskEditorView.tsx` 的**页面内编辑态**；`TasksPanel.tsx`
  在主内容区做列表 ↔ 编辑切换，与工作流/规划中心共用同一交互语言：
  - 不新开窗口、不铺全局遮罩、无固定底栏；滚动沿用 `.tab-content` 单一容器（面板解除自身
    `overflow`），操作区随内容流式排布。
  - 返回列表恢复列表滚动位置（列表可见时记录 `scrollTop`，退出编辑后 `requestAnimationFrame`
    回写）；筛选状态本就在 `useTasksStore.filter`，切换不丢失。
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
  `has_window/process_only` 才算运行中，`unavailable` 表示配置失效，不作推断。
- 应用搜索与图标（v0.11）：`lib/appSearch.ts` 统一搜索（中文连续子串、英文大小写不敏感、
  身份绑定别名、完全匹配 → 前缀 → 包含 → 别名排序）；选择器搜索「已发现集合」，
  应用中心/胶囊搜索「已配置集合」。`components/ui/AppIcon.tsx` 按需异步取真实 Windows 图标
  （扫描先出文字、图标补充，失败统一回退字母，不阻塞选择）。`AppPicker` 新增
  `variant="page"`：工具面板/应用管理/设置页的「添加应用」改为内容区子页面（返回、搜索、
  分类横向滚动、多选批量添加、手动添加、当前窗口选择均在同一页面内切换），任务关联场景仍用
  模态选择器。
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
  同一处的后续真机反馈（松手后光标回退成普通箭头）根因在**光标层**：系统模态缩放循环退出后
  Windows 重设默认光标，指针静止时不再派发 `WM_SETCURSOR`，WebView2 的 CSS `cursor` 没有机会重新
  生效。修复：`window_cursor.rs` 在 `WM_EXITSIZEMOVE` 后延后一拍（`PostMessageW`）按
  `GetDpiForWindow` 折算的 12 CSS px 热区补 `SetCursor(IDC_SIZENWSE/IDC_SIZENESW)`，并在
  `WM_SETCURSOR(HTCLIENT)` 兜底；改写前用 `WindowFromPoint` 校验像素归属（圆角区域外的角点属于
  下层窗口，不越权改写）。热区边长 12 CSS px 是前端 `.resize-grip` 与 `window_cursor::GRIP_CSS`
  的跨端契约，两端单测锁定。证据见 `tmp/acceptance/window-corner-resize/report.md`。
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
  （轨道 56×300、面板 336×420、间隙 8）。
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
  - 构建溯源（2026-11-05）：`build.rs` 注入 `TASK_DOCK_GIT_COMMIT` / `TASK_DOCK_BUILD_TIME`，
    `performance_diagnostics` 在 `build` 段返回 commit、构建时间（Unix 秒）、debug/release
    profile 与当前 exe 路径；不新增依赖、不写用户路径到公开日志。

### 11. 快速捕获（quick_capture/，v0.7）

任意界面按 `Ctrl+Shift+Space` 打开独立的常驻捕获窗口，主窗口不展开；提交后内容按类型进入任务
或临时收集箱。窗口与命令在 `src-tauri/src/quick_capture/mod.rs`，数据与校验在 `store.rs`；
前端窗口在 `capture.html` + `src/capture/`，收集箱面板在 `src/components/inbox/` +
`src/store/useCaptureStore.ts`。

**静态窗口**（`src-tauri/tauri.conf.json`，全部 `decorations=false`、`transparent=true`、
`shadow=false`、`alwaysOnTop=true`、`skipTaskbar=true`、默认 `visible=false`；详细能力见
`src-tauri/capabilities/`）：

| 窗口 | 用途 | 尺寸（逻辑像素） | 关闭语义 |
|---|---|---|---|
| `main` | 任务栏主窗（极简/紧凑/完整） | 400×560，可缩放 | 隐藏，可贴边吸附/胶囊区域 |
| `context-menu` | 托盘/右键菜单 | 250×620，固定 | 失焦隐藏 |
| `notification` | 桌面通知 | 400×400，固定 | 隐藏后复用 |
| `capture` | 快速捕获（v0.7） | 640×360，固定、不占任务栏 | `prevent_close` + hide 复用同一 WebView |

捕获窗口 capability 仅 `core:default` + `core:event:default`
（`src-tauri/capabilities/capture.json`），业务调用走自定义命令，不在窗口内直接调 Tauri
window API。

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
正文，错误不拼接内容；无任何外网请求。功能与用户说明见
[quick-capture/README.md](quick-capture/README.md)。

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
（当前 43 张；v0.7 规划、v0.8 货架/工作流、v0.9 笔记/专注/任务完成事件均在同一注册表中
登记）、恢复顺序与外键依赖；`EXTENDED_TABLES` 标记剪贴板、工作现场与行动中心等
v0.5 扩展表。新增迁移表若未登记，`backup_registry_covers_every_schema_table` 会直接失败，
防止“新模块数据从未进入备份却无人发现”。

**完整与快速备份**：

- full：全量业务表 + 事件归档 JSONL + 全部剪贴板原图/缩略图；不静默截断。
- quick：事件最近 20000 行 + 全部 running/waiting 保护行，通知 500、导航流水 500、
  剪贴板条目 2000、粘贴作业 500；header 记录数据库总量、`partial=true`、
  `partial_reasons` 与 `truncated_tables`。快速备份不打包事件归档，并只打包被导出条目
  引用的资产，避免恢复出“有数据库行、无图片文件”的半套数据。
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
  不新开窗口、不铺全局遮罩；滚动沿用 `.tab-content` 单一容器（编辑态解除列表面板自身
  `overflow`），操作按钮随内容流式排布、不使用固定底栏。「添加步骤」复用
  `Select/Popover` 锚定菜单；未保存返回为页内确认条。执行链路、数据模型与命令不变。
