# Task Dock v0.5 最终性能与可靠性验收报告

> 验收日期：2026-10-30 · 应用版本：0.5.0 · 构建：`release`（MSVC，LTO）
> Git 基线：`66d1eb7`（v0.5 提交）· 工作树：未提交修改（本轮验收直接修改源码，未 commit）
> 原则：只记录实际执行结果；未执行、环境阻塞、缩短执行的部分单独标注，不把未测项写成 PASS。
>
> **编号说明**：本报告按任务书编号：**P0-01 事件顺序、P0-02 退出排空、P1-03 文件队列容量、
> P1-04 快速/完整备份与恢复、P1-05 真机全链路验收**。开发过程中曾把“全量备份/恢复原子性/
> 退出超时”写作 P0-01/P0-02/P1-03，那套编号与本报告不同；引用旧文档时以内容为准，不以编号为准。
>
> **复验轮编号（2026-10-30 23:00 起的追加轮次）**：追加轮次采用另一套编号，为避免与上表混淆，
> 本轮条目一律加前缀 **R-**（复验）：
> **R-P1-01 内存专项与 A–F 归因、R-P1-02 有界内存恢复、R-P1-03 真实 Agent 自动接入、
> R-P1-04 异常退出与文件/磁盘故障注入、R-P2-01 采样器统计、R-P2-02 前台焦点与桌面 GUI**。
> 详见 §14。

## 1. 结论摘要

| 验收项 | 结果 | 依据 |
|---|---|---|
| P0-01 事件顺序 | **PASS** | 9 个顺序/屏障测试 + 4 例终态保护；A3 30,000/30,000 关键事件落库、0 缺失、0 dedupe 重复；soak DB 3,600 条关键事件每条恰好 1 行 |
| P0-02 正常退出排空 | **PASS** | E6 退出 81ms、14/14 排空、0 未完成；E7/E8 重启 102/200 文件全部入库、0 重复 |
| P0-02 异常退出（真实 kill/断电） | **NOT TESTED** | 只有 spool/journal 故障注入与进程重启模拟，未做物理断电或真实 `kill -9` |
| P1-03 文件队列容量 | **PASS（除真实满盘）** | 5,050 预填拒绝普通写入、关键预留可写、5,260 时关键也拒绝、不删旧文件；真实磁盘写满 NOT TESTED |
| P1-04 备份与恢复 | **PASS（有边界）** | 100k 夹具 61.9MB 往返 + 真机 78.44MB 全量恢复 14.28s、25 表一致、21 个恢复故障测试；恢复非常量内存、多 GB 包 NOT TESTED |
| P1-05-A 500/s × 10min | **PASS** | 300,000 / 600.368s = 499.69/s；30,000/30,000 关键；0 拒绝 |
| P1-05-B 200/s × 60s | **PASS** | 12,000 / 60.262s = 199.13/s；1,200/1,200 关键 |
| P1-05-C ≥3 真实安装 Agent | **PARTIAL（原轮）→ R-P1-03 已补测为 PASS** | 原轮：7 个真实安装来源检测到，codex/trae/workbuddy 各 5 次 Hook CLI 投递成功，但 `configured=false`、实时会话未验证。复验轮：codex / DeepSeek Harness / OpenCode **三个 Agent 的自动事件全部落库**，见 §14.2 |
| P1-05-D 30 分钟整桌面 | **吞吐 PASS / 内存 NOT PROVEN** | 36,000/36,000 成功、3,600/3,600 关键、0 丢弃；主进程 private 11.4→95.1MB 未平台；R-P1-01 复验轮 A–F 实验进行中，见 §14.4 |
| P1-05-E 故障注入 | **PASS（除注明项）** | 重复/乱序/超时/突发/SQLite busy/文件回退/退出/重启/备份恢复均实测；真实满盘、真实强杀 NOT TESTED |
| 工程门禁 | **通过（2 例环境失败）** | fmt/check/clippy/tsc/build 通过；Rust 381 passed / 2 failed / 13 ignored；前端 133/133 |
| R-P1-03 真实 Agent 自动接入 | **PASS** | codex / DSH / OpenCode 三方**自动**产生 running→completed 事件并落库；DSH 适配器由「写插件目录但宿主不加载」修正为真正的 profile bundle 安装；证据 `AGENT-agent-integration-20261030-233909.json`（§14.2） |
| R-P1-04 异常退出与文件/磁盘故障 | **PASS（F7 除外）** | 真实 `taskkill /F` 强杀、恢复中断强杀、文件独占锁、HTTP+文件同事件幂等、写入失败落盘暂存、损坏暂存隔离与幂等重放全部实测通过；卷级磁盘写满 NOT TESTED（无提升权限）（§14.3） |
| R-P2-01 采样器统计 | **PASS** | 采样间隔字段拆成 `planned/actual/sample_duration` 三项并按时间戳重算，原始 jsonl 未改动（§8.4、`sampler-recompute-D-soak-20261030.json`） |

**最终判定：CONDITIONAL PASS（有条件通过）**。P0-01、P0-02（正常退出）、P1-03、P1-04 的
实现与自动化测试完成，并通过真机规模/故障数据复核；但 30 分钟负载下主进程内存持续增长、
恢复读取不是常量内存、真实满盘/断电/强杀未测、C 场景实时 Agent 会话未验证，因此不记为
无条件 PASS，也不把未测项写成 PASS。

## 14. 复验轮（2026-10-30 23:00 起）：内存专项、真实 Agent、异常退出与故障注入

复验轮针对原报告 §11 中「内存根因未定位」「C 场景实时会话未验证」「异常退出未实测」三处
缺口补做实验。所有结论标注被测二进制指纹，**不与旧数据混用**。

### 14.1 被测版本

| 项 | 值 |
|---|---|
| `git_head` | `356bc44`（工作树为未提交修改） |
| 复验轮源码树指纹 | `source_tree_sha256=b30399039c0194820ce112a10f5726c09bf14c9bd1352c62371442a324a3d01c`（测量开始时刻） |
| R-P1-03 被测二进制 | `sha256=82ec60a3352e4ee639ef2d979d0d7a57af0bf9b3bf7c14bd611148c5ba1f2182`，15,612,416 字节（23:38:49 构建） |
| R-P1-04 被测二进制 | `sha256=fb5e0eef708ff3e7193e5094f703d81f35ebbf422e6445fed61efdb718e27378`，15,603,200 字节（23:50:36 构建） |
| R-P1-01 被测二进制 | `sha256=fb5e0eef…`（改名副本 `.acceptance/task-dock-memaf.exe`，与上一行同一份构建产物） |

> **改名副本的理由**：测量期间同一工作树上存在另一会话的 `task-dock.exe` 实例。采样器按
> 镜像名归组资源占用，同名实例会污染本臂数据，因此把被测二进制复制为异名副本
> （`task-dock-memaf.exe`）后测量，其 sha256 与 `src-tauri/target/release/task-dock.exe`
> 完全一致，可溯源到同一份源码构建产物。

### 14.2 R-P1-03 真实 Agent 自动接入：**PASS**

原报告 §8.3 记为 PARTIAL 的原因是「只调用了 Hook CLI，没有真实会话触发」。复验轮改为
**由 Agent 自身会话产生事件**，不再手工注入。

证据：`docs/performance/results/AGENT-agent-integration-20261030-233909.json`

