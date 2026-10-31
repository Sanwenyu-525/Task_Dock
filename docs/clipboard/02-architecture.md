# 02 · 架构与模块划分

> 代码位置：`src-tauri/src/clipboard/`、`src-tauri/src/commands/clipboard.rs`、
> `src/components/clipboard/`、`src/store/useClipboardStore.ts`
> 集成点：`src-tauri/src/lib.rs`（运行时装配）、`src/App.tsx`、`src/components/TitleBar.tsx`

## 一、源码审计与技术选型

### 审计结论

| 候选 | 能力 | 结论 |
|---|---|---|
| Tauri `clipboard-manager` 插件 | 读写文本/图片；无剪贴板变更监听；不暴露 CF_HTML 头部、CF_DIB、CF_HDROP、序列号与系统敏感标记 | 不足以支撑本需求，未采用 |
| `clipboard-rs` | 文本/HTML/图片/文件 + Windows watcher | 可用，但对系统标记、序列号隔离、DIB 快照/恢复的控制不足，且仍需 Win32 补丁；引入额外依赖 |
| CopyQ | 独立剪贴板管理器 | 是第二个应用/进程，违背“集成进 Task Dock、单一状态”的约束，未采用 |
| 直接 Win32（`windows-sys`） | `AddClipboardFormatListener`、格式读写、序列号、`SendInput`、进程令牌 | 项目已依赖 `windows-sys`（导航系统），零新增二进制；可完整控制格式与隐私边界 |

最终选择：**Win32 直接实现**。PNG 编解码、SHA-256、base64 使用 `Cargo.lock`
中已存在的 `png` / `sha2` / `base64`，仅提升为直接依赖，未引入新的第三方运行时。

### 复用项

- SQLite 连接、迁移、设置：`db/mod.rs`（迁移 v7 新增剪贴板表，v9 新增快照关联表）。
- 窗口枚举/焦点控制：`navigation/window_manager.rs`（粘贴目标选择与激活）。
- 任务与 Agent 数据：`tasks` 表、Agent 注册表（`agents`）与现有 DTO 风格。
- 事件与前端桥接：Tauri `emit` + `src/lib/bridge.ts` 的类型化 `invoke`。
- 主题与组件：现有 CSS 变量、按钮/输入框/分段控件、毛玻璃材质、Toast。

## 二、分层

```
┌──────────────────────────── React 前端 ────────────────────────────┐
│ TitleBar（唯一入口） → ClipboardDrawer（次级抽屉）                  │
│   ├─ 历史 / 分组 列表（分页 80）                                    │
│   ├─ 条目详情 / 分组详情（大图、HTML 源码、排序、拆分、合并）        │
│   ├─ PastePanel（目标窗口、进度、取消、继续）                       │
│   ├─ AgentExportPanel（本地导出） / TaskLinkBar（任务关联）          │
│   └─ useClipboardStore（筛选/分页/多选） + bridge.ts（41 个命令）    │
└───────────────────────────────┬────────────────────────────────────┘
                                │ invoke / emit（camelCase 参数、snake_case DTO）
┌───────────────────────────────▼────────────────────────────────────┐
│ commands/clipboard.rs：参数校验、DTO 压实、运行时取用                 │
├────────────────────────────────────────────────────────────────────┤
│ clipboard/                                                          │
│  engine.rs      纯逻辑：类型判定/哈希/预览/敏感特征/HTML 清洗/        │
│                  CF_HTML/整组富文本/自动分组与恢复决策（可单测）       │
│  image.rs       PNG 编解码、缩略图、DIB ↔ RGBA（不接触剪贴板）         │
│  store.rs       SQLite 持久化、资产文件引用、去重、分组、清理、分页     │
│  platform.rs    唯一 Win32 层：监听、读取、快照、写入、SendInput、      │
│                  目标窗口/权限检查；非 Windows 编译桩                  │
│  paste.rs       逐项粘贴队列、焦点恢复、取消/继续、剪贴板保护           │
│  agent_bridge.rs 本地导出包（Markdown + 图片 + manifest），不上传      │
│  mod.rs         常量、DTO、ClipboardRuntime（监听/粘贴/维护的生命周期） │
└───────────────────────────────┬────────────────────────────────────┘
                                │
              SQLite（WAL）+ 应用数据目录 clipboard/{images,thumbs}
```

