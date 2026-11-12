# 开发效率中枢（Developer Efficiency Hub）

Task Dock 八项开发效率能力的长期迭代档案。总任务书见 [MASTER_PROMPT.md](MASTER_PROMPT.md)（用户 2026-11-12 放置，
内容原样保留）；跨会话恢复入口见 [ITERATION_STATE.md](ITERATION_STATE.md)。

## 八项功能

1. 开发现场感知——识别当前项目 / 仓库 / 分支 / Worktree，与任务、Agent 会话关联
2. Agent 任务交接包——把任务与资料整理为可直接交给编程 Agent 的结构化 Markdown 包
3. 开发验收工作台——从开发任务到验收通过的闭环（状态派生、验收记录、返工提示词）
4. Git / Worktree 协调中心——多 Agent 并行开发时的 Git 工作环境只读协调与冲突预警
5. 智能问题复现包——诊断事件 → 脱敏问题包 → 修复提示词 → 复验记录
6. 开发环境监控——用户登记的开发服务与测试命令的状态归集（不扫描全机进程）
7. 情境化快捷操作——工具面板按真实上下文排序操作，复用命令面板体系
8. 工作现场增强恢复——在既有现场快照上增加项目 / 分支关联、恢复前预览与逐项回执

## 档案结构

| 文件 | 内容 |
|---|---|
| [MASTER_PROMPT.md](MASTER_PROMPT.md) | 总任务书（最高指令，不随迭代改写） |
| [ITERATION_STATE.md](ITERATION_STATE.md) | 当前阶段、功能状态矩阵、最近执行、下一轮任务清单（跨会话恢复入口） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 统一上下文概念模型、数据契约（表结构 / 命令 / DTO） |
| [ROADMAP.md](ROADMAP.md) | Phase 0–5 推进计划与各阶段任务分解 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收标准与各轮验收结果索引 |
| [DECISIONS.md](DECISIONS.md) | 重要设计决策（复用 vs 新建、边界取舍）及理由 |

## 硬约束（实现前必读）

- SQLite 迁移只在 `src-tauri/src/db/mod.rs` `MIGRATIONS` 末尾追加（当前 v47 之后）；新表必须登记
  `commands/backup.rs` 的 `BACKUP_TABLES`（未登记会被硬校验拦截）。
- 主窗口业务 IPC 统一经 `src/lib/bridge.ts`；参数 camelCase；新命令同步前端类型与 Rust 签名。
- Agent 不能把规划功能置为 completed（`mcp/tools.rs` 边界，只能 submit review）；自动化测试通过
  ≠ 人工验收通过；`completed` ≠ 验收通过。
- 只读协调优先：Git 合并 / rebase / stash / 删除等破坏性操作一律不做、不自动执行。
- 敏感内容（API Key / Token / 私钥 / 凭据）不得进入日志、验收证据与默认导出内容。
- 不新建平行的任务系统 / Agent 状态系统 / 诊断系统 / 命令面板；复用既有实体与注册中心。
