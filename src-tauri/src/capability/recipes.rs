//! 能力配方：把知识检索、外部 MCP 工具与结果沉淀编排为可重复执行的模板。
//!
//! 与工作流引擎的分工：
//! - 工作流步骤是导航/建任务/场景/恢复现场（`workflows::StepType` 白名单）；
//! - 配方只负责「模板 + 参数 + 顺序调度 + 运行记录」，**不复制**步骤执行逻辑；
//! - 知识检索 / MCP 调用 / 写笔记统一由 [`super::steps`] 的公共执行器完成，
//!   未来工作流需要同类步骤时调用同一执行器，不形成第二套长期并行的执行系统；
//! - 高风险 MCP 步骤执行前必须整次确认；失败即停止并留下逐步骤记录。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::steps::{
    cap_step_output, execute_step, step_is_high_risk, CapabilityStep as RecipeStep,
};
use super::{check_project, check_text, now_iso, truncate_chars};

const MAX_STEPS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub description: String,
    pub project_id: Option<String>,
    pub enabled: bool,
    pub steps: Vec<RecipeStep>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub project_id: Option<String>,
    pub enabled: bool,
    pub step_count: usize,
    pub last_run_status: Option<String>,
    pub last_run_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub steps: Vec<RecipeStep>,
}

pub fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRunStepLog {
    pub index: usize,
    pub step_type: String,
    pub status: String,
    pub detail: String,
    pub output: Value,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRun {
    pub id: String,
    pub recipe_id: String,
    pub recipe_name: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub steps: Vec<RecipeRunStepLog>,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRunSummary {
    pub id: String,
    pub recipe_id: String,
    pub recipe_name: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRunPage {
    pub items: Vec<RecipeRunSummary>,
    pub total: i64,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecipeExport {
    version: u32,
    name: String,
    description: String,
    steps: Vec<RecipeStep>,
    /// 导出时是否把敏感参数值替换为 `***`（默认是）。
    #[serde(default)]
    secret_args_redacted: bool,
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "api_key",
        "apikey",
        "credential",
        "authorization",
        "auth",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn redact_secret_args(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if is_secret_key(key) && !item.is_null() {
                    *item = Value::String("***".into());
                } else {
                    redact_secret_args(item);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_secret_args(item);
            }
        }
        _ => {}
    }
}

// ── 持久化 ─────────────────────────────────────────────────────────

const RECIPE_COLUMNS: &str =
    "id, name, description, project_id, enabled, steps_json, created_at, updated_at";

fn row_to_recipe(row: &rusqlite::Row<'_>) -> rusqlite::Result<Recipe> {
    let raw: String = row.get(5)?;
    Ok(Recipe {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        project_id: row.get(3)?,
        enabled: row.get::<_, i64>(4)? != 0,
        steps: serde_json::from_str(&raw).unwrap_or_default(),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn read_recipe(conn: &Connection, id: &str) -> AppResult<Recipe> {
    conn.query_row(
        &format!("SELECT {RECIPE_COLUMNS} FROM capability_recipes WHERE id=?1"),
        [id],
        row_to_recipe,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("能力配方不存在: {id}")))
}

fn validate_steps(db: &Db, steps: &[RecipeStep]) -> AppResult<()> {
    if steps.is_empty() {
        return Err(AppError::Validation("配方至少需要 1 个步骤".into()));
    }
    if steps.len() > MAX_STEPS {
        return Err(AppError::Validation(format!("配方最多 {MAX_STEPS} 个步骤")));
    }
    db.with_read(|conn| {
        for step in steps {
            match step {
                RecipeStep::KnowledgeSearch { kb_ids, query, limit } => {
                    if query.trim().is_empty() || query.chars().count() > 200 {
                        return Err(AppError::Validation(
                            "知识检索步骤的查询词必须为 1~200 字符".into(),
                        ));
                    }
                    if kb_ids.len() > 20 {
                        return Err(AppError::Validation("知识检索最多绑定 20 个知识库".into()));
                    }
                    for id in kb_ids {
                        let exists: bool = conn.query_row(
                            "SELECT EXISTS(SELECT 1 FROM knowledge_bases WHERE id=?1)",
                            [id],
                            |r| r.get(0),
                        )?;
                        if !exists {
                            return Err(AppError::NotFound(format!("知识库不存在: {id}")));
                        }
                    }
                    if !(1..=20).contains(limit) {
                        return Err(AppError::Validation(
                            "知识检索条数必须在 1~20 之间".into(),
                        ));
                    }
                }
                RecipeStep::McpTool {
                    server_id,
                    tool_name,
                    args,
                    ..
                } => {
                    let exists: bool = conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM external_mcp_servers WHERE id=?1)",
                        [server_id],
                        |r| r.get(0),
                    )?;
                    if !exists {
                        return Err(AppError::NotFound(format!(
                            "外部 MCP Server 不存在: {server_id}"
                        )));
                    }
                    if tool_name.trim().is_empty() || tool_name.chars().count() > 200 {
                        return Err(AppError::Validation("MCP 工具名称必须为 1~200 字符".into()));
                    }
                    if !args.is_object() {
                        return Err(AppError::Validation("MCP 工具参数必须是 JSON 对象".into()));
                    }
                    let serialized = args.to_string();
                    if serialized.len() > 64 * 1024 {
                        return Err(AppError::Validation("MCP 工具参数超过 64 KiB".into()));
                    }
                }
                RecipeStep::SaveNote { title } => {
                    check_text(title, "笔记标题", 200)?;
                }
            }
        }
        Ok(())
    })
}

pub fn list_impl(db: &Db) -> AppResult<Vec<RecipeSummary>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {RECIPE_COLUMNS} FROM capability_recipes ORDER BY updated_at DESC, name"
        ))?;
        let recipes = stmt
            .query_map([], row_to_recipe)?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::new();
        for recipe in recipes {
            let last: Option<(String, String)> = conn
                .query_row(
                    "SELECT status, started_at FROM capability_recipe_runs WHERE recipe_id=?1 \
                     ORDER BY started_at DESC LIMIT 1",
                    [&recipe.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            out.push(RecipeSummary {
                id: recipe.id,
                name: recipe.name,
                description: recipe.description,
                project_id: recipe.project_id,
                enabled: recipe.enabled,
                step_count: recipe.steps.len(),
                last_run_status: last.as_ref().map(|v| v.0.clone()),
                last_run_at: last.map(|v| v.1),
                updated_at: recipe.updated_at,
            });
        }
        Ok(out)
    })
}

