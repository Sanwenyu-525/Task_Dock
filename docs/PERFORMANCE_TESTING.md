# 性能测试与压测方法（v0.5）

> 本文只描述**如何测量**与**判定标准**。本次实测结果、机器配置与未完成项见
> [PERFORMANCE_ACCEPTANCE_REPORT.md](PERFORMANCE_ACCEPTANCE_REPORT.md) 与
> [PERFORMANCE_FINAL_ACCEPTANCE.md](PERFORMANCE_FINAL_ACCEPTANCE.md)（后者按本轮
> P0/P1 编号汇总 A/B/C/D/E 与最终判定）。
> 严禁把 Mock/模拟结果或估算数字当作真机性能数据。

## 1. 测试层次

| 层次 | 工具 | 覆盖 | 不覆盖 |
| --- | --- | --- | --- |
| 后端管线 + SQLite | `src-tauri/tests/ingest_perf.rs`（ignored 集成测试） | 真实 `IngestPipeline`、真实 `ingest_core` 事务、真实 WAL 数据库、真实延迟分位 | WebView2、托盘、系统通知 |
| 行动中心查询 | `src-tauri/tests/actions_perf.rs`（ignored） | 60 轮次 + 500 条未读提醒、真实 `actions::feed` 查询路径、合并/映射/过滤、**全局总数与单页分离**（全局 42 > 单页上限 40，验证计数不随分页退化） | 前端绘制与点击跳转 |
| 剪贴板存储/编码 | `src-tauri/tests/clipboard_perf.rs`（ignored） | 300 条历史列表、200 张 1080p 截图入库/分组/配额、PNG/DIB/缩略图 | 真实系统截图采集、逐项粘贴 UI |
| 迁移升级路径 | `src-tauri/tests/real_upgrade.rs`（ignored，需 `TD_REAL_UPGRADE_DB` 指向真实用户库副本） | 真实用户库副本 v11→v13 升级：版本推进、行数不减、外键零违规、`integrity_check=ok`、重复打开幂等 | 真实库安装→升级→卸载（逐版本 v0.1–v0.13 旧库升级已由 `db::tests::every_historical_schema_version_upgrades_to_latest_without_losing_rows` 覆盖） |
| 前端列表渲染 | `scripts/render-perf.mjs`（真实 Chromium + preview 夹具） | 300 行 `TaskItem` 全量重渲染提交/绘制、首屏 | Tauri WebView2 宿主、真实 IPC 延迟 |
| 真机全链路 HTTP | `scripts/perf/ingest-load.mjs` | 真实 Tauri 进程、HTTP 鉴权/并发/超时/429/503、前端刷新与托盘副作用 | 真实第三方 Agent 行为/进程开销 |
| 内存归因（多臂差分） | `src-tauri/tests/memory_attrib.rs`（ignored） | 真实 `IngestPipeline` + 真实 SQLite 写入，四臂差分（full / pipeline_only / db_only / full_checkpoint）把「管线」「库写入」「WAL 累积」拆开 | WebView2、托盘、系统通知 |
| 内存三臂对照 | `scripts/perf/memory-notify-suite.sh`（驱动 `memory-scenario.py`） | 同一 release 二进制上「负载+通知开 / 负载+通知关 / 空闲」三臂，隔离数据目录；同时记录进程 Private Bytes 与 `alloc_stats.live_bytes` | 真实第三方 Agent 行为、真实用户数据 |
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

# 行动中心查询（60 轮次 + 500 未读提醒；全局总数 42 > 单页 40；p95 ≤ 60ms）
cargo test --release --test actions_perf -- --ignored --nocapture

# 剪贴板压力（300 条历史列表 + 200 张 1080p 截图入库/分组/配额）
cargo test --release --test clipboard_perf -- --ignored --nocapture

# 迁移升级路径真机验收（需真实用户库副本；只读副本，不触碰运行中的真实库）
TD_REAL_UPGRADE_DB=<真实用户库.db 的副本> \
  cargo test --test real_upgrade -- --ignored --nocapture
```

剪贴板常驻采样（Windows 真机，采样脚本按验收环境临时编写、不入库）：

- 对 `task-dock` 进程树每 30 s 采一次 CPU 时间、WS、private、线程、句柄；
  CPU% = ΔCPU 秒 ÷ 采样间隔 ÷ 逻辑 CPU 数；
- 同时通过 WebView2 CDP 调 `clipboard_status` / `clipboard_view`，记录监听状态、
  队列峰值、丢弃计数与历史规模；
- 判定：CPU/RSS/线程/句柄在 30 分钟内无持续增长，`monitoring=true` 不漂移，
  历史条数前后一致；锁屏时真实剪贴板事件为 0，**只能证明空闲无泄漏，
  不能替代真实事件节奏（场景 B 必须解锁后另测）**；
- 采样期间不得同时编译或压测，否则 CPU/IO 数据不可归因。

前端 300 行渲染（真实 Chromium，非 jsdom）：

```bash
npm run build
node scripts/make-preview.mjs
node scripts/render-perf.mjs
```

吞吐验收可用 `TD_PERF_A_AGENTS` / `TD_PERF_A_RATE` 调整并发。驱动使用
`MissedTickBehavior::Burst` 后，10 Agent × 50/s 可持续 10 分钟达到名义速率（实测 499.72/s）；
更高并发（40 Agent × 50/s）受运行时调度与 CPU 限制，实际提交 120,000/60s（1,886/s），
因此报告必须记录**实际提交条数**，不能把理论值当吞吐。

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
- 全局在途请求有界（`--inflight`，默认 24，须低于服务端连接/请求配额）；
- 结果 JSON 记录：状态码计数、重试次数、关键事件最终失败 ID、端到端延迟分位。

**压测来源必须隔离（v0.5）**：脚本默认 `--source bench`，该来源由服务端判定为
`benchmark` 归属，事件不进入真实 Agent 状态、行动中心「需介入」，也不触发系统通知。
指向非 `bench` 来源时脚本**直接拒绝执行**，除非显式追加 `--allow-real-source`
（会产生真实数据，谨慎使用）。判定依据见
[AGENT_ADAPTERS.md](AGENT_ADAPTERS.md)。

同一闸门覆盖内存采样链路：`scripts/perf/memory-probe.mjs` 与
`scripts/perf/memory-scenario.py` 默认同为 `bench`，非 `bench` 必须显式
`--allow-real-source`（两个套件脚本用 `SOURCE=bridge` 时会自动追加）。
注意：**只有 `real` 归属的事件才会产生系统通知**，因此要测「通知路径」的内存成本
必须用真实类别来源（`bridge`），此时隔离性由「隔离实例」保证——独立数据目录 /
APPDATA / 端口，用完即弃，绝不接触用户真实库。

### 4.1 真机故障注入

以下脚本均直接访问真实 Tauri 进程的 HTTP 端点，结果写入 `docs/performance/results/`：

```bash
# 客户端超时（服务端已提交）：timeoutMs 小于落库时间，随后用 DB 审计对账
node scripts/perf/fault-inject.mjs --mode timeout --count 300 --timeout-ms 100 \
  --out docs/performance/results/E2-timeout.json
