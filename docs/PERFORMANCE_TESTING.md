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