设计原则：**纯逻辑与平台副作用分离**。`engine`/`image` 不依赖数据库或窗口，
`store` 不触碰 Win32，`platform` 不实现业务规则；`paste` 只通过 `platform`
抽象读写剪贴板，因此分组与恢复决策可在无 GUI 环境下单元测试。

## 三、运行时与线程

`ClipboardRuntime`（`clipboard/mod.rs`）在应用启动时创建并 `manage`：

- `db: Arc<Db>`、`root: <app_data>/clipboard`、`app: AppHandle`。
- `self_write: Arc<AtomicU32>`：本进程最后一次写剪贴板后的序列号。
- `paste: PasteManager`：单活动任务队列。
- `monitor: Mutex<Option<ClipboardMonitor>>`：监听线程句柄。

线程模型（v0.5 整改后，采集链路拆分）：

| 线程 | 职责 | 结束方式 |
|---|---|---|
| 主线程（Tauri） | 命令处理、UI 事件 | 应用退出 |
| `clipboard-monitor` | 消息专用窗口 + `GetMessage` 循环；收到 `WM_CLIPBOARDUPDATE` 只把序列号与时间戳放入有界事件队列，不读剪贴板、不编码图片、不写库 | `WM_CLOSE` / `stop()` |
| `clipboard-capture` | 合并事件（只保留最新序列号）→ 在后台读取剪贴板、系统标记/来源/敏感过滤、图片 PNG 编码 → 放入有界内容队列 | 队列关闭 / 进程退出 |
| `clipboard-worker` | 从内容队列取内容 → `store::record_capture` 入库 → `emit clipboard-changed` | 队列关闭 / 进程退出 |
| `clipboard-maintenance` | 启动 8 秒后首次清理，此后每 300 秒：结束过期收集组、清理过期/超额条目与孤儿文件、标记中断的粘贴任务 | 进程退出 |
| `clipboard-paste` | 单次逐项粘贴任务（同一时刻最多一个） | 完成/取消/失败 |

有界队列与背压：

| 队列 | 容量 | 超限行为 |
|---|---|---|
| 事件队列 | 64 条 | 丢弃最旧事件并累加 `dropped_events`；采集线程合并后只处理最新序列号 |
| 内容队列 | 8 条，且未入库内容合计 ≤128 MB | 丢弃最旧内容并累加 `dropped_contents`；大图不会无限占用内存 |

Windows 剪贴板内容**不可重放**：事件被丢弃后无法补读当时的内容；这是有界内存换来的
明确取舍，通过计数暴露而不是伪装“零丢失”。队列与合并计数经 `clipboard_status.monitor`
返回（只含计数与延迟，不含正文）：`observed_events`、`merged_events`、`captured`、
`recorded`、`duplicates`、`skipped`、`dropped_events`、`dropped_contents`、`failed`、
`peak_event_queue`、`peak_content_queue`、`max_capture_latency_ms`、
`max_process_latency_ms` 及三个容量常量。

**采集事件的处置与去重水位**（第四轮整改）：

`WM_CLIPBOARDUPDATE` 给出的序列号取自**消息处理时刻**，而采集线程真正读到的内容
属于**读取时刻**的剪贴板状态，两者可能对不上（例如两次复制之间还有其他程序写过）。
采集线程因此维护一个「已采集水位」`last`，并用纯函数
`classify_event(event_sequence, last_captured, self_write)` 把每个事件分成三类：

| 处置 | 判定 | 计数 |
|---|---|---|
| `Read` | 事件序列号晚于已采集水位，且不是本进程自写 | 继续读取 |
| `Superseded` | 事件序列号不晚于已采集水位（同一份剪贴板状态已记过） | `superseded_events` |
| `SelfWrite` | 事件序列号不晚于自写水位（本进程自己的写入/恢复） | `self_write_events` |

读取成功后水位推进到**读取时刻**的序列号（`ClipboardRead::Content { sequence, content }`
把两者一起返回），从而保证「同一份剪贴板状态只入库一次」：
既不会漏采，也不会把同一次复制重复抬成多条历史或抬高 `copy_count`。
自写判定排在覆盖判定之前，使「本进程自己写的」与「用户重复复制」在计数器里分开归因。