| Agent | 结果 | 事件增量 | 状态序列 | 传输 | Agent 侧自证 |
|---|---|---|---|---|---|
| codex（0.165.0-alpha.1.2） | **PASS** | 0→3 | running→completed | http | 自身 stdout 打印 `hook: SessionStart / UserPromptSubmit / Stop` |
| DeepSeek Harness（DSH） | **PASS** | 0→2 | running→completed | http | 自身 stdout 打印 `[task-dock-bridge] loaded` |
| OpenCode | **PASS** | 0→3 | running→completed→failed | http | 会话事件由插件写入 |

- 来源健康状态：`codex` / `deepseek-harness` / `opencode` 三者 `verified=1`、
  `transport_verified=1`；其余来源（trae/workbuddy/qoder/zcode/bridge）仍为 0。
- **多 Agent 隔离**：三个 Agent 使用不同 `session` 与不同来源标识，事件互不串台；
  DSH 与 OpenCode 的会话 ID、通道与时间轴互相独立。
- **Hook 非阻塞**：Hook 进程开销 40 次调用 p50 38ms / p95 74ms / p99 91ms / max 91ms，0 错误；
  退出后残留 Hook 进程 0（仅 1 个测量用的 PowerShell 枚举命令）。
- **状态更新延迟**：codex p50 159.0 / p95 263.1ms；OpenCode p50 318.7 / p95 640.1ms；
  DSH p50 267.9 / p95 350.3ms。
- **配置不被破坏**：卸载后 codex `marker_removed=true`、DSH `profile_bundle_removed=true` +
  `profile_listing_removed=true` 且 `profile_base_bundles_kept=true`；三方
  `third_party_kept=true`；全程只读复制真实 Agent 的 auth/credentials，
  **未写入任何真实用户 Agent 配置目录**（隔离 `DSH_HOME`/APPDATA/USERPROFILE）。

#### 14.2.1 修复：DSH 适配器此前是「功能空操作」

复验轮发现 DSH 适配器写出的插件包**宿主根本不会加载**：`~/.dsh/plugins/` 只是客户端插件位，
宿主插件必须以 **profile bundle** 形式安装。修复后（`src-tauri/src/agents/dsh.rs`）：

