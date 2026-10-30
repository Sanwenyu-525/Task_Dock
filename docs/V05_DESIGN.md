# Task Dock v0.5 设计与技术方案

> 状态：实施前基线（先设计、后编码）。本文档同时是数据模型、事件协议与性能预算的权威来源。
> 适用代码基线：v0.4.0（commit e31cc91 + 工作区中的 v0.5 剪贴板后端雏形）。

## 1. 目标与边界

v0.5 在**不破坏 v0.4 任务、提醒、Agent 监控、统一导航**的前提下，增加三个可独立启停的模块，
并用统一任务上下文把它们连起来：

| 模块 | 目标 | 明确不做 |
|---|---|---|
| A 工作现场恢复 | 把窗口/应用/项目/文件/网址保存为快照，按任务或手动恢复；优先复用已有窗口 | 不读取窗口内容、不采集剪贴板正文、不伪造"标签页已恢复" |
| B Agent 行动中心 | 汇总运行/完成/失败/等待输入/需授权事件；筛选、去重合并、跳转、显式降级 | 不臆造 Agent 能力、不为未接入来源伪造"监控中" |
| C 智能剪贴板 | 文字/截图/文件/网址历史，连续截图分组，绑定任务或现场，整组复制/逐项粘贴 | 不上传任何内容、不监听排除应用、不做无上限历史 |

统一上下文：`任务 ↔ Agent ↔ 应用窗口 ↔ 工作现场 ↔ 剪贴板素材 ↔ 事件` 的聚合读模型。
三个模块的存储互不依赖，可单独关闭（设置项或功能开关），关闭后其余模块与既有功能照常工作。

## 2. 复用清单（禁止重复造轮子）

- **窗口/应用动作**：一律走 `navigation::router::navigate` 与 `window_manager`，复用 L1~L4、
  验证级别、焦点重试、exe/URL/AUMID 校验、窗口身份（类名+标题+exe，HWND/PID 不落库）。
- **Agent 事件**：复用 `AgentHub::ingest_core`（校验→状态机→去重→通知→广播），新增的只是
  **接入队列**与**聚合读模型**，不另建事件表。
- **通知/提醒**：复用 `notification_history` 与 `task_reminders`。
- **剪贴板**：复用工作区中已有的 `clipboard::{engine,image,store,platform,paste,agent_bridge}`
  与全部 `clipboard_*` 命令；本次补齐编译、测试、前端与"绑定工作现场"。
- **任务关联**：复用 `task_navigation_targets`、`task_agent_links`、`clipboard_task_links`。
- **UI 结构**：复用 `FullView` 标签页、`WorkspaceLauncher` 弹窗、`modal/.seg-group/.filter-bar`
  设计语言、`useNavigationStore` 缓存、`App.tsx` 事件订阅清理模式。

## 3. 总体架构

```
React（src/）
  App.tsx ── 单一事件订阅入口（agent-changed / notification / clipboard-changed）
    │          └─ 去抖 250ms → 对应 store 刷新（渲染与事件解耦）
    ├─ useActionsStore ── ActionCenterPanel（行动 / 历史两个子视图）
    ├─ useClipboardStore ── ClipboardPanel（历史 / 分组）
    ├─ useWorkspaceStore ── WorkspacePanel（快照列表/捕获/恢复结果）
    └─ TaskContextCard ── 任务上下文聚合卡片（任务编辑器内）
        │  invoke / listen（Tauri IPC）
Rust（src-tauri/src/）
  commands/（薄命令层，只做参数校验与状态获取）
    actions.rs · workspace.rs · context.rs · clipboard.rs(已有) · agents.rs(已有)
        │
  actions/          行动中心读模型（只读聚合 + ack）
  workspace/        快照存储、捕获、恢复（调用 navigation）
  agents/pipeline.rs 有界接入队列（背压/去重/批提交/单次广播）
  agents/retention.rs 事件/通知/导航日志保留上限（防膨胀）
  navigation/       既有导航（不改语义，仅复用）
  clipboard/        既有剪贴板（补 snapshot 关联与测试）
        │
  SQLite（单一连接，WAL；所有新表走追加迁移 v9）
```

