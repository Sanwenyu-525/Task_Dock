//! 小说工作空间专业后端（B2，2026-11-16）：人物档案 / 世界观设定 / 章节引用。
//!
//! ## 归属
//! 本文件由**小说线**独占编写；`commands/mod.rs` 的声明、`db/mod.rs` 的迁移登记、
//! `lib.rs` 的命令注册、`backup.rs` 的备份登记全部由集成负责人完成，本文件不得修改它们。
//!
//! ## 约定
//! - 迁移 DDL 写在本文件的 `MIGRATION_59` 常量里，由集成负责人已在 MIGRATIONS 末尾引用；
//!   修改 SQL 等于修改 v59 迁移，**只能在集成完成前**进行。
//! - 命令命名前缀 `novel_`，形参见 `project_workspace.rs`（`*_impl(db, ...)` + 薄 `#[tauri::command]`）。
//! - 所有写入必须经 `ensure_novel_project` 等价的门禁：`kind = novel` 且 `status = active`；
//!   读取允许归档项目（归档 = 只读）。
//! - 本文件不得删除或改写既有卷/章表结构（v58 已发布，不可改）。

/// v59：人物档案 / 世界观设定 / 章节引用（小说 B2）。
///
/// 允许的额外列、索引由本线决定；**不得在这里创建契约清单以外的表**，
/// 新增表必须先向集成负责人报名字，由其在 `backup.rs` 登记后再写。
pub const MIGRATION_59: (i64, &'static str) = (
    59,
    r#"
-- v59（小说 B2）：表结构由小说线在集成完成前填充。
-- 契约清单：novel_characters / novel_character_relations /
--           novel_worldview_entries / novel_entity_refs
"#,
);
