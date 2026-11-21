# TaskDock 日志系统现状报告（代码级审计）

> 审计日期：2026-11-19
> 审计范围：`src/`（React/TS）、`src-tauri/src/`（Rust/Tauri）、`apps/mobile/`（Android/Kotlin）、
> `scripts/`（构建与验收脚本）
> 审计方式：全仓库关键字检索 + 逐文件精读 + 调用点计数。所有结论均给出 `文件:行号` 证据。
> 审计约束：**未执行**的检查一律标注「未执行」，不以代码存在推定功能可用。

---

## 0. 一句话结论

TaskDock **不存在「没有日志系统」的问题，而是存在「日志系统被局部发明了四次」的问题**：
`diagnostics` 诊断日志主干（Rust + TS 双端）已经具备生产级质量（单写线程、有界队列、
字段白名单脱敏、分页查询、脱敏导出、65 个自动化测试），但它**只覆盖了桌面端**；
Android 端、配对/远控审计、性能指标、跨进程 Trace、Panic 捕获四个方向**要么缺失、
要么各自另建体系**，且四套体系的保留策略、字段契约、查询入口互不统一。

**因此本轮工作的性质是「收敛 + 补齐」，不是「从零建设」。**

---

## 1. 日志实现清单（按体系分组）

### 1.1 体系 A：`diagnostics` 诊断日志主干（主体系，保留并扩展）

**位置**：`src-tauri/src/diagnostics/`（7 文件 3926 行）+ `src-tauri/src/commands/diagnostics.rs`（249 行）
+ `src/lib/diagnostics.ts`（784 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src-tauri/src/diagnostics/mod.rs` | 902 | 事件契约、级别/状态枚举、写线程生命周期、事件构建器 |
| `src-tauri/src/diagnostics/writer.rs` | 596 | 单写线程、BufWriter 批量写、轮转、清理、聚合 |
| `src-tauri/src/diagnostics/query.rs` | 984 | 分页查询、摘要、脱敏报告导出 |
| `src-tauri/src/diagnostics/privacy.rs` | 362 | metadata 白名单、路径形态识别、敏感 key 拒绝 |
| `src-tauri/src/diagnostics/tracing_layer.rs` | 209 | `tracing` → 诊断事件桥接层 |
| `src-tauri/src/diagnostics/batch.rs` | 434 | 批量文件操作诊断事件构造 |
| `src-tauri/src/diagnostics/tests.rs` | 873 | 21 个 `#[test]` |
| `src-tauri/src/commands/diagnostics.rs` | 249 | 7 个 Tauri 命令 |
| `src/lib/diagnostics.ts` | 784 | 前端有界队列、批量 IPC、操作生命周期、跨层去重 |

#### 1.1.1 事件契约

`DiagnosticEvent`（`src-tauri/src/diagnostics/mod.rs:184-227`）字段：

`timestamp` / `level` / `module` / `action` / `event` / `session_id` / `operation_id` /
`window_id` / `component` / `stage` / `status` / `error_code` / `error_category` /
`duration_ms` / `retry_count` / `message` / `metadata` / `source` / `count`

- 落盘为 JSONL，字段名 snake_case，属**稳定存储契约**（`mod.rs:180-182` 注释明示）。
- 全部字段 `#[serde(default)]`，旧日志/半截行不破坏查询（`mod.rs:182`）。
- 级别枚举 `DiagLevel`（`mod.rs:88-96`）：Trace/Debug/Info/Warn/Error/Critical。
- 状态枚举 `DiagStatus`（`mod.rs:137-144`）：started/success/failed/cancelled/recovered。
- 来源枚举 `DiagSource`（`mod.rs:171-176`）：rust/frontend/system。

#### 1.1.2 采集适配层

- **Rust 显式埋点**：`diagnostics::event(...)`（`mod.rs:787`）+ `EventBuilder`
  （`mod.rs:794-855`，链式 `.stage() .status() .operation() .window() .component()
  .message() .error_code() .error_category() .metadata()`）；全仓库 36 处调用
  （`diagnostics::event` 28 处 + `diagnostics::emit` 8 处）。
- **`tracing` 桥接层**：`DiagnosticsLayer`（`tracing_layer.rs:21-73`）挂在
  `tracing_subscriber` 上（`src-tauri/src/lib.rs:652`）。只接收 target 以
  `task_dock_lib` 开头的本 crate 事件（`tracing_layer.rs:33`），第三方库日志不落盘。
  `FieldVisitor`（`tracing_layer.rs:107-137`）只提取 10 个白名单字段，其余结构化字段**全部丢弃**。
  全仓库 `tracing::` 宏共 493 处：`warn!` 297、`info!` 102、`debug!` 72、`error!` 22。
- **前端采集**：`src/lib/diagnostics.ts`
  - `logEvent(input)`（`diagnostics.ts:339`）：同步入队，绝不 `await`、绝不抛出。
  - `startOperation(module, action, options)`（`diagnostics.ts:509`）：返回
    `DiagnosticOperation`，提供 `stage() / success() / fail() / cancel() / recovered()`
    与 `elapsedMs`（用 `performance.now()` 单调时钟，`diagnostics.ts:516`）。
  - `logIpcFailure` / `logIpcSuccess`（`diagnostics.ts:626` / `674`）：IPC 层自动归类。
  - 前端 `logEvent` / `startOperation` 调用点共 **59 处**，分布在 23 个文件。
- **模块归类**：`moduleForCommand(command)`（`diagnostics.ts:402-442`）把命令名映射到稳定
  模块标识（`clipboard`/`agent`/`task`/`mcp`/`ipc`…），未知命令归 `ipc`。

#### 1.1.3 输出目的地与持久化

- 目录：`<app_data>/diagnostics/`（`mod.rs:419`），活动文件 `diagnostics-active.jsonl`，
  归档 `diagnostics-<stamp>-<seq>.jsonl`（`mod.rs:77-78`）。
- **单写线程**：`writer::run`（`writer.rs:45-82`）是唯一接触文件的线程，
  线程名 `diagnostics-writer`（`mod.rs:448`）。
- **异步批量写**：`BufWriter::with_capacity(64 * 1024, file)`（`writer.rs:141`），
  200ms 批次 flush（`FLUSH_INTERVAL`，`writer.rs:39`），绝不对每条日志 `sync_all`。
