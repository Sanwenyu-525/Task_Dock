# 性能测试与压测方法（v0.5）

> 本文只描述**如何测量**与**判定标准**。本次实测结果、机器配置与未完成项见
> [PERFORMANCE_ACCEPTANCE_REPORT.md](PERFORMANCE_ACCEPTANCE_REPORT.md)。
> 严禁把 Mock/模拟结果或估算数字当作真机性能数据。

## 1. 测试层次

| 层次 | 工具 | 覆盖 | 不覆盖 |
| --- | --- | --- | --- |
| 后端管线 + SQLite | `src-tauri/tests/ingest_perf.rs`（ignored 集成测试） | 真实 `IngestPipeline`、真实 `ingest_core` 事务、真实 WAL 数据库、真实延迟分位 | WebView2、托盘、系统通知 |
| 真机全链路 HTTP | `scripts/perf/ingest-load.mjs` | 真实 Tauri 进程、HTTP 鉴权/并发/超时/429/503、前端刷新与托盘副作用 | 真实第三方 Agent 行为/进程开销 |
| 交互性能 | 应用内「设置 → 性能诊断」+ 前端 `getAgentRefreshMetrics()` | 队列深度、快照请求数/合并数/最大并发、SQLite 慢查询 | 自动化浏览器帧率（需真机会话） |

Mock 适配器的事件在 UI/通知中标注「模拟」，**不得**用于性能验收结论。

## 2. 环境记录模板

每次压测在结果 JSON 中自动记录：OS/架构/逻辑 CPU/构建 profile/应用版本。
真机全链路测试还需人工补充：

- CPU / 内存 / 磁盘类型（SSD/HDD）/ Windows 版本；
- Task Dock 构建方式（`npm run tauri build` 正式版 / debug）；
- Agent 侧并发情况（是否同时有真实 Agent 运行）；
- 数据库初始规模（`agent_events` 行数、DB 文件大小）。

## 3. 后端管线压测（A–E）

```bash
cd src-tauri
cargo test --release --test ingest_perf --no-run   # 先构建 release 测试二进制

# 场景 A：10 Agent × 50 事件/秒 × 10 分钟（默认）
cargo test --release --test ingest_perf scenario_a -- --ignored --nocapture

# 场景 B：200 事件/秒 × 60 秒突发
cargo test --release --test ingest_perf scenario_b -- --ignored --nocapture

# 场景 C：持续过载（队列 64 / 批 10 / 注入 30ms 慢写）
cargo test --release --test ingest_perf scenario_c -- --ignored --nocapture

# 场景 D：故障注入（约 2 秒）
cargo test --release --test ingest_perf scenario_d -- --ignored --nocapture

# 场景 E：30 分钟稳定性（默认 4 Agent × 5 事件/秒）
cargo test --release --test ingest_perf scenario_e -- --ignored --nocapture

# 基线对比：等效旧写路径（每事件一个事务）vs 新管线批处理
cargo test --release --test ingest_perf scenario_baseline -- --ignored --nocapture
```

可用环境变量缩短/加长（结果 JSON 会记录实际值）：

| 变量 | 默认 | 场景 |
| --- | --- | --- |
| `TD_PERF_A_SECS` / `_AGENTS` / `_RATE` | 600 / 10 / 50 | A |
| `TD_PERF_B_SECS` / `_AGENTS` / `_RATE` | 60 / 4 / 50 | B |
| `TD_PERF_C_SECS` / `_AGENTS` / `_RATE` | 20 / 8 / 100 | C |
| `TD_PERF_E_SECS` / `_AGENTS` / `_RATE` | 1800 / 4 / 5 | E |
| `TD_PERF_BASE_EVENTS` | 5000 | baseline |
| `TD_PERF_OUT` | `docs/performance/results` | 全部 |

结果文件：`docs/performance/results/<场景>-<时间戳>.json`。

### 判定标准

- **A/B**：`critical_failed = 0`、关键事件在数据库中缺失数 = 0、`submit_errors = 0`；
  队列深度峰值 ≤ 容量；观察接入/写库 p50/p95/p99 与吞吐。
- **C**：`overload_rejects > 0`（确实触发显式拒绝）、`critical_failed = 0`、
  关键事件缺失 = 0、负载结束后单条关键事件可正常提交（消费者未卡死）。
- **D**：坏事件被隔离且好事件落库；重复 `event_id` 仅一行且返回 `deduplicated`；
  终态后迟到 running 不改变终态；新轮次可重新进入 running。
- **E**：关键事件零丢失、`submit_errors = 0`、RSS 首末增长 < 200MiB、无崩溃。

## 4. 真机全链路 HTTP 压测

前提：安装并启动 Task Dock 正式版（`npm run tauri build` 产物），在
「设置 → Agent 接入」启用 HTTP 并复制令牌；确认 `GET /api/v1/health` 可访问。

```bash
# 场景 A（10 Agent × 50 事件/秒 × 10 分钟）
node scripts/perf/ingest-load.mjs \
  --base http://127.0.0.1:47821 --token <令牌> \
  --agents 10 --rate 50 --duration 600 \
  --out docs/performance/results/http-A.json

# 场景 B（200 事件/秒 × 60 秒）
node scripts/perf/ingest-load.mjs --base http://127.0.0.1:47821 --token <令牌> \
  --agents 4 --rate 50 --duration 60 --out docs/performance/results/http-B.json

# 场景 C（800 事件/秒，配合小队列/慢盘）
node scripts/perf/ingest-load.mjs --base http://127.0.0.1:47821 --token <令牌> \
  --agents 8 --rate 100 --duration 20 --out docs/performance/results/http-C.json
```

