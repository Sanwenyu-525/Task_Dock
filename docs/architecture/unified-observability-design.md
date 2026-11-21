# TaskDock 统一日志与可观测性目标架构

> 设计日期：2026-11-19
> 输入依据：[logging-current-state.md](./logging-current-state.md)（现状）、
> [logging-capability-matrix.md](./logging-capability-matrix.md)（能力矩阵）
> 关联规范：[docs/DIAGNOSTICS.md](../DIAGNOSTICS.md)（现有诊断日志技术说明，**继续有效**）
>
> **本设计的第一原则：收敛而非新建。**
> 现有 `diagnostics` 体系（Rust + TS，约 5000 行，65 个自动化测试）已经满足任务书
> 「统一日志契约 / 脱敏 / 异步缓冲 / 背压 / 轮转 / 配额 / 查询 / 导出」的绝大部分要求。
> 本方案**不新建任何并行日志系统**，只在现有体系上补齐缺口、拆分职责、收敛重复实现。

---

## 1. 设计原则与硬约束

| # | 原则 | 落地约束 |
|---|---|---|
| 1 | **优先复用** | 所有新增能力必须在 `diagnostics` 模块内扩展，禁止新建 `logger.rs` / `log2.rs` 之类平行实现 |
| 2 | **优先修复，不重写** | `diagnostics/mod.rs`、`writer.rs`、`privacy.rs`、`query.rs` 只增不改其核心结构；破坏性变更需先说明迁移路径 |
| 3 | **统一契约 ≠ 统一实现** | Rust 用 `tracing` + 自有 writer，TS 用自有队列，Android 用 `android.util.Log` + 自有滚动文件；**通过适配器统一事件结构、等级、关联标识与脱敏策略** |
| 4 | **不引入大型遥测平台** | 不引入 OpenTelemetry Collector / 云日志服务 / 后台常驻进程。现有 `tracing_subscriber` 已足够 |
| 5 | **不新增常驻资源** | 新增能力必须零常驻线程、零常驻定时器；Android 端滚动文件由现有生命周期钩子驱动 |
| 6 | **不改变现有业务行为** | 埋点只增加观测，不改变分支、不吞异常、不改变返回值 |
| 7 | **安全优先于功能** | 敏感信息处理必须在**源头**（字段白名单）而非事后正则 |
| 8 | **日志系统不得成为单点故障** | 任何降级路径必须保证业务可用；降级要有计数器与用户可见状态 |
| 9 | **不信任外部输入** | 前端上报、Android 上报、跨端透传的标识符一律经形态校验后重写 |
| 10 | **证据优先** | 任何「已实现」的声明必须有测试或运行证据，否则写「未执行」 |

---

## 2. 目标架构

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 运行时层                                                             │
│  React/TS (6 窗口)   Rust/Tauri   Android/Kotlin   MCP/Agent Runtime │
└───────────┬──────────────────┬───────────────┬────────────────────────┘
            │                  │               │
            ▼                  ▼               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 采集适配层（各运行时保留成熟框架，仅统一出口）                        │
│  TS: logEvent / startOperation / logIpcFailure   [已存在 ✅]          │
│  Rust: tracing:: 宏 + diagnostics::event()      [已存在 ✅]          │
│  Android: SafeLog.d/e/w + crashHandler          [待建 🆕]            │
└───────────┬──────────────────┬────────────────────┬──────────────────┘
            │                  │                    │
            ▼                  ▼                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 统一事件契约（DiagnosticEvent v2）                                   │
│  timestamp · level · module · action · event · trace_id · span_id    │
│  operation_id · session_id · window_id · device_id · status          │
│  stage · error_code · error_category · duration_ms · kind            │
│  message · metadata · source · count                                  │
└───────────┬──────────────────┬──────────────────────────────────────┘
            │                  │
            ▼                  ▼
┌───────────────────────┐  ┌──────────────────────────────────────────┐
│ 脱敏与字段校验        │  │ 分类路由                                  │
│ · metadata 白名单     │  │ · kind=diagnostic → 诊断日志（JSONL）    │
│ · 敏感 key 拒绝       │  │ · kind=audit     → 安全审计（独立存储） │
│ · 路径形态占位         │  │ · kind=metric    → 性能指标（聚合存储） │
│ · 标识符形态校验      │  └──────────────────────────────────────────┘
└───────────┬──────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 异步缓冲 / 限流 / 背压                                                 │
│ · 前端队列 128 条 + 批量 IPC 20/500ms + 在途 ≤4    [已存在 ✅]        │
│ · Rust sync_channel 1024 + try_send + ERROR ≤2ms×2 [已存在 ✅]        │
│ · 指纹聚合 256/60s                                        [已存在 ✅] │
│ · Android: 有界环形缓冲 + 落盘线程 + 配额            [待建 🆕]       │
└───────────┬──────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 持久化 / 轮转 / 清理                                                  │
│ 诊断日志: JSONL 5MB/文件 ×4 + 25MB 总量 + 7~14 天   [部分 🆕时间维度] │
│ 安全审计: SQLite 表 + 两段式保留                       [已存在 ✅]     │
│ 性能指标: 环形聚合表（内存）+ 阈值触发落盘            [待建 🆕]       │
│ Android: 沙盒内滚动文件 + 配额 + 生命周期            [待建 🆕]       │
└───────────┬──────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 诊断中心 / 查询 / 导出（复用既有面板，不新建页面）                    │
│ · 日志查看 + 操作链 + 筛选 + 复制                [已存在 ✅]          │
│ · 统一审计视图（Hub / Vault / MCP / 配对）        [待建 🆕]          │
│ · 性能指标面板                                    [待建 🆕]          │
│ · 诊断包：预览 → 确认 → 导出                     [部分 ⚠️ 缺预览确认]│
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. 事件契约 v2（`DiagnosticEvent`）

### 3.1 现有字段（**保持不变，向后兼容**）

`timestamp` `level` `module` `action` `event` `session_id` `operation_id` `window_id`
`component` `stage` `status` `error_code` `error_category` `duration_ms` `retry_count`
`message` `metadata` `source` `count`

> 全部字段 `#[serde(default)]`，新增字段用 `#[serde(default)]` + `skip_serializing_if = "Option::is_none"`，
> **旧日志文件与旧前端都能继续读取**。

### 3.2 新增字段

| 字段 | 类型 | 语义 | 生成方 | 校验规则 |
|---|---|---|---|---|
| `trace_id` | `Option<String>` | 一次**跨进程/跨模块**业务链路的唯一标识 | 发起端生成 | 16 位 hex（8 字节），非 hex 一律拒绝并重写为新值 |
| `span_id` | `Option<String>` | 链路内的一个**阶段**标识 | 每个 span 边界生成 | 16 位 hex |
| `device_id` | `Option<String>` | 设备维度（桌面实例 / 手机） | 设备注册时分配 | ≤ 32 字符，`[a-z0-9-_]`；**必须哈希后存储**，不存原始硬件标识 |
| `kind` | `DiagnosticKind` | `diagnostic` / `audit` / `metric` | 由路由层判定 | 缺省 `diagnostic` |