# 重复 event_id（单次 + 并发对）：API 不返回 deduplicated 字段，以 DB 唯一 event_id 行为准
node scripts/perf/fault-inject.mjs --mode duplicate --count 200 \
  --out docs/performance/results/E2-duplicate.json
# 乱序/交错（终态后迟到 running、新轮次）：DB 审计 run 状态与事件顺序
node scripts/perf/fault-inject.mjs --mode interleave --count 200 \
  --out docs/performance/results/E2-interleave.json
# 突发（3300 条瞬间）：客户端必须遵守 Retry-After 重试，统计最终失败 ID
node scripts/perf/fault-inject.mjs --mode burst --count 3000 --max-retries 40 \
  --out docs/performance/results/E3-burst.json

# SQLite busy：另一个连接 BEGIN IMMEDIATE 持有写锁 12s，同时提交 1200 running + 24 关键
python scripts/perf/sqlite-busy.py --db <数据目录>/task-dock.db --hold 12 \
  --out docs/performance/results/E4-sqlite-busy.json
# 文件回退容量：预填 5050 个文件，验证普通写入被拒、关键预留仍可写、预留耗尽后明确失败
python scripts/perf/file-fallback-fault.py --exe <task-dock.exe> --data-dir <隔离数据目录> \
  --out docs/performance/results/E5-file-fallback.json

# 退出时并发投递（托盘退出）：关键事件入库 + 文件回退 + 关闭报告
python scripts/perf/quit-under-load.py
# 重启恢复：应用停止期间写入投递文件，启动后计时扫描入库（脚本按环境编写）
```

每个故障场景之后用 `scripts/perf/db-audit.py --db ... --mode ... --out ...` 对账：
关键事件按 `session+event` 或事件 ID 重建，检查 DB 中是否恰好一行、是否缺失、
`event_id` 全局重复数、`integrity_check` 与外键违规。

### 4.2 30 分钟真机资源采样（区分进程组）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/perf/sampler.ps1 `
  -Out docs/performance/results/D-soak-<ts>.jsonl -IntervalSec 5 -DurationSec 1800 `
  -Token <HTTP 令牌>
```

采样器用 Toolhelp32 父子快照区分：

- `taskdock`：`task-dock*` 主进程；
- `webview2_tree`：Task Dock 进程树内的 `msedgewebview2`；
- `webview2_other`：其他应用的 WebView2（背景项，不归因给 Task Dock）；
- `other_agents`：workbuddy/qoder/trae/codex/opencode/zcode 等其他 Agent 进程。

每轮输出 CPU 百分比（按逻辑 CPU 归一）、WS、private，并每 30s 读取 `/api/v1/stats`。
CPU 差值窗口按上一轮采样开始到本轮开始计算，避免 IO/HTTP 抖动造成虚高。
采样期间不得同时编译或运行其他压测。

### 4.2.1 采样间隔字段的语义（历史字段缺陷与更正）

旧版 `sampler.ps1` 只输出一个 `interval_s`，但它记的是**本轮采样耗时**
（`elapsed - tickStart`），不是**相邻样本的间隔**。因此 30 分钟采样
（359 样本 / 1,794.94s 时间跨度）被算成「平均间隔 2.544s」，与时间戳隐含的
约 5.0s 互相矛盾。

现在的采样行把三件事拆成三个互不依赖的字段：

| 字段 | 含义 |
|---|---|
| `planned_interval_s` | 计划间隔（`-IntervalSec`，默认 5） |
| `actual_interval_s` | 相邻两次采样**开始时刻**的真实间隔（由时间戳算得） |
| `sample_duration_s` | 本轮采集自身耗时（不含等待下一次采样） |
| `interval_s` | 兼容旧字段，等于 `actual_interval_s` |

历史数据用 `scripts/perf/sampler-recompute.py` 就地重算（**不改原始 jsonl**）：

```bash
python scripts/perf/sampler-recompute.py \
  docs/performance/results/D-soak-20261030-101315.jsonl \
  --out docs/performance/results/sampler-recompute-D-soak-20261030.json
```

更正结果（`sampler-recompute-D-soak-20261030.json`）：

- 样本数 359；时间跨度 1,794.94s；
- 真实间隔（由时间戳算得）：min 4.104s / 中位 **5.002s** / 均值 5.014s / max 10.024s / p95 5.21s；
- 旧字段 `interval_s`：min 2.37 / 中位 2.51 / 均值 2.544 / max 3.97s（**语义是采样耗时，不是间隔**）。

**旧 CPU 统计不受该字段影响**：旧版 CPU% 用的是 `tickStart` 差值（真实间隔），
不是 `interval_s`，所以 30 分钟 soak 的 CPU 平均 0.339% / 峰值 0.72% 仍然成立。

### 4.3 备份/恢复真机验收

```bash
# 快速备份（历史超过 20000 条时验证 partial 与 partial_reasons）
task-dock.exe --agentctl backup quick <bundle.json>
# 完整备份（含归档与剪贴板资产）
task-dock.exe --agentctl backup full <bundle.json>
# 隔离目录恢复（TASK_DOCK_DATA_DIR 指向新目录）
task-dock.exe --agentctl restore <bundle.json>
```

验收要点：bundle 逐行重算 SHA-256 与 integrity 行一致；快速备份 `partial=true`
且 header 记录数据库总量；完整备份恢复后逐表逐行一致（本机 `http_token` 按设计
重新生成，不参与比较）；截断/篡改/有效 JSON 篡改的 bundle 必须在写入前拒绝且
目标数据不变；恢复前自动生成 pre-restore 备份。

### 4.4 100k 规模备份/恢复验收

```bash
cd src-tauri
cargo test --release --lib \
  commands::backup::tests::full_backup_100k_events_10k_notifications_roundtrip \
  -- --ignored --nocapture
```

夹具（全部为真实 SQLite 行与真实 PNG 文件，不是缩水夹具）：

- 100,000 条 `agent_events`、10,000 条通知、1,000 个任务、5,000 条剪贴板历史；
- 500 个剪贴板资产记录（250 张 96×96 真实 PNG + 250 张 32×32 缩略图）；
- 100 个工作现场、400 个现场项、100 条剪贴板-现场关联、500 条行动确认；
- 2 个真实事件归档 JSONL（各 40,000 行）、48 项设置、10 个 Agent 来源/实例/会话/轮次。

判定必须同时满足：

1. bundle integrity SHA-256 与逐行重算一致，`partial=false`，25 张表行数全部相等；
2. 关键 ID/外键/水位线/设置一致，`pragma_foreign_key_check` 为空，`integrity_check=ok`；
3. 全部资产/归档的 SHA-256 与源文件一致，`clipboard_assets` 每个路径都能在目标找到文件；
4. 恢复状态 `completed`，pre-restore 备份存在且可读；
5. 备份/恢复期间每 100ms 采样本进程 WS、CPU 与 SQLite 读延迟；不提高内存上限、
   不把整个 bundle 一次性读成单个 JSON。恢复端当前仍有表行 materialize 的内存峰值，
   报告必须如实记录，见 `V05-SCALE-100K-20261030.json`。

原始输出与机器可读结果：
`docs/performance/results/V05-SCALE-100K-20261030.log` / `.json`（优化前对照 `-PREOPT`）。

### 4.5 恢复原子性故障矩阵