- 落盘格式：每条事件一行 JSON（`writer.rs:169-177`）。

#### 1.1.4 有界与背压

| 层级 | 上限 | 位置 | 溢出策略 |
|---|---|---|---|
| 前端队列 | 128 条 | `diagnostics.ts:36` | 优先丢最早 DEBUG/INFO；否则丢最旧非 CRITICAL；全 CRITICAL 才丢本条 |
| 前端在途批次 | 4 | `diagnostics.ts:42` | 超限直接 return，不排队 |
| 前端单批 | 20 条 | `diagnostics.ts:38` | 与后端 `MAX_BATCH` 对齐 |
| Rust 队列 | 1024 条 | `mod.rs:60` (`CHANNEL_CAPACITY`) | `try_send`；ERROR/CRITICAL 允许 ≤2ms 重试 2 次，其余直接丢弃计数 |
| 聚合表 | 256 指纹 | `mod.rs:62` (`AGG_MAX_ENTRIES`) | 同指纹 60s 窗口合并为计数行（`count` 字段） |
| 单文件 | 5 MB | `mod.rs:54` (`MAX_FILE_BYTES`) | 写前判断，轮转 |
| 归档数 | 4 | `mod.rs:56` (`MAX_ARCHIVE_FILES`) | 删最旧 |
| 目录总量 | 25 MB | `mod.rs:58` (`MAX_TOTAL_BYTES`) | 删最旧归档直至达标 |

- 背压失败路径：`record()`（`mod.rs:558-596`）返回 `bool`，丢弃计入 `counters.dropped`。
- **日志失败不影响业务**：写线程内任何 IO 错误只更新计数器并按 30s 间隔打 stderr
  （`writer.rs:399-412`），绝不 panic、绝不向调用方返回错误。
- **防递归**：写线程内部只用 `eprintln!`，绝不调用 `tracing`（`writer.rs:8-9`）。

#### 1.1.5 敏感信息保护（体系 A）

- **字段白名单**：`privacy.rs:23-89` 的 `ALLOWED_META_KEYS`（**66 个键**），非白名单一律丢弃。
- **敏感 key 拒绝**：`FORBIDDEN_KEY_PARTS`（`privacy.rs:121-139`）含
  `token/password/passwd/secret/api_key/apikey/authorization/cookie/credential/content/body/
  clipboard_text/transcript/prompt/message_text/full_path/file_path`；
  `is_allowed_key`（`privacy.rs:141-147`）即使误加白名单也会拒绝。
- **对象/数组/null 一律丢弃**（`privacy.rs:205-206`），避免业务对象整体入库。
- **路径形态识别**：`looks_like_path`（`privacy.rs:98-118`）识别盘符/UNC/POSIX 绝对路径；
  `PATH_LIKE_META_KEYS`（`source/target/from/to`，`privacy.rs:95`）命中时整值替换为 `<路径>`。
- **消息脱敏**：复用 `error::sanitize_diagnostic`（`privacy.rs:172-175`），限长 400 字符。
- **标识符归一**：`normalize_ident`（`privacy.rs:151-170`）只保留小写字母数字与 `_-.:`，截断。
- **错误码形态校验**：`normalize_error_code`（`privacy.rs:218-233`）要求 `A-Z0-9_`、长度 3..=40，
  非法归一为 `UNKNOWN_ERROR`。
- **前端不可信字段重写**：`parse_frontend_event`（`commands/diagnostics.rs:98-112`）
  强制清空 `session_id`/`timestamp`/`count`，并把 `source` 固定为 `Frontend`，
  防止多窗口伪造时钟、计数或来源。

#### 1.1.6 错误归属与去重

- **实例级**：`markLogged` / `isLogged`（`diagnostics.ts:193` / `202`），基于 `WeakSet`。
- **指纹窗口级**：`reserveReport`（`diagnostics.ts:266-287`），同指纹 250ms 内只抑制
  「次级观察」，主要归属（IPC 失败）始终记录；被抑制次数通过
  `metadata.suppressed_since_last` 带回，真实发生次数不丢。
- **Toast 去重**：`globalErrors.ts:26-33`，同根因 30s 内只提示一次。
- 指纹表上限 64 条（`MAX_REPORT_FINGERPRINTS`，`diagnostics.ts:219`），TTL 60s。

#### 1.1.7 生命周期

- **初始化**：仅一次。`Diagnostics::init`（`mod.rs:418-421`）→ `init_at`（`mod.rs:423`），
  目录创建失败则 `disabled=true` 降级（`mod.rs:427-430`）。
- **详细诊断模式**：`set_mode`（`mod.rs:513`），默认 30 分钟、最长 120 分钟
  （`VERBOSE_DEFAULT_MINUTES` / `VERBOSE_MAX_MINUTES`，`mod.rs:66` / `68`）。
  必须**真正改变 `tracing` 过滤**，通过 `attach_filter_reload`（`mod.rs:602-609`）回调
  `EnvFilter::reload`，否则 DEBUG/TRACE 在到达诊断层前就被丢弃（`mod.rs:600-601` 注释）。
- **退出刷盘**：写线程 `finish()`（`writer.rs:388-397`）做一次 `flush` + `sync_all`。
- **有界 flush**：`flush_blocking`（`mod.rs:642-661`），入队等待 ≤300ms，
  回执等待 ≤2s（`FLUSH_ACK_TIMEOUT`，`mod.rs:71`），超时返回 `flushed=false`，
  调用方**不得**在此时声称数据完整。
- **前端退出 flush**：`installDiagnosticsFlushHooks`（`diagnostics.ts:772-784`）在
  `pagehide` / `beforeunload` 尽力 flush。
- **清理取消语义**：`clear()`（`mod.rs:667+`）单飞占用 + 有界入队 + 等待回执；
  超时会**请求取消**（写线程在开始删除前检查 `cancelled` 标记，`writer.rs:64-68`），
  避免「界面提示失败、稍后静默删除」。

#### 1.1.8 查询与导出

- 查询过滤 `DiagnosticQuery`（`query.rs:93-112`）：`levels` / `modules` / `error_codes` /
  `statuses` / `window_ids` / `operation_id` / `text` / `since` / `until` / `limit` / `offset` /
  `anomalies_only`。
