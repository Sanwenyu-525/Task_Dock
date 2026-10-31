# 测试结果与未解决问题

> 测试日期：2026-10-29（基线）· 2026-10-30（最终复核）· 2026-10-31（v0.7 圆角整改复测）· 环境：Windows 11 · Node 24.18.0 · Rust 1.95.0 (MSVC)
> 原则：**不以模拟测试冒充真实接入**；所有未验证项明确列出。
> **2026-10-31 更正**：v0.6 节中「四角黑色直角已消除（diff = 0.0）」的原生验收结论
> **已被真机截图证伪并撤回**。`GetWindowRgn` 成功不能证明像素正确，旧判定缺少独立背景基线，
> 且未发现 Win11 Mica/Acrylic 系统背景忽略窗口区域。现行方法与证据见
> [ui-themes/12-v06-window-corners.md](ui-themes/12-v06-window-corners.md)。
> v0.5 智能剪贴板的最终门禁、性能与阻塞项见
> [clipboard/08-testing-performance.md](clipboard/08-testing-performance.md)、
> [clipboard/09-implementation-report.md](clipboard/09-implementation-report.md)、
> [clipboard/10-remediation-acceptance.md](clipboard/10-remediation-acceptance.md) 与
> [clipboard/11-final-release-acceptance.md](clipboard/11-final-release-acceptance.md)。

## 一、自动化测试结果

### 0.0.4 吸附胶囊真实显示异常修复（区域提交协议/顶底几何/自愈宽限窗，2026-10-31）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误（并行任务的 cdpMainWindow.test.ts 曾短暂阻塞 build，其会话已自行修复） |
| `npx vitest run` | **45 文件 / 431 测试通过**（集成测试新增：裁剪返回 false / IPC 抛异常 → 拒绝隐藏并回滚、坐标滞后下的提交顺序断言、迟到响应按最新期望重同步） |
| `npm run build` | 通过 |
| `cargo test`（src-tauri） | **489 passed / 0 failed**（新增：四边最终矩形断言、DPI 契约、窗口钳制、自愈宽限窗、**真实 HWND SetWindowRgn→GetWindowRgn 回读**） |
| `cargo clippy --all-targets` | 0 warning |
| 真机截图复摄 / 50 次循环 / 点击穿透 | ⬜ **未执行**：`tmp/acceptance/edge-snap-real-capsule-fix/manual-checklist.md` |

### 0.0.3 贴边吸附系统性修复（胶囊区域/接缝降级/唤回/持久化串行，2026-10-31）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过（0 错误） |
| `npx vitest run` | **44 文件 / 406 测试通过**（新增：引擎集成测试 9 例——Mock Tauri Window API + 可控时钟驱动完整状态序列：吸附→隐藏→展开→再隐藏、重启恢复、snap-recall 唤回、关闭吸附安全展开、隐藏中 resize、setPosition 失败重试、接缝降级与邻屏断连恢复；纯函数新增多屏接缝判定与胶囊区段唤出） |
| `npm run build` | 通过 |
| `cargo test`（src-tauri） | **486 passed / 0 failed**（新增：胶囊区域几何 DPI 契约 4 组、snap_state/edge 校验沿用） |
| `cargo clippy --all-targets` | 0 warning |
| 真机（50 次循环/四边/多屏/DPI 矩阵） | ⬜ **未执行**：清单见 `tmp/acceptance/edge-snap-system-remediation/manual-checklist.md` |

### 0.0.2 Smart Dock Capsule（贴边吸附磁吸与状态胶囊专项，2026-10-31）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过（0 错误） |
| `npx vitest run` | **43 文件 / 384 测试通过**（含新增：磁吸滞回/驻留/保护期/离开确认/坐标静默期、胶囊几何 DPI 换算、胶囊信息聚合与异常优先级、胶囊组件渲染与可访问性） |
| `npm run build` | 通过 |
| `cargo test`（src-tauri） | **481 passed / 0 failed**（本专项未改 Rust；运行确认无回归） |
| 悬停防抖 | 自动化覆盖纯判定函数（驻留/保护期/离开确认/静默期/滞回）；**真实窗口悬停 10s 无往复循环为真机验证项**，见 `tmp/acceptance/edge-snap-smart-capsule/manual-checklist.md` |
| 真机 50 次吸附-隐藏-展开循环 | ⬜ **未执行**（需真实桌面交互），清单与记录表见 `tmp/acceptance/edge-snap-smart-capsule/manual-checklist.md` |

### 0.0.1 v0.6 全局 UI/UX 交互精修与剪贴板侧边栏整合（2026-10-30；测试计数于 2026-10-31 复测）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过（0 错误） |
| `npx vitest run` | **40 文件 / 290 测试通过**（2026-10-31 复测；v0.6 时为 37 文件 / 264 项） |
| `cargo test --release` | **472 passed / 3 failed / 3 ignored**（2026-10-31 复测；3 例失败为锁屏会话下 `navigation::router` 前台置前用例，`ENVIRONMENT-BLOCKED`，见 [ui-themes/11-test-results.md](ui-themes/11-test-results.md) 1.2） |
| `npm run build` | 通过（JS 535.40 kB / gzip 163.28 kB；CSS 114.91 kB / gzip 19.52 kB） |
| `npm run tauri build -- --no-bundle` | 通过（Release 可执行文件产出；注意必须用该命令，裸 `cargo build --release` 会漏 `custom-protocol` 特性导致启动即退出） |
| `node scripts/visual-v06.mjs` | **26 场景全部通过**：0 横向溢出、0 元素越界、0 导航项裁剪、0 运行期错误 |
| `node scripts/visual-themes.mjs` | 18 场景全部通过：0 横向溢出、关键元素无越界、0 运行期错误 |
| `node scripts/layout-regression.mjs` | **37 组合全部达标**：六个侧边栏入口全部可达、快速添加按钮未被遮挡、无横向溢出、0 运行期错误 |
| 原生窗口取证（旧：`native-verify.ps1` + `check-corners.py`） | ❌ **结论已撤回**：旧方法只用 `region_probe` + 同帧自比，无法发现黑角；真机受控背景复测为 FAIL（glass 每角 44–45 暗像素、solid 半径 31.75 ≠ 22）。现行方法：`corner-lab.ps1` + `check-corners.py`（独立背景基线 + 四角像素 + `GetWindowRgn` 联合判定，缺基线返回 UNVERIFIED） |
| 修复后原生窗口验收 | ⬜ **UNVERIFIED**：本机会话锁定（LogonUI 运行），无法进行真实窗口取证；见 [ui-themes/12-v06-window-corners.md](ui-themes/12-v06-window-corners.md) |
| 未验证 | Windows 10 真机、100%/150% DPI、Dev 模式、拖动/贴边/托盘交互回归、长时间常驻资源曲线 |

关键回归点（详见 [ui-themes/11-test-results.md](ui-themes/11-test-results.md)）：

- **Escape 优先级**：确认框 > 子弹层 > 菜单 > 抽屉 > 主窗口，一次按键只关一层。
- **剪贴板侧边栏化**：六个导航入口；页面与关联抽屉共用 `ClipboardWorkspace`，
  底层只有一条 `onClipboardChanged` 监听（引用计数断言通过）。
- **日期时间数据完整性**：仅打开浮层不改值、不截断秒、截止与提醒互相独立。
- **快捷键**：Ctrl+1…6 顺序取自 `TAB_ORDER` 单一事实源；完整模式 Ctrl+Shift+C 切页，
  紧凑/极简模式开关临时抽屉。

### 0.0.2 剪贴板第四轮专项整改（2026-10-30 22:00→，隐私事务安全 / 图文粘贴 / 内存稳定性）

