//! 项目资源服务：能力 ↔ 资源的真实关联。
//!
//! 设计边界（`docs/project-hub/02-架构设计.md` §4）：
//! - **能力是「能不能做」，资源是「有没有可调用的东西」**：能力库是 `project_capabilities`，
//!   资源是知识库 / Skill / MCP / Agent / 工具 / 模板 / 工作流，两者用
//!   `capability_resource_links` 关联，不得合并成一张表。
//! - 关联只写引用：不解绑不删除资源本体，也不复制资源内容。
//! - 作用域校验：项目私有的资源（知识库 `project_id`、Skill `scope=project`）只允许本项目绑定；
//!   全局资源对所有项目可见。
//! - 可用性是**探测结果**，不是推断：`available / partial / unavailable / unknown` 必须来自
//!   真实记录（存在性、启用状态、缺失标记、连接状态），无法判定时给 `unknown`，
//!   不得用「有链接就算可用」冒充。

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
    /// `global` / `project`：资源作用域。
    pub scope: String,
    pub availability: String,
    pub detail: String,
}

/// 能力 ↔ 资源关联行。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResourceLink {
    pub id: String,
    pub capability_id: String,
    pub capability_name: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub label: String,
    pub availability: String,
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

/// 资源候选清单：只列出**当前项目可见**的真实资源。
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
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, project_id FROM knowledge_bases
             WHERE project_id IS NULL OR project_id = ?1
             ORDER BY updated_at DESC",
        )?;
        let mapped = stmt.query_map(params![project_id], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let kind: String = r.get(2)?;
            let owner: Option<String> = r.get(3)?;
            Ok(ResourceCandidate {
                kind: "knowledge".into(),
                id,
                label: name,
                scope: if owner.is_some() { "project".into() } else { "global".into() },
                availability: "available".into(),
                detail: format!("知识库（{kind}）"),
            })
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    if wants("skill") && table_exists(conn, "capability_skills")? {
        let mut stmt = conn.prepare(
            "SELECT id, name, scope, project_id, enabled, missing, format_ok
             FROM capability_skills
             WHERE scope = 'global' OR project_id IS NULL OR project_id = ?1
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
            let (availability, detail) = if missing != 0 {
                ("unavailable".to_string(), "Skill 来源已不存在".to_string())
            } else if enabled == 0 {
                ("unavailable".to_string(), "Skill 已禁用".to_string())
            } else if format_ok == 0 {
                ("partial".to_string(), "Skill 格式校验未通过".to_string())
            } else {
                ("available".to_string(), "Skill 可用".to_string())
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
                (_, "ok") => ("available".to_string(), "MCP Server 已连接".to_string()),
                (_, "failed") => (
                    "unavailable".to_string(),
                    if last_error.trim().is_empty() {
                        "MCP Server 连接失败".to_string()
                    } else {
                        format!("MCP Server 连接失败：{}", last_error.trim())
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
            Ok(ResourceCandidate {
                kind: "agent".into(),
                id,
                label,
                scope: "global".into(),
                availability: if enabled != 0 {
                    "partial".into()
                } else {
                    "unavailable".into()
                },
                detail: format!("Agent 共享工作空间：{root}"),
            })
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    if let Some(needle) = needle {
        rows.retain(|row| {
            row.label.to_lowercase().contains(&needle)
                || row.id.to_lowercase().contains(&needle)
                || row.detail.to_lowercase().contains(&needle)
        });
    }
    Ok(rows)
}

/// 项目已关联的资源清单（按能力聚合）。
pub fn list_links(conn: &Connection, project_id: &str) -> AppResult<Vec<CapabilityResourceLink>> {
    let mut stmt = conn.prepare(
        "SELECT l.id, l.capability_id, c.name, l.resource_kind, l.resource_id, l.label,
                l.availability, l.last_checked_at, l.created_at
         FROM capability_resource_links l
         JOIN project_capabilities c ON c.id = l.capability_id
         JOIN project_capability_requirements r ON r.capability_id = l.capability_id
         WHERE r.project_id = ?1
         GROUP BY l.id
         ORDER BY c.name, l.resource_kind, l.label",
    )?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(CapabilityResourceLink {
            id: r.get(0)?,
            capability_id: r.get(1)?,
            capability_name: r.get(2)?,
            resource_kind: r.get(3)?,
            resource_id: r.get(4)?,
            label: r.get(5)?,
            availability: r.get(6)?,
            last_checked_at: r.get(7)?,
            created_at: r.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
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

/// 绑定资源到能力（幂等）：重复绑定返回既有关联，不复制资源本体。
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

    let now = now_iso();
    let link_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO capability_resource_links
         (id, capability_id, resource_kind, resource_id, label, availability, last_checked_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(capability_id, resource_kind, resource_id) DO UPDATE SET
           label = excluded.label,
           availability = excluded.availability,
           last_checked_at = excluded.last_checked_at",
        params![
            link_id,
            capability_id,
            kind,
            resource_id,
            candidate.label,
            candidate.availability,
            now,
            now
        ],
    )?;

    conn.query_row(
        "SELECT id, capability_id, resource_kind, resource_id, label, availability, last_checked_at, created_at
         FROM capability_resource_links
         WHERE capability_id = ?1 AND resource_kind = ?2 AND resource_id = ?3",
        params![capability_id, kind, resource_id],
        |r| {
            Ok(CapabilityResourceLink {
                id: r.get(0)?,
                capability_id: r.get(1)?,
                capability_name: String::new(),
                resource_kind: r.get(2)?,
                resource_id: r.get(3)?,
                label: r.get(4)?,
                availability: r.get(5)?,
                last_checked_at: r.get(6)?,
                created_at: r.get(7)?,
            })
        },
    )
    .map_err(AppError::from)
}

/// 解除关联：只删关联行，不删资源本体。
pub fn unlink_resource(
    conn: &Connection,
    project_id: &str,
    link_id: &str,
) -> AppResult<()> {
    let link_id = clean_id(link_id, "关联 ID")?;
    let capability_id: Option<String> = conn
        .query_row(
            "SELECT l.capability_id FROM capability_resource_links l
             JOIN project_capability_requirements r ON r.capability_id = l.capability_id
             WHERE l.id = ?1 AND r.project_id = ?2
             LIMIT 1",
            params![link_id, project_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(capability_id) = capability_id else {
        return Err(AppError::NotFound("资源关联不存在或不属于当前项目".into()));
    };
    conn.execute(
        "DELETE FROM capability_resource_links WHERE id = ?1 AND capability_id = ?2",
        params![link_id, capability_id],
    )?;
    Ok(())
}

/// 重新校验资源可用性：写入真实探测结果与校验时间。
pub fn validate_resource(
    conn: &Connection,
    project_id: &str,
    link_id: &str,
) -> AppResult<CapabilityResourceLink> {
    let link_id = clean_id(link_id, "关联 ID")?;
    let (capability_id, kind, resource_id): (String, String, String) = conn
        .query_row(
            "SELECT l.capability_id, l.resource_kind, l.resource_id
             FROM capability_resource_links l
             JOIN project_capability_requirements r ON r.capability_id = l.capability_id
             WHERE l.id = ?1 AND r.project_id = ?2
             LIMIT 1",
            params![link_id, project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("资源关联不存在或不属于当前项目".into()))?;

    let availability = match list_candidates(conn, project_id, Some(&kind), None)? {
        candidates => candidates
            .into_iter()
            .find(|item| item.id == resource_id)
            .map(|item| item.availability)
            .unwrap_or_else(|| "unavailable".to_string()),
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
    conn.query_row(
        "SELECT id, capability_id, resource_kind, resource_id, label, availability, last_checked_at, created_at
         FROM capability_resource_links WHERE id = ?1",
        params![link_id],
        |r| {
            Ok(CapabilityResourceLink {
                id: r.get(0)?,
                capability_id: r.get(1)?,
                capability_name: String::new(),
                resource_kind: r.get(2)?,
                resource_id: r.get(3)?,
                label: r.get(4)?,
                availability: r.get(5)?,
                last_checked_at: r.get(6)?,
                created_at: r.get(7)?,
            })
        },
    )
    .map_err(AppError::from)
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