- 查询/摘要/导出均走 `spawn_blocking`，不占命令线程（`commands/diagnostics.rs:173` / `188` / `203`）。
- 导出产出**脱敏诊断报告**（本机文件，不上传）：`ExportResult`（`query.rs:612-625`）包含
  `path`/`bytes`/`records`/`truncated`/`flushed`/`flush_issue`/`complete`；
  schema `taskdock.diagnostic-report/1`（`query.rs:721`），含 app 版本、OS/arch、
  session_id、range、summary、records。
- 导出前先 `flush_blocking`（`commands/diagnostics.rs:205`），无法确认时如实标记不完整。

#### 1.1.9 测试证据

- Rust：`src-tauri/src/diagnostics/tests.rs` **21 个 `#[test]`**；
  `privacy.rs` 内联测试 **9 个**（`privacy.rs:236-362`）；`tracing_layer.rs` 内联 **2 个**
  （`tracing_layer.rs:166-209`）。
- 前端：`src/lib/diagnostics.test.ts` **33 个用例**。
- UI：`src/components/diagnostics/DiagnosticsCenterPanel.test.tsx`、
  `src/components/settings/DiagnosticsLogsSection.test.tsx` 存在。

---

### 1.2 体系 B：`tracing` 控制台日志（基础设施，非独立日志系统）

- 依赖：`tracing` + `tracing_subscriber`，全局 subscriber 在 `src-tauri/src/lib.rs:636-652` 装配，
  `DiagnosticsLayer` 与 fmt layer 并列挂载。
- 493 处宏调用遍布 72/310 个 Rust 源文件（不含 `tests.rs`）。
- 与体系 A 的关系：**体系 B 是体系 A 的上游数据源**，`DiagnosticsLayer` 把已有
  `warn!/error!` 自动导入持久化诊断日志，无需改几十个业务文件（`tracing_layer.rs:3-8`）。
- 默认落盘级别：**仅 WARN 及以上**；INFO/DEBUG/TRACE 需开启详细诊断模式
  （`tracing_layer.rs:44-47`）。
- 控制台输出不受影响，fmt layer 仍独立工作（`tracing_layer.rs:9`）。

### 1.3 体系 C：MCP 审计（`mcp_audit_log`，SQLite）

- 位置：`src-tauri/src/mcp/audit.rs`（258 行），表定义 `src-tauri/src/db/mod.rs:1255-1272`。
- 每次 MCP 工具调用一条记录。字段：`agent_row_id` / `agent_id` / `action` / `entity_type` /
  `entity_id` / `request_id` / `success` / `authz` / `detail` / `result_json` / `created_at`。
- **幂等键**：`UNIQUE(agent_row_id, action, request_id) WHERE request_id <> '' AND success = 1`
  （`db/mod.rs:1271-1272`）。
- **两段式保留**（`mcp/audit.rs:209-258`）：元数据保留 `metadata_days`，幂等载荷
  `result_json` 保留 `payload_days`；先清载荷、再删行；**仍在重试窗口内的 requestId
  永远不会被清理**。
- 清理**只由用户显式触发**（`mcp_audit_prune`），不在启动时静默执行（`mcp/audit.rs:16-17`）。
- 脱敏边界：`detail` 只放动作结果摘要，`result_json` 只保存写工具成功结果（`mcp/audit.rs:3-5`）。
- 查询：`list_page`（`mcp/audit.rs:73`）分页，**不返回** `result_json`/`detail`/`request_id`。

### 1.4 体系 D：Personal Hub 审计（`ph_audit_log`，独立 SQLite）

- 位置：`src-tauri/src/personal_hub/store.rs:401-428` 的 `append_audit`。
- 事件类型（由测试断言反推，`personal_hub/pairing.rs:830` / `900` / `901` / `944`）：
  `PAIRING_APPROVED`、`PAIRING_REJECTED`、`INVITATION_REVOKED`、`SECURITY_FAILURE`。
- 字段：`event_type` / `device_id` / `request_id` / `fingerprint` / `result` / `detail` / `created_at`。
- **与体系 A 完全无关联**：`personal_hub/` 下 17 个 Rust 文件**零** `tracing::` /
  `diagnostics::` 调用（实测计数 0）。

### 1.5 体系 E：安全钥匙库审计（`audit` 表，独立 SQLite）

- 位置：`src-tauri/src/secure_vault/store.rs:525-546` 的 `audit()`。
- 事件：`vault_create` / `unlock` / `change_master_password` / `recover_set_password` /
  `regenerate_recovery` / `record_create` / `record_delete` / `settings_update` /
  `backup_export`（`secure_vault/commands.rs:564` / `697` / `796` / `849` / `898` /
  `1098` / `1200` / `1586`，`secure_vault/backup.rs:389` / `635`）。
- 字段：`at` / `event` / `outcome` / `reason_code` / `count`。
- **保留策略：只保留最近 500 条**（`store.rs:543-546`），硬截断、无时间维度。
- `secure_vault/` 下 13 个 Rust 文件**零** `tracing::` / `diagnostics::` 调用。

### 1.6 体系 F：`resource_cleanup/diagnostics.rs`（命名撞车，非日志系统）

- 位置：`src-tauri/src/resource_cleanup/diagnostics.rs`（805 行）。
- 实际职责：**只读资源诊断**——采样应用自身进程指标与开发相关进程列表，
  「轻量诊断，不是任务管理器」（文件头注释）。不写任何持久化表。
- **与日志系统无任何关系**，仅模块名与 `diagnostics` 撞车。审计时容易误判，需在文档中显式排除。

### 1.7 体系 G：`mcp/diagnostics.rs`（命名撞车，非日志系统）

- 位置：`src-tauri/src/mcp/diagnostics.rs`（455 行）。
- 实际职责：**MCP 连接诊断医生**——探测 bridge 端口、校验工具注册表、查数据库完整性、
  检查 Agent 身份，产出 `DiagnosticsReport`（`ok`/`failed`/`not_run`/`unverified` 四态）。
- **不写日志、不落盘**，是一次性健康检查。同样是命名撞车。

---

## 2. 其它日志痕迹（统计，不逐条列出）

### 2.1 前端 `console.*`

