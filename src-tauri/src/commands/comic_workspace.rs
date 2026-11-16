//! AI 漫剧工作空间专业后端（C1，2026-11-16）：剧集 / 分镜 / 角色场景 / 产物版本。
//!
//! ## 归属
//! 本文件由**漫剧线**独占编写；`commands/mod.rs`、`db/mod.rs`、`lib.rs`、`backup.rs`
//! 由集成负责人维护，本文件不得修改它们。
//!
//! ## 约定
//! - 命令命名前缀 `comic_`，形参见 `project_workspace.rs`。
//! - 写入门禁：`kind = ai_comic` 且 `status = active`；读取允许归档（只读）。
//! - 素材只存**路径引用 + 元数据**，不复制用户原始文件；文件失效时返回可降级提示。
//! - AI 生成能力本轮**未接入**：只允许把镜头状态登记为 planned，禁止伪造已生成产物。

/// v61：剧集 / 分镜 / 角色 / 场景 / 素材版本（漫剧 C1）。
pub const MIGRATION_61: (i64, &'static str) = (
    61,
    r#"
-- v61（漫剧 C1）：表结构由漫剧线在集成完成前填充。
-- 契约清单：comic_episodes / comic_shots / comic_characters / comic_scenes /
--           comic_media_versions
"#,
);
