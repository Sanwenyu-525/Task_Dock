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
>
> 每条结论应选哪条验收通道（自动化测试 / 隔离预览 / CDP + 真实 WebView2 / UIAutomation /
> Win32-DWM 原生 / 物理操作）见 [ACCEPTANCE_ROUTING.md](ACCEPTANCE_ROUTING.md)；本文只记录结果。

## 一、自动化测试结果

### 启动器型应用运行态识别修复（2026-11-11）

现象：胶囊「应用」面板中 Qoder CN 已运行却无绿点。目标配置的是
`...\Qoder CN Launcher\Qoder CN Launcher.exe`，而窗口与常驻进程属于启动器拉起的
版本化主程序（`...\.qoder-versions\0.5.7\Qoder CN.exe`），启动器自身已退出；
**根因是身份不匹配，不是轮询时机**。

修复：`window_manager::launcher_family_stem` 从 `... Launcher.exe` / `... ScLauncher.exe`
推导主程序家族名（`Qoder CN Launcher.exe` → `qoder cn`），运行态（`has_window` /
`process_only`）、窗口定位、退出/结束动作共用同一套判定；家族名只做完整文件名干比较，
不做子串匹配。

| 检查 | 结果 | 证据 |
|---|---|---|
| `cargo test --lib navigation:: -- --test-threads=4`（`D:\Develop\task_dock\src-tauri`） | **PASS 110 passed / 0 failed / 5 ignored**（7.51s，exit 0，2026-11-11 17:19） | 新增 `launcher_family_stem_derives_main_app_name`、`identity_pids_follows_launcher_family_to_main_process`、`launcher_key_matches_running_main_process_family`；`identity_has_window_sees_own_process_window` 扩展为真实窗口 + 伪造启动器身份，验证家族名命中且不误伤不存在的身份 |
| 真机探针（临时测试已执行并移除） | `Qoder CN Launcher` → `Some(HasWindow)`；英文 `Qoder Launcher`（无同名主程序）→ `Some(NotRunning)`；`windows_for_identity` 命中标题「Qoder CN」、exe 为版本化主程序 | 2026-11-11 同日会话内实测；探针未保留在仓库 |

**同日扩大排查（2026-11-11，其他「已启动但无绿点」形态）**：

| 检查 | 结果 | 证据 |
|---|---|---|
| UWP 打包应用窗口识别：WindowsApps 目录名含版本/架构，旧逻辑用族名做路径子串永远不命中 | **修复并真机验证**：Windows Terminal 运行中，`Microsoft.WindowsTerminal_8wekyb3d8bbwe!App` → `Some(HasWindow)`；`windows_for_family` 返回真实窗口（exe 位于 `...WindowsApps\Microsoft.WindowsTerminal_1.24.12741.0_x64__8wekyb3d8bbwe`）。新增按标准包目录解析族名 + 进程 AUMID（`GetApplicationUserModelId`）补权威身份 | 新增 `versioned_windowsapps_path_resolves_package_family`、`aumid_family_uses_package_prefix`；探针在 2026-11-11 会话内执行后移除 |
| 保存的 exe 路径已随版本升级失效、但同类进程仍在运行：旧逻辑强制 `unavailable`（无绿点） | **修复**：运行态优先；确实未运行才报 `unavailable` | `missing_saved_exe_but_running_process_reports_process_only` |
| 其他启动器命名：开始菜单实测发现 QQ 的 `QQScLauncher.exe`（主程序 `QQ.exe`）、Blender 的 `blender-launcher.exe` | **修复/覆盖**：`launcher_family_stem` 支持 `ScLauncher` 词尾；Blender 由既有 `launcher` 词尾覆盖 | `tmp/debug/launcher-runstate/shortcut-launchers.txt`；`launcher_family_stem_derives_main_app_name` 已补断言 |
| `tasklist /FO CSV` 进程名截断/非 ASCII 导致漏判的怀疑 | **本机未发现**：最长进程名 36 字符、无非 ASCII 名称，不构成不足来源 | `tmp/debug/launcher-runstate/tasklist-names.txt` |
| `cargo test --lib navigation:: -- --test-threads=4` 全量复跑（`D:\Develop\task_dock\src-tauri`） | **PASS 113 passed / 0 failed / 5 ignored**（7.00s，exit 0，2026-11-11 17:38） | 覆盖上述新增用例；另一次高负载并行运行时 `tasklist` 快照 5s 超时被缓存为空，致 2 个依赖进程快照的用例短暂失败，隔离与整组复跑均通过——属既有 TTL 缓存的环境抖动，记录待优化，非本次改动回归 |

**本次未覆盖**：Squirrel 型 `Update.exe --processStart ...` 启动器（本机无样本）；UWP 应用无顶层窗口或窗口被 cloak 时仍按未运行处理；`ApplicationFrameHost` 托管且拿不到 AUMID 的旧式 UWP 窗口。

### 多 Agent Worktree 隔离机制（2026-11-07）

| 检查 | 结果 | 证据 |
|---|---|---|
| `node --test scripts/worktree-guard.test.mjs` | **PASS 9/9**（10.4s，exit 0） | 一次性临时 Git 仓库覆盖：Git 登记识别、指定基准创建、重复任务/已存在目录/分支冲突/非法参数拒绝、双 Worktree 未提交隔离、node_modules 同清单 junction 与清单不一致拒绝、merge-tree 冲突/目标未提交重叠/源未提交风险、cleanup 脏/未合入/锁定/缺失/主工作区/当前 cwd 位于待清理目录内拒绝及合入后清理、linked Worktree 内继续创建、分支删除失败返回 5 |
| `npm run test:scripts` | **PASS 10/10**（10.1s，exit 0） | 含既有 `build-guard.test.mjs` 1 项，确认新增脚本未影响构建守卫测试 |
| 真实仓库双 Worktree 验收 | **PASS** | 从 `main @ 07606f6` 创建 `isolation-selftest-a` / `-b` 两个分支；A 的未跟踪文件对 B 与主工作区不可见；重复创建 exit 1 且不覆盖；脏 Worktree 清理 exit 3 且文件保留；干净后 `cleanup --delete-branch --execute` 双双 exit 0，分支与目录移除，主工作区 `git status` 前后完全一致。证据：`tmp/acceptance/agent-worktree-isolation/evidence/` |
| `npm run build` | **PASS**（exit 0，Vite 8.35s，2026-11-07） | `tsc --noEmit` + Vite 构建通过；主 bundle >500 kB 为既有提示。构建时共享工作区另有未提交改动，见验收报告的并发说明 |
| `node scripts/build-guard.mjs precheck` | **PASS**（exit 0） | 现有构建前置检查保持兼容；未创建任何 Rust 隔离缓存目录 |

