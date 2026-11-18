//! 项目上下文：绑定知识库 / Skill / 外部 MCP 工具 / 任务，并装配成有来源、有上限的上下文包。
//!
//! 设计约束：
//! - 装配结果**不落库**，每次按当前真实数据计算；
//! - 只包含用户显式绑定的资源，绝不把整个知识库/全部 Skill 一次性塞入；
//! - 有总字符上限与逐项截断，返回来源清单，供 Agent 引用与用户核对。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{check_project, check_text, now_iso, truncate_chars};

const MAX_KB_IDS: usize = 50;
const MAX_SKILL_IDS: usize = 50;
const MAX_MCP_TOOLS: usize = 50;
const MAX_TASK_IDS: usize = 50;
const MAX_RULES_CHARS: usize = 4000;
const MAX_CONTEXT_CHARS_LIMIT: usize = 40_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolRef {
    pub server_id: String,
    pub tool_name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextConfig {
    #[serde(default)]
    pub kb_ids: Vec<String>,
    #[serde(default)]
    pub skill_ids: Vec<String>,
    #[serde(default)]
    pub mcp_tools: Vec<McpToolRef>,
    #[serde(default)]
    pub task_ids: Vec<String>,
    #[serde(default)]
    pub rules: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub project_id: Option<String>,
    pub config: ContextConfig,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub config: ContextConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleItem {
    pub id: String,
    pub title: String,
    pub source: String,
    pub excerpt: String,
    pub chars: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSection {
    pub kind: String,
    pub title: String,
    pub items: Vec<BundleItem>,
    pub chars: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSource {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundle {
    pub sections: Vec<BundleSection>,
    pub total_chars: usize,
    pub truncated: bool,
    pub sources: Vec<BundleSource>,
}

fn validate_config(db: &Db, config: &ContextConfig) -> AppResult<()> {
    if config.kb_ids.len() > MAX_KB_IDS {
        return Err(AppError::Validation(format!(
            "绑定的知识库最多 {MAX_KB_IDS} 个"
        )));
    }
    if config.skill_ids.len() > MAX_SKILL_IDS {
        return Err(AppError::Validation(format!(
            "绑定的 Skill 最多 {MAX_SKILL_IDS} 个"
        )));
    }
    if config.mcp_tools.len() > MAX_MCP_TOOLS {
        return Err(AppError::Validation(format!(
            "绑定的 MCP 工具最多 {MAX_MCP_TOOLS} 个"
        )));
    }
    if config.task_ids.len() > MAX_TASK_IDS {
        return Err(AppError::Validation(format!(
            "绑定的任务最多 {MAX_TASK_IDS} 个"
        )));
    }
    if config.rules.chars().count() > MAX_RULES_CHARS || config.rules.contains('\0') {
        return Err(AppError::Validation(format!(
            "上下文规则超过 {MAX_RULES_CHARS} 字符或含非法字符"
        )));
    }
    db.with_read(|conn| {
        for id in &config.kb_ids {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM knowledge_bases WHERE id=?1)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!("知识库不存在: {id}")));
            }
        }
        for id in &config.skill_ids {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM capability_skills WHERE id=?1)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!("Skill 不存在: {id}")));
            }
        }
        for tool in &config.mcp_tools {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM external_mcp_servers WHERE id=?1)",
                [&tool.server_id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!(
                    "外部 MCP Server 不存在: {}",
                    tool.server_id
                )));
            }
            if tool.tool_name.trim().is_empty() {
                return Err(AppError::Validation("绑定的 MCP 工具名称不能为空".into()));
            }
        }
        for id in &config.task_ids {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!("任务不存在: {id}")));
            }
        }
        Ok(())
    })
}