pub fn get_impl(db: &Db, id: &str) -> AppResult<Recipe> {
    db.with_read(|conn| read_recipe(conn, id))
}

pub fn save_impl(db: &Db, input: RecipeInput) -> AppResult<Recipe> {
    let name = check_text(&input.name, "配方名称", 80)?;
    if input.description.chars().count() > 1000 {
        return Err(AppError::Validation("配方描述超过 1000 字符".into()));
    }
    validate_steps(db, &input.steps)?;
    let steps_json = serde_json::to_string(&input.steps)?;
    let now = now_iso();
    db.with_conn(|conn| {
        let project_id = check_project(conn, input.project_id.as_deref())?;
        if let Some(id) = &input.id {
            let n = conn.execute(
                "UPDATE capability_recipes SET name=?2, description=?3, project_id=?4, enabled=?5, \
                 steps_json=?6, updated_at=?7 WHERE id=?1",
                params![
                    id,
                    name,
                    input.description.trim(),
                    project_id,
                    i64::from(input.enabled),
                    steps_json,
                    now
                ],
            )?;
            if n == 0 {
                return Err(AppError::NotFound(format!("能力配方不存在: {id}")));
            }
            read_recipe(conn, id)
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO capability_recipes(id,name,description,project_id,enabled,steps_json,created_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
                params![
                    id,
                    name,
                    input.description.trim(),
                    project_id,
                    i64::from(input.enabled),
                    steps_json,
                    now
                ],
            )?;
            read_recipe(conn, &id)
        }
    })
}

