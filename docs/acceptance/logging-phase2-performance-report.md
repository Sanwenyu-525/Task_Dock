# 日志系统第二阶段（logging-phase2）性能验收报告

- 报告日期：2026-11-20（UTC+8）
- 运行模式：**Dev 功能验收（Debug 测试二进制 + 模块级定向测试）**；本报告**不给出**正式性能
  基线结论，无 Release 构建、无 buildId。
- 工作目录：`D:\Develop\task_dock`；Git HEAD：`5b6c671`；共享工作区含其他任务在途改动。
- 检查依据：`AGENTS.md` §5.3（性能结论必须附可复核条件）、§7 报告口径；
  `unified-observability-design.md` §4.5；`DIAGNOSTICS.md` §25.2；
  `interfaces.md` §3.2（指标汇总契约）/§3.3（导出预览契约）。

> **性能口径（必须如实表述）**：
> - 指标窗口是「**进程启动以来累计**」（`window="process"` + `startedAt`/`generatedAt`），
>   **不是**滚动「最近 24 小时」；重启进程即重置。
> - 聚合不逐帧/逐条打点：投屏逐帧、剪贴板逐条原始事件、高频轮询不进指标；按业务批次聚合。
> - 本报告所有耗时/体积数字来自 **Debug 测试二进制或合成日志**，不得外推为 Release 性能结论；
>   未做 RSS/堆/CPU 采样，未做开/关日志对照基准。

---

## 1. 任务范围

1. **指标聚合体系**：阈值触发、有界聚合（计数/失败/slow/avg/max/p95）、容量淘汰、异步计时
   与 Drop 兜底。
2. **业务入口埋点覆盖**：文件、搜索、回收站、资源扫描、剪贴板、设备同步、MCP、Agent 任务、
   桌面启动（startup）。
3. **日志与导出有界性**：诊断事件落盘有界、导出记录/体积上限、预览扫描预算。
4. **阈值校准与正式基线**：候选阈值在真实 Release 负载上校准；CPU/内存/启动耗时基线。

**不在范围**：UI 动画流畅度、真实帧率、网络/数据库本体性能；其他模块的性能优化。

## 2. 检查依据与方法

- 代码核对：`src-tauri/src/diagnostics/metrics.rs`、`diagnostics/query.rs`、前端
  `src/lib/diagnostics.ts`、`src/components/diagnostics/` 性能视图。
- 方法：定向 Rust/JS 测试 + 合成日志导出样本 + 源码走读；初稿未在 Dev 实例做长驻运行采样；
  2026-11-20 17:36 补做单次 Dev 指标实测（§5.6）；仍未做基准脚本（M13 未执行）。
- 证据优先级：原始测试日志 > 子任务 report.md > 文档。

## 3. 环境

- Windows 本地 PC；Debug 构建；初稿未启动 `npm run tauri dev` 长驻实例；17:36 补做隔离 Dev
  实例（数据目录 `tmp/debug/logging-phase2-dev4`，CDP 9223，运行期 HEAD `7cc15d1`、dirty 154，
  Rust 二进制为 16:54 构建）；无 Android 真机/模拟器。
- **D: 盘 ENOSPC 事故**：当日 D: 盘写满至 0 字节，主智能体删除可再生构建产物
  `src-tauri/target/debug`（约 8.0 GB）后恢复约 7.0 GB；部分既有套件复测仅前台控制台通过，
  落盘日志为阻塞记录。详见总报告 §3.2。
- **整 `cargo test --lib` 被其他任务在途未跟踪文件
  `src-tauri/src/agent_access/tests_v82_rest.rs`（非 ASCII 字节串语法错误）阻塞**：
  ENVIRONMENT BLOCKED，非本任务缺陷；性能相关模块以定向测试 + `cargo check --lib` 取证。
- 构建/采样条件未记录：机器空闲状态、样本数、二进制 sha256、工具链版本、隔离数据目录等正式
  基线要素本轮均未采集（见 §7 遗留风险）。

## 4. 命令与结果