**松耦合约束**：

- 行动中心只读 `agent_events/agent_runs/tasks/task_*_links/action_acks`，不写 Agent 状态。
- 工作现场只写 `workspace_*`，动作执行调用 `navigation`，不直接 Win32 操作窗口。
- 剪贴板只写 `clipboard_*`，不依赖行动中心；绑定现场只写关联表。
- 上下文聚合只读，不缓存正文，不产生副作用。

## 4. 统一任务上下文

### 4.1 读模型

`task_context(task_id)` 返回：

```jsonc
{
  "task": { /* 既有 Task */ },
  "counts": { "agents": 2, "targets": 4, "snapshots": 1, "clipboard_items": 6, "clipboard_groups": 2, "events": 5 },
  "agents":   [{ "source_id": "codex", "source_name": "Codex", "session_external_id": "s-1",
                 "run_status": "waiting", "task_title": "重构登录", "last_seen_at": "…", "available": true }],
  "targets":  [{ /* TaskNavLink（含 target 与运行状态） */ }],
  "snapshots":[{ "id": "…", "name": "登录模块现场", "item_count": 3, "updated_at": "…", "last_restored_at": null }],
  "clipboard":{ "items": [ /* 预览级 ClipboardItem */ ], "groups": [ /* ClipboardGroup 摘要 */ ],
                "links": [ /* ClipboardTaskLink */ ] },
  "events":   [ /* 最近 10 条 ActionItem（聚合后） */ ]
}
```

**关联规则（与 v0.4 完全兼容）**：

| 关系 | 来源 | 去重规则 |
|---|---|---|
| 任务→Agent | `task_agent_links` ∪ `task_navigation_targets`(agent_session) | 按 `(source_id, session_external_id)` |
| 任务→窗口/应用/文件/网址 | `task_navigation_targets` | 既有 `UNIQUE(task_id,target_id)` |
| 任务→现场 | `workspace_snapshots.task_id` | 快照各自独立 |
| 任务→素材 | `clipboard_task_links`(target_type=item/group) | 既有 UNIQUE |
| 现场→素材 | `clipboard_snapshot_links` | `UNIQUE(snapshot_id,target_type,target_id)` |
| 事件→任务 | 通过 Agent 会话映射 | 一个会话可属多个任务时取"未完成优先、最近更新" |

不新建"大而全"的关联表；所有关系均由既有/新增的**窄表**表达，聚合在读取时完成。

### 4.2 Agent 会话映射

会话键统一为 `(source_id, session_external_id)`。事件表本来就存这两个字段，因此无需额外索引表：

```sql
SELECT l.source_id, l.session_external_id, t.id, t.title, t.category, t.status, t.updated_at
FROM task_agent_links l JOIN tasks t ON t.id = l.task_id
UNION
SELECT n.agent_source_id, n.agent_session_id, t.id, t.title, t.category, t.status, t.updated_at
FROM task_navigation_targets nl
JOIN navigation_targets n ON n.id = nl.target_id
JOIN tasks t ON t.id = nl.task_id
WHERE n.target_type = 'agent_session';
```

## 5. 模块 A：工作现场

### 5.1 数据模型（迁移 v9）

```sql
CREATE TABLE workspace_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, -- 删任务不销毁现场，降级为手动快照
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('manual','task')),
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_restored_at TEXT,
  restore_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workspace_snapshot_items (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('application','url','file','directory','agent_session')),
  display_name TEXT NOT NULL,
  target_id TEXT,              -- 可复用的导航目标（目标被删除后为 NULL，靠下方身份字段重建）
  app_key TEXT NOT NULL DEFAULT '',
  exe_path TEXT NOT NULL DEFAULT '',
  launch_args TEXT NOT NULL DEFAULT '',
  working_dir TEXT NOT NULL DEFAULT '',
  app_user_model_id TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  agent_source_id TEXT NOT NULL DEFAULT '',
  agent_session_id TEXT NOT NULL DEFAULT '',
  window_title_hint TEXT NOT NULL DEFAULT '',
  window_class TEXT NOT NULL DEFAULT '',   -- 窗口身份（类名+标题+exe），不存 HWND/PID
  window_title TEXT NOT NULL DEFAULT '',
  restore_note TEXT NOT NULL DEFAULT '',   -- 如实说明恢复边界（如"浏览器标签页内容不恢复"）
  last_result TEXT NOT NULL DEFAULT '',
  last_verification TEXT NOT NULL DEFAULT '',
  last_restored_at TEXT
);
```

