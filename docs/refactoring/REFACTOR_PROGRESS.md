# 重构进度（REFACTOR PROGRESS）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（持续更新） |
| 最后更新 | 2026-11-19 |

---

## 阶段进度

| 阶段 | 状态 | 完成日期 | 交付物 |
|---|---|---|---|
| Phase 0 审计 | ✅ 完成 | 2026-11-19 | `CURRENT_STATE_AUDIT.md` |
| Phase 1 方案/规范/ADR | ✅ 完成（待评审） | 2026-11-19 | 架构/工程文档 15 份 + ADR 0002–0006 + 路线图/矩阵 |
| Phase 2 架构守卫 | ✅ 完成（报告模式） | 2026-11-19 | `scripts/architecture/*`（9 规则）+ 基线 + 8 单测；报告见 `tmp/acceptance/architecture-governance/phase2-architecture-guard/report.md` |
| Phase 3 基础设施重构 | 🔄 进行中（3.1 第一步完成） | 2026-11-19 | IPC 类型契约分离：bridge 7027→2785 行，新增 contracts/{models,navigation}.ts；导出 1028/64 零缺失；typecheck 0、137 测试过、守卫无新增。报告 `tmp/acceptance/architecture-governance/phase3-1-ipc-contracts/report.md` |
| Phase 4 业务模块重构 | ⏸ 未开始 | — | 按矩阵 |
| Phase 5 前端/移动治理 | ⏸ 未开始 | — | 按矩阵 |
| Phase 6 整体验收 | ⏸ 未开始 | — | 统一构建/测试/真机 |

## Phase 0 关键事实纠错记录

| 项 | 初报 | 复核后 | 依据 |
|---|---|---|---|
| 迁移版本 | v58（后端 Agent） | **v78** | `db/mod.rs` MIGRATIONS 末项 `MIGRATION_78`，混合内联+外部常量数组 |
| README 迁移 | v33 | 实 v78（README 过时） | 同上 |
| 备份表 | 43（README） | 实 143 | `backup.rs` `BACKUP_TABLES` 143 条 rule |
| 命令数 | 764 注册 | 803 宏 / 764 注册（39 差异待查） | `lib.rs:1283` vs 全库 grep |

## 门禁记录

- Phase 0 → Phase 1：通过（事实基线建立，未改业务代码）。
- Phase 1 → Phase 2：Phase 1 文档齐备（15 份架构/工程文档 + 5 ADR + 路线图/矩阵）；架构评审以本文档体系为输入，评审检查项见 `REFACTOR_ROADMAP.md` Phase 1 门禁。**说明**：本次按用户要求连续推进到 Phase 2；正式"架构评审签字"仍需人工确认，未以工具代替。
- Phase 2 → Phase 3：守卫基线已建立（head 7485d92，25 违规 / 23 例外 / 2 有效），单测 8/8；量具就绪，但**Phase 3 业务代码重构已冻结**，因门禁未满足（见 PHASE3_EXECUTION_PLAN.md §1）：
  - 基线 `npm run typecheck` 退出码 2（错误在他人 在途文件 `workbenchCloseGuard.ts:410`、`WorkbenchShell.tsx:1195-1196`，非本任务范围）；
  - 工作区多 Agent 并行修改、状态动态变化（UI 组件/services/closeTrace 等在途）；
  - 共享枢纽文件（bridge/lib.rs/db/mod.rs）所有权未锁定，架构评审未签字。
  解冻条件全部列于 PHASE3_EXECUTION_PLAN.md §1。此冻结是遵守用户"不因重构退化功能/不跳过评审/冲突暂停报告"原则，非跳过阶段。

## 在途工作保护记录

审计期间识别 22 个已修改文件 + 14 个未跟踪项（files-workspace / boot / workspace / personal-hub），全程只读未触碰。Phase 3+ 重构涉及其依赖文件（如 bridge 命令）时需先与其所有者协调。

## 变更日志

- 2026-11-19：Phase 0 审计完成；Phase 1 文档体系（15 文档 + 5 ADR + 路线图/矩阵）建立；Phase 2 架构守卫建立（9 规则 + 基线 + 8 单测），报告模式运行。
- 2026-11-19（续）：Phase 3.1 第一步完成——IPC 类型契约与实现分离。`bridge.ts` 7027→2785 行，新增 `contracts/models.ts`(4633) 与 `contracts/navigation.ts`(60)；nav 4 类型收进契约层消除类型环；公开导出 1028/64 零缺失；`tsc --noEmit` 0、137 项相关测试通过、架构守卫 25/active 2 与基线一致。同会话确认 `pipeline.rs` 的 tokio Mutex 跨 await 为正确设计，更正审计初判。