| # | 命令（工作目录 `D:\Develop\task_dock`） | 退出码 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | `cargo test --lib diagnostics::metrics` | 0 | 14 passed / 0 failed / 0 ignored（2588 filtered），0.78s | `metrics/test-metrics.log` |
| 2 | `cargo test --lib diagnostics::query` | 0 | 13 passed / 0 failed（2555 filtered），1.67s | `export-preview/test-query-pass.log` |
| 3 | `cargo test --lib diagnostics::query::tests::large_log_export_is_bounded` | 0 | 1 passed；合成 50,000 行日志 → `records=5000`、`bytes=1348773`（约 1.29 MiB）、`elapsed=810.9732ms`（Debug） | `export-preview/test-large-log.log` |
| 4 | `vitest run` 诊断中心组件 | 0 | 1 文件 29 passed（性能视图窗口文案/字段渲染组件级） | `diagnostics-ui/diagnostics-test.log` |
| 5 | `vitest run` 弹层定位回归 | 0 | 3 文件 51 passed | `diagnostics-ui/positioning-test.log` |
| 6 | `npm run typecheck`（主智能体） | 0 | 无类型错误 | 主会话静态检查记录 |
| 7 | `npm run cargo -- check --lib`（主智能体） | 0 | lib 编译通过；36 条既有警告，无新增阻断 | 主会话静态检查记录 |
| 8 | 既有套件前台对照（agents::pipeline 31 / mobile_sync::sync 17 / commands::clipboard 6 / recycle 42 过 1 ignored / global_search 18 / clipboard:: 260 过 1 ignored） | — | 前台控制台通过；落盘日志受 ENOSPC 阻塞，仅作既有基线参照，**不作为本任务指标断言证据** | `metrics/` 控制台记录；`metrics/report.md` §4.2 |
| 9 | `cargo test --lib mcp`（既有对照） | 0* | 71 passed / 1 既有失败（schema 在途，非本任务引入） | `metrics/test-mcp.log` |

\* 既有失败不计入本报告性能结论。

## 5. 已验证的性能事实（模块级）

### 5.1 聚合模型与有界性（14 个 metrics 用例覆盖）

- 指纹（module+action）容量 `MAX_FINGERPRINTS=256`；超限淘汰最久未活跃指纹并计 `evicted`；
  每指纹最近 `SAMPLE_WINDOW=64` 个耗时样本环形窗口算 p95；淘汰计数与样本窗口行为有用例断言。
- 聚合在调用线程完成，不新增常驻线程；锁内无 IO、无系统调用；锁中毒时恢复内部状态继续工作，
  不 panic（设计约束，见 `metrics.rs` 文件头注释）。
- 指标条目：`count` / `failures` / `slow_count` / `avg_ms` / `max_ms` / `p95_ms`；汇总附
  `fingerprints` 与 `evicted`；输出按 module+action 排序确定。
- 阈值触发：常规操作只更新内存聚合；超过阈值才产生一条 WARN（`stage=slow`，错误码
  `SLOW_OPERATION`）；等于阈值不算超（用例断言 200ms 边界：150/200 不触发，201 触发）。

### 5.2 异步计时

- `record_duration_async(module, action, started: Instant)` 接收已流逝起点；
  `OperationTimer::new` 记录起点，显式 `finish()` 消费入账；未 finish 即 Drop（早退/取消/
  panic 展开）由 Drop 兜底记录一次；`finished` 标志防重复入账；计时器持有 `Instant` 与自有
  字符串，`Send` 可跨 await。失败计数由调用方在错误路径显式记录，计时器不推断失败。

### 5.3 埋点覆盖与高频路径控制

