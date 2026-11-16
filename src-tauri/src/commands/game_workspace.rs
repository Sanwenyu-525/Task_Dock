//! 游戏工作空间专业后端（G1，2026-11-16）：引擎识别 / 资源关联 / 构建与测试记录。
//!
//! ## 归属
//! 本文件由**游戏线**独占编写；`commands/mod.rs`、`db/mod.rs`、`lib.rs`、`backup.rs`
//! 由集成负责人维护，本文件不得修改它们。
//!
//! ## 约定
//! - 命令命名前缀 `game_`，形参见 `project_workspace.rs`。
//! - 所有写入门禁：`kind = game` 且 `status = active`；读取允许归档（只读）。
//! - 项目识别必须基于真实文件特征（`ProjectSettings/ProjectVersion.txt`、`*.uproject`、
//!   `project.godot` 等），识别失败返回「未知」，禁止猜测；手动指定由用户显式写入事实表。
//! - **不得执行任意外部命令**：本轮只做构建记录登记，不调用 Unity/Unreal/Godot 可执行文件。

/// v60：引擎识别事实 / 游戏资源 / 构建记录 / 测试记录（游戏 G1）。
pub const MIGRATION_60: (i64, &'static str) = (
    60,
    r#"
-- v60（游戏 G1）：表结构由游戏线在集成完成前填充。
-- 契约清单：game_project_facts / game_assets / game_builds / game_tests
"#,
);
