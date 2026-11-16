//! AI 漫剧工作空间专业后端（C1，2026-11-16）：剧集 / 分镜 / 角色场景 / 产物版本。
//!
//! ## 归属
//! 本文件由**漫剧线**独占编写；`commands/mod.rs`、`db/mod.rs`、`lib.rs`、`backup.rs`
//! 由集成负责人维护，本文件不得修改它们。
//!
//! ## 约定
//! - 命令命名前缀 `comic_`，形参见 `project_workspace.rs`（`*_impl(db, ...)` + 薄 `#[tauri::command]`）。
//! - 写入门禁：`kind = ai_comic` 且 `status = active`；读取允许归档项目（归档 = 只读）。
//! - 素材只存**路径引用 + 元数据**，不复制用户原始文件；文件失效时读侧返回 `file_exists=false`，
//!   前端降级为「文件缺失」提示，不崩溃、不静默清理引用。
//! - 删除剧集/镜头/角色/场景/版本只删本地元数据行，**绝不删除、移动、重命名用户素材原文件**。
//! - AI 生成能力本轮**未接入**：不提供生成命令；导入命令只接受 `source = imported`，
//!   不伪造已生成产物。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// v61：剧集 / 分镜 / 角色 / 场景 / 素材版本（漫剧 C1）。
///
/// 关系：
/// - `comic_episodes.project_id` → `workspace_projects` 级联；
/// - `comic_shots.episode_id` → `comic_episodes` 级联，`project_id` 级联；
/// - `comic_characters` / `comic_scenes.project_id` 级联；
/// - `comic_media_versions` 可挂到镜头（级联）/ 角色 / 场景（置空）；
/// - 剧集↔角色、镜头↔角色用 JSON 数组列承载（契约冻结表清单外不新增关系表）；
/// - 镜头↔场景用 `scene_id` 单外键。
pub const MIGRATION_61: (i64, &'static str) = (
    61,
    r#"
-- v61（漫剧 C1）：剧集 / 分镜 / 角色 / 场景 / 素材版本。
CREATE TABLE comic_episodes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  episode_no INTEGER NOT NULL DEFAULT 0 CHECK (episode_no >= 0),
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scripting','storyboard','producing','reviewing','done')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  character_ids_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_episodes_project
  ON comic_episodes(project_id, sort_order, created_at);

CREATE TABLE comic_characters (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  ref_image_path TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_characters_project
  ON comic_characters(project_id, sort_order, created_at);

CREATE TABLE comic_scenes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ref_image_path TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_scenes_project
  ON comic_scenes(project_id, sort_order, created_at);

CREATE TABLE comic_shots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES comic_episodes(id) ON DELETE CASCADE,
  shot_no INTEGER NOT NULL DEFAULT 0 CHECK (shot_no >= 0),
  description TEXT NOT NULL DEFAULT '',
  character_ids_json TEXT NOT NULL DEFAULT '[]',
  scene_id TEXT REFERENCES comic_scenes(id) ON DELETE SET NULL,
  dialogue TEXT NOT NULL DEFAULT '',
  shot_size TEXT NOT NULL DEFAULT '',
  camera_move TEXT NOT NULL DEFAULT '',
  duration_sec REAL NOT NULL DEFAULT 0 CHECK (duration_sec >= 0),
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo','doing','blocked','done')),
  asset_refs_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_shots_episode
  ON comic_shots(episode_id, sort_order, created_at);
CREATE INDEX idx_comic_shots_project
  ON comic_shots(project_id, sort_order, created_at);
CREATE INDEX idx_comic_shots_scene ON comic_shots(scene_id);

CREATE TABLE comic_media_versions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  shot_id TEXT REFERENCES comic_shots(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES comic_characters(id) ON DELETE SET NULL,
  scene_id TEXT REFERENCES comic_scenes(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  media_kind TEXT NOT NULL DEFAULT 'image'
    CHECK (media_kind IN ('image','video','other')),
  version_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','adopted','rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'imported'
    CHECK (source IN ('imported','planned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_media_shot ON comic_media_versions(shot_id, created_at);
CREATE INDEX idx_comic_media_project ON comic_media_versions(project_id, created_at);
-- 同一镜头同一时刻只能有一个 adopted（角色/场景参考图不参与采用互斥）。
CREATE UNIQUE INDEX idx_comic_media_adopted_shot
  ON comic_media_versions(shot_id)
  WHERE status = 'adopted' AND shot_id IS NOT NULL;
"#,
);

// ── 常量与上限 ─────────────────────────────────────────────────────────

const MAX_TITLE_CHARS: usize = 240;
const MAX_LONG_TEXT_CHARS: usize = 4000;
const MAX_SCRIPT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PATH_CHARS: usize = 4096;
const MAX_REF_COUNT: usize = 50;
const MAX_ASSET_REFS: usize = 20;
/// 列表默认限量（契约 §3.9）。
const MAX_LIST_ROWS: i64 = 200;

const EPISODE_STATUSES: &[&str] = &[
    "draft",
    "scripting",
    "storyboard",
    "producing",
    "reviewing",
    "done",
];
const SHOT_STATUSES: &[&str] = &["todo", "doing", "blocked", "done"];
const MEDIA_KINDS: &[&str] = &["image", "video", "other"];
const MEDIA_IMPORT_STATUSES: &[&str] = &["candidate", "rejected"];

// ── 返回模型 ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicEpisode {
    pub id: String,
    pub project_id: String,
    pub episode_no: i64,
    pub title: String,
    pub synopsis: String,
    pub script: String,
    pub status: String,
    pub progress: i64,
    pub character_ids: Vec<String>,
    pub shot_count: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicShot {
    pub id: String,
    pub project_id: String,
    pub episode_id: String,
    pub shot_no: i64,
    pub description: String,
    pub character_ids: Vec<String>,
    pub scene_id: Option<String>,
    pub dialogue: String,
    pub shot_size: String,
    pub camera_move: String,
    pub duration_sec: f64,
    pub status: String,
    pub asset_refs: Vec<String>,
    pub note: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicCharacter {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub role: String,
    pub description: String,
    pub ref_image_path: String,
    pub ref_image_exists: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicScene {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub description: String,
    pub ref_image_path: String,
    pub ref_image_exists: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicMediaVersion {
    pub id: String,
    pub project_id: String,
    pub shot_id: Option<String>,
    pub character_id: Option<String>,
    pub scene_id: Option<String>,
    pub file_path: String,
    /// 读时计算：引用路径当前是否存在；缺失不清理，由前端降级提示。
    pub file_exists: bool,
    pub media_kind: String,
    pub version_label: String,
    pub status: String,
    pub review_note: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

// ── 命令响应包装 ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ComicEpisodeList {
    pub episodes: Vec<ComicEpisode>,
}
#[derive(Serialize)]
pub struct ComicEpisodeGot {
    pub episode: ComicEpisode,
}
#[derive(Serialize)]
pub struct ComicEpisodeSaved {
    pub episode: ComicEpisode,
}
#[derive(Serialize)]
pub struct ComicShotList {
    pub shots: Vec<ComicShot>,
}
#[derive(Serialize)]
pub struct ComicShotGot {
    pub shot: ComicShot,
}
#[derive(Serialize)]
pub struct ComicShotSaved {
    pub shot: ComicShot,
}
#[derive(Serialize)]
pub struct ComicCharacterList {
    pub characters: Vec<ComicCharacter>,
}
#[derive(Serialize)]
pub struct ComicCharacterSaved {
    pub character: ComicCharacter,
}
#[derive(Serialize)]
pub struct ComicSceneList {
    pub scenes: Vec<ComicScene>,
}
#[derive(Serialize)]
pub struct ComicSceneSaved {
    pub scene: ComicScene,
}
#[derive(Serialize)]
pub struct ComicMediaList {
    pub versions: Vec<ComicMediaVersion>,
}
#[derive(Serialize)]
pub struct ComicMediaSaved {
    pub version: ComicMediaVersion,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicOk {
    pub ok: bool,
}

// ── 校验与门禁 ─────────────────────────────────────────────────────────

fn validate_enum(value: &str, field: &str, allowed: &[&str]) -> AppResult<String> {
    let value = value.trim();
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(AppError::Validation(format!(
            "{} 只允许 {} 之一，收到 {:?}",
            field,
            allowed.join(" | "),
            value
        )))
    }
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

/// 剧本正文：只做字节大小与 NUL 校验，不去首尾空白（缩进/空行属于作者内容）。
fn validate_script_body(raw: &str) -> AppResult<String> {
    if raw.len() > MAX_SCRIPT_BYTES {
        return Err(AppError::Validation(format!(
            "剧本内容超过 {} MiB 上限",
            MAX_SCRIPT_BYTES / (1024 * 1024)
        )));
    }
    if raw.contains('\0') {
        return Err(AppError::Validation("剧本内容含非法控制字符".into()));
    }
    Ok(raw.to_string())
}

fn validate_ref_path(raw: &str, field: &str) -> AppResult<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.len() > MAX_PATH_CHARS {
        return Err(AppError::Validation(format!("{field}路径过长")));
    }
    if raw.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(format!("{field}路径含非法控制字符")));
    }
    if !Path::new(raw).is_absolute() {
        return Err(AppError::Validation(format!("{field}必须是绝对路径")));
    }
    Ok(raw.to_string())
}

fn validate_id_list(
    raw: Option<Vec<String>>,
    field: &str,
    max: usize,
) -> AppResult<Vec<String>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(raw.len());
    for item in raw {
        let item = item.trim().to_string();
        if item.is_empty() {
            continue;
        }
        if item.chars().count() > 64 || item.chars().any(|c| c.is_control()) {
            return Err(AppError::Validation(format!("{field}格式非法")));
        }
        if !out.iter().any(|x| x == &item) {
            out.push(item);
        }
    }
    if out.len() > max {
        return Err(AppError::Validation(format!("{field}最多关联 {max} 项")));
    }
    Ok(out)
}

fn parse_id_array(raw: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

fn serialize_id_array(items: &[String]) -> AppResult<String> {
    serde_json::to_string(items).map_err(AppError::from)
}

fn validate_sort_order(value: i64) -> AppResult<i64> {
    if !(-1_000_000..=1_000_000).contains(&value) {
        return Err(AppError::Validation("排序值超出范围".into()));
    }
    Ok(value)
}

fn file_exists(path: &str) -> bool {
    !path.is_empty() && Path::new(path).exists()
}

/// 漫剧专用门禁：只有 `kind = ai_comic` 的项目可读写；
/// `require_active` 为 true 时（所有写入）还要求 `status = active`；读取允许归档。
fn ensure_comic_project(
    conn: &Connection,
    project_id: &str,
    require_active: bool,
) -> AppResult<()> {
    let (kind, status): (String, String) = conn
        .query_row(
            "SELECT kind, status FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))?;
    if kind != "ai_comic" {
        return Err(AppError::Validation(
            "该操作仅对 AI 漫剧项目开放".to_string(),
        ));
    }
    if require_active && status != "active" {
        return Err(AppError::Validation(
            "项目已归档，剧集/分镜/角色/素材只读；恢复为进行中后才能修改".to_string(),
        ));
    }
    Ok(())
}

fn owner_project_id(conn: &Connection, table: &str, id: &str) -> AppResult<String> {
    let sql = format!("SELECT project_id FROM {table} WHERE id = ?1");
    conn.query_row(&sql, params![id], |row| row.get(0))
        .optional()?
        .ok_or_else(|| AppError::NotFound("记录不存在或已被删除".into()))
}

fn ensure_episode_belongs(
    conn: &Connection,
    project_id: &str,
    episode_id: &str,
) -> AppResult<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM comic_episodes WHERE id = ?1",
            params![episode_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("剧集不属于当前项目".into())),
        None => Err(AppError::Validation("剧集不存在".into())),
    }
}

fn ensure_scene_belongs(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> AppResult<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM comic_scenes WHERE id = ?1",
            params![scene_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("场景不属于当前项目".into())),
        None => Err(AppError::Validation("场景不存在".into())),
    }
}

fn ensure_characters_belong(
    conn: &Connection,
    project_id: &str,
    character_ids: &[String],
) -> AppResult<()> {
    for cid in character_ids {
        let owner: Option<String> = conn
            .query_row(
                "SELECT project_id FROM comic_characters WHERE id = ?1",
                params![cid],
                |r| r.get(0),
            )
            .optional()?;
        match owner {
            Some(owner) if owner == project_id => continue,
            Some(_) => return Err(AppError::Validation("关联角色不属于当前项目".into())),
            None => return Err(AppError::Validation("关联角色不存在".into())),
        }
    }
    Ok(())
}

fn next_sort(conn: &Connection, table: &str, project_id: &str) -> AppResult<i64> {
    let sql = format!(
        "SELECT COALESCE(MAX(sort_order), -1) FROM {table} WHERE project_id = ?1"
    );
    let max: i64 = conn.query_row(&sql, params![project_id], |r| r.get(0))?;
    Ok(max.saturating_add(1))
}

fn next_episode_no(conn: &Connection, project_id: &str) -> AppResult<i64> {
    let max: i64 = conn.query_row(
        "SELECT COALESCE(MAX(episode_no), 0) FROM comic_episodes WHERE project_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    Ok(max.saturating_add(1))
}

fn next_shot_no(conn: &Connection, episode_id: &str) -> AppResult<i64> {
    let max: i64 = conn.query_row(
        "SELECT COALESCE(MAX(shot_no), 0) FROM comic_shots WHERE episode_id = ?1",
        params![episode_id],
        |r| r.get(0),
    )?;
    Ok(max.saturating_add(1))
}

// ── 剧集 ──────────────────────────────────────────────────────────────

fn row_to_episode(conn: &Connection, row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicEpisode> {
    let id: String = row.get("id")?;
    let character_ids_json: String = row.get("character_ids_json")?;
    let shot_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM comic_shots WHERE episode_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(ComicEpisode {
        id,
        project_id: row.get("project_id")?,
        episode_no: row.get("episode_no")?,
        title: row.get("title")?,
        synopsis: row.get("synopsis")?,
        script: row.get("script")?,
        status: row.get("status")?,
        progress: row.get("progress")?,
        character_ids: parse_id_array(&character_ids_json),
        shot_count,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_episode(conn: &Connection, id: &str) -> AppResult<ComicEpisode> {
    conn.query_row(
        "SELECT id, project_id, episode_no, title, synopsis, script, status, progress,
                character_ids_json, sort_order, created_at, updated_at
         FROM comic_episodes WHERE id = ?1",
        params![id],
        |row| row_to_episode(conn, row),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("剧集不存在或已被删除".into()))
}

pub fn comic_episode_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<ComicEpisode>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, episode_no, title, synopsis, script, status, progress,
                    character_ids_json, sort_order, created_at, updated_at
             FROM comic_episodes WHERE project_id = ?1
             ORDER BY sort_order, created_at, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], |row| {
            row_to_episode(conn, row)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn comic_episode_get_impl(db: &Db, id: &str) -> AppResult<ComicEpisode> {
    db.with_read(|conn| {
        let project_id = owner_project_id(conn, "comic_episodes", id)?;
        ensure_comic_project(conn, &project_id, false)?;
        read_episode(conn, id)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn comic_episode_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    episode_no: Option<i64>,
    title: String,
    synopsis: String,
    script: String,
    status: String,
    progress: i64,
    character_ids: Option<Vec<String>>,
    sort_order: Option<i64>,
) -> AppResult<ComicEpisode> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let title = validate_text(&title, "剧集标题", MAX_TITLE_CHARS, false)?;
    let synopsis = validate_text(&synopsis, "剧情简介", MAX_LONG_TEXT_CHARS, true)?;
    let script = validate_script_body(&script)?;
    let status = validate_enum(&status, "剧集状态", EPISODE_STATUSES)?;
    if !(0..=100).contains(&progress) {
        return Err(AppError::Validation("制作进度必须在 0–100 之间".into()));
    }
    let episode_no = episode_no.unwrap_or(0).max(0);
    let character_ids = validate_id_list(character_ids, "出场角色", MAX_REF_COUNT)?;
    let character_ids_json = serialize_id_array(&character_ids)?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        ensure_characters_belong(conn, &project_id, &character_ids)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_sort(conn, "comic_episodes", &project_id)?,
                };
                let no = if episode_no == 0 {
                    next_episode_no(conn, &project_id)?
                } else {
                    episode_no
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_episodes
                     (id, project_id, episode_no, title, synopsis, script, status, progress,
                      character_ids_json, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
                    params![
                        id,
                        project_id,
                        no,
                        title,
                        synopsis,
                        script,
                        status,
                        progress,
                        character_ids_json,
                        order,
                        now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64)> = conn
                    .query_row(
                        "SELECT project_id, sort_order FROM comic_episodes WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((owner, current_order)) = existing else {
                    return Err(AppError::NotFound("剧集不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("剧集不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                let no = if episode_no == 0 {
                    conn.query_row(
                        "SELECT episode_no FROM comic_episodes WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )?
                } else {
                    episode_no
                };
                conn.execute(
                    "UPDATE comic_episodes
                     SET episode_no = ?2, title = ?3, synopsis = ?4, script = ?5,
                         status = ?6, progress = ?7, character_ids_json = ?8,
                         sort_order = ?9, updated_at = ?10
                     WHERE id = ?1 AND project_id = ?11",
                    params![
                        id,
                        no,
                        title,
                        synopsis,
                        script,
                        status,
                        progress,
                        character_ids_json,
                        order,
                        now,
                        project_id
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_episode(conn, &saved_id))
}

pub fn comic_episode_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_episodes", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        // 镜头与镜头下素材版本由外键级联删除；用户素材原文件不动。
        conn.execute("DELETE FROM comic_episodes WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// 剧集排序：按传入 ID 顺序重写 sort_order；ID 必须全部属于本项目。
pub fn comic_episode_reorder_impl(
    db: &Db,
    project_id: &str,
    episode_ids: Vec<String>,
) -> AppResult<Vec<ComicEpisode>> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_transaction(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        for (index, episode_id) in episode_ids.iter().enumerate() {
            let owner: Option<String> = conn
                .query_row(
                    "SELECT project_id FROM comic_episodes WHERE id = ?1",
                    params![episode_id],
                    |r| r.get(0),
                )
                .optional()?;
            match owner {
                Some(owner) if owner == project_id => {}
                Some(_) => return Err(AppError::Validation("剧集不属于当前项目".into())),
                None => return Err(AppError::NotFound("剧集不存在或已被删除".into())),
            }
            conn.execute(
                "UPDATE comic_episodes SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                params![episode_id, index as i64, now_iso()],
            )?;
        }
        Ok(())
    })?;
    comic_episode_list_impl(db, &project_id)
}

// ── 分镜 ──────────────────────────────────────────────────────────────

fn row_to_shot(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicShot> {
    let character_ids_json: String = row.get("character_ids_json")?;
    let asset_refs_json: String = row.get("asset_refs_json")?;
    Ok(ComicShot {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        episode_id: row.get("episode_id")?,
        shot_no: row.get("shot_no")?,
        description: row.get("description")?,
        character_ids: parse_id_array(&character_ids_json),
        scene_id: row.get("scene_id")?,
        dialogue: row.get("dialogue")?,
        shot_size: row.get("shot_size")?,
        camera_move: row.get("camera_move")?,
        duration_sec: row.get("duration_sec")?,
        status: row.get("status")?,
        asset_refs: parse_id_array(&asset_refs_json),
        note: row.get("note")?,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_shot(conn: &Connection, id: &str) -> AppResult<ComicShot> {
    conn.query_row(
        "SELECT id, project_id, episode_id, shot_no, description, character_ids_json,
                scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                asset_refs_json, note, sort_order, created_at, updated_at
         FROM comic_shots WHERE id = ?1",
        params![id],
        row_to_shot,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("镜头不存在或已被删除".into()))
}

pub fn comic_shot_list_impl(
    db: &Db,
    project_id: &str,
    episode_id: Option<String>,
) -> AppResult<Vec<ComicShot>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        if let Some(episode_id) = episode_id.as_deref().filter(|s| !s.is_empty()) {
            ensure_episode_belongs(conn, project_id, episode_id)?;
        }
        let mut stmt = conn.prepare(
            "SELECT id, project_id, episode_id, shot_no, description, character_ids_json,
                    scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                    asset_refs_json, note, sort_order, created_at, updated_at
             FROM comic_shots
             WHERE project_id = ?1 AND (?2 IS NULL OR episode_id = ?2)
             ORDER BY episode_id, sort_order, created_at, id
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![project_id, episode_id, MAX_LIST_ROWS],
            row_to_shot,
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn comic_shot_get_impl(db: &Db, id: &str) -> AppResult<ComicShot> {
    db.with_read(|conn| {
        let project_id = owner_project_id(conn, "comic_shots", id)?;
        ensure_comic_project(conn, &project_id, false)?;
        read_shot(conn, id)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn comic_shot_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    episode_id: String,
    shot_no: Option<i64>,
    description: String,
    character_ids: Option<Vec<String>>,
    scene_id: Option<String>,
    dialogue: String,
    shot_size: String,
    camera_move: String,
    duration_sec: Option<f64>,
    status: String,
    asset_refs: Option<Vec<String>>,
    note: String,
    sort_order: Option<i64>,
) -> AppResult<ComicShot> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let episode_id = episode_id.trim().to_string();
    if episode_id.is_empty() {
        return Err(AppError::Validation("镜头必须归属剧集".into()));
    }
    let description = validate_text(&description, "镜头描述", MAX_LONG_TEXT_CHARS, true)?;
    let dialogue = validate_text(&dialogue, "台词", MAX_LONG_TEXT_CHARS, true)?;
    let shot_size = validate_text(&shot_size, "景别", MAX_TITLE_CHARS, true)?;
    let camera_move = validate_text(&camera_move, "运镜说明", MAX_LONG_TEXT_CHARS, true)?;
    let note = validate_text(&note, "备注", MAX_LONG_TEXT_CHARS, true)?;
    let status = validate_enum(&status, "镜头状态", SHOT_STATUSES)?;
    let duration_sec = duration_sec.unwrap_or(0.0).max(0.0);
    if !duration_sec.is_finite() {
        return Err(AppError::Validation("预计时长非法".into()));
    }
    let character_ids = validate_id_list(character_ids, "出场角色", MAX_REF_COUNT)?;
    let asset_refs = validate_id_list(asset_refs, "素材引用", MAX_ASSET_REFS)?;
    let scene_id = match scene_id {
        None => None,
        Some(raw) => {
            let raw = raw.trim().to_string();
            if raw.is_empty() {
                None
            } else {
                Some(raw)
            }
        }
    };
    let character_ids_json = serialize_id_array(&character_ids)?;
    let asset_refs_json = serialize_id_array(&asset_refs)?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        ensure_episode_belongs(conn, &project_id, &episode_id)?;
        if let Some(scene_id) = scene_id.as_deref() {
            ensure_scene_belongs(conn, &project_id, scene_id)?;
        }
        ensure_characters_belong(conn, &project_id, &character_ids)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_sort(conn, "comic_shots", &project_id)?,
                };
                let no = match shot_no {
                    Some(value) if value > 0 => value,
                    _ => next_shot_no(conn, &episode_id)?,
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_shots
                     (id, project_id, episode_id, shot_no, description, character_ids_json,
                      scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                      asset_refs_json, note, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                              ?15, ?16, ?16)",
                    params![
                        id,
                        project_id,
                        episode_id,
                        no,
                        description,
                        character_ids_json,
                        scene_id,
                        dialogue,
                        shot_size,
                        camera_move,
                        duration_sec,
                        status,
                        asset_refs_json,
                        note,
                        order,
                        now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64)> = conn
                    .query_row(
                        "SELECT project_id, sort_order FROM comic_shots WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((owner, current_order)) = existing else {
                    return Err(AppError::NotFound("镜头不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("镜头不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                let no = match shot_no.filter(|v| *v > 0) {
                    Some(value) => value,
                    None => conn.query_row(
                        "SELECT shot_no FROM comic_shots WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )?,
                };
                conn.execute(
                    "UPDATE comic_shots
                     SET episode_id = ?2, shot_no = ?3, description = ?4,
                         character_ids_json = ?5, scene_id = ?6, dialogue = ?7,
                         shot_size = ?8, camera_move = ?9, duration_sec = ?10, status = ?11,
                         asset_refs_json = ?12, note = ?13, sort_order = ?14, updated_at = ?15
                     WHERE id = ?1 AND project_id = ?16",
                    params![
                        id,
                        episode_id,
                        no,
                        description,
                        character_ids_json,
                        scene_id,
                        dialogue,
                        shot_size,
                        camera_move,
                        duration_sec,
                        status,
                        asset_refs_json,
                        note,
                        order,
                        now,
                        project_id
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_shot(conn, &saved_id))
}

pub fn comic_shot_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_shots", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        // 素材版本由外键级联删除元数据行；用户素材原文件不动。
        conn.execute("DELETE FROM comic_shots WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// 镜头排序：限定在同一剧集内，按传入 ID 顺序重写 sort_order。
pub fn comic_shot_reorder_impl(
    db: &Db,
    project_id: &str,
    episode_id: &str,
    shot_ids: Vec<String>,
) -> AppResult<Vec<ComicShot>> {
    let project_id = project_id.trim().to_string();
    let episode_id = episode_id.trim().to_string();
    if project_id.is_empty() || episode_id.is_empty() {
        return Err(AppError::Validation("项目与剧集不能为空".into()));
    }
    db.with_transaction(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        ensure_episode_belongs(conn, &project_id, &episode_id)?;
        for (index, shot_id) in shot_ids.iter().enumerate() {
            let row: Option<(String, String)> = conn
                .query_row(
                    "SELECT project_id, episode_id FROM comic_shots WHERE id = ?1",
                    params![shot_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match row {
                Some((owner, ep)) if owner == project_id && ep == episode_id => {}
                Some(_) => return Err(AppError::Validation("镜头不属于当前剧集".into())),
                None => return Err(AppError::NotFound("镜头不存在或已被删除".into())),
            }
            conn.execute(
                "UPDATE comic_shots SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                params![shot_id, index as i64, now_iso()],
            )?;
        }
        Ok(())
    })?;
    comic_shot_list_impl(db, &project_id, Some(episode_id.to_string()))
}

// ── 角色 ──────────────────────────────────────────────────────────────

fn row_to_character(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicCharacter> {
    let ref_image_path: String = row.get("ref_image_path")?;
    Ok(ComicCharacter {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        role: row.get("role")?,
        description: row.get("description")?,
        ref_image_exists: file_exists(&ref_image_path),
        ref_image_path,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_character(conn: &Connection, id: &str) -> AppResult<ComicCharacter> {
    conn.query_row(
        "SELECT id, project_id, name, role, description, ref_image_path, sort_order,
                created_at, updated_at
         FROM comic_characters WHERE id = ?1",
        params![id],
        row_to_character,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("角色不存在或已被删除".into()))
}

pub fn comic_character_list_impl(
    db: &Db,
    project_id: &str,
) -> AppResult<Vec<ComicCharacter>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, role, description, ref_image_path, sort_order,
                    created_at, updated_at
             FROM comic_characters WHERE project_id = ?1
             ORDER BY sort_order, created_at, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], row_to_character)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn comic_character_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    name: String,
    role: String,
    description: String,
    ref_image_path: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<ComicCharacter> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let name = validate_text(&name, "角色名称", MAX_TITLE_CHARS, false)?;
    let role = validate_text(&role, "角色定位", MAX_LONG_TEXT_CHARS, true)?;
    let description = validate_text(&description, "角色设定", MAX_LONG_TEXT_CHARS, true)?;
    let ref_image_path = validate_ref_path(
        ref_image_path.as_deref().unwrap_or_default(),
        "参考图",
    )?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_sort(conn, "comic_characters", &project_id)?,
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_characters
                     (id, project_id, name, role, description, ref_image_path, sort_order,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    params![id, project_id, name, role, description, ref_image_path, order, now],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64)> = conn
                    .query_row(
                        "SELECT project_id, sort_order FROM comic_characters WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((owner, current_order)) = existing else {
                    return Err(AppError::NotFound("角色不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("角色不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                conn.execute(
                    "UPDATE comic_characters
                     SET name = ?2, role = ?3, description = ?4, ref_image_path = ?5,
                         sort_order = ?6, updated_at = ?7
                     WHERE id = ?1 AND project_id = ?8",
                    params![id, name, role, description, ref_image_path, order, now, project_id],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_character(conn, &saved_id))
}

pub fn comic_character_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_characters", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        // 镜头/剧集上的角色弱引用由读侧降级展示；素材版本的 character_id 置空。
        conn.execute("DELETE FROM comic_characters WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── 场景 ──────────────────────────────────────────────────────────────

fn row_to_scene(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicScene> {
    let ref_image_path: String = row.get("ref_image_path")?;
    Ok(ComicScene {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        ref_image_exists: file_exists(&ref_image_path),
        ref_image_path,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_scene(conn: &Connection, id: &str) -> AppResult<ComicScene> {
    conn.query_row(
        "SELECT id, project_id, name, description, ref_image_path, sort_order,
                created_at, updated_at
         FROM comic_scenes WHERE id = ?1",
        params![id],
        row_to_scene,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("场景不存在或已被删除".into()))
}

pub fn comic_scene_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<ComicScene>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, description, ref_image_path, sort_order,
                    created_at, updated_at
             FROM comic_scenes WHERE project_id = ?1
             ORDER BY sort_order, created_at, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], row_to_scene)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn comic_scene_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    name: String,
    description: String,
    ref_image_path: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<ComicScene> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let name = validate_text(&name, "场景名称", MAX_TITLE_CHARS, false)?;
    let description = validate_text(&description, "场景设定", MAX_LONG_TEXT_CHARS, true)?;
    let ref_image_path = validate_ref_path(
        ref_image_path.as_deref().unwrap_or_default(),
        "参考图",
    )?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_sort(conn, "comic_scenes", &project_id)?,
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_scenes
                     (id, project_id, name, description, ref_image_path, sort_order,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![id, project_id, name, description, ref_image_path, order, now],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64)> = conn
                    .query_row(
                        "SELECT project_id, sort_order FROM comic_scenes WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((owner, current_order)) = existing else {
                    return Err(AppError::NotFound("场景不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("场景不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                conn.execute(
                    "UPDATE comic_scenes
                     SET name = ?2, description = ?3, ref_image_path = ?4, sort_order = ?5,
                         updated_at = ?6
                     WHERE id = ?1 AND project_id = ?7",
                    params![id, name, description, ref_image_path, order, now, project_id],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_scene(conn, &saved_id))
}

pub fn comic_scene_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_scenes", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        conn.execute("DELETE FROM comic_scenes WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── 素材与产物版本 ────────────────────────────────────────────────────

fn row_to_media(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicMediaVersion> {
    let file_path: String = row.get("file_path")?;
    Ok(ComicMediaVersion {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        shot_id: row.get("shot_id")?,
        character_id: row.get("character_id")?,
        scene_id: row.get("scene_id")?,
        file_exists: file_exists(&file_path),
        file_path,
        media_kind: row.get("media_kind")?,
        version_label: row.get("version_label")?,
        status: row.get("status")?,
        review_note: row.get("review_note")?,
        source: row.get("source")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_media(conn: &Connection, id: &str) -> AppResult<ComicMediaVersion> {
    conn.query_row(
        "SELECT id, project_id, shot_id, character_id, scene_id, file_path, media_kind,
                version_label, status, review_note, source, created_at, updated_at
         FROM comic_media_versions WHERE id = ?1",
        params![id],
        row_to_media,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("素材版本不存在或已被删除".into()))
}

pub fn comic_media_list_impl(
    db: &Db,
    project_id: &str,
    shot_id: Option<String>,
) -> AppResult<Vec<ComicMediaVersion>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        if let Some(shot_id) = shot_id.as_deref().filter(|s| !s.is_empty()) {
            let owner: Option<String> = conn
                .query_row(
                    "SELECT project_id FROM comic_shots WHERE id = ?1",
                    params![shot_id],
                    |r| r.get(0),
                )
                .optional()?;
            match owner {
                Some(owner) if owner == project_id => {}
                Some(_) => return Err(AppError::Validation("镜头不属于当前项目".into())),
                None => return Err(AppError::NotFound("镜头不存在".into())),
            }
        }
        let mut stmt = conn.prepare(
            "SELECT id, project_id, shot_id, character_id, scene_id, file_path, media_kind,
                    version_label, status, review_note, source, created_at, updated_at
             FROM comic_media_versions
             WHERE project_id = ?1 AND (?2 IS NULL OR shot_id = ?2)
             ORDER BY created_at, id
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![project_id, shot_id, MAX_LIST_ROWS], row_to_media)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

/// 导入本地素材：只登记绝对路径引用，不复制大文件；目标三选一（镜头/角色/场景）。
#[allow(clippy::too_many_arguments)]
pub fn comic_media_import_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    shot_id: Option<String>,
    character_id: Option<String>,
    scene_id: Option<String>,
    file_path: String,
    media_kind: String,
    version_label: Option<String>,
    review_note: Option<String>,
) -> AppResult<ComicMediaVersion> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let file_path = validate_ref_path(&file_path, "素材路径")?;
    if file_path.is_empty() {
        return Err(AppError::Validation("素材路径不能为空".into()));
    }
    let media_kind = validate_enum(&media_kind, "素材类型", MEDIA_KINDS)?;
    let version_label = validate_text(
        version_label.as_deref().unwrap_or_default(),
        "版本标注",
        MAX_TITLE_CHARS,
        true,
    )?;
    let review_note = validate_text(
        review_note.as_deref().unwrap_or_default(),
        "修改意见",
        MAX_LONG_TEXT_CHARS,
        true,
    )?;
    let shot_id = normalize_target(shot_id)?;
    let character_id = normalize_target(character_id)?;
    let scene_id = normalize_target(scene_id)?;
    let target_count = shot_id.is_some() as usize
        + character_id.is_some() as usize
        + scene_id.is_some() as usize;
    if target_count != 1 {
        return Err(AppError::Validation(
            "素材必须且只能关联到一个镜头、角色或场景".into(),
        ));
    }

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        if let Some(shot_id) = shot_id.as_deref() {
            ensure_shot_belongs(conn, &project_id, shot_id)?;
        }
        if let Some(character_id) = character_id.as_deref() {
            ensure_character_belongs(conn, &project_id, character_id)?;
        }
        if let Some(scene_id) = scene_id.as_deref() {
            ensure_scene_belongs(conn, &project_id, scene_id)?;
        }
        let now = now_iso();
        let id = id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match id {
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_media_versions
                     (id, project_id, shot_id, character_id, scene_id, file_path, media_kind,
                      version_label, status, review_note, source, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'candidate', ?9, 'imported',
                              ?10, ?10)",
                    params![
                        id,
                        project_id,
                        shot_id,
                        character_id,
                        scene_id,
                        file_path,
                        media_kind,
                        version_label,
                        review_note,
                        now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<String> = conn.query_row(
                    "SELECT project_id FROM comic_media_versions WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                ).optional()?;
                let Some(owner) = existing else {
                    return Err(AppError::NotFound("素材版本不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("素材版本不属于当前项目".into()));
                }
                conn.execute(
                    "UPDATE comic_media_versions
                     SET shot_id = ?2, character_id = ?3, scene_id = ?4, file_path = ?5,
                         media_kind = ?6, version_label = ?7, review_note = ?8, updated_at = ?9
                     WHERE id = ?1 AND project_id = ?10",
                    params![
                        id,
                        shot_id,
                        character_id,
                        scene_id,
                        file_path,
                        media_kind,
                        version_label,
                        review_note,
                        now,
                        project_id
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_media(conn, &saved_id))
}

fn normalize_target(raw: Option<String>) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let value = value.trim().to_string();
            if value.is_empty() {
                Ok(None)
            } else if value.chars().count() > 64 || value.chars().any(|c| c.is_control()) {
                Err(AppError::Validation("关联目标格式非法".into()))
            } else {
                Ok(Some(value))
            }
        }
    }
}

fn ensure_shot_belongs(
    conn: &Connection,
    project_id: &str,
    shot_id: &str,
) -> AppResult<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM comic_shots WHERE id = ?1",
            params![shot_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("镜头不属于当前项目".into())),
        None => Err(AppError::Validation("镜头不存在".into())),
    }
}

fn ensure_character_belongs(
    conn: &Connection,
    project_id: &str,
    character_id: &str,
) -> AppResult<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM comic_characters WHERE id = ?1",
            params![character_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("角色不属于当前项目".into())),
        None => Err(AppError::Validation("角色不存在".into())),
    }
}

/// 版本元信息编辑：版本标注 / 修改意见 / 候选-拒收状态。采用状态走 `adopt` 命令。
pub fn comic_media_save_impl(
    db: &Db,
    id: &str,
    version_label: Option<String>,
    status: Option<String>,
    review_note: Option<String>,
) -> AppResult<ComicMediaVersion> {
    let version_label = validate_text(
        version_label.as_deref().unwrap_or_default(),
        "版本标注",
        MAX_TITLE_CHARS,
        true,
    )?;
    let review_note = validate_text(
        review_note.as_deref().unwrap_or_default(),
        "修改意见",
        MAX_LONG_TEXT_CHARS,
        true,
    )?;
    let status = match status {
        None => None,
        Some(value) => Some(validate_enum(
            &value,
            "素材状态",
            MEDIA_IMPORT_STATUSES,
        )?),
    };
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_media_versions", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        let now = now_iso();
        match status {
            Some(status) => conn.execute(
                "UPDATE comic_media_versions
                 SET version_label = ?2, status = ?3, review_note = ?4, updated_at = ?5
                 WHERE id = ?1",
                params![id, version_label, status, review_note, now],
            )?,
            None => conn.execute(
                "UPDATE comic_media_versions
                 SET version_label = ?2, review_note = ?3, updated_at = ?4
                 WHERE id = ?1",
                params![id, version_label, review_note, now],
            )?,
        };
        Ok(())
    })?;
    db.with_read(|conn| read_media(conn, id))
}

/// 标记采用：同一镜头下其余版本回到候选；未关联镜头的参考素材不能采用。
pub fn comic_media_adopt_impl(db: &Db, id: &str) -> AppResult<ComicMediaVersion> {
    db.with_transaction(|conn| {
        let project_id = owner_project_id(conn, "comic_media_versions", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        let shot_id: Option<String> = conn.query_row(
            "SELECT shot_id FROM comic_media_versions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        ).optional()?
        .ok_or_else(|| AppError::NotFound("素材版本不存在或已被删除".into()))?;
        let Some(shot_id) = shot_id else {
            return Err(AppError::Validation(
                "未关联镜头的参考素材不能标记为采用版本".into(),
            ));
        };
        let now = now_iso();
        conn.execute(
            "UPDATE comic_media_versions
             SET status = 'candidate', updated_at = ?2
             WHERE shot_id = ?1 AND status = 'adopted' AND id != ?3",
            params![shot_id, now, id],
        )?;
        conn.execute(
            "UPDATE comic_media_versions
             SET status = 'adopted', updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    })?;
    db.with_read(|conn| read_media(conn, id))
}

pub fn comic_media_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_media_versions", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        // 只删元数据行；登记引用的用户原文件保留在原位。
        conn.execute("DELETE FROM comic_media_versions WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── 薄包装（注册进 lib.rs 由集成负责人完成） ─────────────────────────────

#[tauri::command]
pub fn comic_episode_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ComicEpisodeList> {
    Ok(ComicEpisodeList {
        episodes: comic_episode_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn comic_episode_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicEpisodeGot> {
    Ok(ComicEpisodeGot {
        episode: comic_episode_get_impl(&db, &id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn comic_episode_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    episode_no: Option<i64>,
    title: String,
    synopsis: String,
    script: String,
    status: String,
    progress: i64,
    character_ids: Option<Vec<String>>,
    sort_order: Option<i64>,
) -> AppResult<ComicEpisodeSaved> {
    Ok(ComicEpisodeSaved {
        episode: comic_episode_save_impl(
            &db,
            id,
            project_id,
            episode_no,
            title,
            synopsis,
            script,
            status,
            progress,
            character_ids,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn comic_episode_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_episode_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

#[tauri::command]
pub fn comic_episode_reorder(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_ids: Vec<String>,
) -> AppResult<ComicEpisodeList> {
    Ok(ComicEpisodeList {
        episodes: comic_episode_reorder_impl(&db, &project_id, episode_ids)?,
    })
}

#[tauri::command]
pub fn comic_shot_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_id: Option<String>,
) -> AppResult<ComicShotList> {
    Ok(ComicShotList {
        shots: comic_shot_list_impl(&db, &project_id, episode_id)?,
    })
}

#[tauri::command]
pub fn comic_shot_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicShotGot> {
    Ok(ComicShotGot {
        shot: comic_shot_get_impl(&db, &id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn comic_shot_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    episode_id: String,
    shot_no: Option<i64>,
    description: String,
    character_ids: Option<Vec<String>>,
    scene_id: Option<String>,
    dialogue: String,
    shot_size: String,
    camera_move: String,
    duration_sec: Option<f64>,
    status: String,
    asset_refs: Option<Vec<String>>,
    note: String,
    sort_order: Option<i64>,
) -> AppResult<ComicShotSaved> {
    Ok(ComicShotSaved {
        shot: comic_shot_save_impl(
            &db,
            id,
            project_id,
            episode_id,
            shot_no,
            description,
            character_ids,
            scene_id,
            dialogue,
            shot_size,
            camera_move,
            duration_sec,
            status,
            asset_refs,
            note,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn comic_shot_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_shot_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

#[tauri::command]
pub fn comic_shot_reorder(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_id: String,
    shot_ids: Vec<String>,
) -> AppResult<ComicShotList> {
    Ok(ComicShotList {
        shots: comic_shot_reorder_impl(&db, &project_id, &episode_id, shot_ids)?,
    })
}

#[tauri::command]
pub fn comic_character_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ComicCharacterList> {
    Ok(ComicCharacterList {
        characters: comic_character_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn comic_character_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    name: String,
    role: String,
    description: String,
    ref_image_path: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<ComicCharacterSaved> {
    Ok(ComicCharacterSaved {
        character: comic_character_save_impl(
            &db,
            id,
            project_id,
            name,
            role,
            description,
            ref_image_path,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn comic_character_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_character_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

#[tauri::command]
pub fn comic_scene_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ComicSceneList> {
    Ok(ComicSceneList {
        scenes: comic_scene_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn comic_scene_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    name: String,
    description: String,
    ref_image_path: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<ComicSceneSaved> {
    Ok(ComicSceneSaved {
        scene: comic_scene_save_impl(
            &db,
            id,
            project_id,
            name,
            description,
            ref_image_path,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn comic_scene_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_scene_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

#[tauri::command]
pub fn comic_media_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    shot_id: Option<String>,
) -> AppResult<ComicMediaList> {
    Ok(ComicMediaList {
        versions: comic_media_list_impl(&db, &project_id, shot_id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn comic_media_import(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    shot_id: Option<String>,
    character_id: Option<String>,
    scene_id: Option<String>,
    file_path: String,
    media_kind: String,
    version_label: Option<String>,
    review_note: Option<String>,
) -> AppResult<ComicMediaSaved> {
    Ok(ComicMediaSaved {
        version: comic_media_import_impl(
            &db,
            id,
            project_id,
            shot_id,
            character_id,
            scene_id,
            file_path,
            media_kind,
            version_label,
            review_note,
        )?,
    })
}

#[tauri::command]
pub fn comic_media_save(
    db: State<'_, Arc<Db>>,
    id: String,
    version_label: Option<String>,
    status: Option<String>,
    review_note: Option<String>,
) -> AppResult<ComicMediaSaved> {
    Ok(ComicMediaSaved {
        version: comic_media_save_impl(&db, &id, version_label, status, review_note)?,
    })
}

#[tauri::command]
pub fn comic_media_adopt(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicMediaSaved> {
    Ok(ComicMediaSaved {
        version: comic_media_adopt_impl(&db, &id)?,
    })
}

#[tauri::command]
pub fn comic_media_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_media_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

// ── 测试 ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::backup::{BackupKind, BackupSources, read_bundle, write_bundle};
    use crate::commands::data::{self, ImportOptions};
    use crate::commands::project_workspace::{
        workspace_project_save_impl, workspace_project_set_status_impl, WorkspaceProject,
    };

    fn create_comic_project(db: &Db, name: &str) -> WorkspaceProject {
        workspace_project_save_impl(db, None, name.to_string(), "ai_comic".into(), None, None, None)
            .expect("创建漫剧项目")
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-comic-{}-{}",
            tag,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 构造验收基线：2 集、每集 3 镜头、3 角色、2 场景、2+ 素材版本。
    fn seed_fixture_data(db: &Db) -> FixtureIds {
        let project = create_comic_project(db, "测试漫剧");
        let ep1 = comic_episode_save_impl(
            db, None, project.id.clone(), Some(1), "第一集".into(),
            "开场简介".into(), "第一场剧本正文。".into(), "scripting".to_string(), 30,
            None, None,
        )
        .unwrap();
        let ep2 = comic_episode_save_impl(
            db, None, project.id.clone(), Some(2), "第二集".into(),
            "中段简介".into(), "第二场剧本正文。".into(), "draft".to_string(), 10,
            None, None,
        )
        .unwrap();

        let c1 = comic_character_save_impl(
            db, None, project.id.clone(), "黑发少年".into(), "小前锋".into(),
            "196cm，25 号球衣".into(), None, None,
        )
        .unwrap();
        let c2 = comic_character_save_impl(
            db, None, project.id.clone(), "队友".into(), "后卫".into(),
            "组织进攻".into(), None, None,
        )
        .unwrap();
        let c3 = comic_character_save_impl(
            db, None, project.id.clone(), "对手队长".into(), "中锋".into(),
            "内线支柱".into(), None, None,
        )
        .unwrap();
        let s1 = comic_scene_save_impl(
            db, None, project.id.clone(), "篮球场".into(), "室内体育馆".into(), None, None,
        )
        .unwrap();
        let s2 = comic_scene_save_impl(
            db, None, project.id.clone(), "更衣室".into(), "赛后走廊".into(), None, None,
        )
        .unwrap();

        let mut shots = Vec::new();
        for (episode, label) in [(&ep1, "A"), (&ep2, "B")] {
            for i in 1..=3 {
                let shot = comic_shot_save_impl(
                    db, None, project.id.clone(), episode.id.clone(), Some(i),
                    format!("{label}-镜头{i}描述"),
                    Some(vec![c1.id.clone(), c2.id.clone()]),
                    Some(s1.id.clone()),
                    format!("{label}-镜头{i}台词"),
                    "中景".into(), "固定机位".into(), Some(3.5),
                    "todo".to_string(), None, format!("{label}-镜头{i}备注"), None,
                )
                .unwrap();
                shots.push(shot);
            }
        }

        let v1 = comic_media_import_impl(
            db, None, project.id.clone(), Some(shots[0].id.clone()), None, None,
            "C:/fixtures/shot-a1-v1.png".into(), "image".to_string(), Some("v1".into()),
            Some("初稿构图".into()),
        )
        .unwrap();
        let v2 = comic_media_import_impl(
            db, None, project.id.clone(), Some(shots[0].id.clone()), None, None,
            "C:/fixtures/shot-a1-v2.png".into(), "image".to_string(), Some("v2".into()),
            Some("调整后".into()),
        )
        .unwrap();

        FixtureIds {
            project,
            episodes: vec![ep1, ep2],
            characters: vec![c1, c2, c3],
            scenes: vec![s1, s2],
            shots,
            versions: vec![v1, v2],
        }
    }

    struct FixtureIds {
        project: WorkspaceProject,
        episodes: Vec<ComicEpisode>,
        characters: Vec<ComicCharacter>,
        scenes: Vec<ComicScene>,
        shots: Vec<ComicShot>,
        versions: Vec<ComicMediaVersion>,
    }

    #[test]
    fn comic_crud_ordering_relations_adoption_and_script_persist() {
        let db = Db::open_in_memory().unwrap();
        let fx = seed_fixture_data(&db);

        // 剧集与镜头按默认顺序持久；每集 3 镜头。
        let episodes = comic_episode_list_impl(&db, &fx.project.id).unwrap();
        assert_eq!(episodes.len(), 2);
        assert_eq!(episodes[0].title, "第一集");
        assert_eq!(episodes[0].script, "第一场剧本正文。");
        assert_eq!(episodes[0].shot_count, 3);
        assert_eq!(episodes[1].shot_count, 3);

        let shots_ep1 = comic_shot_list_impl(
            &db,
            &fx.project.id,
            Some(fx.episodes[0].id.clone()),
        )
        .unwrap();
        assert_eq!(shots_ep1.len(), 3);
        assert_eq!(
            shots_ep1[0].character_ids,
            vec![fx.characters[0].id.clone(), fx.characters[1].id.clone()]
        );
        assert_eq!(shots_ep1[0].scene_id, Some(fx.scenes[0].id.clone()));

        // 重排剧集：逆序后重新读出，顺序必须持久。
        comic_episode_reorder_impl(
            &db,
            &fx.project.id,
            vec![fx.episodes[1].id.clone(), fx.episodes[0].id.clone()],
        )
        .unwrap();
        let reordered = comic_episode_list_impl(&db, &fx.project.id).unwrap();
        assert_eq!(reordered[0].id, fx.episodes[1].id);
        assert_eq!(reordered[1].id, fx.episodes[0].id);

        // 重排镜头：同集内逆序持久。
        comic_shot_reorder_impl(
            &db,
            &fx.project.id,
            &fx.episodes[0].id,
            vec![
                shots_ep1[2].id.clone(),
                shots_ep1[1].id.clone(),
                shots_ep1[0].id.clone(),
            ],
        )
        .unwrap();
        let shots_after = comic_shot_list_impl(
            &db,
            &fx.project.id,
            Some(fx.episodes[0].id.clone()),
        )
        .unwrap();
        assert_eq!(shots_after[0].id, shots_ep1[2].id);

        // 剧本保存与恢复：改名 + 改剧本后 get 逐字返回。
        let updated = comic_episode_save_impl(
            &db,
            Some(fx.episodes[0].id.clone()),
            fx.project.id.clone(),
            Some(1),
            "第一集（修订）".into(),
            "修订简介".into(),
            "修订后的剧本正文。".into(),
            "storyboard".to_string(),
            55,
            Some(vec![fx.characters[0].id.clone()]),
            None,
        )
        .unwrap();
        assert_eq!(updated.title, "第一集（修订）");
        let got = comic_episode_get_impl(&db, &fx.episodes[0].id).unwrap();
        assert_eq!(got.script, "修订后的剧本正文。");
        assert_eq!(got.progress, 55);
        assert_eq!(got.character_ids, vec![fx.characters[0].id.clone()]);

        // 采用唯一：v2 采用后，v1 回到候选；同镜头不能有第二个 adopted。
        comic_media_adopt_impl(&db, &fx.versions[1].id).unwrap();
        let list = comic_media_list_impl(&db, &fx.project.id, Some(shots_ep1[0].id.clone()))
            .unwrap();
        let adopted: Vec<_> = list.iter().filter(|v| v.status == "adopted").collect();
        assert_eq!(adopted.len(), 1);
        assert_eq!(adopted[0].id, fx.versions[1].id);
        let v1 = db
            .with_read(|conn| read_media(conn, &fx.versions[0].id))
            .unwrap();
        assert_eq!(v1.status, "candidate");

        // 切项目隔离：另一项目看不到本项目数据。
        let other = create_comic_project(&db, "另一部漫剧");
        assert!(comic_episode_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(comic_shot_list_impl(&db, &other.id, None).unwrap().is_empty());
        assert!(comic_character_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(comic_scene_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(comic_media_list_impl(&db, &other.id, None).unwrap().is_empty());
    }

    #[test]
    fn comic_commands_reject_non_comic_kind_and_enforce_archived_read_only() {
        let db = Db::open_in_memory().unwrap();
        let comic = create_comic_project(&db, "漫剧");
        let ep = comic_episode_save_impl(
            &db, None, comic.id.clone(), None, "第一集".into(),
            "".into(), "剧本".into(), "draft".to_string(), 0, None, None,
        )
        .unwrap();
        let shot = comic_shot_save_impl(
            &db, None, comic.id.clone(), ep.id.clone(), None, "镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".to_string(), None, "".into(), None,
        )
        .unwrap();

        // 非 ai_comic 项目：读写一律拒绝。
        for kind in ["game", "development", "general", "novel"] {
            let p = workspace_project_save_impl(
                &db, None, kind.into(), kind.into(), None, None, None,
            )
            .unwrap();
            assert!(comic_episode_list_impl(&db, &p.id).is_err(), "{kind} 不应读剧集");
            assert!(comic_episode_save_impl(
                &db, None, p.id.clone(), None, "偷渡集".into(), "".into(), "".into(),
                "draft".to_string(), 0, None, None,
            ).is_err(), "{kind} 不应写剧集");
            assert!(comic_shot_list_impl(&db, &p.id, None).is_err(), "{kind} 不应读镜头");
            assert!(comic_character_list_impl(&db, &p.id).is_err(), "{kind} 不应读角色");
            assert!(comic_scene_list_impl(&db, &p.id).is_err(), "{kind} 不应读场景");
            assert!(comic_media_list_impl(&db, &p.id, None).is_err(), "{kind} 不应读素材");
        }

        // 归档：读取允许，所有写入拒绝。
        workspace_project_set_status_impl(&db, &comic.id, "archived".into()).unwrap();
        assert_eq!(comic_episode_list_impl(&db, &comic.id).unwrap().len(), 1);
        assert_eq!(comic_shot_list_impl(&db, &comic.id, None).unwrap().len(), 1);
        assert!(comic_episode_save_impl(
            &db, Some(ep.id.clone()), comic.id.clone(), None, "改名".into(), "".into(), "".into(),
            "draft".to_string(), 0, None, None,
        ).is_err());
        assert!(comic_episode_delete_impl(&db, &ep.id).is_err());
        assert!(comic_shot_save_impl(
            &db, Some(shot.id.clone()), comic.id.clone(), ep.id.clone(), None, "改名".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".to_string(), None, "".into(), None,
        ).is_err());
        assert!(comic_shot_delete_impl(&db, &shot.id).is_err());
        assert!(comic_character_save_impl(
            &db, None, comic.id.clone(), "偷渡角色".into(), "".into(), "".into(), None, None,
        ).is_err());
        assert!(comic_media_import_impl(
            &db, None, comic.id.clone(), Some(shot.id.clone()), None, None,
            "C:/x.png".into(), "image".to_string(), None, None,
        ).is_err());

        // 恢复 active 后可写。
        workspace_project_set_status_impl(&db, &comic.id, "active".into()).unwrap();
        comic_episode_delete_impl(&db, &ep.id).unwrap();
        let violations: i64 = db
            .with_read(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })?
                )
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn comic_missing_media_path_degrades_without_crash() {
        let db = Db::open_in_memory().unwrap();
        let fx = seed_fixture_data(&db);

        // 引用路径为不存在的位置：读侧必须返回 file_exists=false，而不是报错/崩溃。
        let missing = comic_media_import_impl(
            &db, None, fx.project.id.clone(), Some(fx.shots[0].id.clone()), None, None,
            "C:/definitely/not/existing/shot-missing.png".into(), "image".to_string(),
            Some("缺失版本".into()), None,
        )
        .unwrap();
        assert!(!missing.file_exists, "不存在路径必须标记为文件缺失");

        let list = comic_media_list_impl(&db, &fx.project.id, Some(fx.shots[0].id.clone())).unwrap();
        let row = list.iter().find(|v| v.id == missing.id).unwrap();
        assert!(!row.file_exists);
        // fixture 路径同样不存在，也应降级而不是报错。
        assert!(list.iter().all(|v| !v.file_exists || v.file_path.is_empty()));

        // 角色/场景参考图空路径不报错。
        let chars = comic_character_list_impl(&db, &fx.project.id).unwrap();
        assert!(chars.iter().all(|c| !c.ref_image_exists));
        let scenes = comic_scene_list_impl(&db, &fx.project.id).unwrap();
        assert!(scenes.iter().all(|s| !s.ref_image_exists));
    }

    #[test]
    fn comic_tables_roundtrip_in_full_and_quick_backup() {
        let db = Db::open_in_memory().unwrap();
        let fx = seed_fixture_data(&db);
        comic_media_adopt_impl(&db, &fx.versions[1].id).unwrap();

        for kind in [BackupKind::Full, BackupKind::Quick] {
            let dir = temp_dir("roundtrip");
            let target = dir.join("backup.json");
            write_bundle(&db, BackupSources::default(), &target, kind).unwrap();
            let staging = dir.join("staging");
            let read = read_bundle(&target, &staging).unwrap();

            let dst = Db::open_in_memory().unwrap();
            let parsed = data::validate_bundle(&dst, &read.data, &read.rows_dir).unwrap();
            data::import_parsed_with(
                &dst,
                parsed,
                &ImportOptions { allow_extended: true, commit_marker: None },
            )
            .unwrap();

            let restored = comic_episode_list_impl(&dst, &fx.project.id).unwrap();
            assert_eq!(restored.len(), 2, "{:?} 恢复后剧集丢失", kind);
            assert_eq!(restored[0].script, "第一场剧本正文。");
            let restored_shots = comic_shot_list_impl(&dst, &fx.project.id, None).unwrap();
            assert_eq!(restored_shots.len(), 6, "{:?} 恢复后镜头丢失", kind);
            assert_eq!(restored_shots[0].character_ids.len(), 2);
            let restored_chars = comic_character_list_impl(&dst, &fx.project.id).unwrap();
            assert_eq!(restored_chars.len(), 3, "{:?} 恢复后角色丢失", kind);
            let restored_scenes = comic_scene_list_impl(&dst, &fx.project.id).unwrap();
            assert_eq!(restored_scenes.len(), 2, "{:?} 恢复后场景丢失", kind);
            let restored_media = comic_media_list_impl(&dst, &fx.project.id, None).unwrap();
            assert_eq!(restored_media.len(), 2, "{:?} 恢复后素材版本丢失", kind);
            let adopted: Vec<_> = restored_media.iter().filter(|v| v.status == "adopted").collect();
            assert_eq!(adopted.len(), 1, "{:?} 采用状态必须随备份还原", kind);
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