| module | action | 当前阈值（ms，候选值） | 聚合粒度 |
|---|---|---|---|
| `file` | `list_dir` | 1500 | 每次目录加载 |
| `search` | `query` | 1000 | 每次查询 |
| `recycle` | `list` | 默认 1000（表内未单列） | 每次枚举 |
| `resource` | `snapshot` / `preview` / `disk_analyze` / `junk_scan` | 5000 | 每次扫描动作 |
| `clipboard` | `capture` | 200 | 一次入库捕获聚合一次，不逐条原始事件打点 |
| `mobile_sync` | `pull` / `apply_push` | 5000 | 按一次 pull / 一批 push 聚合 |
| `mcp` | `tool_call` | 10000 | 每次工具调用；`ToolError::Authz` 拒绝不计失败聚合（走 MCP 审计表） |
| `agent` | `submit` | 30000 | 一次 submit 请求聚合 |
| `startup` | `first_ready` | 3000 | **已接线**（`lib.rs` STARTUP_START + `notify_ui_ready` 首次收尾）；Dev 实测 3879 ms（单次 Debug 样本），正式基线未取证 |

- **不打点的高频路径**：投屏逐帧、剪贴板逐条原始事件、通知对账/文件扫描类轮询。
- 各命令模块内暂无指标入账断言用例；埋点代码经测试 harness 编译通过，运行时聚合待 Dev 实例
  或后续基线验证。

### 5.4 导出与扫描有界性样本（Debug，合成日志）

- 预览扫描预算：`MAX_SCAN_LINES=200_000`、`SCAN_BUDGET=400ms`；超限 `truncated=true`，
  预览不连库、不落盘。
- 导出上限：`MAX_EXPORT_RECORDS=5_000`；`MAX_FILE_BYTES=5MiB`；审计段
  `MAX_AUDIT_RECORDS=100`；`BufWriter` + `serde_json::to_writer_pretty` 流式落盘，临时文件
  rename 原子替换。
- 样本：50,000 行合成日志导出 → 记录封顶 **5000**，报告 **1,348,773 字节（约 1.29 MiB）**，
  耗时 **810.97ms**（Debug 测试二进制）；未做 RSS/堆采样，未做关日志对照。

### 5.5 修改文件与关键位置（性能相关）

| 层 | 文件 | 关键位置/职责 |
|---|---|---|
| Rust 指标 | `src-tauri/src/diagnostics/metrics.rs` | `MAX_FINGERPRINTS=256`、`SAMPLE_WINDOW=64`；阈值表；`record_duration_async`；`OperationTimer`（finish/Drop 兜底/防重复/Send）；`started_at()` 进程窗口 |
| Rust 导出/扫描 | `src-tauri/src/diagnostics/query.rs` | `MAX_SCAN_LINES=200_000`、`SCAN_BUDGET=400ms`；`MAX_EXPORT_RECORDS=5_000`；`MAX_FILE_BYTES=5MiB`；`MAX_AUDIT_RECORDS=100`；流式 `BufWriter` + 原子 rename |
| 前端指标门面 | `src/lib/diagnostics.ts` | 与 Rust 同名语义的 `measureOperation` / `recordDuration` / `recordSlowOperation` / `recordFailure`；前端不做聚合 |
| 前端性能视图 | `src/components/diagnostics/`（`PerformanceSection.tsx` 等） | 「进程启动以来」窗口文案、`startedAt`/`generatedAt` 展示、条目字段渲染 |
| 业务埋点 | file/search/recycle/resource/clipboard/mobile_sync/mcp/agent 各命令模块 | 按 §5.3 表登记的 module/action 与阈值；startup 已 Dev 实测单次（3879 ms） |

### 5.6 Dev 实例指标实测（2026-11-20）

在独立数据目录 `tmp/debug/logging-phase2-dev4` 启动 Debug 桌面实例，使用 CDP 打开诊断中心
「性能分析」页，实测结果：

| 字段 | 值 |
|---|---|
| 数据窗口 | `进程启动以来`（非「最近 24 小时」） |
| `startedAt` | 2026-11-20 09:36:14（UTC；本地 17:36:14） |
| `generatedAt` | 2026-11-20 09:40:13（UTC；本地 17:40:13） |
| `startup/first_ready` | 平均 3879 ms，P95 3879 ms，慢操作 1，失败率 0%，次数 1 |
| `resource/snapshot` | 平均 220 ms，P95 220 ms，慢操作 0，失败率 0%，次数 1 |

