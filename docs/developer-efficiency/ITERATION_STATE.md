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
| ② | Agent 任务交接包 | **implemented(MVP)**：12 节模板/敏感扫描/版本化保存/复制/绑定 Agent 会话（v50） | partially_verified（同上） | Round 1 交付；U2-01（2026-11-14） |
| ③ | 开发验收工作台 | **implemented(MVP)**：追加式验收记录/派生状态/返工提示词与返工任务/Agent 完成轮次人工待验收（v50） | partially_verified（同上） | Round 1 交付；U2-02（2026-11-14） |
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
2. 决定 Round 2 工作位置：文件与资源不冲突时直接在主树共享并行；需要独立分支/稳定基线复现
   时才按 `AGENTS.md` §3.3 创建 Worktree（`node scripts/worktree-guard.mjs create --task <task>`）
3. 从 R2-1 开始执行（真机验收可用现有隔离实例配方：记忆 task-dock-cdp-instance-isolation）
4. Round 2 结束时：更新本文件 + ACCEPTANCE.md + tmp/acceptance/<task>/report-round2.md
5. 全部八功能收尾时才回收 build-guard 缓存与 worktree（cleanup 默认 dry-run）

## 2026-11-14（主树 · 效率中枢 V2 / U2）—— R2-4、R2-5 已实现

> 本节记录主树交付，不覆盖上面 worktree 分支的历史状态；统一任务矩阵见
> [../efficiency-hub/TASK_MATRIX.md](../efficiency-hub/TASK_MATRIX.md) §6。

- **R2-4 → U2-01（交接包绑定 Agent 会话）**：迁移 v50 给 `dev_handoff_packs` 加
  `agent_source_id` / `agent_session_external_id`（弱引用，无外键），保存时校验会话真实存在；
  读时 LEFT JOIN `agent_sessions` 派生标题与 `available`；版本列表展示「会话：…」与失效标记。
  前端候选来自 `agent_history_sessions(includeLive=true, limit=20)`，可搜索，不按标题猜身份。
- **R2-5 → U2-02（Agent 完成轮次 → 人工待验收）**：v50 给 `dev_acceptance_records` 加三元组
  来源列；新增只读命令 `dev_acceptance_agent_runs`，候选＝本任务 `task_agent_links` ∪ 本任务
  交接包绑定会话的 `completed` 轮次（`origin='real'`），标注 user/auto/handoff；已登记轮次带
  结论仍返回。**结论必须人工选 verdict + summary 才 INSERT**；服务端校验来源三元组真实存在；
  Agent 完成事件仍只通知、不改任务状态、不自动验收。
- **测试**：Rust `commands::dev_workbench` 21/21、`db::tests::v4*` 5/5（含 v50 升级保留旧行）；
  Vitest 交接包 22/22、验收 23/23、工作台外壳 25/25。测试 exe 仍需按 `docs/TESTING.md` 的
  mt.exe 清单工装运行（本机依赖组合的既有限制，非本轮代码）。
- **未验证**：Windows 真机（Agent 完成后候选出现、登记变已验收、会话删除失效展示）。
- **未做**：Agent 侧从会话打开交接包；U2-03 真实测试日志引用；失败轮次问题排查入口。

## 2026-11-14（主树 · U0：唯一大型完整工作台）

> 本节记录架构收敛；不覆盖上方 worktree 历史。统一矩阵见
> [../efficiency-hub/TASK_MATRIX.md](../efficiency-hub/TASK_MATRIX.md) §7。

- **窗口职责**：`main` = Quick Surface Host（胶囊/贴边/快速操作/工作台入口），`workspace`
  = 唯一 Full Workbench Host（全部完整功能页）。没有第三个大型窗口；辅助窗口不变。
  `workspace` 沿用 v49 label、几何持久化与关闭语义。
- **外壳**：新增 `src/workbench/WorkbenchShell.tsx`（左栏/顶栏/内容宿主/右栏/错误边界/
  路由保活/布局持久化）、`WorkbenchHome`（无项目首页）、`WorkbenchContextPane`；
  旧 `WorkspaceApp` 的项目内容迁入 `ProjectWorkspacePanel`，`WorkspaceApp` 只做组合。