### 规划整改二次验收：Rust 定向测试修复（2026-11-06）

| 检查 | 结果 | 证据 |
|---|---|---|
| `workflows::store::tests::scene_workflow_*`（5 用例） | **PASS** 5/5 | 原 `scene_workflow_nesting_is_bounded` 构造自相矛盾（同时要求 `depth(Scene0)≤3` 与 `depth(WF0)=depth(Scene0)>3`），已按「场景→关联工作流计层」口径重写；新增四层拒绝、工作流侧闭合、运行前校验、删除恢复、多入口共享子图 |
| `mcp::tests::feature_completed_is_user_only_and_submit_for_review_flow` | **PASS** | 原测试用 `planned` 状态提交超长说明，先命中状态冲突；现拆为 A–F（planned 冲突 / 超长回滚 / 合法提交 / completed 拒绝 / 过期 revision / 无残留），生产代码未改 |
| `commands::planning::tests::feature_agent_links_use_real_session_state_and_unlink_in_place` | **PASS** | 原测试重复插入迁移预置的 `agent_sources('codex')`；改为复用预置来源，断言目标不变 |
| shelf junction 相关 3 项 | **PASS** | 2026-11-06 19:26 全量 `cargo test --lib` 中 `orphan_cleanup_rejects_reparse_point_as_shelf_root` / `orphan_cleanup_skips_reparse_point_subdirectory` / `startup_part_cleanup_does_not_follow_junctions` 全部通过；此前 ENVIRONMENT BLOCKED 结论已不成立（当时 `cmd mklink /J` 创建失败） |
| `fs_safety::tests`（5 用例，含 `open_file_handle_prevents_delete_until_released`） | **PASS** 5/5 | 2026-11-06 19:45 定向 `cargo test --lib fs_safety::tests` 全部通过。根因是夹具文件位于共享临时目录根：`lock_category_directory` 以 DELETE 打开该目录时返回 Win32 错误 32（ERROR_SHARING_VIOLATION），函数按 fail-closed 返回 false（生产只锁定应用自管分类子目录）。夹具改为独立分类子目录，并新增正向对照、时间戳变化、文件缺失 3 个边界；生产实现未改。|
| `cargo test --lib`（全量） | **PASS** | 2026-11-06 20:11，**1386 passed / 0 failed / 6 ignored**，exit 0。前两次尝试因并行会话 `diagnostics/` 与 `resource_cleanup/storage.rs` 编译错误未进入测试阶段，非本任务改动 |

### Round 5 Agent 实时监控边界与事件生命周期（2026-11-06）

| 检查 | 结果 |
|---|---|
| Agent 定向 Vitest | **63 passed / 0 failed**（3 files：历史 Hook 生命周期、AgentPanel、agentTree；13:58，日志见 Round 5 验收目录） |
| 胶囊全量统计回归 | 新增用例 **1 passed / 62 skipped**（按测试名隔离执行，断言快照截断时显示真实状态/会话/轮次总数与分页提示） |
| `npm run build` | 最终复跑通过（14:22，`tsc --noEmit` + Vite，1874 modules，6.35s；主 bundle >500 kB 提示）。14:15 的中间复跑曾因并行编辑尚未补 `help` 字段而失败，随后字段补齐、最终构建通过 |
| `cargo test --lib agents:: -- --nocapture`（`src-tauri`） | **未执行到测试**：编译被共享工作区 `src/mcp/tools.rs:478`（`String` / `&str`）与 `:1052`（`AppError` / `ToolError`）两处错误阻断；日志见 `tmp/acceptance/historical-task-closure-round5/logs/agent-rust-tests-20261106.log` |
| `npx vitest run --maxWorkers=4` | 最终状态 **2552 passed / 19 failed，178 files passed / 5 failed**；失败集中在导航入口数量/可见性契约（18 项）和 `useScenarioStore.test.ts`（1 项），均为当前共享工作区导航/场景模块的并行改动，不触及 Agent。本轮定向 Agent 测试 63/63、胶囊统计用例 1/1 通过；子集复跑 `CapsulePanels` + `useNavigationStore` 为 82/82 通过 |
| Windows 桌面原生验收 | 本轮未执行：现有 Task Dock 实例与用户应用正在使用；不操作用户剪贴板、前台焦点或真实目标窗口。Round 4 证据只保留为历史，不并入本轮结论 |

本轮增加了有界实时快照统计、快照外 keyset 续页及共享历史事件监听的定向覆盖。Rust 高活动量新增用例源码尚未通过编译执行，真实 Windows Agent / 剪贴板 / 吸附 / 通知 / 音频验收仍待单独完成；完整范围与 O-1～O-8 现状见
[`historical-task-closure-round5/report.md`](../tmp/acceptance/historical-task-closure-round5/report.md)。

### Round 5 二次验收整改（2026-11-06 同日，followup）

| 检查 | 结果 |
|---|---|
| `cargo check --lib`（`src-tauri`） | **通过，退出码 0**（4 warnings，与本轮无关的资源清理/Workflows/Shelf/全局搜索未用变量）；历史 MCP 两处类型错误已消除 |
| `cargo test --lib agents::`（`src-tauri`） | **201 passed / 0 failed / 1 ignored**（含新增 stale 载荷 3 项）；覆盖 0/10/200/201 会话、300/301 轮次、1000 实时会话、10k 完成会话、跨来源、并发一致性 |
| Agent 前端契约专项 | **64 passed / 0 failed**（4 files：useAgentHistory 26、bridge.normalize 14、HistoryPanel 9、App 15）；覆盖单/多来源 stale、旧全局载荷、缺可选字段、非法载荷、changed=false、顺序/卸载/全局刷新 |
| 导航/场景复验（5 files） | **51 passed / 0 failed**；默认 11 可见 + 帮助隐藏、12 注册、设置底部锁定、场景单飞均与当前产品规则一致；历史 19 项失败已消除 |
| `npx tsc --noEmit` / `npm run build` | **均通过（退出码 0）**；Vite 5.53s，主 bundle >500 kB 提示（既有） |
| `npx vitest run --maxWorkers=4` | **2612 passed / 1 failed，183 files passed / 1 failed**（184 files）；唯一失败为 ClipboardPanel 离场卡片键盘用例在并行负载下 `removingCard() null`，单独复跑 **34/34 通过**（负载抖动，非本轮改动）；本轮 Agent 定向与导航/场景 5 文件均通过 |
| `cargo test --lib` 全量 | **1296 passed / 8 failed / 4 ignored**；8 项失败均在未触及的并行模块（fs_safety 2、shelf 3、resource_cleanup 1、workflows 1、mcp 1，均为断言/文件锁/符号链接语义），与 Agent 改动无关，单独复跑仍失败，列入遗留风险不冒充通过 |
| Windows 原生验收 | 未执行（用户实例占用，不扰动剪贴板/前台/窗口），`ENVIRONMENT BLOCKED` 单列 |

