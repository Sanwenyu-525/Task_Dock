//! 通用工作空间专业后端（U1，2026-11-16）：里程碑 / 项目资料。
//!
//! ## 归属
//! 本文件由**通用线**独占编写；`commands/mod.rs`、`db/mod.rs`、`lib.rs`、`backup.rs`
//! 由集成负责人维护，本文件不得修改它们。
//!
//! ## 约定
//! - 命令命名前缀 `general_`，形参见 `project_workspace.rs`。
//! - 写入门禁：`kind = general` 且 `status = active`；读取允许归档（只读）。
//! - 里程碑与事项的关系必须是**弱引用**（引用 `workspace_items.id`），不得复制事项数据。
//! - 资料只存路径/链接/笔记引用，删除关联**不得删除原始文件**。

/// v62：里程碑 / 项目资料（通用 U1）。
pub const MIGRATION_62: (i64, &'static str) = (
    62,
    r#"
-- v62（通用 U1）：表结构由通用线在集成完成前填充。
-- 契约清单：general_milestones / general_materials
"#,
);
