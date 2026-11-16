//! 开发工作空间专业后端（D1，2026-11-16）：开发任务接续 / Git 风险探测快照。
//!
//! ## 归属
//! 本文件由**开发线**独占编写；`commands/mod.rs`、`db/mod.rs`、`lib.rs`、`backup.rs`
//! 由集成负责人维护，本文件不得修改它们。**不得新建第二套开发工作台或构建队列**：
//! 一律复用 `dev_workbench.rs`（dev_projects / dev_handoff_packs / dev_acceptance_records）
//! 与既有构建调度器。
//!
//! ## 约定
//! - 新命令命名前缀 `dws_`（避免与既有 `dev_*` 命令冲突），形参见 `project_workspace.rs`。
//! - 写入门禁：`kind = development` 且 `status = active`；读取允许归档（只读）。
//! - Git / Worktree 探测**只读**：禁止 reset / stash / clean / checkout / merge / 强制推送。
//! - 风险提示只做「事实 + 明确提示」，不得自动消除冲突。

/// v63：开发任务关联 / 探测快照（开发 D1）。
pub const MIGRATION_63: (i64, &'static str) = (
    63,
    r#"
-- v63（开发 D1）：表结构由开发线在集成完成前填充。
-- 契约清单：dws_task_links / dws_workspace_probes
"#,
);