在隔离数据目录执行 `cargo test --lib commands::restore::tests -- --nocapture`，覆盖 15 类故障；
每个用例都断言：数据库完整、原任务存在或完整恢复、资产引用有效、外键有效、无半套状态、
日志状态可解释、可重试/重启可收尾。

| # | 故障 | 用例 |
| --- | --- | --- |
| 1 | bundle 校验/哈希失败 | `corrupt_bundle_is_rejected_without_touching_db` |
| 2 | SQLite 导入前中止 | `failure_before_db_commit_leaves_original_data` |
| 3 | 事务中途失败 | `mid_transaction_failure_rolls_back_all_tables` |
| 4 | 数据库已提交、归档提交失败 | `db_committed_but_archive_commit_fails_rolls_back_db_and_files` |
| 5 | 归档复制中途失败 | `mid_copy_archive_failure_restores_first_archive` |
| 6 | 缺少图片资产 | `missing_asset_is_rejected` |
| 7 | 资产哈希错误 | `wrong_asset_hash_is_rejected` |
| 8 | 目标权限拒绝 | `permission_denied_during_asset_commit_rolls_back` |
| 9 | 磁盘写满 | `disk_full_during_archive_commit_rolls_back` |
| 10 | Windows 文件被占用 | `file_locked_during_asset_commit_rolls_back` |
| 11 | 提交中进程死亡 | `crash_after_db_commit_is_completed_on_restart` / `crash_mid_file_commit_resumes_without_duplicates` |
| 12 | 恢复后首次启动 | `first_start_after_completed_restore_clears_marker` |
| 13 | 旧备份导入新库 | `old_bundle_preserves_clipboard_and_links` / `legacy_json_import_creates_recovery_point_and_preserves_modules` |
| 14 | 归档重名冲突 | `duplicate_archive_name_is_rejected` |
| 15 | 恶意/越界路径 | `malicious_asset_path_is_rejected` |

### 4.6 退出超时与暂存重放

`cargo test --lib agents::pipeline::tests -- --nocapture` 与
`cargo test --lib agents::spool::tests -- --nocapture` 覆盖：

- 受理 500 条后退出排空、3000 条跨队列+合并缓冲排空、退出期间 HTTP 在途；
- 写库延迟/写失败、排空超时、重复退出、退出后提交拒绝；
- 超时把未写事件原子暂存、暂存写失败如实报告 `unsaved`；
- 重启重放幂等，不复活已终态轮次、不产生重复通知。

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

| 故障 | 期望行为 | 本次覆盖（2026-10-30 真机） |
| --- | --- | --- |
| 单事件写库失败 | 按作业回退，其他事件仍提交；失败事件返回错误 | ✅ `scenario_d`（后端） |
| 重复 event_id | 只写一行；HTTP 两次都返回 accepted=1，以 DB 去重为准 | ✅ `E2-duplicate`（21 个唯一 ID 各 1 行，0 重复） |
| 乱序（终态后迟到 running） | 记录事件但不回退终态 | ✅ `E2-interleave`（run 保持 waiting，旧 running 不变更状态） |
| 终态后新轮次重连 | 新 run 正常 running | ✅ `E2-interleave` |
| 客户端超时但服务端已提交 | 服务端继续提交；客户端重试由 event_id 幂等吸收 | ✅ `E2-timeout`（10/10 标记入库，8 个客户端 AbortError + 2 个 HTTP 200） |
| 队列满/突发 + 关键事件 | 429/503 + Retry-After，客户端重试后零丢失 | ✅ `E3-burst`（3300/3300，493 次重试，关键 300/300） |
| HTTP 并发超限 | 429 + Retry-After，不读体、快速释放 | ✅ 真机突发/压力可观察 |
| SQLite busy | `busy_timeout` + 单写连接；批失败按作业回退 | ✅ `E4-sqlite-busy`（12s 持锁，1224/1224 成功，153 次批失败由 144 个回退作业恢复） |
| 文件回退容量/预留耗尽 | 普通写入明确拒绝；关键预留仍可写；预留耗尽后明确失败且不删旧文件 | ✅ `E5-file-fallback`（5050 预填、1 关键成功、5260 时关键也拒绝、无删除） |
| 用户退出时仍有在途事件 | 排空后退出；未完成事件如实报告；文件回退不丢关键状态 | ✅ `E6-quit-under-load`（464/464 关键覆盖，102 个回退文件） |
| 异常终止后重启 | 上次未处理的投递文件被扫描入库；关键事件不重复 | ✅ `E7`/`E8`（102 文件清空；200 文件 55.7s 入库，120/120 关键，0 重复） |
| 进程被强杀（kill -9） | 重启后恢复与不重复 | ⬜ **NOT TESTED**（本轮只做托盘正常退出；强杀恢复未单独注入） |
| 磁盘写满 | 备份/回退失败必须明确报错，不破坏旧数据 | 🚫 **NOT TESTED**（未在不破坏系统卷的前提下制造写满，未伪造） |
| Task Dock 未启动 | Hook CLI 退出 0 / 插件写文件回退，不阻塞 Agent | ✅ 代码路径 + `E5`/`E8` 文件回退实测 |

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

## 8. 2026-10-30 18:08→18:56 第二轮复核采样

本节只记录本轮在**当前源码**上重跑的性能/迁移采样。历史测量值见上文各节与
[PERFORMANCE_ACCEPTANCE_REPORT.md](PERFORMANCE_ACCEPTANCE_REPORT.md)、
[PERFORMANCE_FINAL_ACCEPTANCE.md](PERFORMANCE_FINAL_ACCEPTANCE.md)，未被改写。

### 8.1 行动中心查询（`actions_perf`）

| 时间 | 命令 | 结果 |
|---|---|---|
| 18:08–18:11 | `cargo test --release --test actions_perf -- --ignored --nocapture` | **FAIL（EXIT=101）**：返回 40 条 / 筛选共 42，p50 3.33 / p95 3.62 / max 4.04 ms；断言 `筛选总数与夹具不一致 left: 42 right: 40` |
| 18:12–18:18 | 同上（修正夹具期望值后） | **PASS（EXIT=0）**：返回 40 条 / 筛选共 42，p50 2.99 / p95 3.22 / max 3.23 ms（预算 p95 ≤ 60 ms） |

**失败原因是夹具期望值算错，不是生产代码回归**：夹具按「每来源 10 个会话、
`session % 3` 分布」播种，实际得到每来源 4 失败 + 3 等待 = 7，6 来源共 **42**，
而断言用的是 `60 / 3 * 2 = 40`。生产侧返回的「单页 40 条 + 全局筛选总数 42」
恰好是本场景要验证的行为（全局总数不随分页退化）。修正方式是把期望值改为
按同一分布计算，并追加一条守护断言：夹具的需介入条数必须大于单页上限，
否则该样本失去验证价值。失败运行日志保留在
`docs/clipboard/evidence/perf-actions-release-20261030-180830.log`，
通过运行在 `…-1813.log`，结果 JSON 在 `docs/performance/results/Q-actions-*.json`。
**未删除失败记录，未放宽预算。**

### 8.2 剪贴板性能（`clipboard_perf`，release）

18:18–18:30，`cargo test --release --test clipboard_perf -- --ignored --nocapture`，
**2 passed / 0 failed（EXIT=0）**，结果 `docs/performance/results/CLIP-20261030-183022.json`：

