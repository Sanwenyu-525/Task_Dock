# 诊断日志（Diagnostics）

> 目标：**发生问题时，开发 Agent 能直接根据脱敏日志定位到模块、操作、执行阶段与可能原因**，
> 不需要反复复现和猜测。本文件是诊断日志的技术说明与接入规范；实施范围与验收证据见
> `tmp/acceptance/diagnostics-logging/report.md`。

## 1. 定位与边界

诊断日志是**故障定位基础设施**，不是业务审计：

| 属于诊断日志 | 不属于诊断日志（各自模块独立保存） |
|---|---|
| 操作失败、降级、超时、恢复 | 工作流步骤回执（`workflow_step_receipts`） |
| 后台任务异常与状态不一致 | 备份 manifest / 恢复点 |
| IPC 失败与耗时 | 文件投递恢复记录（journal） |
| 启动/退出与模式切换里程碑 | 任务、Agent 事件、剪贴板历史等业务表 |

**诊断日志绝不进入 SQLite，也绝不替代任何业务记录。**清理诊断日志不会影响任务、Agent
事件、剪贴板内容、工作流回执、备份或文件投递恢复记录。

## 2. 架构

```text
用户操作 / 后台任务 / 系统事件
        │
   ┌────┴──────────────────────────────┐
   │                                   │
React/TS（每窗口）                Tauri/Rust
`src/lib/diagnostics.ts`          `src-tauri/src/diagnostics/`
有界队列 + 批量 IPC                tracing Layer（自动捕获已有 warn!/error!）
   │                                   │
   └────────────┬──────────────────────┘
                │
        DiagnosticEvent（统一字段）
                │
        有界队列（1024）→ 单写线程（唯一接触文件）
                │
     ┌──────────┴───────────┐
     │                      │
 JSONL 轮转/保留        异常聚合（指纹窗口去重）
     │
 查询 / 摘要 / 脱敏报告导出
     │
 设置页「诊断与日志」
```

要点：

- **单一写入者**：只有写线程执行追加、轮转、清理。多窗口只通过 IPC 上报，不直接写文件。
- **前端不直接做文件 IO**：组件只读 IPC 结果。
- **tracing 复用**：仓库已有的 `tracing::warn!/error!` 自动进入诊断日志，不需要逐个业务
  文件改埋点（字段白名单见 §6）。

### 代码位置

| 职责 | 文件 |
|---|---|
| 事件模型、级别、句柄、全局入口、模式 | `src-tauri/src/diagnostics/mod.rs` |
| 单写线程、轮转、保留、聚合 | `src-tauri/src/diagnostics/writer.rs` |
| 查询、摘要、导出 | `src-tauri/src/diagnostics/query.rs` |
| 字段白名单与脱敏 | `src-tauri/src/diagnostics/privacy.rs` |
| `tracing` 桥接层 | `src-tauri/src/diagnostics/tracing_layer.rs` |
| IPC 命令 | `src-tauri/src/commands/diagnostics.rs` |
| 前端客户端 | `src/lib/diagnostics.ts` |
| 设置页界面 | `src/components/settings/DiagnosticsLogsSection.tsx` |
| 一致性校验 | `src/lib/consistencyChecks.ts`、`commands/settings.rs`（持久化回读） |

## 3. 事件字段（稳定契约）

落盘 JSONL 的一行就是一个事件。字段名使用 **snake_case**（与 `Task` 等后端载荷一致），
IPC 查询参数使用 camelCase（项目参数规范）。

| 字段 | 说明 |
|---|---|
| `timestamp` | 带时区 RFC3339 毫秒（由写入端统一生成，避免多窗口时钟不一致） |
| `level` | `TRACE` / `DEBUG` / `INFO` / `WARN` / `ERROR` / `CRITICAL` |
| `module` | 稳定英文标识：`task`、`agent`、`clipboard`、`ocr`、`file`、`navigation`、`widget`、`workflow`、`voice`、`backup`、`settings`、`ui`、`ipc`…（只允许 `[a-z0-9_.-]`） |
| `action` | 稳定操作标识：命令名（`create_task`）、操作名（`paste_batch`）或 tracing target 末段 |
| `event` | 事件短名：`started` / `success` / `failed` / `cancelled` / `recovered` / `aggregated` / `log` |
| `session_id` | 一次应用运行的 UUID（由后端生成并写入，前端不能伪造） |
| `operation_id` | 一次业务操作的 ID，可跨窗口、跨阶段关联（见 §5） |
| `window_id` | `main` / `context-menu` / `notification` / `capture` / `widget` |
| `component` | 可读上下文（页面名、作用域）；已脱敏 |
| `stage` | 粗粒度阶段：`ipc` / `render` / `persist` / `sync`… |
| `status` | 操作生命周期（同 `event` 的取值域） |
| `error_code` | **优先复用 `AppError` 错误码**（`IO_ERROR`、`DATABASE_BUSY`…）；非 `[A-Z0-9_]{3,40}` 一律归一为 `UNKNOWN_ERROR` |
| `error_category` | `validation` / `io` / `database` / `service` / `agent` / `integrity`… |
| `duration_ms` | 单调时钟（`performance.now()` / Rust `Instant`）计算的耗时 |
| `retry_count` | 重试次数（可选） |
| `message` | 单行、脱敏、≤400 字符 |
| `metadata` | **白名单键**的标量值（≤16 个键，字符串 ≤120 字符）；对象/数组一律丢弃 |
| `source` | `rust` / `frontend` / `system` |
| `count` | 本行代表的**被抑制的重复次数**（普通事件 1，聚合摘要 > 1） |