证据目录：`tmp/acceptance/historical-task-closure-round5-followup/logs/`；完整报告 `tmp/acceptance/historical-task-closure-round5-followup/report.md`。

#### 续验补充（同日 15:40–15:50）

- 场景单飞新增 5 项边界用例（get 失败释放、enter 失败释放、快速/异场景并发拒绝、成功不覆盖结果、删除清理）后 `useScenarioStore.test.ts` **8 passed / 0 failed**；并行 `workflows`/`mcp`/`shelf`  mid-edit 短暂不可编译期间 Agent 专项复跑中 `file_drop` 1 项负载抖动失败，隔离与随后的全量 `agents::` 复跑均通过（201/201）。
- `cargo test --lib` 续验更新为 **1305 passed / 6 failed / 4 ignored**：fs_safety 2 项 + resource_cleanup 1 项已由并行所有者修复；剩余 6 项为 `commands::planning` 唯一约束、`mcp` 断言含 "2000"、`workflows::store` 嵌套深度语义、`shelf` 3 项 junction 创建失败（`ENVIRONMENT BLOCKED`，fixture 路径），均未触及 Agent。
  > **2026-11-06 晚更正**：以上 6 项已全部处理——workflow 深度为测试构造矛盾（已重写 5 用例）、MCP 断言与 planning 唯一约束为测试前置条件错误、shelf junction 3 项已能创建并通过。见本文件顶部「规划整改二次验收」与最后一轮收尾记录。
- 前端复验 7 文件 **97 passed / 0 failed**（Agent 契约 26+14、场景 8、导航 51 一类合并）。

#### 复验收尾（15:53–16:16）

- 类型修复后 `npx tsc --noEmit` 0、`npm run build` 0（6.43s）、定向 48 passed；`cargo check --lib` 0。
- 性能 harness `snapshot_perf_measurement_10k_history_1k_live`（debug 内存库，10k 完成 + 1k 实时，n=20 两次复测）：snapshot p50 380–396ms、历史首屏 p50 60–65ms、liveOnly p50 308–371ms、groups p50 22–33ms；EXPLAIN 均为索引 SEARCH（`idx_sessions_origin_last`、`idx_sessions_origin_source_last_id`），无全表 SCAN。结论为 P2 后续优化项，debug 数字不代表生产延迟。
- 全量 Vitest 低负载（`--maxWorkers=2`）：**187 files passed，2647 passed / 0 failed，退出码 0**（305.5s，`logs/full-vitest-rerun2-20261106.log`），P2-03 以续跑全量通过收闭；此前 `--maxWorkers=4` 1 项抖动仍保留记录。

### 0.0.12 规划中心（多项目功能规划，v0.7，2026-11-03）

| 检查 | 结果 |
|---|---|
| `cargo check`（`D:/Develop/task_dock/src-tauri`） | 0（2026-11-03 15:0x，新增 `commands/planning.rs` 与迁移 v18 后） |
| `cargo test --lib`（同工作树） | **596 passed / 0 failed / 3 ignored**（2026-11-03 15:1x；ignored 为性能/真机套件，不计入通过）。含新增 `commands::planning` 7 项（项目 CRUD+级联、状态历史同事务与 completed_at 语义、步骤进度与统计、里程碑与跨项目守卫、历史分页、输入校验、日期三态）与 `commands::backup` 2 项（规划数据 full/quick 备份往返恢复、旧备份无 planning 表仍可恢复） |
| `cargo test --tests`（集成套件） | **ENVIRONMENT BLOCKED**：共享 target 链接受阻于运行中的 `task-dock.exe`（os error 5）；未执行，不冒充通过 |
| `npx tsc --noEmit` | 0（2026-11-03 16:3x） |
| `npx vitest run`（全量前端） | 931+ 通过；仅 `styles-themes.test.ts` 层叠上下文 1 项失败——`--z-toast(890) < --z-dialog(940)`，定义在 `styles-ui.css`（并行会话未完成工作，本轮 diff 无任何 `z-index`/`--z-*`，见范围外记录）；ClipboardDrawer/ClipboardPanel 3 项在全量并行下超时失败，单独重跑全部通过（负载性抖动） |
| 新增前端测试 | `usePlanningStore.test` 10 项（乱序防护/删除切换/就地更新/分页追加）、`PlanningCenterPanel.test` 13 项（双数据源切换/空态/概览/筛选/搜索/项目切换/新建/编辑失败保留输入/删除确认影响面/重试/步骤勾选反馈）、`FeatureRoadmapPanel.test` 16 项原样保留通过、`FullView.test` + `FullView.navigationContract.test` 随「规划中心」改名同步 |
| 生产构建 | 见验收报告（`tmp/acceptance/planning-center/report.md`） |

本轮发现并修复一处真机级缺陷：`ProjectsView` 空项目自动加载 effect 无限重发
`planning_list_projects`（空列表 + loading 归零使依赖反复成立），以挂载期请求标记修复，
测试中表现为进程不退出、真机为持续空转。

### 0.0.11 窗口圆角二轮整改（矩形区域 → CSS 像素支撑区域，2026-11-01 深夜）