| 项 | 实测 |
|---|---|
| 1000 条历史（1 张 1920×1080）列表 80 条 | p50 2.944 ms / p95 3.416 ms |
| 1000 条历史计数 | p50 0.011 ms / p95 0.013 ms |
| 搜索未命中 | p50 0.713 ms / p95 0.839 ms |
| 缩略图 | p50 8.368 ms / max 8.653 ms |
| PNG 编码 / 解码 | 105.810 ms / 15.474 ms |
| RGBA↔DIB | 5.489 / 5.726 ms |
| 200 张 1920×1080 连拍入库 | **4,279.54 ms**（预算 8,000 ms） |
| 其中清理 / 总计 | 150.28 ms / 4,429.82 ms |
| 资产占用 | 464.8 MB → **30.2 MB**（配额 32 MB） |

与 §5.6（10-30 01:32 的 6,984 ms）相比本次入库更快，属机器负载差异；
**预算未调整，两次测量并列保留**。

### 8.3 迁移升级路径（`real_upgrade`）

18:52，`TD_REAL_UPGRADE_DB=<真实用户库 v11 副本> cargo test --test real_upgrade -- --ignored --nocapture`，
**1 passed / 0 failed（EXIT=0）**：

```
迁移前：version=11 行数=[("tasks", 0), ("agent_sources", 10), ("agent_sessions", 36),
                        ("agent_runs", 248), ("agent_events", 8734), ("notification_history", 310)]
真实用户库升级验证通过：version 11 → 13，行数无减少，外键零违规，integrity_check ok
```

副本取自 `%APPDATA%/com.taskdock.desktop/task-dock.db`（运行中的真实用户库），
降级到 v11 结构后由工具升级。日志：
`docs/clipboard/evidence/gate-real-upgrade-20261030-1855.log`。
**逐版本 v0.1–v0.4 旧库升级、以及真实用户环境的安装→升级→卸载仍未验证**，见
[V05_FINAL_ACCEPTANCE.md](V05_FINAL_ACCEPTANCE.md) §六 C。

## 9. 2026-10-30 21:46→ 第三轮：最终二进制上的长跑复验（方法学与环境干扰）

本节记录第三轮（最终二进制）复验的**方法学修正**与**环境干扰清单**。
前两轮的原始测量值一律保留在原文与
[PERFORMANCE_FINAL_ACCEPTANCE.md](PERFORMANCE_FINAL_ACCEPTANCE.md)，本节不改写它们，
只补记「前一轮数字为什么作废」与「这一轮如何保证不再作废」。

### 9.1 上一轮三臂对照为什么作废（不是「空闲路径释放内存」）

第二轮三臂对照（N1 负载+通知 / N2 负载无通知 / N3 空闲）曾得出
「N3 空闲 8.9 → 0.0 MB、斜率 −0.884 MB/min（空闲路径释放内存）」，
并据此算出「接入路径贡献 = N2 − N3 = +14.3 MB」。**该结论作废**，根因是**测量对象已经死了**：

- N3 臂的实例在采样窗口内**自行退出**（`last-shutdown-report.json` 记录
  `lifecycle=stopped, already_stopped=false, drained_events=0`，属优雅退出，非崩溃）；
  采样器仍在写数据，于是「进程不在 → 内存读数为 0」被误读成「空闲路径释放内存」。
- 同期的 30 分钟 C 臂也在负载结束后约 300 s 失去健康检查，原因同类。
- 两条臂作废时，本机正在跑**上一会话遗留的后台任务**（`cargo build --release`、
  `cargo test --release`、`memory-af-suite.sh` 重跑）。其中一次 `cargo build --release`
  在实例死亡前 18 s 因**目标文件被占用**失败（`failed to remove file … 拒绝访问。 (os error 5)`），
  产出了一个**缺少 `custom-protocol` 特性的 dev-mode 二进制**。

### 9.2 本轮修正的测量缺陷（代码级）

| # | 缺陷 | 症状 | 修正 | 位置 |
|---|---|---|---|---|
| 1 | 套件脚本谎报退出码 | `echo "… rc=$?"` 中 `$(date)` 命令替换先把 `$?` 覆盖成 0，失败轮次被记成成功 | 先 `local rc=$?` 落变量，再输出 | `scripts/perf/memory-af-suite.sh`、`scripts/perf/memory-notify-suite.sh` |
| 2 | 实例退出无法被观测 | 采样仍在跑 → 内存读数归零被误读 | 负载结束后逐秒轮询进程存活；记录 `instance_exited_after_s` / `instance_exit_code`，发生即 `SystemExit(1)` | `scripts/perf/memory-scenario.py` |
| 3 | 应用自身日志缺失 | 判断不了实例为何退出 | 子进程 stdout/stderr 显式落到 `DIAG-<name>-<ts>-app.log`（GUI 子系统程序靠 shell 重定向拿不到有效句柄） | `scripts/perf/memory-scenario.py` |
| 4 | 「显示窗口」取错窗口 | `--window visible` 实际显示的是单实例插件的 `WS_EX_TOOLWINDOW` 消息窗，主窗口始终隐藏（界面根本没渲染） | 过滤 `WS_EX_TOOLWINDOW` + 取面积最大的可见窗口 | `scripts/perf/memory-scenario.py` |
| 5 | 采样器按进程名归组 | 机器上任何多余 `task-dock.exe` 都会混进 `taskdock` 分组 | 场景启动前检查是否已有 `task-dock.exe`，有则**直接拒绝执行**并报出 PID | `scripts/perf/memory-scenario.py` |
| 6 | 压测来源未隔离 | 内存探针默认 `source=bridge`（真实类别），压测事件被服务端判为 `real`，可进真实状态与系统通知 | 与 `ingest-load.mjs` 同口径：默认 `bench`，非 `bench` 必须显式 `--allow-real-source` | `scripts/perf/memory-probe.mjs`、`memory-scenario.py`、两个套件脚本 |

隔离来源的实测校验（35 s 冒烟，隔离实例内查询）：
`agent_events` 全部 `origin=benchmark`（80 条）、`agent_sessions` 2 条同为 `benchmark`、
`notification_history` **0 条**、`bench` 来源 `verified=0 / transport_verified=0`
（压测永远不能成为真实接入证据）。

### 9.3 环境干扰清单（压测前必须逐条确认）

1. **必须用带 `custom-protocol` 的产物**：`cargo build --release`（裸 cargo）**不等于**
   `npm run tauri build`。前者不带该特性 → `tauri::is_dev()` 为真 → 启动走
   「开发服务器预检」分支，弹框后 `return Ok(())`，**数据库/管线/HTTP 服务全部不启动**。
   本轮最终二进制：`src-tauri/target/release/task-dock.exe`，
   **15,553,536 B**，`sha256=35dcd14f109277105db95ed836439b7c6288b70dd760111683566d13d8a82a44`，
   构建时间 2026-10-30 21:46:42（`npm run tauri build -- --no-bundle`）。
   对照：dev-mode 产物为 15,400,960 B（字节数即可肉眼区分）。
   校验方法：隔离实例启动后确认日志**没有**「开发服务器预检失败」，且进程持续存活。
