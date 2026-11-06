//! 一键工作流（v0.9）：把用户确认过的导航目标 / 任务创建 / 现场恢复编排为可重复执行的白名单序列。
//!
//! 安全边界（与 AGENTS.md 红线一致）：
//! - 步骤类型白名单见 [`StepType`]，CHECK 约束同时落在迁移 SQL 上；不支持任意
//!   Shell / PowerShell / 脚本下载执行，前端不能透传可执行路径；
//! - 导航类步骤只引用 `navigation_targets.id`，执行时由 router 重新校验目标；
//! - 参数在保存与执行时双重校验（保存时目标必须存在，执行时重新校验）；
//! - `enter_scene` 引用场景工作区真实服务；场景与工作流的嵌套图在保存和运行时校验，
//!   防止循环与过深嵌套。
//!
//! 模块分层：
//! - [`store`]：工作流 / 步骤 / 运行记录的持久化（事务保证，运行历史有保留上限）；
//! - [`engine`]：顺序执行引擎（暂停 / 取消 / 失败策略 / 幂等回执 / 事件推送）。

pub mod engine;
pub mod store;

use std::collections::{HashMap, HashSet};

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
    /// 进入已保存的场景（由场景工作区服务执行）。
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
            StepType::OpenApp
                | StepType::OpenUrl
                | StepType::OpenPath
                | StepType::EnterScene
                | StepType::RestoreWorkspace
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
    /// enter_scene：场景 ID。
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
                return Err(AppError::Validation(
                    "提醒提前分钟必须在 0~43200 之间".into(),
                ));
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
            let scene_id = params.scene_id.trim().to_string();
            if scene_id.is_empty() {
                return Err(AppError::Validation("「进入场景」步骤必须选择场景".into()));
            }
            if check_references {
                let exists: i64 = db.with_read(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM scenarios WHERE id = ?1",
                        [&scene_id],
                        |r| r.get(0),
                    )
                    .map_err(AppError::from)
                })?;
                if exists == 0 {
                    return Err(AppError::Validation(format!("场景不存在: {}", scene_id)));
                }
            }
            ValidatedStep::EnterScene { scene_id }
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

/// 场景与工作流之间最多允许三层「场景关联工作流」嵌套。
/// 单个 workflow run 仍由 engine 的全局槽保护；这里负责更早拒绝直接或间接循环。
pub const MAX_SCENE_WORKFLOW_DEPTH: usize = 3;

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
enum SceneFlowNode {
    Scene(String),
    Workflow(String),
}

fn validate_scene_flow_graph(
    db: &crate::db::Db,
    override_node: SceneFlowNode,
    override_edges: Vec<SceneFlowNode>,
) -> AppResult<()> {
    let workflow_edges = db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT workflow_id, step_type, params FROM workflow_steps WHERE enabled = 1",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let scene_edges = db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, linked_workflow_id FROM scenarios WHERE linked_workflow_id IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;

    let mut graph: HashMap<SceneFlowNode, Vec<SceneFlowNode>> = HashMap::new();
    for (workflow_id, step_type, raw_params) in workflow_edges {
        if step_type != StepType::EnterScene.as_str() {
            continue;
        }
        let params = serde_json::from_str::<StepParams>(&raw_params).unwrap_or_default();
        let scene_id = params.scene_id.trim();
        if !scene_id.is_empty() {
            graph
                .entry(SceneFlowNode::Workflow(workflow_id))
                .or_default()
                .push(SceneFlowNode::Scene(scene_id.to_string()));
        }
    }
    for (scene_id, workflow_id) in scene_edges {
        graph
            .entry(SceneFlowNode::Scene(scene_id))
            .or_default()
            .push(SceneFlowNode::Workflow(workflow_id));
    }
    graph.insert(override_node, override_edges);

    fn longest_nested_path(
        node: &SceneFlowNode,
        graph: &HashMap<SceneFlowNode, Vec<SceneFlowNode>>,
        visiting: &mut HashSet<SceneFlowNode>,
        memo: &mut HashMap<SceneFlowNode, usize>,
    ) -> AppResult<usize> {
        if visiting.contains(node) {
            return Err(AppError::Validation(
                "场景与工作流存在循环引用，无法保存或执行".into(),
            ));
        }
        if let Some(depth) = memo.get(node) {
            return Ok(*depth);
        }
        visiting.insert(node.clone());
        let mut depth = 0;
        for child in graph.get(node).into_iter().flatten() {
            let nested = if matches!(
                (node, child),
                (SceneFlowNode::Scene(_), SceneFlowNode::Workflow(_))
            ) {
                1
            } else {
                0
            };
            depth = depth.max(nested + longest_nested_path(child, graph, visiting, memo)?);
        }
        visiting.remove(node);
        if depth > MAX_SCENE_WORKFLOW_DEPTH {
            return Err(AppError::Validation(format!(
                "场景与工作流嵌套超过最大深度（{} 层）",
                MAX_SCENE_WORKFLOW_DEPTH
            )));
        }
        memo.insert(node.clone(), depth);
        Ok(depth)
    }

    let mut visiting = HashSet::new();
    let mut memo = HashMap::new();
    for node in graph.keys() {
        longest_nested_path(node, &graph, &mut visiting, &mut memo)?;
    }
    Ok(())
}

pub(crate) fn validate_scene_graph_for_workflow(
    db: &crate::db::Db,
    workflow_id: &str,
    scene_ids: &[String],
) -> AppResult<()> {
    validate_scene_flow_graph(
        db,
        SceneFlowNode::Workflow(workflow_id.to_string()),
        scene_ids
            .iter()
            .filter(|id| !id.trim().is_empty())
            .map(|id| SceneFlowNode::Scene(id.trim().to_string()))
            .collect(),
    )
}

pub(crate) fn validate_scene_graph_for_scene(
    db: &crate::db::Db,
    scene_id: &str,
    linked_workflow_id: Option<&str>,
) -> AppResult<()> {
    validate_scene_flow_graph(
        db,
        SceneFlowNode::Scene(scene_id.to_string()),
        linked_workflow_id
            .filter(|id| !id.trim().is_empty())
            .map(|id| vec![SceneFlowNode::Workflow(id.trim().to_string())])
            .unwrap_or_default(),
    )
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
