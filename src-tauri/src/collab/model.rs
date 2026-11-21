//! 协作中心的公共数据模型。
//!
//! 与前端 `src/lib/collab.ts` 的字段一一对应（camelCase）；枚举以字符串存储，
//! 服务层负责白名单校验，读取时不做隐式归一（避免把非法历史数据“修正”成合法）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const ISSUE_KINDS: &[&str] = &[
    "feature",
    "improvement",
    "architecture",
    "performance",
    "security",
    "tech_debt",
    "bug",
    "other",
];
pub const ISSUE_STATUSES: &[&str] = &[
    "open",
    "triaged",
    "in_progress",
    "resolved",
    "verified",
    "closed",
    "archived",
];
pub const PRIORITIES: &[&str] = &["P0", "P1", "P2", "P3"];
pub const PLAN_STATUSES: &[&str] = &[
    "draft",
    "in_review",
    "changes_requested",
    "approved",
    "developing",
    "accepting",
    "completed",
    "archived",
];
pub const VISUAL_KINDS: &[&str] = &[
    "flowchart",
    "architecture",
    "dataflow",
    "prototype",
    "bug_annotation",
    "static_image",
    "diff",
];
pub const EVIDENCE_KINDS: &[&str] = &[
    "screenshot",
    "log",
    "stack",
    "video",
    "report",
    "test",
    "other",
];
pub const ISSUE_LINK_RELATIONS: &[&str] = &["related", "duplicate", "blocks", "caused_by"];
/// 创作来源（与 `source` 入口维度正交）。
pub const AUTHORING_MODES: &[&str] = &[
    "manual",
    "ai_generated",
    "ai_assisted",
    "agent_authored",
    "imported",
];
/// 可视化资产（图片）类型白名单。
pub const VISUAL_ASSET_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
/// 单次受控读取上限：图片以 base64 进入 WebView，超过 8 MiB 的图会明显卡顿。
pub const MAX_VISUAL_ASSET_READ_BYTES: u64 = 8 * 1024 * 1024;
/// 导入上限与读取上限保持一致：不允许「导入成功但永远无法预览」的资产。
pub const MAX_VISUAL_ASSET_BYTES: u64 = MAX_VISUAL_ASSET_READ_BYTES;

pub const MAX_TITLE: usize = 200;
pub const MAX_DESCRIPTION: usize = 20_000;
pub const MAX_SOLUTION: usize = 200_000;
pub const MAX_STEPS: usize = 30;
pub const MAX_FILES: usize = 50;
pub const MAX_EVIDENCE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_TEXT_EVIDENCE_BYTES: usize = 1024 * 1024;
pub const PAGE_MAX: i64 = 100;
pub const CONTEXT_PAGE_MAX: i64 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

