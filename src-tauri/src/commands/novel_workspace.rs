//! 小说工作空间专业后端（B2，2026-11-16）：人物档案 / 人物关系 / 世界观设定 / 章节引用。
//!
//! ## 归属
//! 本文件由**小说线**独占编写；`commands/mod.rs` 的声明、`db/mod.rs` 的迁移登记、
//! `lib.rs` 的命令注册、`backup.rs` 的备份登记全部由集成负责人完成，本文件不得修改它们。
//!
//! ## 约定
//! - 迁移 DDL 写在本文件的 `MIGRATION_59` 常量里，已由集成负责人在 MIGRATIONS 末尾引用；
//!   修改 SQL 等于修改 v59 迁移，**只能在集成完成前**进行。
//! - 命令命名前缀 `novel_`，形参见 `project_workspace.rs`（`*_impl(db, ...)` + 薄 `#[tauri::command]`）。
//! - 所有写入必须经 `ensure_novel_project` 等价门禁：`kind = novel` 且 `status = active`；
//!   读取允许归档项目（归档 = 只读）。
//! - 本文件不得删除或改写既有卷/章表结构（v58 已发布，不可改）。

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// v59（小说 B2）：人物档案 / 人物关系 / 世界观设定 / 章节引用。
///
/// 四张表均带 `project_id` 级联外键；`novel_entity_refs.entity_id` 为多态引用
/// （character / worldview），由命令层校验归属，删除主实体时在事务内显式清理引用行。
pub const MIGRATION_59: (i64, &'static str) = (
    59,
    r#"
-- 人物档案：姓名 / 别名 / 简介 / 外貌性格 / 背景经历 / 目标动机 / 阵营身份组织 /
-- 人物状态 / 备注 / 自定义标签；标签以 JSON 数组文本存储，类型与名称列可查询筛选。
CREATE TABLE novel_characters (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  motivation TEXT NOT NULL DEFAULT '',
  faction TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_novel_characters_project
  ON novel_characters(project_id, sort_order, created_at);
CREATE INDEX idx_novel_characters_name
  ON novel_characters(project_id, name);

-- 人物关系：有向记录（A → B），双向可查由读侧同时匹配 from/to；
-- 同一项目内同一对人物 + 同一关系类型只保留一条。
CREATE TABLE novel_character_relations (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  from_character_id TEXT NOT NULL REFERENCES novel_characters(id) ON DELETE CASCADE,
  to_character_id TEXT NOT NULL REFERENCES novel_characters(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (from_character_id <> to_character_id)
);
CREATE INDEX idx_novel_rel_from
  ON novel_character_relations(project_id, from_character_id);
CREATE INDEX idx_novel_rel_to
  ON novel_character_relations(project_id, to_character_id);
CREATE UNIQUE INDEX uq_novel_rel_pair
  ON novel_character_relations(project_id, from_character_id, to_character_id, relation_type);

-- 世界观设定：地点 / 国家组织势力 / 历史事件 / 物品道具 / 能力规则体系 / 自定义；
-- 类型、名称、标签列独立建列，禁止把全部设定塞进一个不可检索的大 JSON。
CREATE TABLE novel_worldview_entries (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_novel_worldview_project
  ON novel_worldview_entries(project_id, kind, sort_order, created_at);
CREATE INDEX idx_novel_worldview_name
  ON novel_worldview_entries(project_id, name);

-- 章节引用：人物 / 设定 关联到真实 novel_chapters；解绑只删引用行，
-- 不删除人物、设定或章节。entity_id 多态，归属由命令层校验。
CREATE TABLE novel_entity_refs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('character', 'worldview')),
  entity_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (project_id, entity_type, entity_id, chapter_id)
);
CREATE INDEX idx_novel_refs_entity
  ON novel_entity_refs(project_id, entity_type, entity_id);
CREATE INDEX idx_novel_refs_chapter
  ON novel_entity_refs(chapter_id);
"#,
);

// ── 枚举白名单与长度上限 ─────────────────────────────────────────────

/// 人物状态（与前端下拉一致；未知值拒绝而非静默改写）。
pub const CHARACTER_STATUSES: &[&str] = &["unknown", "active", "missing", "dead"];
/// 关系类型。
pub const RELATION_TYPES: &[&str] = &[
    "family",
    "friend",
    "enemy",
    "mentor",
    "lover",
    "colleague",
    "other",
];
/// 世界观设定类型。
pub const WORLDVIEW_KINDS: &[&str] = &[
    "location",
    "faction",
    "event",
    "item",
    "ability",
    "custom",
];
/// 引用实体类型。
pub const ENTITY_TYPES: &[&str] = &["character", "worldview"];

const MAX_NAME_CHARS: usize = 120;
const MAX_ALIASES_CHARS: usize = 500;
const MAX_LONG_TEXT_CHARS: usize = 4000;
const MAX_RELATION_DESC_CHARS: usize = 1000;
const MAX_REF_NOTE_CHARS: usize = 500;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 40;
/// 列表限量：禁止把整本书的人物/设定全量读进内存。
const LIST_LIMIT: i64 = 200;

// ── 返回模型 ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelCharacter {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub aliases: String,
    pub intro: String,
    pub appearance: String,
    pub background: String,
    pub motivation: String,
    pub faction: String,
    pub status: String,
    pub notes: String,
    pub tags: Vec<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelCharacterRelation {
    pub id: String,
    pub project_id: String,
    pub from_character_id: String,
    pub to_character_id: String,
    pub relation_type: String,
    pub description: String,
    pub from_name: String,
    pub to_name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelWorldviewEntry {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelEntityRef {
    pub id: String,
    pub project_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub entity_name: String,
    pub chapter_id: String,
    pub chapter_title: String,
    pub note: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelCharactersList {
    pub characters: Vec<NovelCharacter>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelCharacterGot {
    pub character: NovelCharacter,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelCharacterSaved {
    pub character: NovelCharacter,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelRelationsList {
    pub relations: Vec<NovelCharacterRelation>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelRelationSaved {
    pub relation: NovelCharacterRelation,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelWorldviewList {
    pub entries: Vec<NovelWorldviewEntry>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelWorldviewGot {
    pub entry: NovelWorldviewEntry,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelWorldviewSaved {
    pub entry: NovelWorldviewEntry,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelRefsList {
    pub refs: Vec<NovelEntityRef>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelRefSaved {
    pub reference: NovelEntityRef,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelOk {
    pub ok: bool,
}

// ── 门禁与校验 ──────────────────────────────────────────────────────

/// 小说专业命令统一类型/状态门禁（与 `project_workspace.rs::ensure_novel_project` 同语义，
/// 按契约在本文件内本地复制，不依赖他模块私有函数）：
/// - 只有 `kind = novel` 的项目可读写人物/世界观/引用；
/// - `require_active` 为 true 时（所有写入）还要求 `status = active`；
///   读取允许归档项目，保证归档后数据仍可查看。
fn ensure_novel_project(conn: &Connection, project_id: &str, require_active: bool) -> AppResult<()> {
    let (kind, status): (String, String) = conn
        .query_row(
            "SELECT kind, status FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("工作空间项目不存在".to_string()))?;
    if kind != "novel" {
        return Err(AppError::Validation(
            "该操作仅对小说项目开放".to_string(),
        ));
    }
    if require_active && status != "active" {
        return Err(AppError::Validation(
            "项目已归档，人物与世界观只读；恢复为进行中后才能修改".to_string(),
        ));
    }
    Ok(())
}

fn validate_text(
    value: &str,
    field: &str,
    max_chars: usize,
    allow_empty: bool,
) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() && !allow_empty {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if value.chars().count() > max_chars {
        return Err(AppError::Validation(format!(
            "{field}超过 {max_chars} 字符"
        )));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(format!("{field}含非法控制字符")));
    }
    Ok(value.to_string())
}

fn validate_enum(value: &str, field: &str, whitelist: &[&str]) -> AppResult<String> {
    let value = value.trim();
    if !whitelist.contains(&value) {
        return Err(AppError::Validation(format!("{field}取值非法")));
    }
    Ok(value.to_string())
}

/// 校验并归一化标签：去空白、去重、限数量与长度；存储为 JSON 数组文本。
fn normalize_tags(tags: Vec<String>) -> AppResult<String> {
    let mut seen: Vec<String> = Vec::new();
    for raw in tags {
        let tag = raw.trim().to_string();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > MAX_TAG_CHARS {
            return Err(AppError::Validation(format!(
                "单个标签超过 {MAX_TAG_CHARS} 字符"
            )));
        }
        if tag.chars().any(|c| c.is_control()) {
            return Err(AppError::Validation("标签含非法控制字符".into()));
        }
        if !seen.contains(&tag) {
            seen.push(tag);
        }
    }
    if seen.len() > MAX_TAGS {
        return Err(AppError::Validation(format!(
            "标签最多 {MAX_TAGS} 个"
        )));
    }
    Ok(serde_json::to_string(&seen)?)
}

fn parse_tags(stored: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(stored)
        .unwrap_or_default()
        .into_iter()
        .filter(|t| !t.is_empty())
        .collect()
}

fn owner_of_character(conn: &Connection, id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT project_id FROM novel_characters WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("人物不存在或已被删除".into()))
}

fn owner_of_worldview(conn: &Connection, id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT project_id FROM novel_worldview_entries WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("设定不存在或已被删除".into()))
}

fn owner_of_chapter(conn: &Connection, id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT project_id FROM novel_chapters WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("章节不存在或已被删除".into()))
}

fn next_sort_order(conn: &Connection, table: &str, project_id: &str) -> AppResult<i64> {
    // 表名由本文件内部固定传入，不接受外部拼接。
    let max: i64 = conn.query_row(
        &format!("SELECT COALESCE(MAX(sort_order), -1) FROM {table} WHERE project_id = ?1"),
        params![project_id],
        |row| row.get(0),
    )?;
    Ok(max.saturating_add(1))
}

// ── 人物档案 ─────────────────────────────────────────────────────────

fn row_to_character(row: &rusqlite::Row) -> rusqlite::Result<NovelCharacter> {
    let tags: String = row.get("tags")?;
    Ok(NovelCharacter {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        aliases: row.get("aliases")?,
        intro: row.get("intro")?,
        appearance: row.get("appearance")?,
        background: row.get("background")?,
        motivation: row.get("motivation")?,
        faction: row.get("faction")?,
        status: row.get("status")?,
        notes: row.get("notes")?,
        tags: parse_tags(&tags),
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const CHARACTER_SELECT: &str = "
    SELECT id, project_id, name, aliases, intro, appearance, background, motivation,
           faction, status, notes, tags, sort_order, created_at, updated_at
    FROM novel_characters";

fn like_pattern(raw: &str) -> String {
    let escaped = raw
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub fn novel_character_list_impl(
    db: &Db,
    project_id: &str,
    query: Option<&str>,
) -> AppResult<Vec<NovelCharacter>> {
    db.with_read(|conn| {
        ensure_novel_project(conn, project_id, false)?;
        let keyword = query.map(|q| q.trim().to_string()).filter(|q| !q.is_empty());
        let mut sql = format!(
            "{CHARACTER_SELECT} WHERE project_id = ?1
             ORDER BY sort_order, created_at, id
             LIMIT {LIST_LIMIT}"
        );
        let mut values: Vec<String> = vec![project_id.to_string()];
        if let Some(keyword) = &keyword {
            values.push(like_pattern(keyword));
            sql = format!(
                "{CHARACTER_SELECT} WHERE project_id = ?1
                 AND (name LIKE ?2 ESCAPE '\\' OR aliases LIKE ?2 ESCAPE '\\'
                      OR tags LIKE ?2 ESCAPE '\\')
                 ORDER BY sort_order, created_at, id
                 LIMIT {LIST_LIMIT}"
            );
        }
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values), row_to_character)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn novel_character_get_impl(db: &Db, id: &str) -> AppResult<NovelCharacter> {
    db.with_read(|conn| {
        let project_id = owner_of_character(conn, id)?;
        ensure_novel_project(conn, &project_id, false)?;
        conn.query_row(
            &format!("{CHARACTER_SELECT} WHERE id = ?1"),
            params![id],
            row_to_character,
        )
        .map_err(AppError::from)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn novel_character_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    name: String,
    aliases: String,
    intro: String,
    appearance: String,
    background: String,
    motivation: String,
    faction: String,
    status: String,
    notes: String,
    tags: Vec<String>,
    sort_order: Option<i64>,
) -> AppResult<NovelCharacter> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let name = validate_text(&name, "人物姓名", MAX_NAME_CHARS, false)?;
    let aliases = validate_text(&aliases, "别名", MAX_ALIASES_CHARS, true)?;
    let intro = validate_text(&intro, "简介", MAX_LONG_TEXT_CHARS, true)?;
    let appearance = validate_text(&appearance, "外貌与性格", MAX_LONG_TEXT_CHARS, true)?;
    let background = validate_text(&background, "背景经历", MAX_LONG_TEXT_CHARS, true)?;
    let motivation = validate_text(&motivation, "目标与动机", MAX_LONG_TEXT_CHARS, true)?;
    let faction = validate_text(&faction, "阵营/身份/组织", MAX_LONG_TEXT_CHARS, true)?;
    let notes = validate_text(&notes, "备注", MAX_LONG_TEXT_CHARS, true)?;
    let status = validate_enum(&status, "人物状态", CHARACTER_STATUSES)?;
    let tags_json = normalize_tags(tags)?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_transaction(|conn| {
        ensure_novel_project(conn, &project_id, true)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => value,
                    None => next_sort_order(conn, "novel_characters", &project_id)?,
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO novel_characters
                     (id, project_id, name, aliases, intro, appearance, background, motivation,
                      faction, status, notes, tags, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
                    params![
                        id, project_id, name, aliases, intro, appearance, background, motivation,
                        faction, status, notes, tags_json, order, now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM novel_characters WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(owner) = existing else {
                    return Err(AppError::NotFound("人物不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("人物不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => value,
                    None => conn.query_row(
                        "SELECT sort_order FROM novel_characters WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )?,
                };
                conn.execute(
                    "UPDATE novel_characters
                     SET name = ?2, aliases = ?3, intro = ?4, appearance = ?5, background = ?6,
                         motivation = ?7, faction = ?8, status = ?9, notes = ?10, tags = ?11,
                         sort_order = ?12, updated_at = ?13
                     WHERE id = ?1 AND project_id = ?14",
                    params![
                        id, name, aliases, intro, appearance, background, motivation, faction,
                        status, notes, tags_json, order, now, project_id
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;

    db.with_read(|conn| {
        conn.query_row(
            &format!("{CHARACTER_SELECT} WHERE id = ?1"),
            params![saved_id],
            row_to_character,
        )
        .map_err(AppError::from)
    })
}

pub fn novel_character_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_transaction(|conn| {
        let project_id = owner_of_character(conn, id)?;
        ensure_novel_project(conn, &project_id, true)?;
        // 关系与引用在事务内显式清理；章节与其他人物不受影响。
        conn.execute(
            "DELETE FROM novel_character_relations
             WHERE from_character_id = ?1 OR to_character_id = ?1",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM novel_entity_refs
             WHERE entity_type = 'character' AND entity_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM novel_characters WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── 人物关系 ─────────────────────────────────────────────────────────

fn row_to_relation(
    conn: &Connection,
    row: &rusqlite::Row,
) -> rusqlite::Result<NovelCharacterRelation> {
    let from_id: String = row.get("from_character_id")?;
    let to_id: String = row.get("to_character_id")?;
    let from_name: String = conn
        .query_row(
            "SELECT name FROM novel_characters WHERE id = ?1",
            params![from_id],
            |r| r.get(0),
        )
        .unwrap_or_default();
    let to_name: String = conn
        .query_row(
            "SELECT name FROM novel_characters WHERE id = ?1",
            params![to_id],
            |r| r.get(0),
        )
        .unwrap_or_default();
    Ok(NovelCharacterRelation {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        from_character_id: from_id,
        to_character_id: to_id,
        relation_type: row.get("relation_type")?,
        description: row.get("description")?,
        from_name,
        to_name,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn novel_character_relation_list_impl(
    db: &Db,
    project_id: &str,
    character_id: Option<&str>,
) -> AppResult<Vec<NovelCharacterRelation>> {
    db.with_read(|conn| {
        ensure_novel_project(conn, project_id, false)?;
        let mut sql = String::from(
            "SELECT id, project_id, from_character_id, to_character_id, relation_type, description,
                    created_at, updated_at
             FROM novel_character_relations WHERE project_id = ?1",
        );
        if character_id.is_some() {
            sql.push_str(" AND (from_character_id = ?2 OR to_character_id = ?2)");
        }
        sql.push_str(" ORDER BY created_at, id");
        let mut stmt = conn.prepare(&sql)?;
        let map_row = |row: &rusqlite::Row| row_to_relation(conn, row);
        let rows = match character_id {
            Some(cid) => stmt.query_map(params![project_id, cid], map_row)?,
            None => stmt.query_map(params![project_id], map_row)?,
        };
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn novel_character_relation_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    from_character_id: String,
    to_character_id: String,
    relation_type: String,
    description: String,
) -> AppResult<NovelCharacterRelation> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let from_character_id = from_character_id.trim().to_string();
    let to_character_id = to_character_id.trim().to_string();
    if from_character_id.is_empty() || to_character_id.is_empty() {
        return Err(AppError::Validation("关系两端人物不能为空".into()));
    }
    if from_character_id == to_character_id {
        return Err(AppError::Validation("人物不能与自己建立关系".into()));
    }
    let relation_type = validate_enum(&relation_type, "关系类型", RELATION_TYPES)?;
    let description = validate_text(&description, "关系描述", MAX_RELATION_DESC_CHARS, true)?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_transaction(|conn| {
        ensure_novel_project(conn, &project_id, true)?;
        let from_owner = owner_of_character(conn, &from_character_id)?;
        let to_owner = owner_of_character(conn, &to_character_id)?;
        if from_owner != project_id || to_owner != project_id {
            return Err(AppError::Validation("关系人物不属于当前项目".into()));
        }
        let now = now_iso();
        match id {
            None => {
                let exists: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM novel_character_relations
                         WHERE project_id = ?1 AND from_character_id = ?2
                           AND to_character_id = ?3 AND relation_type = ?4",
                        params![project_id, from_character_id, to_character_id, relation_type],
                        |r| r.get(0),
                    )
                    .optional()?;
                if exists.is_some() {
                    return Err(AppError::Conflict("该人物关系已存在".into()));
                }
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO novel_character_relations
                     (id, project_id, from_character_id, to_character_id, relation_type,
                      description, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![
                        id, project_id, from_character_id, to_character_id, relation_type,
                        description, now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM novel_character_relations WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(owner) = existing else {
                    return Err(AppError::NotFound("关系不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("关系不属于当前项目".into()));
                }
                // 改挂人物时复核两端归属。
                let from_owner = owner_of_character(conn, &from_character_id)?;
                let to_owner = owner_of_character(conn, &to_character_id)?;
                if from_owner != project_id || to_owner != project_id {
                    return Err(AppError::Validation("关系人物不属于当前项目".into()));
                }
                conn.execute(
                    "UPDATE novel_character_relations
                     SET from_character_id = ?2, to_character_id = ?3, relation_type = ?4,
                         description = ?5, updated_at = ?6
                     WHERE id = ?1 AND project_id = ?7",
                    params![
                        id, from_character_id, to_character_id, relation_type, description,
                        now, project_id
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;

    db.with_read(|conn| {
        conn.query_row(
            "SELECT id, project_id, from_character_id, to_character_id, relation_type, description,
                    created_at, updated_at
             FROM novel_character_relations WHERE id = ?1",
            params![saved_id],
            |row| row_to_relation(conn, row),
        )
        .map_err(AppError::from)
    })
}

pub fn novel_character_relation_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_transaction(|conn| {
        let project_id: Option<String> = conn
            .query_row(
                "SELECT project_id FROM novel_character_relations WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(project_id) = project_id else {
            return Err(AppError::NotFound("关系不存在或已被删除".into()));
        };
        ensure_novel_project(conn, &project_id, true)?;
        // 解绑关系：不删除任何人物。
        conn.execute(
            "DELETE FROM novel_character_relations WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

// ── 世界观设定 ───────────────────────────────────────────────────────

fn row_to_worldview(row: &rusqlite::Row) -> rusqlite::Result<NovelWorldviewEntry> {
    let tags: String = row.get("tags")?;
    Ok(NovelWorldviewEntry {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        kind: row.get("kind")?,
        name: row.get("name")?,
        description: row.get("description")?,
        tags: parse_tags(&tags),
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const WORLDVIEW_SELECT: &str = "
    SELECT id, project_id, kind, name, description, tags, sort_order, created_at, updated_at
    FROM novel_worldview_entries";

pub fn novel_worldview_list_impl(
    db: &Db,
    project_id: &str,
    kind: Option<&str>,
    query: Option<&str>,
) -> AppResult<Vec<NovelWorldviewEntry>> {
    db.with_read(|conn| {
        ensure_novel_project(conn, project_id, false)?;
        let kind = match kind {
            Some(value) => Some(validate_enum(value, "设定类型", WORLDVIEW_KINDS)?),
            None => None,
        };
        let keyword = query.map(|q| q.trim().to_string()).filter(|q| !q.is_empty());
        let mut sql = format!(
            "{WORLDVIEW_SELECT} WHERE project_id = ?1
             ORDER BY sort_order, created_at, id LIMIT {LIST_LIMIT}"
        );
        let mut values: Vec<String> = vec![project_id.to_string()];
        if let Some(kind) = &kind {
            values.push(kind.clone());
            sql = format!(
                "{WORLDVIEW_SELECT} WHERE project_id = ?1 AND kind = ?2
                 ORDER BY sort_order, created_at, id LIMIT {LIST_LIMIT}"
            );
        }
        if let Some(keyword) = &keyword {
            values.push(like_pattern(keyword));
            let idx = values.len();
            sql = format!(
                "{WORLDVIEW_SELECT} WHERE project_id = ?1
                 {kind_clause} AND (name LIKE ?{idx} ESCAPE '\\' OR description LIKE ?{idx} ESCAPE '\\'
                      OR tags LIKE ?{idx} ESCAPE '\\')
                 ORDER BY sort_order, created_at, id LIMIT {LIST_LIMIT}",
                kind_clause = kind.is_some().then_some("AND kind = ?2").unwrap_or_default(),
                idx = idx
            );
        }
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values), row_to_worldview)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn novel_worldview_get_impl(db: &Db, id: &str) -> AppResult<NovelWorldviewEntry> {
    db.with_read(|conn| {
        let project_id = owner_of_worldview(conn, id)?;
        ensure_novel_project(conn, &project_id, false)?;
        conn.query_row(
            &format!("{WORLDVIEW_SELECT} WHERE id = ?1"),
            params![id],
            row_to_worldview,
        )
        .map_err(AppError::from)
    })
}

pub fn novel_worldview_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    kind: String,
    name: String,
    description: String,
    tags: Vec<String>,
    sort_order: Option<i64>,
) -> AppResult<NovelWorldviewEntry> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let kind = validate_enum(&kind, "设定类型", WORLDVIEW_KINDS)?;
    let name = validate_text(&name, "设定名称", MAX_NAME_CHARS, false)?;
    let description = validate_text(&description, "设定描述", MAX_LONG_TEXT_CHARS, true)?;
    let tags_json = normalize_tags(tags)?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_transaction(|conn| {
        ensure_novel_project(conn, &project_id, true)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => value,
                    None => next_sort_order(conn, "novel_worldview_entries", &project_id)?,
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO novel_worldview_entries
                     (id, project_id, kind, name, description, tags, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    params![id, project_id, kind, name, description, tags_json, order, now],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM novel_worldview_entries WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(owner) = existing else {
                    return Err(AppError::NotFound("设定不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("设定不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => value,
                    None => conn.query_row(
                        "SELECT sort_order FROM novel_worldview_entries WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )?,
                };
                conn.execute(
                    "UPDATE novel_worldview_entries
                     SET kind = ?2, name = ?3, description = ?4, tags = ?5, sort_order = ?6,
                         updated_at = ?7
                     WHERE id = ?1 AND project_id = ?8",
                    params![id, kind, name, description, tags_json, order, now, project_id],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;

    db.with_read(|conn| {
        conn.query_row(
            &format!("{WORLDVIEW_SELECT} WHERE id = ?1"),
            params![saved_id],
            row_to_worldview,
        )
        .map_err(AppError::from)
    })
}

pub fn novel_worldview_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_transaction(|conn| {
        let project_id = owner_of_worldview(conn, id)?;
        ensure_novel_project(conn, &project_id, true)?;
        // 引用行显式清理；章节与其他设定不受影响。
        conn.execute(
            "DELETE FROM novel_entity_refs
             WHERE entity_type = 'worldview' AND entity_id = ?1",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM novel_worldview_entries WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

// ── 章节引用 ─────────────────────────────────────────────────────────

fn row_to_ref(row: &rusqlite::Row) -> rusqlite::Result<NovelEntityRef> {
    Ok(NovelEntityRef {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        entity_type: row.get("entity_type")?,
        entity_id: row.get("entity_id")?,
        entity_name: row.get::<_, Option<String>>("entity_name")?.unwrap_or_default(),
        chapter_id: row.get("chapter_id")?,
        chapter_title: row
            .get::<_, Option<String>>("chapter_title")?
            .unwrap_or_default(),
        note: row.get("note")?,
        created_at: row.get("created_at")?,
    })
}

const REF_SELECT: &str = "
    SELECT r.id, r.project_id, r.entity_type, r.entity_id, r.chapter_id, r.note, r.created_at,
           c.title AS chapter_title,
           COALESCE(
             (SELECT name FROM novel_characters WHERE id = r.entity_id),
             (SELECT name FROM novel_worldview_entries WHERE id = r.entity_id)
           ) AS entity_name
    FROM novel_entity_refs r
    LEFT JOIN novel_chapters c ON c.id = r.chapter_id";

pub fn novel_entity_ref_list_impl(
    db: &Db,
    project_id: &str,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
) -> AppResult<Vec<NovelEntityRef>> {
    db.with_read(|conn| {
        ensure_novel_project(conn, project_id, false)?;
        let entity_type = match entity_type {
            Some(value) => Some(validate_enum(value, "实体类型", ENTITY_TYPES)?),
            None => None,
        };
        let mut sql = format!("{REF_SELECT} WHERE r.project_id = ?1");
        let mut values: Vec<String> = vec![project_id.to_string()];
        if let Some(et) = &entity_type {
            values.push(et.clone());
            sql.push_str(" AND r.entity_type = ?2");
        }
        if let Some(eid) = entity_id {
            values.push(eid.trim().to_string());
            let idx = values.len();
            sql.push_str(&format!(" AND r.entity_id = ?{idx}"));
        }
        sql.push_str(" ORDER BY r.created_at, r.id");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values), row_to_ref)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn novel_entity_ref_add_impl(
    db: &Db,
    project_id: String,
    entity_type: String,
    entity_id: String,
    chapter_id: String,
    note: Option<String>,
) -> AppResult<NovelEntityRef> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let entity_type = validate_enum(&entity_type, "实体类型", ENTITY_TYPES)?;
    let entity_id = entity_id.trim().to_string();
    let chapter_id = chapter_id.trim().to_string();
    if entity_id.is_empty() {
        return Err(AppError::Validation("引用实体不能为空".into()));
    }
    if chapter_id.is_empty() {
        return Err(AppError::Validation("章节不能为空".into()));
    }
    let note = validate_text(note.as_deref().unwrap_or(""), "引用备注", MAX_REF_NOTE_CHARS, true)?;

    let saved_id = db.with_transaction(|conn| {
        ensure_novel_project(conn, &project_id, true)?;
        let chapter_owner = owner_of_chapter(conn, &chapter_id)?;
        if chapter_owner != project_id {
            return Err(AppError::Validation("章节不属于当前项目".into()));
        }
        match entity_type.as_str() {
            "character" => {
                let owner = owner_of_character(conn, &entity_id)?;
                if owner != project_id {
                    return Err(AppError::Validation("人物不属于当前项目".into()));
                }
            }
            "worldview" => {
                let owner = owner_of_worldview(conn, &entity_id)?;
                if owner != project_id {
                    return Err(AppError::Validation("设定不属于当前项目".into()));
                }
            }
            _ => unreachable!("实体类型已由白名单校验"),
        }
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM novel_entity_refs
                 WHERE project_id = ?1 AND entity_type = ?2 AND entity_id = ?3 AND chapter_id = ?4",
                params![project_id, entity_type, entity_id, chapter_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Err(AppError::Conflict("该章节引用已存在".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        conn.execute(
            "INSERT INTO novel_entity_refs
             (id, project_id, entity_type, entity_id, chapter_id, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, project_id, entity_type, entity_id, chapter_id, note, now],
        )?;
        Ok::<String, AppError>(id)
    })?;

    db.with_read(|conn| {
        conn.query_row(
            &format!("{REF_SELECT} WHERE r.id = ?1"),
            params![saved_id],
            row_to_ref,
        )
        .map_err(AppError::from)
    })
}

pub fn novel_entity_ref_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_transaction(|conn| {
        let project_id: Option<String> = conn
            .query_row(
                "SELECT project_id FROM novel_entity_refs WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(project_id) = project_id else {
            return Err(AppError::NotFound("引用不存在或已被删除".into()));
        };
        ensure_novel_project(conn, &project_id, true)?;
        // 解绑：只删除引用行，人物/设定/章节全部保留。
        conn.execute("DELETE FROM novel_entity_refs WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── Tauri 薄包装（注册进 lib.rs 由集成负责人完成） ──────────────────────

#[tauri::command]
pub fn novel_character_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    query: Option<String>,
) -> AppResult<NovelCharactersList> {
    Ok(NovelCharactersList {
        characters: novel_character_list_impl(&db, &project_id, query.as_deref())?,
    })
}

#[tauri::command]
pub fn novel_character_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<NovelCharacterGot> {
    Ok(NovelCharacterGot {
        character: novel_character_get_impl(&db, &id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn novel_character_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    name: String,
    aliases: String,
    intro: String,
    appearance: String,
    background: String,
    motivation: String,
    faction: String,
    status: String,
    notes: String,
    tags: Vec<String>,
    sort_order: Option<i64>,
) -> AppResult<NovelCharacterSaved> {
    Ok(NovelCharacterSaved {
        character: novel_character_save_impl(
            &db,
            id,
            project_id,
            name,
            aliases,
            intro,
            appearance,
            background,
            motivation,
            faction,
            status,
            notes,
            tags,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn novel_character_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<NovelOk> {
    novel_character_delete_impl(&db, &id)?;
    Ok(NovelOk { ok: true })
}

#[tauri::command]
pub fn novel_character_relation_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    character_id: Option<String>,
) -> AppResult<NovelRelationsList> {
    Ok(NovelRelationsList {
        relations: novel_character_relation_list_impl(&db, &project_id, character_id.as_deref())?,
    })
}

#[tauri::command]
pub fn novel_character_relation_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    from_character_id: String,
    to_character_id: String,
    relation_type: String,
    description: String,
) -> AppResult<NovelRelationSaved> {
    Ok(NovelRelationSaved {
        relation: novel_character_relation_save_impl(
            &db,
            id,
            project_id,
            from_character_id,
            to_character_id,
            relation_type,
            description,
        )?,
    })
}

#[tauri::command]
pub fn novel_character_relation_delete(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<NovelOk> {
    novel_character_relation_delete_impl(&db, &id)?;
    Ok(NovelOk { ok: true })
}

#[tauri::command]
pub fn novel_worldview_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    kind: Option<String>,
    query: Option<String>,
) -> AppResult<NovelWorldviewList> {
    Ok(NovelWorldviewList {
        entries: novel_worldview_list_impl(&db, &project_id, kind.as_deref(), query.as_deref())?,
    })
}

#[tauri::command]
pub fn novel_worldview_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<NovelWorldviewGot> {
    Ok(NovelWorldviewGot {
        entry: novel_worldview_get_impl(&db, &id)?,
    })
}

#[tauri::command]
pub fn novel_worldview_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    kind: String,
    name: String,
    description: String,
    tags: Vec<String>,
    sort_order: Option<i64>,
) -> AppResult<NovelWorldviewSaved> {
    Ok(NovelWorldviewSaved {
        entry: novel_worldview_save_impl(
            &db,
            id,
            project_id,
            kind,
            name,
            description,
            tags,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn novel_worldview_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<NovelOk> {
    novel_worldview_delete_impl(&db, &id)?;
    Ok(NovelOk { ok: true })
}

#[tauri::command]
pub fn novel_entity_ref_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    entity_type: Option<String>,
    entity_id: Option<String>,
) -> AppResult<NovelRefsList> {
    Ok(NovelRefsList {
        refs: novel_entity_ref_list_impl(&db, &project_id, entity_type.as_deref(), entity_id.as_deref())?,
    })
}

#[tauri::command]
pub fn novel_entity_ref_add(
    db: State<'_, Arc<Db>>,
    project_id: String,
    entity_type: String,
    entity_id: String,
    chapter_id: String,
    note: Option<String>,
) -> AppResult<NovelRefSaved> {
    Ok(NovelRefSaved {
        reference: novel_entity_ref_add_impl(
            &db,
            project_id,
            entity_type,
            entity_id,
            chapter_id,
            note,
        )?,
    })
}

#[tauri::command]
pub fn novel_entity_ref_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<NovelOk> {
    novel_entity_ref_delete_impl(&db, &id)?;
    Ok(NovelOk { ok: true })
}

// ── 自测 ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::project_workspace::{
        novel_chapter_save_impl, novel_volume_save_impl, workspace_project_list_impl,
        workspace_project_save_impl, workspace_project_set_status_impl, WorkspaceProject,
    };

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn novel_project(db: &Db, name: &str) -> WorkspaceProject {
        workspace_project_save_impl(
            db,
            None,
            name.to_string(),
            "novel".to_string(),
            None,
            None,
            None,
        )
        .expect("创建小说项目")
    }

    fn other_project(db: &Db, name: &str, kind: &str) -> WorkspaceProject {
        workspace_project_save_impl(
            db,
            None,
            name.to_string(),
            kind.to_string(),
            None,
            None,
            None,
        )
        .expect("创建项目")
    }

    fn save_character(db: &Db, project_id: &str, name: &str, tags: &[&str]) -> NovelCharacter {
        novel_character_save_impl(
            db,
            None,
            project_id.to_string(),
            name.to_string(),
            "别名".into(),
            "简介".into(),
            "外貌".into(),
            "背景".into(),
            "动机".into(),
            "阵营".into(),
            "active".into(),
            "备注".into(),
            tags.iter().map(|t| t.to_string()).collect(),
            None,
        )
        .expect("保存人物")
    }

    fn chapter_exists(db: &Db, id: &str) -> AppResult<bool> {
        db.with_read(|conn| {
            let found: Option<()> = conn
                .query_row(
                    "SELECT 1 FROM novel_chapters WHERE id = ?1",
                    params![id],
                    |_| Ok(()),
                )
                .optional()?;
            Ok(found.is_some())
        })
    }

    #[test]
    fn character_save_read_update_and_project_isolation() {
        let db = memdb();
        let a = novel_project(&db, "小说 A");
        let b = novel_project(&db, "小说 B");

        let hero = save_character(&db, &a.id, "林雷", &["主角", "少年"]);
        assert_eq!(hero.name, "林雷");
        assert_eq!(hero.tags, vec!["主角", "少年"]);
        assert_eq!(hero.status, "active");

        // 读出一致。
        let got = novel_character_get_impl(&db, &hero.id).unwrap();
        assert_eq!(got.intro, "简介");
        assert_eq!(got.faction, "阵营");

        // 更新：改名与标签。
        let updated = novel_character_save_impl(
            &db,
            Some(hero.id.clone()),
            a.id.clone(),
            "林雷·巴鲁克".into(),
            "".into(),
            "简介更新".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "missing".into(),
            "".into(),
            vec!["主角".to_string()],
            None,
        )
        .unwrap();
        assert_eq!(updated.name, "林雷·巴鲁克");
        assert_eq!(updated.status, "missing");
        assert_eq!(updated.tags, vec!["主角"]);

        // 项目隔离：B 项目列表看不到 A 的人物。
        let list_b = novel_character_list_impl(&db, &b.id, None).unwrap();
        assert!(list_b.is_empty());
        let list_a = novel_character_list_impl(&db, &a.id, None).unwrap();
        assert_eq!(list_a.len(), 1);

        // 跨项目写入被拒绝。
        let cross = novel_character_save_impl(
            &db,
            Some(hero.id.clone()),
            b.id.clone(),
            "串项目".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "active".into(),
            "".into(),
            vec![],
            None,
        );
        assert!(cross.is_err());
    }

    #[test]
    fn list_is_limited_and_server_search_filters() {
        let db = memdb();
        let a = novel_project(&db, "小说 A");

        for i in 0..505 {
            save_character(&db, &a.id, &format!("角色{i}"), &[]);
        }
        save_character(&db, &a.id, "林雷·主角", &["主角"]);

        // 列表限量 200，避免把整本书读进内存。
        let all = novel_character_list_impl(&db, &a.id, None).unwrap();
        assert_eq!(all.len(), LIST_LIMIT as usize);

        // 服务端按姓名检索：500+ 条量级下仍能命中目标条目。
        let found = novel_character_list_impl(&db, &a.id, Some("林雷")).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "林雷·主角");

        // 标签关键词同样可检索。
        let by_tag = novel_character_list_impl(&db, &a.id, Some("主角")).unwrap();
        assert_eq!(by_tag.len(), 1);
    }

    #[test]
    fn relations_bidirectional_and_unbind_keeps_characters() {
        let db = memdb();
        let a = novel_project(&db, "小说 A");
        let x = save_character(&db, &a.id, "甲", &[]);
        let y = save_character(&db, &a.id, "乙", &[]);

        let rel = novel_character_relation_save_impl(
            &db,
            None,
            a.id.clone(),
            x.id.clone(),
            y.id.clone(),
            "friend".into(),
            "挚友".into(),
        )
        .unwrap();
        assert_eq!(rel.from_name, "甲");
        assert_eq!(rel.to_name, "乙");

        // 双向可查：从乙的角度也能看到这条关系。
        let rels_of_x = novel_character_relation_list_impl(&db, &a.id, Some(&x.id)).unwrap();
        let rels_of_y = novel_character_relation_list_impl(&db, &a.id, Some(&y.id)).unwrap();
        assert_eq!(rels_of_x.len(), 1);
        assert_eq!(rels_of_y.len(), 1);

        // 解绑关系：两个人物都还在。
        novel_character_relation_delete_impl(&db, &rel.id).unwrap();
        assert!(novel_character_get_impl(&db, &x.id).is_ok());
        assert!(novel_character_get_impl(&db, &y.id).is_ok());
        assert!(novel_character_relation_list_impl(&db, &a.id, None).unwrap().is_empty());

        // 自己关联自己被拒绝；非法关系类型被拒绝。
        assert!(novel_character_relation_save_impl(
            &db,
            None,
            a.id.clone(),
            x.id.clone(),
            x.id.clone(),
            "friend".into(),
            "".into(),
        )
        .is_err());
        assert!(novel_character_relation_save_impl(
            &db,
            None,
            a.id.clone(),
            x.id.clone(),
            y.id.clone(),
            "rivals".into(),
            "".into(),
        )
        .is_err());
    }

    #[test]
    fn relation_update_retains_ownership_and_rejects_cross_project() {
        let db = memdb();
        let a = novel_project(&db, "小说 A");
        let x = save_character(&db, &a.id, "甲", &[]);
        let y = save_character(&db, &a.id, "乙", &[]);
        let z = save_character(&db, &a.id, "丙", &[]);

        let rel = novel_character_relation_save_impl(
            &db,
            None,
            a.id.clone(),
            x.id.clone(),
            y.id.clone(),
            "friend".into(),
            "挚友".into(),
        )
        .unwrap();

        // 修改关系：换另一端人物、换类型与描述，应在同项目内生效。
        let updated = novel_character_relation_save_impl(
            &db,
            Some(rel.id.clone()),
            a.id.clone(),
            x.id.clone(),
            z.id.clone(),
            "enemy".into(),
            "宿敌".into(),
        )
        .unwrap();
        assert_eq!(updated.to_character_id, z.id);
        assert_eq!(updated.relation_type, "enemy");
        assert_eq!(updated.description, "宿敌");

        // 旧的乙侧关系已解除，甲→丙可双向查到。
        assert!(novel_character_relation_list_impl(&db, &a.id, Some(&y.id)).unwrap().is_empty());
        let rels_of_z = novel_character_relation_list_impl(&db, &a.id, Some(&z.id)).unwrap();
        assert_eq!(rels_of_z.len(), 1);

        // 跨项目改挂：关系归属与人物归属复核拒绝，原关系保持不变。
        let b = novel_project(&db, "小说 B");
        let w = save_character(&db, &b.id, "丁", &[]);
        assert!(novel_character_relation_save_impl(
            &db,
            Some(rel.id.clone()),
            b.id.clone(),
            x.id.clone(),
            w.id.clone(),
            "enemy".into(),
            "".into(),
        )
        .is_err());
        let unchanged = novel_character_relation_list_impl(&db, &a.id, None).unwrap();
        assert_eq!(unchanged.len(), 1);
        assert_eq!(unchanged[0].to_character_id, z.id);

        // 不存在的关系 ID 返回错误。
        assert!(novel_character_relation_save_impl(
            &db,
            Some("no-such-relation".into()),
            a.id.clone(),
            x.id.clone(),
            z.id.clone(),
            "enemy".into(),
            "".into(),
        )
        .is_err());
    }

    #[test]
    fn worldview_crud_kind_filter_and_tags() {
        let db = memdb();
        let a = novel_project(&db, "小说 A");

        let kingdom = novel_worldview_save_impl(
            &db,
            None,
            a.id.clone(),
            "faction".into(),
            "艾尔王国".into(),
            "大陆北部强权".into(),
            vec!["人类".into()],
            None,
        )
        .unwrap();
        let sword = novel_worldview_save_impl(
            &db,
            None,
            a.id.clone(),
            "item".into(),
            "灰烬之剑".into(),
            "传世利器".into(),
            vec!["武器".into(), "传说".into()],
            None,
        )
        .unwrap();

        let all = novel_worldview_list_impl(&db, &a.id, None, None).unwrap();
        assert_eq!(all.len(), 2);
        let factions = novel_worldview_list_impl(&db, &a.id, Some("faction"), None).unwrap();
        assert_eq!(factions.len(), 1);
        assert_eq!(factions[0].id, kingdom.id);
        let items = novel_worldview_list_impl(&db, &a.id, Some("item"), None).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].tags, vec!["武器", "传说"]);

        // 非法类型拒绝。
        assert!(novel_worldview_list_impl(&db, &a.id, Some("planet"), None).is_err());

        // 更新描述。
        let updated = novel_worldview_save_impl(
            &db,
            Some(sword.id.clone()),
            a.id.clone(),
            "item".into(),
            "灰烬之剑·改".into(),
            "重铸后".into(),
            vec!["武器".into()],
            None,
        )
        .unwrap();
        assert_eq!(updated.name, "灰烬之剑·改");
        assert_eq!(updated.tags, vec!["武器"]);
    }

    #[test]
    fn refs_link_chapter_unbind_keeps_entity_and_chapter() {
        let db = memdb();
        let a = novel_project(&db, "小说 A");
        let volume = novel_volume_save_impl(&db, None, a.id.clone(), "第一卷".into(), None).unwrap();
        let chapter = novel_chapter_save_impl(
            &db,
            None,
            a.id.clone(),
            Some(volume.id.clone()),
            "第一章".into(),
            None,
        )
        .unwrap();
        let hero = save_character(&db, &a.id, "林雷", &[]);
        let kingdom = novel_worldview_save_impl(
            &db,
            None,
            a.id.clone(),
            "faction".into(),
            "艾尔王国".into(),
            "".into(),
            vec![],
            None,
        )
        .unwrap();

        let char_ref = novel_entity_ref_add_impl(
            &db,
            a.id.clone(),
            "character".into(),
            hero.id.clone(),
            chapter.id.clone(),
            Some("首次登场".into()),
        )
        .unwrap();
        let world_ref = novel_entity_ref_add_impl(
            &db,
            a.id.clone(),
            "worldview".into(),
            kingdom.id.clone(),
            chapter.id.clone(),
            None,
        )
        .unwrap();

        // 按实体查询：人物的章节引用。
        let hero_refs =
            novel_entity_ref_list_impl(&db, &a.id, Some("character"), Some(&hero.id)).unwrap();
        assert_eq!(hero_refs.len(), 1);
        assert_eq!(hero_refs[0].chapter_title, "第一章");
        assert_eq!(hero_refs[0].entity_name, "林雷");

        let all_refs = novel_entity_ref_list_impl(&db, &a.id, None, None).unwrap();
        assert_eq!(all_refs.len(), 2);

        // 解绑引用：人物、设定、章节全部保留。
        novel_entity_ref_delete_impl(&db, &char_ref.id).unwrap();
        assert!(novel_character_get_impl(&db, &hero.id).is_ok());
        assert!(chapter_exists(&db, &chapter.id).unwrap());
        assert!(novel_entity_ref_list_impl(&db, &a.id, Some("character"), Some(&hero.id))
            .unwrap()
            .is_empty());

        // 解绑后同一实体同一章节可重新关联（不残留唯一约束幽灵）。
        let readd = novel_entity_ref_add_impl(
            &db,
            a.id.clone(),
            "character".into(),
            hero.id.clone(),
            chapter.id.clone(),
            None,
        )
        .unwrap();
        assert_eq!(readd.chapter_id, chapter.id);

        // 删除设定会清理其引用，但章节保留。
        novel_worldview_delete_impl(&db, &kingdom.id).unwrap();
        assert!(novel_entity_ref_list_impl(&db, &a.id, Some("worldview"), Some(&kingdom.id))
            .unwrap()
            .is_empty());
        assert!(chapter_exists(&db, &chapter.id).unwrap());
        let _ = world_ref;
    }

    #[test]
    fn archived_project_is_readonly_and_wrong_kind_rejected() {
        let db = memdb();
        let a = novel_project(&db, "小说 A");
        let other = other_project(&db, "游戏项目", "game");

        let hero = save_character(&db, &a.id, "林雷", &[]);
        let kingdom = novel_worldview_save_impl(
            &db,
            None,
            a.id.clone(),
            "faction".into(),
            "艾尔王国".into(),
            "".into(),
            vec![],
            None,
        )
        .unwrap();

        // 非小说类型项目写入被门禁拒绝。
        assert!(novel_character_save_impl(
            &db,
            None,
            other.id.clone(),
            "串类型".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "active".into(),
            "".into(),
            vec![],
            None,
        )
        .is_err());

        workspace_project_set_status_impl(&db, &a.id, "archived".into()).unwrap();

        // 归档后读取仍允许。
        assert!(novel_character_list_impl(&db, &a.id, None).is_ok());
        assert!(novel_worldview_list_impl(&db, &a.id, None, None).is_ok());
        assert!(novel_entity_ref_list_impl(&db, &a.id, None, None).is_ok());

        // 归档后所有写入拒绝。
        assert!(novel_character_save_impl(
            &db,
            Some(hero.id.clone()),
            a.id.clone(),
            "改名".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            "active".into(),
            "".into(),
            vec![],
            None,
        )
        .is_err());
        assert!(novel_character_delete_impl(&db, &hero.id).is_err());
        assert!(novel_worldview_save_impl(
            &db,
            Some(kingdom.id.clone()),
            a.id.clone(),
            "faction".into(),
            "改名".into(),
            "".into(),
            vec![],
            None,
        )
        .is_err());
        assert!(novel_worldview_delete_impl(&db, &kingdom.id).is_err());
        assert!(novel_entity_ref_add_impl(
            &db,
            a.id.clone(),
            "character".into(),
            hero.id.clone(),
            "missing-chapter".into(),
            None,
        )
        .is_err());
    }

    #[test]
    fn novel_b2_tables_roundtrip_in_full_and_quick_backup() {
        use crate::commands::backup::{read_bundle, write_bundle, BackupKind, BackupSources};
        use crate::commands::data::{import_parsed_with, validate_bundle, ImportOptions};

        let db = memdb();
        let a = novel_project(&db, "小说备份");
        let volume = novel_volume_save_impl(&db, None, a.id.clone(), "第一卷".into(), None).unwrap();
        let chapter = novel_chapter_save_impl(
            &db,
            None,
            a.id.clone(),
            Some(volume.id.clone()),
            "第一章".into(),
            None,
        )
        .unwrap();
        let hero = save_character(&db, &a.id, "林雷", &["主角"]);
        let ally = save_character(&db, &a.id, "艾米", &[]);
        let rel = novel_character_relation_save_impl(
            &db,
            None,
            a.id.clone(),
            hero.id.clone(),
            ally.id.clone(),
            "friend".into(),
            "挚友".into(),
        )
        .unwrap();
        let kingdom = novel_worldview_save_impl(
            &db,
            None,
            a.id.clone(),
            "faction".into(),
            "艾尔王国".into(),
            "北部强权".into(),
            vec!["人类".into()],
            None,
        )
        .unwrap();
        let _ref = novel_entity_ref_add_impl(
            &db,
            a.id.clone(),
            "character".into(),
            hero.id.clone(),
            chapter.id.clone(),
            Some("登场".into()),
        )
        .unwrap();

        let dir = std::env::temp_dir().join(format!(
            "td-novel-b2-backup-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        for kind in [BackupKind::Full, BackupKind::Quick] {
            let target = dir.join(format!("{}.json", kind.as_str()));
            write_bundle(&db, BackupSources::default(), &target, kind).unwrap();
            let staging = dir.join(format!("staging-{}", kind.as_str()));
            std::fs::create_dir_all(&staging).unwrap();
            let read = read_bundle(&target, &staging).unwrap();

            let dst = memdb();
            let parsed = validate_bundle(&dst, &read.data, &read.rows_dir).unwrap();
            import_parsed_with(
                &dst,
                parsed,
                &ImportOptions {
                    allow_extended: true,
                    commit_marker: None,
                },
            )
            .unwrap();

            let restored_project = workspace_project_list_impl(&dst, None).unwrap();
            assert_eq!(restored_project.len(), 1);
            let pid = restored_project[0].id.clone();

            let characters = novel_character_list_impl(&dst, &pid, None).unwrap();
            assert_eq!(characters.len(), 2, "{:?} 恢复后人物丢失", kind);
            let restored_hero = characters.iter().find(|c| c.name == "林雷").unwrap();
            assert_eq!(restored_hero.tags, vec!["主角"]);
            assert_eq!(restored_hero.background, "背景");

            let relations = novel_character_relation_list_impl(&dst, &pid, None).unwrap();
            assert_eq!(relations.len(), 1, "{:?} 恢复后关系丢失", kind);
            assert_eq!(relations[0].description, "挚友");
            let _ = rel.id;

            let entries = novel_worldview_list_impl(&dst, &pid, None, None).unwrap();
            assert_eq!(entries.len(), 1, "{:?} 恢复后设定丢失", kind);
            assert_eq!(entries[0].name, "艾尔王国");
            assert_eq!(entries[0].description, "北部强权");
            let _ = kingdom.id;

            let refs = novel_entity_ref_list_impl(&dst, &pid, None, None).unwrap();
            assert_eq!(refs.len(), 1, "{:?} 恢复后章节引用丢失", kind);
            assert_eq!(refs[0].chapter_title, "第一章");
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