- 全仓库 `src/` 命中 `console.(log|error|warn|info|debug)(` 共 **40 处 / 16 个文件**，其中
  测试文件 3 处（`help/__tests__/health.test.ts` 2、`QuickPreviewDialog.preview.test.tsx` 1），
  **生产代码 37 处 / 14 个文件**：
  `useEdgeSnap.ts`(15)、`useSettingsStore.ts`(5)、`useNavOrderDraft.ts`(4)、
  `WidgetDesktopBridge.tsx`(2)，以及 `ErrorBoundary.tsx` / `globalErrors.ts` /
  `i18n/messages.ts` / `workspace/bootstrap.ts` / `useAgentHistory.ts` /
  `FilesWorkspacePanel.tsx` / `WidgetWindow.tsx` / `capsule/actions.ts` /
  `audioNotification.ts` / `usePlanningStore.ts` 各 1 处。
- **判定**：`ErrorBoundary.tsx` / `globalErrors.ts` 的 console 属于「已接入诊断体系的兜底输出」，
  非缺陷；其余为**开发期调试残留**，属轻微缺陷（生产构建中 console 输出无级别控制）。

### 2.2 Android

- `apps/mobile/`（排除 `node_modules` 与 `build/`）中 `android.util.Log` 调用 **0 处**。
- Kotlin 异常处理方式：`catch (_: Exception) {}` 静默吞异常
  （`apps/mobile/modules/clipboard/android/.../ClipboardModule.kt:63`、
  `apps/mobile/modules/device-identity/android/.../Ed25519Ops.kt:59` 与 `:78`）。
- `IdentityStore.kt` / `DeviceIdentityModule.kt` 有完整错误分类并抛
  `IdentityStorageException`（如 `IdentityStore.kt:104`、`:109`、`:112`、`:177`），
  但**无任何日志落点**，错误只经 JS 桥返回。
- 移动端 TS 仅 3 处 `console.*`，全部在**测试文件**内
  （`apps/mobile/src/domain/tools/diffEngine.test.ts:224`、
  `regexEngine.test.ts:429`、`src/lib/sync/__tests__/engine.test.ts:229`）。
- **无自定义 logger、无本地持久化日志、无崩溃捕获（`UncaughtExceptionHandler`）**。

### 2.3 构建与验收脚本

- `scripts/` 下 22 个 `.mjs` / `.ps1` 使用 `console.log` / `Write-Host`。
- 这些是**一次性构建/验收脚本的终端输出**，不属于应用运行时日志，判定为**不适用**
  （但缺少统一的脚本日志格式，影响跨平台一致性，见能力矩阵 F-15）。

---

## 3. 关键链路现状（用户要求的四条链路）

### 3.1 React UI → Tauri Command → Rust Service → 文件系统 → 返回

| 环节 | 现状 | 证据 |
|---|---|---|
| React → Tauri | **已覆盖**。IPC 失败自动归类落盘 | `diagnostics.ts:626-671`；`bridge.ts` 统一 `invokeCommand` |
| Tauri Command → Rust | **部分覆盖**。`tracing` 宏 + `diagnostics::event` | 493 处 `tracing::`，36 处 `diagnostics::event` |
| Rust → 文件系统 | **部分覆盖**。仅 `fsops`(1/1)、`file_workspace`(0/4)、`shelf`(4/13) 等有埋点 | 顶层模块覆盖统计 |
| 结果返回 | **已覆盖**。前端 `logIpcFailure` 带 `duration_ms` | `diagnostics.ts:626-671` |
| 跨层关联 ID | **已实现（部分）**。`operation_id` 贯穿 `started → stage → failed` | `diagnostics.ts:509-617` |

**结论**：链路 1 的**主干已通**，但 Rust 侧文件级操作埋点密度低（`file_workspace` 0/4、
`transfer` 0/8、`capability` 0/9）。

### 3.2 Desktop → 设备通信 → Android → 操作执行 → 返回

| 环节 | 现状 | 证据 |
|---|---|---|
| Desktop 侧监听 | **已覆盖**。`tracing::info!` 记录监听地址、TLS 就绪、关闭 | `mobile_sync/mod.rs:297,304,328,342,351` |
| 配对码错误/次数过多 | **已覆盖**（WARN 级） | `mobile_sync/server.rs:198,202` |
| 配对写入设备失败 | **已覆盖**（WARN 级） | `mobile_sync/mod.rs:644,691` |
| 鉴权失败 | **已覆盖**（WARN 级） | `mobile_sync/server.rs:259,305` |
| 同步/互传失败 | **已覆盖**（WARN 级） | `mobile_sync/server.rs` 共 40+ 处 |
| Android 侧 | **完全缺失**。无日志、无持久化、无崩溃捕获 | 实测 `Log.x` 调用 0 处 |
| 跨端关联 ID | **缺失**。Desktop 有 `session_id`/`operation_id`，Android 无对应标识 | Android 侧无任何 ID 概念 |

**结论**：链路 2 的 **Desktop 半段可用，Android 半段空白**，且两端**无共同关联 ID**。

### 3.3 Agent → MCP → TaskDock → 业务模块 → 执行结果

| 环节 | 现状 | 证据 |
|---|---|---|
| MCP 工具调用审计 | **已实现且质量高**。`mcp_audit_log` 两段式保留 + 幂等键 | `mcp/audit.rs`、`db/mod.rs:1255-1272` |
| MCP 工具调用诊断事件 | **稀疏**。`mcp/` 18 个文件仅 1 个有 `tracing::`/`diagnostics::` | 顶层模块覆盖统计 |
| Agent 管线事件 | **已覆盖**。`tracing::warn!/error!` 记录暂存失败、批量写入回退 | `agents/pipeline.rs:1282,1298,1316,1518` |
| Agent 失败原因 | **部分覆盖**。`agents/` 27 文件仅 7 个有埋点 | 顶层模块覆盖统计 |
| MCP→诊断日志的关联 ID | **缺失**。审计表有 `request_id`，诊断日志侧无 `trace_id` 概念 | 全仓库 `trace_id`/`span_id` 检索结果为空 |

### 3.4 跨模块追踪标识

| 标识 | 状态 | 证据 |
|---|---|---|
| `session_id` | **已实现**。进程级 UUID，前端不可伪造 | `mod.rs:433`；`commands/diagnostics.rs:107` |
| `operation_id` | **已实现**。操作生命周期主键，支持精确回溯全链路 | `diagnostics.ts:493-502`；`query.rs:101` |
| `window_id` | **已实现**。入口 HTML 表驱动推断 | `diagnostics.ts:84-109` |
| `trace_id` | **未实现**。全仓库检索 `trace_id`/`traceId` 结果为空 | 实测 grep 无命中 |
| `span_id` | **未实现**。同上 | 实测 grep 无命中 |
| `device_id` | **未实现**。`DiagnosticEvent` 无该字段；`window_id` 是窗口不是设备 | `mod.rs:184-227` |
| 跨进程传播 | **未实现**。无上下文注入机制 | — |

