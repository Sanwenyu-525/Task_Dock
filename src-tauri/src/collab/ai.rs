//! AI Provider 抽象与生成任务。
//!
//! 现状（2026-11-18）：仓库没有任何模型供应商、API Key 或 HTTP 客户端。
//! 因此默认只注册 **本地结构化 Provider**（规则生成，不是模型），名称与 UI 标识都明确
//! 为 `local-structured`；图像生成无 Provider 时任务落库为 `provider_unavailable`，
//! **绝不生成假图或假成功**。

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

use super::actor::{assert_project_scope, Actor, Capability};
use super::model::{AiJob, AiProposal, Page, PAGE_MAX};
use super::util::{new_id, now_iso, page_bounds, validate_text};
use super::visual::{create_document, normalize_content, renderer_for};
use super::model::VisualInput;

pub const LOCAL_PROVIDER: &str = "local-structured";
pub const LOCAL_MODEL: &str = "rules-v1";

#[derive(Debug, Clone)]
pub struct TextRequest {
    pub kind: String,
    pub title: String,
    /// 用户原始指令：Provider 必须能拿到它，否则生成与需求脱节。
    pub prompt: String,
    pub context: Value,
}

#[derive(Debug, Clone)]
pub struct TextResult {
    pub content: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone)]
pub enum AiError {
    Unavailable(String),
    Failed(String),
}

impl AiError {
    fn code(&self) -> &'static str {
        match self {
            AiError::Unavailable(_) => "PROVIDER_UNAVAILABLE",
            AiError::Failed(_) => "AI_GENERATION_FAILED",
        }
    }
    fn message(&self) -> String {
        match self {
            AiError::Unavailable(m) | AiError::Failed(m) => m.clone(),
        }
    }
}

pub trait ModelProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn supports_text(&self) -> bool;
    fn supports_image(&self) -> bool;
    fn generate_text(&self, req: &TextRequest) -> Result<TextResult, AiError>;
}

pub struct LocalStructuredProvider;

impl ModelProvider for LocalStructuredProvider {
    fn name(&self) -> &'static str {
        LOCAL_PROVIDER
    }
    fn supports_text(&self) -> bool {
        true
    }
    fn supports_image(&self) -> bool {
        false
    }

    fn generate_text(&self, req: &TextRequest) -> Result<TextResult, AiError> {
        let content = match req.kind.as_str() {
            "flowchart" => local_flowchart(&req.title, &req.prompt, &req.context),
            "architecture" => local_architecture(&req.title, &req.prompt, &req.context),
            "dataflow" => local_dataflow(&req.title, &req.prompt),
            "prototype" => local_prototype(&req.title, &req.prompt, &req.context),
            other => {
                return Err(AiError::Unavailable(format!(
                    "本地结构化 Provider 不支持生成 {other}；请配置文本模型"
                )))
            }
        };
        Ok(TextResult {
            content: content.to_string(),
            provider: LOCAL_PROVIDER.to_string(),
            model: LOCAL_MODEL.to_string(),
        })
    }
}

pub fn text_providers() -> Vec<&'static dyn ModelProvider> {
    vec![&LocalStructuredProvider]
}

pub fn image_provider() -> Option<&'static dyn ModelProvider> {
    // 没有图像模型接入：返回 None，调用方必须落 `provider_unavailable`。
    None
}

/// 把用户指令拆成可执行的步骤：支持 `->`/`→`/`=>`/逗号/分号/换行。
/// 这是规则解析，不是模型理解；结果上限 8 步、每步 60 字。
fn prompt_steps(prompt: &str) -> Vec<String> {
    let mut out = Vec::new();
    let normalized = prompt
        .replace("->", "\n")
        .replace("=>", "\n")
        .replace('→', "\n");
    for part in normalized.split(|c: char| {
        matches!(c, '\n' | '，' | ',' | '；' | ';' | '、')
    }) {
        let step = part.trim();
        if step.is_empty() {
            continue;
        }
        let step: String = step.chars().take(60).collect();
        out.push(step);
        if out.len() >= 8 {
            break;
        }
    }
    out
}

fn step_nodes(steps: &[String], kind: &str) -> Vec<Value> {
    steps
        .iter()
        .enumerate()
        .map(|(i, step)| {
            json!({
                "id": format!("n{}", i + 1),
                "label": step,
                "kind": kind,
                "config": {}
            })
        })
        .collect()
}