### 3.3 与任务书建议字段的映射（保持务实，不做无意义改名）

| 任务书字段 | 本项目对应 | 说明 |
|---|---|---|
| `eventName` | `action` + `event` | 现有两级命名已足够，`event` 是短名（started/failed/aggregated） |
| `spanId` | **新增** `span_id` | — |
| `operationId` | `operation_id` | **已有**，语义一致 |
| `deviceId` | **新增** `device_id` | — |
| `error` (NormalizedError) | `error_code` + `error_category` + `message` | 已有等价物；**不引入自由结构体**，避免序列化风险 |
| `context` | `metadata` | 已有等价物，且**已受白名单约束**（比自由 context 更安全） |

> **决策：不把 `error` 变成嵌套对象。** 任务书示例中的 `error?: NormalizedError` 会引入
> 自由结构序列化风险，与现有「只存标量 + 白名单」的隐私策略冲突。
> 现有 `error_code`/`error_category`/`message` 三元组已经满足定位需要，且已被 65 个测试覆盖。

### 3.4 `kind` 的路由语义

```text
kind=diagnostic  → 诊断 JSONL（可被 verbose 模式影响、聚合、可清理）
kind=audit      → 审计存储（不受 verbose 影响、独立保留、不与普通日志共表）
kind=metric     → 指标聚合（阈值触发才落盘）
```

**关键约束**：`kind=audit` 的事件**必须**写入独立的审计存储，
不得写入诊断 JSONL 后仅靠「不记录正文」来充当安全审计——这正是任务书
「审计日志不得与普通 Debug 日志共用可随意关闭的开关」的要求。

---

## 4. 各阶段设计

### 4.1 第一阶段：统一日志接口（TS）

**现状**：`src/lib/diagnostics.ts` 已有 `logEvent` / `startOperation` / `logIpcFailure` / `logIpcSuccess`。
**目标**：补齐任务书点名的 6 个方法，**全部基于现有实现扩展**。

```ts
// src/lib/diagnostics.ts 新增（不改动既有导出）

/** 创建带固定上下文的子 Logger（上下文不可变，继承并合并）。 */
export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: unknown, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export function createLogger(moduleName: string): Logger;
export function createChildLogger(parent: Logger, context: LogContext): Logger;
export function normalizeError(error: unknown): NormalizedError;  // 复用 src/lib/errors.ts 的 normalizeError
export function sanitizeLogContext(context: LogContext): LogContext;
export function serializeLogEvent(event: DiagnosticInput): DiagnosticInput;
export function shouldEmitLog(level: DiagLevel): boolean;      // 复用 isClientVerboseMode()
```

**实现约束**：
- `createLogger` **不新建队列**，只是把 `module` 绑定到 `logEvent` 的一个闭包。
- `child()` 的上下文合并遵循**白名单 + 标量优先**规则：父上下文中的 key 若不在
  `ALLOWED_META_KEYS` 内，直接丢弃（与后端 `privacy.rs` 同规则）。
- `normalizeError` **直接复用** `src/lib/errors.ts:263` 的实现，不重复实现。
- `serializeLogEvent` 只做「剔除 undefined / 截断超长字符串 / 丢弃对象数组」，
  最终脱敏仍由 Rust 端 `privacy.rs` 兜底（**双保险**）。

**Rust 侧对应**（任务书 `4.2` 要求的 6 个函数）：
现状 `diagnostics/mod.rs` 已具备 `init` / `event` / `emit` / `record` / `flush_blocking` / `shutdown`。
需**新增**的只有：

```rust
// src-tauri/src/diagnostics/mod.rs
pub fn create_log_context(module: &str, action: &str) -> EventBuilder;  // = 现有 event()，加别名
pub fn sanitize_log_fields(metadata: Map<String, Value>) -> Option<Map<String, Value>>; // = privacy::sanitize_metadata，转出
pub fn record_operation_event(builder: EventBuilder, status: DiagStatus) -> bool;
pub fn record_error_event(builder: EventBuilder, error: &AppError) -> bool;
```

> `init_logging()` 与 `flush_logs()` **已存在**（`init` / `flush_blocking`），
> 只做**别名导出**以对齐任务书命名，不新增实现。

### 4.2 第二阶段：持久化与生命周期

**保留现有实现**（`writer.rs`），**新增三项**：

#### 4.2.1 时间维度保留（补 E-05 缺口）

```rust
// writer.rs
pub const MAX_AGE_DAYS: u64 = 14;   // 候选默认值，需实测确认
```

`prune()`（`writer.rs:294`）新增一步：按归档文件名中的时间戳
（`diagnostics-<YYYYMMDD>-<HHMMSS>-<seq>.jsonl`，格式见 `writer.rs:262-266`）
或文件 `mtime` 判定，超过 `MAX_AGE_DAYS` 的归档一并删除。

> **默认 14 天**的理由：任务书建议 7–14 天；诊断日志主要用于复现与排障，
> 14 天覆盖一个完整的双周迭代周期。**最终值以性能与实测报告为准**，
> 实测前不得写死为「已验证」。

#### 4.2.2 配额与轮转参数（沿用现有，补文档化）

| 参数 | 现值 | 位置 | 任务书建议区间 | 决策 |
|---|---|---|---|---|
| 单文件上限 | 5 MB | `mod.rs:54` | 10–20 MB | **维持 5 MB**：桌面端诊断日志量级小，更小的文件降低单次查询与解析成本 |
| 归档数 | 4 | `mod.rs:56` | — | 维持 |
| 目录总量 | 25 MB | `mod.rs:58` | 100–200 MB | **维持 25 MB**：任务书的上限面向「全量业务日志」，本项目只落**诊断事件**（非全量日志），25 MB 已覆盖约 10 万条事件 |
| 保留天数 | 新增 | — | 7–14 天 | **新增 14 天** |

> **重要说明**：以上决策必须写入 `docs/acceptance/logging-performance-report.md`，
> 附「25 MB ≈ 多少条事件」的实测换算，而不是拍脑袋。

#### 4.2.3 磁盘写满 / 权限不足的错误分类（补 E-11/E-13 缺口）

```rust
// writer.rs
enum WriteFailureKind { DiskFull, PermissionDenied, FileLocked, Corrupted, Unknown }
```

`fail()`（`writer.rs:399`）按 `std::io::Error::kind()` 分类计数，
`DiagnosticsStatus`（`commands/diagnostics.rs:31-53`）新增
`last_failure_kind: Option<String>`，让设置页能明确告诉用户「磁盘满」而不是笼统的「日志失败」。