| 检查 | 结果 |
|---|---|
| `cargo check`（`D:/Develop/task_dock/src-tauri`） | 0（2026-11-01 22:2x） |
| `cargo build`（隔离 `target-cornerfix`，绝对路径 `CARGO_TARGET_DIR`） | 0；当前工作树源码 debug 二进制 |
| `cargo test --lib window_shape`（HEAD 快照 + 最终 `window_shape.rs`） | **15 passed / 0 failed**（含真实 Win32 胶囊区域回读、`css_support_left` 实测对齐 15/13/11/9/7/3） |
| 共享工作树 `cargo test --lib window_shape` | **阻塞**：并行未完成的 `wing_outline_golden_points_match_frontend`（`window_shape.rs:1386-1387`，f64/i32）编译失败；非本轮改动 |
| 真机矩阵（125% DPI、隔离数据、置顶纯色背景 + 隐藏基线） | round5 13 场景全部 `baseline valid=True`、`region=00001`、四角精确点与 ±2px `delta=[0,0,0,0]`；覆盖灰 64/128/200、白/黑/洋红、dream/liquid × light/dark × solid/glass、active/inactive、600×800、最小化恢复 |
| 最终共享构建复采 | `final-*` 四场景（灰 64/200、洋红、liquid 灰 128）四角 delta 全部 0；四角外白色来自并行 UI 新增 1px 白色 `--window-edge`，非底层矩形 |
| 透明角命中（真实鼠标点击） | 四角精确点 `app_hit=False`；透明条 (5,5) False；可见弧 (10,10) 与中心 True |
| 未覆盖 | 100%/150% DPI 原生、Windows 10、多显示器、安装版；液态玻璃失焦短暂白边（8s 后平滑）；胶囊真机停靠由并行任务复验 |

证据：`tmp/acceptance/window-corner-unification/report-round2-20261101.md`、
`grey-20261101/`（round5/final 截图、json、crops、日志）、
`summary-round5-20261101.py`、`hit-test-round2-20261101.ps1`。

### 0.0.9 胶囊可见性与窗口状态修复（2026-11-01 晚）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误（`D:/Develop/task_dock`，2026-11-01 19:02，随 `npm run build` 执行） |
| `npx vitest run`（全量） | 49 文件 / **496 用例通过**（26.53s，2026-11-01 19:02） |
| `npm run build` | 通过（tsc + vite；1684 modules，7.33s，CSS 147.98 kB / gzip 23.89 kB） |
| `cargo build`（`src-tauri`） | 通过（2026-11-01 19:05，debug 二进制重新编译；当前 `window_shape.rs` 可编译） |
| `cargo test --lib window_shape` | **16 通过 / 0 失败**（0.03s，2026-11-01 19:05） |
| 真机（125% DPI、隔离数据、局部黑底 + CopyFromScreen + GetWindowRgn 回读） | 折叠单态区域：左 `0,75,70,450`、右 `430,75,500,450`、上 `62,0,437,70`、下 `62,535,437,605`；左展开 `0,0,500,525`；浅色/深色/液态玻璃胶囊均真实可见；解除吸附 **4/4** 恢复 500×700 整窗；`TASK_DOCK_WINDOW_REGION=0` 时保持完整主窗口（`no-region`），不进入透明胶囊态 |
| 修复前后像素（黑底采样，轨道中心） | 浅色修复前 `205,205,205`（根透明 + 86% alpha 卡片面），修复后 `253,254,255`；深色修复后 `38,40,56` 不透明（修复前仅 7.5% 白，等于消失） |
| 未覆盖 | 100%/150% DPI、Windows 10、多显示器/断连、右/上/下展开态、原生 mica/blur 后端矩阵 |

证据：`tmp/acceptance/capsule-visibility-fix/`（`report.md`、`raw/`、`final-*.log`）。
说明：0.0.8 的窗口轮廓结论保持有效；本节只追加胶囊表面不透明底、渲染门控、
重启恢复重试与解除后模式尺寸验证。

### 0.0.8 窗口圆角真机复核与主窗轮廓改造（2026-11-01 晚）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误（`D:/Develop/task_dock`，2026-11-01 18:09） |
| `npx vitest run`（全量） | 49 文件 / **494 用例通过**（31.82s） |
| `npm run build` | 通过（tsc + vite；1684 modules，9.80s，CSS 147.98 kB / gzip 23.89 kB） |
| `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` | 通过（0 warning） |
| `cargo test` | **490 通过 / 1 失败 / 3 ignored**；唯一失败是既有日期敏感测试 `actions::tests::ack_never_changes_agent_state_and_new_event_resurfaces`（新事件硬编码 2026-10-31，ack 用当前时间），`src/actions/` 本轮未改动；`navigation::router` 3 项本轮通过 |
| `window_shape` 单测 | 16 项通过（含矩形区域失效、CSS 圆角命中 100/125/150%、命中状态按 hwnd 隔离） |
| 真机（125% DPI、隔离数据、纯白/纯黑置顶背景 + CopyFromScreen） | dream/liquid × light/dark × solid/glass 四角均为**单条 CSS 抗锯齿弧**（50% 边界为小数像素），无透明月牙、无第二圈；region 探针为 `111111111 bounds=0,0,w+1,h+1`、DWM corner=1（DONOTROUND） |
| 状态切换 | 5 次尺寸抖动 → 600×800 后区域仍为整窗矩形、圆角平滑；最小化/恢复后同样；左缘停靠折叠/展开/收起三态区域与截图复测通过 |
| 未覆盖 | 100%/150% 原生渲染、Windows 10、多显示器（本机仅 125% 单屏）；透明角点击穿透（平台限制，见报告） |

证据：`tmp/acceptance/window-corner-unification/after/`（截图 + meta + 8x 四角放大）、
`tmp/acceptance/window-corner-unification/after/capsule/`（停靠三态）、
`tmp/acceptance/window-corner-unification/report.md`。
> 说明：0.0.7 记录的「区域半径内收 2px 已消除第二圈」在 0.0.8 真机复测中被推翻，
> 旧记录保留，以 0.0.8 为准。

### 0.0.7 综合修复与最终验收（圆角第二圈 / 区域提交 / 几何回滚 / Aero Snap，2026-11-01）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误（工作目录 `D:/Develop/task_dock`，2026-11-01 15:53） |
| `npx vitest run`（全量） | 49 文件 / **488 用例通过**（28.23s） |
| `npm run build` | 通过（tsc + vite；1684 modules，9.89s，CSS 147.85 kB / gzip 23.86 kB） |
| `cargo fmt --check`（`src-tauri`） | 通过（仅格式化 `window_shape.rs`，无逻辑改动） |
| `cargo clippy --all-targets -- -D warnings` | 通过（0 warning） |
| `cargo test` | **485 通过 / 4 失败 / 3 ignored**；4 项失败均与本次改动无关：3 项 `navigation::router` 为 `ENVIRONMENT-BLOCKED`（Windows 前台锁定拒绝置前），1 项 `actions::tests::ack_never_changes_agent_state_and_new_event_resurfaces` 为**既有日期敏感测试**（新事件硬编码 2026-10-31，ack 使用当前时间 2026-11-01，导致新事件被视为已确认）；`src/actions/` 本轮未改动 |
| 真机（125% DPI、隔离数据、纯黑置顶背景 + CopyFromScreen） | 主窗 dream/liquid、solid/glass(css) 四角均无白色/黑色第二圈；修复后角点出现 CSS 抗锯齿过渡像素 `(185,193,208)`；胶囊轨道/面板边缘平滑；重启恢复、点击展开、再次点击收起三态截图均真实 |
| 区域探针 | `GetWindowRgn` 包围盒 `0,0,500,700`，角点 `(3,3)` 不在区域、`(8,8)` 在区域；回读校验通过 |