pub fn delete_impl(db: &Db, id: &str) -> AppResult<bool> {
    db.with_conn(|conn| {
        let n = conn.execute("DELETE FROM capability_recipes WHERE id=?1", [id])?;
        if n == 0 {
            return Err(AppError::NotFound(format!("能力配方不存在: {id}")));
        }
        Ok(true)
    })
}

pub fn duplicate_impl(db: &Db, id: &str) -> AppResult<Recipe> {
    let source = get_impl(db, id)?;
    save_impl(
        db,
        RecipeInput {
            id: None,
            name: format!("{}（副本）", source.name),
            description: source.description,
            project_id: source.project_id,
            enabled: false,
            steps: source.steps,
        },
    )
}

pub fn export_impl(db: &Db, id: &str, include_secret_args: bool) -> AppResult<String> {
    let recipe = get_impl(db, id)?;
    let mut steps = recipe.steps;
    if !include_secret_args {
        for step in &mut steps {
            if let RecipeStep::McpTool { args, .. } = step {
                redact_secret_args(args);
            }
        }
    }
    serde_json::to_string_pretty(&RecipeExport {
        version: 1,
        name: recipe.name,
        description: recipe.description,
        steps,
        secret_args_redacted: !include_secret_args,
    })
    .map_err(AppError::from)
}

pub fn import_impl(db: &Db, raw: &str) -> AppResult<Recipe> {
    if raw.len() > 512 * 1024 {
        return Err(AppError::Validation("配方 JSON 超过 512 KiB".into()));
    }
    let parsed: RecipeExport = serde_json::from_str(raw)
        .map_err(|e| AppError::Validation(format!("配方 JSON 解析失败: {e}")))?;
    if parsed.version != 1 {
        return Err(AppError::Validation(format!(
            "不支持的配方版本: {}",
            parsed.version
        )));
    }
    save_impl(
        db,
        RecipeInput {
            id: None,
            name: parsed.name,
            description: parsed.description,
            project_id: None,
            enabled: false,
            steps: parsed.steps,
        },
    )
}

// ── 执行 ───────────────────────────────────────────────────────────
//
// 步骤执行统一委托 `capability::steps`；本模块只保留模板校验、整次确认与运行记录。

pub fn run_impl(db: &Db, id: &str, confirmed: bool) -> AppResult<RecipeRun> {
    let recipe = get_impl(db, id)?;
    if !recipe.enabled {
        return Err(AppError::Validation("配方已禁用，请先启用".into()));
    }
    let mut high_risk = false;
    for step in &recipe.steps {
        if step_is_high_risk(db, step)? {
            high_risk = true;
            break;
        }
    }
    if high_risk && !confirmed {
        return Err(AppError::Validation(
            "配方包含高风险 MCP 工具步骤，需要确认后执行".into(),
        ));
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO capability_recipe_runs(id,recipe_id,status,started_at,finished_at,steps_json,error) \
             VALUES (?1,?2,'running',?3,NULL,'[]','')",
            params![run_id, id, started_at],
        )?;
        Ok::<_, AppError>(())
    })?;

    let mut logs: Vec<RecipeRunStepLog> = Vec::new();
    let mut failure: Option<String> = None;
    for (index, step) in recipe.steps.iter().enumerate() {
        let step_started = std::time::Instant::now();
        let previous: Vec<(String, Value)> = logs
            .iter()
            .map(|log| (log.step_type.clone(), log.output.clone()))
            .collect();
        match execute_step(db, step, &previous) {
            Ok(output) => {
                logs.push(RecipeRunStepLog {
                    index,
                    step_type: step.kind().to_string(),
                    status: "succeeded".into(),
                    detail: String::new(),
                    output: cap_step_output(output),
                    duration_ms: step_started.elapsed().as_millis() as i64,
                });
            }
            Err(error) => {
                let message = truncate_chars(&error.to_string(), 500);
                logs.push(RecipeRunStepLog {
                    index,
                    step_type: step.kind().to_string(),
                    status: "failed".into(),
                    detail: message.clone(),
                    output: Value::Null,
                    duration_ms: step_started.elapsed().as_millis() as i64,
                });
                failure = Some(message);
                break;
            }
        }
    }
    let finished_at = now_iso();
    let status = if failure.is_some() { "failed" } else { "succeeded" };
    let steps_json = serde_json::to_string(&logs)?;
    let error_text = failure.clone().unwrap_or_default();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE capability_recipe_runs SET status=?2, finished_at=?3, steps_json=?4, error=?5 \
             WHERE id=?1",
            params![run_id, status, finished_at, steps_json, error_text],
        )?;
        Ok::<_, AppError>(())
    })?;
    get_run_impl(db, &run_id)
}

