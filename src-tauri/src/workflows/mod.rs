//! 一键工作流（v0.9）：把用户确认过的导航目标 / 任务创建 / 现场恢复编排为可重复执行的白名单序列。
//!
//! 安全边界（与 AGENTS.md 红线一致）：
//! - 步骤类型白名单见 [`StepType`]，CHECK 约束同时落在迁移 SQL 上；不支持任意
//!   Shell / PowerShell / 脚本下载执行，前端不能透传可执行路径；
//! - 导航类步骤只引用 `navigation_targets.id`，执行时由 router 重新校验目标；
//! - 参数在保存与执行时双重校验（保存时目标必须存在，执行时重新校验）；
//! - `enter_scene` 类型已登记，但场景工作区模块尚未集成：校验层一律拒绝并注明依赖，
//!   绝不伪造场景启动结果。
//!
//! 模块分层：
//! - [`store`]：工作流 / 步骤 / 运行记录的持久化（事务保证，运行历史有保留上限）；
//! - [`engine`]：顺序执行引擎（暂停 / 取消 / 失败策略 / 幂等回执 / 事件推送）。

pub mod engine;
pub mod store;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 步骤类型白名单（与迁移 v23 的 CHECK 约束一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepType {
    /// 打开应用或激活已有窗口（导航目标类型必须为 application）。
    OpenApp,
    /// 打开网页（导航目标类型必须为 url）。
    OpenUrl,
    /// 打开文件或目录（导航目标类型必须为 file / directory）。
    OpenPath,
    /// 创建任务（标题 / 描述 / 优先级 / 可选提醒时间）。
    CreateTask,
    /// 进入场景（依赖场景工作区模块，未集成前校验层拒绝）。
    EnterScene,
    /// 恢复工作现场（用户显式选择的快照，走恢复门禁）。
    RestoreWorkspace,
}

impl StepType {
    pub fn as_str(&self) -> &'static str {
        match self {
            StepType::OpenApp => "open_app",
            StepType::OpenUrl => "open_url",
            StepType::OpenPath => "open_path",
            StepType::CreateTask => "create_task",
            StepType::EnterScene => "enter_scene",
            StepType::RestoreWorkspace => "restore_workspace",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open_app" => Some(StepType::OpenApp),
            "open_url" => Some(StepType::OpenUrl),
            "open_path" => Some(StepType::OpenPath),
            "create_task" => Some(StepType::CreateTask),
            "enter_scene" => Some(StepType::EnterScene),
            "restore_workspace" => Some(StepType::RestoreWorkspace),
            _ => None,
        }
    }

    /// 中文标签（前端展示与错误消息共用，避免两处漂移）。
    pub fn label(&self) -> &'static str {
        match self {
            StepType::OpenApp => "打开应用 / 激活窗口",
            StepType::OpenUrl => "打开网页",
            StepType::OpenPath => "打开文件或目录",
            StepType::CreateTask => "创建任务",
            StepType::EnterScene => "进入场景",
            StepType::RestoreWorkspace => "恢复工作现场",
        }
    }

    /// 是否会抢夺桌面焦点（需要与工作现场恢复互斥的步骤）。
    pub fn is_desktop_affecting(&self) -> bool {
        matches!(
            self,
            StepType::OpenApp | StepType::OpenUrl | StepType::OpenPath | StepType::RestoreWorkspace
        )
    }
}

/// 失败后策略：stop = 停止后续步骤；continue = 记录失败并继续。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnError {
    Stop,
    Continue,
}

impl OnError {
    pub fn as_str(&self) -> &'static str {
        match self {
            OnError::Stop => "stop",
            OnError::Continue => "continue",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "stop" => Some(OnError::Stop),
            "continue" => Some(OnError::Continue),
            _ => None,
        }
    }
}

/// 步骤参数（JSON 存储；字段全部可选，按 step_type 结构化校验）。
///
/// 不使用 serde tagged enum：编辑对话框需要部分填写也能保存草稿以外的完整校验
/// 由 [`validate_step`] 负责，这里只做「类型安全反序列化」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StepParams {
    /// open_app / open_url / open_path：navigation_targets.id。
    #[serde(default)]
    pub target_id: String,
    /// create_task：任务标题（必填）。
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// create_task：优先级 0..=3（缺省 2）。
    #[serde(default)]
    pub priority: Option<u8>,
    /// create_task：提醒时间（RFC3339，可选）。
    #[serde(default)]
    pub remind_at: Option<String>,
    /// create_task：提醒提前分钟（≥0，可选）。
    #[serde(default)]
    pub advance_minutes: Option<i64>,
    /// restore_workspace：workspace_snapshots.id。
    #[serde(default)]
    pub snapshot_id: String,
    /// enter_scene：场景 ID（模块未集成，仅保留参数位）。
    #[serde(default)]
    pub scene_id: String,
}