证据：`tmp/acceptance/20261101-comprehensive-fix/report.md`、`raw/black-default.png`（修复前硬边）、
`raw/black-inset-final.png`、`raw/black-dwmonly.png`、`raw/capsule-collapsed-final.png`、
`raw/capsule-expanded-final.png`、`raw/capsule-collapse-after-expand.png`。

### 0.0.6 分类胶囊收尾（分类单一事实来源 / 停靠失败回滚，2026-11-01）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误（工作目录 `D:/Develop/task_dock`，2026-11-01 13:19） |
| `npx vitest run`（定向） | 5 文件 / **143 用例通过**（CapsuleDock / useEdgeSnap.integration / capsuleLayout / capsuleModel / edgeSnap，24.58s） |
| `npx vitest run`（全量） | 49 文件 / **478 用例通过**（20.43s） |
| `npm run build` | 通过（tsc + vite；1684 modules，7.71s，CSS 147.85 kB / gzip 23.86 kB） |
| 真机停靠三态（Win32 区域探针 + CopyFromScreen 截图） | 重启恢复 `bounds=0,162,70,537`（轨道 56×300 逻辑 / 70×375 物理）→ 点击轨道球展开 `bounds=0,87,500,612`（轨道 ∪ 面板，500×525 物理）→ 再次点击收起 `bounds=0,162,70,537`；三态截图均有真实面板内容，区域外为桌面，无整块底色 |
| Rust | 本轮未改 `src-tauri/`，未重跑 cargo（复用的调试二进制于 2026-11-01 10:44 构建） |

**测试用例语义变更**：`useCapsuleStore` 删除 `lastActive` / `ensureActive`，`active` 改为恒有值（收起不清空）。
`CapsuleDock.test.tsx` 相应用例由「兜底回填最近分类」改写为「收起后再展开保留同一分类」。
证据：`tmp/acceptance/capsule-docking-fix/`（report.md / lab.log / probe.log / 四张截图）。

### 0.0.5 停靠态极简（圆角细线/删除磁铁/拖拽解除）与白角滚动条诊断（2026-10-31）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误 |
| `npx vitest run` | **46 文件 / 441 测试通过**（新增：停靠中拖离 >24px 自动解除且不被拉回、≤24px 仍拉回齐平、程序移动不解除；细线四个方位与 hot/停靠/隐藏态渲染；主题令牌结构守卫补齐 `--radius-window`） |
| `npm run build` | 通过（tsc + vite；1674 modules，CSS 137.40 kB / gzip 22.25 kB） |
| `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings`（src-tauri） | 通过（0 warning） |
| `cargo test`（src-tauri） | **487 passed / 1 failed / 3 ignored**（`commands::system::tests` 4/4 通过，含 `win11_auto_backend_uses_css_when_region_clipping`）。唯一失败 `actions::tests::ack_never_changes_agent_state_and_new_event_resurfaces` 为**既有时间依赖用例**：硬编码新事件时间 `2026-10-31T10:00Z` 早于当前 `now`（11:30Z），与本次材质改动无关；单跑稳定复现，未改动该模块 |
| Dev WebView2（CDP 9223，隔离数据目录）滚动条诊断 | 全屏 400×560：任务/Agent/行动/剪贴板/历史 0 溢出；设置页 1 个真实滚动容器（2476/521）。紧凑 400×380、极简 280×140：0 个原生滚动条。340×340 窄窗：`rail-items` 231/229（只滚 2px 的幽灵滚动条）→ 收紧断点间距后消除；设置页滚动条改为透明轨道 + 6px thumb |
| 真机四角像素（受控背景 + CopyFromScreen + 隐藏窗口基线） | 修复前 liquid 深色 solid：角外 0 个暗像素（46–48 个仅因窗口阴影带偏离背景）；glass（blur）：角/弧带 102–104 个暗像素。修复后（默认后端 `css`，无原生材质）浅/深主题对角 0/2/4/6px 像素与背景逐值一致（如 `(0,0,0)`），内容从 8px 开始，暗楔消失；半径缝隙带已由 20px 对齐修复 |
| 前端材质状态 | `data-material=glass`、`data-native-glass=true`、`materialInfo.effect=css`、`osVersion=10.0.22631`（CSS 玻璃，原生模糊停用） |
| 真实鼠标拖拽解除手感 | ⬜ **ENVIRONMENT BLOCKED**：合成 `mouse_event` 注入未触发原生窗口移动（窗口位置不变），无法在本会话完成真机拖拽；引擎行为由集成测试覆盖 |

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
| `node scripts/layout-regression.mjs` | **38 组合全部达标**（2026-11-06）：导航清单按 `.rail-items` + `.rail-foot`（剔除动态「更多」）合并校验；新增**高度填充**断言（内容区 = 视口 − 标题栏，`.full-view` / `.rail` / `.tab-content` 与内容区同高，「设置」固定区贴底）与**导航显隐后高度稳定性**用例；无横向溢出、0 运行期错误 |
| 原生窗口取证（旧：`native-verify.ps1` + `check-corners.py`） | ❌ **结论已撤回**：旧方法只用 `region_probe` + 同帧自比，无法发现黑角；真机受控背景复测为 FAIL（glass 每角 44–45 暗像素、solid 半径 31.75 ≠ 22）。现行方法：`corner-lab.ps1` + `check-corners.py`（独立背景基线 + 四角像素 + `GetWindowRgn` 联合判定，缺基线返回 UNVERIFIED） |
| 修复后原生窗口验收 | ⬜ **UNVERIFIED**：本机会话锁定（LogonUI 运行），无法进行真实窗口取证；见 [ui-themes/12-v06-window-corners.md](ui-themes/12-v06-window-corners.md) |
| 未验证 | Windows 10 真机、100%/150% DPI、Dev 模式、拖动/贴边/托盘交互回归、长时间常驻资源曲线 |

