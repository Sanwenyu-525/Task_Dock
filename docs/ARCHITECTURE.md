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
- 提交后副作用每批只执行一次：一次前端广播、一次托盘刷新、聚合系统通知
  （≤3 条弹窗 + 摘要），绝不放进事务。
- 过期清理：超过 `stale_run_minutes`（默认 15min）无更新的活跃轮次 → `disconnected`，**不推断任务成败**。
- 事件保留（`retention.rs`）：启动 20s 后运行一次、此后每 6 小时；默认保留 30 天或
  最多 20 万行，仅 `running`/`idle` 可清理，归档失败则中止删除。
- Adapter trait：`spawn(Box<Self>, Arc<AgentHub>)`，新增 Agent 只需新增一个 Adapter。
- 性能设计与边界见 [PERFORMANCE_ARCHITECTURE.md](PERFORMANCE_ARCHITECTURE.md)。

### 4. Adapter 清单
| Adapter | 机制 | 状态 |
|---|---|---|
| MockAdapter | 内置模拟会话（UI 明确标注「模拟」） | 已实现，默认开启 |
| FileDropAdapter | 轮询 `%APPDATA%/com.taskdock.desktop/agent-inbox/*.json`（大小/数量/重试上限） | 已实现，常开 |
| HttpIngestAdapter | 127.0.0.1 HTTP + Bearer + 并发/超时/64KB 上限 + 429/503 重试提示 | 已实现，可配置 |
| Codex 钩子 | 原生 Hook CLI（`task-dock --agent-hook`）+ HTTP 优先、文件兜底 | 已实现，需真实 Codex 环境验证 |
| DSH / OpenCode 插件 | 宿主插件桥接：有界队列、2.5s 超时、running 合并、指数退避 | 已实现，需对应宿主验证 |
| Qoder / WorkBuddy | 官方接口未核实 → stub 来源，通过通用接入上报 | 未验证（见 AGENT_ADAPTERS.md） |

### 5. 统一导航系统（navigation/，v0.4）
与 Agent 观测层完全解耦：agents/ 只产生事件，navigation/ 只负责「把用户送到正确的窗口/页面/会话」。

- `router.rs`：`navigate(db, app, target_id, options)` 唯一入口。按目标类型分发 L1~L4 动作；
  每次执行从数据库重读目标配置并**重新校验**（安装路径可能已失效）；结果携带
  `verification_level`（window-confirmed / process-spawned / launch-requested / delegated /
  requested-unverified）与 `fallback_used`，不允许把「进程已启动」报告成「窗口已确认」。
- `window_manager.rs`：EnumWindows 枚举可见顶层窗口（排除工具窗口与 UWP cloaked），
  `QueryFullProcessImageNameW` 关联进程身份；焦点控制「IsWindow 核验 → SW_RESTORE →
  SetForegroundWindow（被拒时 ALT 解锁重试一次）→ 前台句柄轮询核实」；被系统拒绝时
  返回准确原因。HWND/PID 只作运行时身份，绝不落库。枚举带 1.2s TTL 缓存。
- `app_discovery.rs`：开始菜单 .lnk（lnk crate 解析，catch_unwind 隔离畸形文件）+
  卸载注册表（winreg）+ UWP（Get-StartApps 单次调用、8s 超时）+ 常用软件路径探测。
  扫描带 5 分钟缓存；只扫明确位置，绝不全盘搜索；浏览器渲染进程等子进程不构成独立应用
  （窗口层只枚举顶层窗口，天然排除）。
- `target_resolver.rs`：`navigation_targets`（用户确认过的可信启动配置，按
  app_key+target_type 幂等去重）、`task_navigation_targets`（任务关联：display_order /
  is_default / launch_behavior，UNIQUE(task_id, target_id)）、`navigation_log`（执行流水）。
  与既有 `task_agent_links` 并存互补，旧表与历史数据不动。
- `agent_navigation.rs`：每个 Agent 的启动/唤醒/工作区/会话恢复能力全部**证据化**
  （exe-found / cli-help-probed / baseline-verified / unsupported-interface / not-installed）；
  无官方接口的 Agent 诚实降级为启动/唤醒并标注 fallback，不臆造 Deep Link。

### 6. 前端（src/）
- 三种显示模式对应三套视图；完整模式五标签页（任务/动作/Agent/历史/设置）。
- 刷新调度（v0.5）：`useAgentsStore` 单飞 + 节流（critical 100ms / normal 400ms）+
  脏标记追赶；窗口隐藏只置脏，恢复可见补一次；100 条事件不再触发 100 次全量快照。
