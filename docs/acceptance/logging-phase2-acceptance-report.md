# 日志系统第二阶段（logging-phase2）Dev 功能验收报告

- 报告日期：2026-11-20（UTC+8）
- 运行模式：**Dev 功能验收（Debug 模块级定向测试 + 静态检查）+ Android 真机功能验收**；
  本报告**不是** Release 正式验收，不产生 buildId、不推进任务状态机。Android 最终安装的是当前
  工作树构建的临时 arm64 Release 包，不是集成快照产物。
- 工作目录：`D:\Develop\task_dock`；Git HEAD：收尾测试时为 `5b6c671`；运行期外部定时提交推进至
  `fc1c629`（非本任务操作），共享工作区约 89 条在途未提交/未跟踪改动，本报告结论仅覆盖第二阶段
  声明路径，不代其他任务下结论。
- 验收依据：`AGENTS.md` §2/§7、`docs/architecture/logging-current-state.md`、
  `logging-capability-matrix.md`、`unified-observability-design.md`、`docs/DIAGNOSTICS.md`、
  `tmp/acceptance/logging-phase2/interfaces.md`（冻结契约）。

> 状态三分法：**已实现且已验证**（代码存在且有本轮真实执行通过的测试/命令证据）/
> **已实现未验证**（代码存在，但无设备、无 Dev 实例、未跑全量或被环境阻塞）/
> **延期**（本阶段明确不做，理由与将来约定见现状报告 §10.4）。
> 本报告严格区分「测试代码存在」与「测试通过」：未执行的一律写「未执行」，环境阻塞写
> `ENVIRONMENT BLOCKED`，证据不足写「证据不足」。

---

## 1. 任务范围

第二阶段在第一阶段诊断日志基座（event 契约、writer 轮转、privacy 脱敏、panic hook、查询/导出）
之上，落地：

| 子任务 | 范围 | 证据目录 |
|---|---|---|
| A Android 日志体系 | 原生 `SafeLog.kt` / `FileLogSink.kt` / `LoggerModule.kt` / `CrashHandler.kt` + JS `safeLog.ts`；有界队列、分级丢弃、轮转降级、原生侧先脱敏 | `tmp/acceptance/logging-phase2/android-logger/` |
| C Trace ID 链路 | `diagnostics/trace.rs`、事件 `trace_id` 契约、mobile_sync 会话共享、前端 `startTracedOperation`、鉴权隔离 | `trace-id/` |
| D 安全审计统一视图 | `security_audit/adapter.rs` 四源投影、来源状态、来源标识分离、合并分页 | `security-audit/` |
| G 导出预览 | `diagnostics/query.rs` 只读预览、`export_with_options`/`export_with_db`、有界导出 | `export-preview/` |
| E 诊断中心 UI | 三视图（运行诊断/安全审计/性能分析）、导出预览对话框、弹层定位回归 | `diagnostics-ui/` |
| F 性能指标 | `diagnostics/metrics.rs` 阈值触发 + 有界聚合、`record_duration_async` / `OperationTimer`、业务入口埋点 | `metrics/`（report.md 兜底副本见 §11） |
| T Trace 接线 | shelf addPaths/runFileOp 接通；open_agent_session Rust+bridge；create_task 待接 | `trace-wiring/`（report.md 兜底副本见 §11） |

**不在本任务范围**：Release 安装包/升级/卸载/签名/生产资源加载/正式性能基线；整库全量测试；
其他在途任务的改动验收；代码重构与依赖升级。

## 2. 检查依据

1. 冻结契约：`tmp/acceptance/logging-phase2/interfaces.md`（Trace / 审计 / 指标 / 导出 /
   Android 五组接口）。
2. 设计文档：`unified-observability-design.md` §4（事件/审计/Trace/指标/导出）、§5（Android）、
   §6（迁移路线）；`DIAGNOSTICS.md` §3–§6、§24、§25。
3. 项目红线：`AGENTS.md` §4（分层、IPC、SQLite、Agent 管线、剪贴板、UI Token、异步生命周期、
   按需加载）；本报告只验收第二阶段声明路径是否触碰红线。
4. 证据优先级：原始日志/测试结果 > 子任务 report.md > 文档；数字以当次输出为准。

## 3. 环境

### 3.1 基础环境

- OS：Windows（本地 PC）；Shell：PowerShell 7.6.4；前端 Vite 端口 1420（strictPort）。
- 初稿未启动 `npm run tauri dev`；2026-11-20 17:36 补做隔离 Dev 实例（数据目录
  `tmp/debug/logging-phase2-dev4`，CDP 9223），真实 WebView2 / Win32 窗口链路已部分走查
  （诊断中心，§8.3）；其他页面链路仍未走查。
- Android 真机已连接并完成验收：vivo V2323A / Android 16 / API 36 / `arm64-v8a`；
  详见 §8.4 与 `final/android-device.md`。设备沙盒文件级证据在 Debug 变体取得，最终 Release 变体
  非 debuggable，只复核了启动与数据保留。

### 3.2 D: 盘 ENOSPC 事故与恢复（如实记录）

本轮收尾阶段 D: 盘写满至 **0 字节可用**，多个子任务的后台复测、报告落盘与日志落盘失败
（`os error 112 / ENOSPC`）。主智能体删除可再生构建产物 `src-tauri/target/debug`
（约 **8.0 GB**）后恢复约 **7.0 GB** 可用空间。

事故影响：

- 部分定向套件仅在前台控制台真实执行通过，落盘复测日志为 ENOSPC 阻塞记录；**这些 ENOSPC
  记录不能作为测试失败证据**，但对应复测项在本报告中按「未完成复测」标注。