关键回归点（详见 [ui-themes/11-test-results.md](ui-themes/11-test-results.md)）：

- **Escape 优先级**：确认框 > 子弹层 > 菜单 > 抽屉 > 主窗口，一次按键只关一层。
- **剪贴板侧边栏化**：完整模式八个导航入口（v0.7 起）；页面与关联抽屉共用 `ClipboardWorkspace`，
  底层只有一条 `onClipboardChanged` 监听（引用计数断言通过）。
- **日期时间数据完整性**：仅打开浮层不改值、不截断秒、截止与提醒互相独立。
- **快捷键**：Ctrl+1…8 顺序取自 `TAB_ORDER` 单一事实源；完整模式 Ctrl+Shift+C 切页，
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
| 100k 规模备份/恢复 | 通过：最终源码 backup 571ms / 61,877,483 B；restore 5,019ms；25 表逐行一致、500 资产/2 归档 SHA 一致；恢复峰值 WS 619.0MB（非流式，见 §4）**（2026-11-04 更正：注册表已扩到 43 表，恢复改为行落盘流式，峰值 54.9MB，见 §0.1）** |
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
  **2026-11-05 追加（导航测试门禁稳定性）**：为区分「产品窗口身份竞态」与「测试依赖外部桌面状态」，
  `src-tauri/src/navigation/router.rs` 做了两处最小抽取（不改产品行为）：
  1）窗口身份判定抽成纯函数 `same_window_identity` / `explicit_window_still_present`，
     并新增纯逻辑用例 `explicit_window_identity_ignores_title_and_checks_hwnd_pid_class`
     （标题变化不算身份变化；hwnd/pid/class 任一变化必须判为已变化），可在任意桌面运行；
  2）前台用例的前置条件改为「自建记事本窗口连续两次枚举身份一致」才进入导航
     （`wait_for_stable_owned_window`），不要求系统里只有一个记事本实例；
  失败分支会先断言「产品声称身份已变化时窗口是否仍可枚举」——窗口仍在才 panic（产品缺陷），
  窗口确实被系统重建则记 `env_blocked`（环境竞态，不伪装通过、也不放宽断言）。
  **执行前提**：交互式桌面登录（非锁屏/服务会话）、允许前台置前、无其他会话正在跑同类记事本用例
  （`NOTEPAD_TEST_LOCK` 已串行化同类用例）。
  **推荐命令**：单独跑 `cargo test --lib navigation::router::tests`（在 `src-tauri/` 内）；
  整仓回归再跑 `cargo test --lib`。锁屏或前台锁拒绝时按 `ENVIRONMENT BLOCKED` 记录，不标记通过。
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
$env:TASK_DOCK_SCALE_TEST="1"
cargo test --release --lib \
  commands::backup::tests::full_backup_100k_events_10k_notifications_roundtrip \
  -- --nocapture            # 100k 规模备份/恢复（约 11s 测试体，构建另计；未设置开关时快速跳过）
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

## 分类胶囊（v0.7，2026-10-31）

新增/改写的用例（全部随 `npx vitest run` 执行）：

| 文件 | 覆盖 |
|---|---|
| `src/lib/capsuleLayout.test.ts` | 胶囊常量契约（与 `window_shape.rs` 同步）、四边停靠位置与钳制、可见区域（物理像素）、DPI 换算、命中判定、容器补足 |
| `src/components/capsule/CapsuleDock.test.tsx` | 折叠只挂轨道、点击展开、再次点击收起、切换分类不重复展开、Esc 只收面板、徽标口径（0 不显示、waiting+failed 才计数）、四类空状态 |
| `src/components/capsule/format.test.ts` | 截止文案（逾期/今天/明天/月日）与待办排序 |
| `src/hooks/useEdgeSnap.integration.test.tsx` | 停靠贴边与撑容器、折叠/展开不改窗口几何、重启恢复、托盘唤回、拖离解除、关闭开关、候选超时、右缘停靠 |
| `src/components/SnapOverlay.test.tsx` | 仅拖拽相位渲染反馈；停靠相位不渲染覆盖层；反馈 1.2s 自动清除 |

Rust：`cargo test --lib` 覆盖 `capsule_regions`（四边 × 折叠/展开、DPI、退化钳制）与
真实（不可见）Win32 窗口上的 `SetWindowRgn`/`CombineRgn` 回读验证。

**真机验收未执行**：真实窗口的吸附手感、多显示器、DPI 125%/150%/200%、系统阴影与
透明区域未验证，不得以浏览器渲染或单测替代。详细口径见
[ui-themes/13-capsule-redesign.md](ui-themes/13-capsule-redesign.md) 与
`tmp/acceptance/capsule-redesign/report.md`。


## 停靠态可见性与启动显示门（v0.7，2026-11-02）

| 文件 | 新增覆盖 |
|---|---|
| `src/App.test.tsx` | 停靠外壳 DOM 契约：未停靠 / 折叠 / 展开 / 缺停靠边 四种状态下根节点 `is-capsule`、`.dock-app` 的 `inert`、`CapsuleDock` 挂载 |
| `src/styles-themes.test.ts` | `@layer` 顺序；`.dock-window.is-capsule` 最终规则必须落在 theme 层且清空 `background / background-image / border / box-shadow / border-radius`；`::before` 不绘制；`.dock-app` 隐藏；`.capsule-rail` 不得写矩形外观（背景/描边/阴影/圆角） |
| `src/hooks/useEdgeSnap.integration.test.tsx` | 启动显示门：无停靠记录立即放行；有记录必须**区域写入成功之后**放行且只放行一次；恢复连续失败仍放行；区域写入失败不得提前放行 |

真机口径（`tmp/acceptance/docked-window-hidden/`）：启动后用 250ms 采样
`GetWindowRgn`，任何一次都不得出现「包围盒 = 整窗」；停靠态以黑色背景截图做
区域外像素审计（`audit.py`，区域外每隔 2px 采样，要求与背景一致且无近白像素）。
2026-11-02 结果：12 张截图 0 越界；四边 × 明暗/玻璃、展开、解除、启动恢复均通过；
100%/150% DPI、Windows 10、多显示器、release 构建未验证。

## 快速捕获（v0.7，2026-11-03）

新增/改写的用例（前端随 `npx vitest run`，Rust 随 `cargo test`）：