- 生成 `package.json`（声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`）+
  `cordis.patch.yml` + `lib/index.js`；
- 安装到 `<profile>/node_modules/task-dock-bridge/`，并登记进 profile 的
  `dependencies["task-dock-bridge"]` 与 `dsh.profile.bundles`；
- **只改动这两个字段**，第三方 dependency/bundle 与其它顶层字段原样保留
  （`config_preservation.dsh_profile_base_bundles_kept=true`、
  `dsh_profile_manifest_other_fields_kept=true`）；
- 卸载只删 Task Dock 自己的条目与目录，保留 `node_modules` 下的第三方包；
- 迁移 v14（`src-tauri/src/db/mod.rs`）修正 `agent_sources` 里原先会误导用户的说明。

新增 6 个单元测试（manifest 声明、bundle 登记与第三方条目保留、幂等安装、
无 manifest 的 profile 跳过、卸载只删自己的条目、卸载保留第三方包）全部通过。

### 14.3 R-P1-04 异常退出与文件/磁盘故障注入：**PASS**（F7 卷级写满除外）

证据：`docs/performance/results/FAULT-fault-injection-20261030-235312.json`
（隔离根 `C:\Users\ASUS\AppData\Local\Temp\taskdock-fault-20261030-235312`）

> **隔离约束**：全程独立 `TASK_DOCK_DATA_DIR`/`APPDATA`/`USERPROFILE`/`TEMP`；
> 只用 `taskkill /PID <本脚本启动的 PID> /T /F` 终止**自己**启动的进程；
> 未触碰真实 Task Dock 进程、用户数据目录或系统盘。

| 编号 | 场景 | 实测结果 | 结论 |
|---|---|---|---|
| F1/F2 | 投递期间强制结束进程（真实 `taskkill /F`） | 投递 175 条 / 接受 174 / 强杀成功；强杀前已提交 168 条，**重启后仍为 168 条**；0 重复 `event_id`；`integrity_check=ok`；WAL 存在 | **PASS** |
| F3 | 写库失败 → 落盘暂存 + 暂存文件被截断/残留半写文件 | 锁 WAL 帧区后 6 次写入全部 **HTTP 500 且 `retryable=true`**；生成 6 个 `spool-*.jsonl`；重启后**损坏文件被隔离到 `corrupt/`**（`files_quarantined=1`），5 个完整文件**幂等重放 5/5 事件**（`deduplicated=0`），0 重复 `event_id`，`integrity_check=ok`，启动未受阻 | **PASS** |
| F4/F5 | 恢复过程中强制结束进程 | 恢复进行到 `journal_state=committing` 时被强杀；**重启后 journal 已被正确判定并清理**（`journal_left_after_restart=false`）；事件数恢复前后均 60,000；`integrity_check=ok`；健康检查 ok | **PASS** |
| F6 | 恢复期间数据库文件被独占锁定 | 恢复整体失败（rc=1，`disk I/O error`）；事件数前后均 60,000；**未留下 journal**；`integrity_check=ok`；健康检查 ok | **PASS** |
| F8 | 同一 `event_id` 同时走 HTTP 与文件投递 | HTTP 200；DB 中该 `event_id` **恰好 1 行** | **PASS** |
| F7 | 卷级磁盘写满（隔离 VHD/VHDX） | 未执行：`fltmc` 探测返回 `0x80070005`（会话未提升）。按隔离要求不对真实卷做写满注入 | **NOT TESTED** |

**F7 的等价证据（真实二进制）**：E1 备份目标是已存在目录 → 备份 rc=1 且**未留下任何半截产物**；
E2 备份包被截断 → 恢复 rc=1（`备份第 44 行不是合法 JSON`）、事件数前后均 60,000、
`integrity_check=ok`。另有两个 Rust 单元测试覆盖写满/权限拒绝路径：
`commands::restore::tests::disk_full_during_archive_commit_rolls_back`、
`commands::restore::tests::permission_denied_during_asset_commit_rolls_back`。

#### 14.3.1 故障注入期间的实测结论（数据可靠性边界）

- **已提交事务**：强杀后完整保留，0 重复，0 损坏（`integrity_check=ok`）。
- **已 fsync 的 spool**：重启后幂等重放，重复投递由 `event_id` 去重，损坏文件隔离保留而非丢弃。
- **内存中未持久化的事件**：F1/F2 中 174 条被接受、168 条已提交，**差额 6 条随强杀丢失**。
  这是**已落库前只在内存里的事件**，任务书明确不允许为其承诺断电零丢失，此处如实记录。
- **客户端重试语义**：写失败一律返回 HTTP 500 且 `retryable=true`；客户端可安全重试，
  重试由 `event_id` 保证幂等。
- **证据保留**：损坏的暂存文件被移到 `ingest-spool/corrupt/`，不删除。

#### 14.3.2 过程中修正的两处验收脚本缺陷（不影响产品结论）

1. `db_query()` 缺少参数位，导致 F3 的参数化查询抛 `TypeError` → 已修（补 `params` 形参）。
2. 场景内异常会让隔离实例**残留**，其免鉴权的 `/api/v1/health` 会替后续场景应答，
   造成静默串台（F3/F6 曾因此误判）→ 已修：
   - `Instance` 增加实例登记表，场景之间与 `finally` 中强制回收；
   - 实例启动后额外用**带 token 的 `/api/v1/stats`** 确认应答者就是本轮实例；
   - 运行前检查目标端口是否被占用并直接中止。

   > 该缺陷也解释了「同一次运行里 F3/F6 结果与另一次运行相反」的现象：两轮结果都不可信，
   > 修好后才得到上表的全部 PASS。

### 14.4 R-P1-01 内存专项与 A–F 归因：进行中

结论待 §14.6 的实验矩阵完成后填入；未填前不得据本节引用任何内存结论。

### 14.5 R-P1-02 有界内存恢复

结论待 §14.6 填入。

### 14.6 复验轮实验矩阵与结论

> 本节在 A–F 实验完成后填写；未完成前不得据本节下任何结论。


> **复验轮对判定的修正（见 §14）**：复验轮补齐了原报告的两处缺口——C 场景真实 Agent 会话
> （已升级为 R-P1-03 PASS）与异常退出/文件故障注入（已升级为 R-P1-04 PASS），
> 并把「内存未定位」升级为有插桩的 A–F 归因实验。**内存条目在 §14.4 出结果前仍为
> NOT PROVEN**，总体判定仍为 CONDITIONAL PASS。

## 2. Git 基线、变更范围与证据位置

- 起始 `HEAD`：`66d1eb755aa692febdad720e37b5cd6d16f9591d`（`feat(v0.5): 工作现场、Agent 行动中心与智能剪贴板，并修复托盘图标重复`）。
- 工作树在验收开始前即包含 v0.5 的未提交修改；本轮**未执行** `git reset --hard`、`git clean -fd`、
  未覆盖其他功能的未提交修改，也未创建 commit。
- 相对 `HEAD` 的已跟踪变更：**53 个文件，+7,367 / −986**（含 README 与 11 份 `docs/` 文档修订；
  不含 `docs/performance/results/`、`docs/clipboard/evidence/` 等未跟踪验收产物）。
  本报告自身与新增 `V05-*` 证据文件均为未跟踪文件。
- 本轮 P0/P1 相关核心文件：
  - `src-tauri/src/agents/pipeline.rs`：受理序号、跨队列排序、关键状态屏障、退出生命周期、暂存兜底。
  - `src-tauri/src/agents/inbox.rs`：文件队列容量、关键预留、原子写、锁回收。
  - `src-tauri/src/agents/file_drop.rs`：自适应扫描、单轮上限、关键最新通道、失败隔离。
  - `src-tauri/src/agents/spool.rs`：稳定 `event_id` 的原子暂存与幂等重放。
  - `src-tauri/src/commands/backup.rs`：25 表注册表、全量/快速流式写入、读取校验、100k 验收测试。
  - `src-tauri/src/commands/restore.rs`：恢复状态机、journal、预备份、暂存/保险库、回滚、崩溃恢复。
  - `src-tauri/src/commands/data.rs`：导入校验、旧版兼容导入、外键检查、`ingest_seq` 续接。
  - `src-tauri/src/db/mod.rs`：`with_read` 读连接池 try-lock 跳过长快照占用。
  - `src-tauri/src/winproc.rs`（新增）：控制台子进程 `CREATE_NO_WINDOW`。
- 验收产物：`docs/performance/results/V05-*.json|log`、`docs/performance/results/*-20261030*`、
  `docs/clipboard/evidence/*`。

## 3. 修复的问题、严重级别与代码清单

### 3.1 问题与严重级别

| 编号 | 严重级别 | 问题 | 修复结果 |
|---|---|---|---|
| P0-01 | P0 | 主队列与合并缓冲分别消费：合并缓冲可能先于更早受理的队列事件写入；关键状态可被前后 running 合并吞掉；终态后迟到 running 可回退状态 | 入口分配全局 `ingest_seq`；主队列+缓冲稳定排序；关键状态成屏障；终态/时间双重保护 |
| P0-02 | P0 | 退出只统计已入队数量，合并缓冲/未写事务可能未落库；超时仍可能报告“已排空”；进程被杀后无重放 | QUIESCING→DRAINING→STOPPED；排空全部批次；超时如实报告并原子 spool；重启幂等重放 |
| P1-03 | P1 | 文件投递目录无总量上限、无单轮上限；满目录时关键状态无法写入；半写文件/权限失败可造成阻塞或死循环 | 5,000 文件/256MiB + 关键预留 250/16MiB；原子写；单轮 16MiB/8MiB 单文件；失败隔离；自适应扫描 |
| P1-04 | P1 | 全量备份遗漏 Agent/通知/导航/剪贴板/工作现场/动作/设置；资产缺失静默跳过；恢复非原子；旧包会删新模块 | 25 表注册表 + 双向资产校验；Quick/Full 语义；恢复状态机/journal/预备份/回滚；旧包保留新模块 |
| P1-04b | P1 | 备份长读快照占住读连接，普通查询等待；恢复把整包行集合物化到内存 | 读池 try-lock 跳过忙连接；恢复峰值 686.2→619.0MB，但仍非常量内存（保留项） |
| P1-05b | P1（用户可见） | Release 无父控制台，`tasklist`/`reg`/`where`/`powershell` 探测每次闪出控制台窗口 | 新增 `winproc::hidden()` 统一 `CREATE_NO_WINDOW`；重建 Release 后整桌面长跑 0 个可见控制台 |

### 3.2 代码清单（关键位置）

| 能力 | 位置 |
|---|---|
| 受理序号（入口、任何等待之前） | `src-tauri/src/agents/pipeline.rs:771`、`:784` |
| 主队列+合并缓冲稳定排序 | `src-tauri/src/agents/pipeline.rs:1331`、`:1347` |
| 关键状态屏障 / 仅连续 running 合并 | `src-tauri/src/agents/pipeline.rs:1349`–`:1377` |
| 终态/时间因果保护 | `src-tauri/src/agents/mod.rs:570`–`:690` |
| 退出 QUIESCING→DRAINING→报告 | `src-tauri/src/agents/pipeline.rs:112`、`:614`、`:693`、`:702` |
| 消费者排空队列/合并缓冲 | `src-tauri/src/agents/pipeline.rs:997`、`:1107`、`:1312` |
| 超时事件安全暂存 | `src-tauri/src/agents/pipeline.rs:1208`、`:1246` |
| spool 原子写/幂等重放 | `src-tauri/src/agents/spool.rs:78`、`:94`、`:134`、`:282` |
| 文件队列容量/关键预留 | `src-tauri/src/agents/inbox.rs:19`–`:26`、`:247`、`:305`、`:325` |
| 文件扫描上限/关键最新通道/失败隔离 | `src-tauri/src/agents/file_drop.rs:30`–`:39`、`:349`、`:436`、`:640` |
| 25 表注册表 | `src-tauri/src/commands/backup.rs:98` |
| 全量/快速流式写入 | `src-tauri/src/commands/backup.rs:1150` |
| 备份读取与完整性/路径/引用校验 | `src-tauri/src/commands/backup.rs:1436` |
| 注册表覆盖 `sqlite_master` 自动检测 | `src-tauri/src/commands/backup.rs:2442` |
| 100k 事件全链路验收测试 | `src-tauri/src/commands/backup.rs:3483` |
| 恢复状态机/预备份/文件提交/回滚 | `src-tauri/src/commands/restore.rs:603` |
| journal 与崩溃恢复 | `src-tauri/src/commands/restore.rs:210`、`:928` |
| “数据库已提交但归档提交失败”回滚测试 | `src-tauri/src/commands/restore.rs:1414` |
| 旧备份保留新模块 | `src-tauri/src/commands/restore.rs:1729` |
| 导入校验/旧版兼容/外键与 `ingest_seq` | `src-tauri/src/commands/data.rs:1387`、`:1406` |
| 读连接池跳过长快照连接 | `src-tauri/src/db/mod.rs:625`、`:635` |
| 控制台窗口抑制 | `src-tauri/src/winproc.rs:11`、`:24`；调用点 `agents/managed.rs:92`、`agents/discovery.rs:58`、`navigation/app_discovery.rs:529`、`navigation/agent_navigation.rs:200` |

## 4. P0-01 事件顺序：根因、实现与验证

### 4.1 根因

v0.5 的接入链路是“有界队列 → 250ms 合并窗口 → 批处理”。旧实现先处理主队列，再单独清空
合并缓冲；当较早受理的 running 还在合并缓冲、较晚受理的关键状态已进入主队列时，关键状态
可能先落库，随后被更早的 running 覆盖。合并缓冲按“同一轮次+通道”去重时，如果不在关键状态
处切断，前后两段 running 会被合并成一条，关键状态消失。数据库层还缺终态保护：`completed`
之后到达的旧 `running` 可能把轮次重新打开。

### 4.2 实现

1. **入口分配全局受理序号**：`submit` 在 `begin_submit` 之后、任何队列等待/合并之前，为每个
  事件分配单调递增 `ingest_seq`（`pipeline.rs:784`），文件通道、HTTP 通道、合并缓冲共用同一序列。
2. **统一稳定排序**：`process` 把当前作业与合并缓冲拼成一个数组，按 `ingest_seq` 稳定排序后
   再落库（`pipeline.rs:1347`），不再“先清缓冲/先消费队列”。
3. **关键状态屏障**：同一 `coalesce_key` 的连续 running 可合并；遇到非 running（waiting/
   completed/failed/disconnected/idle）立即关闭 `running_slot`，其后的 running 不得与屏障前的
   进度合并（`pipeline.rs:1349`–`:1377`）。
4. **最新关键状态胜出**：同一批内关键状态按受理序号排序；例如 1,000 条 running 后到达的
   waiting 必须最后写入，不能被前面的进度吸收。
5. **终态/时间双重保护**：数据库层用 `last_ingest_seq` 与 `last_event_at` 判断迟到事件；
   终态后的旧 running 只入流水，不改变轮次状态；只有事件时间严格晚于结束时间且不是终态时，
   才允许同一 `external_run_id` 开启新一轮（`agents/mod.rs:570`–`:690`）。
6. **幂等**：`event_id` 唯一索引 + `dedupe_key` 内容签名；重复投递只保留一行。

### 4.3 自动化测试（10 个场景，全部通过）

| 测试 | 位置 | 断言 |
|---|---|---|
| `process_sorts_main_queue_and_merge_buffer_by_ingest_seq` | `pipeline.rs:1967` | 主队列 500 + 缓冲 100/300 → 落库顺序 100/300/500 |
| `critical_state_is_a_coalescing_barrier` | `pipeline.rs:1984` | running/waiting/running 三段保留，`events_merged=0` |
| `thousand_running_burst_keeps_waiting_and_respects_barrier` | `pipeline.rs:2009` | 500 running + waiting + 500 running → 3 条，waiting 在中间 |
| `newest_waiting_wins_after_progress_burst` | `pipeline.rs:2041` | 1,000 running + 最新 waiting → waiting 最后落库 |
| `drain_merged_handles_all_batches_in_seq_order` | `pipeline.rs:2066` | 7 条缓冲按批 2 分 4 批，顺序 1..7 |
| `shutdown_drains_every_merge_batch` | `pipeline.rs:2086` | 450 条缓冲跨 3+ 批全部写入，`unfinished_events=0` |
| `full_queue_alternating_critical_events_are_not_lost` | `pipeline.rs:2114` | 队列容量 1、10 轮交替 running/waiting，10 条关键全部落库 |
| `http_and_file_progress_keep_global_order` | `pipeline.rs:2157` | 文件 100 / HTTP 200 / HTTP 300 → 顺序 100/200/300 |
| `merge_buffer_full_samples_only_noncritical_and_keeps_critical` | `pipeline.rs:2182` | 缓冲满只采样非关键，关键仍 accepted |
| 终态保护（4 例） | `agents/mod.rs:1438`、`:1759`、`:2320`、`:2356` | 迟到 running 不复活/不回退终态；同一 run 重连按事件时间开新轮 |

### 4.4 真机数据

- **A3**：30,000 条关键事件全部落库，DB 对账 `critical_present=30000`、`critical_missing=0`、
  `dedupe_key_duplicates=0`、`integrity_check=ok`（`db-A3-20261030-085817.json`）。
- **30 分钟 soak**：客户端 3,600 条关键事件；DB 中 `http-soak2-20261030-101315%` 共 21,282 行，
  其中 17,682 running + 1,800 waiting + 1,800 completed = 3,600 条关键，**每条恰好 1 行**，
  0 重复 `event_id`（`V05-SOAK-30MIN-DB-RECON-20261030.json`）。
- **乱序注入**：终态后迟到 running 后，run 仍为 `waiting`，旧 running 未改变状态
  （`E2-interleave-20261030-091402-audit.json`）。
- **重复注入**：21 个唯一 ID 各 1 行，0 重复（`E2-duplicate-20261030-091402-audit.json`）。

**边界**：真机只做了 HTTP 单通道与“文件回退→重启”场景；HTTP+文件同 run 的跨通道顺序由
单元测试 `http_and_file_progress_keep_global_order` 覆盖，未单独做真机跨通道顺序注入。

## 5. P0-02 正常退出与异常退出

### 5.1 生命周期

`RUNNING → QUIESCING（停收新提交，等待已进入的提交退出）→ DRAINING（排空通道与全部合并
批次，等待当前事务）→ STOPPED`（`pipeline.rs:112`、`:614`、`:693`、`:702`）。

- 关闭时先置 `closed`，新提交返回 `Unavailable`；已进入的提交在硬时限内完成。
- 消费者收到 shutdown 作业后：先处理通道中已受理作业，再排空合并缓冲；即使已到时限，也必须
  把 shutdown 作业送进通道，让消费者执行磁盘暂存。
- 报告字段：`lifecycle`、`timed_out`、`queued_events_at_start`、`merge_events_at_start`、
  `drained_events`、`events_processed`、`unfinished_events`、`spooled_events`、
  `unsaved_events`。**超时不伪造“已持久化”**：未落库且未 fsync 的事件如实计入 `unsaved_events`。
- spool：每文件 ≤500 事件，`.tmp` + `sync_all` + 原子 rename；重启 `replay_pending` 成功后才删除
  文件，重复投递由 `event_id` 去重；损坏文件隔离保留（`spool.rs:78`、`:94`、`:134`、`:282`）。

### 5.2 自动化测试

- 排空：500 条队列事件、450 条合并缓冲、3,000 条跨队列+缓冲、延迟 SQLite、写失败、
  排空超时、重复 shutdown、shutdown 与提交竞争、无事件快速退出。
- 暂存/重放：超时原子 spool、spool 写失败如实报告、事务失败回退后 spool、HTTP 在途提交、
  HTTP+文件双通道停止、重启重放不复活终态轮次。
- 对应测试：`pipeline.rs:2235`、`:2259`、`:2284`、`:2302`、`:2326`、`:2361`、`:2377`、`:2412`、
  `:2437`、`:2474`、`:2506`、`:2579`、`:2624`、`:2687`、`:2729`；`spool.rs:527`。
- 共 17 个退出/spool 测试通过（见 §10）。

### 5.3 真机正常退出（E6）

- 773 条提交、464 条关键；`last-shutdown-report.json` 记录的管线排空耗时 **81ms**，
  `queued_events_at_start=14`、`drained_events=14`、`events_processed=703`、
  `unfinished_events=0`、`timed_out=false`。自动化从启动 PowerShell 托盘点击到进程消失
  为 12.71s，该数值包含 PowerShell 启动与 UI 自动化开销，不是纯应用退出耗时。
- 退出后 inbox 102 个文件（70 个关键状态文件）；按 `session+event` 对账 **464/464 关键事件
  可覆盖**（416 在 DB，其余在 inbox；`critical_missing_db_not_in_inbox=[]`）。
- 重启（E7）：inbox 102→0；464/464 关键事件在 DB 中恰好 1 行；773 个会话全部存在；
  0 重复 `event_id`；`integrity_check=ok`。
- 定时重启（E8）：应用停止期间写入 200 个文件（120 关键）；启动后 **55.67s** 排空到 0；
  200/200 入库、120/120 关键、0 缺失、0 重复、`integrity_check=ok`。

### 5.4 异常退出边界

- **未做真实 `kill -9`/物理断电**。已有：spool 原子写、journal 恢复、故障注入与进程重启模拟；
  这些证明“已提交事务 + 已 fsync 的 spool 可恢复”，**不证明**未 fsync 内存事件不丢。
- 10:13 那一次 30 分钟 soak 的实例由验收脚本结束进程，`data-v3/last-shutdown-report.json`
  仍是 09:30（`events_processed=102`）的旧文件；因此**不把该 soak 实例当作正常退出证据**，
  正常退出只引用 E6/E7/E8。
- 退出硬时限内未完成的事务不会被打断；超时后由 spool 兜底；spool 写失败时报告
  `unsaved_events`，不承诺零丢失。

## 6. P1-03 文件队列：容量、扫描与失败隔离

### 6.1 容量与写入

- 上限：`MAX_FILES=5000`、`MAX_BYTES=256MiB`、`MAX_FILE_BYTES=8MiB`；关键状态额外预留
  `250` 文件 / `16MiB`（`inbox.rs:19`–`:26`、`:325`）。
- 普通写入在总量耗尽时返回 `ReserveError::Full`，原因明确为“关键事件预留空间保留”；
  关键写入可用预留额度；预留也耗尽时明确失败“关键预留也已耗尽”。
- 配额锁：`create_new` + PID/时间戳 + `sync_all`；持有者死亡可回收，空锁不误删；
  临界区超时可重试；并发写入严格不超上限（实现 `inbox.rs:247`，并发测试 `:564`）。
- 原子写：临时文件 `create_new` + `write_all` + `sync_all` + `rename_with_retry`；
  不覆盖已有文件、不删除他人文件；失败清理 tmp（`inbox.rs:305`、`:282`）。
- 统计：`measure` 只计有效 `.json`，`failed/` 与 `.tmp` 不计入配额，外部脚本文件计入
  `external_files`，便于诊断但不擅自删除。

### 6.2 扫描与失败处理

- 自适应节拍：活跃 750ms、积压 1s、空闲最长 5s；稳定年龄 300ms，避免半写文件
  （`file_drop.rs:30`–`:34`）。
- 单文件最多 1,000 事件；单轮最多读取 16MiB；关键最新通道最多 64 文件/16MiB，
  保证最新目录里的 waiting/completed/failed 不被旧积压饿死（`file_drop.rs:35`–`:39`、`:349`、`:436`）。
- 读取失败（独占锁/权限）连续 5 次移入 `failed/`；解析/超限失败按指数退避最多 8 次，
  仍失败移入 `failed/` 并保留原文件；失败日志 256KiB 上限（`file_drop.rs:198`、`:557`）。
- 手动恢复 `retry_failed_inbox` 受总量约束，空位不足时明确拒绝，不清空/覆盖现有投递。

### 6.3 验证

- 12 个 inbox 单元测试：总文件上限、总字节上限、关键预留、超大单文件、原子写无 tmp、
  活锁/死锁与锁回收、并发 40 写入不超 10、measure 忽略 failed/tmp、tmp 清理、失败日志。
- 集成测试 `tests/inbox_processes.rs:10`：**50 个并发 Hook 进程**写入完整事件通过。
- E5 真机：预填 5,050 文件 → 普通 `PreToolUse` 被拒绝（exit 0，failure log 记录）；
  `Stop` 关键事件使用预留成功（5,051）；预填 5,260 → 关键也拒绝（5,260 不变）；
  **全程未删除任何文件**（`E5-file-fallback-20261030-091652.json`）。
- E6/E8：102/200 个真实 Hook 文件在退出/重启后全部被扫描入库，失败日志为空/无丢失。
- **NOT TESTED**：真实磁盘写满（只在恢复用注入 IO 错误模拟）、杀毒软件长期占用导致 rename
  持续失败、`kill -9` 恰好发生在 rename 与 fsync 之间的物理时序。

## 7. P1-04 快速/完整备份与恢复

### 7.1 覆盖范围

- **25 张业务表**：任务域 5、Agent 域 6、导航域 3、剪贴板域 6、工作现场 3、动作与设置 2。
- **文件资产**：`clipboard/images/*.png`、`clipboard/thumbs/*.png` 逐文件 SHA-256+大小；
  `clipboard_assets.path` 必须全部命中且可读，缺失/不可读直接失败；文件集合必须被合法行
  引用（全量模式），双向校验。
- **Agent 归档**：`*.jsonl` 按 1MiB 文本块写入；拒绝绝对路径、`..`、反斜杠、NUL、重名。
- **设置**：默认导出全部用户设置；`EXCLUDED_SETTINGS = ["http_token", RESTORE_COMMIT_KEY]`
  永不入包；`window_rect`/`snap_state`/`nav_window_memory`/`autostart` 导出但恢复端可选择保留本机值。
- **Quick**：`agent_events` 20,000、通知 500、导航日志 500、剪贴板条目 2,000、粘贴任务 500；
  必须写 `partial=true`、`partial_reasons`、`truncated_tables` 与截断前计数；核心配置不截断。
- **Full**：不截断；25 表 + 图片/缩略图 + 归档 + 动作状态 + 设置；`partial=false`。
- **遗漏自动检测**：`backup_registry_covers_every_schema_table`（`backup.rs:2442`）枚举
  `sqlite_master` 的用户表，新迁移表未登记即测试失败。

### 7.2 恢复原子性

状态机：`PREPARING → VALIDATED → READY_TO_COMMIT → COMMITTING → COMPLETED`；失败进入
`ROLLBACK_REQUIRED → ROLLING_BACK → ROLLED_BACK`；不可恢复为 `FAILED_UNRECOVERED`，保留证据。

1. `PREPARING` 写 journal 与预备份（被替换前的完整备份，可验证恢复点）。
2. `read_bundle` 全量校验后进入暂存区；数据库导入在单事务中执行，提交前可整体回滚。
3. 数据库提交成功后写提交标记，再逐个提交资产/归档；文件提交幂等（已存在且哈希一致则跳过），
   支持崩溃续跑。
4. 任一步失败按“是否已提交数据库”决定回滚数据库与文件；失败不清空预备份。
5. 首次启动 `recover_pending` 读 journal：已完成则清标记；中断在可恢复点则续跑或回滚，
   不把半状态当成功。
6. 旧版备份缺少扩展模块时，保留当前剪贴板/工作现场/动作数据，不因旧包删除新模块。

**21 个恢复故障测试全部通过**（`restore.rs:1240`–`:1944`）：完整恢复、partial 需显式确认、
损坏包、导入前失败、事务中失败、**数据库已提交但归档提交失败**、归档复制中断、资产缺失、
资产哈希错误、权限拒绝、磁盘写入错误（注入）、Windows 文件锁、提交后崩溃、文件提交中断续跑、
首次启动清标记、旧包保留新模块、归档重名、恶意路径、预备份失败、旧 JSON 导入、data-only 不物化。
最重要的一例 `db_committed_but_archive_commit_fails_rolls_back_db_and_files`（`:1414`）验证
数据库回滚、旧任务重新可见、文件回滚、恢复点保留、随后可重试成功。

### 7.3 规模与真机

100k 夹具：100,000 事件、10,000 通知、5,000 剪贴板条目、500 个真实 PNG（250 原图+250 缩略图）、
100 工作现场/400 条目、100 动作状态、48 项设置、2 个真实归档（共 4.28MB）。

| 指标 | 优化前 | 优化后 | 最终源码复跑 |
|---|---:|---:|---:|
| 备份耗时 | 724ms | 631ms | **571ms** |
| 恢复耗时 | 7,696ms | 6,352ms | **5,019ms** |
| 恢复峰值工作集 | 686.2MB | 612.2MB | **619.0MB** |
| 备份读 SQL p95 / max | 615,877µs / 615,877µs | 144µs / 1,678µs | **96µs / 819µs** |
| 恢复读 SQL p95 / p99 | 142µs / 270µs | 140µs / 302µs | **81µs / 141µs** |
| 包大小 | 61,877,483B | 61,877,483B | 61,877,483B |

复核：25 张表行数全部一致；100,000/10,000/5,000/500/100/400/500 计数一致；外键 0 行；
`integrity_check=ok`；资产/归档 SHA-256 逐文件一致；`http_token` 未导出且目标本机值保留；
主题等设置恢复；Quick 兼容包保留新模块；恢复点存在且可解析。

真机 E9（应用停止时备份 → 隔离目录恢复）：

- Quick 实时：1.07s / 57.36MB，`partial=true`，导出 67,122 事件（20,000 + 全部受保护状态），
  通知 500；Full 实时：1.18s / 78.44MB，80,362 事件 / 36,015 通知；
- 全量恢复：14.28s，25 表一致，预备份创建，`integrity=ok`，`http_token` 不入包；
  Quick 恢复 4.8s，partial 标记保留；
- 篡改/截断/合法 JSON 篡改/哈希篡改：全部在写入前拒绝，数据计数不变；
- **NOT TESTED**：真实磁盘写满（恢复测试用注入 IO 错误模拟）；多 GB 包；恢复中断电。

**保留限制**：恢复读取仍把整包行集合物化到内存，62MB 包峰值 **619.0MB**，不是常量内存流式；
数 GB 包会继续增长。因此 P1-04 不能记为无条件 PASS。

## 8. P1-05 真机全链路验收

### 8.1 A：10 Agent × 50/s × 600s（500/s）

- 300,000 条提交 / 600.368s = **499.69 事件/秒**；30,000 条关键全部成功；0 个 429/503；
  45 次瞬时网络错误全部重试成功。
- 全部事件 p50 2.98 / p95 184.39 / p99 233.8 / max 7,291.14ms；关键 p50 183.85 / p95 766.56ms。
- DB 对账：30,000 关键存在、0 缺失、15,000 runs completed、0 重复 `dedupe_key`、
  `integrity_check=ok`。
- 产物：`http-A3-20261030-085817.json`、`db-A3-20261030-085817.json`、pre/post stats。

### 8.2 B：4 Agent × 50/s × 60s（200/s）

- 12,000 / 60.262s = **199.13 事件/秒**；1,200/1,200 关键；0 错误；p95 183.33ms。
- DB 对账：1,200 关键存在、0 缺失；`integrity_check=ok`。
- 产物：`http-B3-20261030-090949.json`、`db-B3-20261030-090949.json`。

### 8.3 C：真实安装 Agent（3 个以上）

- 扫描到 **7 个真实安装来源 + bridge**：codex、trae、workbuddy、qoder、opencode、
  deepseek-harness、zcode（`agents-C-20261030-091128.json`）；codex 当时有 2 个运行实例，
  workbuddy 有 6 个。
- 对 codex/trae/workbuddy 各直接调用官方事件 `SessionStart`/`UserPromptSubmit`/`PreToolUse`/
  `PermissionRequest`/`Stop`，共 **15 次 Hook CLI 调用全部 exit 0**；DB 中三个来源各写入 5 条
  对应事件（running/waiting/completed 状态可见；codex 库中另有压力测试事件，不计入这 5 条）。
- **但是**：这三个来源的 `configured=false`、`verified=false`、`health_state=no-events`，
  即没有把 Hook 正式写入 Agent 配置，也没有从真实 Agent 会话触发 Hook。因此 C 只能记为
  **“安装检测 + Hook 协议投递 PASS；实时会话接入 NOT VERIFIED”**，不能写成“3 个 Agent 已完整接入”。
- 未测量真实 Agent 会话启动延迟、Hook 对 Agent 交互的额外开销。

### 8.4 D：30 分钟整桌面 soak（最终 Release）

- 2026-10-30 10:13:15–10:43:16，359 样本 / 1,797.4s；应用 UI + 4 Agent × 5/s HTTP + 5s 采样。
- **采样间隔字段更正（P2-01）**：旧 `sampler.ps1` 的 `interval_s` 记的是**本轮采样耗时**而不是**相邻样本间隔**，旧报告里「平均间隔 2.544s」不成立。按时间戳重算的真实间隔为 min 4.104 / 中位 5.002 / 均值 5.014 / max 10.024 / p95 5.21s，与 359 样本 / 1,794.94s 跨度自洽（原始 jsonl 未改动；重算见 `docs/performance/results/sampler-recompute-D-soak-20261030.json`）。旧 CPU% 按 `tickStart` 差值计算，不受该缺陷影响。
- 客户端 36,000/36,000 成功、3,600/3,600 关键、27 次网络错误重试后全部成功、0 个 429/503；
  p95 268.63 / p99 284.68 / max 1,970.43ms；关键 p95 319.18 / p99 378.53ms。
- 服务端 accepted 36,000、received 36,005、processed 21,287、merged 14,718；
  队列峰值 **20/1,024**；0 overload / 0 commit failure / 0 unsaved / 0 spool；健康检查 359/359。
- DB 对账（`V05-SOAK-30MIN-DB-RECON-20261030.json`）：21,282 行 = 17,682 running + 1,800
  waiting + 1,800 completed；**3,600/3,600 关键事件恰好 1 行**；0 重复 `event_id`；
  外键 0 违规；`integrity_check=ok`。算术闭合：36,005 received − 5 重复 = 36,000 unique；
  32,400 running − 14,718 merged = 17,682 rows。
- CPU：应用平均 **0.339%**、峰值 **0.72%**；主进程平均 0.175%。
- **内存：不通过**。主进程 WS 39.5→124.0MB、private 11.4→95.1MB 持续上升，30 分钟无平台，
  停止负载 90s 后仍为 WS 124.1MB / private 95.2MB；WebView2 进程树 WS 394–440MB、
  private 219.0→246.5MB，有波动但增幅明显小于主进程；
  应用总 WS 433.5–531.9MB。根因未定位，不能记为“内存稳定/无泄漏”。
- 控制台窗口：中途与结束两次枚举 0 个可见 `tasklist`/`system32` 控制台；201 次子控制台工具
  采样 0 个可见窗口。
- 第一次运行（09:34:32 启动）26.3 分钟时因控制台闪窗调查被主动终止，只作中断记录，
  **不冒充 30 分钟通过**。
- 该 soak 实例由验收脚本结束进程，未产生自己的 shutdown 报告；正常退出证据只引用 E6/E7/E8。

### 8.5 E：故障注入矩阵

| 场景 | 实测 | 结论 |
|---|---|---|
| 重复 `event_id` | 21 个唯一 ID 各 1 行，0 重复；`integrity=ok` | PASS |
| 乱序/终态后迟到 running | run 最终 `waiting`，迟到 running 未回退状态；新轮次可重开 | PASS |
| HTTP 超时但服务端已提交 | 300 条普通事件全部 200；10 个 marker 中 8 个客户端 AbortError、2 个 200；DB 10/10 存在，0 重复 | PASS |
| 突发 3,300 条 | 3,300/3,300 HTTP 200，493 次重试，300/300 关键；0 丢失 | PASS |
| SQLite busy 12s | 1,224/1,224 HTTP 200；153 次提交失败由 144 个回退作业恢复；24/24 关键 + 10/10 marker；`integrity=ok` | PASS |
| 文件回退容量 | 5,050 预填拒绝普通；关键预留成功；5,260 关键也拒绝；0 删除 | PASS |
| 用户退出时并发投递 | 773 提交/464 关键；管线排空 81ms；14/14 排空；464/464 可对账；102 inbox 文件（自动化到进程消失 12.71s，含 PowerShell 开销） | PASS |
| 重启恢复 | 102 文件→0；464/464 关键恰好 1 行；0 重复 | PASS |
| 定时重启恢复 | 200 文件 55.67s 排空；200/200 入库；120/120 关键；0 重复 | PASS |
| 备份/恢复/篡改 | Quick/Full 往返；25 表一致；4 类篡改在写入前拒绝 | PASS |
| 真实磁盘写满 | 未在真实满盘卷执行；恢复仅注入 IO 错误 | **NOT TESTED** |
| 真实 `kill -9`/断电 | 未做物理断电；仅有 spool/journal 故障注入与进程重启 | **NOT TESTED** |
| 第三方应用矩阵/剪贴板图文混合 GUI | 环境阻塞，未执行 | **NOT TESTED** |

### 8.6 剪贴板 UI 与空闲常驻

- Release WebView2，1,700 条历史：打开抽屉 239.11ms；搜索稳定 367.4ms；详情含图 56.4ms；
  分组卡 7.8ms；连续开合 85–152ms；滚动 p95 17.2ms（395 帧，0 次 >50ms）；
  清理 p95 8.6ms（325 帧，0 次 >50ms）；后端 list80 p95 40.77ms、list200 p95 52.46ms、
  search p95 43.86ms。
- 旧验收中的 2,991ms/700–1,022ms 指标在本版本未复现；本次为优化后真实数据。
- 空闲/常驻（控制台修复前同提交 Release，7 个进程）：58 样本 / 1,803s；WS 589.28→556.65MB；
  private 378.67→401.5MB；线程 223→214；句柄 10,096→10,091；CPU 平均 0.294%、最大 0.607%。
- 产物：`docs/clipboard/evidence/perf-d-ui-release-20261030.json`、
  `perf-a-idle-30min-final-20261030.json`。

## 9. 性能前后对比

| 对比 | 之前 | 之后 | 说明 |
|---|---:|---:|---|
| 写库路径（5,000 事件） | 21,556ms（逐事件事务） | **1,065ms（批处理）** | **20.24×**；后端 harness，不含 UI |
| 100k 备份 | 724ms | **571ms** | 同一夹具、同一机器 |
| 100k 恢复 | 7,696ms | **5,019ms** | 同一夹具；峰值 686.2→619.0MB |
| 备份期间普通读 SQL max | 615,877µs | **819µs** | 读池 try-lock 跳过忙连接 |
| 剪贴板抽屉打开 | 2,991ms（旧验收） | **239.11ms** | 方法/版本不同，仅作方向参考 |
| 剪贴板搜索稳定 | 700–1,022ms（旧验收） | **367.4ms** | 同上 |
| 控制台闪窗 | 每轮扫描可见控制台 | **0 个可见窗口** | 201 次采样 |
| 30 分钟吞吐（参考） | 后端 harness 20/s | **真机 20/s 持续 30 分钟** | 36,000/36,000；前后口径不同，不作严格 A/B |

**不能声称的对比**：

- **v0.4 真机对照 NOT TESTED**：只有 v0.5 内部“旧逐事件事务 vs 新批处理”的后端基线 20.24×，
  没有同机、同场景的 v0.4 安装版负载数据；因此不作“v0.4→v0.5 真机提升 N 倍”的结论。
- **CPU 前后对比 NOT TESTED**：没有 v0.4 同口径每进程 CPU 秒/墙钟数据，只有 v0.5 的
  0.339% 平均/0.72% 峰值。
- 剪贴板旧数据来自旧验收记录，采集方法/版本不同，只能作为方向性参考，不作为严格 A/B。

## 10. 自动化测试结果

### 10.1 前端

- `npm test`：**133/133 通过**（21 个测试文件）。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过（Vite 7.3.7，1,636 模块）。

### 10.2 Rust

- `cargo fmt --all -- --check`：通过。
- `cargo check --all-targets`：通过。
- `cargo clippy --all-targets -- -D warnings`：通过。
- `cargo test --all-targets`：
  - **2026-10-30 09:44（控制台修复前，交互桌面）**：**382 通过 / 0 失败 / 13 忽略**
    （381 lib + 1 集成）。
  - **2026-10-30 10:0x（控制台修复后）**：lib **380 通过 / 2 失败 / 3 忽略**；2 例为
    `notepad_launch_focuses_existing_window_of_owned_process`、
    `launch_disallowed_reports_failure_or_focus_only`，失败原因是 Windows 前台锁拒绝置前
    （“Windows 前台锁定拒绝了切换”），与本轮改动无关；**未修改断言、未跳过**。lib 失败后
    cargo 中止，集成测试另行执行 **1 通过 / 10 忽略**；合并 **381 通过 / 2 失败 / 13 忽略**。
  - 13 个忽略项全部为需手动运行的性能/规模场景：万级文件 IO、100k 备份、工作现场延迟、
    动作/剪贴板压测（3 个）、5 个 HTTP 压测场景、真实备份导入工具。
- 专项测试：恢复故障注入 **21 例全部通过**；管线退出/排空 **17 例通过** + spool 单元测试 **6 例通过**；
  `tests/inbox_processes.rs` **50 并发 Hook 进程 1 例通过**；
  `winproc::tests::hidden_command_still_runs_and_captures_output` 通过。
- 官方 Release 构建：通过；NSIS **4.17 MiB**、MSI **6.37 MiB**（控制台修复后重建）。

### 10.3 证据文件

- `V05-GATES-CARGO-TEST-20261030.log`（382/0/13）
- `V05-GATES-CARGO-TEST-FINAL-20261030.log`（380/2/3 + 1/10，含失败详情）
- `V05-RELEASE-BUILD-FINAL-20261030.log`
- `V05-SCALE-100K-FINAL-20261030.json/.log`（最终源码复跑）
- `V05-SCALE-100K-20261030.*`、`V05-SCALE-100K-PREOPT-20261030.*`
- `V05-SOAK-30MIN-20261030.json`、`V05-SOAK-30MIN-DB-RECON-20261030.json`
- `D-soak-20261030-101315.jsonl`、`http-soak-20261030-101315.json/.log`
- `D-soak-20261030-093432.jsonl`（控制台修复前中断记录）
- `E2-*`、`E3-burst-*`、`E4-sqlite-busy-*`、`E5-file-fallback-*`、`E6-*`、`E7-*`、`E8-*`、`E9-*`

## 11. 未通过 / 未测试 / 环境阻塞

1. **30 分钟主进程内存稳定性：NOT PROVEN**。WS 39.5→124.0MB、private 11.4→95.1MB 持续增长，
   30 分钟无平台，停止负载 90s 后仍 124.1/95.2MB；根因未定位（分配器保留/事件管线/其他未区分），
   不能记为“无泄漏”。
2. **恢复不是常量内存流式**：62MB 包峰值 619.0MB；多 GB 包未验证。
3. **真实磁盘写满：NOT TESTED**。E5 只验证文件队列配额；恢复的“磁盘满”用注入 IO 错误模拟，
   未在真实满盘卷执行。
4. **真实断电/`kill -9`：NOT TESTED**。spool/journal/故障标记只证明可恢复路径，未做物理断电。
5. **C 场景实时 Agent 会话：NOT VERIFIED**。7 个真实安装来源被检测到，codex/trae/workbuddy
   的 Hook CLI 协议投递 15/15 成功；但 `configured=false`、`verified=false`，没有真实会话触发。
6. **剪贴板图文混合粘贴 GUI：NOT TESTED**（需要真实聊天应用与键盘注入，环境阻塞）。
7. **第三方应用矩阵**（微信、Agent 类宿主）：NOT VERIFIED。
8. **v0.4 真机对照：NOT TESTED**（只有后端“旧事务 vs 批处理”基线）。
9. **前台锁 2 例导航测试**：最终门禁中被 Windows 拒绝置前（环境性，断言未改；
   09:44 交互会话曾 382/0/13 通过）。
10. **soak 实例自身的 shutdown 报告缺失**：该实例由脚本结束进程，`last-shutdown-report.json`
    仍是 09:30 旧文件；正常退出只引用 E6/E7/E8，不混用。
11. **真机跨通道顺序注入**：HTTP+文件同 run 的顺序由单元测试覆盖，未单独做真机注入。
12. **UI 压测自动化**：剪贴板 UI 数值来自真实 WebView2 手动脚本，未接入持续 CI。

## 12. 可靠性边界

- **一致性与恢复点**：全量备份在单个 SQLite 读事务中读取行；资产/归档为文件快照，缺失即失败。
  恢复前必有预备份；回滚保留证据。
- **RPO**：已提交事务 + 已 fsync 的 spool 可恢复；强杀/断电时内存中未持久化事件可能丢失；
  spool 写失败时报告 `unsaved_events`，不承诺零丢失。
- **RTO**：62MB 包恢复 5.02s（本机，最终源码复跑）；随数据量近似线性增长，不承诺固定时限。
- **并发**：备份期间普通读不再被长快照阻塞（try-lock 跳过忙连接）；3 个读连接全部被占用时仍会等待。
- **兼容性**：旧版备份缺少扩展模块时按“保留现有剪贴板/工作现场/动作数据”导入；不支持的表会被
  拒绝；`http_token` 永不跨机导出。
- **安全**：日志不输出剪贴板正文、令牌或密钥；备份包不含 `http_token` 与恢复内部标记；
  恶意资产路径/归档名/未注册表被拒绝。
- **Quick 包**：明确 `partial=true`，不能被当作完整恢复；恢复端默认拒绝 partial，需显式
  `allow_partial`。
- **平台**：Windows 文件锁、权限拒绝、同名归档均有回滚/重试路径；不支持跨平台包。
- **文件队列**：不覆盖/不删除他人文件；满容量显式拒绝；关键预留耗尽也明确失败，不伪造成功。

## 13. 最终判定

**CONDITIONAL PASS（有条件通过）**。

### 满足项

- **P0-01**：受理序号 + 跨队列稳定排序 + 关键状态屏障 + 终态保护已落地；9 个顺序/屏障测试
  + 4 例终态保护通过；A3 30,000/30,000 关键在 DB、0 缺失、0 dedupe 重复；soak 3,600/3,600
  关键恰好各 1 行。
- **P0-02**：QUIESCING→DRAINING→STOPPED、全部批次排空、超时如实报告、spool 原子写/幂等重放
  已落地；17 个管线退出/排空测试 + 6 个 spool 单元测试通过；E6 管线排空 81ms、14/14 排空、
  464/464 可对账；E7/E8 重启 102/200 文件全部入库、0 重复。
- **P1-03**：5,000/256MiB 总配额、250/16MiB 关键预留、原子写、失败隔离、自适应扫描已落地；
  12 个 inbox 测试 + 50 并发 Hook 进程测试通过；E5 真实预填 5,050/5,260 行为符合预期且 0 删除。
- **P1-04**：25 表注册表、Quick/Full 语义、资产/归档/设置/动作覆盖、遗漏自动检测、恢复
  状态机/journal/预备份/回滚已落地；21 个恢复故障测试通过；100k 往返 25 表一致；
  真机 78.44MB 全量恢复 14.28s、4 类篡改在写入前拒绝。
- **P1-05-A/B**：真机 499.69/s × 600s、199.13/s × 60s，关键事件 30,000/30,000、1,200/1,200，
  0 拒绝；队列有界。
- **P1-05-D**：30 分钟整桌面完成，36,000/36,000 成功、3,600/3,600 关键、0 丢弃、队列峰值
  20/1,024、DB 21,282 行与客户端/服务端计数闭合。
- **P1-05-E**：重复、乱序、超时、突发、SQLite busy、文件回退、退出、重启、备份恢复均实测；
  未测项已标 NOT TESTED。
- 额外修复真机发现的控制台闪窗，重建 Release 后 201 次采样 0 个可见控制台窗口。

### 保留条件（因此不是 PASS）

1. 30 分钟负载下主进程 WS 39.5→124.0MB、private 11.4→95.1MB 持续增长，30 分钟无平台，
   停止负载 90s 后仍 124.1/95.2MB；根因未定位，不能声称内存稳定。
2. 恢复读取仍非常量内存，62MB 包峰值 619.0MB；多 GB 包未验证。
3. 真实磁盘写满、真实断电/`kill -9` 未执行；只有注入错误/进程重启模拟。
4. C 场景未验证实时 Agent 会话；只验证了安装检测与 Hook CLI 协议投递（`configured=false`、
   `verified=false`）。
5. 剪贴板图文混合 GUI、第三方应用矩阵、v0.4 真机对照未执行。
6. 前台锁 2 例导航测试在最终门禁中环境性失败（断言未改，09:44 交互会话曾通过）。

在上述条件解决前，不将本版本标记为无条件 PASS；也不把任一未测项写成 PASS。