上限：单快照 ≤ 30 项；保留最新 100 个快照（超出按 `updated_at` 清理最旧且未被任务引用的）。
恢复参数：项间间隔默认 350ms（避免抢前台），可取消。

### 5.2 捕获

入口：

1. 任务编辑器「工作现场」：把任务已关联目标一键存为快照（`source=task`）。
2. 任务面板/现场面板：枚举当前可见窗口，用户勾选后保存（`source=manual`，可绑定任务）。
3. 恢复失败/成功结果写回 `last_result/last_verification`，不做"恢复成功"的虚假断言。

隐私：只读取窗口标题、类名、进程 exe 路径与用户显式登记的文件/网址；**不读取窗口内文本、
不读取剪贴板正文、不截图**。窗口标题可能含文档名，属于用户可见的元数据，在 UI 中明确说明。

### 5.3 恢复算法（逐项）

```
for item in order:
  1. 完整性预检：文件/目录不存在 → skipped（reason=路径不存在）
  2. 若为 application：
     a. 枚举顶层窗口；存在 class+title(+exe) 精确匹配 → focus_window
        → verification=window-confirmed, fallback=false
     b. 同 exe 窗口存在（标题已变化）→ focus 该窗口
        → verification=window-confirmed, fallback=true（"按进程复用"）
     c. 无窗口 → 确保存在 navigation_target（按 app_key/类型幂等保存）→ navigate(open_app)
        → verification=process-spawned / launch-requested（按后端证据）
  3. url → navigate(open)；verification=delegated（浏览器接管，标签页不可验证）
  4. file → 存在则 navigate(open)；verification=launch-requested（默认程序接管）
  5. directory → navigate(open_directory)；verification=window-confirmed（资源管理器可核验）
  6. agent_session → 会话必须存在于本地观测库，否则 skipped；navigate(resume_session)
     → 按 agent_navigation 证据降级（window-confirmed / process-spawned / delegated）
  7. 任意异常 → failed（保留原因），继续下一项
```

恢复是**顺序可取消**的：每项之间检查取消标志，已执行的动作不可撤回；返回值包含
`total/succeeded/failed/skipped/cancelled` 与每项 `verification_level/fallback/reason`。
前端显示"已验证/已启动/已委托/跳过/失败"，不把"已发出启动请求"画成"窗口已恢复"。

## 6. 模块 B：Agent 行动中心

### 6.1 接入管线（有界、背压、去重、批量）

```
HTTP/文件/插件 ──try_send──▶ bounded channel(1024) ──▶ worker（合并窗口 250ms / 单批≤100）
                                                          │
                                              去重（event_id / 批内相同签名）
                                                          │
                                          AgentHub::commit_events（单事务）
                                                          │
                                   after_batch：最多 3 条 OS 通知 + 1 次 agent-changed + 1 次托盘
```

- **有界**：队列默认 1024（设置可调 16~65536）；满时 `try_send` 失败：
  - HTTP：返回 `503/429` + `Retry-After`（调用方可重试，不静默丢失）；
  - 文件投递：文件留在 inbox，下一轮扫描重试；
  - Mock/调试：保持同步 `ingest`（低频、确定性测试）。
- **去重**：数据库 `dedupe_key` 仍是最终幂等保障；管线内对**非终态**相同
  `(source,session,run,state,message)` 在批内只保留最后一条并计数，终态事件绝不合并。
