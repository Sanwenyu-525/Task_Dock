# ITERATION_STATE —— 跨会话恢复入口

> 本文件是迭代状态记录（不是任务书）。总任务书原样保留在 [MASTER_PROMPT.md](MASTER_PROMPT.md)，
> 每次新执行先读本文件，不得从功能一重新开始。
> 最后更新：2026-11-13 02:2x（Round 1 已集成 main @ 614411d；Round 2a 已交付 worktree 分支
> 9384944，**集成被并行 WIP 阻塞**，见下）。

## 当前总体状态

- **当前 Phase**：Phase 1——Round 1 已集成；Round 2a（R2-3/R2-6）已交付待集成；R2-1/R2-2 未启动
- **开发 Worktree**：`D:\Develop\task_dock-worktrees\dev-efficiency-p1`，分支
  `agent/dev-efficiency-p1`，HEAD **9384944**（= 2bec5e4 + 48a189c(R2-6 后端) + 9384944(R2-3 前端)）
- **主树状态**：main @ 145d4c7 + **另一会话活跃 WIP 7 文件**（InboxDropPane*/InboxRecentShelf/
  fileDrop*/locales zh+en——暂存架任务），其中 **locales/zh-CN 与 en-US 与 Round 2a 分支重叠，
  `git merge` 会被未提交改动拒绝**。不得代提交、不得覆盖对方改动。
- **构建缓存**：`D:\Develop\task_dock\src-tauri\target-dev-efficiency-p1`（build-guard 已登记，
  Round 2 复用同 worktree 可继续用；整体收尾时 `build-guard cleanup --dir <该目录> --execute`）
- **验收报告**：`tmp/acceptance/dev-efficiency-p1/report-round1.md`（+ Round 2a 节、
  audit-baseline.md、acceptance-round1.md、logs/ 原始日志）
- **注意**：本仓库并行会话活跃（本轮期间 main 已 6 次前进 + 暂存架 WIP 进行中）。开工必须重新
  `git status` + `git log` 对照。

## 八功能状态矩阵（实现状态 / 验证状态 分列）

| # | 功能 | 实现 | 验证 | 本轮变化 |
|---|---|---|---|---|
| ① | 开发现场感知 | **implemented(MVP)**：项目登记/当前选择/git 只读探测/worktree 识别/胶囊 chip | partially_verified（自动化全绿；真机未验） | Round 1 交付 |
| ② | Agent 任务交接包 | **implemented(MVP)**：12 节模板/敏感扫描/版本化保存/复制 | partially_verified（同上） | Round 1 交付 |
| ③ | 开发验收工作台 | **implemented(MVP)**：追加式验收记录/派生状态/返工提示词与返工任务 | partially_verified（同上） | Round 1 交付 |
| ④ | Git/Worktree 协调中心 | in_progress(0%)：仅 git 探测的 worktree 识别就位 | unverified | – |
| ⑤ | 智能问题复现包 | not_started | – | – |
| ⑥ | 开发环境监控 | not_started | – | – |
| ⑦ | 情境化快捷操作 | not_started | – | – |
| ⑧ | 工作现场增强恢复 | not_started（workspace v40 为基座） | – | – |

## Round 1 交付清单（已集成 main）

**提交链**：a2fd8e1(后端) → 36ef332(前端) → cc52b2a(目录计数契约同步) → 4381267(merge main，
与另一会话 a8e7908 的同义修复冲突已解) → 2bec5e4(独立验收 P1-1 修复+i18n) → 614411d(merge main
集成) → ddaeadb(档案)。

- 后端：迁移 v48 三表四索引；`workbench_current_project` 设置键；`devwork/git.rs` 只读探测
  （2s 超时、CREATE_NO_WINDOW、只读白名单）；`devwork/secrets.rs` 六类敏感扫描（不回显原文）；
  11 个 dev_workbench 命令；BACKUP_TABLES/EXTENDED/generic_sql 三处登记。
- 前端：DevWorkbenchPanel 三区块（DevProjectContext / DevHandoffSection / DevAcceptanceSection）、
  TaskContextDrawer「生成交接包」入口、TasksLite 项目 chip、acceptanceStatus 派生函数、
  bridge 10+1 包装、locales zh/en +149 key、featureCatalog core.dev-workbench 同步。
- 集成修复：shelf v47 夹具按版本号定位（v48 追加的必然碎裂）；featureRoadmapContract/
  FeatureRoadmapPanel 计数同步（与 a8e7908 同义双修）。

