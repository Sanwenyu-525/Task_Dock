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
- **通知限频（v0.5）**：一个 tick 内到期的提醒**不再逐条弹系统通知**——本轮全部到期项先收集起来，
  一次性交给 `AgentHub::notify_reminder_popups`，与 Agent 事件共用**同一个** `NotifyGate`
  窗口预算（跨批次生效）；多条提醒合并为一条「任务提醒汇总」，
  等待/失败类通知优先占用额度；UI 广播也合并为一条 `reminder-fired`（携带 `task_ids`）。
  `notify_reminder` / `notify_muted` 开关对提醒与 Agent 通知分别生效。

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
  `QueryFullProcessImageNameW` 关联进程身份；焦点控制「IsWindow 核验 → SW_RESTORE →
  SetForegroundWindow（被拒时 ALT 解锁重试一次）→ 前台句柄轮询核实」；被系统拒绝时
  返回准确原因。HWND/PID 只作运行时身份，绝不落库。枚举带 1.2s TTL 缓存。
- `app_discovery.rs`：开始菜单 .lnk（lnk crate 解析，catch_unwind 隔离畸形文件）+
  卸载注册表（winreg）+ UWP（Get-StartApps 单次调用、8s 超时）+ 常用软件路径探测。
  扫描带 5 分钟缓存；只扫明确位置，绝不全盘搜索；浏览器渲染进程等子进程不构成独立应用
  （窗口层只枚举顶层窗口，天然排除）。
- 控制台工具（`tasklist`/`reg`/`where`/`powershell`/opencode 探测）统一经
  `winproc::hidden()` 启动并设置 `CREATE_NO_WINDOW`：Release 为 `windows` 子系统，
  不隐藏控制台会在每次 Agent/应用扫描时闪出终端窗口。
- `target_resolver.rs`：`navigation_targets`（用户确认过的可信启动配置，按
  app_key+target_type 幂等去重）、`task_navigation_targets`（任务关联：display_order /
  is_default / launch_behavior，UNIQUE(task_id, target_id)）、`navigation_log`（执行流水）。
  与既有 `task_agent_links` 并存互补，旧表与历史数据不动。
- `agent_navigation.rs`：每个 Agent 的启动/唤醒/工作区/会话恢复能力全部**证据化**
  （exe-found / cli-help-probed / baseline-verified / unsupported-interface / not-installed）；
  无官方接口的 Agent 诚实降级为启动/唤醒并标注 fallback，不臆造 Deep Link。

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
- 历史面板：默认加载 100 条，`list_agent_events(before=...)` keyset 分页加载更早事件，
  刷新增量合并；新通知/事件 500ms 防抖刷新。
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
- 主题：CSS 变量 + `data-theme`，跟随系统时监听 `prefers-color-scheme`。
- 导航（v0.4）：`lib/navigation.ts` 类型化桥接 + `useNavigationStore`（扫描缓存/任务关联映射，
  运行状态按需刷新不轮询）；任务卡最多直列 3 个目标图标，其余折叠进快捷菜单（键盘可操作）；
  `AppPicker` 应用选择器（搜索/分类/当前窗口/手动登记）；`WorkspaceLauncher` 工作区
  顺序批量启动（可取消、部分成功明确）；设置页新增「应用与快捷方式」管理区。
  系统级窗口控制全部在 Rust 后端，React 不触碰 Win32。
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
- 应用内快捷键：Ctrl+1…6 切换标签（顺序与侧边栏一致，取自 `useUiStore` 的
  `TAB_ORDER` 单一事实源）、Ctrl+K 快速添加、Ctrl+Shift+C 剪贴板
  （完整模式切到剪贴板页，紧凑/最小模式开关临时抽屉）；
  输入框内不拦截，窗口聚焦时生效。实现见 `src/hooks/useGlobalShortcuts.ts`。
- 视觉系统（v0.6）：三个正交维度——视觉预设 `visual_preset`
  （dream-gradient / liquid-glass）、明暗 `theme`、材质 `material`；
  统一在 `useSettingsStore` 一条管道里落到 `html[data-preset|data-theme|data-material]`，
  老组件只认 `--surface-*` 等语义变量，因此两套皮肤共用一套组件代码。
  界面材质跟随**实际生效值**（`materialInfo.resolved`），原生 Mica/Acrylic 失败时自动回退 solid；
  每次重算都重新探测原生材质，系统「减少透明效果」关闭后能真正恢复。
  完整模式改为**左侧垂直导航**（62px，窄窗收敛为 46px 图标轨）。
  窗口圆角在 Win32 层用 `SetWindowRgn(CreateRoundRectRgn)` 裁剪（DWM 背景不受 CSS radius 影响，
  否则四角露黑），并按 `scale_factor` 换算物理像素。
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

### v0.5 备份与恢复架构（2026-10-30）

**统一注册表**：`src-tauri/src/commands/backup.rs` 的 `BACKUP_TABLES` 声明全部用户业务表
（当前 25 张）、恢复顺序与外键依赖；`EXTENDED_TABLES` 标记剪贴板、工作现场与行动中心等
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