fn local_flowchart(title: &str, prompt: &str, context: &Value) -> Value {
    let mut steps = prompt_steps(prompt);
    if steps.len() < 2 {
        steps = context
            .get("tasks")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(|s| s.to_string()))
                    .take(20)
                    .collect()
            })
            .unwrap_or_default();
    }
    let mut nodes = vec![json!({"id":"start","label":"开始","kind":"start","config":{}})];
    let mut edges = Vec::new();
    if steps.is_empty() {
        nodes.push(json!({"id":"n1","label":title,"kind":"process","config":{}}));
        nodes.push(json!({"id":"end","label":"完成","kind":"end","config":{}}));
        edges.push(json!({"id":"e1","from":"start","to":"n1","label":""}));
        edges.push(json!({"id":"e2","from":"n1","to":"end","label":""}));
    } else {
        nodes.extend(step_nodes(&steps, "process"));
        let mut prev = "start".to_string();
        for (i, _) in steps.iter().enumerate() {
            let id = format!("n{}", i + 1);
            edges.push(json!({"id": format!("e{}", i + 1), "from": prev, "to": id, "label": ""}));
            prev = id;
        }
        nodes.push(json!({"id":"end","label":"完成","kind":"end","config":{}}));
        edges.push(json!({"id": format!("e{}", steps.len() + 1), "from": prev, "to": "end", "label": ""}));
    }
    let direction = if prompt.contains("横向") || prompt.contains("左右") {
        "LR"
    } else {
        "TB"
    };
    json!({"nodes": nodes, "edges": edges, "layout": {"direction": direction}})
}

fn local_architecture(title: &str, prompt: &str, context: &Value) -> Value {
    let from_prompt = prompt_steps(prompt);
    let modules: Vec<String> = if from_prompt.len() >= 2 {
        from_prompt
    } else {
        context
            .get("modules")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).take(12).collect())
            .unwrap_or_else(|| {
                vec![
                    "外部 Agent / CLI / MCP".to_string(),
                    "协作服务层 collab".to_string(),
                    "SQLite".to_string(),
                    "规划中心 UI".to_string(),
                ]
            })
    };
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for (i, m) in modules.iter().enumerate() {
        nodes.push(json!({
            "id": format!("m{}", i + 1),
            "label": m,
            "kind": if i == 0 { "external" } else if i == modules.len() - 1 { "ui" } else { "service" },
            "config": {}
        }));
    }
    for i in 0..modules.len().saturating_sub(1) {
        edges.push(json!({
            "id": format!("e{}", i + 1),
            "from": format!("m{}", i + 1),
            "to": format!("m{}", i + 2),
            "label": ""
        }));
    }
    if nodes.is_empty() {
        nodes.push(json!({"id":"m1","label":title,"kind":"service","config":{}}));
    }
    json!({"nodes": nodes, "edges": edges, "layout": {"direction": "LR"}})
}

fn local_dataflow(title: &str, prompt: &str) -> Value {
    let steps = prompt_steps(prompt);
    if steps.len() >= 2 {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for (i, step) in steps.iter().enumerate() {
            let kind = if i == 0 {
                "source"
            } else if i == steps.len() - 1 {
                "sink"
            } else if i % 3 == 2 {
                "store"
            } else {
                "process"
            };
            nodes.push(json!({"id": format!("d{}", i + 1), "label": step, "kind": kind, "config": {}}));
            if i > 0 {
                edges.push(json!({
                    "id": format!("e{}", i),
                    "from": format!("d{}", i),
                    "to": format!("d{}", i + 1),
                    "label": ""
                }));
            }
        }
        return json!({"nodes": nodes, "edges": edges, "layout": {"direction": "LR"}});
    }
    json!({
        "nodes": [
            {"id":"src","label":"外部 Agent 提交","kind":"source","config":{}},
            {"id":"svc","label":title,"kind":"process","config":{}},
            {"id":"db","label":"SQLite 事实源","kind":"store","config":{}},
            {"id":"ui","label":"开发者审阅","kind":"sink","config":{}}
        ],
        "edges": [
            {"id":"e1","from":"src","to":"svc","label":""},
            {"id":"e2","from":"svc","to":"db","label":""},
            {"id":"e3","from":"db","to":"ui","label":""}
        ],
        "layout": {"direction": "LR"}
    })
}