- 磁盘满 → 停止写入直到容量恢复（当前退避 60s 已近似），并在 UI 提示。
- 权限不足 → 降级为只读计数，提示用户检查目录权限。
- 文件被占用 → 保持当前「继续追加」行为（`writer.rs:280-282`），仅计数。

### 4.3 第三阶段：安全审计与隐私保护

#### 4.3.1 收敛策略（不新建第五套审计）

现状四套审计存储：

| 体系 | 存储 | 保留 | 处置 |
|---|---|---|---|
| MCP 审计 | `mcp_audit_log`（主库） | 两段式天数 | **保留原地**，补 `duration_ms` 列（新迁移） |
| Personal Hub 审计 | `ph_audit_log`（独立库） | 未定义 | **保留原地**，通过**视图映射**进统一审计视图 |
| Vault 审计 | `audit`（独立库） | 硬截断 500 条 | **保留原地**，改为**时间维度 + 数量双上限** |
| 诊断 JSONL | 文件 | 数量+容量（新增时间） | **保留原地**，仅承载 `kind=diagnostic` |

**统一审计视图**（新增，查询层而非存储层）：
在诊断中心新增「安全审计」标签页，通过**只读 IPC** 聚合上述三个来源，
按统一字段投影：

```text
统一审计项 = { ts, source, event_type, subject, action, result, reason_code, correlation_id }
  ├─ mcp_audit_log   → action / agent_id / success / authz / request_id
  ├─ ph_audit_log    → event_type / device_id / request_id / fingerprint / result / detail
  └─ vault.audit     → event / outcome / reason_code / count
```

> **决策：不做数据搬迁。** 搬迁三套表会触及已发布迁移与备份 manifest（`AGENTS.md` §4.3 红线），
> 收益低于风险。**统一视图**已能满足「安全事件能审计」的验收标准。

#### 4.3.2 配对/信任变更审计（补 F-05/F-06 缺口）

`mobile_sync` 的配对流程目前**成功路径完全无痕迹**（`mobile_sync/mod.rs:450` / `:568`）。
新增审计事件（写入**独立审计存储**，不写诊断 JSONL）：

| 事件 | 触发点 | 主体 | 结果 |
|---|---|---|---|
| `PAIRING_REQUESTED` | `start_pairing`（`mobile_sync/mod.rs:450`） | — | `ok` |
| `PAIRING_SUCCEEDED` | `complete_pairing` 落库成功后（`mobile_sync/mod.rs:~630`） | `device_id`（新生成 UUID） | `ok` |
| `PAIRING_FAILED` | `complete_pairing` 各失败分支（`PairFailure::InvalidCode` / `TooManyAttempts` / `Closed`） | `peer_ip` 最小化 | `invalid_code` / `too_many` / `closed` |
| `DEVICE_REVOKED` | 设备撤销路径 | `device_id` | `ok` |
| `AUTH_FAILED` | `authenticate_device` 失败（`mobile_sync/mod.rs:707`） | `peer_ip` 最小化 | `unauthorized` |

**脱敏要求**（对齐 `docs/ARCHITECTURE.md` §4.5「日志不记录正文、路径、密钥」）：
- **绝不记录配对码**、token、密钥库秘密。
- `device_id` 用库内 UUID，**不用** MAC/IMEI/序列号。
- `peer_ip` 记录前截断为 `/24` 网段（IPv4）或 `/48`（IPv6）。
- 设备指纹（SPKI）**只记录是否为已信任**，不记录指纹本身。

#### 4.3.3 审计存储选型

新增 `mobile_sync` 审计事件写入**主库新表** `security_audit_log`（**追加新迁移**，
不改已发布迁移，登记 `BACKUP_TABLES`）：

```sql
CREATE TABLE security_audit_log (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,      -- pairing | auth | permission | remote | vault | agent
  event_type TEXT NOT NULL,    -- PAIRING_SUCCEEDED 等稳定枚举
  subject TEXT,                -- device_id / agent_id / slot（已最小化）
  action TEXT NOT NULL,
  result TEXT NOT NULL,        -- ok | denied | failed
  reason_code TEXT,
  correlation_id TEXT,         -- = operation_id / trace_id
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sec_audit_time ON security_audit_log(created_at);
CREATE INDEX idx_sec_audit_cat  ON security_audit_log(category, created_at);
```

保留策略：**元数据 90 天**、**不删行只清 `reason_code` 明细 30 天**（对齐 MCP 审计的两段式思路）。

#### 4.3.4 防篡改：明示威胁模型（补 F-15 缺口）

**不引入哈希链。** 理由：本地哈希链在「设备所有者即攻击者」的桌面威胁模型下
**无法阻止恶意修改**（攻击者可重算整条链），只会制造「已防篡改」的错觉。

**采用的最小措施**：
1. 审计表**只追加不更新**（应用层不提供 UPDATE 路径）。
2. 审计事件**含 `correlation_id`**，与诊断日志可交叉验证。
3. 文档明示威胁模型：
   > 本机制防的是**误删、误改、未授权软件的意外损坏**；
   > **不防**设备所有者或已取得本机完全控制权的攻击者。

### 4.4 第四阶段：跨模块追踪

#### 4.4.1 标识符体系（复用现有，只加两个）

| 标识 | 作用域 | 生成 | 传播 |
|---|---|---|---|
| `session_id` | **进程实例** | Rust 启动时 UUID v4（`mod.rs:433`） | 已在所有事件中，**不需新增** |
| `operation_id` | **一次用户操作** | 前端 `operationId()`（`diagnostics.ts:493`） | 已在 TS→IPC 全链路，**不需新增** |
| `trace_id` | **一次跨端/跨进程业务链路** | 发起端（前端或 Rust 入口） | **新增**：前端 → IPC → Rust → 移动通信 → Android |
| `span_id` | **链路内一个阶段** | 每个 span 边界 | **新增**：父子 span 关系用 `parent_span_id`（可选） |

> **决策：复用 OpenTelemetry 的 ID 形态（16 位 hex），但不引入 OTel SDK。**
> 任务书要求「优先采用现有成熟标准和库，不要自行开发完整分布式追踪框架」——
> 采纳其 **ID 规范**即可满足关联需求，引入完整 OTel Collector 与本项目「不引入大型遥测平台」
> 的硬约束冲突。

#### 4.4.2 生成与传播

```ts
// src/lib/diagnostics.ts
export function createTraceContext(): { traceId: string; spanId: string };
export function startSpan(traceId: string, name: string): Span;
export function endSpan(span: Span, status: DiagStatus): void;
export function propagateTraceContext(headers: Record<string,string>): Record<string,string>;
export function recordSpanError(span: Span, error: unknown): void;
```

**Rust 侧**：
```rust
// src-tauri/src/diagnostics/mod.rs
pub fn create_trace_context() -> TraceContext;   // trace_id + span_id
pub fn current_trace() -> Option<TraceContext>;   // 线程局部，任务局部，不依赖全局可变变量
```

