//! 项目资源服务：能力 ↔ 资源的真实关联。
//!
//! 设计边界（`docs/project-hub/02-架构设计.md` §4）：
//! - **能力是「能不能做」，资源是「有没有可调用的东西」**：能力库是 `project_capabilities`，
//!   资源是知识库 / Skill / MCP / Agent / 工具 / 模板 / 工作流，两者用
//!   `capability_resource_links` 关联，不得合并成一张表。
//! - **关联有明确归属**（v87）：`project_capability_links.project_id` 是关联行所属项目，
//!   `scope` 表达作用域。禁止再用全局 `capability_id` 推断项目资源所有权：
//!   两个项目引用同一个能力库条目是合法且常见的，但 A 的私有资源不得出现在 B 的清单里。
//! - `scope='project'`：私有绑定，只有归属项目能查询、校验、解除；
//!   `scope='global'`：显式共享的全局资源绑定，所有需要该能力的项目可见、可校验，
//!   但只有创建者能解除。
//! - 关联只写引用：不解绑不删除资源本体，也不复制资源内容。
//! - 可用性是**探测结果**，不是推断：`available / partial / unavailable / unknown` 必须来自
//!   真实记录（数据库存在性、本地文件存在性、启用状态、缺失标记、连接状态），
//!   无法判定时给 `unknown`；MCP 的 `status` 是**已记录状态**，不是实时连接探测。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 资源类型：与 `capability_resource_links.resource_kind` 的 CHECK 约束一致。
pub const RESOURCE_KINDS: &[&str] = &[
    "knowledge", "skill", "mcp", "agent", "tool", "template", "workflow",
];

const AVAILABILITY_VALUES: &[&str] = &["available", "partial", "unavailable", "unknown"];

/// 可绑定资源候选（真实资源，不含尚未登记的类型）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCandidate {
    pub kind: String,
    pub id: String,
    pub label: String,
    /// `global` / `project`：资源自身的作用域（决定绑定时使用哪种关联作用域）。
    pub scope: String,
    pub availability: String,
    pub detail: String,
}

/// 能力 ↔ 资源关联行。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResourceLink {
    pub id: String,
    /// 关联归属项目（`scope='global'` 时是创建者项目）。
    pub project_id: String,
    /// `project` / `global`。
    pub scope: String,
    pub capability_id: String,
    pub capability_name: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub label: String,
    pub availability: String,
    /// 探测依据（数据库 / 本地文件 / 记录状态），说明这次判定不是「有链接就算可用」。
    pub detail: String,
    pub last_checked_at: Option<String>,
    pub created_at: String,
}

/// 资源关联写入输入。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLinkInput {
    pub capability_id: String,
    pub resource_kind: String,
    pub resource_id: String,
}

// ── 基础查询 ──────────────────────────────────────────────────────────