fn local_prototype(title: &str, prompt: &str, context: &Value) -> Value {
    let acceptance = if prompt.trim().is_empty() {
        context
            .get("acceptance")
            .and_then(|v| v.as_str())
            .unwrap_or("确认需求与验收标准")
    } else {
        prompt
    };
    json!({
        "schemaVersion": 1,
        "viewport": {"width": 400, "height": 640},
        "pages": [
            {
                "id": "page-1",
                "name": "方案确认",
                "components": [
                    {"id":"c-title","type":"heading","x":10,"y":24,"w":300,"h":40,
                     "props":{"text":title},"style":{"fontSize":"20px","fontWeight":"bold"},"events":{}},
                    {"id":"c-desc","type":"text","x":10,"y":76,"w":300,"h":60,
                     "props":{"text":acceptance},"style":{"fontSize":"14px"},"events":{}},
                    {"id":"c-input","type":"input","x":10,"y":150,"w":300,"h":40,
                     "props":{"label":"审阅备注","placeholder":"填写修改意见"},"style":{},"events":{}},
                    {"id":"c-switch","type":"switch","x":10,"y":210,"w":300,"h":36,
                     "props":{"label":"同意进入开发"},"style":{},"events":{}},
                    {"id":"c-btn","type":"button","x":10,"y":270,"w":140,"h":40,
                     "props":{"label":"批准方案","variant":"primary"},
                     "style":{"bg":"var(--accent)","radius":"8px"},
                     "events":{"onClick":{"action":"navigate","target":"page-2"}}},
                    {"id":"c-note-btn","type":"button","x":160,"y":270,"w":140,"h":40,
                     "props":{"label":"查看说明"},"style":{"radius":"8px"},
                     "events":{"onClick":{"action":"openModal","target":"c-note"}}},
                    {"id":"c-note","type":"frame","x":10,"y":330,"w":300,"h":100,
                     "props":{"label":"说明：批准后进入开发，可随时返回修改。"},
                     "style":{},"events":{}}
                ]
            },
            {
                "id": "page-2",
                "name": "已确认",
                "components": [
                    {"id":"c-done-title","type":"heading","x":10,"y":24,"w":300,"h":40,
                     "props":{"text":"方案已确认"},"style":{"fontSize":"20px","fontWeight":"bold"},"events":{}},
                    {"id":"c-done-text","type":"text","x":10,"y":76,"w":300,"h":60,
                     "props":{"text":"已进入开发准备阶段；可返回继续修改。"},"style":{"fontSize":"14px"},"events":{}},
                    {"id":"c-back","type":"button","x":10,"y":160,"w":140,"h":40,
                     "props":{"label":"返回方案"},"style":{"radius":"8px"},
                     "events":{"onClick":{"action":"navigate","target":"page-1"}}}
                ]
            }
        ],
        "state": {}
    })
}

// ── Job 持久化 ───────────────────────────────────────────────────────────

fn map_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<AiJob> {
    Ok(AiJob {
        id: r.get(0)?,
        project_id: r.get(1)?,
        plan_id: r.get(2)?,
        document_id: r.get(3)?,
        kind: r.get(4)?,
        provider: r.get(5)?,
        model: r.get(6)?,
        prompt: r.get(7)?,
        params_json: r.get(8)?,
        status: r.get(9)?,
        result_json: r.get(10)?,
        error_code: r.get(11)?,
        error_message: r.get(12)?,
        cost_units: r.get(13)?,
        created_by: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
    })
}

const JOB_COLS: &str = "id, project_id, plan_id, document_id, kind, provider, model, prompt, \
params_json, status, result_json, error_code, error_message, cost_units, created_by, \
created_at, updated_at";

fn insert_job(conn: &Connection, job: &AiJob) -> AppResult<()> {
    conn.execute(
        &format!("INSERT INTO collab_ai_jobs ({JOB_COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)"),
        rusqlite::params![
            job.id, job.project_id, job.plan_id, job.document_id, job.kind, job.provider,
            job.model, job.prompt, job.params_json, job.status, job.result_json, job.error_code,
            job.error_message, job.cost_units, job.created_by, job.created_at, job.updated_at
        ],
    )?;
    Ok(())
}