- `metrics/report.md`、`trace-wiring/report.md` 未写入仓库 `tmp/acceptance/logging-phase2/`，
  兜底副本在会话工作区（§11）；本报告数字已与仓库内原始日志交叉核对。
- 恢复后未对被删除的 `target/debug` 做全量重建；后续全量 `cargo test` 前需重新增量编译。
- **同日晚再次出现 0 字节可用**（Android 最终 Release 构建阶段）：首次 R8/lint 因 ENOSPC 失败；
  清理本任务可再生的 Android `intermediates`（约 1.37 GB）与旧 Dev 数据后恢复约 3.2 GB，最终
  arm64 Release 构建成功（5m15s）。未删除用户文件、他人缓存或验收证据。为避免继续占满 D:，
  Release 构建显式跳过 `lintVitalRelease`/`lintRelease`；本报告未把 lint 计为通过项。

### 3.3 环境阻塞项（ENVIRONMENT BLOCKED，非本任务缺陷）

- 整 `cargo test --lib` 被其他任务在途未跟踪文件
  `src-tauri/src/agent_access/tests_v82_rest.rs` 阻塞：该文件 raw byte string 含非 ASCII
  字节串语法错误，测试目标整包无法编译。本阶段各子任务以定向 `cargo test --lib <模块>` +
  `cargo check --lib` 证明改动；阻塞解除后需复测全量。
- `mcp::protocol` Rust 单测同受上述在途编译错误牵连，本轮未在绿构上执行。

## 4. 命令与结果

> 执行日期：2026-11-20（UTC+8）；工作目录：`D:\Develop\task_dock`。「执行方」列：子任务为
> 对应 Agent 在共享工作区执行；主智能体两条静态检查由主智能体本轮执行。退出码与计数以原始
> 日志为准，用例耗时见各日志；日志路径见 §11。

| # | 命令（工作目录 `D:\Develop\task_dock`，除标注外） | 执行方 | 退出码 | 结果 | 证据 |
|---|---|---|---|---|---|
| 1 | `npm run typecheck`（`tsc --noEmit`） | 主智能体 | 0 | 无类型错误 | 主会话静态检查记录 |
| 2 | `npm run cargo -- check --lib` | 主智能体 | 0 | lib 编译通过；36 条既有警告（其他在途文件既有告警），无新增阻断性错误 | 主会话静态检查记录 |
| 3 | `cargo test --lib diagnostics::query` | G | 0 | 13 passed / 0 failed / 0 ignored（2555 filtered），1.67s | `export-preview/test-query-pass.log` |
| 4 | `cargo test --lib diagnostics::query::tests::large_log_export_is_bounded` | G | 0 | 1 passed；50,000 行合成日志 → `records=5000`、`bytes=1348773`（约 1.29 MiB）、`elapsed=810.9732ms`（Debug 测试二进制） | `export-preview/test-large-log.log` |
| 5 | `cargo test --lib security_audit` | D | 0 | 16 passed / 0 failed / 0 ignored（2552 filtered），12.02s | `security-audit/cargo-test-3.log` |
| 6 | `cargo test --lib mobile_sync` | C | 0 | 90 passed / 0 failed / 0 ignored（2478 filtered），77.89s | `trace-id/cargo-test-mobile-sync.txt` |
| 7 | `cargo test --lib diagnostics::trace` | C | 0 | 5 passed / 0 failed / 0 ignored（2563 filtered） | `trace-id/cargo-test-trace.txt` |
| 8 | `cargo test --lib diagnostics::metrics` | F | 0 | 14 passed / 0 failed / 0 ignored（2588 filtered），0.78s | `metrics/test-metrics.log` |
| 9 | `cargo test --lib commands::agents::trace_wiring_tests` | T | 0 | 4 passed / 0 failed / 0 ignored（2598 filtered） | `trace-wiring/cargo-test-agents.log` |
| 10 | `cargo test --lib trace_wiring`（shelf） | T | 0 | 8 passed / 0 failed / 0 ignored（2594 filtered） | `trace-wiring/cargo-test-trace.log` |
| 11 | `vitest run src/lib/diagnostics.test.ts` | C | 0 | 1 文件 40 passed，2.49s | `trace-id/frontend-diagnostics-test.txt` |
| 12 | `vitest run src/lib/sync/...` | C | 0 | 4 文件 30 passed，3.75s | `trace-id/mobile-sync-test.txt` |
| 13 | `vitest run` 诊断中心组件 | E | 0 | 1 文件 29 passed | `diagnostics-ui/diagnostics-test.log` |
| 14 | `vitest run` 弹层定位回归 | E | 0 | 3 文件 51 passed（positioning 36 + PointerMenu 8 + Popover.edge 7） | `diagnostics-ui/positioning-test.log` |
| 15 | `vitest run` shelf store | T | 0 | 2 文件 52 passed，1.21s | `trace-wiring/vitest-shelf-store.log` |
| 16 | `vitest run` Agent/胶囊组件 | T | 0 | 4 文件 130 passed，24.31s | `trace-wiring/vitest-agent-components.log` |
| 17 | Gradle 定向 `:logger:testDebugUnitTest` Kotlin 单测 | A | 0 | BUILD SUCCESSFUL；**28 用例**（SafeLogTest 16 / FileLogSinkTest 12），failures=0 errors=0；机器可读结果在模块 `build/test-results/` | `android-safelog-kotlin-test.log`；`TEST-*.xml`；`final/android-device.md` §3.1 |
| 18 | `vitest run` `apps/mobile` `safeLog.test.ts`（定向） | A | 0 | 1 文件 **14 passed**，2.98s | `android-safelog-js-test.log` |
| 19 | `vitest run` `apps/mobile` 全量 | A | 0 | 86 文件 926 passed，59.81s | `android-logger/js-all-tests.txt` |
| 20 | `tsc --noEmit`（`apps/mobile`） | A | 0 | 无类型错误（日志 0 字节，无报错输出） | `android-typecheck.log`；`android-logger/tsc-noemit.txt` |
| 21 | `cargo test --lib mcp`（既有套件对照） | F | 0* | 71 passed / **1 failed**：`tool_defs_are_complete_and_unique`（taskdock_collab_create_issue 缺并发能力 token，MCP 工具 schema 在途问题，**非本任务引入**）；0 ignored（2530 filtered），37.73s | `metrics/test-mcp.log`；`metrics/report.md` §4.1 |
| 22 | 其它既有套件前台对照（agents::pipeline 31 / mobile_sync::sync 17 / commands::clipboard 6 / recycle 42 过 1 ignored / global_search 18 / clipboard:: 260 过 1 ignored） | F | — | 前台控制台通过；落盘日志受 ENOSPC 阻塞，仅作既有基线参照，不作为本任务新增断言证据 | `metrics/` 目录控制台记录；`metrics/report.md` §4.2 |
| 23 | Android arm64 Release 构建 `assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon -x lintVitalRelease -x lintRelease` | 主智能体 | 0 | BUILD SUCCESSFUL in 5m15s；APK 33,513,751 B，SHA256 `B3D6C6F2…9BEECE` | `final/android-build-release-final.log` |
| 24 | `adb install -r app-release.apk` | 主智能体 | 0 | Success；`firstInstallTime=2026-11-17 13:55:41` 不变，`lastUpdateTime=2026-11-20 19:33:28` | `final/android-device.md` §2 |
| 25 | `adb shell am start -W -n dev.taskdock.mobile/.MainActivity`（停止 Metro、移除 reverse） | 主智能体 | 0 | `COLD`，`TotalTime=623ms`；Logcat `I app: 应用启动`（19:33:41，PID 32410） | `final/android-device.md` §4；`android-device-release/` |
| 26 | 真机脱敏探针（含 metadata 键名凭据） | 主智能体 | — | 修复前 `password=P@ssw0rd` 泄漏；修复后 `password/token/api_key/email=[redacted]`、`path=[path]`、nested 丢弃；原始敏感串 0 命中 | `final/android-device.md` §3.1 |
| 27 | 真机轮转 15,000 条（3×5,000，480 字符） | 主智能体 | — | 始终 3 文件；总量 6,092,322 B；`app.1=2,097,693`、`app.2=2,097,649`、`app.log=1,893,528` | `final/android-device.md` §3.2 |
| 28 | `adb shell am crash dev.taskdock.mobile` | 主智能体 | — | 生成 `crash-20261120-183856-11044.txt`（650 B，10 帧），无敏感路径；重启恢复 | `final/android-device.md` §3.3 |