> 完整报告见 [clipboard/12-fourth-round-acceptance.md](clipboard/12-fourth-round-acceptance.md)。
> 本节只列可复现的结论与原始证据路径；**未执行的验收不写成通过**。

| 检查 | 结果 |
|---|---|
| `cargo fmt --all -- --check` | 通过（无差异，22:21:18→22:21:20，exit 0） |
| `cargo clippy --all-targets --all-features` | 通过，0 警告（22:21:20→22:22:48，exit 0） |
| `cargo test --all-targets --no-fail-fast` | lib **449 passed / 0 failed / 3 ignored**；全部测试二进制合计 450 passed / 0 failed / 19 ignored（22:22:48→22:25:39，exit 0） |
| `cargo test --lib clipboard::` | **89 passed / 0 failed / 0 ignored**（22:25:39→22:25:42，exit 0） |
| `npx tsc --noEmit` | 通过（22:25:42→22:25:48，exit 0） |
| `npx vitest run` | **36 文件 / 260 测试通过**（22:25:48→22:26:35，exit 0） |
| `npm run build` | 通过（22:26:35→22:26:46，exit 0） |
| `cargo test --release --test clipboard_perf -- --ignored --nocapture` | **2 passed / 0 failed**（22:26:46→22:32:18，exit 0） |
| Release 构建（`npx tauri build --no-bundle`，`CARGO_TARGET_DIR=src-tauri/target-accept`） | 退出码 0，`task-dock.exe` 15,603,200 B，时间 23:42:45 |
| P2-06 前台焦点测试（`cargo test --lib navigation::router`） | **10 passed / 0 failed / 0 ignored**（真实交互桌面，断言未改、未跳过） |
| P1-03 真实图文混合粘贴（像素级） | **52 PASS / 0 FAIL / 0 BLOCKED**，overall = PASS；目标端三图 `alphaMin=alphaMax=255`、`transparentPixels=0`、RGB 精确匹配 |
| 采集事件计数器对账 | `observed 10 = captured 5 + self_write 5`，`superseded 0` / `empty 0` / `dropped 0` / `merged 0` / `skipped 0` / `duplicates 0` / `failed 0` |

第四轮新增回归测试：

| 位置 | 用例 | 验证点 |
|---|---|---|
| `src-tauri/src/clipboard/platform.rs` | `event_disposition_separates_read_superseded_and_self_write` | 事件三态归因（读取/覆盖/自写）、读取水位去重、`u32` 序列号回绕 |
| `src-tauri/src/db/mod.rs` | `clipboard_repair_fault_after_writes_rolls_back` / `clipboard_repair_database_write_failure_rolls_back_backup` / `clipboard_repair_process_death_rolls_back_on_reopen` / `clipboard_repair_blocks_monitor_until_commit_with_resume` | 修复事务性：故障注入后不留半修复状态、备份回滚、进程中途死亡后重开仍回滚、提交前监控被门控 |
| `src-tauri/src/db/mod.rs` | `clipboard_fresh_install_seeds_defaults_and_marks_origin` / `clipboard_missing_config_never_reenables_across_restarts` / `clipboard_partial_missing_is_not_filled_on_restart` / `clipboard_user_disabled_survives_key_loss_and_repair_only` / `clipboard_repair_missing_switch_is_conservative` | 缺失键策略：全新安装标记来源、缺键跨重启不自动开启、缺键不被静默补齐、用户关闭在键丢失与「仅修复」后仍保持关闭、缺失开关按保守值处理 |

原始输出：`docs/clipboard/evidence/gate-*-20261030-2221.log`、
`gates-fourth-round-20261030-2221.md`、`p2-06-focus-tests-fourth-round-20261030.log`、
`p1-03-mixed-paste-20261030-235050-76869ab9.json`、
`release-build-fourth-round-20261030-2305.log`。

### 0.0 v0.6 双视觉主题汇总（2026-10-30）