## 验证状态（最终口径，全部真实输出）

- cargo `test --lib` 全量：**1654 passed / 0 failed / 8 ignored**
- vitest 全量（worktree 最终）：**3632 passed / 0 failed**（242 文件）
- cargo 定向合并后（主树+worktree 各一次）：36/36；`npx tsc --noEmit` 0 错；`npm run build` exit 0
- 独立验收（子智能体 C）：18 项验收组 17 PASS，P1-1 修复后转通过；报告 acceptance-round1.md
- 真机：**NOT VERIFIED**（清单见 ACCEPTANCE.md；ROADMAP R2-2）
- 观察项：NavigationVisibility.integration 2 例全量并发下偶发（4 次全量=败/过/败/过，约 50%
  复现率；隔离恒过；与 P1-1 修复无因果）——logs/vitest-main-postmerge2.log 为第 4 次全绿记录；
  已登记 R2-2 稳定化。

## 下一轮任务清单（编号稳定，按优先级；完成不删除，标记 ✅）

- **R2-0（P0，立即）**：集成 Round 2a（worktree 9384944）到 main——前置条件：暂存架会话提交其
  locales WIP。步骤：`worktree-guard check` 确认无重叠 → 主树 `git merge --no-ff
  agent/dev-efficiency-p1` → 合并后 vitest 全量 + cargo 定向复测 → 更新本文件
- **R2-1（P1）**：Round 1 真机验收（通道 C/E：真实 git 仓库+worktree 探测、胶囊 chip、三区块、
  设置键重启恢复、320/400 窄窗、深浅主题 × 两预设、中英文），报告补真机节
- **R2-2（P1）**：NavigationVisibility.integration 2 例偶发失败根因定位与稳定化（先根因，
  不调等待时间掩盖；5 次全量=败/过/败/过/败，隔离恒过）
- **R2-3（P1）✅**：交接包「资料选择」补齐——已交付 worktree 9384944（DevHandoffSection 18/18、
  bridge 补 notesList 只读包装、zh/en +11 key、tsc 0 错；全量 vitest 3638/1=已知偶发、
  cargo 1655/0/8），待 R2-0 集成
- **R2-4（P2）**：交接包关联 Agent 会话快照（task_agent_links 取材，链路 A 后半段）
- **R2-5（P2）**：验收工作台「从 Agent 执行轮次生成待验收项」（链路 B：agent 完成 → 待验收）
- **R2-6（P2）✅**：probe 级 git_unavailable 端到端测试——已交付 worktree 48a189c
  （probe_with_program 测试缝，devwork 20/20，生产零行为变化）
- **R2-7（P2）**：Phase 2 预研启动——Worktree 关联表 + 重叠文件检测（复用 worktree-guard
  check --json 语义）；开发环境监控登记表设计（服务/测试命令，参照 workflow_runs 状态机）
- **R2-8（P3）**：开发现场第三层识别可行性调研（前台 IDE 进程元数据，需探针授权，先方案后实现）

## 阻塞与风险登记

- 16GB 内存压力：cargo 必须 `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0` + 任务专属 target；
  vitest 全量若 OOM 用 singleFork 法（记忆 task-dock-low-memory-build-diagnostics）
- **junction 穿透删除事故已固化**：`git worktree remove --force` 会穿透 node_modules junction
  清空目标（本轮两次事故各赔一次 npm ci）；删前必须先 `cmd /c rmdir <junction>`（记忆
  task-dock-worktree-isolation）
- 并行会话活跃：每次开工重新对照 git 状态；bridge.ts/locales/styles.css/featureCatalog 是
  高频重叠面，合并前必跑 `worktree-guard check`
- 真机验收未做：整体结论保持「部分通过」，不得宣称八功能完成

## 恢复检查点（下一执行从这里开始）

1. 读本文件 + 主树 `git status`/`git log`（确认是否有并行会话新提交）
2. 决定 Round 2 工作位置：若主树干净且无并行迹象，可直接用主树 + 新 worktree 二选一
   （跨模块任务仍建议一任务一 Worktree：`node scripts/worktree-guard.mjs create --task <task>`）
3. 从 R2-1 开始执行（真机验收可用现有隔离实例配方：记忆 task-dock-cdp-instance-isolation）
4. Round 2 结束时：更新本文件 + ACCEPTANCE.md + tmp/acceptance/<task>/report-round2.md
5. 全部八功能收尾时才回收 build-guard 缓存与 worktree（cleanup 默认 dry-run）