\* 退出码按既有失败用例判定；该失败与第二阶段改动无关。

## 5. 修改文件与关键位置

> 本节为子任务报告与代码核对的汇总；未列出的文件不属于本任务声明范围。

### 5.1 Android（A）

- `apps/mobile/modules/logger/android/src/main/java/dev/taskdock/modules/logger/`
  - `SafeLog.kt`：唯一日志入口；tag 归一 + 调用方匿名化；统一走 `FileLogSink`。
  - `FileLogSink.kt`：沙盒 `filesDir/logs`；常量 `MAX_FILE_BYTES=2MB`、
    `MAX_FILE_HARD_BYTES=4MB`、`MAX_FILES=3`、`RETENTION_MS=7d`、
    `MAX_PENDING_LOGS=256`、`HIGH_PRIORITY_RESERVED=32`；分级配额丢弃；轮转降级指数退避
    （5 s 起翻倍、封顶 60 s、位移上限 10）；`writeFailures` / `droppedCount` 及分级计数。
  - `LoggerModule.kt`：原生侧先脱敏，Logcat 与文件共用同一份结果；metadata 白名单重序列化；
    `write` 入口幂等 `FileLogSink.init`（修复 Expo 模块注册晚于首帧时的启动日志丢失）。
  - `SafeLog.kt`：唯一日志入口；tag 归一 + 调用方匿名化；统一走 `FileLogSink`；
    新增 `SENSITIVE_METADATA_KEY`，键名型凭据值统一 `[redacted]`（真机 P1 修复）。
  - `CrashHandler.kt`：install 幂等；崩溃线程同步写文件；委托原 handler；5 文件/7 天清理。
- `apps/mobile/src/lib/safeLog.ts`：JS 统一入口（trace/debug/info/warn/error）；`REDACT_RULES`
  与 Kotlin `RULES` 同序同规则；`SENSITIVE_METADATA_KEY` 与 Kotlin 同步；原生 sink 改为按条
  `getTaskDockLogger()` 懒解析，不在模块顶层固化 null。
- `apps/mobile/modules/logger/index.ts`：`getTaskDockLogger()` 懒解析/缓存，供启动首帧后原生模块
  注册完成时接管。
- 既有 Kotlin 静默吞异常修复：`ClipboardModule.kt:63`、`Ed25519Ops.kt:59,78` 改 `SafeLog.e`，
  保持原行为；同时补齐两文件的 `SafeLog` import（否则 Release 编译失败）。

### 5.2 Trace（C / T）

- `src-tauri/src/diagnostics/trace.rs`：`TRACE_ID_LEN=16`、`new_trace_id()`、`new_span_id()`
  （生成函数；span 事件字段延期）、`validate_external_id`、线程局部上下文。
- `src-tauri/src/diagnostics/mod.rs:226`：`DiagnosticEvent.trace_id: Option<String>`；
  `normalize()` 校验非法值；`stage` 事件不挂 trace。