- **批量状态更新**：一次提交只发一次 `agent-changed`（已有 `after_batch`）；前端再次去抖，
  把 N 次事件压缩为 1 次快照/行动列表刷新。
- **队列统计**：`pipeline_stats` 命令返回 `batches/events_received/events_processed/
  events_merged/events_sampled/overload_rejects/commit_failures/queue_depth_*/
  ingest_latency/db_write_latency/max_batch/last_flush_at`，供设置页诊断与性能验收。
- **背压可视化**：队列使用率 > 80% 时 UI 状态点变黄并提示"事件积压，已拒绝新事件"。

### 6.2 聚合读模型

数据来源（只读）：
`agent_events`（最近 7 天，最多 600 行）→ 合并 → 映射任务 → 过滤 → 返回最多 300 条。

| kind | 判定 | 优先级 |
|---|---|---|
| `failed` | state=failed | P0 |
| `authorization` | state=waiting 且消息/待办命中授权关键词（标注"推断"） | P1 |
| `waiting_input` | state=waiting | P1 |
| `running` | state=running | P2 |
| `completed` | state=completed | P3 |
| `disconnected` | state=disconnected | P2 |
| `reminder` | `notification_history.kind='reminder'` 未读 | P1 |

去重合并：相邻（按时间倒序）且 `(source,session,run,kind,message)` 相同、间隔 ≤ 10 分钟
→ 一条，`count` 累加，`event_ids` 保留全部（用于"已处理"批量 ack）。稳定 key 取首条事件 id。

"已处理"持久化：`action_acks(event_id)`；列表返回 `acked`（合并项全部 ack 才为 true）。
"全部历史"继续复用 `HistoryPanel`（通知 + 原始事件流水），不丢失既有能力。

### 6.3 显式降级与监控覆盖

- `coverage[]` 按来源列出：`enabled`、`monitored = enabled && transport_verified`、
  `last_event_at`、`level`（live/stale/no-events/disabled/not-configured）。
- 未接入/未验证的来源显示"未接入（仅发现）"，**不显示运行状态、不生成事件**。
- 跳转按钮附带 `AgentNavCapabilities`（复用于 navigation，5 分钟缓存）；不支持会话恢复的
  Agent 显示"仅启动/唤醒"并给出 reason，不伪造 Deep Link。
- 授权关键词只做**提示**，不是权限系统：`authorization_inferred=true` 且 UI 标注"推断"。

## 7. 模块 C：智能剪贴板（补齐）

后端已存在（工作区未提交），本阶段只补：

- 编译修复（缺失的 pipeline 等）与单元/压力测试；
- 绑定**工作现场**：`clipboard_snapshot_links` + `clipboard_link_snapshot/unlink/links`；
- 前端：历史/分组、搜索、类型筛选、缩略图懒加载、分组详情、拆分/合并、整组富文本/文件复制、
  逐项粘贴（目标窗口预检、进度、取消/恢复、失败剩余项）、绑定任务/现场、暂停监听、清理；
- 设置页新增剪贴板区（监听开关/暂停/截图分组/保留天数/条目与存储上限/排除应用/敏感过滤）；
- 隐私：排除应用名单、敏感内容过滤、本地存储、无网络上传；`clipboard_status` 显示监听是否真的可用。

素材绑定：绑定到任务或现场只写关联表，不复制内容；删除任务/现场级联删关联，素材保留。

## 8. 性能与稳定性设计

### 8.1 强制约束