2. **Windows 文件锁**：正在运行的 `task-dock.exe` 会让 `cargo build --release` 无法替换
   目标文件。压测前必须确认没有实例在跑（否则构建失败，或构建产物被占用回退成旧文件）。
3. **后台任务队列**：压测期间若有后台构建/测试任务被拉起，会同时污染 CPU 与采样归属。
   开跑前确认任务队列为空，且压测期间**不得**同时跑 cargo/npm（见 §4.2 的约定）。
4. **机器固有噪声**：本机 `gitfox`（nssm 管理）存在约 128 s 周期的崩溃重启，
   其他项目的 dev server 常驻。这些不影响按进程树归组的 `taskdock` 分组，
   但会抬高全机 `webview2_other` / `other_agents` 的 CPU 读数——解读时只看本进程分组。
5. **采样窗口内不得改代码/构建**：任何一次 `cargo build` 都会抢占磁盘与 CPU，
   并可能在 Windows 上直接锁住被测二进制。

### 9.4 复现命令

```bash
# 三臂对照（通知路径 / 接入路径 / 空闲基线），来源用真实类别 bridge：
# 服务端按 origin 判定，只有 real 事件才会产生系统通知，
# 用隔离来源 bench 时 N1 与 N2 的通知路径完全相同，差值恒为 0。
WORK=C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-abc-v05r3 SOURCE=bridge \
  DURATION=480 POST=90 PORT_BASE=47890 bash scripts/perf/memory-notify-suite.sh

# 30 分钟长跑（UI+HTTP、负载后空闲），同样在隔离实例内
WORK=C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-af-v05r3 SOURCE=bridge \
  ONLY=C-ui-http-30min,E-idle-after-load-30min PORT_BASE=47900 \
  bash scripts/perf/memory-af-suite.sh
```

结果落在 `docs/performance/results/`：`DIAG-<臂名>-<时间戳>.jsonl`（逐样本）、
`DIAG-<臂名>-<时间戳>-meta.json`（口径、退出码、汇总）、
`DIAG-<臂名>-<时间戳>-app.log`（被测实例自身日志）、
`MEMABC-<臂名>-<时间戳>.log`（套件日志）、`MEMABC-fingerprint-<时间戳>.txt`（源码与二进制指纹）。

### 9.5 第四轮（22:08→）：并行会话把测量环境打穿，三处「测量装置本身」缺陷

第三轮的数据仍然作废，原因和 §9.1 同源但更具体：**有其它会话在同一台机器、同一份工作区上并行操作**。
本轮把「谁杀了被测实例」查到了具体一条命令，并把由此暴露的测量装置缺陷全部修掉。

**证据（会话日志时间戳与被测实例死亡时刻对齐）**：

| 事实 | 证据 |
|---|---|
| 被测实例在 t≈190 s 被外部 `TerminateProcess` | 21:55:52 实例消失；应用日志末尾只有正常的 `HTTP 接入 POST … -> 200`；**没有** `last-shutdown-report.json`（非优雅退出）；Windows 应用程序日志无崩溃条目 |
| 杀手是按镜像名的 `taskkill` | 另一会话的会话日志里存在 `taskkill //IM task-dock.exe //F`，时间戳 `2026-10-30T13:55:52.715Z`（= 本地 21:55:52），**与实例死亡时刻逐秒吻合**；同一条命令在 22:05:14 又出现一次，正好杀死当时正在跑的 N3 臂 |
| 产物被换掉 | 21:55:59 另一会话启动 `cargo test --release`，21:58:33 把 `src-tauri/target/release/task-dock.exe` 换成 **dev-mode** 产物（15,400,960 B，`sha256=9f666133…`）；此后所有臂测的都不是被指纹记录过的那个二进制 |
| 采样器本身可能一条样本都产不出来 | `scripts/perf/sampler.ps1` 是 **UTF-8 无 BOM**，Windows PowerShell 5.1 按系统 ANSI（本机 GB2312）解码，行尾中文标点（如「。」）的字节被当作半个双字节字符，**吞掉换行**，把下一行并进注释 |

**由「并行会话按镜像名杀进程」推出的三条装置级修正**：

1. **测量用改名副本，避开按镜像名的误杀**。
   把产物复制成 `tdmeas.exe` 再测：另一个会话的 `taskkill //IM task-dock.exe` 不再命中被测实例。
   代价是采样器必须按**实际镜像名**归组，因此 `sampler.ps1` 增加 `-ProcessNamePattern` 参数，
   场景脚本按被测 exe 的文件名自动传入（`^tdmeas`）。
2. **产物与构建目录隔离**：用 `CARGO_TARGET_DIR=src-tauri/target-measure` + 独立的前端产物目录构建，
   产物复制到 `C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-bin/tdmeas.exe` 后再指纹化。
   这样别的会话重建 `target/release` 不会影响本轮测量。
3. **「同名实例」才是阻断项，「异名实例」只是环境噪声**：
   场景脚本的污染检查从「机器上有任何 `task-dock.exe` 就拒绝执行」改成
   「有**同名**实例才拒绝」；异名实例进程树独立、不会串进 `taskdock` 分组，
   只记录到 `meta.other_task_dock_instances` 作为环境干扰说明。

**由「采样器 0 样本」推出的两条修正**：

4. **0 样本必须判失败**。此前采样器解析失败时，场景脚本仍以 `rc=0` 退出、
   `samples: 0` 被当成「内存平稳」的空结果——这是最危险的一类假数据。
   现在 `memory-scenario.py` 在 0 样本时写入 `error` 并 `SystemExit(1)`。
5. **`.ps1` 必须能被 PowerShell 自己解析**。新增回归测试
   `src/test/powershellScripts.test.ts`：用 `[System.Management.Automation.Language.Parser]::ParseFile`
   体检仓库里所有 `.ps1`（必须零错误），并要求**含非 ASCII 的 `.ps1` 必须带 UTF-8 BOM**。
   `scripts/perf/sampler.ps1` 已补 BOM（其余 `.ps1` 本来就是纯 ASCII，不受 GB2312 影响）。
   注意：**Edit 保留 BOM、Write 会丢 BOM**，后续改这个文件要留意。

### 9.6 第四轮复现命令

```bash
# 0) 先把产物构建到独立目录并改名，避开其它会话的 cargo 与按名 taskkill
npx vite build --outDir "C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-build/dist" --emptyOutDir
npx tauri build --no-bundle \
  --config '{"build":{"frontendDist":"C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-build/dist","beforeBuildCommand":""}}' \
  -- --target-dir D:/Develop/task_dock/src-tauri/target-measure
mkdir -p "C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-bin"
cp src-tauri/target-measure/release/task-dock.exe \
   "C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-bin/tdmeas.exe"
sha256sum "C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-bin/tdmeas.exe"

# 1) 三臂对照（通知路径 / 接入路径 / 空闲基线）
EXE="C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-bin/tdmeas.exe" \
WORK="C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-abc-v05r4" SOURCE=bridge \
  DURATION=480 POST=90 PORT_BASE=47890 bash scripts/perf/memory-notify-suite.sh

# 2) 30 分钟长跑（C 持续负载 / E 负载后空闲）
EXE="C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-bin/tdmeas.exe" \
WORK="C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-af-v05r4" SOURCE=bridge \
  ONLY=C-ui-http-30min,E-idle-after-load-30min PORT_BASE=47900 \
  bash scripts/perf/memory-af-suite.sh

# 3) 归因（进程中途退出的臂会被拒绝出归因，而不是给出假差值）
python scripts/perf/memory-compare.py docs/performance/results/DIAG-N[123]-*.jsonl
```