诊断专用错误码（不属于 `AppError` 码表，仅用于 UI/渲染异常定位）：
`UI_RENDER_ERROR`（ErrorBoundary 捕获的渲染异常）、`UI_UNCAUGHT_ERROR` 场景由 `action`
区分（`render` / `uncaught_error` / `unhandled_rejection`），`error_code` 仍使用归一化结果。

## 4. 级别策略

| 级别 | 何时使用 | 默认是否落盘 |
|---|---|---|
| `CRITICAL` | 数据一致性异常、持久化损坏、回读不一致 | 是（**从不聚合**） |
| `ERROR` | 真实操作失败（IPC 失败、投递失败、工作流步骤失败） | 是 |
| `WARN` | 降级、超时、重试失败、配置回退 | 是 |
| `INFO` | 关键业务里程碑（启动、退出、模式切换、诊断模式切换） | 是 |
| `DEBUG` | 阶段推进、IPC 成功耗时（**仅详细诊断模式**） | 否 |
| `TRACE` | 开发期细节 | 否 |

补充规则：

- `tracing` 已有事件：正常模式**只落 WARN 及以上**；`INFO` 及以下只在详细诊断模式接收。
  原因：`tracing` 的 INFO 多为开发期流水，长期落盘没有诊断价值，且容易形成日志风暴。
- 业务里程碑要落盘请显式调用 `diagnostics::event(Info, ...)`，不要依赖 `tracing::info!`。
- 详细诊断模式：默认 30 分钟、最长 120 分钟，到期自动恢复；进程重启也恢复为正常模式。

## 5. `operation_id` 使用规则

- 一次用户/后台操作生成一个 ID；**前端 `startOperation()` 生成，后端沿用**。
- 同一操作的前端、IPC、后端异步子任务应共享同一 ID：前端记录 `started`/`stage`/终态，
  后端把收到的 ID 透传到步骤级事件（工作流引擎已有 `operation_id` 的复用同一值）。
- 带 `operation_id` 的事件**永不参与聚合**（每次操作失败都必须独立可见）。
- 不适合修改公开 IPC 参数的既有命令：不改签名，用 `action = 命令名` + `error_code` +
  `duration_ms` 关联；需要链路时在上层用 `startOperation` 包住调用并透传 ID。

## 6. 敏感数据过滤（白名单优先）

两处过滤，**从源头不写入**是主要手段：

1. **前端**：只上送语义化字段；`metadata` 只允许标量；不传业务对象、正文、路径。
2. **Rust**：
   - `module`/`action`/`event`/`stage` 归一化为标识符（非法字符替换、截断）；
   - `message`/`component` 复用 `error::sanitize_diagnostic`：单行化、去堆栈/SQL 行、
     隐藏用户目录（`C:\Users\<用户>`、`/home/<user>`）与凭证（`Authorization: Bearer <token>`、
     `token=`、`api_key=`、`password=`…）、限长；
   - `metadata` 只保留 `ALLOWED_META_KEYS`（`src-tauri/src/diagnostics/privacy.rs`）且拒绝
     含 `token/password/secret/content/body/path/prompt` 等片段的键；
   - `tracing` 只提取白名单字段（`message`/`action`/`stage`/`operation_id`/`error_code`/
     `status`/`window`/`duration_ms`），其余结构化字段全部丢弃。

**明确不记录**：剪贴板正文与图片、Agent 对话正文、密码/Token/API Key、完整用户目录路径、
环境变量、HTTP 请求体、设置值（设置一致性校验只记录键名）。

> 注意：白名单只能降低风险，不能证明"已过滤所有敏感数据"。新增字段必须先在
> `privacy.rs` 登记并说明用途。

## 7. 目录、轮转与保留

- 目录：`<app_data_dir>/diagnostics/`（`TASK_DOCK_DATA_DIR` 可整体隔离）。
  Windows 默认 `%APPDATA%\com.taskdock.desktop\diagnostics`。
- 活动文件：`diagnostics-active.jsonl`；归档：`diagnostics-<YYYYMMDD-HHMMSS>-<seq>.jsonl`。
- 单文件上限 5 MB，**写入前**判断并轮转（一行不会跨文件）。
- 归档最多 4 个（共 5 个文件，约 25 MB）；同时受目录总量 25 MB 上限约束，超限删最旧。
- 启动时执行一次轻量保留检查；轮转后立即检查。
- 写入：`BufWriter`（64 KiB）+ 200 ms 批次 flush；**不对每条日志 `sync_all`**，只在退出时
  同步一次。
- 失败降级：目录不可用/磁盘满/权限不足 → 只计数 + stderr 限流提示（30 s 一次）+ 60 s 退避，
  **不 panic、不向业务返回错误、不递归调用 `tracing`**。

## 8. 查询与摘要

- `diagnostics_query`：分页（`limit ≤ 500`，`offset ≤ 100000`），支持级别/模块/错误码/
  状态/窗口/`operation_id`/文本/时间范围过滤；单次扫描上限 20 万行 + 400 ms 预算，
  命中即置 `truncated`，并返回跳过（损坏/半截）行数。
