# 日志系统第二阶段：现状复核、接口契约与开发计划

> 复核日期：2026-11-20
> 复核方式：对照第一阶段审计（`docs/architecture/logging-current-state.md`，2026-11-19）逐项重查当前
> 工作区代码；所有结论附 `文件:行号` 证据；未执行的检查如实标注。
> 前置事实：**第一阶段改动仍在工作区未提交**（`git status`：`src-tauri/src/diagnostics/{mod,privacy,writer,tests}.rs`、
> `lib.rs`、`commands/diagnostics.rs` 为已修改，`diagnostics/panic_hook.rs` 为未跟踪新文件）。
> 本阶段改动叠加在该工作区状态之上；按 AGENTS.md §3.2 不代为提交，提交由用户/主 Agent 统一处理。

---

## 0. 复核结论（对照任务书 §二 的 9 项检查）

| # | 检查项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | Panic Hook 是否已正确安装 | **已安装且第一阶段已验证**；但 `install()` 无一次性保护 | `lib.rs:641`（setup 内调用一次）；`diagnostics/panic_hook.rs:48-58` |
| 2 | 是否存在重复安装可能 | **存在（潜伏缺陷）**：`install()` 每次调用 `take_hook`+`set_hook` 重新包装，重复调用会链式叠加导致同一 Panic 重复记录。当前生产代码仅 `lib.rs:641` 调用一次，测试代码未调用（`grep install(` 无命中），故为**潜伏**而非已触发 | `panic_hook.rs:48-58` |
| 3 | tracing message 是否绕过脱敏 | **主干已闭合，边界仍有缺口**：`FieldVisitor` 只收白名单字段 → `record()` → `normalize()`（`mod.rs:283-288`）→ `sanitize_message` → `sanitize_diagnostic`（`error.rs:339-378`：单行化、栈/SQL 过滤、`redact_home_dirs`、`redact_secrets` 10 个标记、400 字符限长）。**缺口**：`password:`/`secret:`（只有 `=` 变体）、无分隔符 `apikey`、URL 查询参数变体（`?key=`/`?auth=`/`?sig=`）、邮箱、`sk-` 前缀密钥形态均未覆盖 | `error.rs:428-440`（MARKERS 10 项） |
| 4 | MCP/Vault/普通诊断日志存储关系 | **三套独立审计存储 + 一套诊断 JSONL，互不混写**：`mcp_audit_log`（主库，`db/mod.rs:1255`，两段式保留+幂等键）；`vault.audit`（独立库，`secure_vault/store.rs:525-546`，**硬截断 500 条**）；`ph_audit_log`（personal_hub 独立库，`store.rs:67`）；诊断 JSONL 只承载 `kind=diagnostic`。**缺口**：`mobile_sync` 配对/鉴权路径零审计（`mobile_sync/mod.rs` 无 audit 引用，grep 实测）；vault 审计无时间维度 | 同左 |
| 5 | 是否已有部分 Trace ID 实现 | **未实现**：全仓库 `trace_id|traceId` grep 0 命中。已有可复用基础：`session_id`（`mod.rs:433`）、`operation_id`（`diagnostics.ts:509`）、`window_id`（`diagnostics.ts:84-109`） | 实测 grep |
| 6 | Android 技术栈与日志入口 | **React Native 0.88 + Expo 58（TypeScript）**，非 Kotlin-only/Flutter。`android.util.Log` 调用 **0 处**；`apps/mobile/src` 生产代码 `console.*` **0 处**；无 `UncaughtExceptionHandler`（0 命中）；Kotlin 静默吞异常 3 处（`ClipboardModule.kt:63`、`Ed25519Ops.kt:59,78`） | 实测 grep |
| 7 | 前端残留 console 数量 | **生产代码 36 处 / 14 文件**（上轮报告 37 处，计数漂移 1 处，以本次实测为准）。测试文件不计。分布：`useEdgeSnap.ts`(15)、`useSettingsStore.ts`(5)、`useNavOrderDraft.ts`(4)、`WidgetDesktopBridge.tsx`(2)，其余 10 文件各 1 处 | 实测 grep |
| 8 | 诊断包导出是否已有预览确认 | **无预览**：`DiagnosticsCenterPanel.tsx:563-576` `onExport()` 直接调用 `diagnosticsExport(filter)` 落盘文件，导出**后**才有结果/不完整提示（`:638-649`），导出前无内容预览与确认步骤。导出报告本身已是脱敏 schema（`query.rs:721` `taskdock.diagnostic-report/1`） | 同左 |
| 9 | 日志轮转在文件被占用时的真实行为 | **缺陷确认**：`writer.rs:275-283` rename 失败仅 `fail_io` 后 `open_active` 继续追加；下次写入 `bytes_in_file > max_file_bytes`（`writer.rs:189-193`）再次触发 `rotate()` → **每次写入重复尝试 rename**（失败风暴 + failures 计数膨胀），且活动文件**无上限增长**（`prune` 只删归档，活动文件只统计不处置，`writer.rs:299-367`） | `writer.rs:189-193, 258-291, 299-367` |