### 9.7 第四轮：被测实例「自行退出」的取证（不是被测二进制的缺陷）

第四轮三臂里 N2、N3 两臂的实例在观察窗口内**自行退出**（N2 存活 515.5 s、N3 存活 144.3 s，
reproA 42.1 s、reproB 26.8 s），退出码 0 且写出 `last-shutdown-report.json`，
`memory-compare.py` 因此拒绝输出三臂差值归因。

**排查结论：退出不是被测二进制触发的，而是「托盘自动化误伤别的 Task Dock 实例」。**

取证链：

1. **源码级收敛**。产品里优雅退出只有一个入口 `request_exit()`
   （`src-tauri/src/lib.rs:797`），调用方仅三处：托盘菜单 `quit`（`lib.rs:205`）、
   `commands/system.rs:15` 的 `quit_app`（前端从未调用）、`RunEvent::ExitRequested`（`lib.rs:782`）。
   而 `RunEvent::ExitRequested` 在 `tauri-runtime-wry` 里只有两个来源：
   **最后一个窗口被销毁**（`TaoWindowEvent::Destroyed`）或 **`app.exit()`**（本产品只有 `request_exit` 末尾自己调）。
   于是只剩两种可能：有人点了托盘「退出」，或主窗口被销毁。
2. **排除崩溃与强杀**。退出前应用日志无任何 WARN/ERROR；Windows 应用程序事件日志无崩溃记录；
   被测产物已改名 `tdmeas.exe`，按镜像名的误杀脚本打不中它；退出码 0 + 退出报告 = 产品自身退出。
3. **受控复现**。新增 `scripts/perf/exit-forensics.py` 盯住实例的全部顶层窗口句柄，
   在机器上没有其它 Task Dock 实例时执行仓库自带的托盘自动化
   （`scripts/perf/quit-under-load.py` 使用的 `tray-quit5.ps1`）：

   ```
   [  20.1s] 执行托盘退出自动化
   [  20.1s] 托盘脚本输出: icon=2084,1233 menu=2084,934,205,299 quit=2144,1208
   [  20.1s] 窗口失效 hwnd=0x15f0dec ...（全部顶层窗口同时失效）
   [  29.2s] 进程退出 {"exited_after_s": 29.2, "exit_code": 0, "shutdown_report": true}
   [verdict] GRACEFUL_REQUEST_EXIT
   ```

   应用日志尾与四次历史退出**逐行一致**（同样三条 INFO + 同一条 Chromium 收尾 ERROR）。
4. **机理**。`tray-quit5.ps1` 按**通知区图标名**定位实例：
   `if($n.StartsWith("Task Dock") …)` 后取 `Select-Object -First 1`，**不区分实例**。
   所有 Task Dock 实例的托盘提示词都是 `Task Dock`，所以并行会话跑托盘退出自动化时，
   退出的是**通知区里第一个匹配的图标**——可能是正在压测的隔离实例。
   这与 §9.5 记录的「按镜像名 `taskkill` 误杀」是同一类跨实例污染，只是选择器换成了托盘图标名。

**处置**：

- `scripts/perf/quit-under-load.py` 增加前置检查：机器上存在除本实例外的其它 Task Dock 进程时
  **拒绝执行**托盘自动化（托盘自动化无法按 PID 定位），检查结果写入证据 JSON 的
  `other_taskdock_instances` 字段。
- 测量侧保留「实例中途退出即判该臂无效」的硬失败（`memory-scenario.py` 记录
  `instance_exited_after_s` / `instance_exit_code`，`memory-compare.py` 见到
  `process_exited_during_run` 即拒绝出归因），避免把死掉的实例读成「内存回落到 0」。
- 新增 `scripts/perf/exit-forensics.py`：区分「窗口先失效 → 产品优雅退出」与「被外部杀掉」，
  并用退出报告判别二者，可作为后续压测的前置体检。

完整取证记录：[performance/results/EXIT-FORENSICS-20261030.md](performance/results/EXIT-FORENSICS-20261030.md)。

### 9.8 剪贴板第四轮专项（P1-04 / P1-05）：三臂长跑方法学

§9.5–§9.7 的教训直接决定了本轮套件的设计：**测量装置本身必须先被怀疑**。
本轮（2026-10-30 23:51 起）用 `scripts/perf/fourth-round-memory-suite.sh` 跑三臂，
每一臂都满足以下前置条件：

| 前置 | 本轮做法 | 针对的历史事故 |
|---|---|---|
| 被测产物改名 | 复制为 `task-dock-acc1.exe` 后再测；采样器用 `-ProcessNamePattern '^task\-dock\-acc1'` 归组 | §9.5 记录的另一会话 `taskkill /IM task-dock.exe` 误杀 |
| 构建目录隔离 | `CARGO_TARGET_DIR=src-tauri/target-accept`，产物与并行会话的 `target/release` 不共用 | §9.5 记录的产物被换成 dev-mode 二进制 |
| 单实例锁隔离 | 每臂独立 `TASK_DOCK_DATA_DIR`（单实例锁标识 = 数据目录哈希），三臂互不互斥 | 多臂并行时第二实例直接退出 |
| 真实二进制 | `npx tauri build --no-bundle` 产出，带 `custom-protocol` 特性 | §9.3「裸 cargo build 不等于 tauri build」 |
| 零样本判失败 | `memory-scenario.py` 在 0 样本时写 `error` 并 `SystemExit(1)` | §9.5 记录的「采样器 0 样本被当成内存平稳」 |
| 实例中途退出即判该臂无效 | 记录 `instance_exited_after_s` / `instance_exit_code`，`process_exited_during_run` 为真则拒绝出结论 | §9.1/§9.7 记录的「死掉的实例被读成内存回落到 0」 |
| 分段而非整段斜率 | `memory-phases.py` 按 warmup / load / load_tail_quarter / post 切分，边界由 `http_accepted` 增长数据驱动 | §9.1「把负载期爬升与负载后回落平均成一条直线」 |

三臂参数（`memory-scenario.py`）：

| 臂 | 名称 | 负载 | 剪贴板 | 窗口 | 端口 |
|---|---|---|---|---|---|
| A | `fourth-round-memory-a` | 4 Agent × 5 事件/秒，通知开 | 关 | visible | 47851 |
| B | `fourth-round-memory-b` | 同 A（**可重复性对照**） | 关 | visible | 47852 |
| C | `fourth-round-joint-clipboard` | 同 A | **开**（真实 Windows 剪贴板事件 + 图片） | minimized | 47853 |

- A/B 参数完全相同但独立跑完 30 分钟负载 + 10 分钟后段，用于判断结论**是否可重复**，
  而不是一次偶然。臂 C 与 A 的唯一差异是剪贴板激励，用来分离“剪贴板路径”的贡献。