**安全约束（逐条对应任务书）**：

| 要求 | 实现 |
|---|---|
| 不信任外部传入的 Trace ID | 任何外部传入的 `trace_id` 必须匹配 `^[0-9a-f]{16}$`，否则**丢弃并生成新值**（不报错、不透传） |
| 限制标识长度和格式 | 同上正则 + 16 字符硬上限 |
| 不依赖不安全的全局可变变量 | Rust 用 `thread_local!`（每线程独立）；TS 用**显式传参**（`options` / `metadata`），**不引入隐式全局上下文** |
| Trace ID 不能替代认证或授权 | 认证路径（`authenticate_device`、MCP token 校验）**完全不读 trace_id** |
| 避免高频事件产生海量追踪记录 | `trace_id` **只挂在操作边界事件**（started/success/failed/cancelled/recovered），**stage 事件不带 trace_id**（只有 operation_id） |

#### 4.4.3 跨进程传播路径

```text
React UI  --(invoke: traceId)-->  Tauri Command  --> Rust Service
                                              │
                                              ▼
                                    mobile_sync 协议 ──(JSON 字段 traceId)──> Android
```

- 前端 → Rust：随 `invoke` 参数传递（`trace_id`）。
- Rust → Android：`mobile_sync` 的 JSON 载荷**新增可选字段** `traceId`，
  Android 侧回包**原样带回**（不校验、不解释，仅透传）。
- **Android 不生成 trace_id**，只回传，避免两端 ID 体系分叉。

### 4.5 第五阶段：性能日志

#### 4.5.1 统一的指标 API（基于现有 `duration_ms`，不新建体系）

```ts
// src/lib/diagnostics.ts
export function measureOperation<T>(module: string, action: string, fn: () => Promise<T>, options?: { slowMs?: number }): Promise<T>;
export function recordDuration(module: string, action: string, ms: number, metadata?: LogContext): void;
export function recordSlowOperation(module: string, action: string, ms: number, thresholdMs: number, metadata?: LogContext): void;
export function recordFailure(module: string, action: string, error: unknown, metadata?: LogContext): void;
```

```rust
// src-tauri/src/diagnostics/mod.rs
pub fn measure_operation<T>(module: &str, action: &str, f: impl FnOnce() -> T) -> (T, u64);
pub fn record_duration(module: &str, action: &str, ms: u64);
pub fn record_slow_operation(module: &str, action: &str, ms: u64, threshold_ms: u64);
pub fn record_failure(module: &str, action: &str, error: &AppError);
```

#### 4.5.2 阈值触发原则（关键）

**不是所有耗时都记。** 采用「阈值触发 + 聚合」：

| 场景 | 策略 |
|---|---|
| 常规操作 | **不记**耗时（只在失败时记 `duration_ms`） |
| 超过阈值 | 记一条 WARN，`stage=slow`，`metadata.duration_ms` |
| 高频事件（投屏帧、剪贴板捕获、文件扫描） | **只记聚合指标**（计数 + P95），**绝不逐条记** |
| 失败 | 必记（现有 `startOperation` 的 `fail` 已覆盖） |

**默认阈值表**（候选值，需实测校准）：

| 模块 | 阈值 |
|---|---|
| 桌面启动（首屏可交互） | 3000 ms |
| 文件工作区目录加载 | 1500 ms |
| 回收站枚举 | 1000 ms |
| 资源扫描 | 5000 ms |
| 剪贴板捕获 | 200 ms |
| 投屏建连 | 3000 ms |
| 设备通信请求 | 5000 ms |
| MCP 工具调用 | 10000 ms |
| Agent 任务 | 30000 ms |
| SQLite 单条查询 | 500 ms |

> **所有阈值在实测前均为「候选值」，必须在 `docs/acceptance/logging-performance-report.md`
> 中用真实基线替换，并注明测量设备与数据规模。**

#### 4.5.3 日志系统自身性能基准（P0，必须建）

新增脚本 `scripts/logging-benchmark.mjs`，测量：

| 指标 | 方法 | 建议阈值 |
|---|---|---|
| 日志关闭 vs 开启的业务耗时差异 | 同一业务操作 N 次取分位数对比 | P99 差异 ≤ 5% |
| 高频事件下 CPU 占用 | 1000 events/s 持续 60s | ≤ 3% |
| 队列增长 | 突发 10000 事件 | 队列长度**不得超过 128**（前端）/ **1024**（Rust），且计数与丢弃数一致 |
| 大日志查询阻塞 | 25 MB 日志下查询耗时 | UI 交互**无冻结**（主线程无长任务 > 50 ms） |
| 清理/轮转影响 | 触发轮转时业务 P99 | 增量 ≤ 10 ms |
| 退出等待 | 触发 `shutdown()` 到进程退出 | ≤ 500 ms |

### 4.6 第六阶段：诊断中心 UI（复用既有面板，不新建页面）

**唯一新增页面元素**：诊断中心内的标签切换（`日志` / `安全审计` / `性能指标`）。
**不新建**任何顶级页面——`DiagnosticsCenterPanel.tsx` 已存在且功能完整。

| 需求 | 现状 | 动作 |
|---|---|---|
| 按时间/等级/模块/关键词筛选 | ✅ 已有 | 保留 |
| **按设备筛选** | ❌ | 依赖 `device_id`，随 §4.4 落地后加 |
| **Trace ID 搜索** | ❌ | 随 §4.4 落地后加（与现有 operationId 搜索并列） |
| 错误详情 / 一键复制 | ✅ 已有 | 保留 |
| 导出诊断包 | ⚠️ 缺预览确认 | 补 `previewDiagnosticBundle()` → 用户确认 → `exportDiagnosticBundle()` |
| 默认最新 / 虚拟滚动 | 分页已限制单页体量 | 虚拟滚动为性能增强，**按实测页大小决定是否做** |
| **暂停实时刷新** | ❌ | 补开关；暂停时新事件入队但不自动刷新 |
| **新日志不打断阅读** | ⚠️ 部分 | 补滚动位置保持 |
| 空/加载/失败状态 | ✅ 已有 | 保留 |

**诊断包流程（补齐）**：

```text
用户点「导出诊断包」
  → previewDiagnosticBundle(filter)
      返回：将要包含的条数、时间范围、级别分布、**字段清单**、预计体积、**脱敏声明**
  → 用户确认（可勾选「包含 INFO」「包含 metadata」）
  → exportDiagnosticBundle(filter, options)
      → 本地文件（dir/exports/），**绝不上传**
```

**脱敏声明**必须明示：包内不含密码、token、正文、完整路径、剪贴板内容。

### 4.7 第七阶段：全局异常处理