- `diagnostics_summary`：按 `module + action + error_code` 分组，权重为 `count` 之和，
  返回首次/最近时间、最近状态、是否恢复、样例文案与样例 `operation_id`，以及模块/错误码分布。
- **操作链查询（诊断中心）**：按 `operation_id` 精确匹配，**不传** `levels` / `anomaliesOnly` /
  `since`，从而返回该操作所有已落盘级别（`DEBUG` 阶段仅详细诊断模式存在）；单次上限 200 条
  （取最新的 200 条，更早事件可能缺失并在界面明确提示），前端按时间升序渲染。默认异常列表
  仍使用 `anomaliesOnly: true`（最低 WARN）。没有 `operation_id` 的事件不得按模块/操作猜测关联。
- **异常聚合**：仅对 `WARN`/`ERROR`、无 `operation_id`、失败态、带错误码或文案的事件，
  按指纹（级别+模块+操作+事件+错误码）在 60 s 窗口内聚合：只写第一条原始行，窗口结束时写
  一条 `event=aggregated` 摘要行（`count` = 被抑制次数，`metadata.occurrences` = 总次数）。
  聚合表容量 256，超限先落摘要再淘汰最旧。`CRITICAL` 与带 `operation_id` 的失败从不聚合。

## 9. 诊断报告（面向开发 Agent）

`diagnostics_export` 在 `<log_dir>/exports/diagnostic-report-<时间>-<随机>.json` 生成本机文件
（**不上传**），schema 标识 `taskdock.diagnostic-report/1`，包含：

- 应用版本/构建 profile/OS/架构/`session_id`/会话开始时间；
- 查询时间范围与**实际观测到的**首末时间；
- 摘要（总/错误/警告/信息、分组、模块与错误码分布、`truncated`/`skipped`）；
- 最近关键异常（≤5000 条，权重与阶段字段齐全）；
- 日志系统自身状态（容量、写入/丢弃/队列满/聚合/轮转/失败计数、`degraded`、
  `lastWriterError`、详细模式剩余时间）；
- `privacy` 说明：`localOnly: true` 与已脱敏字段列表。

导出前会 `flush` 写线程（含聚合摘要），保证包含刚刚发生的异常；先写临时文件再 rename。

## 10. 生命周期与资源

- 启动：`lib.rs` 的 `.setup()` 中**先**确定数据目录，随后初始化诊断日志、挂载
  `tracing`（`EnvFilter` + `fmt` + `DiagnosticsLayer`），再创建窗口。
- 退出：`request_exit` 在 `EXIT_READY` 前记录 `system/shutdown` 事件并 `shutdown()` 写线程
  （刷出队列尾部与聚合摘要 + 一次 `sync_all`），然后加入线程。
- 资源上限：队列 1024 条、聚合表 256 条、单文件 5 MB、总量 25 MB、查询 20 万行/400 ms、
  导出 5000 条。**内存不随运行时间增长**。
- 前端：队列 128 条、每批 20 条、500 ms 间隔、最多 4 个在途批次；溢出优先丢
  DEBUG/INFO 并本地计数（`clientDiagnosticsStats()`）。

## 11. 错误归属与去重（前端）

一次真实失败只归属**一个主要诊断事件**：

| 入口 | 谁记录 | 说明 |
|---|---|---|
| `invokeCommand`（所有 IPC） | 这里记录唯一一条（命令名、耗时、错误码），并 `markLogged(err)` | 成功仅在详细模式记 DEBUG |
| `reportError` / `recordBackgroundError` | 仅当 `!isLogged(err)` 时补记（本地抛出的校验/状态错误） | 用户提示与重试逻辑不变 |
| `ErrorBoundary` | `getDerivedStateFromError` 先 `markLogged`，`componentDidCatch` 记一条 `ui/render` | 渲染异常只有一条，带作用域 |
| `globalErrors`（`unhandledrejection`） | 每次上报（后端按指纹聚合计数），Toast 30 s 去重 | 提示去重不丢发生次数 |
| `globalErrors`（`error`） | 记录 `ui/uncaught_error`；已被归属的错误跳过 | 覆盖事件处理器等边界外异常 |

## 12. 一致性校验

- **设置持久化回读**（`update_settings`）：写入后逐键回读，不一致/缺失记录 `CRITICAL`
  （`settings/persist_verify`，`DATA_INTEGRITY_ERROR`），只记录键名，不记录值。
- **导航布局孤儿项**（`src/lib/consistencyChecks.ts`）：设置首次加载后执行一次，校验存储
  布局中的入口 ID 是否仍存在于注册中心；无法解析回退默认或存在孤儿项时记录 `WARN`
  （`navigation/layout_check`）。一次性退订，不轮询、不改用户数据。

## 13. 接入规范（后续模块）

1. **先判断是否已有失败路径**：已有 `reportError` / `invokeCommand` 的链路不需要新增埋点，
   IPC 失败会自动归类到模块（`moduleForCommand`）。
2. **需要追踪成功路径时**用 `startOperation(module, action)`：
   ```ts
   const op = startOperation("file", "deliver", { component: "文件投递" });
   try {
     op.stage("validate");
     await deliverFile(...);
     op.success({ metadata: { file_count: 1 } });
   } catch (e) {
     op.fail(e);
   }
   ```