---

## 4. 重复实现与命名冲突清单

| # | 冲突 | 位置 | 判定 |
|---|---|---|---|
| C-1 | 诊断日志持久化 vs 三套审计表 | `diagnostics/` vs `mcp_audit_log` / `ph_audit_log` / `vault.audit` | **需收敛**：四套独立存储、独立保留期、独立查询入口 |
| C-2 | `diagnostics` 模块名撞车 ×2 | `resource_cleanup/diagnostics.rs`、`mcp/diagnostics.rs` | **需文档消歧**（功能上不是日志系统） |
| C-3 | `commands/audit.rs` 命名撞车 | `commands/audit.rs:1-8` | 实为「历史测试数据审计与清理」，与安全审计无关 |
| C-4 | 保留策略三套 | 诊断 5MB×4=25MB（数量+容量）；MCP 两段式天数；vault 硬截断 500 条 | **需统一策略语义** |
| C-5 | 事件字段契约三套 | `DiagnosticEvent` vs `mcp_audit_log` 列 vs `ph_audit_log` 列 | 需定义「审计事件」与「诊断事件」的关系与映射 |
| C-6 | 前端 console 与诊断体系并存 | 37 处生产 `console.*` | 需明确「开发期调试」与「生产日志」的边界 |

---

## 5. 安全风险点（有代码证据）

| # | 风险 | 位置 | 等级 |
|---|---|---|---|
| S-1 | **Panic 不被记录**。全仓库无 `std::panic::set_hook`，Rust panic 直接终止进程，无任何落盘记录 | 实测 `set_hook` 检索为 0 | **高** |
| S-2 | **Android 静默吞异常**。`catch (_: Exception) {}` 无日志、无上报 | `ClipboardModule.kt:63`、`Ed25519Ops.kt:59,78` | **高** |
| S-3 | **Android 无崩溃捕获**。无 `UncaughtExceptionHandler`，崩溃原因不可得 | 实测检索为 0 | **高** |
| S-4 | **配对/信任变更未进统一审计**。`mobile_sync` 的配对流程（`start_pairing` / `complete_pairing`）只写库、不写诊断日志；成功配对**完全无痕迹** | `mobile_sync/mod.rs:450`、`:568` | **高** |
| S-5 | **MCP 审计与诊断日志无关联 ID**。审计表的 `request_id` 无法在诊断中心检索 | `mcp/audit.rs` vs `mod.rs:184-227` | 中 |
| S-6 | **钥匙库审计硬截断 500 条**。高频操作会挤掉早期安全事件 | `secure_vault/store.rs:543-546` | 中 |
| S-7 | **诊断日志无时间维度保留**。只有数量/容量上限，无「7–14 天」过期 | `writer.rs:294-328` | 中 |
| S-8 | **`tracing` DEBUG 消息含自由文本**。`tracing_layer` 提取 `message` 字段后经 `sanitize_diagnostic` 处理，但自由文本仍可能被塞入业务数据 | `tracing_layer.rs:64`；`mobile_sync/server.rs` 多处 `format!` | 中 |
| S-9 | **无日志目录权限收紧**。`create_dir_all` 使用默认权限，未显式设置 | `mod.rs:427`、`writer.rs:125` | 低 |
| S-10 | **诊断目录无防篡改**。JSONL 可被任意编辑（本机威胁模型下可接受，但需在文档中明示边界） | `writer.rs:136-144` | 低（需明示） |

---

## 6. 性能相关现状

| 项 | 现状 | 证据 |
|---|---|---|
| 日志写入对业务线程的阻塞 | **受控**。`try_send` + ERROR 最多 2ms×2 重试 | `mod.rs:566-589` |
| 磁盘同步写 | **无**。200ms 批量 flush，退出时才 `sync_all` 一次 | `writer.rs:39`、`writer.rs:388-397` |
| 高频事件噪声控制 | **已实现**。后端 60s 指纹聚合 + 前端 DEBUG/INFO 常态丢弃 | `writer.rs` Aggregator；`diagnostics.ts:342-345` |
| 投屏/剪贴板/文件扫描逐条日志 | **未逐条记录**。文件拖放只记录订阅失败/恢复 | `diagnostics.ts:691-769` |
| **通用耗时指标体系** | **不存在**。无 `measureOperation` / `recordDuration` / `recordSlowOperation` 统一 API | 实测检索无命中 |
| `performance_diagnostics` 命令 | **仅 SQLite 专项**，不是通用性能指标 | `commands/system.rs:563-571` |
| 启动耗时 | **部分覆盖**。`lib.rs:1068` 有启动超时事件 | `lib.rs:1068` |
| 慢查询/锁等待 | **未实现**。无慢查询检测 | 实测检索无命中 |
| 日志系统自身性能基准 | **不存在**。无「日志开/关业务耗时差异」基准 | 实测检索无命中 |

---

## 7. 已有文档与本文档的关系

- `docs/DIAGNOSTICS.md`（699 行）是**体系 A 的技术说明与接入规范**，内容准确、
  与代码一致，**继续有效**，本文档不替代它。
- `docs/DIAGNOSTICS.md:255-263`（§15 已知限制）已记录 4 条限制，与本文档一致。
- `docs/DIAGNOSTICS.md` 引用 `tmp/acceptance/diagnostics-logging/report.md` 作为验收证据，
  但该目录**当前不存在**（实测 `ls` 失败）——属于**已声明但证据缺失**。
- `docs/architecture/` 已有 12 篇架构文档，本文档系列按仓库既有规范落在同目录。

---

## 8. 未执行 / 无法验证的检查（诚实声明）

> **本表是审计当时（2026-11-19）的状态快照**；第二阶段收尾已真实执行 `typecheck`、`cargo check`、
> Rust/Kotlin/前端定向测试、一次 Dev 诊断中心实测与 Android 真机验收，进展见 §10.4/§10.7 与
> `docs/acceptance/logging-phase2-acceptance-report.md` §8.2/§8.3/§8.4；未执行项以验收报告为准。