这是 **单次 Debug 样本**，只证明 startup 埋点在真实 Dev 实例中入账、窗口语义正确；不能作为
启动性能基线，也不代表命令模块指标已逐项验证。证据见 `final/dev-ui.md` 与
`final/dev-ui/performance.png`。

## 6. 未验证 / 证据不足项

| 项 | 状态 | 原因 |
|---|---|---|
| Release 正式性能基线（启动耗时、p50/p95、CPU/内存稳态） | **未执行** | 未出 Release 安装包；无干净构建工作区采样；无开/关日志对照基准脚本（M13 未执行） |
| 阈值校准 | **证据不足** | 阈值表为设计候选值，未在真实负载上校准；偏松/偏紧未知 |
| 长驻运行内存与 CPU 曲线 | **未执行** | 未做长驻采样；指标注册表淘汰行为仅由单测断言，无运行期内存占用证据 |
| 命令模块指标入账运行时表现 | **已实现未验证** | file/resource/recycle/clipboard/sync/agent/mcp 模块内无指标断言用例；harness 编译通过 |
| 桌面 startup（first_ready）埋点 | **已 Dev 验证（单次样本）** | 阈值表就位；`lib.rs` 起点与 `notify_ui_ready` 首次收尾已接线；Dev 实例实测 3879 ms / P95 3879 ms / 慢操作 1；正式 Release 基线未执行 |
| Android 日志写入性能与容量行为 | **已实现未验证** | JVM 单测覆盖队列/轮转/降级逻辑；真机写入吞吐、文件实际体积、7 天清理未取证 |
| 大日志在真实用户数据目录下的导出耗时/体积 | **证据不足** | 样本为合成日志；真实历史日志分布、重复行与 metadata 体积未测 |
| 整库性能相关回归 | **ENVIRONMENT BLOCKED** | `tests_v82_rest.rs` 阻塞整 `cargo test --lib` |

## 7. P0–P3 问题清单

### P0

- 未在本任务定向证据中发现 P0（无观察到的崩溃、无界内存增长或核心流程阻塞）。证据边界：
  无长驻采样、无 Release 构建，不能据此排除性能回归。

### P1

| # | 现象 | 根因 | 影响 | 证据 |
|---|---|---|---|---|
| P1-1 | 整库性能相关 Rust 测试无法全量回归 | 在途未跟踪文件 `tests_v82_rest.rs` 语法错误阻塞编译 | 指标/导出牵连链路未在绿构全量验证 | 总报告 §3.3 |
| P1-2 | 无正式性能基线与基准脚本 | M13 未排期执行 | 阈值、有界性与导出体积缺少 Release 对照；当前数字不可作为发布性能承诺 | §6 |

### P2

| # | 现象 | 根因 | 影响 | 证据 |
|---|---|---|---|---|
| P2-1 | 业务命令模块指标入账缺运行时断言 | 埋点随命令模块接入，模块内无单测 | 埋点漏挂/阈值错配只能靠 Dev 实例或基线发现 | `metrics/report.md` §1.2 |
| P2-2 | ~~startup 埋点已接线但无运行时观测~~ **已解决（Dev 实测）** | 收尾阶段未启动 Dev 实例采样；2026-11-20 17:36 补做 | 已观测 `startup/first_ready` 3879 ms / P95 3879 ms / 慢操作 1；正式 Release 基线仍需补 | `final/dev-ui.md` §3.1；本报告 §5.6 |
| P2-3 | 导出估算为保守下限：审计单条体积未计入预览 | 预览不读审计表 | 勾选审计段后的实际体积可能高于预览估算 | `export-preview/report.md` §3.2 |

### P3

| # | 现象 | 根因 | 影响 | 证据 |
|---|---|---|---|---|
| P3-1 | 既有失败用例 `tool_defs_are_complete_and_unique` | MCP schema 在途，非本任务引入 | mcp 套件未全绿；不影响指标聚合结论 | `metrics/test-mcp.log` |
| P3-2 | 既有 ignored 用例（recycle 1、clipboard 1） | 套件既有标记 | 不计为通过项 | `metrics/report.md` §4.2 |