| 文件 | 覆盖 |
|---|---|
| `src/capture/captureUtils.test.ts` | 五类型常量与未知值回落、单选组循环索引、链接识别与句末标点剥离、`suggestKind` 只建议（链接优先于时间词）、空/超长/首行标题校验、提交输入拆分（链接→url+note、`www.` 补协议）、备注截断、草稿状态机与文案、`formatClock`/`newClientId`/`formatError`；2026-11-11 增：`appendDictation`（中文直拼、ASCII 词界单空格、空片段 no-op、超限截断+overflow）、`voiceListeningMessage`（中文/回退语言/空语言） |
| `src/capture/CaptureApp.test.tsx` | 挂载同步 last_type 与空内容禁用保存、主题快照、切换类型立即保存草稿、方向键/Home/End 循环、建议不静默改类型、600ms 防抖且只展示后端确认时间、保存失败重试、失焦/`capture-flush-draft`/隐藏事件 flush、唤起恢复草稿提示、字数阈值、Ctrl+Enter 提交成功后约 500ms 隐藏、失败保留内容与同一 client_id、防重复提交、空内容拒绝、链接拆分提交、Esc 关闭、关闭按钮走 bridge、IME 组合中不提交；2026-11-11 增：语音启动/停止、临时结果只展示不写正文、定稿片段追加、错误状态回 idle、静音超时信息态、启动失败文案、关闭前停止语音、启动中取消补发停止、头部 drag-region DOM 契约（关闭按钮不参与）；2026-11-11 增：`PERMISSION_REQUIRED` 启动失败展示中文说明与「打开设置」入口、点击后调用 bridge 并提示重启 Task Dock、普通启动失败不显示该入口；录音态按钮图标由麦克风切换为暂停、idle 恢复麦克风；停止回包补发的定稿片段追加进正文、`stopping` 期间定稿事件不丢且状态事件不提前回 idle |
| `src/components/inbox/CaptureInboxPanel.test.tsx` | 加载未处理列表与类型/内容/时间渲染、筛选全部、复制（链接优先复制 URL）、转任务后移除并递减徽标、标记已处理、全部筛选下禁用处理操作、删除就地二次确认（取消/确认）、两种空态文案、加载失败重试、刷新当前筛选 |
| `src/lib/featureCatalog.test.ts` | 快速捕获登记为 implemented 且 verification 仍 unverified、能力/入口文本含独立捕获窗口/五类型/收集箱/幂等、partial 集合调整、全目录计数（2026-11-06 起为 31 = 13 implemented + 15 partial + 3 planned + 0 blocked；本行 v0.7 记录时点为 28 = 4 / 8 / 16 / 0，已被后续迭代覆盖） |
| `src/components/roadmap/FeatureRoadmapPanel.test.tsx` | partial 样例改为场景工作区、quick-capture 显示已实现横幅并给出现有入口 |

Rust：`cargo test --lib` 的 `quick_capture` 模块覆盖窗口定位（主屏居中、副屏 work_area 原点
偏移、DPI 缩放、工作区过小收缩、非法 scale 回退）、迁移 v17 建表/索引、五种类型落位、空/超长
内容拒绝且不落行、client_id 重复提交幂等（不重复建任务）、建任务失败回滚捕获行并保留草稿、
草稿保存/恢复/清空且不混入 items、标记已处理/删除/转任务、task/todo 建可查询任务、列表筛选与
limit 钳制、last_type 设置与 state。2026-11-11 增 `quick_capture::voice` 纯逻辑用例：会话结束
原因 → `idle/error` 与文案（自然结束不报错、麦克风/网络/语言失败可操作）、WinRT 结果状态分类、
状态事件载荷 camelCase 且不含正文；2026-11-11 增：隐私策略未接受（`0x80045509` /
`0x800455A0`）映射为 `PERMISSION_REQUIRED`（category permission、中文可操作文案且含重启指引），
其他引擎错误保留阶段上下文；`StartAsync` 异步失败通过 `GetResults()` 读取真实 HRESULT。

**真机验收未执行**：全局热键在真实 Windows 桌面的唤起、唤起前前台焦点恢复、DPI
125%/150%/200%、多显示器定位、置顶/任务栏层级与失焦隐藏未验证；jsdom 单测与浏览器渲染不能
替代。语音隐私恢复入口的真实 `ms-settings:privacy-speech` 打开、用户在设置中开启「在线语音
识别」以及开启后成功听写同样未验证（隔离预览只覆盖错误态与按钮调用）。停止补发的真实
时机（WinRT 是否在 `StopAsync` 中实际送出最后一句）必须真机录音验收；jsdom/预览只覆盖
前端收到补发片段后的追加与 stopping 状态机。全量 `cargo test` 本轮在 `src-tauri/target/debug/task-dock.exe` 被并行实例占用时失败
（os error 5），属环境阻塞，不作为通过证据。详细未验证项见
[quick-capture/README.md](quick-capture/README.md) 与
`tmp/acceptance/quick-capture/report.md`。

**2026-11-11 头部拖拽 / 语音输入（v0.7 增补）**：自动化只覆盖 DOM 契约、光标会话、语音状态机
与纯逻辑；**真实窗口拖动、WM_EXITSIZEMOVE 相位、麦克风录音与系统语音包必须真机验收**（通道
E/F）。隔离浏览器预览（通道 B）只验证布局与状态渲染，不代表原生窗口与系统音频。证据与未验证
项见 `tmp/acceptance/capture-drag-voice/report.md`。

## 智能日程提醒 2.0（2026-11-03）

新增/改写的用例（前端随 `npx vitest run`，Rust 随 `cargo test`）：

| 文件 | 覆盖 |
|---|---|
| `src/lib/sharedClock.test.tsx` | 页面级共享时钟：首个订阅只启动一条 1s interval、多订阅共用同一快照、最后一个退订后释放计时器 |
| `src/lib/format.test.ts` | `describeRecurrence` 旧规则语义不变 + 工作日 / 每月第 N 个 / 最后一个 / 每 N 月；`formatCountdown` >1h「时:分」、≤1h「分:秒」、到期与负值钳制 |
| `src/components/tasks/QuickReminder.test.tsx` | 预设 5/10/15/30/60 分钟、自定义时/分校验（1..1440）、创建成功 Toast 含真实提醒时间、失败弹真实错误、创建中防连点 |
| `src/components/tasks/ActiveReminders.test.tsx` | 无提醒不渲染、倒计时口径与已到期态、延后走 `snoozeReminder`、延后失败显示后端原因、重复任务不提供取消、已延后标记、卸载释放事件订阅 |
| `src/components/tasks/TaskEditor.test.tsx` | 高级每月模式（第 N 个 / 最后一个星期X / 最后一个工作日）、规则预览、非法组合拒绝、只改标题不清空重复规则 |
| `src/components/tasks/TaskItem.test.tsx` | 任务卡下次提醒时间与延后菜单（真实命令） |
| `src/notifications/*` | 任务提醒通知操作（查看 / 稍后 / 完成）与 `ref_id` 路由 |