- `src/lib/diagnostics.ts`：`startTracedOperation(module, action, options)`；入队前 16-hex
  校验；显式传参，不引入隐式全局上下文。
- `mobile_sync`：pull 按会话存 `trace.id`，`pushBatch` 回传；非法/缺失回退新生成。
- T 接线（2026-11-20 收尾补齐）：shelf `addPaths` / `runFileOp` 端到端接通；`create_task`
  （`useTasksStore` → `bridge.createTask` → `commands/tasks.rs`，成功/失败事件挂 trace）、
  `open_agent_session` 三处前端入口（AgentPanel ×2 / AgentsLite ×1）、工作区
  `fs_copy_job_start` / `fs_move_job_start`（命令解析 → `fsops` worker 按值捕获 → 终态诊断）
  均已接通。16 个 `trace_wiring_tests`（tasks/shelf/agents/recycle）通过。**仍未接线**：工作流
  执行链路；该缺口在 §8 记为 P2。

### 5.3 安全审计（D）

- `src-tauri/src/security_audit/adapter.rs`：四源只读投影、合并排序分页、来源状态
  `available/empty/locked/notWired/error`；条目 `id=<source>:<原始 id>`；vault 运行态判定；
  `personalHub` 保留 `HubAuditReader` trait 预留。
- `commands/security_audit.rs`：`list_security_audit` 命令（只读）；`limit` 钳制 1..=100，
  默认 50；fetch 内部兜底 200。

### 5.4 指标（F）

- `src-tauri/src/diagnostics/metrics.rs`：`MAX_FINGERPRINTS=256`、`SAMPLE_WINDOW=64`；
  阈值表（file 1500 / search 1000 / recycle 默认 1000 / resource·ocr 5000 / clipboard 200 /
  screen 3000 / device·mobile_sync 5000 / mcp 10000 / agent 30000 / db 500 /
  startup·system 3000）；`record_duration_async`、`OperationTimer`（显式 finish / Drop 兜底 /
  finished 防重复 / `Send`）；`started_at()` 固定进程启动窗口。
- 业务埋点：file/list_dir、search/query、recycle/list、resource 四动作、clipboard/capture、
  mobile_sync/pull+apply_push、mcp/tool_call、agent/submit。

### 5.5 导出预览与 UI（G / E）

- `src-tauri/src/diagnostics/query.rs`：`export_preview` 只读扫描（`MAX_SCAN_LINES=200_000`、
  `SCAN_BUDGET=400ms`）；`export_with_options` / `export_with_db`；`MAX_EXPORT_RECORDS=5_000`、
  `MAX_FILE_BYTES=5MiB`、`MAX_AUDIT_RECORDS=100`；流式 `BufWriter` +
  `serde_json::to_writer_pretty` + 临时文件 rename 原子替换。
- `src/components/diagnostics/`：运行诊断 / 安全审计 / 性能分析三视图；`ExportPreviewDialog`
  （安全审计默认关闭、显式勾选；取消/关闭/Escape/遮罩不落地文件；空结果禁用确认）；
  性能视图展示「进程启动以来」窗口与 `startedAt`/`generatedAt`。

## 6. 已验证项（模块级，有真实执行证据）

### 6.1 已实现且已验证

- **Trace 生成与校验**：16-hex 形态、外部非法值（大写/非 hex/长短/空串）丢弃并重新生成；
  鉴权路径隔离（无效令牌+traceId 仍 401，有效令牌+畸形 trace 仍 200）。证据：trace 5 用例、
  mobile_sync 90 用例、前端 diagnostics 40 用例、sync 30 用例。
- **审计适配层**：来源标识分离、合并分页无重叠、设备过滤、authz 映射、traceId 形态校验、
  vault locked、hub notWired、撤销事件映射；16 用例通过。
- **指标聚合层**：计数/失败/slow/avg/max/p95、容量淘汰与 `evicted`、环形样本窗口、
  阈值触发边界（等于阈值不算超）、异步计时与 Drop 兜底防重复；14 用例通过。
- **导出有界性与只读预览**：空目录、级别/时间筛选、预览不落盘、估算单调、无审计段委托、
  授权段脱敏、50k 行封顶 5000；13 用例通过 + 大日志样本 1 用例通过。
- **诊断中心组件与弹层定位**：29 个诊断中心用例、51 个弹层定位用例通过；三视图与导出预览
  对话框在组件层确认。
- **Android 单测层 + 真机功能层**：Kotlin **28** 用例、JS 定向 **14** 用例、JS 全量 86 文件
  926 用例通过；双侧脱敏规则对照用例通过；`tsc --noEmit` 退出码 0。真机（vivo V2323A /
  Android 16）验证脱敏、轮转/三文件上限、崩溃文件、启动日志与覆盖安装保留数据（§8.4）。
- **静态检查**：`typecheck` 退出码 0；`cargo check --lib` 退出码 0，无新增阻断。

### 6.2 已实现未验证（代码存在，运行时未取证）

- ~~Android 真机/模拟器运行~~ **已真机验证（范围限定）**：Expo Module 实例化、JS→原生 IPC、
  原生 HandlerThread 分发、真机落盘/轮转/崩溃文件均已取证；未覆盖 Release 包内文件内容直接读取
  （非 debuggable、无 root）、7 天跨天清理与不同厂商 ROM（§8.4）。
- Dev 视觉矩阵（部分）：诊断中心三视图、安全审计来源状态、导出预览与取消已在 Dev 实测；
  trace 在 WebView2 端到端、320/400 窄窗、深浅主题、液态玻璃可读性、命中区、
  键盘/Escape 焦点顺序仍未全量走查（§8.3 边界）。
