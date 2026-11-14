# 开发效率中枢——验收标准与结果索引

各轮验收报告在 `tmp/acceptance/dev-efficiency-p1/`（目录被 .gitignore 忽略，本文件索引其结论）。
验收分级与结论口径遵循根 `AGENTS.md`「文档、验收产物与交付」（通过 / 部分通过 / 不通过 /
证据不足；环境阻塞单列）。

## Round 1（2026-11-12/13）：Phase 1 开发上下文与交接闭环 MVP ✅ 已集成 main（614411d）

- 范围：迁移 v48（dev_projects / dev_handoff_packs / dev_acceptance_records）、设置键
  `workbench_current_project`、只读 git 探测（devwork/git.rs）、敏感扫描（devwork/secrets.rs）、
  11 个 `dev_workbench` IPC 命令、DevWorkbenchPanel 三区块（现场 / 交接包 / 验收）、
  TaskContextDrawer 交接入口、TasksLite 现场 chip、featureCatalog 同步。
- 报告：`tmp/acceptance/dev-efficiency-p1/report-round1.md`（+ audit-baseline.md、
  acceptance-round1.md、logs/ 14 个原始日志）
- 结论：**部分通过**（自动化全绿；真机未验收）
  - cargo `--lib` 全量：**1654 passed / 0 failed / 8 ignored**
  - vitest 全量（worktree 最终）：**3632 passed / 0 failed**（242 文件）
  - `npx tsc --noEmit` 0 错误；`npm run build` exit 0
  - 独立验收（子智能体 C）：18 项验收组 17 PASS + 1 FAIL；P1-1（evidence 类型契约破裂）已修
    （2bec5e4）后复验通过；P2-1（交接包资料选择）与 P3-1（probe 级 git_unavailable e2e）登记 R2
  - 观察项：NavigationVisibility.integration 2 例全量并发下偶发（隔离恒过），登记 R2-2 稳定化
- 基线预存缺陷（归属 55288a8/a8e7908 链，本轮核实并按归属处理）：
  1. 目录计数契约漂移（32/15 vs 实际 33/16；核心分类 5→6、P0 优先级 5→6）——本轮与主树
     a8e7908 同义双修，合并冲突已按双方 diff 解决（cc52b2a + 4381267）
  2. CapsulePanels 3 / ClipboardLite 3 / InboxLite 2 / help health 1——本轮在纯净 HEAD 复现
     确证后，由主树 a8e7908（另一会话 2026-11-12 23:35）修复，经合并 4381267 获得复验通过
- 真机待验清单：真实 git 仓库探测 / worktree 识别 / 胶囊 chip / 三区块交互 / 设置键重启恢复 /
  320×400 窄窗 / 深浅主题 × 两预设 / 中英文（ROADMAP R2-1）。

## 验收硬标准（跨轮持续有效）

- 交接包：复制与保存内容一致；失败不丢编辑；敏感扫描不回显密文；无授权不外发。
- 验收工作台：验收历史不可无痕覆盖（只追加）；无测试证据不得显示成功；
  Agent completed ≠ 验收通过；自动化测试通过 ≠ 人工验收通过。
- 现场感知：识别失败显示未知，不伪造；禁用感知后不采集。
- 数据一致性：新表全部登记 BACKUP_TABLES；迁移只追加；派生状态不写回任务/规划状态字段。