> 本节记录的是 v0.6 **双视觉主题**子版本当时的验收数据（已被后续的 UI 交互精修取代）；
> 当前最新数据见上方 [0.0.1](#001-v06-全局-uiux-交互精修与剪贴板侧边栏整合2026-10-30) 一节。

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过（0 错误） |
| `npx vitest run` | **23 文件 / 166 测试通过**（v0.5 的 21 文件 / 133 项 + 新增 theme / useSettingsStore / FullView 三个文件共 13 项） |
| `cargo test --release` | 通过（lib + 集成；真机验收工具按惯例 ignored） |
| `npm run build` | 通过（478.09 kB JS / 94.72 kB CSS） |
| `npm run tauri build -- --no-bundle` | 通过（Release 可执行文件产出；注意必须用该命令，裸 `cargo build --release` 会漏 `custom-protocol` 特性导致启动即退出） |
| `node scripts/visual-themes.mjs` | 18 场景全部通过：0 横向溢出、关键元素无越界、0 运行期错误 |
| `node scripts/theme-perf.mjs` | 空闲 3 s 主线程 6.4–8.9 ms、布局 0 次、`backdrop-filter` 0 个、常驻动画 1 个、主题切换 20 次 29–63 ms |
| 原生窗口取证（`scripts/native-verify.ps1` + `scripts/check-corners.py`） | ❌ **原结论已撤回**：旧采集的 `region_probe=00001` / `diff = 0.0` 不能证明圆角正确；受控背景复测为 FAIL，修复后验收因会话锁定 UNVERIFIED。见 [12 文档](ui-themes/12-v06-window-corners.md) |
| 未验证 | Windows 10 真机、100%/150% DPI、Dev 模式、拖动/贴边/托盘交互回归、长时间常驻资源曲线 |

详见 [视觉主题专项文档](ui-themes/05-test-plan.md) 与
[视觉验收](ui-themes/07-visual-acceptance.md)。

### 0.0.3 复验轮：真实 Agent 自动接入 / 异常退出与故障注入 / 内存归因（2026-10-30 23:00→）

> 完整结论见 [PERFORMANCE_FINAL_ACCEPTANCE.md](PERFORMANCE_FINAL_ACCEPTANCE.md) §14；
> 方法学见 [PERFORMANCE_TESTING.md](PERFORMANCE_TESTING.md) §10。
> **每条结论绑定被测二进制 sha256，不与历史数据混用。**

| 验收项 | 结果 | 证据 |
|---|---|---|
| 真实 Agent 自动接入（≥3） | **PASS** — codex 0→3 事件、DeepSeek Harness 0→2、OpenCode 0→3，均为 Agent **自身会话**自动产生，状态 running→completed；三者 `verified=1` / `transport_verified=1` | `performance/results/AGENT-agent-integration-20261030-233909.json` |
| Hook 非阻塞 | 40 次调用 p50 38ms / p95 74ms / p99 91ms / max 91ms，0 错误；残留 Hook 进程 0 | 同上 |
| 状态更新延迟 | codex p50 159.0ms、DSH p50 267.9ms、OpenCode p50 318.7ms | 同上 |
| 多 Agent 隔离 | 三个 Agent 会话 ID / 来源 / 通道互相独立，事件互不串台 | 同上 |
| 用户配置不被破坏 | 卸载后第三方 dependency/bundle 全部保留（`third_party_kept=true`）；全程未写入真实用户 Agent 配置目录 | 同上 |
| DSH 适配器修复 | 此前是「功能空操作」（插件写在 `~/.dsh/plugins/`，宿主不加载）→ 改为真正的 **profile bundle** 安装；新增 6 个单元测试；迁移 v14 修正来源说明 | `src-tauri/src/agents/dsh.rs`、`src-tauri/src/db/mod.rs` |
| 异常退出（真实 `taskkill /F`） | **PASS** — 投递 175 条/接受 174；强杀前已提交 168 条，重启后仍 168 条；0 重复 `event_id`；`integrity_check=ok` | `performance/results/FAULT-fault-injection-20261030-235312.json` |
| 写库失败落盘暂存 + 损坏暂存隔离 + 幂等重放 | **PASS** — 6 次写入全部 HTTP 500 且 `retryable=true`；生成 6 个 spool；重启后损坏文件隔离到 `corrupt/`，5 个完整文件重放 5/5、0 重复 | 同上 |
| 恢复中断强杀 | **PASS** — `journal_state=committing` 时强杀，重启后 journal 正确判定并清理；60,000 行前后一致 | 同上 |
| 恢复期间文件被独占锁 | **PASS** — 恢复整体失败（rc=1，`disk I/O error`），事件数不变，未留 journal，`integrity_check=ok` | 同上 |
| HTTP + 文件同事件幂等 | **PASS** — 同一 `event_id` DB 中恰好 1 行 | 同上 |
| 卷级磁盘写满 | **NOT TESTED** — `fltmc` 探测 `0x80070005`（会话未提升）；按隔离要求不对真实卷写满；等价场景 E1/E2 与 2 个 Rust 回滚测试已覆盖 | 同上 |
| 内存 A–F 归因 | **进行中** — 插桩（Rust 堆 live/peak、Tokio 存活任务、SQLite WAL/页数、线程/句柄、系统 Committed）已就位 | `performance/results/DIAG-[A-F]-*.jsonl` |

**如实披露的数据可靠性边界**：F1/F2 中 174 条被接受、168 条已提交，**差额 6 条随强杀丢失**
（尚未落库、只在内存里的事件）。任务书明确不允许为未持久化的内存事件承诺断电零丢失，
此处如实记录，不粉饰。

**过程中修正的两处验收脚本自身缺陷**（不影响产品结论，但会让结论不可信，必须保留修复）：
`db_query()` 缺参数位导致 F3 抛 `TypeError`；场景异常导致隔离实例残留、其**免鉴权**的
`/api/v1/health` 替后续场景应答造成静默串台（曾让 F3/F6 在不同轮次给出相反结论）。
修复：实例启动后额外用带 token 的 `/api/v1/stats` 确认应答者身份；场景之间与 `finally`
强制回收实例；运行前检查端口占用。

### 0.0.4 第五轮：五臂长跑与门禁复跑（2026-10-30 23:53 → 10-31 09:44）

> 被测 release 二进制：15,603,200 B，`sha256=fb5e0eef708ff3e7193e5094f703d81f35ebbf422e6445fed61efdb718e27378`
> （2026-10-30 23:50 由 `cargo build --bins --features tauri/custom-protocol --release` 构建，
> **MSVC 工具链**，产物含 `task_dock.pdb`）。每条结论绑定该二进制，不与历史采样混用。
> 方法学见 [PERFORMANCE_TESTING.md](PERFORMANCE_TESTING.md) §10.5，完整结论见
> [V05_FINAL_ACCEPTANCE.md](V05_FINAL_ACCEPTANCE.md) §5.5。

**五臂内存链**（20 事件/秒，隔离数据目录，`task-dock-acc9.exe` 改名副本）：

| 臂 | 样本 | Private 首→末 | 关键结果 | 自退 |
|---|---|---|---|---|
| N1 负载 + 通知开（480 s + 90 s） | 97 | 41.3→49.1 MB | 9,616 事件 / 0 丢弃；通知 45/45 | 无 |
| N2 负载 + 通知关（480 s + 90 s） | 59 | 9.0→13.6 MB | 9,604 事件 / 0 丢弃 | 无 |
| N3 空闲（480 s + 90 s） | 51 | 8.3→8.2 MB | 基线平 | 无 |
| C UI+HTTP 30 min（+120 s） | 188 | 9.1→17.8 MB | 36,070 收 / 15,665 提交 / 20,405 合并 / **0 丢弃**；分段斜率 +0.218 → +0.066 → **0.000 MB/min**（末 116 s 恒定） | 无 |
| E 10 min 负载 + 30 min 空闲 | 255 | 11.9→18.9→19.3 MB | 11,914 事件；通知 55/55；负载 +0.542、空闲 +0.0028 → −0.0275 MB/min | 无 |

**归因**：通知路径 N1−N2 = **+3.2 MB / 10 min（45 条 → ≈72.8 KB/条）**；接入路径 N2−N3 =
**+4.7 MB / 10 min（≈9,600 事件 → ≈0.49 KB/事件）**；基线 −0.1 MB。N1 的 `live_bytes` 仅 +0.038 MB
（`private_minus_live = 7.76 MB`）⇒ **不是 Rust 堆泄漏**，是分配器保留 / 原生内存（SQLite 页缓存与 WAL、
COM/GDI、线程栈）。通知开启本身带 ≈30 MB / 9 线程 / ≈300 句柄的 WinRT toast + COM 固定开销。
结论只能表述为「**未观察到泄漏型增长**、负载段出现平台期、空闲段不增长」，不能表述为「已证明无泄漏」。

证据：`docs/performance/results/` 下 `DIAG-{N1,N2,N3,C,E}-*.jsonl`、`MEM-CHAIN-v05r5-20261030-2353.log`、
`MEM-ATTRIBUTION-v05r5.json`（单文档 UTF-8）、`WINDOWS-{C,E}-*.json`（分段窗口与斜率）。

**门禁复跑**（前两次失败原样保留）：

| 轮次 | 时间 | 检查 | 结果 | Exit | 日志（`clipboard/evidence/`） |
|---|---|---|---|---|---|
| 1 | 09:07→09:15 | test-all / perf-clipboard | **失败**：`--manifest-path` 从仓库根调用绕过 `src-tauri/rust-toolchain.toml` → GNU ld `export ordinal too large`（装置缺陷 #16） | 101 | `gate-test-all-20261031-0907.log`、`gate-perf-clipboard-20261031-0907.log` |
| 2 | 09:21→09:28 | test-all / perf-clipboard | **失败**：D: 盘写满（0.03 GB），`LNK1201` / `os error 112`（装置缺陷 #18） | 101 | `gate-test-all-20261031-0921.log`、`gate-perf-clipboard-20261031-0921.log` |
| 3 | 09:29→09:33 | `cargo test --all --no-fail-fast` | lib **472 passed / 3 failed / 3 ignored**；其余目标通过（`inbox_processes` 1 passed） | 101 | `gate-test-all-20261031-0929.log` |
| 3 | 09:43→09:44 | `cargo test --lib -- --skip <3 个前台聚焦用例>` | **474 passed / 0 failed / 3 ignored / 3 filtered out** | 0 | `gate-test-all-filtered-20261031-0943.log` |
| 3 | 09:33→09:41 | `cargo test --release --test clipboard_perf -- --ignored --nocapture` | **2 passed / 0 failed**（34.82 s） | 0 | `gate-perf-clipboard-20261031-0929.log` |

3 个失败用例全部是 `navigation::router` 前台聚焦测试，报错 `foreground-denied`（当时桌面前台是
Geek Uninstaller 窗口，Windows 前台锁不允许后台进程抢占）→ **ENVIRONMENT-BLOCKED**。
同一组用例在第四轮安静桌面上逐条通过（`p2-06-focus-tests-fourth-round-20261030.log`，23:34/23:35）；
本轮未改断言、未删用例、未加 `#[ignore]`。工具链与指纹见 `gate-rerun-fingerprint-20261031-0929.txt`
（MSVC 覆盖生效；开始 152 files/+6,088 → 结束 159 files/+6,479，并行会话仍在编辑，计数不作稳定值）。

**收口复跑（09:46 → 10:24，补齐前端与 release）**：

| 轮次 | 时间 | 检查 | 结果 | Exit | 日志 |
|---|---|---|---|---|---|
| 4 | 09:46→10:01 | fmt / clippy | **失败**：fmt 16 处差异；clippy `needless_borrow`（`src/lib.rs:275`）。均为本次整改新增代码引入，已修复 | 1 / 101 | `gate-final-fmt-20261031-0946.log`、`gate-final-clippy-20261031-0946.log` |
| 4 | 09:51→09:53 | tsc / vitest / `npm run build` | 全通过 | 0 | `gate-final-tsc/vitest/npm-build-20261031-0946.log` |
| 5 | 10:04→10:14 | fmt / clippy | **0 / 0**（修复后重跑） | 0 | `gate-final2-fmt/clippy-20261031-1004.log` |
| 5 | 10:05→10:08 | `cargo test --all --no-fail-fast` | lib **474 passed / 3 failed / 3 ignored**（2 前台锁 + 1 偶发并发，见下） | 101 | `gate-final2-test-all-20261031-1004.log` |
| 5 | 10:07→10:08 | `cargo test --lib -- --skip <3 个前台用例>` | **474 passed / 0 failed / 3 ignored / 3 filtered out** | 0 | `gate-final2-test-filtered-20261031-1004.log` |
| 5 | 10:08→10:14 | release 构建（cwd=`src-tauri`，MSVC） | **成功**：15,799,296 B，`sha256=4fddaa06…`，6m10s | 0 | `gate-final2-release-20261031-1004.log` |
| 6 | 10:19→10:20 | fmt / clippy / test-all / perf | fmt 0；其余 **101**：并行会话 v0.6 编辑使工作区不可编译（`window_shape.rs` 等 11 处错误）→ **无效快照** | — | `gate-final3-*-20261031-1019.log` |

`agents::inbox::tests::concurrent_writers_never_exceed_capacity` 在 10:05 失败一次（`实际 11 > 上限 10`）。
随后单测连跑 20 次、整 lib 套件连跑 5 次均 **477 passed / 0 failed / 3 ignored**（10:16–10:18 终端输出，
未落日志文件）；用独占打开 `hook-a.json` 的探针验证 `measure()` 未漏数 → 机制未复现。
未删除用例、未放宽断言，按「负载相关偶发」列入遗留风险（`V05_FINAL_ACCEPTANCE.md` §3.5/§八）。

**补充快照（10:28→10:33，并行会话 v0.6 编辑后、非 v0.5 验收依据）**：
`cargo test --all --no-fail-fast` → **exit 0，lib 480 passed / 0 failed / 3 ignored**（`inbox_processes` 1 passed），
10:05 失败的 3 例全部通过；同轮 `fmt`/`clippy` 的失败点只在并行会话的 `context_menu.rs`、`window_shape.rs`。
日志：`gate-final4-{fmt,clippy,test-all,summary}-20261031-1028.*`。

### 0. v0.5 汇总（2026-10-30 最终复核）

| 检查 | 结果 |
|---|---|
| `cargo fmt --check` | 通过（无差异） |
| `cargo clippy --all-targets --all-features` | 通过，0 警告（16.17 s） |
| `cargo test --all-targets` | **2026-10-30 09:44 交互复跑：382 passed / 0 failed / 13 ignored**（lib 381 + inbox 进程测试 1）；**控制台闪窗修复后 10:0x 复跑：lib 380 passed / 2 failed / 3 ignored，lib 失败后 cargo 中止，集成另行执行 1 passed / 10 ignored，合并 381 passed / 2 failed / 13 ignored**（2 例为 `navigation::router` 前台聚焦测试被 Windows 前台锁拒绝，环境性失败，断言未改）；更早 01:26 锁屏会话 302 passed / 2 failed / 11 ignored。三次结果都保留，见 §4 |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run` | 21 文件 / 133 测试通过（55.44 s） |
| `npm run build` | 通过（467.06 kB JS / 68.51 kB CSS；gzip 139.65 / 10.96 kB） |
| `npm run tauri build`（release） | 通过，release 编译 5m19s（首次）/ 4m53s（控制台闪窗修复后重建，10:10）；NSIS 4.17 MiB / MSI 6.37 MiB |
| 100k 规模备份/恢复 | 通过：最终源码 backup 571ms / 61,877,483 B；restore 5,019ms；25 表逐行一致、500 资产/2 归档 SHA 一致；恢复峰值 WS 619.0MB（非流式，见 §4） |
| 恢复原子性故障矩阵 | 21 个恢复测试全部通过（含数据库已提交但归档失败回滚、崩溃续跑、权限/磁盘满/文件锁、旧备份保留扩展模块） |
| 退出超时事件恢复 | 17 个 pipeline 退出/暂存测试 + 6 个 spool 测试通过（3000 条跨队列与合并缓冲、500 条排空、HTTP 在途、暂存失败如实报告、重启幂等重放） |
| 控制台闪窗修复 | `winproc::hidden()` + `CREATE_NO_WINDOW`；新增单元测试通过；隔离实例 `--agentctl scan` 采样 201 次控制台工具进程，0 个可见窗口句柄 |
| 剪贴板真机/性能 | 2/2 通过：列表 p95 2.364 ms、200 张 1080p 入库 6.984 s（预算 8 s）、配额 30.21 MB（预算 32 MB） |
| 真机验收 | **46/46 PASS（2026-10-29 历史证据，本轮未重跑）**（`clipboard/evidence/acceptance-final13.log`） |
| 第三方应用矩阵 | **5/5 PASS（历史）**；微信 ENVIRONMENT BLOCKED、Agent NOT VERIFIED |

**2026-10-30 16:15→16:47 追加复跑（P0/P1 综合整改后，不改写上表任何历史数值）**：

| 检查 | 结果 | 退出码 | 日志 |
|---|---|---|---|
| `cargo test --all --no-fail-fast` | **lib 441 passed / 0 failed / 3 ignored**（17.99 s）；`inbox_processes` 1 passed；`actions_perf`/`clipboard_perf`/`ingest_perf`/`real_backup_restore`/`real_clipboard` 为真机/性能工具（ignored） | 0 | `clipboard/evidence/gate-rust-all-20261030-1615.log` |
| `cargo clippy --all-targets --all-features -- -D warnings` | 首两次失败（共 6 处：未用变量、恒等乘法、多余 `as`、两处嵌套 `format!`、`Default::default()` 后逐字段赋值）→ 逐条修根因后 **0 警告** | 101 → 0 | `gate-fmt-clippy-20261030-1620.log`、`gate-clippy-test-20261030-1625.log` |
| `cargo fmt --all -- --check` | 无差异 | 0 | `gate-fmt-20261030-1700.log` |
| `npm run build` | `✓ built in 10.73s`；js 478.09 kB / css 94.72 kB | 0 | `release-build-accept-20261030-161144.log` |
| `npx vitest run` | **23 文件 / 164 用例通过**（Duration 37.64s） | 0 | `gate-npmtest-20261030-1630.log` |
| Windows Release 构建 | `Finished release in 8m 08s` → `target-accept/release/task-dock.exe`（15,515,136 B，16:20） | 0 | `release-build-accept-20261030-161144.log` |
| 真实桌面图文混合粘贴验收 | **PASS 52 / FAIL 0 / BLOCKED 0**（含「剪贴板已恢复为粘贴前哨兵」15/15 采样、序列号全程一致、DOM 图/图/文/图、三图像素级 Alpha=255）；另有 1 轮 2 条 FAIL（断言写法问题）与 1 轮 EXIT=3（隔离实例被外部终止）完整保留 | 1 / 3 / 0 | `p1-03-mixed-paste-run-1635-console.log`、`…-1700-console.log`、`…-1710-console.log` + `p1-03-mixed-paste-20261030-164201-c07922a9.json` |
| `TD_REAL_CLIPBOARD=1 cargo test --test real_clipboard -- --ignored --nocapture` | **3 passed / 0 failed**（真实剪贴板 4 项分组顺序、逐条写入回读、全透明图、CF_HDROP、富文本、自写去重、用户原剪贴板恢复） | 0 | `gate-real-clipboard-20261030-1715.log` |
| `cargo test --lib navigation::router` | **10 passed / 0 failed**——上表 10:0x 会话里被前台锁拒绝的 2 例（`launch_disallowed_reports_failure_or_focus_only`、`notepad_launch_focuses_existing_window_of_owned_process`）本轮真实通过 | 0 | 同上 |
| `npm run tauri build`（安装包） | **本轮未执行**：`target-accept/release/bundle/` 的 NSIS/MSI 仍是 10-29 00:42/00:43 产物，不代表本轮源码；升级迁移与安装/卸载因此维持「未验证」 | — | — |

**如实披露**：16:05 前后两次 `npm test` 各出现 2 例 5000 ms 超时（`TasksPanel 筛选交互` 等 jsdom 用例），
当时同机正在编译 release；空闲复跑 23 文件 / 164 用例全绿。未删除用例、未放宽断言、未调大超时阈值。
完整判定见 `docs/V05_FINAL_ACCEPTANCE.md`，过程记录见 `docs/V05_COMPREHENSIVE_REMEDIATION.md`。

**2026-10-30 18:08→18:56 第二轮追加复跑（第二轮补漏修复之后，不改写上方任何历史数值）**：

第二轮补了五处（历史分页失同步、行动中心分页竞态、压测数据审计无前端入口、调度器提醒绕过限频、
性能夹具期望值算错），因此门禁全部重跑，并新增两个迁移相关的测试。

| 检查 | 结果 | 退出码 | 日志 |
|---|---|---|---|
| `cargo fmt --all -- --check` | **首次失败**（新增代码有 2 处格式差异）→ `cargo fmt --all` 后复验无差异 | 1 → 0 | `clipboard/evidence/gate-rust-final-20261030-1832.log`、`…-1836.log`、`…-1855.log` |
| `cargo clippy --all-targets --all-features -- -D warnings` | 0 警告 | 0 | 同上 |
| `cargo test --all --no-fail-fast` | **lib 445 passed / 0 failed / 3 ignored**（22.11 s；第一轮 441 → 第二轮补 3 个 notify 用例 → 445 再补 1 个 v11→v13 迁移升级用例）；`inbox_processes` 1 passed；新增真机工具 `real_upgrade`（默认 ignored） | 0 | `gate-rust-final-20261030-1855.log` |
| `npm test`（vitest） | **23 文件 / 166 用例通过**（Duration 37.44s；第一轮 164） | 0 | `gate-npm-final-20261030-1842.log` |
| `npm run build` + `npx tsc --noEmit` | `✓ built in 7.84s`（js 481.35 kB / css 94.72 kB）；tsc 无错误 | 0 | 同上 |
| `cargo test --release --test actions_perf -- --ignored --nocapture` | **首次失败**（全局筛选总数 42 ≠ 夹具期望 40，根因在夹具公式）→ 修正期望值后通过：p50 2.99 ms · **p95 3.22 ms** · max 3.23 ms（预算 p95 ≤ 60 ms） | 101 → 0 | `perf-actions-release-20261030-180830.log`（失败轮原样保留）、`…-1813.log` |
| `cargo test --release --test clipboard_perf -- --ignored --nocapture` | **2 passed / 0 failed**：`insert_avg 0.097 ms`、`list80 p95 3.416 ms`、`count p95 0.013 ms`、`search_miss p95 0.839 ms`、`thumb max 8.653 ms`、`png_encode 105.81 ms` / `png_decode 15.47 ms`、`rgba_to_dib 5.49 ms` / `dib_to_rgba 5.73 ms` | 0 | `perf-clipboard-release-20261030-1819.log` |
| `npm run tauri build`（**安装包，本轮首次用当前源码执行**） | **EXIT=0**：release exe 15,531,520 B；**NSIS `Task Dock_0.5.0_x64-setup.exe` 4,493,352 B**；**MSI `Task Dock_0.5.0_x64_en-US.msi` 6,840,320 B**（均 18:44）。**未执行实际安装→升级→卸载**（会改动用户机器） | 0 | `bundle-build-20261030-1841.log` |
| `TD_REAL_UPGRADE_DB=<真实用户库 v11 副本> cargo test --test real_upgrade -- --ignored --nocapture` | **ok**：version 11 → 13；8,734 事件 / 36 会话 / 248 轮次 / 310 通知行数无减少；外键零违规；`integrity_check=ok`；回填把 6 个 `taskdock-selftest-` 会话及其 12 事件/12 轮次/12 通知标为 `selftest`，其余保持 `real`；重复打开不重复推进版本 | 0 | `gate-real-upgrade-20261030-1855.log` |

**本轮新增的测试入口**：

- `src-tauri/src/db/mod.rs` → `v11_to_v13_upgrade_keeps_rows_and_isolates_provable_test_data`：
  建 v11 库并放入旧结构数据 → 用 `Db::open` 升级 → 断言版本推进、四张表行数不变、
  旧行默认 `real`、可证明的自测/压测数据被隔离、`bench` 来源 `category=benchmark & hidden=1`、
  v13 四个分页索引齐备、`pragma_foreign_key_check` 零违规、**重复打开不重复回填也不改写归类**。
- `src-tauri/tests/real_upgrade.rs` → `real_user_database_upgrades_without_losing_rows`（`#[ignore]`）：
  真机工具，`TD_REAL_UPGRADE_DB` 指向**真实用户库副本**；迁移只发生在副本上，用户原库只读。

剪贴板模块内 Rust 测试覆盖：分类优先级、去重哈希、45s 分组与文本穿插、
300/组上限、HTML 清洗、高置信敏感模式、来源未知保守凭据模式、排除名单 basename、
恢复不覆盖用户新内容、富文本整组顺序、DIB/PNG/缩略图/全透明归一化、CF_HTML 偏移、
HDROP 解析、资产清理与引用安全、保留期/条数上限、任务删除级联保留内容、
图片落盘失败无半行、配置损坏 fail-closed 与修复备份、HTTP header timeout 回归、
粘贴状态机（写后不重发、取消保留未处理、目标关闭/焦点失败、内容竞态、恢复失败、
续跑不重发）、监听有界队列（100/1000 事件峰值与丢弃计数）、panic 隔离。
前端 133 例（21 文件）：`useAgentsStore` 刷新调度、`useClipboardStore` 4 例、
`clipboardUi` 预检 9 例、`PastePanel` 3 例、`ClipboardDrawer` 4 例、
`AgentExportPanel` 2 例及任务/导航既有测试。

### 1. Rust 单元测试（cargo test，v0.4 记录）

```
running 111 tests
test result: ok. 111 passed; 0 failed
```

覆盖（v0.3 的 80 例之上，v0.4 新增 31 例导航相关）：
- **统一导航安全校验（4 例）**：URL 协议白名单（file:/javascript:/ms-settings:/控制字符/超长拒绝）、
  exe 路径规则（相对路径/非 exe/不存在/cmd 黑名单拒绝，notepad 通过）、
  AUMID 字符集、启动参数长度与控制字符；
- **窗口管理（5 例，真机）**：顶层窗口枚举结构校验 + exe 关联、TTL 缓存命中、
  死句柄报 WindowVanished、测试进程自解析、空输入匹配拒绝；
- **软件发现（5 例）**：分类判定（浏览器/通讯/音乐/开发）、中文应用标题提示、
  app_key 去重与空 key 拒绝、**真机扫描只产出通过安全校验的目标**、
  运行状态分级（无 GUI 测试进程不得报 HasWindow）；
- **目标持久化（6 例）**：app_key 幂等去重（含覆盖改名）、危险目标拒绝
  （相对路径/cmd/ftp/javascript/不存在文件/未知类型）、任务关联 CRUD 与默认唯一、
  未知 target_id 拒绝、exe 失效标记 unavailable、导航日志读写与清理；
- **路由（4 例）**：exe 消失如实失败（不假装跳转）、URL 执行时重校验（防库内篡改）、
  **真机 notepad 启动/唤醒（验证级别如实）**、禁启设置下只允许唤醒；
- **Agent 导航（5 例）**：未知 Agent 能力全不支持（证据标注）、非法/不存在会话 ID 拒绝、
  非白名单来源拒绝、无效目录/无工作区接口拒绝、codex 能力证据化；
- **DB 迁移 v4（1 例）**：v3→v4 新表齐备 + task_agent_links 原样保留 +
  唯一约束/CHECK 生效 + 任务删除级联清理两种关联。

### 2. 前端测试（vitest，v0.4 记录）

```
Test Files  5 passed (5)
     Tests  44 passed (44)
```

覆盖：日期标签、截止格式化、相对时间、过期判断、时长格式化、优先级标签、
datetime-local 互转、Agent 树聚合（10 例）；
**导航纯函数（7 例，v0.4）**：头像色稳定、状态徽标分级（有窗口/仅进程/未运行/失效）、
验证级别文案（进程启动 ≠ 窗口确认）、结果消息（失败带原因 / 降级必标注 / 成功不含失败字样）、
目标类型标签齐全。

### 3. 类型检查与构建

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit`（strict + noUnusedLocals） | ✅ 0 错误（v0.5 复测） |
| `npm run build`（tsc + vite build） | ✅ 通过（v0.5 最终：464.88 kB JS + 68.51 kB CSS） |
| `cargo clippy --all-targets --all-features` | ✅ 0 警告（v0.5 复测） |

### 4. 已知测试缺口（诚实记录）

- 真机剪贴板/逐项粘贴验收已完成（46/46）；微信与 Agent 类应用因环境阻塞未验证，
  详见 §六与 `clipboard/10-remediation-acceptance.md`。
- `cargo test --all-targets` 的 2 例导航前台聚焦测试在锁屏/非交互会话会被 Windows 前台锁
  拒绝置前；生产代码如实返回失败原因（不伪装成功），未放宽断言、未跳过。
  **2026-10-30 01:26 锁屏会话**：302 passed / 2 failed / 11 ignored，整体退出码非 0；
  **2026-10-30 09:44 交互会话**：382 passed / 0 failed / 13 ignored，两例通过；
  **2026-10-30 10:0x 控制台修复后复跑**：lib 380 passed / 2 failed / 3 ignored，两例再次被
  前台锁拒绝（错误信息“Windows 前台锁定拒绝了切换”）；lib 失败后 cargo 中止，集成另行执行
  1 passed / 10 ignored，合并 381 passed / 2 failed / 13 ignored。该两例与剪贴板/备份改动无关，
  未修改断言、未跳过；不能把“09:44 曾通过”写成“最终始终全部通过”。
  **2026-10-30 16:45 追加**：同机交互会话复跑 `cargo test --lib navigation::router`
  → **10 passed / 0 failed**，两例真实通过（此前挡住它们的记事本「他人已存在的单实例多标签进程」已不在）。
- **2026-10-30 16:41 追加**：上条「真机剪贴板 46/46」之外，本轮另跑 `TD_REAL_CLIPBOARD=1`
  真机套件 **3 passed / 0 failed** 与图文混合粘贴 GUI 验收 **52/52 PASS**；
  微信/Office/Word 与 Agent 类应用接收在本轮**仍未复跑**（矩阵脚本从未入库，见
  `docs/V05_FINAL_ACCEPTANCE.md` 第六节 C.2）。
- **恢复侧内存**：100k 事件 + 10k 通知 + 5k 剪贴板条目的 61.9MB bundle，恢复进程观测
  峰值 WS **619.0MB**（备份侧约 27.4MB）。备份是流式写入，但恢复读取仍把表行
  materialize 为 JSON 与强类型行；不满足“恢复也常量内存”的理想目标，未虚报为 PASS。
  数据正确性、外键、资产/归档 SHA 与崩溃回滚均通过；详见
  `performance/results/V05-SCALE-100K-FINAL-20261030.json`。
- WebView2 真机帧率、多显示器/DPI 组合、真实监听 observed/captured/dropped 仍未测量；
  30 分钟空闲资源、95 秒 Agent 并发、1000+ 历史/大分组滚动已由 release 真机采样覆盖
  （`clipboard/evidence/perf-*-20261030.json`）。后端 30 分钟长稳见 §一.5。
  **2026-10-30 最终 Release 整桌面 30 分钟已完成**（36,000 事件 0 失败、队列峰值 20/1,024、
  HTTP p95 268.63ms）；但主进程 private 11.4→95.1MB 持续增长、停止负载后未回落，
  内存泄漏尚未定位，不能写成“30 分钟无泄漏”。
- 图片/文件粘贴到图形界面应用未验证（仅记事本拒绝图片时如实报告）；修复后的图文混合
  像素级复验仍为 ENVIRONMENT BLOCKED，不能算通过。
  → **2026-10-30 16:41 更新（原文保留作历史）**：工作站解锁后已用 16:20 release 二进制完成该复验，
  **52/52 PASS**（DOM 顺序图/图/文/图、三图 Alpha=255 与 RGB 逐点断言、恢复哨兵 15/15 命中），
  见 §0 追加表与 `clipboard/11-final-release-acceptance.md` §4.6；
  但「图形界面应用矩阵」仍只在 Edge contenteditable 一个目标上通过，记事本/Word/微信等未复跑。
- 安装/卸载/签名未验证。
- ESLint：仓库无配置文件，`npm run lint` 不存在，未伪造 lint 结果。
- 前端既有测试在 CPU 满载并行编译时出现过 3 例 5 s 超时；本次全量通过（未改阈值）。
- v0.3 记录的两项缺口（AgentHub::ingest 集成测试、前端组件 UI 测试）中，
  前端已引入 testing-library 并补充组件测试；AgentHub 集成测试仍缺。

### 5. v0.5 性能验收（实测摘要，详见 [最终验收](PERFORMANCE_FINAL_ACCEPTANCE.md) 与 PERFORMANCE_ACCEPTANCE_REPORT.md）

| 场景 | 实测 | 判定 |
|---|---|---|
| 持续吞吐（10 Agent × 50/s × 600s） | 300,000 条 = **499.72 事件/秒**，关键 30,000/30,000 | PASS |
| 高并发（40 Agent × 50/s × 60s） | **1,886.32 事件/秒**，队列 1024/1024，1,195 次可重试拒绝，零丢失 | PASS |
| 200 事件/秒突发（60s） | 12,000 条 = 198.1/s，关键 1,200/1,200 | PASS |
| 持续过载与恢复（队列 64） | 8,579 次显式拒绝，关键 1,600/1,600 落库，`recovery_ok` | PASS |
| 单批落库 p95 | 45.8ms（A1）/ 118.9ms（A2）/ 14.1ms（B）/ 57.9ms（C） | PASS |
| 基线对比（5,000 事件） | 新管线 1,065ms vs 旧 21,556ms → **20.24×** | PASS |
| 行动中心查询 p95（600 事件） | 3.6ms | PASS |
| 剪贴板 300 条历史列表 p95 | 0.96 / 1.11ms（80 / 200 行） | PASS |
| 200 张连续截图入库+分组+配额 | 4.22s，磁盘 30.2MB（配额 32MB） | PASS（不含 PNG 采集编码） |
| 前端 300 行重渲染 | 提交中位数 0.2ms，到绘制 30.5ms | PASS（preview harness） |
| 前端刷新调度 | 100 事件 → 2 次快照请求（最大并发 1） | PASS（真实模块单测） |
| 稳定性（30 分钟，4×5/s） | 36,000 条，关键 3,600/3,600；RSS +2.4MB（峰值 18.0MB）；队列 12/1024 | PASS |
| 故障注入 | 坏事件隔离/幂等/乱序保护/重连 全部成立 | PASS |

已补充（2026-10-30）：真机 HTTP 全链路压测 10 Agent × 50/s × 600s（300,000 条，
499.69/s，关键 30,000/30,000，p95 184.39ms）与 200/s × 60s（12,000 条，关键 1,200/1,200）；
30 分钟整桌面资源采样（主进程 + WebView2 进程树 + 其他 Agent，36,000 条、0 丢弃）；
100k 备份/恢复。该轮**应用层内存未通过**：主进程 private 11.4→95.1MB 持续增长、
停止负载后未回落，根因未定位，不记为“内存稳定”；真实 Agent 只验证安装发现与 Hook CLI
协议投递，实时会话未验证。仍未执行：WebView2 逐帧帧率、真实监听事件率、修复后图文混合
GUI 复验（锁屏阻塞）、磁盘写满真机注入与强杀/断电物理恢复。

## 二、端到端运行验证（真实运行，非模拟冒充）

以下在 Windows 11 上真实运行 `target/debug/task-dock.exe` 完成：

### 1. 应用启动（冒烟测试）

```
INFO task_dock_lib::db: 数据库迁移至 v1
INFO task_dock_lib::agents::mock: Mock Adapter 启动（模拟状态源）
INFO task_dock_lib::scheduler: 提醒调度引擎启动（1s 粒度）
INFO task_dock_lib::agents::file_drop: 文件投递 Adapter 启动，监听目录 ...\agent-inbox
INFO task_dock_lib::commands::data: 启动自动备份完成: ...\backups\backup-20261025-162633.json
INFO task_dock_lib: Task Dock 启动完成（数据目录: ...）
INFO task_dock_lib::agents::http_ingest: 本地 HTTP 接入监听 127.0.0.1:47821
INFO task_dock_lib::agents::mock: [模拟] 会话开始 mock-sess-... (重构登录模块)
INFO task_dock_lib::agents::mock: [模拟] 会话结束 mock-sess-... outcome=completed
```

窗口持续运行 170 秒无崩溃；Mock 会话按 30 秒周期完整走完 running → completed 生命周期。

### 2. HTTP 接入端点（curl 实测）

| 用例 | 请求 | 结果 |
|---|---|---|
| 健康检查 | `GET /api/v1/health` | ✅ 200 `{"ok":true}` |
| 错误令牌 | `POST /api/v1/events`（Bearer wrong-token） | ✅ 401 unauthorized |
| 合法事件 | 正确令牌 + codex running 事件 | ✅ 200 `{"accepted":1}` |
| 未注册来源 | 正确令牌 + source_id=unknown-source | ✅ 422 event rejected |
| 日志脱敏 | 日志仅含方法/路径/状态/对端/耗时 | ✅ 无请求体 |

### 3. 文件投递通道（实测）

| 用例 | 结果 |
|---|---|
| mock 源事件文件 | ✅ 已处理并删除 |
| 已禁用源（qoder）事件文件 | ✅ 正确拒绝（来源已禁用）并移入 failed/ |
| waiting + pending_items 事件 | ✅ 正常进入状态机 |

### 4. Release 安装包（已验证）

```
npm run tauri build   → EXIT=0（20m33s，含 WiX 下载）
Finished 2 bundles at:
  bundle/nsis/Task Dock_0.1.0_x64-setup.exe (2.42 MiB)
  bundle/msi/Task Dock_0.1.0_x64_en-US.msi  (3.30 MiB)
```
release exe 直接运行验证：进程稳定、全部适配器启动、`GET /api/v1/health` 返回 200。
安装包已归档至仓库 `release/` 目录（未签名，首次运行需「更多信息 → 仍要运行」）。

### 5. 单实例保护（实测）

首个实例运行中，再启动同一个 exe：

| 用例 | 操作 | 结果 |
|---|---|---|
| 重复启动 | 已有实例运行时再启动一次 | ✅ 第二进程立即退出（EXIT=0），进程数保持 1 |
| 窗口聚焦 | 已有实例窗口处于隐藏状态时再启动 | ✅ 已有实例窗口显示并获得焦点 |
| 端口独占 | 重复启动后 `GET /api/v1/health` | ✅ 仍 200，未出现双绑定/绑定失败 |
| 托盘图标 | 观察通知区域 | ✅ 始终 1 个图标 |

### 6. 修复记录（测试驱动发现的问题）

1. Tauri v2 事件回调为单参数（`on_window_event`）；
2. `tauri_plugin_autostart` 方法名为 `autolaunch()` 而非 `autostart()`；
3. 主线程直接 `tokio::spawn` 无 reactor → 改 `tauri::async_runtime::spawn`；
4. 前端 invoke 参数名需 snake_case（Tauri v2 不做驼峰转换）；
5. NLP：裸时刻 1-6 点按下午、今晚 +12、无日期默认今天、周一至周五的周前缀；
6. 重复规则：月度先查当月；SQL 占位符编号唯一化；
7. `formatRelative` 单位阈值错误（30 分钟显示为 1 小时）。
8. **缺少单实例保护**：重复启动会多开进程 → 抢占 47821 端口、通知区域出现多个托盘图标，
   非正常结束的实例还会留下「幽灵图标」。已接入 `tauri-plugin-single-instance`，
   并放在 `Builder` 的**第一个**插件位置（插件按注册顺序初始化，必须早于建库/绑端口/建托盘）。

## 三、明确未验证项（不冒充完成）

| 项 | 状态 | 说明 |
|---|---|---|
| **Codex 真实接入** | ⚠️ 未验证 | 钩子安装器已实现，但本机无 Codex CLI 安装，未经真实 Codex 环境联调 |
| **Qoder / WorkBuddy 官方接口** | ⚠️ 未验证 | 未找到公开官方状态接口；当前为 stub 来源（UI 标注「未验证」），可走通用接入 |
| **Codex App Server** | ⬜ 未实现 | 路线已评估并记录在 docs/AGENT_ADAPTERS.md，列入 v0.2 |
| **休眠/唤醒补偿** | ⚠️ 未经真实休眠 | 按挂钟每秒比对的设计；休眠恢复后到期提醒会补触发（逻辑已验证，未做真实休眠测试） |
| **Windows 通知** | ⚠️ 未经真实弹窗 | 通知插件调用路径已通（Mock 完成时会触发）；未截图验证 toast 样式 |
| **安装包** | ✅ 已构建 | `release/Task Dock_0.1.0_x64-setup.exe`（NSIS 2.42 MiB）与 `release/Task Dock_0.1.0_x64_en-US.msi`（3.30 MiB）；release exe 已验证可启动、HTTP 端点 200 |
| **UI 视觉细节** | ⚠️ 未走查 | 严格类型 + 构建通过 + 运行无报错；未经人工视觉走查 |

## 四、复现命令

```bash
npm test                              # 前端 133 例（21 文件）
cd src-tauri && cargo test            # lib 380 通过 + 2 前台锁环境失败 + 3 ignored；集成 1 通过 + 10 ignored
cargo test --lib commands::restore::tests -- --nocapture   # 恢复原子性 21 例
cargo test --release --lib \
  commands::backup::tests::full_backup_100k_events_10k_notifications_roundtrip \
  -- --ignored --nocapture            # 100k 规模备份/恢复（约 11s 测试体，构建另计）
npm run build                         # tsc + vite
npm run tauri build                   # 安装包
```

## 五、v0.4 统一导航真机验收（2026-10-26，Computer Use 驱动）

> 方法：正式版 exe（custom-protocol 构建）+ Windows UIA 自动化逐场景操作，所有结论有
> **数据库审计记录或进程实测**佐证；UI toast 瞬时不过记录的以 navigation_log 为准。
> 验收数据已清理，Agent 历史与设置未触碰。

### 场景结果

| 场景 | 操作 | 结果 | 证据 |
|---|---|---|---|
| 快速添加 | UIA 输入「验收演示：打开记事本」→ 创建 | ✅ Toast「已创建」+ 列表/计数更新 | UIA 树 |
| 应用选择器 | 编辑器「添加目标…」→ 搜索/空态/分类 | ✅ 打开正常；notepad 无 Win32 安装记录为真实结果（Win11 为商店应用） | UIA 树 |
| 窗口选择器 | 「从当前运行的窗口选择…」 | ✅ 列出 Chrome/ZCode/Task Dock 窗口，含标题+exe 身份 | UIA 树 |
| 手动登记 EXE | 「手动添加」C:\Windows
otepad.exe | ✅ 目标落库 → 任务关联落库 → 编辑器条目（上移/下移/默认/解除）→ 任务卡图标 | DB: navigation_targets + task_navigation_targets |
| L1 启动 | 点击任务卡「打开 记事本」 | ✅ Notepad.exe 进程真实启动（PID 102752）；**verification_level=process-spawned**（Win11 记事本 UWP 化，窗口在 ApplicationFrameHost 名下，不谎报 window-confirmed） | DB 日志 + tasklist |
| L2 唤醒 | 点击「打开 02_插件与工具生态」（Chrome 已运行） | ✅ **window-confirmed**：前台句柄核实成功；重复点击复用现有窗口 | DB 日志（focus_window/success=1） |
| 已运行复用 | 再次点击 Chrome 目标 | ✅ 不重复启动，唤醒现有窗口 | DB use_count 递增 |
| 工作区启动 | 任务卡「打开工作区」→ 启动全部（2 目标） | ✅ 顺序执行、逐项状态（等待→启动中→结果）、Chrome window-confirmed + notepad process-spawned | DB 日志 2 条 + use_count |
| Agent 树按钮 | 「全部」筛选展开 8 个来源 | ✅ 本机未装的 7 个 Agent「打开应用」按钮全部 **disabled**（证据化 not-installed） | UIA 树 |
| 会话跳转 | bridge 来源 v04-smoke-2 会话点跳转 | ✅ 诚实拒绝：success=0「该 Agent 无已知窗口身份」（纯数据通道不冒充可用） | DB 日志（resume_session/0） |
| 应用管理 | 设置页「应用与快捷方式」 | ✅ 导航偏好 6 项控件 / 已保存目标（收藏·隐藏·测试跳转·删除）/ 最近导航记录（含失败原因） | UIA 树 |
| 审计闭环 | — | ✅ use_count/last_used_at/navigation_log 全部正确落库 | DB |

### 验收发现并当场修复的缺陷（4 个，全部已修复并回归）

| # | 级别 | 缺陷 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | P0 | 正式版扫描到开始菜单畸形 .lnk 时**整个应用退出** | `[profile.release] panic = "abort"` 使 catch_unwind 失效（单测是 debug 构建未暴露） | 移除 panic=abort（Cargo.toml 注释说明原因）；真机日志确认 5+ 个畸形 lnk 全部被隔离 |
| 2 | P0 | 打开应用选择器**前端崩溃白屏**（WebView UIA 树塌掉） | zustand v5 selector 每次渲染返回新 `Set` → 严格相等比较失败 → 无限重渲染 | AppPicker/WorkspaceLauncher 的 selector 只取稳定引用，派生集合移入 useMemo |
| 3 | P0 | 手动添加后「目标已保存但关联静默失败」 | **Tauri v2 invoke 参数只认 camelCase**：bridge 层全量 snake_case 键——required 参数报 invalid args（toast 实证 `invalid args 'taskId'`），Option 参数静默失效（v0.3 的 linkTaskAgent、快速添加时间参数等同样受累） | bridge.ts + navigation.ts 全部 invoke 键改 camelCase（约 20 处）；调用方同步 |
| 4 | P2 | 关联失败无任何 UI 提示（unhandled rejection） | ManualAddForm.onSaved 未 await async 回调 | afterPick 包 try-catch + 明确错误 toast（该提示直接定位了 #3） |

### 遗留观察

- WebView2 的 UIA 提供程序在长时间高频查询后会卡住（重启进程恢复；Chrome 无此现象）——
  影响自动化测试工具而非用户交互，记录备查。
- Win11 商店版记事本等 UWP 化应用的窗口不在自身 exe 名下 → 窗口级唤醒按设计如实降级为
  process-spawned；如需窗口级支持，后续可按 AUMID/ApplicationFrameHost 特判（列入待办）。

## 六、v0.5 智能剪贴板真机验收（2026-10-29 历史 + 2026-10-30 复核）

> 方法：隔离实例（identifier `com.taskdock.desktop.accept`、独立 appdata、CDP 9417、
> 内嵌前端 debug 构建）；真实系统剪贴板 + 真实外部窗口；每项读回来自目标应用/磁盘/
> 独立进程。原始证据：`clipboard/evidence/acceptance-final13.log`。
> **10-30 复核后最终判定为 CONDITIONAL PASS**，完整依据见
> [`clipboard/11-final-release-acceptance.md`](clipboard/11-final-release-acceptance.md)。

- 结果（2026-10-29）：**46/46 PASS**（A0、B1–B17 及 b 补充项、C1–C12、D1–D5、
  E1、F1、G1–G2、H1–H2）。覆盖 22 个必测场景；场景与检查项对应关系见
  `clipboard/08-testing-performance.md` §三。**10-30 未重跑这 46 项**（锁屏）。
- 关键真机证据：C3 记事本真实接收 3 项且顺序正确；C5 粘贴后恢复原剪贴板；
  C10 目标关闭停止；C11 用户中途复制的新内容不被覆盖；C12 目标拒绝图片时只报
  “动作已发送”；C6 自身粘贴不产生新历史。
- 第三方矩阵（10-29）：记事本、资源管理器（CF_HDROP）、Edge 文本与 contenteditable
  富文本、VS Code（保存后磁盘读回）均 **PASS**；微信因已登录真实用户会话
  **ENVIRONMENT BLOCKED / NOT VERIFIED**；Trae CN（Agent）停在登录/引导页
  **NOT VERIFIED**。
- 10-30 新增：P0 隐私配置损坏的隔离真实运行（暂停→修复→恢复，任务设置不受影响）、
  场景 C Agent 并发（74,653 次请求 0 失败）、场景 D（1,250 条历史/大分组/滚动/
  抽屉/清理）、场景 A 30 分钟空闲采样。
- 修复前的图文混合真机记录：顺序正确但三张图 Alpha 全 0；修复 Alpha 后
  **GUI 复验被锁屏阻塞**。不把单测折算为应用层通过。
- 真机发现并修复两处 UI 缺陷：任务关联模式抽屉 z-index 低于编辑弹窗导致不可点选；
  删除确认框继承 `pointer-events:none` 导致可见但不可点击。D1/D3 回归通过。
- 未执行/阻塞：修复后图文混合复验、场景 B 连续 30 分钟真实采集、>1000 截图、
  多显示器/DPI、图片/文件粘贴到图形界面应用；微信与 Agent 应用的接收行为未验证。
- 不把格式层单元测试折算为应用层兼容性证明，也不把未验证应用写成“支持”。