Rust：`cargo test` 覆盖新建 5/30 分钟提醒、到期只触发一次、延后后旧时间不再触发、撤销恢复
与旧撤销失效、重复任务延后后仍推进、每两个月真隔两月、每周多日推进、每月第二个星期一、
每月最后一个工作日、2 月 28/29 与每月 31 日、跨年边界、重启补偿、已完成/已删除不产生幽灵
通知、并发延后/取消/领取、旧库重复规则兼容（迁移 v20 升级测试）。

**真机验收未执行**：任务页快捷提醒与倒计时在真实窗口的布局/双主题/320·400 窄窗、系统通知
弹窗与通知窗口按钮、休眠唤醒后真实补触发未验证；jsdom 单测与预览截图不能替代。

## 资源管理与智能清理（2026-11-06）

- 前端定向：仓库根执行 `npx vitest run src/components/settings/ResourceCleanupSection.test.tsx src/components/settings/AudioSettings.test.tsx src/lib/settingsSections.test.ts src/components/settings/SettingsPanel.test.tsx`，4 个文件、38 个用例通过，退出码 0；最新日志 `tmp/acceptance/resource-cleaner/frontend-focused-final3.log`。
- 完整前端构建：`npm run build` 退出码 0（TypeScript 检查与 Vite 生产构建通过）；最新日志 `tmp/acceptance/resource-cleaner/frontend-build-final3.log`。
- Rust 定向测试：`resource_cleanup::tests` 15/15、Shelf maintenance gate 1/1、`fs_safety::tests` 3/3 通过，退出码均为 0；日志分别为 `rust-resource-cleanup-final3.log`、`rust-shelf-maintenance-final2.log`、`rust-fs-safety-final.log`。`audio::cache::tests` 14/14 的可复核旧日志仍为 `rust-audio--cache--tests.log`。
- junction 复测：`shelf/tests.rs` 的测试辅助函数已改用 Windows `cmd.exe /S /C` 原始命令行引号；同参数隔离临时目录 smoke 创建 junction 并保留目标哨兵通过，日志 `junction-helper-smoke.log`。Rust `cargo test --lib reparse_point -- --nocapture` 在执行用例前被共享源码编译错误阻断，退出码 101：范围外 `src-tauri/src/mcp/bridge.rs:534` 调用不支持的 `JoinHandle::is_finished`；日志 `rust-reparse-point-final.log`。旧 `orphan_` 过滤仍是 7/9（两个失败在 junction 建立），日志 `rust-orphan-.log`。
- Rust 当前集成构建受共享工作树编译错误阻断：最新测试 crate 无法越过上述范围外 MCP 错误；不修改该文件，也不把之前通过的定向过滤扩展成当前全量通过结论。
- **2026-11-06 晚更正（规划整改收尾）**：上述「编译阻断」与 junction 旧结论已被新的全量运行覆盖——19:26 `cargo test --lib` 实际执行（1367 passed / 1 failed / 4 ignored），junction 3 项通过；唯一失败 `fs_safety` 于 19:45 以独立分类目录夹具修复（`fs_safety::tests` 5/5，生产实现未改）。旧日志与结论保留，仅作历史记录。
- Windows 原生 Tauri 页面、双主题/窄窗/高 DPI 走查未执行；DOM 测试不替代原生证据。资源清理当前结论见 `tmp/acceptance/resource-cleaner/report.md`。


## 文件投递失败诊断与 v47 迁移（2026-11-12）

- 根因夹具：真实文件库先应用迁移至 v46，再重建为旧版 `shelf_file_ops`
  `CHECK (op IN ('move'))`；重新打开触发 v47 后，复制 PNG 成功、源文件保留、历史未完成
  move 日志逐字段保留（`shelf::tests::drop_copy_png_on_legacy_schema_database_is_repaired_by_v47`）。
- Rust 定向（`src-tauri`，测试二进制直接执行）：
  - `v47` 过滤 3/3 通过：旧约束修复、保行 + 重复启动、异常行整体回滚；
  - `drop_` 过滤 37/37 通过（含日志写入故障注入、托管副本移动拒绝、父/子批次、冲突策略）；
  - `privacy` 8/8、`diagnostics::` 43/43；
  - 全量 `--test-threads=1 --skip "audio::tests::"`：**1596 passed / 0 failed / 8 ignored**
    （162.61s）。`audio::tests::` 6 项在整模块运行时于
    `engine_metadata_is_truthful_and_unavailable_engine_is_structural` 处稳定 SIGSEGV
    （单独运行该用例与 `audio::tts`/`audio::voice_packs` 全部通过）；该模块属其他任务的
    未提交 WIP（`audio/tts.rs` 仅可见性改动、`quick_capture/voice.rs` 新增），本次未修改，
    记为环境/范围外阻塞，不计为通过。
- 前端：`npm run build` 退出 0（TypeScript + Vite，日志 `npm-build-final-20261112.log`）。
- 前端全量：默认 `npm test` 在低内存环境 OOM（`MarkCompactCollector ... JS heap out of memory`）；
  按低内存配方 `npx vitest run --pool=forks --poolOptions.forks.singleFork --maxWorkers=1`
  得到 **231/233 文件、3483/3487 用例通过**；2 个失败文件
  （`CapsuleDragCursor.test.tsx` 3 项、`Popover.edge.test.tsx` 1 项）单独复跑
  **2/2 文件通过**，判定为全量长跑下的环境性抖动，与本任务改动无调用关系。
- 诊断可见性：`diagnostics::tests::shelf_drop_business_failure_reaches_anomaly_list_and_operation_chain`
  断言默认异常列表（WARN+、24h）、`operation_id` 操作链、错误码筛选均命中，
  且落盘内容不含路径/文件名。
- 未验证：真实 WebView2 下「查看诊断」跳转与操作链展示、320/400 窄窗三链接排版、
  真实 Tauri 实例重启后的 v47 迁移（未对用户正式库执行迁移）。