pub fn get_run_impl(db: &Db, id: &str) -> AppResult<RecipeRun> {
    db.with_read(|conn| {
        let (recipe_id, status, started_at, finished_at, steps_json, error, recipe_name): (
            String,
            String,
            String,
            Option<String>,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT r.recipe_id, r.status, r.started_at, r.finished_at, r.steps_json, r.error, \
                        c.name FROM capability_recipe_runs r \
                 JOIN capability_recipes c ON c.id = r.recipe_id WHERE r.id=?1",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("配方运行记录不存在: {id}")))?;
        Ok(RecipeRun {
            id: id.to_string(),
            recipe_id,
            recipe_name,
            status,
            started_at,
            finished_at,
            steps: serde_json::from_str(&steps_json).unwrap_or_default(),
            error,
        })
    })
}

pub fn list_runs_impl(
    db: &Db,
    recipe_id: Option<&str>,
    offset: usize,
    limit: usize,
) -> AppResult<RecipeRunPage> {
    let limit = limit.clamp(1, 200);
    let recipe_id = recipe_id.map(str::trim).filter(|v| !v.is_empty());
    db.with_read(|conn| {
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM capability_recipe_runs WHERE (?1 IS NULL OR recipe_id=?1)",
            params![recipe_id],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(
            "SELECT r.id, r.recipe_id, c.name, r.status, r.started_at, r.finished_at, r.error \
             FROM capability_recipe_runs r JOIN capability_recipes c ON c.id=r.recipe_id \
             WHERE (?1 IS NULL OR r.recipe_id=?1) \
             ORDER BY r.started_at DESC, r.id DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt.query_map(params![recipe_id, limit as i64, offset as i64], |r| {
            Ok(RecipeRunSummary {
                id: r.get(0)?,
                recipe_id: r.get(1)?,
                recipe_name: r.get(2)?,
                status: r.get(3)?,
                started_at: r.get(4)?,
                finished_at: r.get(5)?,
                error: r.get(6)?,
            })
        })?;
        let items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = offset.saturating_add(items.len()) < total as usize;
        Ok(RecipeRunPage {
            items,
            total,
            offset,
            limit,
            has_more,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recipe(db: &Db, steps: Vec<RecipeStep>) -> Recipe {
        save_impl(
            db,
            RecipeInput {
                id: None,
                name: "测试配方".into(),
                description: String::new(),
                project_id: None,
                enabled: true,
                steps,
            },
        )
        .unwrap()
    }

    #[test]
    fn save_rejects_empty_or_unknown_step_fields() {
        let db = Db::open_in_memory().unwrap();
        assert!(save_impl(
            &db,
            RecipeInput {
                id: None,
                name: "空".into(),
                description: String::new(),
                project_id: None,
                enabled: true,
                steps: Vec::new(),
            }
        )
        .is_err());
        assert!(save_impl(
            &db,
            RecipeInput {
                id: None,
                name: "坏".into(),
                description: String::new(),
                project_id: None,
                enabled: true,
                steps: vec![RecipeStep::KnowledgeSearch {
                    kb_ids: Vec::new(),
                    query: "".into(),
                    limit: 5,
                }],
            }
        )
        .is_err());
        assert!(import_impl(&db, r#"{"version":1,"name":"x","steps":[{"type":"shell","command":"rm"}]}"#).is_err());
    }

    #[test]
    fn knowledge_recipe_runs_and_records_steps() {
        let db = Db::open_in_memory().unwrap();
        let data = std::env::temp_dir().join(format!("td-recipe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data).unwrap();
        let file = data.join("a.md");
        std::fs::write(&file, "章节检查需要人物一致性").unwrap();
        let kb_id = super::super::knowledge::create_base_impl(
            &db,
            super::super::knowledge::KnowledgeBaseInput {
                name: "小说".into(),
                description: String::new(),
                kind: "personal".into(),
                project_id: None,
                workspace_id: None,
            },
        )
        .unwrap()
        .id;
        super::super::knowledge::import_file_impl(
            &db,
            &data,
            &kb_id,
            file.to_str().unwrap(),
            "reference",
            None,
        )
        .unwrap();
        let saved = recipe(
            &db,
            vec![
                RecipeStep::KnowledgeSearch {
                    kb_ids: vec![kb_id],
                    query: "人物".into(),
                    limit: 3,
                },
                RecipeStep::SaveNote {
                    title: "章节检查结果".into(),
                },
            ],
        );
        let run = run_impl(&db, &saved.id, false).unwrap();
        assert_eq!(run.status, "succeeded");
        assert_eq!(run.steps.len(), 2);
        assert!(run.steps[0].output.to_string().contains("章节检查"));
        let note_id = run.steps[1].output.get("noteId").and_then(Value::as_str).unwrap();
        let note = crate::notes::store::get(&db, note_id).unwrap();
        assert_eq!(note.title, "章节检查结果");
        assert!(note.content.contains("knowledge_search"));
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn disabled_recipe_cannot_run_and_failure_stops() {
        let db = Db::open_in_memory().unwrap();
        let saved = recipe(
            &db,
            vec![RecipeStep::KnowledgeSearch {
                kb_ids: Vec::new(),
                query: "任意".into(),
                limit: 1,
            }],
        );
        save_impl(
            &db,
            RecipeInput {
                id: Some(saved.id.clone()),
                name: saved.name,
                description: String::new(),
                project_id: None,
                enabled: false,
                steps: saved.steps,
            },
        )
        .unwrap();
        assert!(run_impl(&db, &saved.id, false).is_err());
    }

    #[test]
    fn export_and_import_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let saved = recipe(
            &db,
            vec![RecipeStep::SaveNote {
                title: "结果".into(),
            }],
        );
        let exported = export_impl(&db, &saved.id, false).unwrap();
        let imported = import_impl(&db, &exported).unwrap();
        assert_eq!(imported.steps.len(), 1);
        assert!(!imported.enabled);
        assert_ne!(imported.id, saved.id);
    }

    #[test]
    fn export_redacts_secret_args_by_default() {
        let db = Db::open_in_memory().unwrap();
        let server_id = super::super::external_mcp::save_server_impl(
            &db,
            super::super::external_mcp::McpServerInput {
                id: None,
                name: "s".into(),
                command: "cmd".into(),
                args: Vec::new(),
                env: Vec::new(),
            },
        )
        .unwrap()
        .id;
        let saved = recipe(
            &db,
            vec![RecipeStep::McpTool {
                server_id,
                tool_name: "echo".into(),
                args: json!({ "token": "super-secret", "path": "x" }),
                high_risk: false,
            }],
        );
        let safe = export_impl(&db, &saved.id, false).unwrap();
        assert!(!safe.contains("super-secret"));
        assert!(safe.contains("***"));
        assert!(safe.contains("secretArgsRedacted"));
        let full = export_impl(&db, &saved.id, true).unwrap();
        assert!(full.contains("super-secret"));
    }

    #[test]
    fn high_risk_mcp_requires_confirmation() {
        let db = Db::open_in_memory().unwrap();
        let server_id = super::super::external_mcp::save_server_impl(
            &db,
            super::super::external_mcp::McpServerInput {
                id: None,
                name: "s".into(),
                command: "cmd".into(),
                args: Vec::new(),
                env: Vec::new(),
            },
        )
        .unwrap()
        .id;
        let saved = recipe(
            &db,
            vec![RecipeStep::McpTool {
                server_id,
                tool_name: "write_file".into(),
                args: json!({}),
                high_risk: true,
            }],
        );
        let err = run_impl(&db, &saved.id, false).unwrap_err();
        assert!(err.to_string().contains("确认"));
    }
}