剪贴板当前为空或只有无法识别的格式时，事件计入 `empty_events` 并记日志，
不再像早期实现那样**既不计数也不留痕**——这条静默路径正是第四轮一次真实验收失败
（`observed=6` 而 `captured=4`）无法定位的直接原因。
现在 `observed_events` 的每一次去向都有归属：
`observed = captured + self_write_events + superseded_events + empty_events + dropped_events`。


并发约定：

- SQLite 由现有 `Mutex<Connection>` 串行化；WAL + `busy_timeout`。
- 粘贴任务互斥：`PasteManager::begin` 在锁内检查活动任务，重复启动返回校验错误。
- 监听侧不信任事件时间：每次事件重新加载设置；暂停/停用立即生效。
- 剪贴板配置读取 fail-closed：`Settings::load_clipboard` 区分键缺失（沿用默认，兼容旧库）、
  单项 JSON 损坏、类型错误、数值越界与数据库读取失败；后四类返回
  `ClipboardConfigError { kind, keys }`，`capture_allowed=false`，采集线程与 worker
  直接跳过并限频记录日志（最多 60 秒一次），**不会**按默认值恢复自动记录。
  整个 `Settings::load` 会先剔除损坏的剪贴板字段，任务/Agent 等其他设置不受牵连。
- 维护线程在逐项粘贴进行中跳过自动清理（`interrupt_stale_paste_jobs` 与
  `store::cleanup` 都不执行）；手动 `clipboard_cleanup` 在粘贴进行中直接返回校验错误。
  清理会删除条目与资产，而粘贴队列按 id 逐项读取，删除会让后续条目凭空丢失。
- 采集线程只读取一次剪贴板；读取使用 10 次、每次 12 ms 的 `OpenClipboard` 重试，
  失败计入 `skipped`（原因“剪贴板被其他程序占用”），不记录、不崩溃。
- 单个内容处理被 `catch_unwind` 隔离：解析/入库 panic 只记 `failed`，不杀死采集线程。
- 所有日志只记录类型/大小/计数/原因，不记录正文、文件路径或完整图片。

### 剪贴板访问并发模型（P0 整改）

本进程所有剪贴板访问——采集读取、事件复核、快照、内容比较、写入、恢复——共用
进程级 `ACCESS_LOCK`（`platform.rs`），保证同一进程同一时刻只有一条
`OpenClipboard → 读/写 → CloseClipboard` 序列。

这不是保守设计，而是真机缺陷的直接修复：同进程两个线程各自开关剪贴板会互相打断
`GetClipboardData`（对方 `CloseClipboard` 后句柄失效）。不串行化时，粘贴线程刚写完
就在验证读取中读到 `None`，被误判为“用户接管”，甚至出现错误的空内容快照。

写入路径（`write_guarded_inner`）：

```
ACCESS_LOCK
  → OpenClipboard（10×12 ms 重试）
  → GetClipboardSequenceNumber
  → 守卫判定：
       Content    → 锁内读取文本/HTML/PNG/文件并与期望内容比较
       Sequence   → 比较调用方记录的序列号
       Unconditional → 直接允许（用户主动复制）
     不匹配 → CloseClipboard 返回 SequenceChanged（绝不调用 EmptyClipboard）
  → EmptyClipboard + SetClipboardData
       Text → CF_UNICODETEXT + 可选 CF_HTML
       Image → PNG + CF_DIB
       Files → CF_HDROP（仅存在且绝对路径）+ 路径纯文本
  → CloseClipboard
  → GetClipboardSequenceNumber（关闭后读取；Windows 会继续为合成格式递增）
  → 需要抑制自写时：仍在 ACCESS_LOCK 内 self_write.fetch_max(final_seq)
  → 释放 ACCESS_LOCK
```

- **以内容为准**：序列号在合成格式/延迟渲染下会继续增长，不能单独证明剪贴板归属；
  逐项粘贴的写前检查、写后确认和恢复都用锁内内容比较。序列号只作快速变化检测。
- 两类写入：
  - 用户主动复制（单条/整组富文本/整组文件）→ `write_payload`，即
    `WriteGuard::Unconditional`；这是明确用户意图，不加守卫，但仍串行化，
    并在命令层调用 `note_self_write`，监听侧不会把本次写入当成外部复制。
  - 逐项粘贴 → `write_guarded_notifying(payload, Content(上次写入或基线快照), self_write)`；
    写入成功后的最终序列号在 **同一把 ACCESS_LOCK 内**登记。