3. **后端**需要结构化事件时用 `diagnostics::event(DiagLevel::Warn, "clipboard", "paste_batch", "failed")`
   + `.stage()` / `.operation()` / `.status()` / `.metadata()`；**不要**为了记录日志把业务对象
   序列化后塞进 `message`。
4. **新增 metadata 键**必须先在 `privacy.rs` 的 `ALLOWED_META_KEYS` 登记；新增 `module`
   使用稳定英文小写标识，并同步到设置页筛选项说明。
5. **不要**新增轮询/定时器仅为了写日志；不要为每次点击写日志；不要把 DEBUG 写成常态。

## 14. 排查示例

| 场景 | 操作 |
|---|---|
| 创建任务失败 | 筛选 `module=task` 或 `text=create_task`，看 `error_code`、`stage=ipc`、`duration_ms` |
| 剪贴板批量粘贴失败 | 复制最近异常的 `operation_id`，用 `operationId` 过滤看 `started → stage → failed` 全链路 |
| Agent 反复失败 | 摘要按 `module=agent` 看 `count` 与 `recovered`，原始行看首次时间；高频重复已被聚合并计数 |
| 页面白屏 | 筛选 `module=ui`、`action=render`，看 `component`（窗口/作用域）与 `UI_RENDER_ERROR` |
| 设置"保存成功但未生效" | 筛选 `action=persist_verify`，`CRITICAL` 表示回读不一致，`metadata.key` 指出键名 |
| 上报上次运行 | 直接查日志目录（跨会话保留），或用报告导出后交给开发 Agent |

## 15. 已知限制

- 前端队列在进程被强杀时最多丢 500 ms 的尾部事件；正常退出会尽力 flush。
- 日志目录被外部持续占用（杀毒/索引器）时轮转可能失败：此时继续追加到同一文件，
  受总量上限保护，但单文件可能超过 5 MB。
- 聚合会把"相同指纹的高频噪声"合并为计数；需要逐条排查时用 `operation_id` 或详细诊断模式。
- 诊断日志能定位"哪个操作在哪个阶段失败"，**不能自动发现所有逻辑缺陷**；状态一致性
  校验只覆盖已接入的两条路径（设置持久化、导航布局）。

## 16. 复查修复记录（2026-11-06 第二轮）

1. **唯一入队路径**：删除内部 `push()`，模式切换/到期恢复改为走 `record()`，与普通事件共用
   `normalize()`（时间戳、`session_id`、脱敏、级别过滤）。此前 `verbose_mode/changed` 会落出
   `timestamp=""`/`session_id=""` 的坏行。
2. **动态日志级别**：`tracing` 过滤改为 `reload::Layer<EnvFilter>`，`set_mode` 与到期恢复通过
   `attach_filter_reload` 真正切换：正常 `info`，详细 `info,task_dock_lib=debug`
   （`RUST_LOG` 显式设置时始终以开发者意图为准）。仅本 crate 放开 DEBUG，第三方库仍不落盘。
3. **刷盘结果**：`flush_blocking() -> FlushOutcome { flushed, timed_out, queue_full }`；入队
   有界（300ms）+ 回执有界（2s）。导出把结果写进报告（`flushed`/`flushIssue`/`complete`），
   不完整时如实标注。
4. **清理生命周期**：单飞（并发返回 `CONFLICT`）+ 有界入队 + 回执超时后**请求取消**；
   写线程在开始删除前检查取消标记，因此不会出现"界面失败、稍后静默删除"。
   `ClearOutcome.completed` 明确区分"已执行"与"未执行"。
5. **导出上限契约**：导出改用 `query_with_limit(..., 5000)`，普通分页仍为 500；两者独立。
6. **恢复状态判定**：不再用"历史上出现过 recovered"近似。摘要按分组记录失败/恢复时间线，
   `operation_id` 精确匹配（匿名恢复只匹配匿名失败）；恢复时间必须晚于对应失败；之后再失败
   则重新显示未恢复；取消不算恢复；恢复事件不计入错误数。
7. **前端去重与计数**：主路径（IPC 失败）永不被指纹窗口抑制；次级观察者用 250ms 有界指纹
   去重，被抑制次数在下次真正落盘时以 `metadata.suppressed_since_last` 带回，不吞真实次数。
8. **失败阶段**：`startOperation` 记录最后阶段，终态 `failed` 事件在正常模式下也带 `stage`。
9. **详细模式前端同步**：客户端记住本地到期时间（无需轮询），安装时一次性 `syncDiagnosticMode()`；
   到期后立即停止发送 DEBUG，不会出现"前端还在发、后端已恢复"。
10. **导航入口**：左侧「诊断中心」（`id=diagnostics`，默认隐藏、仅左侧、不占 Ctrl+数字、
    非 locked；隐藏时经「更多」可达；可在导航自定义中开启与排序）。独立页面复用同一
    `diagnostics_*` IPC，不新建查询逻辑；设置页保留状态/模式/容量/摘要并提供「打开诊断中心」深链。

## 17. 复查修复记录（2026-11-07 第三轮）

本轮以真实日志与隔离实例复验为准，新增/修正以下长期契约：