| 项 | 状态 | 原因 |
|---|---|---|
| Rust 单元测试实际执行 | **未执行** | 本阶段为只读审计，未执行 `cargo test` |
| 前端测试实际执行 | **未执行** | 未执行 `npm run test` |
| 完整构建 | **未执行** | 审计阶段不构建 |
| 真机/真窗口日志落盘取证 | **未执行** | 未启动应用 |
| 诊断日志实际文件内容抽样 | **未执行** | 未读取用户机器上的 `%APPDATA%` 日志目录 |
| 磁盘写满/权限不足的故障注入 | **未执行** | 属后续阶段 |
| 性能基准实测 | **未执行** | 属后续阶段 |
| Android 端真机行为 | **未执行** | 需真机/模拟器 |
| `cargo clippy` / `npm run typecheck` | **未执行** | 审计阶段未跑 |

---

## 9. 审计证据索引（可复现命令）

```bash
# 体系规模
find src-tauri/src/diagnostics -name "*.rs" | xargs wc -l
wc -l src/lib/diagnostics.ts src/components/diagnostics/DiagnosticsCenterPanel.tsx

# tracing 宏分布
grep -roh "tracing::\(trace\|debug\|info\|warn\|error\)!" src-tauri/src --include=*.rs | sort | uniq -c

# 显式诊断埋点
grep -roh "diagnostics::event\|diagnostics::emit" src-tauri/src --include=*.rs | sort | uniq -c

# Rust 文件级覆盖密度
for d in src-tauri/src/*/; do echo "$(basename $d): $(grep -rl 'tracing::\|diagnostics::event' "$d" --include=*.rs | wc -l)/$(find "$d" -name '*.rs' | wc -l)"; done

# Android 日志（预期 0）
grep -rn "Log\.[dveiw](" apps/mobile --include=*.kt | grep -v node_modules | wc -l

# Panic 钩子（预期 0）
grep -rn "panic::set_hook" src-tauri/src --include=*.rs | wc -l

# Trace/Span 概念（预期 0）
grep -rn "trace_id\|span_id\|traceId\|spanId" src-tauri/src src --include=*.rs --include=*.ts --include=*.tsx | wc -l

# 审计表清单
grep -rn "CREATE TABLE.*audit" src-tauri/src --include=*.rs
grep -rn "INSERT INTO.*audit" src-tauri/src --include=*.rs

# 前端 console 调用点
grep -rn "console\.(log|error|warn|info|debug)(" src --include=*.ts --include=*.tsx | grep -v "\.test\."
```

---

## 10. 第二阶段复核与回填（2026-11-20，logging-phase2）

> 本节是 2026-11-20 第二阶段开发后的**复核回填**；§1–§8 的 2026-11-19 审计结论保留原样，
> 与本节冲突时以本节带日期的复核为准。证据目录：`tmp/acceptance/logging-phase2/`
> （8 个子任务报告；其中 `metrics/report.md`、`trace-wiring/report.md` 因当日 D: 盘 ENOSPC
> 未落盘仓库，兜底副本在会话工作区，见验收报告证据清单）。
>
> **状态三分法**（本节与后续矩阵/报告统一口径）：
> - **已实现且已验证**：代码存在，且本轮有真实执行通过的自动化测试/命令证据；
> - **已实现未验证**：代码存在，但无设备、无 Dev 实例、未跑全量或被环境阻塞，运行时表现未取证；
> - **延期**：本阶段明确不做，记录理由与将来字段/接线约定。

### 10.1 逐项复核结论（对照 §1–§6 的 2026-11-19 缺口）

| 2026-11-19 缺口 | 第二阶段状态 | 复核依据（证据路径） |
|---|---|---|
| Android 无日志体系（B-07/B-08/C-14/D-09/E-16/J-07/K-17） | **已实现且真机验证（范围限定）**：`SafeLog.kt` / `FileLogSink.kt` / `LoggerModule.kt` / `CrashHandler.kt` 已落地 `apps/mobile/modules/logger/android/src/main/java/dev/taskdock/modules/logger/`；JVM/JS 单测与真机（vivo V2323A / Android 16）文件级验收通过：脱敏（含 metadata 键名凭据修复）、15,000 条轮转仅 3 文件/6,092,322 B、崩溃文件 650 B、Debug 启动日志落盘、最终 Release 冷启动 623 ms 且覆盖安装保留数据。Release 包内文件内容（非 debuggable/无 root）、7 天清理、低电量/不同 ROM 未覆盖 | `android-logger/report.md`；`final/android-device.md`；Kotlin **28**（SafeLog 16 / FileLogSink 12）、JS 定向 **14**、JS 全量 926（86 文件），`tsc --noEmit` 退出码 0 |
| `trace_id` 跨端链路（G-04/G-13/G-14） | **已实现且已验证（模块级）**：`DiagnosticEvent.trace_id` 已入契约（`diagnostics/mod.rs:226`），`validate_external_id` 16 位小写 hex 校验；mobile_sync pull/push 会话级共享；前端 `startTracedOperation`；shelf addPaths/runFileOp、`create_task`、`open_agent_session` 三处、工作区 copy/move 已端到端接通（16 个 trace_wiring 用例通过）。**Dev 真机端到端未执行**；工作流执行链路仍未挂 trace（P2-1） | `trace-id/report.md`（mobile_sync 90 passed、diagnostics::trace 5 passed、前端 diagnostics.test.ts 40 passed、移动端 sync 4 文件 30 passed）；`trace-wiring/report.md`（trace_wiring 16 passed、tasks 45 passed、agent/胶囊组件 130 passed） |
| `span_id` 阶段级标识（G-05） | **延期**：当前只有 `operation_id` + `trace_id`；`new_span_id()` 生成函数存在但事件结构未引入 span 字段。理由与将来字段约定见 §10.4 | `trace-id/report.md` §5 |
| 统一安全审计视图（F-06/F-16） | **已实现且已验证（Rust 适配层 + Dev 实测）**：`security_audit/adapter.rs` 四源统一投影、合并排序分页、来源覆盖状态；16 个 `security_audit` 用例通过；Dev 实测四源状态（审计日志/MCP `无事件`、保险库 `未解锁`、个人中枢 `未接入`）。`personalHub` 源 **notWired（延期接线）**；vault 解锁态真实 `VaultState` 路径未在真机验证 | `security-audit/report.md`；`final/dev-ui.md` §3.1 |
| 通用性能指标体系（H-01/H-03…H-10） | **已实现且已验证（聚合层模块级）**：`diagnostics/metrics.rs` 阈值触发 + 有界聚合 + `record_duration_async` / `OperationTimer`；14 个 metrics 用例通过；12 个业务入口已埋点（含桌面 startup/first_ready，2026-11-20 由主智能体接线，**Dev 实测 3879 ms / P95 3879 ms / 慢操作 1，单次 Debug 样本**）。**正式性能基线未执行**（无 Release 采样） | `metrics/report.md`；`final/dev-ui.md` §3.1 |
| 导出前预览 + 显式授权（I-12） | **已实现且已验证（Rust 定向 + Dev 实测）**：`export_preview` 只读扫描不落盘；前端 `ExportPreviewDialog`；13 个 query 用例、29 个诊断中心用例 + 51 个弹层定位用例通过；Dev 实测默认不勾选审计、勾选后 5→6 条/5.5→6.3 KB、取消不落盘（`final/dev-ui.md`）。**确认导出后的原生保存与窄窗/主题未走查** | `export-preview/report.md`；`diagnostics-ui/report.md`；`final/dev-ui.md` |
| 诊断中心三视图（运行诊断 / 安全审计 / 性能分析） | **已实现且 Dev 实测**：三视图、安全审计四来源状态、性能窗口与 startup 入账已在真实 Debug 实例渲染（`final/dev-ui.md`）；组件级 29 用例通过。**320/400 窄窗、深浅主题、焦点顺序未走查** | `diagnostics-ui/report.md` §5；`final/dev-ui.md` |