| 异常源 | 现状 | 动作 |
|---|---|---|
| `window.onerror` / `unhandledrejection` | ✅ 已有 | 保留 |
| React ErrorBoundary | ✅ 已有 | 保留 |
| Tauri Command 错误 | ✅ 已有 | 保留 |
| **Rust Panic** | ❌ **P0** | 安装 `std::panic::set_hook` |
| 已有 `catch_unwind` 的 9 个点 | ⚠️ 未统一 | 统一约定 |
| **Android UncaughtException** | ❌ **P0** | 安装 `Thread.setDefaultUncaughtExceptionHandler` |
| MCP Tool Error | ✅ 已有 | 保留 |
| Agent 执行错误 | ⚠️ 部分 | 补埋点 |

#### 4.7.1 Rust Panic Hook（P0）

```rust
// src-tauri/src/diagnostics/panic.rs（新增）
pub fn install_panic_hook() {
    let previous = std::panic::set_hook(Box::new(move |info| {
        // 1) 写入诊断日志（ERROR，kind=diagnostic）
        // 2) 尝试写安全审计（kind=audit，event_type=PANIC）
        // 3) 交给上一个 hook（保持原有 stderr 行为）
        previous(info);
    }));
}
```

**硬约束**：
- hook 内部**不得 panic**、**不得调用会 panic 的代码**（所有操作包在 `catch_unwind` 里）。
- hook 内部**只写最小信息**：panic 消息（经脱敏）、`panic::Location`（文件:行，**不含绝对路径**——需用
  `normalize_ident` 处理）、线程名。
- **不写**：栈回溯全文（可能含路径）、线程局部业务数据。
- 安装时机：`Diagnostics::init` 之后立即安装（`lib.rs:637` 附近）。
- **必须先取 `previous` 再调用**，保持 Tauri 默认 panic 行为不变。

#### 4.7.2 `catch_unwind` 统一约定

现有 9 处 `catch_unwind`（`clipboard/paste.rs:1222`、`clipboard/platform.rs:424`、
`commands/scenario.rs:1865`、`file_workspace/mod.rs:932`、`navigation/app_discovery.rs:740`、
`workflows/engine.rs:558`、`workspace/gate.rs:224`、`workspace/mod.rs:1181`、`workspace/mod.rs:1260`）
——**逐点核对是否已有诊断记录**，缺失的补一条 ERROR 级事件。

#### 4.7.3 错误提示与日志对账（补 J-17）

`reportError` / `globalErrors` 路径当前**不生成 `operation_id`**。
改为：次级观察也生成 `operation_id`（与主要归属方**共用同一个**），
这样「用户看到的 Toast」与「诊断中心里的日志」可以用一个 ID 对上。

实现上，`invokeCommand` 的失败路径已经在 `logIpcFailure` 里生成事件；
次级观察需要拿到同一个 `operation_id`——做法是把 `operation_id` 挂在
`AppError` 实例上（`errors.ts` 的 `AppError` 已有 `operation` 字段语义），
由 `logIpcFailure` 写入、`reportError` 复用。

---

## 5. Android 端设计（新建，但保持轻量）

### 5.1 定位

Android 端日志**独立于桌面端**，**不向桌面持续上报**（任务书明确禁止）。
目标：**移动端自身故障可定位**，不追求与桌面端统一存储。

### 5.2 组件

```text
apps/mobile/modules/logger/android/.../SafeLog.kt   ← 新增（唯一日志入口）
  · d/e/w/i(tag, msg, throwable?)  → android.util.Log（Logcat）
  · 全部走脱敏（禁正文/路径/token）
  · 模块 tag 稳定化

apps/mobile/modules/logger/android/.../CrashHandler.kt ← 新增
  · Thread.setDefaultUncaughtExceptionHandler
  · 捕获崩溃 → 写本地文件 → 委托原 handler（不吞崩溃）

apps/mobile/modules/logger/android/.../FileLogSink.kt ← 新增
  · 沙盒内 filesDir/logs/，滚动文件（≤ 2 MB/文件，≤ 3 个）
  · 总量 ≤ 6 MB
  · 启动时按 mtime 清理超期文件（保留 7 天）
```

### 5.3 关键约束（对齐任务书 §4.3）

| 约束 | 实现 |
|---|---|
| App 沙盒 | `context.filesDir/logs`，不写外部存储，无需权限 |
| 文件大小限制 | 单文件 ≤ 2 MB，最多 3 个文件 |
| 生命周期 | **无后台常驻**：仅在有日志时写入，App 退到后台即停止周期性工作 |
| 后台运行 | **不注册后台服务**（省电） |
| 崩溃恢复 | `CrashHandler` 写入崩溃文件，下次启动时读取并上报到诊断中心（**用户主动**） |
| 电量与存储 | 无常驻线程；写入走 `HandlerThread` 或直接同步写（Kotlin 小体量，App 后台被杀即丢弃） |
| 不持续上报桌面 | 移动日志**仅存本地**，用户在移动端主动「发送诊断」时才打包上传 |

### 5.4 Kotlin 静默吞异常修复

`ClipboardModule.kt:63`、`Ed25519Ops.kt:59`、`:78` 的 `catch (_: Exception) {}`
改为**记录一行 SafeLog.e 并继续**（保持业务行为不变——原逻辑就是吞掉）。

### 5.5 现有移动端错误传递链

移动端 JS 已通过 Expo 模块把错误抛回 JS 层（`IdentityStorageException` 等）。
**新增**：JS 层的 `catch` 也写入 SafeLog 的 JS 侧缓冲（`console` → SafeLog 桥），
使 Kotlin → JS 两层在同一份日志里可对照。

---

## 6. 迁移路线（增量、可回退、每步独立可验收）

> **原则**：每一步都是「新增能力」或「修缺陷」，**不破坏现有契约**；
> 每一步都有独立测试；不合并成一次大改。