1. **操作链双查询模式**（诊断中心）：默认「异常列表」保持 `anomaliesOnly: true`；点击记录/筛选
   chip 的「查看操作链」改为 `{ operationId, limit: 200, offset: 0 }`，不携带列表的级别、模块、
   时间范围与 `anomaliesOnly`。时间线按 `Date.parse` 升序（相同时间保持原序）；0 条、缺
   `started`、缺终态、缺 DEBUG 阶段、命中超过 200 条、扫描预算截断分别给出独立提示，不补造事件。
2. **设置页与诊断中心去重**：设置页「诊断与日志」只保留状态、容量、计数器、详细模式开关、
   最近异常摘要（24h、最多 8 组）与「打开诊断中心」；不再调用 `diagnostics_query`，不再维护
   第二套筛选/分页/导出/清理。列表、操作链、导出、清理统一在诊断中心。
3. **401 日志有界聚合**：HTTP 接入的鉴权失败按 10s 窗口聚合为一条 WARN（含窗口累计次数），
   非 401 请求降为 DEBUG；`stats().rejected_auth` 计数保留。实测 31 次未授权请求只产生 2 条
   原始 WARN（1 次 + 30 次），JSONL 内由诊断聚合合并为 1 行（`occurrences=2`），不再出现
   每请求一条 INFO。
4. **端口绑定失败限流**：`127.0.0.1:<port>` 被占用时适配器每 10s 重试；日志改为首次 +
   每 30 次（约 5 分钟）一条并带累计尝试次数。修复前实测 11 分钟产生 67 条同指纹 ERROR。
5. **导航三态复验**：默认隐藏（rail 不含诊断中心）→「更多」可达 → 导航自定义开启后按注册表
   顺序出现（规划中心之后）→ 上移排序生效 → 刷新后显隐/顺序持久化 → 「恢复完整面板默认」
   回到隐藏。不占 Ctrl+数字、不增加胶囊常驻入口、设置入口仍固定。
6. **胶囊 5px 越界归因**：历史日志 `w=500 h=700 edge=0 px=80 py=75 pw=425 ph=550` 是 125% DPI
   下「展开早于容器撑窗」的**安全拒绝**：当前 `capsule_regions` 在面板越界时返回 `None`，
   `apply_window_capsule` 返回 `false` 且不写区域。真实复现该条件（500×700、125%、面板
   425×550）返回 `false`；按容器 404×440（逻辑）撑窗后四边 `panel` 均返回 `true`，`GetWindowRgn`
   包围盒均落在窗口内。前端 `needsContainerResize` + `capsuleContainerSize` 仍是展开前置条件，
   不得绕过。
7. **胶囊几何回归测试**：新增四边 × 1.0/1.25/1.5 DPI 的包含性测试，以及容器差 1px 时
   展开必须整体失败（不得钳小面板后报告成功）的拒绝契约。
8. **诊断中心视觉/信息架构**：概览（24h 错误/警告、最近异常、容量条）、常用筛选两列
   （≤360px 单列）、高级筛选折叠、两行异常行、可展开详情（时间/operation_id/session/window/
   stage/duration/error_category/retry_count/source/metadata）、操作链时间线、底部管理区；
   区分加载中/失败/无日志/筛选无结果/截断/降级/已清理。容量 ≥60% 用提示色、>90% 也只提示
   自动轮转，不按错误色渲染。
9. **真实运行复验（新 session）**：39 条 JSONL 全部有 `timestamp`/`session_id`；无
   `Command ... not found`；详细模式落入 Rust `DEBUG` 探针「诊断日志级别已切换」并经动态
   EnvFilter 生效（正常模式 2 事件链、详细模式 3 事件链含 `stage=persist`）；恢复常规后无新增
   DEBUG。诊断中心查询/导出/清理二次确认/深浅主题/320px 视口（无横向溢出）均实测。

## 18. 复查修复记录（2026-11-11）

本轮来自隔离真实实例走查（`tmp/acceptance/diagnostics-center-real-20261111/report.md`），
修复以下长期契约问题：

1. **终态 `event` 必须等于 `status`**：`startOperation` 的 `success/fail/cancel/recovered`
   统一经 `finish()` 落盘，此前继承 `base.event="started"`，导致 JSONL 出现
   `event="started"` + `status="success"`。现在 `finish()` 显式写入 `event: status`；诊断中心
   读 `status` 的展示不受影响，按 `event` 检索/导出恢复正确语义。
2. **同毫秒操作链顺序**：后端按批次入库统一生成时间戳，短操作的 `started` 与终态常同毫秒；
   `diagnostics_query` 返回新→旧，前端不得“相同时间保持原序”。`sortByTimeAsc` 改为同时间
   反转序号（`right.index - left.index`），保证时间线先 `started` 后终态。
3. **链视图作用域**：进入操作链后，头部「导出报告」只按 `operationId` 导出当前链路，
   「复制摘要」复用链路脱敏摘要；不再静默作用于异常列表筛选。
4. **异常行可访问名称**：移除行按钮的 `aria-label`（此前全部读作「展开详情」），由行内
   module/action/message 提供可访问名称，保留 `aria-expanded`。
5. **异步状态分键**：诊断中心的加载/导出/清理改为独立的 `busy.load/export/clear`，
   加载结束不再提前清空仍在进行的导出/清理 spinner。