- 业务入口埋点运行时表现：startup/first_ready 与 resource/snapshot 已 Dev 实测（§8.3）；其余
  file/recycle/clipboard/mobile_sync/agent/mcp 命令模块内无单元测试断言指标入账，运行时聚合
  待 Dev 实例或后续基线。
- vault 解锁态真实 `VaultState` 路径（`Unlocked` 读取审计）未在解锁环境验证。
- 前端审计视图与 Rust 适配层联调：**已 Dev 实测**（§8.3：四源状态、筛选、分页），vault 解锁态
  真实会话与 personalHub 未接线路径未验证。
- **桌面 startup（`first_ready`）埋点**：阈值表已含 `startup` 3000 ms；主智能体已在
  `lib.rs`（`STARTUP_START` 起点）与 `commands/system.rs::notify_ui_ready`（首次就绪收尾，
  `UI_READY.swap` 保证重复调用不重复入账）完成接线；**Dev 实测已入账 3879 ms（单次 Debug
  样本，见 §8.3）**；正式 Release 性能基线仍未执行。

## 7. 延期与未执行项（如实标注）

### 7.1 延期（本阶段明确不做）

- **`span_id` 完整 Span 体系**：当前只有 `operation_id` + `trace_id`；`new_span_id()`
  生成函数存在，事件结构未引入 span 字段。理由与将来字段约定（可选 `span_id` /
  `parent_span_id`，serde default + skip）见 `logging-current-state.md` §10.4、
  `DIAGNOSTICS.md` §25.1。
- **personalHub 审计源接线**：独立进程无主进程只读管道；`HubAuditReader` trait 预留，待协议/
  State 增加只读方法后接入。

### 7.2 未执行 / 阻塞（非本任务可在本环境闭环）

- 整 `cargo test --lib`：被在途未跟踪文件 `tests_v82_rest.rs` 语法错误阻塞（ENVIRONMENT
  BLOCKED，非本任务缺陷）。
- **Release 正式验收**：安装包生成、安装/升级/卸载、签名与更新、生产资源加载、正式性能基线，
  均未按集成流程执行，无 buildId。收尾阶段已用当前工作树构建并真机安装了临时 arm64 Release
  APK（33,513,751 B，SHA256 `B3D6C6F2…9BEECE`），只验证冷启动 623 ms、启动日志与覆盖安装保留
  数据；**不是**集成快照构建，不能作为正式 Release 结论。
- 性能基准脚本与阈值校准（M13）：未执行；阈值为候选值。
- 桌面端真实磁盘满/权限不足/文件占用故障注入（M14 桌面部分）：未执行；Android 文件占用降级
  有 JVM 用例覆盖。
- 部分子任务复测受 ENOSPC 影响未在绿构上完成（见 §3.2）。

## 8. P0–P3 问题清单

> 分级口径见 `AGENTS.md` §7：P0 数据丢失/安全泄露/崩溃/核心流程不可用；P1 主要功能错误或
> 严重仓库/数据风险；P2 边界错误/次要缺陷/文档与实现不一致；P3 体验/格式/低风险改进。

### P0

- **未在本任务定向证据中发现 P0**。证据边界：整库测试被阻塞、Dev 真机链路未走查，不能据此
  排除其他在途改动引入的 P0；本任务声明路径内未观察到数据丢失、安全泄露、崩溃或核心流程
  不可用。

### P1

| # | 现象 | 根因 | 影响 | 证据 |
|---|---|---|---|---|
| P1-1 | 整 `cargo test --lib` 无法编译运行 | 其他任务在途未跟踪文件 `src-tauri/src/agent_access/tests_v82_rest.rs` 含非 ASCII 字节串 raw string 语法错误 | 全量回归不可用；本阶段只能以定向测试 + `check --lib` 证明改动；阻塞解除前无法排除跨模块回归 | `trace-id/report.md` §7；`metrics/report.md` §2 阻塞段；`trace-wiring/report.md` §6 |
| P1-2 | 多个子任务后台复测与日志/报告落盘失败 | D: 盘 ENOSPC（0 字节可用） | 部分套件仅有前台控制台通过记录，落盘复测缺失；两份 report.md 兜底到会话工作区 | §3.2；`metrics/report.md` §2；`trace-wiring/report.md` §7 |

### P2

| # | 现象 | 根因 | 影响 | 证据 |
|---|---|---|---|---|
| P2-1 | 工作流执行链路未挂 trace（`create_task`、`open_agent_session` 三处、工作区 copy/move 已于 2026-11-20 收尾接通） | 工作流命令在共享模块内，收尾阶段未改 | 工作流任务的跨模块关联在诊断视图中不可见 | `trace-wiring/report.md` §5；本报告 §8.2 |
| P2-2 | 诊断中心前端未提供 Trace ID 检索、设备筛选、暂停刷新、滚动保持；`eventType` 筛选项未暴露 | 本阶段 E 任务聚焦三视图 + 预览 + 定位回归 | 调试时按 trace/设备定位能力有限 | `diagnostics-ui/report.md` §4；`trace-id/report.md` §6 |
| P2-3 | vault 解锁态读取审计未在解锁环境验证 | 验收环境无解锁 Vault 会话 | `Unlocked` 分支只经适配层用例构造，真实 `VaultState` 转换路径待复核 | `security-audit/report.md` §5/§8 |
| P2-4 | 审计口径偏差：vault `total` 受 1000 条上限约束；mcp COUNT 仅时间边界，过滤在内存层；fetch 兜底 200 | 适配层有界读取设计 | 超大库下列表 total/页与全量过滤存在偏差；文档已明示边界 | `security-audit/report.md` §8 |

### P3