/// 校验后的强类型步骤（执行器输入）。
#[derive(Debug, Clone)]
pub enum ValidatedStep {
    OpenNav {
        target_id: String,
    },
    CreateTask {
        title: String,
        description: String,
        priority: u8,
        remind_at: Option<String>,
        advance_minutes: i64,
    },
    EnterScene {
        scene_id: String,
    },
    RestoreWorkspace {
        snapshot_id: String,
    },
}

/// 步骤保存 / 执行共用的校验入口。
///
/// `check_references = true` 时校验目标 / 快照在库中真实存在（保存与执行都必须）。
pub fn validate_step(
    db: &crate::db::Db,
    step_type: &str,
    params: &StepParams,
    check_references: bool,
) -> AppResult<(StepType, ValidatedStep)> {
    let ty = StepType::parse(step_type)
        .ok_or_else(|| AppError::Validation(format!("未知步骤类型: {}", step_type)))?;
    let validated = match ty {
        StepType::OpenApp | StepType::OpenUrl | StepType::OpenPath => {
            let target_id = params.target_id.trim().to_string();
            if target_id.is_empty() {
                return Err(AppError::Validation(format!(
                    "「{}」步骤必须选择导航目标",
                    ty.label()
                )));
            }
            if check_references {
                let t = crate::navigation::target_resolver::get_target(db, &target_id)?
                    .ok_or_else(|| {
                        AppError::Validation(format!("导航目标不存在: {}", target_id))
                    })?;
                let expected = match ty {
                    StepType::OpenApp => "application",
                    StepType::OpenUrl => "url",
                    _ => "file|directory",
                };
                let ok = match ty {
                    StepType::OpenApp => t.target_type == "application",
                    StepType::OpenUrl => t.target_type == "url",
                    _ => t.target_type == "file" || t.target_type == "directory",
                };
                if !ok {
                    return Err(AppError::Validation(format!(
                        "「{}」步骤要求 {} 类型的目标，实际为 {}",
                        ty.label(),
                        expected,
                        t.target_type
                    )));
                }
            }
            ValidatedStep::OpenNav { target_id }
        }
        StepType::CreateTask => {
            let title = params.title.trim().to_string();
            if title.is_empty() {
                return Err(AppError::Validation("任务标题不能为空".into()));
            }
            if title.chars().count() > 200 {
                return Err(AppError::Validation("任务标题超过 200 字符".into()));
            }
            if params.description.chars().count() > 2000 {
                return Err(AppError::Validation("任务描述超过 2000 字符".into()));
            }
            if let Some(p) = params.priority {
                if p > 3 {
                    return Err(AppError::Validation("优先级必须是 0~3".into()));
                }
            }
            if let Some(remind) = &params.remind_at {
                if !remind.trim().is_empty() {
                    chrono::DateTime::parse_from_rfc3339(remind.trim()).map_err(|_| {
                        AppError::Validation(format!("提醒时间格式非法: {}", remind))
                    })?;
                }
            }
            let advance = params.advance_minutes.unwrap_or(0);
            if !(0..=60 * 24 * 30).contains(&advance) {
                return Err(AppError::Validation("提醒提前分钟必须在 0~43200 之间".into()));
            }
            ValidatedStep::CreateTask {
                title,
                description: params.description.trim().to_string(),
                priority: params.priority.unwrap_or(2),
                remind_at: params
                    .remind_at
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                advance_minutes: advance,
            }
        }
        StepType::EnterScene => {
            // 场景工作区由其他子任务开发；接口稳定并经验证前，此类型一律拒绝执行。
            // 绝不为了工作流功能伪造场景启动结果或另建场景表。
            return Err(AppError::Validation(
                "「进入场景」依赖场景工作区模块，该模块尚未集成，步骤暂不可用".into(),
            ));
        }
        StepType::RestoreWorkspace => {
            let snapshot_id = params.snapshot_id.trim().to_string();
            if snapshot_id.is_empty() {
                return Err(AppError::Validation(
                    "「恢复工作现场」步骤必须选择快照".into(),
                ));
            }
            if check_references {
                let exists: i64 = db.with_conn(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM workspace_snapshots WHERE id = ?1",
                        [&snapshot_id],
                        |r| r.get(0),
                    )
                    .map_err(AppError::from)
                })?;
                if exists == 0 {
                    return Err(AppError::Validation(format!(
                        "工作现场快照不存在: {}",
                        snapshot_id
                    )));
                }
            }
            ValidatedStep::RestoreWorkspace { snapshot_id }
        }
    };
    Ok((ty, validated))
}