| 步骤 | 内容 | 依赖 | 产出证据 | 风险 |
|---|---|---|---|---|
| **M1** | Rust Panic Hook | 无 | 新增 `diagnostics/panic.rs` + 测试 | 低 |
| **M2** | 诊断日志时间维度保留（`MAX_AGE_DAYS`） | 无 | `writer.rs` 改动 + 测试 | 低 |
| **M3** | 写失败错误分类（磁盘满/权限/占用） | 无 | `writer.rs` + `DiagnosticsStatus` + 测试 | 低 |
| **M4** | `trace_id`/`span_id`/`device_id` 契约扩展 | M1–M3 | `mod.rs` + `diagnostics.ts` + 双端测试 | **中**（契约扩展） |
| **M5** | TS `Logger` 门面（`createLogger` 等 6 方法） | M4 | `diagnostics.ts` + 测试 | 低 |
| **M6** | 性能指标 API + 阈值触发 | M5 | `diagnostics.ts` + `mod.rs` + 测试 | 中 |
| **M7** | 配对/信任/鉴权审计事件 + `security_audit_log` 迁移 | M4 | 新迁移 + `mobile_sync` + 测试 | **中**（涉及 DB） |
| **M8** | 统一审计视图（诊断中心新标签页） | M7 | `DiagnosticsCenterPanel.tsx` + IPC | 中 |
| **M9** | 诊断包预览 + 确认流程 | M6 | UI + IPC + 测试 | 低 |
| **M10** | Android SafeLog + CrashHandler + FileLogSink | M4（trace 透传） | `apps/mobile/modules/logger/` + 测试 | **中**（新模块） |
| **M11** | Android Kotlin 静默吞异常修复 | M10 | 3 处改动 | 低 |
| **M12** | 诊断中心交互增强（暂停刷新、滚动保持、Trace 搜索、设备筛选） | M4, M8 | UI + 测试 | 低 |
| **M13** | 统一性能基准脚本 + 阈值校准 | M6 | `scripts/logging-benchmark.mjs` + 报告 | 低 |
| **M14** | 故障注入测试套件 | M2, M3 | Rust 测试 + 脚本 | 中 |
| **M15** | 错误提示 ↔ operationId 对账 | M5 | `errors.ts` + `diagnostics.ts` | 低 |
| **M16** | 生产 `console.*` 收敛（37 处 / 14 个文件） | M5 | 批量替换 + 测试 | 低 |
| **M17** | `catch_unwind` 9 点统一 + 命名消歧文档 | M1 | 9 处 + 文档 | 低 |

**并行编排**（按 `AGENTS.md` §3.1，文件所有权互斥）：

| 子智能体 | 负责步骤 | 独占写入路径 |
|---|---|---|
| A：Rust 诊断内核 | M1, M2, M3 | `src-tauri/src/diagnostics/**` |
| B：TS 契约与门面 | M4, M5, M6, M15, M16 | `src/lib/diagnostics.ts`、`src/lib/errors.ts` |
| C：Android 日志 | M10, M11 | `apps/mobile/modules/logger/**`、`apps/mobile/modules/{clipboard,device-identity}/**` |
| D：安全审计 | M7, M8 | `src-tauri/src/mobile_sync/**`、`src-tauri/src/db/mod.rs`（**MIGRATIONS 末尾独占**）、`src-tauri/src/commands/audit*.rs` |
| E：诊断中心 UI | M9, M12 | `src/components/diagnostics/**`、`src/components/settings/DiagnosticsLogsSection.tsx` |
| F：测试与性能 | M13, M14, M17 | `scripts/logging-benchmark.mjs`、`src-tauri/src/diagnostics/tests.rs`、新测试文件 |

**共享枢纽文件**（必须由主智能体串行写）：
`src-tauri/src/diagnostics/mod.rs`（事件契约）、`src-tauri/src/db/mod.rs`（迁移）、
`src/lib/diagnostics.ts`（前端契约）、`src/components/diagnostics/DiagnosticsCenterPanel.tsx`。
按 `AGENTS.md` §3.1 判定：这些属于「情况 C（改公共契约）」，**必须指定唯一所有者串行写入**。

---

## 7. 与现有文档的关系

| 文档 | 处置 |
|---|---|
| `docs/DIAGNOSTICS.md`（699 行） | **继续有效**，作为体系 A 的权威技术说明。M4 的契约扩展需在该文件追加 §25「契约 v2」 |
| `docs/architecture/logging-current-state.md` | 本轮新增（现状证据） |
| `docs/architecture/logging-capability-matrix.md` | 本轮新增（功能矩阵） |
| `docs/architecture/unified-observability-design.md` | 本轮新增（本文件） |
| `docs/acceptance/logging-*.md` × 3 | 开发阶段产出，落到 `docs/acceptance/`（该目录已存在） |
| `docs/architecture/SECURITY.md` | 需补充威胁模型章节（M3/M7 落地后） |

**命名消歧**（M17）：在 `docs/DIAGNOSTICS.md` 增加一节，明确
`resource_cleanup/diagnostics.rs`（进程采样）、`mcp/diagnostics.rs`（连接医生）、
`commands/audit.rs`（测试数据清理）**均非日志系统**，避免后续维护者误判。

---

## 8. 验收标准（可判定，逐条对应任务书）

| # | 标准 | 判定方式 | 对应步骤 |
|---|---|---|---|
| 1 | **出现错误能记录** | 注入 3 类错误（IPC 失败、业务失败、panic），诊断中心可见 | M1, 现有 |
| 2 | **发生故障能定位** | 任意失败事件可查出「哪个模块/哪个阶段/什么错误码/耗时」 | 现有 + M4 |
| 3 | **跨模块操作能追踪** | 一次操作从前端到 Rust 到 Android 可用同一 `trace_id` 串起 | M4, M10 |
| 4 | **安全事件能审计** | 配对成功/失败、鉴权失败、权限变更、MCP 调用、Vault 操作在**统一审计视图**可见 | M7, M8 |
| 5 | **日志数量可控制** | 目录总量 ≤ 25 MB 且保留 ≤ 14 天；队列长度恒定 | M2 + 现有 |
| 6 | **敏感数据不泄漏** | 全部隐私回归测试通过；Android 端日志不含正文/路径/token | 现有 + M10 |
| 7 | **正常使用几乎无感** | 日志开/关业务 P99 差异 ≤ 5%；退出等待 ≤ 500 ms | M13 |
| 8 | **审计不可被普通开关关闭** | 关闭 verbose 后审计事件仍全部记录 | M7 |
| 9 | **日志系统不是单点故障** | 目录不可写 / 磁盘满 / 文件被占用时业务完全不受影响 | M3, M14 |
| 10 | **不新增常驻资源** | 桌面端线程数不增加；Android 无后台常驻服务 | M13 验证 |

---

## 9. 未决问题（需产品/用户确认，不擅自决定）

| # | 问题 | 影响 | 建议默认 |
|---|---|---|---|
| Q1 | 诊断日志保留天数取 7 还是 14 天？ | M2 参数 | 14 天 |
| Q2 | 是否允许「导出诊断包」包含 INFO 级事件（默认不含）？ | M9 | 默认不含，用户勾选才含 |
| Q3 | Android 崩溃日志是否需要用户主动上传，还是仅本机留存？ | M10 | 仅本机留存 + 主动发送 |
| Q4 | `device_id` 是否需要在 UI 展示完整值，还是只显示哈希前缀？ | M4 | 只显示 8 位哈希前缀 |
| Q5 | 安全审计保留 90 天是否过长（合规角度）？ | M7 | 90 天元数据 / 30 天明细 |
| Q6 | 性能阈值是否需要暴露为用户可调项？ | M6 | **不暴露**，保持默认，避免增加用户配置成本 |

---

## 10. 未执行声明

本设计文档基于**代码级审计**产出。下列内容**未执行**、结论待开发阶段验证：