### 10.2 安全口径（第二阶段定稿）

- **Android 原生日志无脱敏绕过**：`LoggerModule.write` 先在原生侧独立清洗 tag/message/metadata，
  Logcat 与 `FileLogSink` **共用同一份脱敏结果**，不依赖 JS 已脱敏前提；metadata 解析失败只丢
  metadata、不丢整条日志。metadata 键名本身是凭据类别（`password/token/api_key/...`）时值统一
  `[redacted]`；Kotlin/JS 双侧 `SENSITIVE_METADATA_KEY` 同步。Kotlin `RULES` 与 JS
  `REDACT_RULES` 同序同规则，双侧各有对照矩阵用例；真机探针已复测。
- **trace_id 只做诊断关联**：绝不参与认证/授权/设备信任判断；`authenticate_device`、MCP token
  校验路径不读取 trace；非法外部 trace（大写/非 hex/长度不符/空串）丢弃并重新生成，不报错、
  不透传。测试 `trace_value_does_not_change_authentication_outcome` 验证无效令牌 + 携带 traceId
  仍 401、有效令牌 + 畸形 trace 仍 200。
- **导出含安全审计须用户显式勾选**：预览对话框中安全审计段默认关闭，勾选后才重新拉取预览；
  取消/关闭/Escape/点遮罩均不产生文件；未授权导出不触碰审计表。
- **审计来源不伪装同一张物理表**：统一视图条目 `id = <source>:<原始 id>`；不可读来源在
  `sources[]` 显式标注 `locked` / `notWired` / `error`，不返回空列表冒充无事件。

### 10.3 Android 日志容量与背压常量（取自 `FileLogSink.kt` 与 `android-logger/report.md`）

| 项 | 常量 / 策略 |
|---|---|
| 单文件软目标 | 2 MB（`MAX_FILE_BYTES`）；活动文件硬上限 4 MB（`MAX_FILE_HARD_BYTES`），超限有界丢弃并计入 `writeFailures` |
| 归档数 / 总量 | 最多 3 个（`app.log` / `app.1.log` / `app.2.log`），总量 ≤ 6 MB |
| 保留期 | 7 天（`RETENTION_MS`），init 按 mtime 清理（含崩溃文件） |
| 有界队列 | `MAX_PENDING_LOGS=256`，`HIGH_PRIORITY_RESERVED=32`；入队成功才计 pending，任务 `finally` 减 pending |
| 分级丢弃 | TRACE/DEBUG/INFO 占低级别槽位（总量 − 预留），WARN/ERROR 独立预留配额；队列满优先丢低级别，按 trace/debug/info/warn/error/other 分别计数 + `droppedCount` 总量；未初始化/已关闭/dispatcher 拒绝均静默丢弃计数，绝不阻塞调用线程、绝不抛错崩溃 |
| 轮转降级 | rename/移动失败进入降级：`rotateFailures` 连续失败计数（恢复成功后清零）用于 `rotateBackoff` 5 s 起翻倍、封顶 60 s（位移上限 10）；退避窗口内不重复 rename；每条 `writeLine` 与 `flushWriter` 都是恢复检查点（无常驻轮询定时器），**硬上限分支在退避到期时也会先尝试 rotate**，文件可用后由下一条写入自动恢复 |

真机实测（2026-11-20，vivo V2323A / Android 16）：三批 15,000 条后仅 3 个文件
（`app.1=2,097,693`、`app.2=2,097,649`、`app.log=1,893,528`），总量 **6,092,322 B**；
`rotate-probe3` 在 `app.2` 0 条、`app.1` 1,532 条，最旧一代被替换。详见
`tmp/acceptance/logging-phase2/final/android-device.md` §3.2。

### 10.4 延期项与将来约定

- **span_id 完整 Span 体系（延期）**：现状 `diagnostics::trace::new_span_id()` 生成函数已存在，
  `DiagnosticEvent` 尚未引入 `span_id` 字段。延期理由：① 现有 `operation_id` 已承担父子关联
  （父操作 ID + 阶段标识）；② 批量导入/移动等扇出场景的子阶段边界尚未定稿，先定 span 命名与
  父子约定容易返工；③ 高频事件（拖拽、轮询、通知对账）按契约不建 span。将来落地预留：
  `DiagnosticEvent` 增加可选 `span_id: Option<String>` 与 `parent_span_id: Option<String>`，
  serde `default` + `skip_serializing_if = "Option::is_none"`；span 仅挂在扇出父操作与其子阶段
  事件上，高频链路事件不分配 span。本次未改事件序列化结构，旧日志读入不受影响。