impl<T> Page<T> {
    pub fn new(items: Vec<T>, total: i64, page: i64, page_size: i64) -> Self {
        Self {
            items,
            total,
            page,
            page_size,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub impact: String,
    pub priority: String,
    pub status: String,
    pub acceptance: String,
    pub repro_steps: Vec<String>,
    pub expected_result: Option<String>,
    pub actual_result: Option<String>,
    pub environment: Option<String>,
    pub related_files: Vec<String>,
    pub resolution: String,
    pub assignee: String,
    pub dedupe_key: String,
    pub source_agent: String,
    pub source_session: String,
    pub source: String,
    pub revision: i64,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueInput {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub impact: String,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub acceptance: String,
    #[serde(default)]
    pub repro_steps: Vec<String>,
    #[serde(default)]
    pub expected_result: Option<String>,
    #[serde(default)]
    pub actual_result: Option<String>,
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub related_files: Vec<String>,
    #[serde(default)]
    pub assignee: String,
    /// Agent 会话 ID（MCP/CLI 传入；UI 可为空）。来源由服务端记录，不接受伪造 actor。
    #[serde(default)]
    pub source_session: Option<String>,
    /// 可选幂等键（同一次提交重试不重复创建）。
    #[serde(default)]
    pub client_request_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub impact: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub acceptance: Option<String>,
    #[serde(default)]
    pub repro_steps: Option<Vec<String>>,
    #[serde(default)]
    pub expected_result: Option<String>,
    #[serde(default)]
    pub actual_result: Option<String>,
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub related_files: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueLink {
    pub id: String,
    pub issue_id: String,
    pub target_kind: String,
    pub target_id: String,
    pub relation: String,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub id: String,
    pub project_id: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub sha256: String,
    pub size_bytes: i64,
    pub mime: String,
    pub meta_json: String,
    pub created_by: String,
    pub source: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceInput {
    pub subject_kind: String,
    pub subject_id: String,
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCandidate {
    pub id: String,
    pub title: String,
    pub status: String,
    pub kind: String,
    pub score: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueCreateResult {
    pub issue: Issue,
    pub duplicate_candidates: Vec<DuplicateCandidate>,
    /// 相同 `client_request_id` 命中时为 true（幂等返回）。
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub issue: Issue,
    pub links: Vec<IssueLink>,
    pub evidence: Vec<Evidence>,
    pub plans: Vec<String>,
    pub evidence_count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueFilter {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub include_archived: Option<bool>,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub priority: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub project_id: String,
    pub issue_id: Option<String>,
    pub title: String,
    pub summary: String,
    pub solution_md: String,
    pub breakdown: Vec<TaskDraft>,
    pub status: String,
    pub review_note: String,
    pub approved_by: String,
    pub approved_at: Option<String>,
    pub revision: i64,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub solution_md: Option<String>,
    #[serde(default)]
    pub breakdown: Option<Vec<TaskDraft>>,
    /// 仅用于合法状态推进（提交/审批由独立命令封装；此字段供内部复用）。
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub review_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTaskRef {
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub completed_at: Option<String>,
    pub orphan: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDetail {
    pub plan: Plan,
    pub visuals: Vec<VisualDocument>,
    pub tasks: Vec<PlanTaskRef>,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTasksResult {
    pub plan: Plan,
    pub created: Vec<String>,
    pub existing: Vec<String>,
    pub tasks: Vec<PlanTaskRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanProgress {
    pub total: i64,
    pub completed: i64,
    /// 空分母时为 null，不返回 0 冒充“完成度 0%”。
    pub percent: Option<i64>,
    pub orphan: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualDocument {
    pub id: String,
    pub project_id: String,
    pub plan_id: Option<String>,
    pub title: String,
    pub description: String,
    pub kind: String,
    /// 创作来源：manual / ai_generated / ai_assisted / agent_authored / imported。
    pub authoring_mode: String,
    pub schema_version: i64,
    pub source_format: String,
    /// JSON 字符串（可重新编辑）；读取端按 kind 解析。
    pub source_content: String,
    pub renderer: String,
    pub preview_asset: Option<String>,
    pub status: String,
    pub version: i64,
    pub revision: i64,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub kind: String,
    #[serde(default = "default_json_format")]
    pub source_format: String,
    #[serde(default)]
    pub source_content: String,
    #[serde(default)]
    pub plan_id: Option<String>,
    #[serde(default)]
    pub preview_asset: Option<String>,
    /// 可选显式创作来源；缺省时按 actor 推断（UI=manual / Agent=agent_authored）。
    #[serde(default)]
    pub authoring_mode: Option<String>,
}

fn default_json_format() -> String {
    "json".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub source_format: Option<String>,
    #[serde(default)]
    pub source_content: Option<String>,
    #[serde(default)]
    pub preview_asset: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// 仅内部/AI 路径使用：显式写入创作来源（如应用 AI 建议后置为 ai_assisted）。
    #[serde(default)]
    pub authoring_mode: Option<String>,
    /// AI 修改提案的 Job ID；写入版本快照，便于追溯是哪次生成被应用。
    #[serde(default)]
    pub ai_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualVersion {
    pub id: String,
    pub document_id: String,
    pub version: i64,
    pub snapshot: String,
    pub change_summary: String,
    pub authoring_mode: String,
    pub created_by: String,
    pub source: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualAsset {
    pub id: String,
    pub project_id: String,
    pub document_id: Option<String>,
    pub title: String,
    pub path: String,
    pub sha256: String,
    pub size_bytes: i64,
    pub mime: String,
    pub ext: String,
    pub status: String,
    pub meta_json: String,
    pub created_by: String,
    pub source: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualAssetInput {
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub document_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetContent {
    pub id: String,
    pub mime: String,
    pub size_bytes: i64,
    /// base64（不含 data: 前缀）；前端自行拼 `data:<mime>;base64,`。
    pub base64: String,
}

/// AI 修改提案：只返回候选内容，不写文档；用户确认后由前端调用 update。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProposal {
    pub job: AiJob,
    pub document_id: String,
    pub base_revision: i64,
    pub kind: String,
    pub proposed_content: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffItem {
    pub path: String,
    pub change: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualDiff {
    pub added: i64,
    pub removed: i64,
    pub changed: i64,
    pub summary: String,
    pub items: Vec<DiffItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererCapability {
    pub kind: String,
    pub renderer: String,
    pub interactive: bool,
    pub editable: bool,
    pub export_formats: Vec<String>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub format: String,
    pub content: String,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrototypeState {
    pub current_page: String,
    pub modal: Option<String>,
    pub values: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrototypeEvent {
    pub action: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchOp {
    pub op: String,
    #[serde(default)]
    pub page_id: Option<String>,
    #[serde(default)]
    pub component_id: Option<String>,
    #[serde(default)]
    pub component: Option<Value>,
    #[serde(default)]
    pub patch: Option<Value>,
    /// 字段删除表达：`{"props":["k"],"style":["bg"],"events":["onClick"]}`。
    ///
    /// 与 `patch` 同时出现时先删除再写入（同名键最终以 `patch` 为准）；
    /// 删除不存在的键视为幂等空操作，便于 diff 重复应用。
    #[serde(default)]
    pub remove_keys: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    /// 页面级操作：page_add 的页面名 / page_rename 的新名称。
    #[serde(default)]
    pub name: Option<String>,
    /// 页面级操作：page_add 可提交完整页面对象（缺省则创建空页面）。
    #[serde(default)]
    pub page: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionFlowReport {
    pub ok: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJob {
    pub id: String,
    pub project_id: String,
    pub plan_id: Option<String>,
    pub document_id: Option<String>,
    pub kind: String,
    pub provider: String,
    pub model: String,
    pub prompt: String,
    pub params_json: String,
    pub status: String,
    pub result_json: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub cost_units: f64,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub project_id: String,
    pub entity_kind: String,
    pub entity_id: String,
    pub action: String,
    pub actor: String,
    pub actor_kind: String,
    pub source: String,
    pub revision_before: Option<i64>,
    pub revision_after: Option<i64>,
    pub detail_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTask {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: i64,
    pub due_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    pub project_id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub target_date: Option<String>,
    pub counts: ContextCounts,
    pub architecture: Option<String>,
    pub knowledge: Option<Vec<String>>,
    pub issues: Option<Page<Issue>>,
    pub plans: Option<Page<Plan>>,
    pub tasks: Option<Page<ContextTask>>,
    pub visuals: Option<Page<VisualDocument>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCounts {
    pub issues: i64,
    pub bugs: i64,
    pub plans: i64,
    pub visuals: i64,
    pub evidence: i64,
    pub tasks: i64,
}

pub fn page_args(page: Option<i64>, page_size: Option<i64>) -> (i64, i64, i64) {
    let page = page.unwrap_or(1).max(1);
    let size = page_size.unwrap_or(20).clamp(1, PAGE_MAX);
    let offset = (page - 1).saturating_mul(size);
    (page, size, offset)
}