定向验证：`npx vitest run src/components/diagnostics/DiagnosticsCenterPanel.test.tsx
src/lib/diagnostics.test.ts`（42 tests passed）、`npx tsc --noEmit`（退出码 0）。

## 19. 记录项修复（2026-11-11）

诊断中心「异常列表」中出现的系统事件也需要修复源头，而不是只改展示：

1. **设置白名单补齐**：设置页「诊断与日志」可修改的
   `agent_event_retention_days` / `agent_event_max_rows` / `agent_event_archive` /
   `perf_diagnostics_enabled` 此前不在 `update_settings` 白名单，保存会报「未知设置键」
   并被诊断日志记录为一次真实失败。现已加入白名单并按类型/范围校验：
   保留天数 0–365（0 = 不按时间清理）、最大行数 0–1,000,000,000（0 = 不按行数清理），
   归档与性能诊断仅接受布尔值。
2. **HTTP 端口被另一实例占用**：`http_ingest` 绑定失败时先请求
   `GET /api/v1/health`；若响应 `service="task-dock"`，说明是另一个 Task Dock 实例
   （正式安装版 + `TASK_DOCK_DATA_DIR` 隔离实例），日志降为 WARN 并明确「本实例会在端口
   释放后自动接入」；其他程序占用仍记 ERROR。探测超时/失败一律按其他程序处理。
3. **热键冲突消息**：`Occupied` 不再拼接插件内部的
   `HotKey { mods: ..., key: ..., id: ... }` Debug 文本，改为「该组合已被其他程序占用」/
   「系统拒绝注册（可能已被其他程序占用）」；组合名已由日志的 `accelerator` 字段记录。

边界：多个实例争用全局资源（热键、固定 HTTP 端口）属于部署/验收场景，不会因为「修复」
变成两个实例都可注册；诊断日志现在会准确区分「同族实例占用」与「真实故障」，避免误报。

真机复验（2026-11-11 20:26–20:31，两个隔离实例）：后启动实例记录
`WARN agents/http_ingest ... 已被另一个 Task Dock 实例占用`（无 ERROR）；前者退出后约 10s
后者自动接管 47821。设置页「性能诊断」开关与保留天数经真实 UI 修改后回读一致
（`perf_diagnostics_enabled` true↔false、`agent_event_retention_days` 30→32→30），
诊断日志无 `update_settings` 失败事件。

## 20. 启动空白（界面「崩溃」）修复（2026-11-11）

**现象**：开发实例启动后窗口还在，但客户端区域空白（有时露出原生标题栏），用户看不到
任何 UI；诊断中心只看到一条 `前端未在 4000ms 内确认就绪`，没有可归因的异常记录。

**根因**（CDP + 真实 WebView2 复现）：Vite 开发服务器默认 `optimizeDeps.holdUntilCrawlEnd =
true`，大模块图的入口依赖扫描完成前不返回模块请求；本仓库可把 `/src/main.tsx` 及依赖卡住
40–100s。此时 `#root` 为空、`installGlobalErrorHandlers` / ErrorBoundary 都还没执行，窗口
透明（Tauri `transparent: true`）→ 看起来像「窗口在但 UI 崩溃」。热重载后 Vite 已有模块
缓存，首屏恢复 1s 级，所以用户会觉得「刚才崩溃了/又好了」。同一机制也解释了 4s 兜底告警。

**修复**：

1. **静态启动占位**（`index.html`）：内联样式 + 经典脚本先于所有模块执行；显示
   「正在启动…」，4s 改为「加载组件可能稍久」，15s 显示重试按钮。期间窗口始终有可见内容，
   不再空白。React 挂载（`#root` 出现子节点）后占位淡出移除。
2. **启动看门狗上报**：经典脚本先安装 `error` / `unhandledrejection` 监听（补齐模块初始化
   之前无处理器的缺口）；15s 未挂载直接经 `diagnostics_record` 写
   `ui/boot_timeout`（WARN，`UI_BOOT_TIMEOUT`，metadata：`reason=frontend_root_not_mounted`、
   `event_count`）。挂载成功但耗时 ≥4s 或捕获到启动期错误时写 `ui/boot_slow`
   （WARN，`UI_BOOT_SLOW`，`duration_ms` 为实测耗时）；正常快速启动不写记录。
3. **后端结构化超时**：`lib.rs` 的启动兜底线程仍按 4s 撤销 1×1 空白区域（让窗口先可见），
   但只在 **10s** 后仍未收到 `notify_ui_ready` 时写
   `window/startup_ready_timeout`（WARN，`UI_BOOT_TIMEOUT`），消息带 mode、窗口物理尺寸、
   scale，metadata 为 `mode` / `reason=frontend_not_ready`。`commands/system.rs` 的
   `notify_ui_ready` 置位 `UI_READY`。这样开发态 5–8s 的正常加载不会产生异常记录。
4. **开发首屏加速**（`vite.config.ts`）：`optimizeDeps.holdUntilCrawlEnd = false`，先放行
   已发现依赖、后续发现新依赖由 Vite 客户端整页重载补齐；并给主窗/快速捕获/右键菜单/
   通知/标签提示/微件入口加 `server.warmup.clientFiles`。实测修复前冷启动 40–100s 才挂载，
   修复后约 3.5s 挂载、占位正常淡出。