- 历史面板：默认加载 100 条，`list_agent_events(before=...)` keyset 分页加载更早事件，
  刷新增量合并；新通知/事件 500ms 防抖刷新。
- 贴边吸附：轮询光标与窗口位置（220ms），靠近边缘且光标离开窗口才收起（留 6px 触发条），
  光标回边缘即展开；状态与窗口矩形持久化。
- 主题：CSS 变量 + `data-theme`，跟随系统时监听 `prefers-color-scheme`。
- 导航（v0.4）：`lib/navigation.ts` 类型化桥接 + `useNavigationStore`（扫描缓存/任务关联映射，
  运行状态按需刷新不轮询）；任务卡最多直列 3 个目标图标，其余折叠进快捷菜单（键盘可操作）；
  `AppPicker` 应用选择器（搜索/分类/当前窗口/手动登记）；`WorkspaceLauncher` 工作区
  顺序批量启动（可取消、部分成功明确）；设置页新增「应用与快捷方式」管理区。
  系统级窗口控制全部在 Rust 后端，React 不触碰 Win32。
- 智能剪贴板（v0.5）：标题栏唯一入口 + 内容区次级抽屉（不新增主标签页）；
  `useClipboardStore` 管理筛选/分页/多选，监听 `clipboard-changed` 合并刷新；
  列表 DTO 只含预览，完整正文/大图按需读取；所有粘贴与 Agent 导出均为显式操作。
  模块与边界见 [clipboard/02-architecture.md](clipboard/02-architecture.md)。
- 行动中心（v0.5）：`useActionsStore` 去抖单飞刷新（1200ms），事件批量到达只唤醒一次；
  `ActionCenterPanel` 提供 kind/来源/任务/优先级筛选、覆盖度披露、ack/unack、
  跳转 Agent 会话或任务上下文。
- 任务上下文抽屉（v0.5）：`TaskContextDrawer` 复用次级抽屉视觉，按需加载
  `task_context`；现场恢复进度订阅 `workspace-restore-progress`，与剪贴板抽屉互斥。
- 应用内快捷键：Ctrl+1…5 切换标签、Ctrl+K 快速添加、Ctrl+Shift+C 剪贴板；
  输入框内不拦截，窗口聚焦时生效。

### 7. 智能剪贴板（clipboard/，v0.5）
- `platform.rs` 是唯一的 Win32 层：`AddClipboardFormatListener` 消息窗口监听，
  读取 CF_UNICODETEXT / HTML Format / PNG / DIB / CF_HDROP，快照与恢复、
  `SendInput` Ctrl+V、系统敏感标记检查；非 Windows 为明确降级桩。
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

### 8. 行动中心（actions/，v0.5）
- `actions::feed` 是只读读模型：`agent_events`（近 7 天、最多 600 条）+ `agent_runs` +
  任务关联 + `notification_history` 提醒 → 合并为「需要人处理的动作」。
- 合并规则：同来源/会话/轮次/类型/消息且间隔 ≤10 分钟的事件合并计数，保留全部
  `event_ids` 供批量确认；`taskdock-selftest-*` 自测事件不进入行动中心。
- 分类与优先级：failed=P0、waiting=P1（含授权关键词时标记 `authorization` 且
  `authorization_inferred=true`）、disconnected/running=P2、completed=P3。
- 覆盖度：`enabled && transport_verified` 才算「监控中」，并给出 `live/stale/no-events/
  disabled/not-configured` 与一句话解释；不支持的状态不伪造。
- 确认：`action_acks(event_id)` 幂等持久化，提醒类同时标记已读；可撤销。
- 查询上限：单次扫描 600 条、返回 ≤300 条（默认 120）。

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

## 三、数据模型（SQLite）

```
tasks ──┬── recurrence_rules (1:0..1)
        ├── task_reminders (1:N，UNIQUE(task_id, occurrence))
        ├── task_agent_links (1:N，v0.1~0.3 Agent 会话关联，保留)
        └── task_navigation_targets (1:N，v0.4 通用目标关联)

agent_sources (codex/qoder/workbuddy/mock …)
agent_sessions (UNIQUE(source_id, external_id))
agent_runs     (UNIQUE(source_id, external_run_id) WHERE NOT NULL)
agent_events   (流水，仅元数据)

navigation_targets        （用户确认的目标；app_key+target_type 幂等去重）
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