- 恢复 → `restore_if_own_content(snapshot, last_written)`：只有锁内确认当前内容仍等于
  本进程最后一次写入时才写回快照；否则返回 `KeepUserCopy`，**绝不覆盖用户后来复制的
  内容**。若无法打开剪贴板，也返回错误而不是猜测写入。
- 自写抑制原子化：采集线程的 `read_clipboard_for_event` 在同一把锁内复核
  `event_sequence <= self_write`，因此不会出现“采集线程抢在登记之前读取”从而重复
  记录本进程写入的问题；用户复制的序列号必然大于登记值，不会被误跳过。
- `snapshot()` 在同一次锁内读取序列号 + 内容，避免“序列号与内容不匹配”。
- `ACCESS_LOCK` **只覆盖剪贴板打开窗口**；等待目标窗口、焦点轮询、条目间间隔、
  `SendInput` 均在锁外，目标应用无响应不会阻塞用户复制，也不会持锁等待目标。
- 无法打开剪贴板时返回“剪贴板被其他程序占用，请稍后重试”，不进入半写入状态。

## 四、IPC 命令（41 个）

注册位置：`src-tauri/src/lib.rs` 的 `invoke_handler`；前端封装：`src/lib/bridge.ts`。

| 分组 | 命令 |
|---|---|
| 查询 | `clipboard_view`、`clipboard_item`、`clipboard_group`、`clipboard_stats`、`clipboard_thumb`、`clipboard_image` |
| 复制 | `clipboard_copy_item`、`clipboard_copy_group_rich`、`clipboard_copy_group_files` |
| 整理 | `clipboard_toggle_item`、`clipboard_toggle_group`、`clipboard_close_group`、`clipboard_delete_items`、`clipboard_delete_group`、`clipboard_create_group`、`clipboard_rename_group`、`clipboard_add_to_group`、`clipboard_remove_group_item`、`clipboard_move_group_item`、`clipboard_split_group`、`clipboard_merge_groups` |
| 任务关联 | `clipboard_link_task`、`clipboard_unlink_task`、`clipboard_task_links` |
| 快照关联（v0.5 并行模块） | `clipboard_link_snapshot`、`clipboard_unlink_snapshot`、`clipboard_snapshot_links` |
| 粘贴 | `clipboard_visible_targets`、`clipboard_foreground_target`、`clipboard_paste_precheck`、`clipboard_paste_group`、`clipboard_paste_cancel`、`clipboard_paste_resume`、`clipboard_paste_job`、`clipboard_paste_active` |
| 维护/诊断 | `clipboard_cleanup`、`clipboard_status`、`clipboard_probe` |
| Agent | `clipboard_agent_targets`、`clipboard_export_for_agent`、`clipboard_export_preview` |

约定：

- 前端调用参数使用 camelCase（如 `itemId`、`targetHwnd`、`alsoDeleteItems`），
  Rust 侧为 snake_case；DTO 字段统一 snake_case。
- 列表/分组详情接口返回“压实” DTO：`text` = 预览，`html` 清空；完整正文/HTML
  只在 `clipboard_item` / `clipboard_group` 详情接口返回。
- 错误沿用 `AppError`：校验失败/未找到/IO/数据库，前端直接展示错误文本。
- 事件：`clipboard-changed`（采集/整理/清理，payload 为 `kind`、`created`、`grouped`），
  `clipboard-paste`（任务进度与结束，camelCase：`jobId`、`status`、`sent`、`total`、
  `pending`、`message`、`restored`）。

## 五、关键流程

### 采集

```
WM_CLIPBOARDUPDATE（消息线程）
  → 只入队 {sequence, observed_at}（事件队列 64，满则丢最旧并计数）
capture 线程
  → 合并队列，只保留最新序列号（merged_events）
  → classify_event：Read / Superseded（superseded_events）/ SelfWrite（self_write_events）
  → 重新读取设置（enabled / paused）
  → 读取格式（文本 / HTML / PNG / DIB / HDROP），系统敏感标记检查
      PNG 优先于 DIB；但 Windows 会从 32bpp BI_RGB 的 DIB 合成 Alpha 全 0 的 PNG，
      若直接原样保存，历史里和粘贴出去的图片会变成完全透明。读取时统一走
      `image::normalize_clipboard_png`：仅当**所有**像素 Alpha 都为 0 时改写为不透明并重编码，
      部分透明的图标/贴纸保持原样；有可见像素的 PNG 不重编码（字节保持不变）。
  → 格式优先级判定（files > image > URL > html > text）
  → 自身来源/排除名单/采集类型开关/敏感过滤（高置信；来源未知时加保守凭据模式）
  → 大小与数量上限；图片 PNG 编码/缩略图
  → 放入内容队列（8 条 / 128 MB，满则丢最旧并计数）
  → 采集水位推进到**读取时刻**的序列号（同一份剪贴板状态只入库一次）
worker 线程
  → store::record_capture
       → 归一化 + HTML 清洗 + SHA-256
       → 命中哈希：copy_count+1、last_seen_at、来源更新，结束
       → 未命中：图片落盘 → 事务插入条目/资产 → 自动分组决策
  → emit clipboard-changed
```

