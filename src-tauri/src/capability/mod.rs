//! 知识与 AI 能力中心（v72）。
//!
//! 模块边界（与 `docs/ai-capability-center/技术架构与数据模型.md` 同源）：
//! - [`knowledge`]：知识库、文档、分块索引、检索与关联；
//! - [`skills`]：Agent Skills（SKILL.md）发现、解析、导入、风险标记；
//! - [`external_mcp`]：TaskDock 作为 MCP **Client** 管理外部 stdio Server；
//! - [`context`]：项目上下文配置与装配；
//! - [`recipes`]：能力配方定义与受限执行；
//! - [`commands`]：Tauri 命令薄壳。
//!
//! 安全边界（不可绕过）：
//! - 知识正文、Skill 内容、MCP 返回内容一律视为数据，不作为指令执行；
//! - 引用模式删除只删索引，绝不删除原文件；导入模式只删受管副本；
//! - 外部 MCP 仅支持 stdio，连接/调用强制超时并回收子进程；不记录 env 值、
//!   调用参数正文与返回正文；
//! - Agent 读取知识必须持有 `knowledge.read` 能力（全局或知识库级）。

pub mod commands;
pub mod context;
pub mod external_mcp;
pub mod knowledge;
pub mod recipes;
pub mod schema;
pub mod skills;
pub mod steps;

use crate::error::{AppError, AppResult};

/// 单个知识文档可索引的最大正文字节数（2 MiB）。超出按截断处理并记录原因。
pub const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;

/// 单个知识库的文档数上限（防止一次导入把库撑爆）。
pub const MAX_DOCUMENTS_PER_KB: i64 = 20_000;

/// 检索单次返回上限。
pub const MAX_SEARCH_LIMIT: u32 = 100;

pub(crate) fn now_iso() -> String {
    crate::agents::now_iso()
}

/// 名称/标题校验：去首尾空白、非空、字符数上限、禁止控制字符。
pub(crate) fn check_text(raw: &str, field: &str, max_chars: usize) -> AppResult<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if value.chars().count() > max_chars {
        return Err(AppError::Validation(format!(
            "{field}超过 {max_chars} 字符"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(AppError::Validation(format!("{field}含非法控制字符")));
    }
    Ok(value.to_string())
}

/// 项目引用校验：None/空串合法；非空必须存在且未删除。
pub(crate) fn check_project(conn: &rusqlite::Connection, project_id: Option<&str>) -> AppResult<Option<String>> {
    check_workspace_ref(conn, project_id, "项目")
}

/// 工作区引用校验。现有系统唯一的稳定 Workspace 身份是 `workspace_projects.id`
/// （项目工作空间），本轮直接复用，不新建重复表；非空必须真实存在。
pub(crate) fn check_workspace(conn: &rusqlite::Connection, workspace_id: Option<&str>) -> AppResult<Option<String>> {
    check_workspace_ref(conn, workspace_id, "工作区")
}

fn check_workspace_ref(
    conn: &rusqlite::Connection,
    id: Option<&str>,
    label: &str,
) -> AppResult<Option<String>> {
    let Some(id) = id.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_projects WHERE id = ?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(AppError::from)?;
    if !exists {
        return Err(AppError::Validation(format!("{label}不存在: {id}")));
    }
    Ok(Some(id.to_string()))
}

/// 知识库绑定归一：personal 清除全部绑定；project/workspace 必须真实存在。
pub(crate) fn normalize_kb_binding(
    conn: &rusqlite::Connection,
    kind: &str,
    project_id: Option<&str>,
    workspace_id: Option<&str>,
) -> AppResult<(Option<String>, Option<String>)> {
    match kind {
        "personal" => Ok((None, None)),
        "project" => {
            let project = check_project(conn, project_id)?;
            if project.is_none() {
                return Err(AppError::Validation(
                    "项目类型知识库必须选择真实项目".into(),
                ));
            }
            Ok((project, None))
        }
        "workspace" => {
            let workspace = check_workspace(conn, workspace_id)?;
            if workspace.is_none() {
                return Err(AppError::Validation(
                    "工作区类型知识库必须选择真实工作区".into(),
                ));
            }
            Ok((None, workspace))
        }
        other => Err(AppError::Validation(format!(
            "知识库类型非法: {other}（允许 personal|project|workspace）"
        ))),
    }
}

/// 按字符边界截断并补省略号。
pub(crate) fn truncate_chars(input: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if input.chars().count() <= max {
        return input.to_string();
    }
    if max == 1 {
        return "…".to_string();
    }
    let mut out: String = input.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// 生成安全的受管文件名：uuid + 规范化扩展名（只保留小写字母数字，≤12）。
pub(crate) fn managed_file_name(original: &std::path::Path) -> String {
    let ext = original
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    let id = uuid::Uuid::new_v4();
    if ext.is_empty() {
        id.to_string()
    } else {
        format!("{id}.{ext}")
    }
}

/// 知识受管目录根：`<data_dir>/knowledge`。
pub fn knowledge_root(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("knowledge")
}

/// Skill 受管目录根：`<data_dir>/skills`。
pub fn skills_root(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("skills")
}

/// SHA-256 十六进制摘要。
pub(crate) fn content_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_validation_rejects_empty_control_and_overlong() {
        assert!(check_text("  ", "名称", 10).is_err());
        assert!(check_text("a\u{0000}b", "名称", 10).is_err());
        assert!(check_text("12345678901", "名称", 10).is_err());
        assert_eq!(check_text(" 知识库 ", "名称", 10).unwrap(), "知识库");
    }

    #[test]
    fn truncate_is_char_boundary_safe() {
        assert_eq!(truncate_chars("abcdef", 4), "abc…");
        assert_eq!(truncate_chars("中文内容", 3), "中文…");
        assert_eq!(truncate_chars("ok", 4), "ok");
    }

    #[test]
    fn managed_name_never_contains_path_parts() {
        let name = managed_file_name(std::path::Path::new("C:/x/..\\evil.MD"));
        assert!(!name.contains('/') && !name.contains('\\') && !name.contains(".."));
        assert!(name.ends_with(".md"));
    }
}
