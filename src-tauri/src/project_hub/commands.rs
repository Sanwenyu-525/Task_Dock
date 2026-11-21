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

use super::resources::{self, CapabilityResourceLink, ResourceCandidate, ResourceLinkInput};
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

// ── 统一项目创建（UI 快速创建） ──────────────────────────────────────

/// 快速创建请求：只描述「用户选了什么」，不重复任何业务规则。
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct InitialPlanCommand {
    #[serde(default)]
    pub goals: Vec<super::service::CreateGoalInput>,
    #[serde(default)]
    pub phases: Vec<super::service::CreatePhaseInput>,
    #[serde(default)]
    pub features: Vec<super::service::CreateFeatureInput>,
    #[serde(default)]
    pub tasks: Vec<super::service::CreateTaskInput>,
    #[serde(default)]
    pub capabilities: Vec<super::service::CreateCapabilityInput>,
}

#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateCommand {
    #[serde(default)]
    pub client_request_id: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub goal: String,
    pub target_date: Option<String>,
    pub template_id: Option<String>,
    pub root_path: Option<String>,
    /// metadata_only | attach_existing | create_new；缺省按「有路径 = 关联已有」推断。
    pub directory_mode: Option<String>,
    pub dev_project_id: Option<String>,
    pub note: Option<String>,
    pub plan_name: Option<String>,
    #[serde(default)]
    pub initial_plan: Option<InitialPlanCommand>,
    /// none | creator_project | creator_project_and_plan（本机人类创建时忽略）。
    pub agent_access_policy: Option<String>,
}

/// 统一创建入口：工作台快速创建与「另存为项目」都走这里。
///
/// 目录初始化可能涉及磁盘 IO（`create_new`），必须离开 UI 主线程。
#[tauri::command]
pub async fn project_create(
    db: State<'_, Arc<Db>>,
    input: ProjectCreateCommand,
) -> AppResult<super::creation::ProjectCreateResult> {
    let mode = match input.directory_mode.as_deref().map(str::trim) {
        None | Some("") => super::creation::DirectoryMode::default_for(
            input.root_path.as_deref().unwrap_or_default(),
        ),
        Some(raw) => super::creation::DirectoryMode::parse(raw).ok_or_else(|| {
            AppError::Validation(format!(
                "未知的 directoryMode：{raw}（允许 metadata_only | attach_existing | create_new）"
            ))
        })?,
    };
    let policy = match input.agent_access_policy.as_deref().map(str::trim) {
        None | Some("") => super::creation::AgentAccessPolicy::None,
        Some(raw) => super::creation::AgentAccessPolicy::parse(raw).ok_or_else(|| {
            AppError::Validation(format!("未知的 agentAccessPolicy：{raw}"))
        })?,
    };
    let draft = input.initial_plan.unwrap_or_default();
    let request = super::creation::CreateProjectRequest {
        client_request_id: input.client_request_id,
        name: input.name,
        kind: input.kind,
        description: input.description,
        goal: input.goal,
        target_date: input.target_date,
        template_id: input.template_id,
        root_path: input.root_path,
        directory_mode: mode,
        dev_project_id: input.dev_project_id,
        note: input.note,
        plan_name: input.plan_name,
        plan_description: None,
        plan_status: None,
        draft: super::creation::InitialPlanDraft {
            goals: draft.goals,
            phases: draft.phases,
            features: draft.features,
            tasks: draft.tasks,
            capabilities: draft.capabilities,
        },
        agent_access_policy: policy,
    };
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || super::creation::create(db.as_ref(), request))
        .await
        .map_err(|error| background_error("项目创建失败", error))?
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

// ── 项目资源（能力 ↔ 资源） ──────────────────────────────────────────

/// 可绑定资源候选：只返回当前项目作用域内真实存在的资源。
#[tauri::command]
pub async fn project_hub_resource_candidates(
    db: State<'_, Arc<Db>>,
    project_id: String,
    kind: Option<String>,
    query: Option<String>,
) -> AppResult<Vec<ResourceCandidate>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        resources::candidates(db.as_ref(), &project_id, kind.as_deref(), query.as_deref())
    })
    .await
    .map_err(|error| background_error("项目资源查询失败", error))?
}

/// 项目已关联资源清单。
#[tauri::command]
pub async fn project_hub_resource_links(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<Vec<CapabilityResourceLink>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || resources::links(db.as_ref(), &project_id))
        .await
        .map_err(|error| background_error("项目资源清单读取失败", error))?
}

/// 绑定资源到能力（幂等）。
#[tauri::command]
pub async fn project_hub_resource_link(
    db: State<'_, Arc<Db>>,
    project_id: String,
    input: ResourceLinkInput,
) -> AppResult<CapabilityResourceLink> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        resources::link(db.as_ref(), &project_id, input)
    })
    .await
    .map_err(|error| background_error("项目资源关联失败", error))?
}

/// 解除资源关联（只删关联，不删资源本体）。
#[tauri::command]
pub async fn project_hub_resource_unlink(
    db: State<'_, Arc<Db>>,
    project_id: String,
    link_id: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        resources::unlink(db.as_ref(), &project_id, &link_id)
    })
    .await
    .map_err(|error| background_error("项目资源解除关联失败", error))?
}

/// 重新校验资源可用性。
#[tauri::command]
pub async fn project_hub_resource_validate(
    db: State<'_, Arc<Db>>,
    project_id: String,
    link_id: String,
) -> AppResult<CapabilityResourceLink> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        resources::validate(db.as_ref(), &project_id, &link_id)
    })
    .await
    .map_err(|error| background_error("项目资源可用性校验失败", error))?
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
    /// invalid 时给出原因：not-absolute / unc / illegal-char
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

/// 工作目录校验执行体（纯函数，便于单测）。
///
/// 路径策略由 [`service::root_path_violation`] 唯一定义：只接受本地绝对路径，
/// 拒绝 UNC（`\\server\share`）、`\\?\` 扩展路径、盘符相对路径与非法字符。
/// 本函数只补充文件系统事实，不重复实现第二套语法规则。
pub fn workspace_path_check_impl(raw: &str) -> WorkspacePathStatus {
    let text = raw.trim();
    if text.is_empty() {
        return WorkspacePathStatus::none("empty");
    }
    if let Some(reason) = service::root_path_violation(text) {
        return WorkspacePathStatus::invalid(reason);
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