| 资源 | 上限 | 执行点 |
|---|---|---|
| Agent 接入队列 | 1024 条（可配置） | `pipeline` |
| 单批提交 | 100 条 / 250ms 合并窗口（可配置） | `pipeline` |
| `agent_events` | running/idle 默认 200,000 行或 30 天；清理前归档，关键状态永不自动删 | `retention` |
| `notification_history` | 不自动裁剪；界面/导出最多 500 条，提供手动清空 | 查询上限 |
| `navigation_log` | 手动清理（默认保留最近 200 条），诊断导出截断 | `nav_prune_logs` |
| 动作中心单次查询 | 600 行，返回 ≤300 | `actions` |
| 剪贴板条目 | 设置默认 1000（收藏/置顶不参与计数裁剪） | 既有 `clipboard::cleanup` |
| 剪贴板资产 | 设置默认 512MB | 同上 |
| 工作现场 | 单快照 30 项；全局 100 个 | `workspace` |
| 前端事件刷新 | Agent 100/400ms 节流 + 单飞；动作中心 1200ms 去抖；剪贴板 300ms 合并 | stores / panels |

### 8.2 性能预算（实测评判）

| 场景 | 预算 | 测量方式 |
|---|---|---|
| 管线吞吐（持续 running 心跳 + 关键事件） | ≥ 1000 事件/秒，队列不超容量 | `tests/ingest_perf.rs`（ignore，release） |
| 单批事件落库（≤100 条） | p95 ≤ 150ms | `pipeline_stats.db_write_latency` |
| 行动中心查询（600 事件 + 映射） | p95 ≤ 60ms | `tests/actions_perf.rs`（ignore，release） |
| 剪贴板 300 条历史（含 100 图）列表 | ≤ 120ms | `tests/clipboard_perf.rs`（ignore，release） |
| 连续截图 200 张入库+分组+配额 | ≤ 8s，磁盘占用 ≤ 配额 | `tests/clipboard_perf.rs` 压力段 |
| 前端 300 行任务列表全量重渲染 | 提交 p50 ≤ 100ms | `scripts/render-perf.mjs`（真实 Chromium） |

预算不达标必须调整实现或下调承诺，文档记录实测值，不以"已优化"代替数据。
2026-10-29 实测结果（含运行环境、未完成项与 1080p 截图采集编码成本）见
[PERFORMANCE_ACCEPTANCE_REPORT.md](PERFORMANCE_ACCEPTANCE_REPORT.md)。

### 8.3 稳定性

- 所有事件订阅在 `useEffect` cleanup 中解除；组件卸载后不再 setState。
- 管线 worker 在应用退出时随进程结束；无 detached 无限线程（单一 worker）。
- 数据库迁移原子化（既有 `apply_migrations`）。
- 剪贴板监听失败只降级，不阻塞启动（既有）。
- 工作现场恢复每项独立 try/catch，单项失败不阻断。
- 不新增全局轮询；保留 1s 提醒调度与 30s 失联清理（既有低频），剪贴板维护 5 分钟。

## 9. 事件协议（Tauri → 前端）

| 事件 | 载荷 | 发送方 | 前端处理 |
|---|---|---|---|
| `agent-changed` | 既有字段 + `batch/states/late` | `AgentHub::after_batch` | 去抖后刷新 Agent 快照 + 行动中心 |
| `notification` | `()` | AgentHub | 去抖后刷新通知/任务统计 |
| `clipboard-changed` | `{kind}` | clipboard runtime | 去抖后刷新剪贴板视图（仅面板挂载时） |
| `clipboard-paste` | 进度（既有） | paste | 分组粘贴进度 |
| `workspace-restore-progress` | `{snapshot_id,index,total,item_id,phase,result?}` | workspace restore | 进度列表 |
| `app-ready` / `reminder-fired` | 既有 | 既有 | 既有 |

所有事件只传**元数据**，不传剪贴板正文、不传窗口内容、不传文件内容。

## 10. 隐私与权限

- 本地数据库 + 本地文件资产目录 `%APPDATA%/com.taskdock.desktop/clipboard`；
  无外网请求；不采集窗口内容；不上传任何剪贴板正文。
- 剪贴板排除应用（默认密码管理器）、暂停监听、敏感内容过滤（PEM 私钥等高置信模式）、
  自动清理；日志只记类型/大小/计数，不记正文。
