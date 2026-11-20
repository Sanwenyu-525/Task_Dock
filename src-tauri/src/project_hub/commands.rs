//! 项目中枢 IPC 命令面（v78）。
//!
//! 前端只通过这些命令读写项目事实；准备度/进度公式留在已测试的 TS 领域层。
//! 读写都可能等待 SQLite 写锁，必须离开 UI 主线程执行：同步命令会阻塞主线程，
//! 一旦另一个后台任务持有写连接并等待主线程，应用会直接进入 `Responding=False`。

use std::io::ErrorKind;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::service::{self, CreateProjectInput, ProjectHubSnapshot, ProjectSummary};

fn background_error(context: &str, error: tauri::Error) -> AppError {
    AppError::Unavailable(format!("{context}: {error}"))
}

#[tauri::command]
pub async fn project_hub_list_projects(
    db: State<'_, Arc<Db>>,
) -> AppResult<Vec<ProjectSummary>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service::list_projects(db.as_ref()))
        .await
        .map_err(|error| background_error("项目列表查询失败", error))?
}

#[tauri::command]
pub async fn project_hub_get_project(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ProjectHubSnapshot> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service::get_snapshot(db.as_ref(), &project_id))
        .await
        .map_err(|error| background_error("项目读取失败", error))?
}

#[tauri::command]
pub async fn project_hub_create_project(
    db: State<'_, Arc<Db>>,
    input: CreateProjectInput,
) -> AppResult<ProjectHubSnapshot> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service::create_project(db.as_ref(), input))
        .await
        .map_err(|error| background_error("项目创建失败", error))?
}

// ── 工作目录校验 ─────────────────────────────────────────────────────

/// 工作目录校验结果：前端 `src/lib/workspacePath.ts` 是唯一消费入口。
///
/// 只做语法与文件系统事实判断；**不 canonicalize、不回写用户输入**，
/// `path` 字段原样返回 trim 后的输入，避免路径大小写/短名在保存前被改写。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathStatus {
    /// empty / invalid / offline / not-directory / inaccessible / ok
    pub status: String,
    /// invalid 时给出原因：not-absolute / illegal-char
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl WorkspacePathStatus {
    fn none(status: &str) -> Self {
        Self {
            status: status.to_string(),
            reason: None,
            path: None,
        }
    }

    fn invalid(reason: &str) -> Self {
        Self {
            status: "invalid".to_string(),
            reason: Some(reason.to_string()),
            path: None,
        }
    }

    fn with_path(status: &str, path: &str) -> Self {
        Self {
            status: status.to_string(),
            reason: None,
            path: Some(path.to_string()),
        }
    }
}

/// Windows 绝对路径：盘符 `X:\`（或 `X:/`）或 UNC `\\`。与 `clean_root_path` 一致，
/// 只接受绝对路径，不接受盘符相对路径（`C:foo`）与普通相对路径。
fn is_absolute_workspace_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    let drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    drive_absolute || text.starts_with("\\\\")
}

/// 去掉盘符后检查非法字符（`<>:"|?*` 与控制字符）：这些字符无法在 Windows 创建目录。
fn has_illegal_workspace_chars(text: &str) -> bool {
    let rest = if text.as_bytes().get(1) == Some(&b':') {
        &text[2..]
    } else {
        text
    };
    rest.chars().any(|c| {
        c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')
    })
}

/// 工作目录校验执行体（纯函数，便于单测）。
pub fn workspace_path_check_impl(raw: &str) -> WorkspacePathStatus {
    let text = raw.trim();
    if text.is_empty() {
        return WorkspacePathStatus::none("empty");
    }
    if !is_absolute_workspace_path(text) {
        return WorkspacePathStatus::invalid("not-absolute");
    }
    if has_illegal_workspace_chars(text) {
        return WorkspacePathStatus::invalid("illegal-char");
    }
    match std::fs::metadata(text) {
        Ok(meta) if meta.is_dir() => WorkspacePathStatus::with_path("ok", text),
        Ok(_) => WorkspacePathStatus::with_path("not-directory", text),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            WorkspacePathStatus::with_path("offline", text)
        }
        // 权限不足、网络共享断连等一律按「不可访问」返回，不臆断为不存在。
        Err(_) => WorkspacePathStatus::with_path("inaccessible", text),
    }
}

/// 校验项目工作目录：语法检查 + 文件系统事实（是否存在 / 是否目录 / 是否可访问）。
///
/// `metadata` 在网络共享或断连盘上可能长时间阻塞，因此放到阻塞线程池执行，
/// 不占用 UI 主线程。返回结构见 [`WorkspacePathStatus`]。
#[tauri::command]
pub async fn workspace_path_check(raw: String) -> AppResult<WorkspacePathStatus> {
    tauri::async_runtime::spawn_blocking(move || Ok(workspace_path_check_impl(&raw)))
        .await
        .map_err(|error| background_error("工作目录校验失败", error))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 每个用例独立临时目录（q: tempfile 不在依赖里，自行创建并清理）。
    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "taskdock-workspace-path-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
    }

    #[test]
    fn workspace_path_empty_input() {
        assert_eq!(workspace_path_check_impl("").status, "empty");
        assert_eq!(workspace_path_check_impl("   ").status, "empty");
    }

    #[test]
    fn workspace_path_relative_is_not_absolute() {
        let result = workspace_path_check_impl("docs\\handoff");
        assert_eq!(result.status, "invalid");
        assert_eq!(result.reason.as_deref(), Some("not-absolute"));
        assert_eq!(result.path, None);
    }

    #[test]
    fn workspace_path_illegal_chars_rejected() {
        for raw in [r"C:\work\a?b", r"C:\work\a<b", r"C:\work\a|b", "C:\\work\\a\u{1}b"] {
            let result = workspace_path_check_impl(raw);
            assert_eq!(result.status, "invalid", "{raw}");
            assert_eq!(result.reason.as_deref(), Some("illegal-char"), "{raw}");
        }
    }

    #[test]
    fn workspace_path_missing_is_offline() {
        let dir = temp_dir("missing");
        let target = dir.join("not-created");
        let result = workspace_path_check_impl(target.to_string_lossy().as_ref());
        assert_eq!(result.status, "offline");
        assert_eq!(result.path.as_deref(), Some(target.to_string_lossy().as_ref()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_path_file_is_not_directory() {
        let dir = temp_dir("file");
        let file = dir.join("note.txt");
        std::fs::write(&file, b"x").expect("写临时文件失败");
        let result = workspace_path_check_impl(file.to_string_lossy().as_ref());
        assert_eq!(result.status, "not-directory");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_path_directory_is_ok() {
        let dir = temp_dir("dir");
        let result = workspace_path_check_impl(dir.to_string_lossy().as_ref());
        assert_eq!(result.status, "ok");
        // 不回写用户输入：原样返回（仅 trim）
        assert_eq!(result.path.as_deref(), Some(dir.to_string_lossy().as_ref()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