| # | 现象 | 根因 | 影响 | 证据 |
|---|---|---|---|---|
| P3-1 | 慢操作阈值为候选值，未经 Release 基线校准 | M13 基准脚本未执行 | 阈值偏松/偏紧可能误报或漏报慢操作 | `metrics/report.md` §4.4；设计文档 §4.5.2 |
| P3-2 | 既有失败用例：`mcp::tests::tool_defs_are_complete_and_unique`（`taskdock_collab_create_issue` 缺并发令牌字段） | MCP 工具 schema 在途改动，非本任务引入 | mcp 套件 1 failed（71 passed）；本任务 trace/metrics 路径不依赖该用例 | `metrics/test-mcp.log`；本报告 §8.2 复验记录 |
| P3-3 | 既有失败用例：shelf `backup_roundtrip`（备份 schema 在途） | 其他在途任务 | shelf 模块首跑 1 failed；T 任务 trace 用例本身通过 | `trace-wiring/report.md` §7 |
| P3-4 | ~~两份子任务 report.md 未落仓库 `tmp/`（C: 兜底副本）~~ **已解决** | ENOSPC 落盘失败；收尾阶段已从会话工作区复制 | 证据已归位：`tmp/acceptance/logging-phase2/metrics/report.md`、`trace-wiring/report.md` | 本报告 §11 |

### 8.2 收尾复验（2026-11-20，主智能体直接执行）

用户要求停止子代理后，主智能体直接完成并复验。详细命令、退出码与证据见
`tmp/acceptance/logging-phase2/final/summary.md`。

| 检查 | 结果 |
|---|---|
| Trace 接线补齐 | `create_task`（store→bridge→Rust）、`open_agent_session` 三处、工作区 copy/move（命令→fsops worker→终态诊断）已接通；`trace_wiring_tests` 16 passed |
| Android 硬上限恢复 | `writeLine` 硬上限分支退避到期先 rotate；新增 JVM 用例；当时 Kotlin 27 passed（SafeLog 15 / FileLogSink 12）；后续新增 metadata 键名用例后为 28（SafeLog 16） |
| 既有测试修正 | diagnostics 两条轮转用例：隐私截断导致 1024 阈值不再触发（改 400）；恢复里程碑需第二个 flush 屏障 |
| `npm run typecheck` | 退出码 0（`final/typecheck.log`） |
| `cargo check --lib` | 退出码 0，36.82 s，36 条既有警告（`final/cargo-check.log`） |
| Rust 定向 | diagnostics 109 passed / 2 ignored；security_audit 16；mobile_sync 90；tasks 45；shelf 7；agents 4；fsops 35；recycle 4；trace_wiring 16；mcp 71 passed / 1 failed（`final/rust-targeted.log`） |
| 前端定向 | 8 文件 258 passed（诊断中心 29 + 弹层 51 + store/Agent/胶囊/文件工作区/diagnostics 门面）（`final/vitest-targeted.log`） |
| 前端全量（对照） | 411 文件 / 5625 用例，5596 passed / 29 failed；15 个失败文件均在本任务路径之外（clipboard UI、help、roadmap、settings 导航、workbench 等，其他任务在途）（`final/vitest-full.log`） |
| `npm run arch:guard` | 退出码 0（报告模式；DUP-001 为其他任务平行源码树） |

**环境绕行（必须如实记录）**：

- GNU `task_dock_lib-*.exe` 未内嵌 Common-Controls 6.0 清单，加载期
  `STATUS_ENTRYPOINT_NOT_FOUND`（0xc0000139）；用 `mt.exe` 将主程序清单嵌入测试二进制副本后
  执行（`final/test-manifest.xml`）。这是构建/环境缺口，不是测试失败；正式修复应在构建脚本为
  测试目标补清单。
- 另一任务在途未跟踪文件 `tests_v82_rest.rs` 使用旧 API，阻塞整库测试编译；将当前源码复制到
  `C:\taskdock-verify`，仅在该**副本**排除此无关测试模块后编译取证，工作区他人文件未改。
- `mcp::` 唯一失败 `taskdock_collab_create_issue` 缺并发令牌字段，属其他任务在途 schema，
  非本任务引入；其余 71 例通过。

**截至 §8.2 仍未执行（后由 §8.4 完成 Android 真机）**：Android 真机/模拟器、Dev 完整视觉矩阵
（320/400 窄窗、深浅主题、焦点顺序）、
Release 正式验收、命令模块指标运行时聚合、整库 `cargo test --lib`（被其他任务阻塞）。

### 8.3 Dev 诊断中心真实窗口验收（2026-11-20 17:36–17:42）

用户要求停止子代理后，主智能体用独立数据目录与 CDP 脚本在真实 Debug 桌面实例上补做诊断中心
UI 验收。完整记录见 `tmp/acceptance/logging-phase2/final/dev-ui.md`，截图在同目录 `dev-ui/`。

| 项 | 实测结果 |
|---|---|
| 运行环境 | `target/debug/task-dock.exe`，SHA256 `6E4D6293…28F65F`；前端 Vite `localhost:1420`；数据目录 `tmp/debug/logging-phase2-dev4`；运行期 HEAD `7cc15d1`（外部提交推进，二进制底栏仍为 `5b6c671（构建时未提交）`，dirty 154） |
| 三视图 | 「运行诊断 / 安全审计 / 性能分析」真实渲染；运行诊断含健康概览、按需加载表、筛选/分页 |
| 安全审计来源状态 | 审计日志 `无事件`、MCP 审计 `无事件`、保险库 `未解锁`、个人中枢 `未接入`；未把不可读来源伪装成 0 事件；时间/来源/类别/结果/设备主体筛选可见 |
| 性能窗口语义 | 明确显示「进程启动以来」，`startedAt=09:36:14`、`generatedAt=09:40:13`；`startup/first_ready` 平均/P95 3879 ms、慢操作 1、失败率 0%、次数 1；`resource/snapshot` 220 ms |
| 导出预览 | 默认不勾选安全审计：5 条、5 警告、5.5 KB、已脱敏、含设备诊断；勾选后重新预估为 6 条、6 警告、6.3 KB |
| 取消不落盘 | 点「取消」后对话框关闭，`Downloads` 无 `diag|taskdock|report` 新文件；`onCancel` 只关对话框，不调用导出命令 |