- Agent HTTP 接入仅 127.0.0.1 + Bearer 令牌（既有）。
- 工作现场恢复只执行用户确认过的目标；URL 仅 http(s)；exe 白名单校验；不经过 shell。
- Windows 权限：普通用户权限即可完成剪贴板监听与窗口操作；**不以管理员权限运行**；
  目标窗口以管理员运行时，UIPI 可能阻止模拟 Ctrl+V → 逐项粘贴会如实报告失败并提供
  "复制到剪贴板手动粘贴"的备用方案（不谎报成功）。
- 跨平台：窗口枚举/焦点/剪贴板模拟按键为 Windows 实现；其他平台编译时以显式错误降级，
  UI 标注"当前平台不支持"，不提供假按钮。

## 11. 测试计划

### 11.1 Rust

- 迁移 v8→v9：新表存在、旧数据不变、`foreign_key_check` 0 违规。
- 管线：容量 512、满时拒绝、合并窗口、批内去重、终态不合并、单次提交回调。
- 保留策略：插入 6000 条事件 → 裁剪到 5000；通知/导航日志同理。
- 行动中心：合并计数、ack、过滤（kind/source/task/project/priority）、任务映射、覆盖率。
- 工作现场：捕获去重/上限、恢复（窗口复用/文件缺失/应用未安装/取消）、快照任务绑定与级联。
- 剪贴板：engine 分类/敏感/PEM、store 去重/自动分组/拆分合并/配额/保留、图片缩略图。
- 性能（`#[ignore]`）：管线 throughput/过载/故障/长稳（`ingest_perf`）、600 事件行动查询（`actions_perf`）、
  剪贴板批量入库与 200 张截图（`clipboard_perf`）；前端渲染用 Playwright 采样（`render-perf.mjs`）。

### 11.2 前端（Vitest + jsdom）

- 去抖刷新 store：多次事件只发一次请求；卸载后不再刷新。
- 行动中心：kind 筛选、合并项展开、ack 调用、空态/降级提示。
- 剪贴板：列表渲染、类型筛选、分组详情、复制调用、绑定任务。
- 工作现场：捕获选择、恢复进度、失败项展示。
- 保持既有 88 项测试全绿。

### 11.3 视觉/真机

- `npm run build` + `scripts/make-preview.mjs` 扩展新 fixtures → Playwright 320/400 宽截图，
  检查横向溢出、标签页可达、深色/毛玻璃。
- 真机（Windows）验证：剪贴板监听、截图分组、整组复制粘贴（含 UIPI 失败提示）、
  窗口复用与关闭后恢复、Agent Mock 场景 → 行动中心。

## 12. 实施顺序

1. 修复后端编译（pipeline）→ 基线 `cargo test`。
2. v9 迁移 + retention + 管线测试。
3. 行动中心读模型 + 命令 + 测试。
4. 工作现场存储/捕获/恢复 + 命令 + 测试。
5. 剪贴板绑定现场 + 后端测试/压力测试。
6. 统一上下文命令 + 测试。
7. 前端桥接/Store/组件/样式 + 单测。
8. 预览截图 + 真机验证 + 性能报告。
9. 文档（产品/架构/协议/隐私/性能/使用/维护）。

## 13. 已知风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Agent 事件突发 | UI 卡顿/DB 争锁 | 有界队列 + 批提交 + 前端去抖 |
| 剪贴板大图 | 内存峰值 | 解码前 64MB 上限、缩略图 192px、列表只给预览、图片按需 data URL |
| 连续截图分组误判 | 素材混组 | 45s 窗口 + 手动拆分/合并 + 分组上限 300 |
| 窗口恢复抢前台 | 用户操作被打断 | 顺序 350ms 间隔 + 可取消 + 失败继续 |
| 浏览器标签页不可恢复 | 期望落差 | 捕获时写明限制，恢复结果显示"已委托" |
| 管理员窗口 UIPI | 自动粘贴失败 | 预检 + 明确失败 + 手动复制备用方案 |
| 未接入 Agent 被误解为"监控中" | 虚假安全感 | coverage + 显式"未接入"标签，无事件不生成状态 |
