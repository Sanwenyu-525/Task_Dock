# 开发效率中枢——验收标准与结果索引

各轮验收报告在 `tmp/acceptance/dev-efficiency-p1/`（目录被 .gitignore 忽略，本文件索引其结论）。
验收分级与结论口径遵循 AGENTS.md 第 10 节（通过 / 部分通过 / 不通过 / 证据不足；环境阻塞单列）。

## Round 1（2026-11-12/13）：Phase 1 开发上下文与交接闭环 MVP

- 范围：迁移 v48（dev_projects / dev_handoff_packs / dev_acceptance_records）、设置键
  `workbench_current_project`、只读 git 探测（devwork/git.rs）、敏感扫描（devwork/secrets.rs）、
  11 个 `dev_workbench` IPC 命令、DevWorkbenchPanel 三区块（现场 / 交接包 / 验收）、
  TaskContextDrawer 交接入口、TasksLite 现场 chip、featureCatalog 同步。
- 报告：`tmp/acceptance/dev-efficiency-p1/report-round1.md`（含命令、退出码、证据路径）
- 结论：**部分通过**（自动化全绿；真机未验收）
  - cargo `--lib`：全量通过（数字见报告，v48 迁移与 devwork/dev_workbench/settings 套件定向全绿；
    v47 夹具按版本号定位修复）
  - vitest：新前端 81/81 + 回归通过；全量数字见报告
  - `npm run build`（tsc --noEmit + vite build）：通过
  - 独立验收（子智能体 C）：见报告 §验收
- 基线预存缺陷（归属 55288a8 P0 合并，本轮不修、已核实 HEAD 复现）：
  1. `featureRoadmapContract.test.ts` 目录计数断言漂移（32/15 vs 实际 33/16）——**本轮已修**
     （契约以 featureCatalog 为事实源，P0 合并漏同步，一行断言更正并注明出处）
  2. `CapsulePanels.test.tsx` 3 例失败（任务编辑器跳转 `editor.open` 未置位：tests:360；
     应用面板两例「点加号进应用中心添加页」跳转目标断言）——**未修，登记为 P2 预存缺陷**，
     建议下一轮修复（涉及 P0 引入的 useUiStore tab/editor 联动）。
- 真机待验清单：见报告（真实 git 仓库探测 / worktree 识别 / 胶囊 chip / 三区块交互 /
  设置键重启恢复 / 320×400 窄窗 / 深浅主题 × 两预设 / 中英文）。

## 验收硬标准（跨轮持续有效）

- 交接包：复制与保存内容一致；失败不丢编辑；敏感扫描不回显密文；无授权不外发。
- 验收工作台：验收历史不可无痕覆盖（只追加）；无测试证据不得显示成功；
  Agent completed ≠ 验收通过；自动化测试通过 ≠ 人工验收通过。
- 现场感知：识别失败显示未知，不伪造；禁用感知后不采集。
- 数据一致性：新表全部登记 BACKUP_TABLES；迁移只追加；派生状态不写回任务/规划状态字段。