需要注意：`ui/boot_timeout` / `ui/boot_slow` 来自 `index.html` 的经典脚本，不经过前端
`diagnostics.ts` 队列；字段使用后端 `parse_frontend_event` 接受的 snake_case，metadata 只
使用隐私白名单内 key（`reason` / `event_count` / `mode`）。`window/startup_ready_timeout`
来自 Rust 结构化事件，出现在诊断中心「异常列表」中可按 `module=window` 筛选。



## 21. 文件投递业务失败记录与旧库兼容（2026-11-12）

**问题**：收集箱把 PNG 拖入「文件 → 目录卡片」时，界面显示
`成功 0 项 · 跳过 0 项 · 失败 1 项 / 写入复制日志失败，未执行复制：数据库错误：CHECK constraint failed: op IN ('move')`，
但诊断中心没有任何记录。原因有两层：

1. 业务失败没有诊断归属：`shelf_drop_to_directory` 即使 `failed > 0` 也是**成功返回**
   `DropReport`，`invokeCommand` 不会产生 IPC 失败事件；此前没有任何层把逐条结果转成诊断事件。
2. 数据库结构陈旧：用户库 `PRAGMA user_version = 46`，但 `shelf_file_ops.op` 仍是旧版
   `CHECK (op IN ('move'))`。历史构建写下的 v34 表与现行源码（`('move','copy')`）不一致，
   而迁移只按 `user_version` 前进、不会重放。修复见 `ARCHITECTURE.md` 的 v47 迁移说明。

**事件契约（Rust 业务边界，`commands::shelf::shelf_drop_to_directory`）**：

- `module = file`，`action = shelf_drop_to_directory`，`operation_id = DropReport.batch_id`；
- 汇总事件（每次业务返回一条）：
  - 全部成功（含正常跳过）→ `INFO`，`event = drop_completed`，`status = success`；
  - 部分失败 / 含 partial → `WARN`，`event = drop_partial`，`status = failed`；
  - 全部失败 → `ERROR`，`event = drop_failed`，`status = failed`；
  - 全部失败但全部是明确预期拒绝（校验 / 不支持 / 冲突 / 目标不可用）→ `WARN`；
  - 命中 `SHELF_DROP_DB_SCHEMA_INCOMPATIBLE` 时即使还有成功项也升级为 `ERROR`；
- 明细事件：按（稳定错误码, 阶段）聚合，`event = drop_item_failed`，最多
  `MAX_DROP_FAILURE_EVENTS = 4` 条；汇总事件 metadata 的 `failure_groups` 保留真实分组数；
- 汇总 metadata（白名单已登记）：`total` / `success` / `skipped` / `failed` / `partial` /
  `mode`（copy|move）/ `target_id` / `failure_groups`；不含路径、文件名、原始错误文本；
- 正常跳过（同名策略、已在目标目录内）不是失败，只计入 `skipped`；
- 写诊断失败不改变投递结果：`Diagnostics::record` 非阻塞，队列满/降级只计数。

**稳定错误码**：

| 错误码 | 分类 | 含义 |
|---|---|---|
| `SHELF_DROP_DB_SCHEMA_INCOMPATIBLE` | database | 操作日志表结构不兼容（旧 CHECK、缺表/缺列） |
| `SHELF_DROP_DB` | database | 其他数据库读写失败 |
| `SHELF_DROP_SOURCE_MISSING` | not_found | 源文件已不存在 |
| `SHELF_DROP_TARGET_UNAVAILABLE` | not_found | 目标目录在操作前已不可用 |
| `SHELF_DROP_ACCESS_DENIED` | permission | 权限拒绝 |
| `SHELF_DROP_FILE_BUSY` | io | 文件被占用（共享/锁冲突） |
| `SHELF_DROP_CONFLICT` | conflict | 目标已存在且策略不允许覆盖 |
| `SHELF_DROP_IO` | io | 其他文件读写/校验失败 |
| `SHELF_DROP_VALIDATION` | validation | 参数/路径校验拒绝 |
| `SHELF_DROP_UNSUPPORTED` | unsupported | 明确不支持的语义（如移动托管副本） |
| `SHELF_DROP_PARTIAL` | integrity | 目标完整、源清理或引用更新未完成 |
| `SHELF_DROP_MULTI_FAILURE` | unknown | 一次批次存在多种失败分类时的汇总码 |
| `SHELF_DROP_UNKNOWN` | unknown | 未能归类的失败 |

**可见性**：默认异常列表（WARN+、最近 24 小时）可直接看到汇总与明细；按
`operation_id = batch_id` 可打开完整操作链；错误码可直接筛选。收集箱结果条在
`failed > 0 || partial > 0` 时提供「查看诊断」入口（一次性导航意图，不轮询、不新建弹窗）。

**去重边界**：IPC 层失败（目标不可用、参数非法等 `Err` 返回）仍由
`invokeCommand → logIpcFailure` 记录一条 `stage = ipc` 的事件；业务汇总事件只在
`Ok(report)` 时写入且 `stage = business`，同一故障不会在两层各记一次。

## 22. 暂存添加业务结果分级与结构化失败（2026-11-12）

**问题**：`shelf_add_paths` 即使逐条失败也是 `Ok(ShelfAddReport)` 返回，
`useShelfStore.addPaths` 无论 `failed.length` 多少都写一条 `success`；诊断中心因此只看到
「添加成功」，用户只能从界面 Toast 感知失败。与此同时 `ShelfFailedEntry` 只有
`path/reason` 自由文本，前端无法稳定分级或聚合。

