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
│  commands/        前端命令层（tasks / agents / settings /      │
│                   data / system）——输入校验、无业务泄漏          │
│        │                                                      │
│  db/               SQLite（rusqlite bundled）                  │
│    · 连接管理 · 版本迁移（PRAGMA user_version）· 设置存储        │
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
│  nlp.rs / recurrence.rs   中文自然语言解析 · 重复规则计算         │
│  lib.rs            窗口/托盘/热键/自启动装配                    │
└──────────────────────────────────────────────────────────────┘
```

设计原则：**UI、业务逻辑、存储、Agent Adapter 四层分离**。前端不直接访问数据库，
Agent 逻辑不写入 UI，Adapter 只产生事件、不感知存储。

## 二、模块职责

### 1. 数据层（db/）
- `Db`：`Mutex<Connection>` 封装，锁中毒时自动恢复（前次 panic 不阻塞后续操作）。
- 迁移机制：`MIGRATIONS` 数组按 `PRAGMA user_version` 顺序应用，新增版本只追加不修改。
- 设置存储：`application_settings` 键值表 + `Settings` 强类型视图（`#[serde(default)]` 兜底）。
- WAL 模式 + `busy_timeout`，外键约束开启。

### 2. 提醒调度（scheduler.rs）
- 独立 tokio 任务，**每秒按挂钟时间**比对 `task_reminders`，与前端窗口是否打开无关。
- 休眠/唤醒：不做定时器累加，每次 tick 重新查询「到期且未触发」，唤醒后自然补触发。
- 过期补偿：超过 `overdue_grace_hours`（默认 24h）的提醒只记历史不发通知，避免远古提醒轰炸。
- 去重：`UNIQUE(task_id, occurrence)` + `fired` 标志 + 通知历史唯一约束，三重保障。
- 重复推进：仅「截止」类提醒触发推进，删除旧未触发提醒并生成下一轮；**不改变任务完成状态**。

### 3. Agent 接入层（agents/）
- `AgentEvent`：统一事件（source_id / session_id / run_id / task_title / state / message / pending_items）。
- `AgentHub::ingest` 唯一入口，事务内完成：
  1. 校验（来源已注册且启用、ID 字符集、长度上限、时间格式）；
  2. 会话 upsert（`agent_sessions`，按 source+external_id 唯一）；
  3. 轮次状态机（`agent_runs`：running/waiting → completed/failed/disconnected，记 ended_at）；
  4. 事件流水（`agent_events`，仅元数据）；
  5. 状态跃迁通知（waiting/completed/failed，按 run+state+序号去重）；
  6. 前端广播 + 托盘图标/提示刷新。
- 过期清理：超过 `stale_run_minutes`（默认 15min）无更新的活跃轮次 → `disconnected`，**不推断任务成败**。
- Adapter trait：`spawn(Box<Self>, Arc<AgentHub>)`，新增 Agent 只需新增一个 Adapter。

### 4. Adapter 清单
| Adapter | 机制 | 状态 |
|---|---|---|
| MockAdapter | 内置模拟会话（UI 明确标注「模拟」） | 已实现，默认开启 |
| FileDropAdapter | 轮询 `%APPDATA%/com.taskdock.desktop/agent-inbox/*.json` | 已实现，常开 |
| HttpIngestAdapter | 127.0.0.1 HTTP 端点 + Bearer 令牌 + 64KB 上限 + 脱敏日志 | 已实现，可配置 |
| Codex 钩子 | 安装器写 `~/.codex/hooks.json` + PowerShell 上报脚本（HTTP 优先、文件兜底） | 已实现，需真实 Codex 环境验证 |
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
- 三种显示模式对应三套视图；完整模式四标签页（任务/Agent/历史/设置）。
- 贴边吸附：轮询光标与窗口位置（220ms），靠近边缘且光标离开窗口才收起（留 6px 触发条），
  光标回边缘即展开；状态与窗口矩形持久化。
- 主题：CSS 变量 + `data-theme`，跟随系统时监听 `prefers-color-scheme`。
- 导航（v0.4）：`lib/navigation.ts` 类型化桥接 + `useNavigationStore`（扫描缓存/任务关联映射，
  运行状态按需刷新不轮询）；任务卡最多直列 3 个目标图标，其余折叠进快捷菜单（键盘可操作）；
  `AppPicker` 应用选择器（搜索/分类/当前窗口/手动登记）；`WorkspaceLauncher` 工作区
  顺序批量启动（可取消、部分成功明确）；设置页新增「应用与快捷方式」管理区。
  系统级窗口控制全部在 Rust 后端，React 不触碰 Win32。

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

task_categories · notification_history (UNIQUE(kind, ref_id, occurrence)) · application_settings
```

时间一律以 UTC ISO8601 字符串存储，展示层转本地时区。

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