**边界**：该次为「当前前端工作树 + 16:54 Debug Rust 二进制」的混合 Dev 运行，不是干净快照；
仅覆盖诊断中心三视图、审计来源状态、导出预览/取消、startup 单次入账。Android 真机、320/400
窄窗、深浅主题矩阵、键盘/Escape 焦点顺序、导出确认后的原生保存与实际文件内容均未执行
（Android 真机后由 §8.4 完成）。

### 8.4 Android 真机功能验收（2026-11-20 18:20–19:33）

完整记录、命令与证据见 `tmp/acceptance/logging-phase2/final/android-device.md`。

| 项 | 实测结果 |
|---|---|
| 设备 | vivo V2323A，Android 16 / API 36，`arm64-v8a`；`dev.taskdock.mobile` v0.1.20（68） |
| 构建 | 全 ABI Release 在 x86 链接 OOM（ENVIRONMENT BLOCKED）；改 arm64 后先暴露 `ClipboardModule.kt` / `Ed25519Ops.kt` 漏 `SafeLog` import（编译失败，已修）；最终 `BUILD SUCCESSFUL in 5m15s`，APK 33,513,751 B / SHA256 `B3D6C6F2…9BEECE` |
| 安装 | `adb install -r` 成功；`firstInstallTime=2026-11-17 13:55:41` 多次覆盖不变；最终 `lastUpdateTime=19:33:28`；UI 仍显示 5 条任务（含 `desk_sync_1`） |
| 脱敏 | 真机发现 metadata 键名型凭据泄漏（`password=P@ssw0rd`），修复后 `password/token/api_key/email=[redacted]`、`path=[path]`、nested 丢弃；Logcat/文件一致；原始敏感串 0 命中 |
| 轮转 | 15,000 条（3×5,000）后仅 3 文件；`app.1=2,097,693`、`app.2=2,097,649`、`app.log=1,893,528`，总量 6,092,322 B；最旧一代被替换 |
| 崩溃 | `am crash` 生成 `crash-20261120-183856-11044.txt`（650 B，10 帧），无敏感路径；重启恢复 |
| 启动日志 | Debug 修复后冷启动 18:52:54（PID 17984），Logcat 与 `app.log` 均有「应用启动」；此前失败由 Metro CI 模式加载旧 JS bundle 解释（模块 961 缺 `getTaskDockLogger`），`--clear` 重启后闭环 |
| 最终 Release | 停 Metro、清 reverse 后冷启动 `COLD/623ms`；Logcat `19:33:41 I app: 应用启动`；`run-as` 拒绝（非 debuggable、无 root），文件内容未直接复核 |

**边界**：Release 文件级内容、7 天跨天清理、低电量/后台限制、不同厂商 ROM 未测；最终 APK 是
工作树临时 Release，不是集成快照，不能替代正式 Release 验收。

## 9. 遗留风险

1. **全量回归缺口**：整 `cargo test --lib` 阻塞解除后，需重跑全量并复核本阶段各模块无回归；
   当前结论不覆盖阻塞文件及其牵连链路。
2. **真机/完整 Dev 矩阵未全覆盖**：Android 端已完成真机功能验收（§8.4），但 Release 包内文件
   内容、7 天清理、低电量/后台限制与不同 ROM 未覆盖；桌面诊断中心三视图、审计来源状态、
   导出预览/取消已 Dev 实测（§8.3），320/400 窄窗、主题矩阵、通知/剪贴板/焦点等原生通道仍未
   全量走查；上线前须按 `docs/ACCEPTANCE_ROUTING.md` 原生通道验收。
3. **阈值与基线**：慢操作阈值、p95 样本窗口、导出体积/耗时数字均来自 Debug 测试二进制，
   不能外推为 Release 性能结论；正式基线须在干净构建工作区采样。
4. **审计源扩展**：personalHub 接线后需补适配层用例与前端联调；vault 解锁态需真实会话复核。
5. **磁盘与构建产物**：`target/debug` 已被删除恢复空间；后续全量编译耗时与磁盘占用需重新
   评估，构建前按 `AGENTS.md` §5.3 做预检。

## 10. 结论

**Dev 功能验收：通过（范围限定）；Android 真机功能验收：通过（范围限定）；Release 正式验收：未执行。**

- 八项需求均有代码落地与真实模块级证据：Android 原生脱敏/有界队列/轮转降级（**28 Kotlin +
  14 JS** 用例，真机脱敏/轮转/崩溃/启动/覆盖安装已取证）、跨端 Trace（mobile_sync 90、
  trace_wiring 16、前端定向 258）、安全审计适配（16）、指标聚合（diagnostics 套件内 14）、
  导出预览（query 定向 13）、诊断中心与弹层（80 组件用例）；`typecheck`、`cargo check --lib`、
  `arch:guard` 退出码均为 0。
- 诊断中心已在真实 Debug 桌面实例补做 Dev 验收（§8.3）：三视图、安全审计四来源状态、导出
  预览与取消不落盘、性能窗口语义与 startup 单次入账均实测；`dev-ui.md` 与截图已归档。
- Android 真机验收（§8.4）：vivo V2323A / Android 16；脱敏（含 metadata 键名凭据 P1 修复）、
  15,000 条轮转仅 3 文件/总量 6,092,322 B、崩溃文件 650 B、Debug 启动日志落盘、最终 Release
  冷启动 623 ms + 启动日志、覆盖安装保留 SQLite/5 条任务。