**后端契约（`commands::shelf::ShelfFailedEntry`）**：保留 `path` / `reason`，新增可选
`code`（`AppError::code`）与 `category`（`AppError::category`）；`None` 时字段不序列化，
旧前端忽略即可。无底层错误的明确拒绝（如剪贴板快照 `Unsupported`）使用
`UNSUPPORTED` / `unsupported`。单条失败不阻断其他文件，添加语义不变。

**前端汇总事件（`useShelfStore.addPaths`，`module = file`、`action = shelf_add_paths`、
一次投递一个 `operation_id`）**：

| 结果 | level / status | stage | error_code |
|---|---|---|---|
| `failed=0 && added>0`（全成功） | `INFO` / `success` | —（终态不带 stage） | 无 |
| `added>0 && failed>0`（部分失败） | 见下方级别规则 / `failed` | `persist` | `SHELF_ADD_PARTIAL_FAILED` |
| `added=0 && failed>0`（全部失败） | 见下方级别规则 / `failed` | `persist` | 全部失败码一致且非空时复用真实后端码，否则 `SHELF_ADD_FAILED` |
| `paths` 非空但 `added=0 && failed=0` | `WARN` / `failed` | `persist` | `SHELF_ADD_NO_INPUT`（`category = validation`） |
| 参数/IPC 抛错 | `invokeCommand` 既有推断（validation → WARN，其余 ERROR） | `ipc`/最后阶段 | 真实 `AppError` 码 |

级别规则（部分/全部失败）：任一失败 `category = integrity`（或
`code = DATA_INTEGRITY_ERROR`）→ `CRITICAL`；全部失败均为
`validation / not_found / unsupported / conflict` → `WARN`；其余（`io / permission /
service / timeout / database / unknown`…）→ `ERROR`。`OperationExtras` 新增可选
`severity` / `stage`，允许业务汇总覆盖 `fail()` 的推断，旧调用方行为不变。

**metadata（均已登记 `ALLOWED_META_KEYS`）**：`count` / `total` / `added` / `failed` /
`mode` / `source`；失败时附 `failure_codes`（去重、最多 3 个、逗号分隔、单个 ≤40 字符）。
不含路径、文件名、正文或原始堆栈；`path` 只存在于返回给 UI 的 report。

**阶段推进**：`validate → persist → finalize`；`finalize` 仅在有新增条目时执行（本地乐观
合并 + 权威列表/元数据刷新）。若收尾刷新失败，追加一条
`WARN / stage=finalize / error_code=SHELF_ADD_REFRESH_FAILED` 事件（**不带 status**，
避免同一 `operation_id` 同时出现 failed 与 success 两个终态），但**不改写添加结论**、
不 reject `addPaths`，仍返回后端 report。

**可见性**：上述 WARN 及以上事件可在默认异常列表（WARN+、最近 24 小时、`module=file`）
直接看到；按 `operation_id` 可打开操作链；`SHELF_ADD_PARTIAL_FAILED` /
`SHELF_ADD_FAILED` / `SHELF_ADD_NO_INPUT` / `SHELF_ADD_REFRESH_FAILED` 可直接按错误码
筛选。前端单测与 Rust 诊断查询测试覆盖这三条路径。

## 22a. 预检失败并入同一操作（2026-11-13 更正）

上一节表格中「部分失败/全部失败」行的 `stage` 与数量口径自本日起更正：拖入路径的客户端
预检（空白/相对路径）从 `ShelfWorkspace` UI 层**下沉到 `useShelfStore.addPaths` 内部**，
预检失败与后端失败共用同一个 `operation_id` 与同一份返回值，修复「UI 报告合并了无效项、
诊断却只统计有效项」的数量不一致，以及「全部路径无效时不产生任何诊断操作」的缺口。

| 结果 | level / status | stage | error_code |
|---|---|---|---|
| 全部输入无效（`total>0` 且有效项为 0，不调后端） | `WARN` / `failed` | `validate` | `SHELF_ADD_ALL_INVALID`（新增，`category = validation`） |
| 空数组（`total=0`，不调后端） | `WARN` / `failed` | `validate` | `SHELF_ADD_NO_INPUT` |
| 混合输入后端无失败条目（失败全部来自预检） | 见级别规则 / `failed` | `validate` | `SHELF_ADD_PARTIAL_FAILED`（有新增）或全部失败码一致时复用预检码 |
| 混合输入且后端返回失败条目 | 见级别规则 / `failed` | `persist` | 同上一节规则 |

其余口径：`metadata.total` = **原始输入总数（含无效项）**；`failed` = 预检失败 + 后端失败
之和；`failure_codes` 可包含预检码 `empty_path` / `relative_path`（沿用去重 ≤3、单个
≤40 字符约束）；返回给 UI 的 `failed` 数组为「预检失败在前、后端失败在后」，UI 与诊断
数量严格一致。预检失败条目带 `category: "validation"`，级别仍按预期拒绝归 `WARN`。
调用方不再预过滤路径（文件选择器路径必为绝对路径，行为不变）；胶囊「最近暂存」与完整
暂存架拖入共用此契约。