- **personalHub 审计源未接线（notWired）**：Hub 运行在独立进程二进制 `taskdock-personal-hub`，
  主 Tauri 进程未托管任何 `HubApi`/`HubStore` State；Named Pipe 协议仅暴露 identity/pairing/
  devices，无审计读取方法；`ph_audit_log` 只在独立进程的 `hub.db` 连接内可写。`HubAuditReader`
  trait 已预留，待管道协议/主进程 State 增加只读方法后接入。
- **Release 专属项未按集成流程执行**：安装包生成、安装/升级/卸载、签名与更新机制、生产环境资源
  加载、正式性能基线，本阶段为 Dev/真机功能验收；已用当前工作树构建临时 arm64 Release APK
  （33,513,751 B / SHA256 `B3D6C6F2…9BEECE`）并真机安装，但非集成快照、无 buildId，不能作为
  正式 Release 结论。
- **整 `cargo test --lib` 受其他任务在途文件阻塞（ENVIRONMENT BLOCKED，非本任务缺陷）**：
  在途未跟踪文件 `src-tauri/src/agent_access/tests_v82_rest.rs` 存在 raw byte string 含非 ASCII
  字节的语法错误，导致测试目标整包无法编译；本阶段各子任务以定向 `cargo test --lib <模块>` +
  `cargo check --lib` 证明改动，阻塞解除后需复测全量。
- **桌面 startup（startup/first_ready）埋点：已实现且 Dev 实测单次入账**。`metrics.rs` 阈值表
  已含 `startup` 3000 ms；`lib.rs` 的 `STARTUP_START` 在 `run()` 入口置起点，
  `commands::system::notify_ui_ready` 首次就绪时调用
  `metrics::record_duration_async("startup", "first_ready", start)` 收尾。Dev 诊断中心实测
  3879 ms / P95 3879 ms / 慢操作 1（`final/dev-ui.md` §3.1），单次 Debug 样本；正式 Release
  性能基线仍未执行。

### 10.5 本轮主智能体静态检查（来源：主智能体执行）

| 命令（工作目录 `D:\Develop\task_dock`） | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck`（`tsc --noEmit`） | 0 | 无类型错误（2026-11-20 16:xx 复跑，53.1 s） |
| `npm run cargo -- check --lib`（`CARGO_TARGET_DIR=C:\taskdock-target-lp2`） | 0 | lib 编译通过；36 条既有警告（均为其他在途文件既有告警），无新增阻断性错误（40.3 s） |
| `gradlew.bat :logger:testDebugUnitTest --rerun-tasks` | 0 | BUILD SUCCESSFUL；**28 用例**（SafeLog 16 / FileLogSink 12），failures=0 errors=0；后续新增 metadata 键名用例 |
| Rust 定向套件（经嵌入 Common-Controls 清单的测试二进制） | 0 | trace_wiring 16、security_audit 16、mobile_sync 90、tasks 45、shelf 7、agents 4、fsops 35、recycle 4 全部通过；diagnostics 109 通过 / 2 ignored |
| `cargo test --lib mcp` | 101 | 71 passed / 1 failed：`taskdock_collab_create_issue` 缺并发令牌字段（其他任务在途 schema，非本任务） |

> 测试二进制说明：本机 GNU toolchain 的 `task_dock_lib-*.exe` 未内嵌 Common-Controls 6.0
> 清单，链接到的 `comctl32!TaskDialogIndirect` 在加载期报 `STATUS_ENTRYPOINT_NOT_FOUND`
> （0xc0000139）。收尾复验用 `mt.exe` 将主程序清单嵌入测试二进制副本后执行；这是环境/构建
> 缺口，不是测试失败，正式修复需在构建脚本为测试目标补清单。

### 10.6 环境事故记录（D: 盘 ENOSPC）

本轮收尾阶段 D: 盘写满至 **0 字节可用**，多个子任务的后台复测与报告落盘失败（`os error 112`）。
主智能体删除可再生构建产物 `src-tauri/target/debug`（约 8.0 GB）后恢复约 7.0 GB 可用空间。
受影响：部分定向套件仅在前台控制台真实执行通过，落盘复测日志为 ENOSPC 阻塞记录（不作为测试
失败证据）；`metrics`、`trace-wiring` 两份 `report.md` 兜底落在会话工作区（**收尾阶段已复制入
仓库 `tmp/acceptance/logging-phase2/{metrics,trace-wiring}/`**）。事故不影响已在绿构上跑通的
用例结论，但全量复测仍需在阻塞解除后补做；Android 真机验收已由 §10.7 完成（范围限定）。

### 10.7 Android 真机回填（2026-11-20 18:20–19:33）

- **设备/包**：vivo V2323A，Android 16 / API 36，`arm64-v8a`；`dev.taskdock.mobile` v0.1.20（68）。
  最终临时 Release APK 33,513,751 B / SHA256 `B3D6C6F2…9BEECE`（当前工作树，非集成快照）。
- **脱敏**：真机发现 metadata 键名型凭据泄漏（`password=P@ssw0rd`），Kotlin/JS 双侧新增
  `SENSITIVE_METADATA_KEY` 后复测 `password/token/api_key/email=[redacted]`、`path=[path]`、
  nested 丢弃，原始敏感串 0 命中；Kotlin 28、JS 14、`tsc` 0。
- **容量/轮转**：15,000 条后仅 3 文件、总量 6,092,322 B，最旧一代被替换。
- **崩溃/启动**：`am crash` 生成 `crash-20261120-183856-11044.txt`（650 B，10 帧，无敏感路径）；
  Debug 启动日志已落盘（18:52:54）；最终 Release 停 Metro 后冷启动 623 ms、Logcat
  `19:33:41 I app: 应用启动`，覆盖安装保留 SQLite/5 条任务。
- **修复的真实问题**：metadata 键名凭据（P1）；`LoggerModule.write` 前 `FileLogSink` 未初始化
  （P2）；`ClipboardModule.kt` / `Ed25519Ops.kt` 漏 `SafeLog` import（P2，Release 编译失败）。
- **边界**：Release 非 debuggable/无 root，包内文件内容未直接复核；7 天清理、低电量/后台限制、
  不同 ROM 未测；正式 Release 验收（集成快照、安装/升级/卸载、签名、生产资源加载、正式性能
  基线）仍未执行。详见 `tmp/acceptance/logging-phase2/final/android-device.md`。