**补充核对（本阶段其余工作面）**：

- **性能指标 API 不存在**：`measureOperation|recordDuration|recordSlowOperation` 前后端 grep 0 命中。
- **第一阶段已交付并验证**（`docs/acceptance/logging-acceptance-report.md:319-322`）：panic 捕获（J-05）、时间维度保留（E-05，`MAX_AGE_DAYS=14` `mod.rs:65`）、写失败三分类（E-11/E-13，`mod.rs:381-420`）。**不重做**。
- 命名撞车消歧（防误判）：`resource_cleanup/diagnostics.rs`（进程采样）、`mcp/diagnostics.rs`（连接医生）、`commands/audit.rs`（测试数据清理）**均非日志系统**。

---

## 1. 本阶段功能矩阵与步骤映射

对齐 `docs/architecture/unified-observability-design.md` §6 迁移路线（M1–M3 已完成）：

| 步骤 | 内容 | 承担方 | 批次 |
|---|---|---|---|
| M1' | Panic Hook 一次性安装保护（`install_once`/`is_installed`） | A | 1 |
| 3.2 | tracing/文本脱敏强化（`redact_secrets` 扩展 + 形态测试矩阵） | A | 1 |
| M7 | `security_audit_log` 迁移 + 配对/鉴权/撤销审计事件 + vault 审计保留策略修复 | B | 1 |
| M4 | `trace_id` 契约（Rust 字段 + 校验 + tracing 白名单 + TS 上下文 + MCP/移动协议透传） | C | 1 |
| M9 | 诊断包导出预览与确认流程 | E | 2 |
| M8/M12 | 诊断中心三视图（运行诊断/安全审计/性能）+ 交互增强 | E | 2 |
| §8 | 文件占用时轮转降级（有界重试 + 退避 + 恢复） | F | 2 |
| M6 | 性能指标 API（阈值触发 + 聚合，前后端） | F | 2 |
| M13/M14 | 性能基准脚本 + 故障注入测试 | F | 2 |
| M10/M11 | Android SafeLog + CrashHandler + FileLogSink + 静默吞异常修复 | D | 2 |
| M16 | 生产 console 36 处收敛 | G | 2 |
| 集成 | lib.rs 命令注册、跨批集成、验收报告 | 主智能体 | 批次间 |

## 2. 接口契约（主智能体先行定死，子智能体不得偏离）

### 2.1 Trace（C 交付，B/D 依赖）

```rust
// src-tauri/src/diagnostics/trace.rs（新文件）
pub const TRACE_ID_LEN: usize = 16;
pub fn new_trace_id() -> String;                 // 16 位小写 hex（uuid v4 派生）
pub fn new_span_id() -> String;                  // 同上
/// 外部传入 ID 统一入口：匹配 ^[0-9a-f]{16}$ 返回 Some，否则 None（调用方丢弃并重新生成，
/// 不报错、不透传）。长度硬上限 16。绝不参与任何认证/授权判断。
pub fn validate_external_id(raw: &str) -> Option<String>;
```