- 未运行 `cargo test` / `npm run test` / `npm run typecheck` / `npm run arch:guard`。
- 未执行任何构建（含 `npm run tauri build`）。
- 未启动应用，未采集真实日志文件样本。
- 未做性能实测：本文所有阈值均为**候选值**。
- 未做故障注入：磁盘满、权限不足、文件占用等场景的行为**基于代码阅读推断**。
- 未验证 Android 端：`apps/mobile` 未构建、未在真机运行。

以上将在 `docs/acceptance/logging-acceptance-report.md`、
`logging-performance-report.md`、`logging-security-report.md` 中以真实输出回填。

---

## 11. 第二阶段落地回填（2026-11-20，logging-phase2）

> 本节回填第二阶段（M4 部分 / M6 部分 / M7–M10 / M12 部分）的真实落地状态。§1–§10 的
> 设计意图与候选参数保留原样；与本节冲突处以本节带日期的落地结论为准。证据目录
> `tmp/acceptance/logging-phase2/`，三份验收报告见 `docs/acceptance/logging-phase2-*.md`。

### 11.1 迁移路线执行对照（§6 M1–M17）

| 步骤 | 设计目标 | 第二阶段落地状态 |
|---|---|---|
| M4 契约扩展 | `trace_id` / `span_id` / `device_id` / `kind` | **部分落地**：`trace_id` 已入 `DiagnosticEvent`（`Option<String>`，serde default + skip）；**`span_id` 延期**（§11.3）；`device_id`、`kind` 本阶段未引入 |
| M6 性能指标 API | 阈值触发 + 聚合 + 异步计时 | **Rust 侧落地并模块级验证**（§11.4）；前端门面方法未在本阶段专项验收 |
| M7 配对/信任/鉴权审计 + `security_audit_log` | 独立审计存储 | **落地**：主库 `security_audit_log` 经适配层真接入；两段式清理沿用；启动路径不调用 prune |
| M8 统一审计视图 | 诊断中心安全审计标签页 | **落地（Rust 适配层 + 前端组件级）**；四源状态显式标注；`personalHub` 未接线（§11.2） |
| M9 诊断包预览 + 确认 | 预览 → 确认 → 导出 | **落地**：只读预览 + 显式授权勾选 + 取消不落地（§11.5） |
| M10 Android SafeLog + CrashHandler + FileLogSink | 沙盒滚动文件 + 脱敏 + 崩溃捕获 | **落地并经真机验证（范围限定）**：vivo V2323A / Android 16 验证脱敏、15,000 条轮转（3 文件/6,092,322 B）、崩溃文件、启动日志；最终临时 Release 冷启动 623 ms、覆盖安装保留数据（§11.6） |
| M12 诊断中心交互增强 | 三视图、Trace 展示 | **部分落地**：三视图（运行诊断/安全审计/性能分析）完成；Trace 搜索、设备筛选、暂停刷新、滚动保持未在本阶段完成 |
| M13 性能基准脚本与阈值校准 | 可复现基准 + 阈值固化 | **未执行**：阈值仍为候选值；无 Release 基线、无 CPU/内存采样 |
| M14 故障注入测试套件 | 磁盘满/权限/占用注入 | **部分**：Android 文件占用降级有 JVM 用例；桌面端真实磁盘满/权限注入未执行 |
| M5 TS Logger 门面 / M11 Kotlin 吞异常修复 / M15 错误对账 / M16 console 收敛 / M17 catch_unwind 统一 | 见 §6 | 本阶段未作为独立批次验收；现状以 `logging-capability-matrix.md` §M 为准 |

### 11.2 统一审计视图落地口径（对应 §4.3.1）

- **查询层而非存储层**的决策保持：未搬迁三套既有审计表；适配层只读投影合并。
- 来源与覆盖状态（`available` / `empty` / `locked` / `notWired` / `error`）：

| 来源 | 状态 | 说明 |
|---|---|---|
| `securityAuditLog` | **available（真接入）** | 主库 `security_audit_log`（迁移 v82），只读连接；`DEVICE_REVOKED` → `deviceRevoked`；pairing/auth/mcp 直通；其余 `other`；`correlation_id` 过 16-hex 校验后才作 traceId |
| `mcpAuditLog` | **available（真接入）** | 主库 `mcp_audit_log`（迁移 v37）；`authz=0` → `denied`，`success=1 && authz=1` → `ok`，其余 → `failed`；`request_id` 过校验后作 traceId |
| `vault` | **条件接入** | trait 已接线，运行态按会话判定：`Unlocked` 才读审计；`Locked`/`Recovery`/`NoVault` → `locked`（附 note）；读取异常 → `error`。未解锁不返回空列表冒充无事件。解锁态真实 `VaultState` 路径未在 Dev/Release 环境验证 |
| `personalHub` | **notWired（延期）** | Hub 在独立进程 `taskdock-personal-hub`；主进程未托管 Hub State，Named Pipe 无审计读取方法；`ph_audit_log` 仅在独立进程 `hub.db` 内可写。`HubAuditReader` trait 预留，待管道协议/State 增加只读方法后接入 |
| 远控（remote control） | **不适用** | 仓库不存在远控功能模块；未新增来源、未伪造事件 |

- **不把不同库伪装成同一物理表**：统一条目 `id = <source>:<原始 id>`；`total` 为各源 COUNT 之和，
  合并后切片；来源不可读时 `sources[].status` 显式说明。
- 已知口径偏差（见 `security-audit/report.md` §8）：vault 解锁态 `total` 受 `AUDIT_MAX_ROWS=1000`
  上限约束；mcp 源 COUNT 仅纳入时间边界，`result`/`eventType`/`device` 过滤在内存层应用；
  各源 fetch 内部兜底上限 200，`limit` 钳制 1..=100（默认 50）。

### 11.3 Trace 契约落地与 span 延期（对应 §4.4）

- **已落地**：`trace_id` 16 位小写 hex；外部传入经 `validate_external_id`，非法丢弃并重新生成，
  不报错、不透传；显式传参（不依赖 thread_local 跨 await）；同一次同步周期的分页 pull、push、
  后续 pull 共享会话 trace（`trace_sessions` 进程内有界 32 条，设备撤销后不主动清理，重启即清空）。
- **安全边界保持**：trace 只写入诊断事件 `trace_id` 字段；认证/授权/设备信任/SPKI/管线 origin
  路径完全不读 trace。
- **`span_id` 延期（更正 §3.2 / §4.4.1 的字段规划）**：当前业务链路为单层操作，一次用户操作
  对应一个 `operation_id`，起止事件经 `trace_id` 即可串起；`new_span_id()` 生成函数已存在但
  事件结构未引入 span 字段。延期理由：① `operation_id` 已承担父子关联；② 批量导入/移动等扇出
  场景的子阶段边界尚未定稿；③ 高频事件（拖拽、轮询、通知对账）按契约不建 span。将来落地预留：
  `DiagnosticEvent` 增加可选 `span_id: Option<String>` 与 `parent_span_id: Option<String>`，
  serde `default` + `skip_serializing_if = "Option::is_none"`；span 仅挂扇出父操作与子阶段事件。