- **导航协议**：`workbench_open_window` / `workbench_take_nav` / `workbench_nav_ack`
  （客户端预生成 requestId、入队+事件快路径、拉取去重、四态回执、pending 最终态、
  12s 超时）；胶囊/主面板 → 工作台不再「打开窗口即成功」。
- **宿主解绑**：`windowHost.ts` 角色 + `WorkbenchPageActiveContext`；`useMainUiVisible` /
  `useFullViewVisible` 在工作台内不再依赖主窗口 mode/贴边相位；隐藏但保活的页面暂停
  消费者刷新；快捷键作用于本窗口。
- **布局**：新增设置键 `workbench_layout`（路由/项目/右栏/宽度，v1）；后端结构校验，
  前端逐字段降级、串行写入；`navigation_layout` 与项目 `layout_json` 不变、不清空。
- **权限**：workspace capability 仍只有 event/dialog/opener；微件显示/隐藏/重置允许
  main/workspace，快照发布仍仅 main；capability 契约测试锁定不复制主窗口权限。
- **Phase D（主窗口收敛，2026-11-14）**：主窗口完整模式中开发工作台、项目工作空间、
  应用、微件、手机互传、工作流、历史、规划、帮助、诊断、资源 11 个大型管理页不再挂载
  原面板，统一渲染 `WorkbenchHandoff`（摘要 + 在完整工作台中打开）；点击走
  `workbench_open_window` 并落到对应路由。任务/Agent/行动/剪贴板/收集与暂存仍属快捷面，
  设置仍是主窗口窗口/外观配置入口；导航显隐/排序、Ctrl+数字语义与旧数据不变。
- **测试（最终树）**：Vitest 全量 **270 文件 / 4078 passed / 0 failed**（单 worker，
  677.79s，`tmp/acceptance/efficiency-hub-u0/vitest-full-final.log`）；`npm run build`
  （tsc + vite）exit 0（5.58s）。Rust 全量（排除已知 audio::tests 组崩溃）**1854 passed /
  2 failed / 8 ignored**；2 个失败均在并行任务文件（`shelf_tags` 未登记备份策略、
  virtual_display 参数断言），隔离复跑仍失败，不属 U0 改动；`audio::tts` +
  `audio::voice_packs` 18/18、`audio::tests` 6 项逐项通过。U0 定向 Rust
  工作台 9 / 设置 13 / 微件 11 全过。
- **原生冒烟（隔离实例，2026-11-14，最终二进制）**：胶囊四边停靠（left/right/top/bottom
  几何与轨道方向）、展开/收起、胶囊直接入口打开工作台、WM_CLOSE 后胶囊继续可用并重开；
  工作台 19 路由逐页渲染、任务栏 `WS_EX_APPWINDOW`、最大化/恢复；草稿确认条、取消保留
  草稿、确认后切页、项目上下文只在确认后提交、持久化任务未被修改；Phase D 9 个入口
  原生点击与跳转。1180×760 @125% DPI 单屏（CSS 944×608）。
- **原生阶段发现并修复**：StrictMode 拉取后丢弃（take 改 peek-until-ack）、事件丢失后
  等聚焦（Rust 页面 ping）、`.wb-body` 与开发工作台既有类冲突导致内容区/右栏纵向堆叠
  （外壳改名 `wb-workarea`）、944 CSS 三栏主内容仅 392px（右栏阈值改 1000）、页面重载
  期间积压请求（拉取改为逐条拉空）、Rust 提前写活跃项目导致取消导航仍改上下文
  （删除原生预写，统一由外壳确认后提交）、工作台不读任务/Agent/行动数据（启动一次性读取）。
- **未完成/环境受限**：多显示器（本机仅 1 屏）、150%/200% DPI（固定 125%，改系统缩放会
  影响并行会话）、2K/4K 逐页视觉/键盘走查、Phase E 游戏/AI 漫剧专业闭环（仍只有事项阶段）；
  迁移前性能基线未测，当前仅有迁移后采样（胶囊隐藏 0.00 CPU-s/10s；工作台空闲
  0.13 CPU-s/10s；开关 3 轮关闭后 845–868MB，未观察到单调增长，不宣称无泄漏）。