fn table_exists(conn: &Connection, name: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn clean_kind(kind: &str) -> AppResult<String> {
    let text = kind.trim().to_ascii_lowercase();
    if !RESOURCE_KINDS.contains(&text.as_str()) {
        return Err(AppError::Validation(format!("资源类型不支持：{text}")));
    }
    Ok(text)
}

fn clean_id(value: &str, field: &str) -> AppResult<String> {
    let text = value.trim();
    if text.is_empty() {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    Ok(text.to_string())
}

fn file_state(path: &str) -> (&'static str, String) {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return ("unknown", "未记录来源路径".to_string());
    }
    if Path::new(trimmed).exists() {
        ("ok", format!("来源存在：{trimmed}"))
    } else {
        ("missing", format!("来源路径不存在：{trimmed}"))
    }
}

/// 资源候选清单：只列出**当前项目可见**的真实资源。
///
/// 项目私有资源（知识库 `project_id`/`workspace_id`、Skill `scope=project`）只出现在
/// 归属项目；全局资源（知识库无归属、`scope=global` 的 Skill、MCP、Agent 工作空间、
/// 工作流）对所有项目可见。
pub fn list_candidates(
    conn: &Connection,
    project_id: &str,
    kind: Option<&str>,
    query: Option<&str>,
) -> AppResult<Vec<ResourceCandidate>> {
    let wanted = match kind {
        Some(value) => Some(clean_kind(value)?),
        None => None,
    };
    let needle = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let mut rows: Vec<ResourceCandidate> = Vec::new();

    let wants = |k: &str| wanted.as_deref().map(|w| w == k).unwrap_or(true);

    if wants("knowledge") && table_exists(conn, "knowledge_bases")? {
        // workspace_id 是 v74 增加的真实绑定列；两列都按当前项目过滤，
        // 全局知识库要求 project_id 与 workspace_id 同时为空。
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, project_id, workspace_id FROM knowledge_bases
             WHERE (project_id IS NULL AND workspace_id IS NULL)
                OR project_id = ?1 OR workspace_id = ?1
             ORDER BY updated_at DESC",
        )?;
        let mapped = stmt.query_map(params![project_id], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let kind: String = r.get(2)?;
            let owner: Option<String> = r.get(3)?;
            let workspace: Option<String> = r.get(4)?;
            let scoped = owner.is_some() || workspace.is_some();
            Ok(ResourceCandidate {
                kind: "knowledge".into(),
                id,
                label: name,
                scope: if scoped { "project".into() } else { "global".into() },
                availability: "available".into(),
                detail: format!("知识库（{kind}）：数据库记录存在，未做正文可用性探测"),
            })
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    if wants("skill") && table_exists(conn, "capability_skills")? {
        let mut stmt = conn.prepare(
            "SELECT id, name, scope, project_id, enabled, missing, format_ok, source_path
             FROM capability_skills
             WHERE (scope = 'global' AND project_id IS NULL) OR project_id = ?1
             ORDER BY name",
        )?;
        let mapped = stmt.query_map(params![project_id], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let scope: String = r.get(2)?;
            let owner: Option<String> = r.get(3)?;
            let enabled: i64 = r.get(4)?;
            let missing: i64 = r.get(5)?;
            let format_ok: i64 = r.get(6)?;
            let source_path: String = r.get(7)?;
            let (availability, detail) = if missing != 0 {
                ("unavailable".to_string(), "Skill 来源已标记缺失".to_string())
            } else if enabled == 0 {
                ("unavailable".to_string(), "Skill 已禁用".to_string())
            } else {
                let (state, detail) = file_state(&source_path);
                if state == "missing" {
                    ("unavailable".to_string(), detail)
                } else if format_ok == 0 {
                    ("partial".to_string(), "Skill 格式校验未通过".to_string())
                } else if state == "unknown" {
                    ("unknown".to_string(), detail)
                } else {
                    ("available".to_string(), detail)
                }
            };
            Ok(ResourceCandidate {
                kind: "skill".into(),
                id,
                label: name,
                scope: if owner.is_some() {
                    "project".into()
                } else {
                    scope
                },
                availability,
                detail,
            })
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    if wants("mcp") && table_exists(conn, "external_mcp_servers")? {
        let mut stmt = conn.prepare(
            "SELECT id, name, enabled, status, last_error FROM external_mcp_servers ORDER BY name",
        )?;
        let mapped = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let enabled: i64 = r.get(2)?;
            let status: String = r.get(3)?;
            let last_error: String = r.get(4)?;
            let (availability, detail) = match (enabled, status.as_str()) {
                (0, _) => ("unavailable".to_string(), "MCP Server 已禁用".to_string()),
                (_, "ok") => (
                    "available".to_string(),
                    "MCP Server 上次连接成功（记录状态，非实时探测）".to_string(),
                ),
                (_, "failed") => (
                    "unavailable".to_string(),
                    if last_error.trim().is_empty() {
                        "MCP Server 上次连接失败".to_string()
                    } else {
                        format!("MCP Server 上次连接失败：{}", last_error.trim())
                    },
                ),
                _ => ("unknown".to_string(), "MCP Server 尚未连接".to_string()),
            };
            Ok(ResourceCandidate {
                kind: "mcp".into(),
                id,
                label: name,
                scope: "global".into(),
                availability,
                detail,
            })
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    // Agent 资源来自共享工作空间登记表；该表由独立任务维护，缺失时降级为空清单。
    if wants("agent") && table_exists(conn, "agent_workspaces")? {
        let mut stmt = conn.prepare(
            "SELECT id, name, root_path, enabled FROM agent_workspaces ORDER BY name",
        )?;
        let mapped = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let root: String = r.get(2)?;
            let enabled: i64 = r.get(3)?;
            let label = if name.trim().is_empty() {
                format!("Agent 工作空间 {id}")
            } else {
                name
            };
            let (availability, detail) = if enabled == 0 {
                ("unavailable".to_string(), "Agent 工作空间已禁用".to_string())
            } else {
                match file_state(&root) {
                    ("ok", _) => (
                        "partial".to_string(),
                        format!("Agent 共享工作空间：{root}（目录存在，未验证可写）"),
                    ),
                    ("missing", detail) => ("unavailable".to_string(), detail),
                    (_, detail) => ("unknown".to_string(), detail),
                }
            };
            Ok(ResourceCandidate {
                kind: "agent".into(),
                id,
                label,
                scope: "global".into(),
                availability,
                detail,
            })
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    // 工作流是全局真实实体（`workflows` 表），可直接作为资源候选。
    if wants("workflow") && table_exists(conn, "workflows")? {
        let mut stmt = conn.prepare(
            "SELECT id, name, enabled, description FROM workflows ORDER BY sort_order, name",
        )?;
        let mapped = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let enabled: i64 = r.get(2)?;
            let description: String = r.get(3)?;
            Ok(ResourceCandidate {
                kind: "workflow".into(),
                id,
                label: name,
                scope: "global".into(),
                availability: if enabled != 0 { "available".into() } else { "unavailable".into() },
                detail: if enabled != 0 {
                    if description.trim().is_empty() {
                        "工作流已启用".to_string()
                    } else {
                        format!("工作流已启用：{}", description.trim())
                    }
                } else {
                    "工作流已禁用".to_string()
                },
            })
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    // tool / template 目前没有真实登记表：宁可不返回候选，也不伪造数据。

    if let Some(needle) = needle {
        rows.retain(|row| {
            row.label.to_lowercase().contains(&needle)
                || row.id.to_lowercase().contains(&needle)
                || row.detail.to_lowercase().contains(&needle)
        });
    }
    Ok(rows)
}

const LINK_COLUMNS: &str = "l.id, l.project_id, l.scope, l.capability_id, c.name, l.resource_kind,
        l.resource_id, l.label, l.availability, l.last_checked_at, l.created_at";

/// 项目可见的资源关联：
/// - 本项目创建的关联（`project` 与 `global` 都算）；
/// - 其他项目显式声明为 `global` 的共享关联。
///
/// 私有绑定（`scope='project'`）永远只属于 `project_id` 对应项目。
pub fn list_links(conn: &Connection, project_id: &str) -> AppResult<Vec<CapabilityResourceLink>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {LINK_COLUMNS}
         FROM capability_resource_links l
         JOIN project_capabilities c ON c.id = l.capability_id
         WHERE (l.project_id = ?1 OR l.scope = 'global')
           AND EXISTS (
             SELECT 1 FROM project_capability_requirements r
             WHERE r.project_id = ?1 AND r.capability_id = l.capability_id
           )
         ORDER BY c.name, l.resource_kind, l.label"
    ))?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(CapabilityResourceLink {
            id: r.get(0)?,
            project_id: r.get(1)?,
            scope: r.get(2)?,
            capability_id: r.get(3)?,
            capability_name: r.get(4)?,
            resource_kind: r.get(5)?,
            resource_id: r.get(6)?,
            label: r.get(7)?,
            availability: r.get(8)?,
            detail: String::new(),
            last_checked_at: r.get(9)?,
            created_at: r.get(10)?,
        })
    })?;
    let mut out = rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)?;
    for link in &mut out {
        link.detail = describe_link(conn, project_id, link)?;
    }
    Ok(out)
}

/// 关联的探测依据：按**当前查看项目**的可见候选重新计算，避免展示过期或错位文案。
fn describe_link(
    conn: &Connection,
    viewer_project_id: &str,
    link: &CapabilityResourceLink,
) -> AppResult<String> {
    let candidates = list_candidates(conn, viewer_project_id, Some(&link.resource_kind), None)?;
    Ok(candidates
        .into_iter()
        .find(|item| item.id == link.resource_id)
        .map(|item| item.detail)
        .unwrap_or_else(|| "资源不在当前项目可见范围内（可能已删除或作用域变化）".to_string()))
}

fn require_capability_in_project(
    conn: &Connection,
    project_id: &str,
    capability_id: &str,
) -> AppResult<()> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT capability_id FROM project_capability_requirements
             WHERE project_id = ?1 AND capability_id = ?2",
            params![project_id, capability_id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::Forbidden(
            "能力不属于当前项目，拒绝关联资源".into(),
        ));
    }
    Ok(())
}