fn load_job(conn: &Connection, id: &str) -> AppResult<AiJob> {
    conn.query_row(
        &format!("SELECT {JOB_COLS} FROM collab_ai_jobs WHERE id=?1"),
        rusqlite::params![id],
        map_job,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("AI 任务不存在".to_string()))
}

pub fn list_jobs(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    status: Option<&str>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<AiJob>> {
    actor.require(Capability::VisualRead)?;
    assert_project_scope(conn, actor, project_id)?;
    let (page, size, offset) = page_bounds(page, page_size, PAGE_MAX);
    let total: i64 = match status {
        Some(s) => conn.query_row(
            "SELECT COUNT(*) FROM collab_ai_jobs WHERE project_id=?1 AND status=?2",
            rusqlite::params![project_id, s],
            |r| r.get(0),
        )?,
        None => conn.query_row(
            "SELECT COUNT(*) FROM collab_ai_jobs WHERE project_id=?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )?,
    };
    let sql = match status {
        Some(_) => format!(
            "SELECT {JOB_COLS} FROM collab_ai_jobs WHERE project_id=?1 AND status=?2 \
             ORDER BY created_at DESC LIMIT ?3 OFFSET ?4"
        ),
        None => format!(
            "SELECT {JOB_COLS} FROM collab_ai_jobs WHERE project_id=?1 \
             ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let items = match status {
        Some(s) => stmt
            .query_map(rusqlite::params![project_id, s, size, offset], map_job)?
            .collect::<Result<Vec<_>, _>>()?,
        None => stmt
            .query_map(rusqlite::params![project_id, size, offset], map_job)?
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(Page::new(items, total, page, size))
}

pub fn cancel_job(conn: &Connection, actor: &Actor, id: &str) -> AppResult<AiJob> {
    actor.require(Capability::AiGenerate)?;
    let job = load_job(conn, id)?;
    assert_project_scope(conn, actor, &job.project_id)?;
    if matches!(job.status.as_str(), "succeeded" | "failed" | "cancelled") {
        return Ok(job);
    }
    let now = now_iso();
    conn.execute(
        "UPDATE collab_ai_jobs SET status='cancelled', updated_at=?2 WHERE id=?1",
        rusqlite::params![id, now],
    )?;
    load_job(conn, id)
}

// ── 文本生成 ─────────────────────────────────────────────────────────────

pub fn generate_visual(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    plan_id: Option<&str>,
    issue_id: Option<&str>,
    kind: &str,
    prompt: &str,
) -> AppResult<AiJob> {
    actor.require(Capability::AiGenerate)?;
    assert_project_scope(conn, actor, project_id)?;
    let kind = super::util::validate_enum(
        kind,
        &["flowchart", "architecture", "dataflow", "prototype"],
        "生成类型",
    )?;

    let prompt = validate_text(prompt, "生成说明", 4000, false)?;
    let (title, context) = build_context(conn, project_id, plan_id, issue_id)?;
    let request = TextRequest {
        kind: kind.clone(),
        title: title.clone(),
        prompt: prompt.clone(),
        context,
    };

    let mut job = AiJob {
        id: new_id("aj"),
        project_id: project_id.to_string(),
        plan_id: plan_id.map(|s| s.to_string()),
        document_id: None,
        kind: "text".to_string(),
        provider: LOCAL_PROVIDER.to_string(),
        model: LOCAL_MODEL.to_string(),
        prompt,
        params_json: json!({"kind": kind}).to_string(),
        status: "running".to_string(),
        result_json: None,
        error_code: None,
        error_message: None,
        cost_units: 0.0,
        created_by: actor.id.clone(),
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    insert_job(conn, &job)?;

    let provider: &dyn ModelProvider = &LocalStructuredProvider;
    let result = match provider.generate_text(&request) {
        Ok(result) => result,
        Err(err) => {
            let now = now_iso();
            conn.execute(
                "UPDATE collab_ai_jobs SET status='failed', error_code=?2, error_message=?3, updated_at=?4 WHERE id=?1",
                rusqlite::params![job.id, err.code(), err.message(), now],
            )?;
            return Err(AppError::Unavailable(err.message()));
        }
    };

    // 生成结果必须过 Schema 校验后才落库；失败写 job 失败，不创建文档。
    let normalized = match normalize_content(&kind, "json", &result.content) {
        Ok(v) => v,
        Err(e) => {
            let now = now_iso();
            conn.execute(
                "UPDATE collab_ai_jobs SET status='failed', error_code='SCHEMA_INVALID', error_message=?2, updated_at=?3 WHERE id=?1",
                rusqlite::params![job.id, e.to_string(), now],
            )?;
            return Err(AppError::Validation(format!("生成内容未通过校验：{e}")));
        }
    };

    let doc = create_document(
        conn,
        actor,
        project_id,
        &VisualInput {
            title: format!("{}（{}）", title, kind_label(&kind)),
            description: format!("由 {} 生成", LOCAL_PROVIDER),
            kind: kind.clone(),
            source_format: "json".to_string(),
            source_content: normalized,
            plan_id: plan_id.map(|s| s.to_string()),
            preview_asset: None,
            authoring_mode: Some("ai_generated".to_string()),
        },
    )?;

    let now = now_iso();
    conn.execute(
        "UPDATE collab_ai_jobs SET status='succeeded', document_id=?2,
         result_json=?3, provider=?4, model=?5, updated_at=?6 WHERE id=?1",
        rusqlite::params![
            job.id,
            doc.id,
            json!({"documentId": doc.id, "version": doc.version}).to_string(),
            result.provider,
            result.model,
            now
        ],
    )?;
    job.status = "succeeded".to_string();
    job.document_id = Some(doc.id);
    job.provider = result.provider;
    job.model = result.model;
    job.result_json = Some(json!({"documentId": job.document_id, "version": doc.version}).to_string());
    job.updated_at = now;
    Ok(job)
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "flowchart" => "流程图",
        "architecture" => "架构图",
        "dataflow" => "数据流图",
        "prototype" => "原型",
        _ => "可视化",
    }
}

fn build_context(
    conn: &Connection,
    project_id: &str,
    plan_id: Option<&str>,
    issue_id: Option<&str>,
) -> AppResult<(String, Value)> {
    if let Some(plan_id) = plan_id {
        let plan = super::plan::load_plan(conn, plan_id)?;
        if plan.project_id != project_id {
            return Err(AppError::Forbidden("方案不属于该项目".to_string()));
        }
        let tasks: Vec<String> = plan.breakdown.iter().map(|t| t.title.clone()).collect();
        return Ok((
            plan.title.clone(),
            json!({
                "summary": plan.summary,
                "solution": plan.solution_md,
                "tasks": tasks,
                "acceptance": "",
                "modules": ["规划中心", "协作服务层", "SQLite", "可视化引擎"]
            }),
        ));
    }
    if let Some(issue_id) = issue_id {
        let issue = super::issue::load_issue(conn, issue_id)?;
        if issue.project_id != project_id {
            return Err(AppError::Forbidden("需求不属于该项目".to_string()));
        }
        return Ok((
            issue.title.clone(),
            json!({
                "summary": issue.description,
                "acceptance": issue.acceptance,
                "tasks": [issue.title.clone()],
            }),
        ));
    }
    let name: String = conn.query_row(
        "SELECT name FROM planning_projects WHERE id=?1",
        rusqlite::params![project_id],
        |r| r.get(0),
    )?;
    Ok((name, json!({})))
}

// ── 图像任务 ─────────────────────────────────────────────────────────────

pub fn create_image_job(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    plan_id: Option<&str>,
    prompt: &str,
    params: Option<Value>,
) -> AppResult<AiJob> {
    actor.require(Capability::AiGenerate)?;
    assert_project_scope(conn, actor, project_id)?;
    if let Some(plan_id) = plan_id {
        let project: Option<String> = conn
            .query_row(
                "SELECT project_id FROM collab_plans WHERE id=?1",
                rusqlite::params![plan_id],
                |r| r.get(0),
            )
            .optional()?;
        if project.as_deref() != Some(project_id) {
            return Err(AppError::Forbidden("方案不属于该项目".to_string()));
        }
    }
    let prompt = validate_text(prompt, "图像生成提示", 4000, true)?;
    let status = if image_provider().is_some() {
        "queued"
    } else {
        "provider_unavailable"
    };
    let job = AiJob {
        id: new_id("aj"),
        project_id: project_id.to_string(),
        plan_id: plan_id.map(|s| s.to_string()),
        document_id: None,
        kind: "image".to_string(),
        provider: "none".to_string(),
        model: String::new(),
        prompt,
        params_json: params.unwrap_or_else(|| json!({})).to_string(),
        status: status.to_string(),
        result_json: None,
        error_code: if status == "provider_unavailable" {
            Some("PROVIDER_UNAVAILABLE".to_string())
        } else {
            None
        },
        error_message: if status == "provider_unavailable" {
            Some("未配置图像模型供应商；任务已记录，不生成假图".to_string())
        } else {
            None
        },
        cost_units: 0.0,
        created_by: actor.id.clone(),
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    insert_job(conn, &job)?;
    Ok(job)
}

// ── AI 辅助修改（返回候选，不落库）──────────────────────────────────────

/// 对已有文档生成修改候选。**只返回候选内容**，用户确认后由前端调用
/// `visual::update_document`（带 expectedRevision）才会生成新版本。
///
/// 当前由本地规则 Provider 生成并明确标注；真实模型接入后替换本函数内部实现即可，
/// 入口/权限/确认流程不变。
pub fn propose_modification(
    conn: &Connection,
    actor: &Actor,
    document_id: &str,
    instruction: &str,
    selection: &[String],
) -> AppResult<AiProposal> {
    actor.require(Capability::AiGenerate)?;
    let doc = super::visual::get_document(conn, actor, document_id)?;
    if !matches!(
        doc.kind.as_str(),
        "flowchart" | "architecture" | "dataflow" | "prototype"
    ) {
        return Err(AppError::Unavailable(format!(
            "{} 类型暂不支持 AI 结构化修改",
            doc.kind
        )));
    }
    let instruction = validate_text(instruction, "修改说明", 2000, true)?;
    let mut content: Value = serde_json::from_str(&doc.source_content)
        .map_err(|_| AppError::Validation("文档内容损坏".to_string()))?;
    let steps = prompt_steps(&instruction);
    if steps.is_empty() {
        return Err(AppError::Validation("请描述要修改的内容".to_string()));
    }

    let summary = if doc.kind == "prototype" {
        apply_ai_prototype(&mut content, &instruction, selection)?
    } else {
        apply_ai_graph(&mut content, &doc.kind, &instruction, &steps, selection)?
    };
    let normalized = normalize_content(&doc.kind, "json", &content.to_string())?;

    let now = now_iso();
    let job = AiJob {
        id: new_id("aj"),
        project_id: doc.project_id.clone(),
        plan_id: doc.plan_id.clone(),
        document_id: Some(doc.id.clone()),
        kind: "text".to_string(),
        provider: LOCAL_PROVIDER.to_string(),
        model: LOCAL_MODEL.to_string(),
        prompt: instruction.clone(),
        params_json: json!({
            "mode": "propose",
            "documentId": doc.id,
            "baseRevision": doc.revision,
            "selection": selection
        })
        .to_string(),
        status: "succeeded".to_string(),
        result_json: Some(
            json!({"documentId": doc.id, "baseRevision": doc.revision, "summary": summary})
                .to_string(),
        ),
        error_code: None,
        error_message: None,
        cost_units: 0.0,
        created_by: actor.id.clone(),
        created_at: now.clone(),
        updated_at: now,
    };
    insert_job(conn, &job)?;

    Ok(AiProposal {
        job,
        document_id: doc.id,
        base_revision: doc.revision,
        kind: doc.kind,
        proposed_content: normalized,
        summary,
    })
}

fn next_ai_id(prefix: &str, used: &mut std::collections::BTreeSet<String>) -> String {
    let mut n = 1;
    loop {
        let candidate = format!("{prefix}{n}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

fn apply_ai_graph(
    content: &mut Value,
    kind: &str,
    instruction: &str,
    steps: &[String],
    selection: &[String],
) -> AppResult<String> {
    if content.as_object().is_none() {
        return Err(AppError::Validation("图内容必须是对象".to_string()));
    }
    let node_values = content
        .get("nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| AppError::Validation("图缺少 nodes".to_string()))?;
    if node_values.len() + steps.len() > 200 {
        return Err(AppError::Validation("节点数将超过 200 上限".to_string()));
    }
    let mut used: std::collections::BTreeSet<String> = node_values
        .iter()
        .filter_map(|n| n.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let anchor = selection
        .iter()
        .find(|id| used.contains(*id))
        .cloned()
        .or_else(|| {
            node_values
                .last()
                .and_then(|n| n.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        })
        .ok_or_else(|| AppError::Validation("图中没有可连接的节点".to_string()))?;
    let (ax, ay) = node_values
        .iter()
        .find(|n| n.get("id").and_then(|v| v.as_str()) == Some(anchor.as_str()))
        .map(|n| {
            (
                n.get("x").and_then(|v| v.as_f64()).unwrap_or(60.0),
                n.get("y").and_then(|v| v.as_f64()).unwrap_or(80.0),
            )
        })
        .unwrap_or((60.0, 80.0));
    let horizontal = instruction.contains("横向") || instruction.contains("左右");
    if horizontal {
        if let Some(layout) = content
            .get_mut("layout")
            .and_then(|v| v.as_object_mut())
        {
            layout.insert("direction".to_string(), json!("LR"));
        }
    }
    let node_kind = match kind {
        "architecture" => "service",
        _ => "process",
    };
    let mut previous = anchor.clone();
    let mut new_edges = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let id = next_ai_id("n_ai_", &mut used);
        let (x, y) = if horizontal {
            (ax + 220.0 * (i as f64 + 1.0), ay)
        } else {
            (ax, ay + 130.0 * (i as f64 + 1.0))
        };
        new_edges.push(json!({
            "id": next_ai_id("e_ai_", &mut used),
            "from": previous,
            "to": id,
            "label": ""
        }));
        content
            .get_mut("nodes")
            .and_then(|v| v.as_array_mut())
            .expect("nodes 已在上面校验")
            .push(json!({
                "id": id, "label": step, "kind": node_kind, "config": {},
                "x": x, "y": y
            }));
        previous = id;
    }
    content
        .get_mut("edges")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| AppError::Validation("图缺少 edges".to_string()))?
        .extend(new_edges);
    Ok(format!(
        "规则生成：在「{anchor}」后新增 {} 个节点并连接（非模型）",
        steps.len()
    ))
}

fn apply_ai_prototype(
    content: &mut Value,
    instruction: &str,
    selection: &[String],
) -> AppResult<String> {
    let pages = content
        .get_mut("pages")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| AppError::Validation("原型缺少 pages".to_string()))?;
    let page = pages
        .first_mut()
        .ok_or_else(|| AppError::Validation("原型至少需要一个页面".to_string()))?;
    let comps = page
        .get_mut("components")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| AppError::Validation("页面缺少 components".to_string()))?;
    if comps.len() >= 200 {
        return Err(AppError::Validation("单页组件数超过 200 上限".to_string()));
    }
    let mut used: std::collections::BTreeSet<String> = comps
        .iter()
        .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let anchor = selection
        .iter()
        .find(|id| used.contains(*id))
        .cloned()
        .or_else(|| {
            comps
                .last()
                .and_then(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        });
    let (x, y, w) = anchor
        .as_deref()
        .and_then(|id| comps.iter().find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id)))
        .map(|c| {
            (
                c.get("x").and_then(|v| v.as_f64()).unwrap_or(10.0),
                c.get("y").and_then(|v| v.as_f64()).unwrap_or(10.0)
                    + c.get("h").and_then(|v| v.as_f64()).unwrap_or(40.0)
                    + 8.0,
                c.get("w").and_then(|v| v.as_f64()).unwrap_or(280.0),
            )
        })
        .unwrap_or((10.0, 10.0, 280.0));
    let id = next_ai_id("c_ai_", &mut used);
    comps.push(json!({
        "id": id,
        "type": "text",
        "x": x, "y": y, "w": w, "h": 40,
        "props": {"text": instruction},
        "style": {"fontSize": "13px"},
        "events": {}
    }));
    Ok("规则生成：在选中组件下方新增说明文本（非模型）".to_string())
}

/// 生成说明中显式暴露 Provider，避免 UI 把规则生成误认为模型生成。
pub fn provider_notice() -> Value {
    json!({
        "textProvider": LOCAL_PROVIDER,
        "textModel": LOCAL_MODEL,
        "textMode": "local-structured",
        "imageProvider": null,
        "notice": "当前为本地结构化规则生成，不是模型生成；图像生成未配置供应商"
    })
}

#[allow(dead_code)]
fn unused_renderer() -> AppResult<&'static str> {
    renderer_for("flowchart")
}