- `DiagnosticEvent` 新增 `trace_id: Option<String>`（`#[serde(default, skip_serializing_if)]`，
  向后兼容），`normalize()` 中经 `validate_external_id` 校验，非法丢弃。
- `tracing_layer` `FieldVisitor` 白名单新增 `trace_id`；**只在操作边界事件挂 trace_id**（started/
  success/failed/cancelled/recovered），stage 事件不带（设计文档 §4.4.2）。
- TS（`src/lib/diagnostics.ts`）：`createTraceContext(): { traceId: string }`；`DiagnosticEventInput`
  与 `startOperation` options 新增 `traceId?`；入队前同一 16-hex 校验。**显式传参，不引入隐式全局上下文**。
- 跨端协议：`mobile_sync` JSON 载荷新增可选字段 `traceId`，Android **只回传不生成、不校验语义**
  （16-hex 形态由桌面端入队校验兜底）。MCP 外部传入走 `validate_external_id`。

### 2.2 安全审计（B 交付）

- 表 `security_audit_log`：按设计文档 §4.3.3 schema（`id/category/event_type/subject/action/
  result/reason_code/correlation_id/created_at` + created_at/category 索引），**MIGRATIONS 末尾追加**，
  登记 `BACKUP_TABLES`；保留策略元数据 90 天、明细 30 天两段式。
- 事件清单（首批）：`PAIRING_REQUESTED / PAIRING_SUCCEEDED / PAIRING_FAILED / DEVICE_REVOKED /
  AUTH_FAILED`（mobile_sync）；vault 侧保留原表并改「时间+数量双上限」；MCP 高风险调用/权限拒绝
  写入 `security_audit_log`（普通调用留在 `mcp_audit_log`，不双写）。
- 脱敏红线：不记录配对码/token/密钥/指纹值；`subject.device_id` 用库内 UUID；`peer_ip` 截断 /24（IPv4）
  或 /48（IPv6）；指纹只记录「是否已信任」布尔。
- 可靠性：审计写入失败**不阻塞业务**，但高风险操作（配对成功落库、设备撤销）失败时**必须**在诊断
  日志记 ERROR（`error_code=SECURITY_AUDIT_WRITE_FAILED`）供告警；普通日志清理路径（`writer::clear`、
  `prune`）只动 `diagnostics-*.jsonl`，物理上不可能删除审计表。
- 防篡改：**不做哈希链**（设计文档 §4.3.4 威胁模型），表只追加不更新，文档明示边界。

### 2.3 轮转降级与指标（F 交付）

- `writer.rs` 轮转失败进入**降级状态**：记 `rotate_failures` 计数，按指数退避（≥60s）重试 rename，
  重试窗口内**跳过 rotate 判断**（消除每次写入的 rename 风暴）；活动文件加**绝对硬上限**
  （如 64 MB，超限改用截断式归档或丢弃计数），文件可用后自动恢复正常轮转。测试必须真实占用文件
  （Windows 独占打开）验证，不只测 rename 成功路径。
- 指标 API（前后端同名语义）：`measureOperation / recordDuration / recordSlowOperation /
  recordFailure / getMetricsSummary`；**阈值触发**（超阈值才记 WARN + `stage=slow`），高频事件只聚合
  （计数 + p95），阈值用设计文档 §4.5.2 候选值并在基准报告校准。不逐帧/逐条记录投屏与剪贴板。

### 2.4 Android（D 交付）

- `apps/mobile/modules/logger/`（新原生模块：`SafeLog.kt`/`CrashHandler.kt`/`FileLogSink.kt`）+
  `apps/mobile/src/lib/safeLog.ts`（JS 统一入口：`trace/debug/info/warn/error`）。
- 沙盒 `filesDir/logs`，单文件 ≤2 MB ×3 个，保留 7 天；`HandlerThread` 异步写，无常驻定时器；
  崩溃经 `CrashHandler` 写本地文件并委托原 handler；不上传桌面，仅用户主动导出。