客户端行为：

- running 事件快速入队（不等落库）；waiting/completed/failed 等待确认；
- 429/503 读取 `Retry-After` 或指数退避重试，**不把失败当成功**；
- 结果 JSON 记录：状态码计数、重试次数、关键事件最终失败 ID、端到端延迟分位。

同步采集服务端指标：

1. 应用「设置 → 性能诊断」点「刷新」，记录队列深度/容量、合并/采样/拒绝数、
   接入与写库 p50/p95/p99、SQLite 读平均/慢查询、前沿快照请求数与最大并发；
2. 压测结束后再记录一次，确认队列回落、CPU 回落；
3. 需要数据库规模时执行：
   ```sql
   SELECT COUNT(*) FROM agent_events;
   SELECT state, COUNT(*) FROM agent_events GROUP BY state;
   ```

### 判定标准（真机）

| 目标 | 判定 |
| --- | --- |
| 有界队列 | 诊断面板队列深度 ≤ 容量；过载出现 429/503 而非无限增长 |
| 关键状态不丢 | `critical_failed = 0`，数据库关键状态计数与发送数一致（允许同 event_id 幂等重复） |
| UI 刷新不随事件线性增长 | 100 事件期间快照请求数远小于 100，`maxConcurrent ≤ 1` |
| 正常负载流畅 | 输入/切换标签无明显卡顿（人工观察），p95 接入延迟在可接受范围 |
| 过载可恢复 | 停止压测后队列回落、再次提交关键事件成功 |
| CPU/内存回落 | 负载结束后 1~2 分钟内 CPU 回落，RSS 不持续增长（任务管理器/性能诊断） |
| SQLite 一致 | 无 `database is locked` 报错；关键事件状态与数据库一致 |
| 历史可用 | 历史面板可加载更早事件，分页无重复/跳条 |

## 5. 故障注入矩阵（场景 D 扩展）

| 故障 | 期望行为 | 本次自动化覆盖 |
| --- | --- | --- |
| 单事件写库失败 | 按作业回退，其他事件仍提交；失败事件返回错误 | ✅ `scenario_d` |
| 重复 event_id | 只写一行，返回 `deduplicated` | ✅ `scenario_d` |
| 乱序（终态后迟到 running） | 记录事件但不回退终态 | ✅ `scenario_d` |
| 终态后新轮次重连 | 新 run 正常 running | ✅ `scenario_d` |
| 队列满 + 关键事件 | 返回可重试错误（HTTP 503 + Retry-After），不静默成功 | ✅ `scenario_c` |
| HTTP 并发超限 | 429 + Retry-After，不读体、快速释放 | 代码路径 + 压测可观察 |
| HTTP 请求超时 | 服务端继续提交；客户端重试由 event_id 幂等吸收 | 需真机断点/代理注入（未完成） |
| 文件写入失败 / 磁盘满 | 文件回退失败不阻塞 Agent；失败文件保留并重试 | 需真机模拟磁盘满（未完成） |
| SQLite busy | `busy_timeout` 5s；单写连接避免自锁 | 单元/集成测试间接覆盖，未做独立注入 |
| Task Dock 未启动 | Hook CLI 静默退出 0 / 插件写文件回退，不阻塞 Agent | 代码路径 + 手动验证 |

## 6. 归档恢复

事件归档为 JSONL（首行为文件头）：

```json
{"type":"taskdock-agent-events-archive","version":1,"created_at":"...","cutoff":"...","rows":123}
{"id":"...","source_id":"codex","session_external_id":"...","run_external_id":"...","event_type":"status","state":"running","message":null,"received_at":"...","schema_version":1,"event_id":"...","instance_id":null,"parent_run_id":null,"occurred_at":"...","transport":"http","evidence_type":"observed","confidence":1.0,"dedupe_key":"..."}
```

恢复原则：

- 归档只包含 `running`/`idle` 过程事件，用于审计/回放分析，**不直接导回运行库**
  （导回会与当前会话/轮次状态冲突）；如需分析，用脚本读取 JSONL。
- 重要状态（waiting/failed/completed）与审计记录在 `agent_runs`/`agent_sessions` 中，
  随 JSON 导出与备份完整保留。
- 备份/导入使用「设置 → 数据与备份」或 `import_data`，导入前自动备份。

## 7. 复现与注意事项

- 压测会写入真实临时数据库（`%TEMP%\taskdock-perf-*`），测试结束自动清理；
  真机 HTTP 压测会写入应用真实数据库，请先备份或在测试配置文件中运行。
- 驱动节拍按 Agent 独立计时，使用 `MissedTickBehavior::Burst` 补偿 Windows 定时器粒度
  （~15.6ms）；否则 20ms 周期会被跳过节拍、实际注入速率低于名义值（v0.5 实测过
  Delay 策略只有名义值的约 2/3）。报告同时记录**实际提交数**与达成速率。
- 不要同时运行多个压测场景：`scenario_guard` 已串行化后端测试，真机 HTTP 压测
  也应逐个执行，避免读数互相干扰。
- Windows 上 RSS 采样依赖 PowerShell `Get-Process WorkingSet64`；若 PowerShell
  被策略禁用，场景 E 会跳过 RSS 判定（报告 `rss_growth_mb_first_to_last = null`），
  其余断言仍生效。
