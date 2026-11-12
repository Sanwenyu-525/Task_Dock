# 开发效率中枢——推进路线图

更新：2026-11-12（Round 1 开始时）。阶段划分遵循总任务书第七节（依赖序，不按功能编号）。

## Phase 0：工程审计与架构设计 ✅（Round 1 完成）

- [x] 现有能力审计（子智能体 C）：`tmp/acceptance/dev-efficiency-p1/audit-baseline.md`
- [x] 八功能复用面矩阵（审计报告 §对照表）
- [x] 数据契约：ARCHITECTURE.md §2–§8（迁移 v48 / 11 命令 / git 探测 / secret scan / 状态派生）
- [x] 持久迭代档案（本目录 6 文件）
- [x] 测试基线确认（vitest 239 文件、cargo test 需 dist、guard 脚本可用）

关键审计结论：上一轮「开发工作台 P0」（55288a8）已交付当前任务锚点 + DevWorkbenchPanel 骨架 +
Agent 状态区；其 missingFeatures（项目上下文关联、只读 Git 摘要、测试/构建结果归集）与八功能
①④③⑥ 缺口重合，Phase 1 直接在其上扩展，不新建页面、不重复实体。

## Phase 1：开发上下文与交接闭环（进行中）

目标闭环：识别项目 → 关联任务 → 生成任务包 → 关联 Agent → 收集执行结果 → 进入待验收。

| # | 任务 | 优先级 | 状态 |
|---|---|---|---|
| P1-1 | 迁移 v48（dev_projects / dev_handoff_packs / dev_acceptance_records）+ 设置键 workbench_current_project | P0 | Round 1 实现中 |
| P1-2 | 只读 git 探测模块 + 敏感扫描模块（devwork/git.rs、devwork/secrets.rs） | P0 | Round 1 实现中 |
| P1-3 | 11 个 dev_workbench 命令 + BACKUP_TABLES 登记 | P0 | Round 1 实现中 |
| P1-4 | DevWorkbenchPanel 三区块（现场 / 交接包 / 验收）+ TaskContextDrawer 入口 + TasksLite chip | P0 | Round 1 实现中 |
| P1-5 | acceptanceStatus 派生纯函数 + 全组件测试 | P0 | Round 1 实现中 |
| P1-6 | 闭环集成验证（链路 A/B/F 子集）+ 独立验收 | P0 | Round 1 待做 |
| P1-7 | 开发现场第三层识别（前台 IDE/进程元数据，需探针授权） | P2 | 未排期 |
| P1-8 | 交接包关联 Agent 会话快照（task_agent_links 取材） | P1 | Round 2 候选 |
| P1-9 | 验收工作台自动归集测试/构建结果（依赖功能⑥命令执行器） | P1 | Phase 2 后 |

## Phase 2：多 Agent 与开发环境协同（未开始）

- P2-1 任务↔Worktree 关联表 + 重叠文件检测（复用 worktree-guard check 语义，Rust 只读 git）
- P2-2 开发环境监控（服务/测试命令登记表 + 事件驱动状态机，参照 workflow_runs）
- P2-3 Git 协调视图（潜在冲突三类区分：已确认/潜在/仅重叠）

## Phase 3：问题复现与智能操作（未开始）

- P3-1 问题复现包实体（关联诊断 JSONL 事件，复用 privacy.rs 脱敏）
- P3-2 修复提示词 + 返工任务闭环（链路 C）
- P3-3 情境化快捷操作规则引擎（commandRegistry 白名单框架内，用户固定操作保护）

## Phase 4：工作现场增强恢复（未开始）

- P4-1 现场快照增加项目/分支关联（workspace v40 几何快照之上）
- P4-2 恢复前预览 + 部分恢复 + 逐项回执增强（workspace_restore 已有回执基座）

## Phase 5：联合验收（未开始）

八功能跨模块一致性、权限隐私、性能、真机验收清单执行。

## 真机验收待办池

- Round 1 交付后：真实 git 仓库探测（含 worktree）、胶囊 chip 显示、面板三区块、设置键持久化
  重启恢复、320/400 窄窗、深浅主题 × 两预设、中英文。
- 验收通道：C（CDP 真实 WebView2）为主，E（Win32/DWM）在涉及原生窗口行为时补。