- 剪贴板激励由 `scripts/acceptance/clipboard_stimulus.py` 产生：它写的是**真实系统剪贴板**
  （每 3 s 一次 `CF_UNICODETEXT` 文本；每第 10 次**额外**写入图片：注册格式 `PNG` 为主、
  `CF_DIBV5` 为辅，文本不因此跳过），因此触发的是真正的 `WM_CLIPBOARDUPDATE`，
  **不是**向队列塞模拟事件。图片使用确定性构造的 RGBA 图（不透明/半透明/全透明三段），
  事后可按种子重算并逐字节比对入库 PNG 与 Alpha 通道。脚本会先把用户原剪贴板读入
  进程内存（不落盘、不写日志），结束时尽力恢复，恢复不了就如实记 `restored=false`；
  纯 ctypes 实现，不弹控制台窗口。
  （`CF_DIB` 单格式在本机 `SetClipboardData` 返回 `ERROR_INVALID_HANDLE=6`，已弃用；
  `CF_DIBV5` 与注册 `PNG` 均可真实写入并被系统广播。）
- 臂 C 的设置通过 `--settings-json` 注入 `clipboard_enabled=true` +
  `clipboard_capture_images=true` + `clipboard_capture_html=true`；
  `clipboard_enabled=false` 时采集被配置门控关掉（这一点在 P0-01/P1-02 后是硬约束）。

复现命令：

```bash
WORK=C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-v05-fourth \
  SRC_EXE="$PWD/src-tauri/target-accept/release/task-dock.exe" \
  DURATION=1800 POST=600 bash scripts/perf/fourth-round-memory-suite.sh
```

原始产物：`docs/performance/results/DIAG-fourth-round-*-<时间戳>.jsonl`（逐样本）、
`DIAG-fourth-round-*-<时间戳>-meta.json`（口径与退出码）、
`DIAG-fourth-round-*-<时间戳>-app.log`（被测实例自身日志）、
`analysis-fourth-round-*-<时间戳>.json`（分段分析），
套件日志 `docs/clipboard/evidence/perf-fourth-round-suite-*.log`。

### 9.9 剪贴板第四轮专项：分段分析口径

`scripts/perf/memory-phases.py` 的切分规则：

- `warmup`：采样起点 → 负载开始。负载起点取 `http_accepted` **首次增长**的样本。
- `load`：负载开始 → 负载结束。负载结束取 `http_accepted` **最后一次增长**样本之后的
  第一条样本。
- `load_tail_quarter`：负载期的后 1/4。线性增长会在后半段平坦，**尾段斜率最能暴露泄漏**。
- `post`：负载结束 → 采样结束（10 分钟观察窗）。
- 进程死亡后的样本一律剔除：内存读数为 0 代表「实例已退出」，不是「内存回落」。

每个指标给出 `n / first / last / min / max / mean / delta / slope_per_min`。
解读原则：**先看尾段斜率与 post 段回落**，再看整段均值差；单看整段斜率会把
「负载期爬升 + 负载后回落」平均成一条无意义的直线。

对照口径：
- `rust.live_bytes` 来自 `TrackingAllocator`（`src-tauri/src/alloc_stats.rs`），
  是 `#[global_allocator]`，**只统计 Rust 堆**；bundled SQLite 的 C 堆不在其中。
- `taskdock.private_mb` 是整个进程树的私有内存（含原生分配）。
- 因此 `private_mb` 与 `live_bytes` 的差值可以区分「Rust 侧持有」与「原生/SQLite 侧增长」，
  `db.page_count` / `db.wal_bytes` 则单独跟踪数据库增长。

## 10. 复验轮测试方法（2026-10-30 23:00→）

### 10.1 异常退出与文件/磁盘故障注入（`scripts/perf/fault-injection.py`）

```bash
python scripts/perf/fault-injection.py \
  --exe src-tauri/target/release/task-dock.exe --port 47875
# 只跑单个场景：--only F3
```

隔离约束（脚本内强制）：独立 `TASK_DOCK_DATA_DIR`/`APPDATA`/`USERPROFILE`/`TEMP`；
只用 `taskkill /PID <本脚本启动的 PID> /T /F` 终止**自己**启动的进程；
不触碰真实 Task Dock 进程、用户数据目录或系统盘。卷级磁盘写满需要管理员创建 VHD，
未提升时按要求标记 **NOT TESTED** 并用真实二进制上的写失败等价场景补证据。

| 编号 | 场景 | 注入方式 |
|---|---|---|
| F1/F2 | 投递期间强制结束进程 | `taskkill /T /F`（不给收尾机会） |
| F3 | 写库失败 → 落盘暂存；暂存文件被截断 / 残留半写 `.tmp` 文件 | **锁 WAL 帧区**（偏移 32 起 1MiB，`msvcrt.locking LK_NBLCK`）。WAL 模式下写入落在 `-wal` 的帧区，锁住它会让提交真实失败（disk I/O error） |
| F4/F5 | 恢复过程中强制结束进程 | 恢复进行到 `journal_state=committing` 时 `taskkill /F` |
| F6 | 恢复期间数据库文件被独占锁定 | `msvcrt.locking(LK_NBLCK)` 锁住 DB 首字节 |
| F7 | 卷级磁盘写满 | 需管理员创建隔离 VHD/VHDX；未提升 → NOT TESTED |
| F8 | 同一 `event_id` 同时走 HTTP 与文件投递 | HTTP POST + 写 `agent-inbox/*.json` |

**测量装置自身的两个坑（已修，务必保留这两个修复）**：

1. `/api/v1/health` 是**免鉴权**端点。残留的隔离实例会替后续场景应答，导致静默串台。
   → `Instance.start()` 除健康检查外，还用**带 token 的 `/api/v1/stats`** 确认应答者就是
   本轮实例；并维护实例登记表，场景之间与 `finally` 中强制回收；
   运行前检查目标端口是否被占用并直接中止。
2. 场景内抛异常会让隔离实例残留（上一轮 F3 的 `TypeError` 就是这样让实例活到了下一轮）。
   → 每个场景执行完毕后无条件 `Instance.stop_all()`。

### 10.2 真实 Agent 自动接入（`scripts/perf/agent-integration.py`）

```bash
python scripts/perf/agent-integration.py \
  --exe src-tauri/target/release/task-dock.exe --dsh-profile headless
```

要点：

- **必须由 Agent 自身会话产生事件**，手工调用 Hook CLI 不算自动接入。
- 每个 Agent 用独立 `HOME`/`APPDATA`/`DSH_HOME`；真实 Agent 的 auth/credentials **只读复制**，
  不写入任何真实用户配置目录。
- DSH 侧需要两个前提，缺一不可：
  1. profile 存在（`dsh --profile <name> --help` 会自动创建 `$DSH_HOME/profiles/<name>`）；
  2. provider 可用——`settings.yaml` 写 `llm-pi-ai.providers.agnes`（`apiKeyEnv: AGNES_API_KEY`），
     并用 `--patch` 把 `agent-default-model` 覆盖为 `agnes`，否则 headless profile 默认
     `provider: deepseek-official` 会 401。
- 判定：事件增量 > 0、状态序列含 running→终态、来源 `verified=1` 且 `transport_verified=1`、
  Agent 自身 stdout 能看到桥接生效的痕迹（DSH 打印 `[task-dock-bridge] loaded`）。

### 10.3 内存 A–F 实验矩阵（`scripts/perf/memory-af-suite.sh`）