// ── 行结构 ──────────────────────────────────────────────────

/// 工作流行（列表用，含步骤计数）。
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub sort_order: i64,
    pub step_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
}

/// 步骤行。
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowStepRow {
    pub id: String,
    pub workflow_id: String,
    pub step_type: String,
    pub params: StepParams,
    pub display_order: i64,
    pub enabled: bool,
    pub on_error: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 运行记录行。
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRunRow {
    pub id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub status: String,
    pub current_step_index: i64,
    pub total_steps: i64,
    pub completed_steps: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

/// 运行步骤回执行。
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRunStepRow {
    pub id: String,
    pub run_id: String,
    pub step_id: String,
    pub step_type: String,
    pub display_order: i64,
    pub status: String,
    pub detail: String,
    pub result: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub operation_id: String,
}

/// 运行详情（运行头 + 逐步骤回执）。
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRunDetail {
    #[serde(flatten)]
    pub run: WorkflowRunRow,
    pub steps: Vec<WorkflowRunStepRow>,
}

/// 运行历史分页。
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRunPage {
    pub items: Vec<WorkflowRunRow>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

/// 步骤编辑输入（保存时整表替换）。
#[derive(Debug, Clone, Deserialize)]
pub struct StepInput {
    /// 前端生成的稳定 ID；为空时由后端生成。
    #[serde(default)]
    pub id: String,
    pub step_type: String,
    #[serde(default)]
    pub params: StepParams,
    #[serde(default = "crate::workflows::default_true")]
    pub enabled: bool,
    #[serde(default = "default_on_error")]
    pub on_error: String,
}

fn default_on_error() -> String {
    "stop".to_string()
}

pub(crate) fn default_true() -> bool {
    true
}

impl StepInput {
    /// 校验并规范化（含引用存在性检查）。
    pub fn validate(&self, db: &crate::db::Db) -> AppResult<(StepType, ValidatedStep)> {
        if self.on_error.is_empty() {
            return Err(AppError::Validation("on_error 不能为空".into()));
        }
        OnError::parse(&self.on_error)
            .ok_or_else(|| AppError::Validation(format!("未知失败策略: {}", self.on_error)))?;
        validate_step(db, &self.step_type, &self.params, true)
    }
}

/// 新建 / 更新工作流的输入。
#[derive(Debug, Clone, Deserialize)]
pub struct WorkflowInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 新建时可同时携带步骤（模板场景）；更新时步骤走 replace_steps。
    #[serde(default)]
    pub steps: Vec<StepInput>,
}

pub(crate) fn check_workflow_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(AppError::Validation("工作流名称不能为空".into()));
    }
    if n.chars().count() > 60 {
        return Err(AppError::Validation("工作流名称超过 60 字符".into()));
    }
    Ok(n.to_string())
}

pub(crate) fn check_workflow_description(desc: &str) -> AppResult<String> {
    if desc.chars().count() > 300 {
        return Err(AppError::Validation("工作流描述超过 300 字符".into()));
    }
    Ok(desc.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_type_roundtrip_and_labels() {
        for ty in [
            StepType::OpenApp,
            StepType::OpenUrl,
            StepType::OpenPath,
            StepType::CreateTask,
            StepType::EnterScene,
            StepType::RestoreWorkspace,
        ] {
            assert_eq!(StepType::parse(ty.as_str()), Some(ty));
            assert!(!ty.label().is_empty());
        }
        assert_eq!(StepType::parse("shell"), None);
        assert_eq!(StepType::parse("powershell"), None);
    }

    #[test]
    fn step_params_deserializes_partial_and_ignores_unknown() {
        let p: StepParams =
            serde_json::from_str(r#"{"target_id":"t1","unknown_key":123}"#).unwrap();
        assert_eq!(p.target_id, "t1");
        assert_eq!(p.title, "");
        assert!(p.priority.is_none());
    }

    #[test]
    fn on_error_parsing_rejects_unknown() {
        assert_eq!(OnError::parse("stop"), Some(OnError::Stop));
        assert_eq!(OnError::parse("continue"), Some(OnError::Continue));
        assert_eq!(OnError::parse("retry"), None);
    }

    #[test]
    fn desktop_affecting_types_cover_focus_steppers() {
        assert!(StepType::OpenApp.is_desktop_affecting());
        assert!(StepType::RestoreWorkspace.is_desktop_affecting());
        assert!(!StepType::CreateTask.is_desktop_affecting());
    }
}