fn read_link(conn: &Connection, id: &str) -> AppResult<Option<CapabilityResourceLink>> {
    conn.query_row(
        &format!(
            "SELECT {LINK_COLUMNS}
             FROM capability_resource_links l
             JOIN project_capabilities c ON c.id = l.capability_id
             WHERE l.id = ?1"
        ),
        params![id],
        |r| {
            Ok(CapabilityResourceLink {
                id: r.get(0)?,
                project_id: r.get(1)?,
                scope: r.get(2)?,
                capability_id: r.get(3)?,
                capability_name: r.get(4)?,
                resource_kind: r.get(5)?,
                resource_id: r.get(6)?,
                label: r.get(7)?,
                availability: r.get(8)?,
                detail: String::new(),
                last_checked_at: r.get(9)?,
                created_at: r.get(10)?,
            })
        },
    )
    .optional()
    .map_err(AppError::from)
}

/// 绑定资源到能力（幂等）：重复绑定返回既有关联，不复制资源本体。
///
/// 作用域由**资源自身**决定：
/// - 项目私有资源 → `scope='project'`，只有本项目可见；
/// - 全局资源 → `scope='global'`，跨项目共享一条关联（显式表达共享）。
pub fn link_resource(
    conn: &Connection,
    project_id: &str,
    input: &ResourceLinkInput,
) -> AppResult<CapabilityResourceLink> {
    let capability_id = clean_id(&input.capability_id, "能力 ID")?;
    let kind = clean_kind(&input.resource_kind)?;
    let resource_id = clean_id(&input.resource_id, "资源 ID")?;
    require_capability_in_project(conn, project_id, &capability_id)?;

    let candidates = list_candidates(conn, project_id, Some(&kind), None)?;
    let candidate = candidates
        .into_iter()
        .find(|item| item.id == resource_id)
        .ok_or_else(|| {
            AppError::Validation(format!(
                "资源不存在或不在当前项目作用域内：{kind}/{resource_id}"
            ))
        })?;

    let scope = if candidate.scope == "global" { "global" } else { "project" };
    let now = now_iso();
    let link_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO capability_resource_links
         (id, project_id, scope, capability_id, resource_kind, resource_id, label,
          availability, last_checked_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(project_id, capability_id, resource_kind, resource_id)
           WHERE scope = 'project' DO UPDATE SET
             label = excluded.label,
             availability = excluded.availability,
             last_checked_at = excluded.last_checked_at",
        params![
            link_id,
            project_id,
            scope,
            capability_id,
            kind,
            resource_id,
            candidate.label,
            candidate.availability,
            now
        ],
    )
    .or_else(|err| {
        // 全局共享关联命中 ux_crl_global（其他项目已登记同一条共享绑定）：
        // 复用既有行，而不是新增重复行。
        if scope == "global" && is_unique_violation(&err) {
            conn.execute(
                "UPDATE capability_resource_links
                    SET label = ?2, availability = ?3, last_checked_at = ?4
                  WHERE scope = 'global' AND capability_id = ?1
                    AND resource_kind = ?5 AND resource_id = ?6",
                params![capability_id, candidate.label, candidate.availability, now, kind, resource_id],
            )?;
            return Ok(0);
        }
        Err(err)
    })
    .map_err(AppError::from)?;

    let link_id: String = conn.query_row(
        "SELECT id FROM capability_resource_links
         WHERE capability_id = ?1 AND resource_kind = ?2 AND resource_id = ?3
           AND (project_id = ?4 OR scope = 'global')
         ORDER BY CASE WHEN project_id = ?4 THEN 0 ELSE 1 END
         LIMIT 1",
        params![capability_id, kind, resource_id, project_id],
        |r| r.get(0),
    )?;
    read_link(conn, &link_id)?
        .ok_or_else(|| AppError::NotFound("资源关联写入后不可读".into()))
}