```bash
WORK="C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-af-<ts>" \
EXE=".acceptance/task-dock-memaf.exe" PORT_BASE=47880 \
  bash scripts/perf/memory-af-suite.sh
# 只跑部分场景：ONLY=A,C
```

| 场景 | 配置 | 目的 |
|---|---|---|
| A | 空载 30min，窗口可见，通知关 | 纯基线漂移 |
| B | 仅 HTTP（窗口隐藏）30min，4 Agent × 5/s | 分离「接入路径」贡献 |
| C | 完整 UI + HTTP 30min | 分离「渲染路径」贡献 |
| D | 整桌面 + 文件回退 + 系统通知 30min | 最接近真实使用的负载 |
| E | 负载 10min 后空闲 30min | 看是否回落/平台化 |
| F | 重复负载 60min | 看是否随时长继续爬升 |

**测量装置要求**（这几条决定数据可不可信）：

- **被测二进制要改名**：采样器按镜像名归组资源占用，同名实例会污染本臂数据。
  把 `task-dock.exe` 复制为 `task-dock-memaf.exe` 再测，并在
  `scripts/perf/source-fingerprint.sh` 里记录 `measured_exe_sha256`，
  保证证据指向真正跑出数据的那份二进制。
- **必须带 `-Token`**：否则 `/api/v1/stats` 取不到，采样行里 `stats: null`，
  Rust 堆 / Tokio / SQLite 的归因数据全部缺失（2026-10-30 10:13 那轮 30 分钟 soak 就是
  因为漏了 `-Token`，只能看到 WS/private 两个黑盒数字）。
- **串行执行**：不与其他压测/编译重叠；采样期间不跑 cargo/npm。
- **0 样本即失败**：`memory-scenario.py` 在采样器没产出样本时直接 `SystemExit(1)`，
  不允许把「没测到」读成「内存平稳」。
- **实例中途退出即该臂无效**：`instance_exited_after_s` 非空即判失败，
  防止把死掉的实例读成「内存回落到 0」。

### 10.4 采样器新增字段

`sampler.ps1` 除 `planned_interval_s` / `actual_interval_s` / `sample_duration_s` 外，
本轮新增系统级 **Committed Bytes / Commit Limit**，用于区分「本进程增长」与「全机提交量增长」。
`memory-scenario.py` 的 `analyze_sampler()` 相应新增斜率字段
（private / ws / live / threads / handles / committed / alive_tasks / wal / db）与
`rust_live_bytes`、`tokio_alive_tasks`、`sqlite_wal_bytes`、`sqlite_page_count` 等首末值。



### 10.5 第五轮内存链（2026-10-30 23:53 → 10-31 01:35）：三臂归因 + C/E 长跑复跑

目的：给 §9 遗留的「2.3 KB/事件、无平台期」一个可重复的**归因口径**，并用**当前源码构建**的
release 二进制重跑 30 分钟负载与 30 分钟空闲。装置要点（缺一不可）：

- 被测副本改名 `task-dock-acc9.exe`（进程名含 task/dock，触发托盘自动化的拒绝执行；
  又与并行会话的副本名不同，采样器按精确镜像名归组不会串组）；
- 每臂独立 `--data-dir` / `APPDATA` / 端口，绝不接触用户真实库；
- `SOURCE=bridge --allow-real-source`：只有服务端判定为 `real` 的来源才发系统通知，
  否则「通知路径差值」恒为 0；
- **0 样本 / 实例中途退出即该臂失败**（`memory-scenario.py` 直接 `SystemExit(1)`）。

复现命令（整链串行，约 100 分钟）：

```bash
EXE=src-tauri/target/release/task-dock.exe \
WORK=C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-v05r5 \
ACC_NAME=task-dock-acc9.exe PORT_TRIAD=47910 PORT_AF=47920 \
DURATION=480 POST=90 SOURCE=bridge \
bash scripts/perf/v05r5-memory-chain.sh
```

归因与分段分析：

```bash
python scripts/perf/memory-compare.py docs/performance/results/DIAG-N1-*.jsonl \
  docs/performance/results/DIAG-N2-*.jsonl docs/performance/results/DIAG-N3-*.jsonl \
  --out docs/performance/results/MEM-ATTRIBUTION-v05r5.json
python scripts/perf/memory-phases.py --jsonl docs/performance/results/DIAG-C-ui-http-30min-20261031-002204.jsonl \
  --meta docs/performance/results/DIAG-C-ui-http-30min-20261031-002204-meta.json
```

被测二进制：15,603,200 B，`sha256=fb5e0eef708ff3e7193e5094f703d81f35ebbf422e6445fed61efdb718e27378`，
2026-10-30 23:50 由 `cargo build --bins --features tauri/custom-protocol --release`
从 `356bc44` + 工作区改动构建（9m28s）。

| 臂 | 样本 | Private 首→末 | 负载段斜率 | 后段斜率 | 结论 |
|---|---|---|---|---|---|
| N1 负载+通知开（480 s） | 97 | 41.3→49.1 MB | +0.809 MB/min | −0.657 MB/min | 41.3 MB 起点的 ≈30 MB 是 toast/COM 固定开销 |
| N2 负载+通知关（480 s） | 59 | 9.0→13.6 MB | +0.590 MB/min | −0.467 MB/min | 与 N1 差值即通知路径贡献 |
| N3 空闲（480 s） | 51 | 8.3→8.2 MB | +0.018 MB/min | — | 空闲基线平 |
| C UI+HTTP 负载（1800 s + 120 s） | 188 | 9.1→17.8 MB | 0.218（前 20 min）→ 0.066（尾段 9.1 min）MB/min | 结束后 116 s **0.000** | **出现平台期**；36,070 事件 / 0 丢弃 |
| E 负载 600 s + 空闲 1800 s | 255 | 11.9→18.9→19.3 MB | +0.542 MB/min | +0.0028（前 15 min）→ −0.0275（其后 14.5 min）MB/min | 负载结束不增长 |

分段斜率由 `scripts/perf/memory-window-slopes.py` 依据负载起点（C 85.2 s、E 78.1 s）对原始 jsonl
做最小二乘计算，窗口定义与结果见 `docs/performance/results/WINDOWS-C-ui-http-30min-20261031-002204.json`
与 `WINDOWS-E-idle-after-load-30min-20261031-005450.json`，可逐项复算。

归因：通知路径 **+3.2 MB/10 min（45 条 → ≈72.8 KB/条）**；接入路径 **+4.7 MB/10 min
（≈9,600 事件 → ≈0.49 KB/事件增量）**；基线 −0.1 MB。N1 `live_bytes` 仅 +0.038 MB
（`private_minus_live = 7.76 MB`）⇒ 不是 Rust 堆泄漏，是分配器保留 / 原生内存。

证据：`docs/performance/results/MEM-ATTRIBUTION-v05r5.json`、`PHASES-C-…-002204.json`、
`PHASES-E-…-005450.json`、`DIAG-*.jsonl` 与 `MEM-*.log`（见
[V05_FINAL_ACCEPTANCE.md](V05_FINAL_ACCEPTANCE.md) §5.5）。

**边界**：只覆盖 20 事件/秒、单实例、单显示器；未做 ETW/Heap 逐分配点归因；
未覆盖 500 事件/秒持续负载、8 小时以上长跑、安装形态与长时间 UI 交互。