- **已接通的主要入口**（2026-11-20 收尾补齐）：shelf 批量导入/移动/复制、`create_task`、
  `open_agent_session` 三处前端入口、工作区 copy/move、mobile_sync pull/push、MCP 工具调用。
- **尚未接线的入口**：工作流执行链路（明确缺口，见验收报告 P2-1）；`span_id` 体系按 §3.2 延期。

### 11.4 指标体系落地口径（对应 §4.5）

- **数据窗口：进程启动以来累计**（`window="process"` + `startedAt`/`generatedAt`），
  **不是滚动「最近 24 小时」**；重启进程即重置。诊断中心性能视图固定展示「进程启动以来」与
  起始/生成时刻，不使用 24 小时表述。
- **聚合模型**：指纹（module+action）容量 256，每指纹最近 64 个耗时样本环形窗口算 p95；
  超限淘汰最久未活跃指纹并计 `evicted`；聚合在调用线程完成，不新增常驻线程、无全局可变状态。
- **异步计时**：`record_duration_async(module, action, started: Instant)`；`OperationTimer`
  显式 `finish()` 消费，未 finish 即 Drop（早退/取消/panic 展开）由 Drop 兜底记录一次，
  `finished` 标志防重复入账，`Send` 可跨 await 持有；失败计数由调用方在错误路径显式记录，
  计时器不推断失败。
- **阈值表（ms，当前候选值，待 Release 基线校准）**：

  | module | action | 阈值 |
  |---|---|---|
  | `file` | `list_dir` | 1500 |
  | `search` | `query` | 1000 |
  | `recycle` | `list` | 默认 1000（表内未单列） |
  | `resource` | `snapshot` / `preview` / `disk_analyze` / `junk_scan` | 5000 |
  | `clipboard` | `capture` | 200 |
  | `mobile_sync` | `pull` / `apply_push` | 5000 |
  | `mcp` | `tool_call` | 10000 |
  | `agent` | `submit` | 30000 |
  | `startup` | `first_ready` | 3000（已接线；Dev 实测 3879 ms / P95 3879 ms，单次 Debug 样本） |

- **不逐帧/逐条打点**：投屏逐帧、剪贴板逐条原始事件、高频轮询均未打点；剪贴板按一次入库
  捕获聚合一次，同步按一次 pull / 一批 push 聚合，Agent 管线按一次 submit 请求聚合。
- **MCP 授权拒绝**（`ToolError::Authz`）不计入失败聚合：授权拒绝已走 MCP 审计表，与
  `record_failure` 面向「真实故障」的语义分工。

### 11.5 导出预览落地口径（对应 §4.6 诊断包流程）

- 预览 `export_preview` 只读扫描：复用扫描器 `MAX_SCAN_LINES=200_000` 与 `SCAN_BUDGET=400ms`，
  **不生成文件、不落盘、不打开数据库连接**；超限 `truncated=true`。
- 导出有界性：命中事件受 `MAX_EXPORT_RECORDS=5_000` 上限；`BufWriter` +
  `serde_json::to_writer_pretty` 流式落盘，临时文件 rename 原子替换。
- 授权并入审计段：`include_security_audit=false` 完全不触碰数据库；`true` 经
  `security_audit::list_page` 只读查询，审计段请求上限 `MAX_AUDIT_RECORDS=100`（与既有
  100 条/页钳制对齐）；查询失败标记 `error` 并降级保留其它报告内容，不使整份导出失败。
- 估算口径：固定外壳 `REPORT_ENVELOPE_BYTES=4096`，授权审计段另加
  `AUDIT_SECTION_ENVELOPE_BYTES=512`；每条命中事件按落盘 JSON 重序列化字节累加；预览不读
  审计表，单条审计事件字节未计入，属保守下限。
- **实测样本（Debug 测试二进制，不外推为正式性能结论）**：合成 50,000 行日志 →
  `records=5000`（封顶），报告 `bytes=1,348,773`（约 1.29 MiB），导出耗时 `810.97ms`；
  未做 RSS/堆采样。

### 11.6 Android 落地口径（对应 §5）

- 模块位置：`apps/mobile/modules/logger/android/src/main/java/dev/taskdock/modules/logger/`
  （`SafeLog.kt` / `FileLogSink.kt` / `LoggerModule.kt` / `CrashHandler.kt`）；JS 侧
  `apps/mobile/src/lib/safeLog.ts`。
- 容量与背压常量：单文件软目标 2 MB、归档 3 个、总量 ≤6 MB、保留 7 天；活动文件硬上限 4 MB；
  队列 `MAX_PENDING_LOGS=256`、高级别预留 `HIGH_PRIORITY_RESERVED=32`；分级丢弃与退避策略
  详见 `logging-current-state.md` §10.3。
- **验证状态（2026-11-20 真机回填）**：vivo V2323A / Android 16 / arm64 已完成 Debug 文件级
  验收：脱敏（含 metadata 键名凭据 P1 修复）、15,000 条轮转仅 3 文件/6,092,322 B、崩溃文件
  650 B（10 帧、无敏感路径）、启动日志落盘；最终临时 Release 冷启动 623 ms、覆盖安装保留
  SQLite/5 条任务。**未覆盖**：Release 包内文件内容（非 debuggable、无 root）、7 天跨天清理、
  低电量/后台限制、不同 ROM；正式 Release 专属项（集成快照、安装/升级/卸载、签名、生产资源
  加载、正式性能基线）仍未执行。详见 `tmp/acceptance/logging-phase2/final/android-device.md`。

### 11.7 仍未决 / 阻塞项

- **整 `cargo test --lib` 被其他任务在途未跟踪文件
  `src-tauri/src/agent_access/tests_v82_rest.rs`（非 ASCII 字节串语法错误）阻塞**：
  ENVIRONMENT BLOCKED，非本任务缺陷；阻塞解除后需复测全量。
- 本轮主智能体静态检查：`npm run typecheck` 退出码 0；`npm run cargo -- check --lib` 退出码 0
  （36 条既有警告，无新增阻断性错误）。
- **D: 盘 ENOSPC 事故**：当日 D: 盘写满至 0 字节，主智能体删除可再生构建产物
  `src-tauri/target/debug`（约 8.0 GB）后恢复约 7.0 GB；部分定向套件仅前台控制台通过，
  落盘复测为环境阻塞记录。Android 最终 Release 构建前再次出现 0 字节可用，清理本任务可再生的
  Android `intermediates`（约 1.37 GB）与旧 Dev 数据后恢复约 3.2 GB，构建成功。基准脚本、
  完整视觉走查、正式 Release 验收须在磁盘充足且阻塞解除后补做。
