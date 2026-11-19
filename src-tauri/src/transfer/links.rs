//! 通用实体关联。
//!
//! 只用于**没有归属表**的实体对；以下关系必须复用既有表，不得在此重复：
//! - 知识 ↔ 任务/项目/笔记/会话：`knowledge_links`；
//! - 暂存架 ↔ 任务/项目：`shelf_task_links` / `shelf_project_links`；
//! - 项目 ↔ 任务：`workspace_task_links`。
//!
//! 关系语义（不可混用）：
//! - `reference`：引用（被引用对象独立存在，删除不影响本体）；
//! - `attachment`：附件（语意为「属于」但仍是引用，不复制内容）；
//! - `parent`：父子（有方向，禁止成环）；
//! - `derived`：派生（由 A 产生 B，如规划生成任务）。

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::store;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityLink {
    pub id: String,
    pub source_type: String,
    pub source_id: String,
    pub target_type: String,
    pub target_id: String,
    pub relation: String,
    pub label: String,
    pub metadata: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInput {
    pub source_type: String,
    pub source_id: String,
    pub target_type: String,
    pub target_id: String,
    #[serde(default = "default_relation")]
    pub relation: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

fn default_relation() -> String {
    "reference".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedEntity {
    pub link_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub relation: String,
    pub label: String,
    /// 指向方向：`out` = 本实体 → 对方；`in` = 对方 → 本实体。
    pub direction: String,
    pub created_at: String,
    /// 对方实体是否仍存在（false = 失效引用，不自动删除）。
    pub exists: bool,
}

fn validate_type(value: &str, field: &str) -> AppResult<()> {
    if !super::is_allowed(super::ENTITY_TYPES, value) {
        return Err(AppError::Validation(format!(
            "未知实体类型 {field}: {value}"
        )));
    }
    Ok(())
}

fn read_link(row: &rusqlite::Row<'_>) -> rusqlite::Result<EntityLink> {
    let meta: String = row.get(7)?;
    Ok(EntityLink {
        id: row.get(0)?,
        source_type: row.get(1)?,
        source_id: row.get(2)?,
        target_type: row.get(3)?,
        target_id: row.get(4)?,
        relation: row.get(5)?,
        label: row.get(6)?,
        metadata: serde_json::from_str(&meta).unwrap_or_else(|_| json!({})),
        created_at: row.get(8)?,
    })
}

const LINK_COLUMNS: &str = "id, source_type, source_id, target_type, target_id, relation, label, metadata_json, created_at";

/// 校验关联：类型、存在性、关系方向。
pub fn validate(
    db: &Db,
    source_type: &str,
    source_id: &str,
    target_type: &str,
    target_id: &str,
    relation: &str,
) -> AppResult<()> {
    validate_type(source_type, "source")?;
    validate_type(target_type, "target")?;
    if !super::is_allowed(super::RELATIONS, relation) {
        return Err(AppError::Validation(format!("未知关系类型: {relation}")));
    }
    if source_id.trim().is_empty() || target_id.trim().is_empty() {
        return Err(AppError::Validation("关联两端不能为空".into()));
    }
    if source_type == target_type && source_id == target_id {
        return Err(AppError::Validation("不能关联到自己".into()));
    }
    db.with_conn(|conn| {
        if !store::entity_exists(conn, source_type, source_id)? {
            return Err(AppError::NotFound("来源实体不存在".into()));
        }
        if !store::entity_exists(conn, target_type, target_id)? {
            return Err(AppError::NotFound("目标实体不存在".into()));
        }
        if relation == "parent" {
            // 防环：目标不能已经是来源的祖先。
            let ancestors = ancestors_of(conn, source_type, source_id)?;
            if ancestors
                .iter()
                .any(|(t, id)| t == target_type && id == target_id)
            {
                return Err(AppError::Conflict("父子关系会形成环".into()));
            }
        }
        Ok(())
    })
}

fn ancestors_of(
    conn: &rusqlite::Connection,
    entity_type: &str,
    entity_id: &str,
) -> AppResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut frontier = vec![(entity_type.to_string(), entity_id.to_string())];
    for _ in 0..32 {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for (t, id) in frontier {
            let mut stmt = conn.prepare(
                "SELECT source_type, source_id FROM entity_links
                 WHERE target_type = ?1 AND target_id = ?2 AND relation = 'parent'",
            )?;
            let rows = stmt.query_map(params![t, id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let pair = row?;
                if !out.contains(&pair) {
                    next.push(pair.clone());
                    out.push(pair);
                }
            }
        }
        frontier = next;
    }
    Ok(out)
}

pub fn create_link(db: &Db, input: &LinkInput) -> AppResult<EntityLink> {
    validate(
        db,
        &input.source_type,
        &input.source_id,
        &input.target_type,
        &input.target_id,
        &input.relation,
    )?;
    db.with_conn(|conn| {
        if let Some(existing) = find_existing(
            conn,
            &input.source_type,
            &input.source_id,
            &input.target_type,
            &input.target_id,
            &input.relation,
        )? {
            return Ok(existing);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        let meta_value = if input.metadata.is_null() {
            json!({})
        } else {
            input.metadata.clone()
        };
        let meta = serde_json::to_string(&meta_value).unwrap_or_else(|_| "{}".into());
        conn.execute(
            "INSERT INTO entity_links (
                id, source_type, source_id, target_type, target_id, relation, label,
                metadata_json, created_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                id,
                input.source_type,
                input.source_id,
                input.target_type,
                input.target_id,
                input.relation,
                input.label.trim(),
                meta,
                now,
            ],
        )?;
        let sql = format!("SELECT {LINK_COLUMNS} FROM entity_links WHERE id = ?1");
        conn.query_row(&sql, params![id], read_link)
            .map_err(AppError::from)
    })
}

fn find_existing(
    conn: &rusqlite::Connection,
    source_type: &str,
    source_id: &str,
    target_type: &str,
    target_id: &str,
    relation: &str,
) -> AppResult<Option<EntityLink>> {
    conn.query_row(
        &format!(
            "SELECT {LINK_COLUMNS} FROM entity_links
             WHERE source_type = ?1 AND source_id = ?2 AND target_type = ?3
             AND target_id = ?4 AND relation = ?5 LIMIT 1"
        ),
        params![source_type, source_id, target_type, target_id, relation],
        read_link,
    )
    .optional()
    .map_err(AppError::from)
}

/// 批量关联：返回成功创建的条数与失败明细（部分成功）。
pub fn batch_create(
    db: &Db,
    inputs: Vec<LinkInput>,
) -> AppResult<(Vec<EntityLink>, Vec<(String, String)>)> {
    let mut created = Vec::new();
    let mut failed = Vec::new();
    for input in inputs {
        match create_link(db, &input) {
            Ok(link) => created.push(link),
            Err(e) => failed.push((format!("{}:{}", input.target_type, input.target_id), e.to_string())),
        }
    }
    Ok((created, failed))
}

pub fn remove_link(db: &Db, id: &str) -> AppResult<bool> {
    db.with_conn(|conn| Ok(conn.execute("DELETE FROM entity_links WHERE id = ?1", params![id])? > 0))
}

/// 按两端删除（幂等）。
pub fn unlink(
    db: &Db,
    source_type: &str,
    source_id: &str,
    target_type: &str,
    target_id: &str,
    relation: Option<&str>,
) -> AppResult<usize> {
    db.with_conn(|conn| {
        let removed = match relation {
            Some(rel) => conn.execute(
                "DELETE FROM entity_links WHERE source_type = ?1 AND source_id = ?2
                 AND target_type = ?3 AND target_id = ?4 AND relation = ?5",
                params![source_type, source_id, target_type, target_id, rel],
            )?,
            None => conn.execute(
                "DELETE FROM entity_links WHERE source_type = ?1 AND source_id = ?2
                 AND target_type = ?3 AND target_id = ?4",
                params![source_type, source_id, target_type, target_id],
            )?,
        };
        Ok(removed)
    })
}

/// 某实体的全部关联（双向）。
pub fn related(db: &Db, entity_type: &str, entity_id: &str) -> AppResult<Vec<RelatedEntity>> {
    validate_type(entity_type, "entity")?;
    db.with_conn(|conn| {
        let mut out = Vec::new();
        let mut stmt = conn.prepare(&format!(
            "SELECT {LINK_COLUMNS} FROM entity_links
             WHERE (source_type = ?1 AND source_id = ?2)
                OR (target_type = ?1 AND target_id = ?2)
             ORDER BY created_at ASC"
        ))?;
        let rows = stmt.query_map(params![entity_type, entity_id], read_link)?;
        for row in rows {
            let link = row?;
            let (other_type, other_id, direction) =
                if link.source_type == entity_type && link.source_id == entity_id {
                    (link.target_type.clone(), link.target_id.clone(), "out")
                } else {
                    (link.source_type.clone(), link.source_id.clone(), "in")
                };
            let exists = store::entity_exists(conn, &other_type, &other_id)?;
            out.push(RelatedEntity {
                link_id: link.id,
                entity_type: other_type,
                entity_id: other_id,
                relation: link.relation,
                label: link.label,
                direction: direction.into(),
                created_at: link.created_at,
                exists,
            });
        }
        Ok(out)
    })
}

/// 删除实体时清理其关联（仅在确认实体已删除后调用）。
pub fn purge_entity(db: &Db, entity_type: &str, entity_id: &str) -> AppResult<usize> {
    validate_type(entity_type, "entity")?;
    db.with_conn(|conn| {
        let removed = conn.execute(
            "DELETE FROM entity_links
             WHERE (source_type = ?1 AND source_id = ?2)
                OR (target_type = ?1 AND target_id = ?2)",
            params![entity_type, entity_id],
        )?;
        Ok(removed)
    })
}