- 修复 3 处 Kotlin 静默吞异常（`ClipboardModule.kt:63`、`Ed25519Ops.kt:59,78`）→ `SafeLog.e` 一行并保持原行为。

## 3. 文件所有权矩阵（批次内独占，跨批串行）

| 方 | 独占写入 | 明确禁触 |
|---|---|---|
| A | `diagnostics/panic_hook.rs`、`src-tauri/src/error.rs`、`diagnostics/privacy.rs`（仅增测试） | mod.rs、tracing_layer.rs、writer.rs |
| B | `src-tauri/src/security_audit/`（新）、`db/mod.rs`（MIGRATIONS 末尾 + BACKUP_TABLES）、`mobile_sync/`、`mcp/audit.rs`、`commands/security_audit.rs`（新） | diagnostics/**、lib.rs |
| C | `diagnostics/trace.rs`（新）、`diagnostics/mod.rs`、`diagnostics/tracing_layer.rs`、`src/lib/diagnostics.ts(+test)`、`mcp/mod.rs`、`mcp/protocol.rs` | mobile_sync（B 拥有）、db/mod.rs |
| D | `apps/mobile/**`（本任务范围） | src/、src-tauri/ |
| E | `components/diagnostics/**`、`settings/DiagnosticsLogsSection.tsx`、`diagnostics/query.rs`、`commands/diagnostics.rs` | lib.rs、mod.rs |
| F | `diagnostics/writer.rs`、`diagnostics/metrics.rs`（新）、`scripts/logging-benchmark.mjs`、`diagnostics/tests.rs`（故障注入） | mod.rs（仅批次 2 由主智能体代注册 `pub mod metrics`） |
| G | console 收敛 14 文件清单（hooks/stores/widgets 等） | diagnostics.ts（只导入使用） |
| 主 | `lib.rs`（注册）、全部文档、验收报告 | — |

冲突预裁决：`mobile_sync` 归 B（审计事件 + `traceId` 透传字段一并实现，调用 §2.1 契约）；
`mcp/` 按 audit.rs（B）/ mod.rs+protocol.rs（C）拆分；`diagnostics/tests.rs` 批次 1 无人改，
批次 2 归 F。

## 4. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| R-1 | 共享工作区叠加第一阶段未提交改动，git diff 混合两阶段 | 不代提交；交付报告说明归属；测试以当前工作区状态为准 |
| R-2 | DB 迁移破坏已发布 schema | B 仅末尾追加 + BACKUP_TABLES 登记；不改已有迁移 |
| R-3 | vitest 全量在低内存假失败 | 各方只跑**定向**测试（vitest run <文件>、cargo test <模块::>） |
| R-4 | 并行 cargo test 共享 target 锁排队 | 属预期；错误按真实退出码判断，不自动重试 |
| R-5 | 轮转降级引入新死循环/风暴 | F 的实现必须有真实文件占用测试 + 重试窗口断言 |
| R-6 | trace_id 被误用于授权 | 契约明令：认证路径（`authenticate_device`、MCP token 校验）不读 trace_id；C/B 测试各覆盖一条 |
| R-7 | Android 真机验收环境缺失 | D 交付单元测试 + 逻辑验收；真机项如实标注「未执行」 |

## 5. 开发计划

1. 批次 1 并行：A（panic hook + 脱敏）、B（审计体系）、C（trace 契约）→ 各自定向测试通过。
2. 主智能体审核接口 + lib.rs 注册 + 跨模块冒烟（cargo check + 定向测试）。
3. 批次 2 并行：D（Android）、E（诊断中心）、F（轮转/指标）、G（console 收敛）。
4. 统一集成：全量定向测试、typecheck、arch:guard；更新四份架构文档；产出验收/安全/性能三份报告。

> 本文档为第二步交付（现状 + 矩阵 + 契约 + 风险 + 计划）。后续 `logging-phase2-acceptance-report.md`、
> `logging-phase2-security-report.md`、`logging-phase2-performance-report.md` 在集成后以真实执行结果回填。