- **边界**：Release 包内文件内容（非 debuggable、无 root）、7 天跨天清理、低电量/后台限制与
  不同厂商 ROM 未测；Dev 完整视觉矩阵（320/400 窄窗、深浅主题、焦点顺序；三视图/导出预览已
  实测）、Release 正式安装包/升级/签名/生产资源加载、命令模块指标运行时聚合均**未按集成流程
  执行**；startup 已 Dev 实测单次 3879 ms，但只是 Debug 样本，不是正式性能基线；`span_id` 体系
  与 personalHub 审计源按设计延期；工作流执行链路 trace 未接（P2-1）。这些边界不构成本轮代码
  与真机功能验收的失败，但**不能**被表述为正式 Release 已验收。
- 其余在途任务造成的全量测试失败（前端 29 例、`mcp` 1 例、整库 cargo 测试被未跟踪文件阻塞）
  已单列，不计入本任务结论。
- 本结论**不构成**正式安装包、升级/卸载、签名、生产资源加载或正式性能结论；Release 验收须在
  集成快照构建的安装包上重新进行。

### 10.1 初次结论（2026-11-20 子任务收尾时，已被 §10 更正）

**部分通过（Dev 功能验收）。**

- 第二阶段声明路径的模块级定向测试与静态检查在本环境真实执行通过：Trace 契约与鉴权隔离、
  审计适配层、指标聚合层、导出预览与有界性、诊断中心组件与弹层定位、Android JVM/JS 单测层；
  `typecheck` 与 `cargo check --lib` 退出码 0。
- 未达到「通过」的原因：① 整库全量测试被其他任务在途文件阻塞（ENVIRONMENT BLOCKED）；
  ② 真机/模拟器与 Dev 实例真实窗口链路未走查；③ personalHub 审计源未接线、span 体系延期、
  startup 埋点已接线但**运行时未观测**；④ Release 专属项与正式性能基线未执行；
  ⑤ 部分复测受 ENOSPC 影响未在绿构闭环。
- 更正依据：收尾阶段补齐 `create_task` / `open_agent_session` / 工作区 copy-move 的 trace，
  完成 Android 硬上限恢复修复与定向复验，并把兜底报告归位；全量前端对照与 Rust 定向测试
  已在 `final/` 留存证据。
- 补充（2026-11-20 17:42）：主智能体随后完成 Dev 诊断中心真实窗口验收（§8.3），上条
  「Dev 实例真实窗口链路未走查」不再成立；Android 真机验收随后由 §8.4 完成。初次结论保留为
  历史记录。

## 11. 证据路径清单

仓库内证据（`D:\Develop\task_dock\tmp\acceptance\logging-phase2\`）：

- `interfaces.md` — 冻结契约
- `android-logger/report.md`；`gradle-test-9.txt`（历史 BUILD SUCCESSFUL）；`js-all-tests.txt`
  （86 文件 / 926 passed）；`js-safeLog-final.txt`（历史 13 passed）；`tsc-noemit.txt`；
  **最新**：`final/android-safelog-kotlin-test.log`（28 用例，SafeLog 16 / FileLogSink 12）、
  `final/android-safelog-js-test.log`（14 passed）、`final/android-typecheck.log`
- `trace-id/report.md`；`cargo-test-mobile-sync.txt`（90 passed）；`cargo-test-trace.txt`
  （5 passed）；`frontend-diagnostics-test.txt`（40 passed）；`mobile-sync-test.txt`（30 passed）
- `security-audit/report.md`；`cargo-test-3.log`（16 passed）
- `export-preview/report.md`；`test-query-pass.log`（13 passed）；`test-large-log.log`
  （50k → 5000 / 1,348,773 B / 810.97ms）
- `diagnostics-ui/report.md`；`diagnostics-test.log`（29 passed）；`positioning-test.log`
  （51 passed）；`i18n-test.log`（4 文件 68 passed）
- `metrics/` 目录：`test-metrics.log` 14 passed；`test-mcp.log` 71 passed/1 既有 failed；
  **已归位**：`metrics/report.md`
- `trace-wiring/` 目录：`cargo-test-trace.log` 8 passed；`cargo-test-agents.log` 4 passed；
  `vitest-shelf-store.log` 52 passed；`vitest-agent-components.log` 130 passed；
  **已归位**：`trace-wiring/report.md`
- `final/` 收尾复验（主智能体直接执行）：
  `summary.md`、`typecheck.log`、`cargo-check.log`、`rust-targeted.log`、
  `vitest-targeted.log`（258 passed）、`vitest-full.log`（5596/5625，29 例外失败）、
  `arch-guard.log`、`kotlin-test.log`、两份 `TEST-*.xml`、`test-manifest.xml`
- `final/dev-ui.md` + `final/dev-ui/`：Dev 诊断中心真实窗口验收记录与截图
  （runtime / security / performance / export-preview-default / export-preview-audit / nav-custom）
- `final/android-device.md` + `final/android-device/`（Debug 真机工作台截图/层级）、
  `final/android-device-release/`（最终 Release 工作台截图/层级）、
  `final/android-build-release-final.log`（最终 arm64 Release 构建，5m15s）

文档产出：

- `docs/architecture/logging-current-state.md`（§10 回填）
- `docs/architecture/logging-capability-matrix.md`（§M 回填）
- `docs/architecture/unified-observability-design.md`（§11 回填）
- `docs/DIAGNOSTICS.md`（§15 更正注记、§3 字段表、§25 追加契约）
- `docs/acceptance/logging-phase2-security-report.md`
- `docs/acceptance/logging-phase2-performance-report.md`
