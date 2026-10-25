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
│  agents/           AI Agent 状态接入层                         │
│    · AgentHub     统一事件总线：校验→状态机→持久化→通知→广播     │
│    · Adapter      mock / file_drop / http_ingest（可扩展）      │
│    · codex.rs     Codex 生命周期钩子安装器                      │
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

### 5. 前端（src/）
- 三种显示模式对应三套视图；完整模式四标签页（任务/Agent/历史/设置）。
- 贴边吸附：轮询光标与窗口位置（220ms），靠近边缘且光标离开窗口才收起（留 6px 触发条），
  光标回边缘即展开；状态与窗口矩形持久化。
- 主题：CSS 变量 + `data-theme`，跟随系统时监听 `prefers-color-scheme`。

## 三、数据模型（SQLite）

```
tasks ──┬── recurrence_rules (1:0..1)
        ├── task_reminders (1:N，UNIQUE(task_id, occurrence))
        └── task_agent_links (1:N)

agent_sources (codex/qoder/workbuddy/mock …)
agent_sessions (UNIQUE(source_id, external_id))
agent_runs     (UNIQUE(source_id, external_run_id) WHERE NOT NULL)
agent_events   (流水，仅元数据)

task_categories · notification_history (UNIQUE(kind, ref_id, occurrence)) · application_settings
```

时间一律以 UTC ISO8601 字符串存储，展示层转本地时区。

## 四、安全设计

- 本地 HTTP 接入：仅绑 `127.0.0.1`；Bearer 令牌（首次启动随机生成，存本地设置）；
  请求体 ≤64KB；日志只记方法/路径/状态/对端/耗时，**绝不记录请求体**。
- 命令层全部做输入校验；跳转 Codex 会话使用白名单程序 + 受限字符参数，不经过 shell。
- 前端能力收敛：Tauri capability 仅授权必要权限（窗口控制/光标位置/通知/对话框等）。
- 无任何外网请求代码；不上传 Prompt、聊天内容、代码、密钥。