fn is_unique_violation(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

/// 解除关联：只删关联行，不删资源本体。
///
/// 归属校验：只有关联所属项目能解除自己的绑定；共享关联合法可见但不允许他人解除。
pub fn unlink_resource(
    conn: &Connection,
    project_id: &str,
    link_id: &str,
) -> AppResult<()> {
    let link_id = clean_id(link_id, "关联 ID")?;
    let owner: Option<(String, String)> = conn
        .query_row(
            "SELECT l.project_id, l.scope FROM capability_resource_links l
             WHERE l.id = ?1",
            params![link_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((owner_project, _scope)) = owner else {
        return Err(AppError::NotFound("资源关联不存在".into()));
    };
    if owner_project != project_id {
        return Err(AppError::Forbidden(
            "该资源关联属于其他项目，拒绝解除".into(),
        ));
    }
    conn.execute(
        "DELETE FROM capability_resource_links WHERE id = ?1 AND project_id = ?2",
        params![link_id, project_id],
    )?;
    Ok(())
}

/// 重新校验资源可用性：写入真实探测结果与校验时间。
///
/// 可校验范围：本项目创建的关联，以及显式共享（`scope='global'`）的关联。
/// 探测内容按资源类型区分（见 `list_candidates`），**不**统一声称「在线可用」。
pub fn validate_resource(
    conn: &Connection,
    project_id: &str,
    link_id: &str,
) -> AppResult<CapabilityResourceLink> {
    let link_id = clean_id(link_id, "关联 ID")?;
    let link = read_link(conn, &link_id)?
        .ok_or_else(|| AppError::NotFound("资源关联不存在".into()))?;
    if link.project_id != project_id && link.scope != "global" {
        return Err(AppError::Forbidden(
            "该资源关联属于其他项目，拒绝校验".into(),
        ));
    }
    require_capability_in_project(conn, project_id, &link.capability_id)?;

    let (availability, detail) = match list_candidates(conn, project_id, Some(&link.resource_kind), None)?
        .into_iter()
        .find(|item| item.id == link.resource_id)
    {
        Some(item) => (item.availability, item.detail),
        None => (
            "unavailable".to_string(),
            "资源不在当前项目可见范围内（可能已删除或作用域变化）".to_string(),
        ),
    };
    let availability = if AVAILABILITY_VALUES.contains(&availability.as_str()) {
        availability
    } else {
        "unknown".to_string()
    };
    let now = now_iso();
    conn.execute(
        "UPDATE capability_resource_links SET availability = ?2, last_checked_at = ?3 WHERE id = ?1",
        params![link_id, availability, now],
    )?;
    let mut updated = read_link(conn, &link_id)?
        .ok_or_else(|| AppError::NotFound("资源关联校验后不可读".into()))?;
    updated.detail = detail;
    Ok(updated)
}

// ── 对外服务入口 ──────────────────────────────────────────────────────

pub fn candidates(
    db: &Db,
    project_id: &str,
    kind: Option<&str>,
    query: Option<&str>,
) -> AppResult<Vec<ResourceCandidate>> {
    db.with_read(|conn| list_candidates(conn, project_id, kind, query))
}

pub fn links(db: &Db, project_id: &str) -> AppResult<Vec<CapabilityResourceLink>> {
    db.with_read(|conn| list_links(conn, project_id))
}

pub fn link(db: &Db, project_id: &str, input: ResourceLinkInput) -> AppResult<CapabilityResourceLink> {
    db.with_transaction(|conn| link_resource(conn, project_id, &input))
}

pub fn unlink(db: &Db, project_id: &str, link_id: &str) -> AppResult<()> {
    db.with_transaction(|conn| unlink_resource(conn, project_id, link_id))
}

pub fn validate(db: &Db, project_id: &str, link_id: &str) -> AppResult<CapabilityResourceLink> {
    db.with_transaction(|conn| validate_resource(conn, project_id, link_id))
}