### 逐项粘贴

```
UI 选择目标窗口 → clipboard_paste_precheck（存在/非自身/UIPI）
  → PasteManager.start：互斥检查 → 创建/重置 job → snapshot() 原剪贴板
  → 后台线程：逐项状态机
      pending → preparing（读取内容）
        → 目标已关闭/读取失败 → failed/skipped，停止或继续
        → focus_window（3 轮 × 10×60 ms 轮询 + 150 ms 间隔，锁外）
        → 写前：剪贴板内容仍等于上次写入/基线快照（5 次退避重试区分“读不到”）
            内容被更换 → failed，不写、不按键、不恢复，停止
        → write_guarded(Content(上次写入/基线))（锁内比较+写入）
            守卫拒绝 → failed，不覆盖用户新内容
        → clipboard_written → 登记自写序列号
        → 写后：再次做锁内内容比较
            Same → SendInput Ctrl+V；Different/Unavailable → failed，不发送按键
        → input_sent → settling → unverified
        （没有可靠接收信号，永不标记 confirmed，也不自动重发）
        → 更新 job / emit 进度 → 按类型间隔等待（可取消）
  → 收尾阶段：wrote_any 且用户未接管时，按最后类型再等待 → restore_if_own_content
      内容已变 → KeepUserCopy（保留用户内容）；剪贴板占用 → 报错不猜测
  → 写入最终状态与诚实文案，emit clipboard-paste
```

取消时保留未处理条目到 `remaining_items`；已写入但未确认的条目不会自动重发。
每条目状态为 `pending/preparing/clipboard_written/input_sent/settling/unverified/
failed/cancelled/confirmed`，其中 `confirmed` 仅在存在独立接收信号时使用（Windows
通用窗口没有该信号，正常路径止于 `unverified`）。

## 六、降级与边界

- 监听启动失败：`ClipboardRuntime::start` 记录警告，运行时继续工作；
  `clipboard_status.monitoring=false`，抽屉状态显示“监听未启动”。
- 配置损坏：监听线程保持运行（可被重新启用/继续接收事件），但 `capture_allowed=false`，
  不读取、不入库；`clipboard_status` 对外报告 `enabled=false`、`paused=true` 与
  `configError`，抽屉显示“配置异常，自动记录已暂停”，不会显示“监听中”。
  用户可在设置中“修复配置”（原始值备份到 `clipboard_config_corrupt_backup`，
  修复后保持暂停）或“修复并恢复记录”。数据库读取失败不能靠修复解决，UI 如实说明。
- 目标窗口复用：粘贴的聚焦与 `SendInput` 前都会用 PID 复核 HWND 归属，并再次确认
  目标仍在前台；窗口关闭或被系统复用则失败停止，不向其他窗口发送按键。
- 清理与粘贴争用：粘贴进行中不执行自动清理，手动清理被拒绝，避免删除正在发送的资产。
- 非 Windows：`platform` 编译桩返回空读/明确写入错误；不伪装监听可用。
- 图片文件缺失：复制/粘贴时返回“图片文件缺失”，不阻塞其他条目。
- 原文件被移动/删除：文件条目复制时只保留仍存在的路径；全部不存在则报错。
- HTML 采集关闭：若存在纯文本则降级为 text 记录，否则不记录。
- 敏感过滤开启：仅命中高置信模式才跳过；来源未知时额外启用保守凭据模式；
  不做“100% 识别”的承诺。
- 高频复制超出队列容量：显式丢弃并计数（`dropped_events` / `dropped_contents`）；
  Windows 剪贴板无法回放被丢弃的内容，界面对应诊断字段可查。