fn row_to_context(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContextProfile> {
    let raw: String = row.get(4)?;
    Ok(ContextProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        project_id: row.get(3)?,
        config: serde_json::from_str(&raw).unwrap_or_default(),
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const CONTEXT_COLUMNS: &str = "id, name, description, project_id, config_json, created_at, updated_at";

fn read_context(conn: &Connection, id: &str) -> AppResult<ContextProfile> {
    conn.query_row(
        &format!("SELECT {CONTEXT_COLUMNS} FROM capability_contexts WHERE id=?1"),
        [id],
        row_to_context,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("上下文配置不存在: {id}")))
}

pub fn list_impl(db: &Db, project_id: Option<&str>) -> AppResult<Vec<ContextProfile>> {
    let project = project_id.map(str::trim).filter(|v| !v.is_empty());
    db.with_read(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {CONTEXT_COLUMNS} FROM capability_contexts \
             WHERE (?1 IS NULL OR project_id=?1) ORDER BY updated_at DESC, name"
        ))?;
        let rows = stmt.query_map(params![project], row_to_context)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

pub fn get_impl(db: &Db, id: &str) -> AppResult<ContextProfile> {
    db.with_read(|conn| read_context(conn, id))
}

pub fn save_impl(db: &Db, input: ContextInput) -> AppResult<ContextProfile> {
    let name = check_text(&input.name, "上下文名称", 80)?;
    if input.description.chars().count() > 1000 {
        return Err(AppError::Validation("上下文描述超过 1000 字符".into()));
    }
    validate_config(db, &input.config)?;
    let config_json = serde_json::to_string(&input.config)?;
    let now = now_iso();
    db.with_conn(|conn| {
        let project_id = check_project(conn, input.project_id.as_deref())?;
        if let Some(id) = &input.id {
            let n = conn.execute(
                "UPDATE capability_contexts SET name=?2, description=?3, project_id=?4, \
                 config_json=?5, updated_at=?6 WHERE id=?1",
                params![id, name, input.description.trim(), project_id, config_json, now],
            )?;
            if n == 0 {
                return Err(AppError::NotFound(format!("上下文配置不存在: {id}")));
            }
            read_context(conn, id)
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO capability_contexts(id,name,description,project_id,config_json,created_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?6)",
                params![id, name, input.description.trim(), project_id, config_json, now],
            )?;
            read_context(conn, &id)
        }
    })
}

pub fn delete_impl(db: &Db, id: &str) -> AppResult<bool> {
    db.with_conn(|conn| {
        let n = conn.execute("DELETE FROM capability_contexts WHERE id=?1", [id])?;
        if n == 0 {
            return Err(AppError::NotFound(format!("上下文配置不存在: {id}")));
        }
        Ok(true)
    })
}

pub fn duplicate_impl(db: &Db, id: &str) -> AppResult<ContextProfile> {
    let source = get_impl(db, id)?;
    save_impl(
        db,
        ContextInput {
            id: None,
            name: format!("{}（副本）", source.name),
            description: source.description,
            project_id: source.project_id,
            config: source.config,
        },
    )
}

// ── 装配 ─────────────────────────────────────────────────────────

struct Budget {
    max: usize,
    used: usize,
    truncated: bool,
}

impl Budget {
    fn take(&mut self, text: &str) -> Option<String> {
        if self.used >= self.max {
            self.truncated = true;
            return None;
        }
        let remaining = self.max - self.used;
        let count = text.chars().count();
        if count <= remaining {
            self.used += count;
            return Some(text.to_string());
        }
        self.truncated = true;
        let excerpt = truncate_chars(text, remaining);
        self.used += excerpt.chars().count();
        Some(excerpt)
    }
}

fn push_section(
    sections: &mut Vec<BundleSection>,
    sources: &mut Vec<BundleSource>,
    budget: &mut Budget,
    kind: &str,
    title: &str,
    items: Vec<(BundleItem, Option<String>)>,
) {
    let mut kept = Vec::new();
    let mut chars = 0usize;
    for (item, path) in items {
        let Some(excerpt) = budget.take(&item.excerpt) else {
            break;
        };
        let chars_item = excerpt.chars().count();
        chars += chars_item;
        sources.push(BundleSource {
            kind: kind.to_string(),
            id: item.id.clone(),
            label: item.title.clone(),
            path,
        });
        kept.push(BundleItem { excerpt, chars: chars_item, ..item });
    }
    if !kept.is_empty() {
        sections.push(BundleSection {
            kind: kind.to_string(),
            title: title.to_string(),
            items: kept,
            chars,
        });
    }
}

pub fn assemble_impl(
    db: &Db,
    id: Option<&str>,
    config: Option<ContextConfig>,
    query: Option<&str>,
    max_chars: Option<usize>,
) -> AppResult<ContextBundle> {
    let (config, project_id) = match id.map(str::trim).filter(|v| !v.is_empty()) {
        Some(id) => {
            let profile = get_impl(db, id)?;
            (profile.config, profile.project_id)
        }
        None => (
            config.ok_or_else(|| {
                AppError::Validation("装配上下文需要配置 id 或临时 config".into())
            })?,
            None,
        ),
    };
    validate_config(db, &config)?;
    let query = query.map(str::trim).filter(|v| !v.is_empty());
    if let Some(q) = query {
        if q.chars().count() > 200 {
            return Err(AppError::Validation("查询词超过 200 字符".into()));
        }
    }
    let max = max_chars.unwrap_or(12_000).clamp(200, MAX_CONTEXT_CHARS_LIMIT);
    let mut budget = Budget {
        max,
        used: 0,
        truncated: false,
    };
    let mut sections = Vec::new();
    let mut sources = Vec::new();

    // 1) 规则
    if !config.rules.trim().is_empty() {
        push_section(
            &mut sections,
            &mut sources,
            &mut budget,
            "rules",
            "项目规则",
            vec![(
                BundleItem {
                    id: "rules".into(),
                    title: "规则与角色".into(),
                    source: "上下文配置".into(),
                    excerpt: config.rules.trim().to_string(),
                    chars: 0,
                },
                None,
            )],
        );
    }

    // 2) 知识
    if !config.kb_ids.is_empty() {
        let items: Vec<(BundleItem, Option<String>)> = db.with_read(|conn| {
            if let Some(q) = query {
                // 复用知识库检索（不在本模块复制检索逻辑）。
                let page = super::knowledge::search_in_conn(
                    conn,
                    q,
                    &config.kb_ids,
                    None,
                    None,
                    8,
                    0,
                )?;
                Ok(page
                    .hits
                    .into_iter()
                    .map(|hit| {
                        (
                            BundleItem {
                                id: hit.doc_id,
                                title: hit.title,
                                source: format!("知识库：{}", hit.kb_name),
                                excerpt: hit.snippet,
                                chars: 0,
                            },
                            hit.source_path,
                        )
                    })
                    .collect())
            } else {
                let placeholders = vec!["?"; config.kb_ids.len()].join(",");
                let sql = format!(
                    "SELECT d.id, d.title, d.source_path, kb.name, substr(d.content, 1, 400) \
                     FROM knowledge_documents d JOIN knowledge_bases kb ON kb.id=d.kb_id \
                     WHERE d.kb_id IN ({placeholders}) AND d.status='indexed' \
                     ORDER BY d.updated_at DESC LIMIT 8"
                );
                let mut stmt = conn.prepare(&sql)?;
                let refs: Vec<&dyn rusqlite::ToSql> =
                    config.kb_ids.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
                let rows = stmt.query_map(refs.as_slice(), |r| {
                    let id: String = r.get(0)?;
                    let title: String = r.get(1)?;
                    let path: Option<String> = r.get(2)?;
                    let kb_name: String = r.get(3)?;
                    let excerpt: String = r.get(4)?;
                    Ok((
                        BundleItem {
                            id,
                            title,
                            source: format!("知识库：{kb_name}"),
                            excerpt: excerpt.replace('\n', " "),
                            chars: 0,
                        },
                        path,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
            }
        })?;
        push_section(
            &mut sections,
            &mut sources,
            &mut budget,
            "knowledge",
            "相关知识",
            items,
        );
    }

    // 3) Skill（只列启用、未丢失且作用域匹配的绑定项）
    if !config.skill_ids.is_empty() {
        let access = super::skills::SkillAccessContext {
            project_id: project_id.as_deref(),
            // 现有 Workspace 身份复用 workspace_projects.id，与项目同源。
            workspace_id: project_id.as_deref(),
            // 预览没有具体 Agent 身份：agent 级 Skill 不进入预览（只对指定 Agent 可见）。
            agent_row_id: None,
        };
        let items: Vec<(BundleItem, Option<String>)> = db.with_read(|conn| {
            let mut out = Vec::new();
            for id in &config.skill_ids {
                let row = conn
                    .query_row(
                        "SELECT name, description, source_path, content, enabled, missing, \
                                scope, project_id, workspace_id, agent_id \
                         FROM capability_skills WHERE id=?1",
                        [id],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, String>(2)?,
                                r.get::<_, String>(3)?,
                                r.get::<_, i64>(4)? != 0,
                                r.get::<_, i64>(5)? != 0,
                                r.get::<_, String>(6)?,
                                r.get::<_, Option<String>>(7)?,
                                r.get::<_, Option<String>>(8)?,
                                r.get::<_, Option<String>>(9)?,
                            ))
                        },
                    )
                    .optional()?;
                let Some((
                    name,
                    description,
                    path,
                    content,
                    enabled,
                    missing,
                    scope,
                    skill_project,
                    skill_workspace,
                    skill_agent,
                )) = row
                else {
                    continue;
                };
                if !enabled || missing {
                    continue;
                }
                if !super::skills::is_applicable(
                    &scope,
                    skill_project.as_deref(),
                    skill_workspace.as_deref(),
                    skill_agent.as_deref(),
                    &access,
                ) {
                    continue;
                }
                let excerpt = if description.trim().is_empty() {
                    truncate_chars(&content, 600)
                } else {
                    truncate_chars(&format!("{description}\n{}", truncate_chars(&content, 500)), 700)
                };
                out.push((
                    BundleItem {
                        id: id.clone(),
                        title: name,
                        source: "Skill".into(),
                        excerpt,
                        chars: 0,
                    },
                    Some(path),
                ));
            }
            Ok(out)
        })?;
        push_section(
            &mut sections,
            &mut sources,
            &mut budget,
            "skills",
            "适用 Skill",
            items,
        );
    }

    // 4) MCP 工具（只列已启用 Server 的已发现工具；工具不存在时如实说明）
    if !config.mcp_tools.is_empty() {
        let items: Vec<(BundleItem, Option<String>)> = db.with_read(|conn| {
            let mut out = Vec::new();
            for tool_ref in &config.mcp_tools {
                let row = conn
                    .query_row(
                        "SELECT name, enabled, tools_json FROM external_mcp_servers WHERE id=?1",
                        [&tool_ref.server_id],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, i64>(1)? != 0,
                                r.get::<_, String>(2)?,
                            ))
                        },
                    )
                    .optional()?;
                let Some((server_name, enabled, tools_json)) = row else {
                    continue;
                };
                if !enabled {
                    continue;
                }
                let tools: Vec<serde_json::Value> =
                    serde_json::from_str(&tools_json).unwrap_or_default();
                let found = tools
                    .into_iter()
                    .find(|t| t.get("name").and_then(|v| v.as_str()) == Some(&tool_ref.tool_name));
                let excerpt = match found {
                    Some(tool) => {
                        let description = tool
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let schema = tool
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or(serde_json::json!({}));
                        truncate_chars(
                            &format!(
                                "{}\n参数结构：{}",
                                description,
                                truncate_chars(&schema.to_string(), 1200)
                            ),
                            1400,
                        )
                    }
                    None => "工具快照不存在（Server 可能已变更），请重新测试连接".to_string(),
                };
                out.push((
                    BundleItem {
                        id: format!("{}:{}", tool_ref.server_id, tool_ref.tool_name),
                        title: format!("{server_name} / {}", tool_ref.tool_name),
                        source: "外部 MCP".into(),
                        excerpt,
                        chars: 0,
                    },
                    None,
                ));
            }
            Ok(out)
        })?;
        push_section(
            &mut sections,
            &mut sources,
            &mut budget,
            "mcp",
            "可用 MCP 工具",
            items,
        );
    }

    // 5) 任务
    if !config.task_ids.is_empty() {
        let items: Vec<(BundleItem, Option<String>)> = db.with_read(|conn| {
            let mut out = Vec::new();
            for id in &config.task_ids {
                let row = conn
                    .query_row(
                        "SELECT title, status, priority, description FROM tasks WHERE id=?1",
                        [id],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, i64>(2)?,
                                r.get::<_, String>(3)?,
                            ))
                        },
                    )
                    .optional()?;
                let Some((title, status, priority, description)) = row else {
                    continue;
                };
                out.push((
                    BundleItem {
                        id: id.clone(),
                        title,
                        source: format!("任务（{status}，优先级 {priority}）"),
                        excerpt: truncate_chars(&description, 300),
                        chars: 0,
                    },
                    None,
                ));
            }
            Ok(out)
        })?;
        push_section(
            &mut sections,
            &mut sources,
            &mut budget,
            "tasks",
            "关联任务",
            items,
        );
    }

    // 项目名只作为来源说明，不复制项目数据。
    if let Some(project_id) = project_id {
        if let Ok(name) = db.with_read(|conn| {
            conn.query_row(
                "SELECT name FROM workspace_projects WHERE id=?1",
                [&project_id],
                |r| r.get::<_, String>(0),
            )
            .map_err(AppError::from)
        }) {
            sources.push(BundleSource {
                kind: "project".into(),
                id: project_id,
                label: name,
                path: None,
            });
        }
    }

    Ok(ContextBundle {
        sections,
        total_chars: budget.used,
        truncated: budget.truncated,
        sources,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::knowledge::{self, KnowledgeBaseInput};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("td-ctx-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_validates_references_and_duplicate_is_independent() {
        let db = Db::open_in_memory().unwrap();
        let mut config = ContextConfig::default();
        config.kb_ids.push("missing".into());
        assert!(save_impl(
            &db,
            ContextInput {
                id: None,
                name: "上下文".into(),
                description: String::new(),
                project_id: None,
                config,
            }
        )
        .is_err());

        let profile = save_impl(
            &db,
            ContextInput {
                id: None,
                name: "上下文".into(),
                description: String::new(),
                project_id: None,
                config: ContextConfig {
                    rules: "保持人物一致".into(),
                    ..Default::default()
                },
            },
        )
        .unwrap();
        let copy = duplicate_impl(&db, &profile.id).unwrap();
        assert!(copy.name.contains("副本"));
        assert_ne!(copy.id, profile.id);
        let updated = save_impl(
            &db,
            ContextInput {
                id: Some(copy.id.clone()),
                name: "副本改名".into(),
                description: String::new(),
                project_id: None,
                config: ContextConfig::default(),
            },
        )
        .unwrap();
        assert_eq!(updated.name, "副本改名");
        assert_eq!(get_impl(&db, &profile.id).unwrap().config.rules, "保持人物一致");
    }

    #[test]
    fn assemble_respects_budget_and_sources() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("assemble");
        let file = data.join("a.md");
        std::fs::write(&file, "苏州城外的雨夜，林深抵达旧城。".repeat(20)).unwrap();
        let kb_id = knowledge::create_base_impl(
            &db,
            KnowledgeBaseInput {
                name: "小说".into(),
                description: String::new(),
                kind: "personal".into(),
                project_id: None,
                workspace_id: None,
            },
        )
        .unwrap()
        .id;
        knowledge::import_file_impl(&db, &data, &kb_id, file.to_str().unwrap(), "reference", None)
            .unwrap();
        let config = ContextConfig {
            kb_ids: vec![kb_id],
            // 规则占掉大半预算，确保知识片段必须被截断。
            rules: "保持时间线一致与人物设定一致。".repeat(10),
            ..Default::default()
        };
        let bundle = assemble_impl(&db, None, Some(config.clone()), Some("雨夜"), None).unwrap();
        assert!(bundle.total_chars > 0);
        assert!(bundle.sections.iter().any(|s| s.kind == "knowledge"));
        assert!(bundle.sources.iter().any(|s| s.kind == "knowledge"));
        let small = assemble_impl(&db, None, Some(config), Some("雨夜"), Some(200)).unwrap();
        assert!(small.total_chars <= 200);
        assert!(small.truncated);
        std::fs::remove_dir_all(data).ok();
    }
}