## 8. 遗留风险

1. **Debug 数字不可外推**：810.97ms / 1.29 MiB 来自 Debug 合成日志；Release 优化、真实日志
   分布与磁盘缓存条件下数字会变化，发布前须在干净构建工作区重测。
2. **内存有界性待长驻验证**：256 指纹 / 64 样本窗口为代码约束；长驻运行的实际 RSS 与淘汰
   频率需采样确认，不得凭单测宣称「无泄漏」。
3. **阈值误报/漏报**：候选阈值未校准；上线后应结合慢操作 WARN 事件分布回调阈值表。
4. **磁盘事故后重建**：`target/debug` 已被删除；后续全量编译与首次测试耗时需重新预检磁盘
   空间（`AGENTS.md` §5.3）。
5. **阻塞解除后复测**：`tests_v82_rest.rs` 修复后重跑 `diagnostics::metrics`、
   `diagnostics::query`、`mcp`、`agents::pipeline`、`mobile_sync` 等模块并记录基线条件。

## 9. 结论

**证据不足（正式性能基线）；模块级指标聚合与有界性部分通过。**

- **部分通过的部分**：指标聚合模型、容量淘汰、异步计时与 Drop 兜底、阈值触发边界、导出/扫描
  有界性，有 14 个 metrics 用例、13 个 query 用例与大日志合成样本的定向证据；窗口口径
  （进程启动以来累计，非 24 小时）已在代码、前端视图与 Dev 实测中确认。
- **Dev 实测补充**：诊断中心「性能分析」页显示数据窗口「进程启动以来」，
  `startup/first_ready` 3879 ms / P95 3879 ms / 慢操作 1 / 失败率 0% / 次数 1，
  `resource/snapshot` 220 ms；只证明埋点真实入账，单次 Debug 样本不构成基线。
- **证据不足的部分**：Release 启动耗时、p50/p95、CPU/内存稳态、阈值校准、长驻内存曲线、
  真机/真实数据目录表现均未执行；现有数字来自 Debug 测试二进制，不构成正式性能结论。
- 后续补做条件：集成快照 Release 构建 → 干净构建工作区 → 隔离数据目录 → 记录二进制
  sha256/工具链/机器空闲状态/样本数 → 开/关日志对照基准 → 按 `docs/TESTING.md` 与
  `docs/PERFORMANCE_*.md` 留痕。

## 10. 证据路径清单

仓库内（`D:\Develop\task_dock\tmp\acceptance\logging-phase2\`）：

- `final/dev-ui.md`；`final/dev-ui/performance.png`（Dev 性能分析三视图与 startup 入账）
- `metrics/test-metrics.log`（14 passed）；`metrics/test-mcp.log`（71 passed / 1 既有
  failed）；`metrics/` 目录其它控制台记录；**`report.md` 兜底副本**：
  `C:\Users\ASUS\AppData\Local\DoubaoWork\User Data\Profile 1\.doubaowork\agent_mode\workspace\.sessions\38455111763599362\agents\s_000tJuwvV4g\report.md`
- `export-preview/report.md`；`test-query-pass.log`（13 passed）；`test-large-log.log`
  （50k → 5000 / 1,348,773 B / 810.97ms）
- `diagnostics-ui/report.md`；`diagnostics-test.log`（29 passed）；`positioning-test.log`
  （51 passed）
- `trace-wiring/report.md` 兜底副本：
  `C:\Users\ASUS\AppData\Local\DoubaoWork\User Data\Profile 1\.doubaowork\agent_mode\workspace\.sessions\38455111763599362\agents\s_000tJuwvBI6\evidence\logging-phase2\trace-wiring\report.md`

代码位置：

- `src-tauri/src/diagnostics/metrics.rs`（聚合注册表、阈值表、`OperationTimer`、`started_at`）
- `src-tauri/src/diagnostics/query.rs`（预览预算、导出上限、流式落盘）
- `src/components/diagnostics/` 性能分析视图（窗口文案与字段）
