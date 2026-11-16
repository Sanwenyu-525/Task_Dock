//! 游戏工作空间专业后端（G1，2026-11-16）：引擎识别 / 资源关联 / 构建与测试记录。
//!
//! ## 归属
//! 本文件由**游戏线**独占编写；`commands/mod.rs`、`db/mod.rs`、`lib.rs`、`backup.rs`
//! 由集成负责人维护，本文件不得修改它们。
//!
//! ## 约定
//! - 命令命名前缀 `game_`，形参见 `project_workspace.rs`：`*_impl(db, ...)` + 薄 `#[tauri::command]`。
//! - 所有写入门禁：`kind = game` 且 `status = active`；读取允许归档（只读）。
//! - 项目识别必须基于真实文件特征（`ProjectSettings/ProjectVersion.txt`、`*.uproject`、
//!   `project.godot` 等），识别失败返回「未知」，**禁止按目录名猜测**；手动指定由用户显式
//!   写入事实表，记录证据路径与识别方式 `auto` / `manual`。
//! - **不得执行任意外部命令**：本轮只做构建/测试记录登记，不调用 Unity/Unreal/Godot
//!   可执行文件，不渲染「自动构建」假入口。
//! - 外部源文件安全：只存路径 + 元数据；删除关联不删除、移动、重命名用户原文件。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::file_workspace::normalize_lexical;

/// v60：引擎识别事实 / 游戏资源 / 构建记录 / 测试记录（游戏 G1）。
///
/// 四张表均带 `project_id` 并 `REFERENCES workspace_projects(id) ON DELETE CASCADE`；
/// `item_id` / `build_id` 为弱引用（不建外键）：目标事项/构建被删除后保留原 ID，
/// 读侧如实标注失效，不级联删除资源与记录。
pub const MIGRATION_60: (i64, &'static str) = (
    60,
    r#"
-- v60（游戏 G1）：引擎识别事实 / 游戏资源 / 构建记录 / 测试记录。
-- 关系：workspace_projects 删除级联四张表；事项与构建为弱引用，不建外键。
CREATE TABLE game_project_facts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  engine TEXT NOT NULL DEFAULT 'unknown'
    CHECK (engine IN ('unity','unreal','godot','custom','unknown')),
  detection_method TEXT NOT NULL DEFAULT 'unknown'
    CHECK (detection_method IN ('auto','manual','unknown')),
  engine_version TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id)
);
CREATE INDEX idx_game_facts_project ON game_project_facts(project_id);

CREATE TABLE game_assets (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('image','model','audio','animation','scene','config','other')),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  relative_path TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT 'inside' CHECK (location IN ('inside','outside')),
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  modified_at TEXT NOT NULL DEFAULT '',
  item_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_game_assets_project ON game_assets(project_id, kind, created_at);
CREATE INDEX idx_game_assets_item ON game_assets(item_id);

CREATE TABLE game_builds (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL
    CHECK (status IN ('planned','success','failed','canceled','unknown')),
  built_at TEXT NOT NULL,
  log_path TEXT NOT NULL DEFAULT '',
  log_summary TEXT NOT NULL DEFAULT '',
  artifact_path TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','imported')),
  item_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_game_builds_project ON game_builds(project_id, built_at DESC);
CREATE INDEX idx_game_builds_item ON game_builds(item_id);

CREATE TABLE game_tests (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  build_id TEXT,
  title TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL
    CHECK (result IN ('passed','failed','blocked','skipped','unknown')),
  tested_at TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  defect_count INTEGER NOT NULL DEFAULT 0 CHECK (defect_count >= 0),
  item_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_game_tests_project ON game_tests(project_id, tested_at DESC);
CREATE INDEX idx_game_tests_build ON game_tests(build_id);
CREATE INDEX idx_game_tests_item ON game_tests(item_id);
"#,
);

// ── 枚举与上限 ─────────────────────────────────────────────────────────

const ENGINES: &[&str] = &["unity", "unreal", "godot", "custom", "unknown"];
const DETECTION_METHODS: &[&str] = &["auto", "manual", "unknown"];
const ASSET_KINDS: &[&str] = &[
    "image", "model", "audio", "animation", "scene", "config", "other",
];
const BUILD_STATUSES: &[&str] = &["planned", "success", "failed", "canceled", "unknown"];
const TEST_RESULTS: &[&str] = &["passed", "failed", "blocked", "skipped", "unknown"];

const MAX_NAME_CHARS: usize = 240;
const MAX_NOTE_CHARS: usize = 2000;
const MAX_PATH_CHARS: usize = 4096;
const MAX_TEXT_CHARS: usize = 500;
const MAX_EVIDENCE_CHARS: usize = 1000;
const MAX_LIST_ROWS: i64 = 500;

// ── 返回模型 ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameProjectFact {
    pub id: String,
    pub project_id: String,
    pub engine: String,
    pub detection_method: String,
    pub engine_version: String,
    pub evidence: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 只读扫描结果：不落库；确认后由 `game_project_facts_save` 持久化。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameDetectionReport {
    pub engine: String,
    pub engine_version: String,
    /// 命中的真实特征标记（相对项目根的路径片段）；未命中为空。
    pub evidence: Vec<String>,
    pub root_exists: bool,
    pub root_path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameAsset {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub location: String,
    pub size_bytes: i64,
    pub modified_at: String,
    pub item_id: Option<String>,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    /// 读时计算：登记路径当前是否存在（不落库）。
    pub path_exists: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameBuild {
    pub id: String,
    pub project_id: String,
    pub target: String,
    pub engine: String,
    pub config: String,
    pub status: String,
    pub built_at: String,
    pub log_path: String,
    pub log_summary: String,
    pub artifact_path: String,
    pub source: String,
    pub item_id: Option<String>,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    pub log_exists: bool,
    pub artifact_exists: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameTestRecord {
    pub id: String,
    pub project_id: String,
    pub build_id: Option<String>,
    pub title: String,
    pub scope: String,
    pub result: String,
    pub tested_at: String,
    pub summary: String,
    pub defect_count: i64,
    pub item_id: Option<String>,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

// ── 命令响应包装 ────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GameFactGot {
    pub facts: Option<GameProjectFact>,
}

#[derive(Serialize)]
pub struct GameFactSaved {
    pub facts: GameProjectFact,
}

#[derive(Serialize)]
pub struct GameDetection {
    pub detection: GameDetectionReport,
    pub facts: Option<GameProjectFact>,
}

#[derive(Serialize)]
pub struct GameAssetList {
    pub assets: Vec<GameAsset>,
}

#[derive(Serialize)]
pub struct GameAssetSaved {
    pub asset: GameAsset,
}

#[derive(Serialize)]
pub struct GameBuildList {
    pub builds: Vec<GameBuild>,
}

#[derive(Serialize)]
pub struct GameBuildSaved {
    pub build: GameBuild,
}

#[derive(Serialize)]
pub struct GameTestList {
    pub tests: Vec<GameTestRecord>,
}

#[derive(Serialize)]
pub struct GameTestSaved {
    pub test: GameTestRecord,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameOk {
    pub ok: bool,
}

// ── 公共校验与门禁 ─────────────────────────────────────────────────────

fn validate_text(value: &str, field: &str, max_chars: usize, allow_empty: bool) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() && !allow_empty {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if value.chars().count() > max_chars {
        return Err(AppError::Validation(format!("{field}超过 {max_chars} 字符")));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(format!("{field}含非法控制字符")));
    }
    Ok(value.to_string())
}

fn validate_enum(value: &str, field: &str, allowed: &[&str]) -> AppResult<String> {
    let value = value.trim();
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(AppError::Validation(format!(
            "{field}只允许 {} 之一，收到 {:?}",
            allowed.join(" | "),
            value
        )))
    }
}

fn normalize_optional_id(raw: Option<String>, field: &str) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let value = value.trim();
            if value.is_empty() {
                Ok(None)
            } else if value.chars().count() > 64 || value.chars().any(|c| c.is_control()) {
                Err(AppError::Validation(format!("{field}格式非法")))
            } else {
                Ok(Some(value.to_string()))
            }
        }
    }
}

/// 空串 = 未设置路径；非空必须是绝对路径。
fn validate_optional_path(raw: Option<String>, field: &str) -> AppResult<String> {
    let raw = raw.unwrap_or_default();
    let raw = raw.trim().to_string();
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.chars().count() > MAX_PATH_CHARS || raw.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(format!("{field}非法")));
    }
    let p = normalize_lexical(Path::new(&raw));
    if !p.is_absolute() {
        return Err(AppError::Validation(format!("{field}必须是绝对路径")));
    }
    Ok(p.to_string_lossy().into_owned())
}

fn project_kind_status(conn: &Connection, project_id: &str) -> AppResult<(String, String)> {
    conn.query_row(
        "SELECT kind, status FROM workspace_projects WHERE id = ?1",
        params![project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))
}

/// 游戏项目统一门禁：`kind = game`；`require_active` 为 true 时还要求 `status = active`
/// （写入）。读取允许归档项目，保证归档后资源与记录仍可查看。
fn ensure_game_project(
    conn: &Connection,
    project_id: &str,
    require_active: bool,
) -> AppResult<()> {
    let (kind, status) = project_kind_status(conn, project_id)?;
    if kind != "game" {
        return Err(AppError::Validation("该操作仅对游戏项目开放".to_string()));
    }
    if require_active && status != "active" {
        return Err(AppError::Validation(
            "项目已归档，游戏资源与构建记录只读；恢复为进行中后才能修改".to_string(),
        ));
    }
    Ok(())
}

/// 弱引用事项必须属于同一项目（防跨项目绑定）；事项不存在时拒绝。
fn ensure_item_belongs(
    conn: &Connection,
    project_id: &str,
    item_id: Option<&str>,
) -> AppResult<()> {
    let Some(item_id) = item_id else {
        return Ok(());
    };
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM workspace_items WHERE id = ?1",
            params![item_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("关联事项不属于当前项目".into())),
        None => Err(AppError::NotFound(format!("关联事项不存在: {item_id}"))),
    }
}

fn ensure_build_belongs(
    conn: &Connection,
    project_id: &str,
    build_id: Option<&str>,
) -> AppResult<()> {
    let Some(build_id) = build_id else {
        return Ok(());
    };
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM game_builds WHERE id = ?1",
            params![build_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("关联构建不属于当前项目".into())),
        None => Err(AppError::NotFound(format!("关联构建不存在: {build_id}"))),
    }
}

// ── 文件特征识别（只读扫描，不执行任何外部命令）─────────────────────────

fn has_dir(root: &Path, name: &str) -> bool {
    root.join(name).is_dir()
}

fn has_file(root: &Path, rel: &str) -> bool {
    root.join(rel).is_file()
}

/// 从 Unity `ProjectSettings/ProjectVersion.txt` 解析编辑器版本号。
fn unity_version(project_version: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(project_version) else {
        return String::new();
    };
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("m_EditorVersion:") {
            let v = rest.trim().to_string();
            if !v.is_empty() {
                return v;
            }
        }
    }
    String::new()
}

fn first_uproject(root: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.path().is_file() && name.ends_with(".uproject") {
            return Some(entry.path());
        }
    }
    None
}

fn dir_has_entry(root: &Path) -> bool {
    std::fs::read_dir(root)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
}

/// 按真实文件特征识别引擎；目录名不作为证据。
fn detect_engine(root: &Path) -> (String, String, Vec<String>) {
    if !root.is_dir() {
        return ("unknown".into(), String::new(), Vec::new());
    }

    // Unity：ProjectSettings/ProjectVersion.txt 为权威特征。
    let unity_pv = root.join("ProjectSettings").join("ProjectVersion.txt");
    if unity_pv.is_file() {
        let mut evidence = vec!["ProjectSettings/ProjectVersion.txt".to_string()];
        if has_dir(root, "Assets") {
            evidence.push("Assets/".to_string());
        }
        if has_file(root, "Packages/manifest.json") {
            evidence.push("Packages/manifest.json".to_string());
        }
        let version = unity_version(&unity_pv);
        return ("unity".into(), version, evidence);
    }

    // Unreal：根目录存在 *.uproject。
    if let Some(uproject) = first_uproject(root) {
        let mut evidence = vec![uproject
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "*.uproject".into())];
        if has_dir(root, "Content") {
            evidence.push("Content/".to_string());
        }
        if has_file(root, "Config/DefaultEngine.ini") {
            evidence.push("Config/DefaultEngine.ini".to_string());
        }
        return ("unreal".into(), String::new(), evidence);
    }

    // Godot：project.godot 为权威特征。
    if has_file(root, "project.godot") {
        let mut evidence = vec!["project.godot".to_string()];
        if has_dir(root, ".godot") {
            evidence.push(".godot/".to_string());
        }
        return ("godot".into(), String::new(), evidence);
    }

    // 目录存在且有内容但无引擎特征 → 普通自定义游戏项目；空目录 → 未知。
    if dir_has_entry(root) {
        ("custom".into(), String::new(), Vec::new())
    } else {
        ("unknown".into(), String::new(), Vec::new())
    }
}

// ── 路径与元数据 ──────────────────────────────────────────────────────

fn path_exists(path: &str) -> bool {
    !path.is_empty() && Path::new(path).exists()
}

/// 计算与项目根目录的相对关系：根内给相对路径（`/` 分隔），根外标注 `outside`。
fn rel_and_location(root: Option<&Path>, abs: &Path) -> (String, String) {
    let Some(root) = root.filter(|r| r.is_dir()) else {
        return (String::new(), "outside".into());
    };
    let abs_n = normalize_lexical(abs);
    let root_n = normalize_lexical(root);
    match abs_n.strip_prefix(&root_n) {
        Ok(rel) if rel.as_os_str().is_empty() => (String::new(), "inside".into()),
        Ok(rel) => {
            let rel_str = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            (rel_str, "inside".into())
        }
        Err(_) => (String::new(), "outside".into()),
    }
}

fn metadata_of(path: &Path) -> (i64, String) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (0, String::new());
    };
    let size = meta.len() as i64;
    let modified = meta
        .modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_default();
    (size, modified)
}

fn project_root(conn: &Connection, project_id: &str) -> AppResult<Option<PathBuf>> {
    let root: String = conn
        .query_row(
            "SELECT root_path FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))?;
    if root.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(root)))
    }
}

// ── 引擎识别事实 ────────────────────────────────────────────────────────

fn row_to_fact(row: &rusqlite::Row<'_>) -> rusqlite::Result<GameProjectFact> {
    Ok(GameProjectFact {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        engine: row.get("engine")?,
        detection_method: row.get("detection_method")?,
        engine_version: row.get("engine_version")?,
        evidence: row.get("evidence")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn fact_get_impl(db: &Db, project_id: &str) -> AppResult<Option<GameProjectFact>> {
    db.with_read(|conn| {
        ensure_game_project(conn, project_id, false)?;
        let fact = conn
            .query_row(
                "SELECT id, project_id, engine, detection_method, engine_version, evidence,
                        created_at, updated_at
                 FROM game_project_facts WHERE project_id = ?1",
                params![project_id],
                row_to_fact,
            )
            .optional()?;
        Ok(fact)
    })
}

/// 只读扫描项目根目录的真实文件特征；不写库。归档项目也允许扫描查看。
pub fn game_project_detect_impl(db: &Db, project_id: &str) -> AppResult<GameDetection> {
    db.with_read(|conn| {
        ensure_game_project(conn, project_id, false)?;
        let root = project_root(conn, project_id)?;
        let root_path = root
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let root_exists = root.as_ref().map(|p| p.is_dir()).unwrap_or(false);
        let (engine, engine_version, evidence) = match &root {
            Some(root) => detect_engine(root),
            None => ("unknown".into(), String::new(), Vec::new()),
        };
        let facts = fact_get_impl(db, project_id)?;
        Ok(GameDetection {
            detection: GameDetectionReport {
                engine,
                engine_version,
                evidence,
                root_exists,
                root_path,
            },
            facts,
        })
    })
}

/// 持久化引擎识别事实：自动扫描确认或用户手动指定都走这里；UPSERT 按项目唯一。
pub fn game_project_facts_save_impl(
    db: &Db,
    project_id: String,
    engine: String,
    detection_method: String,
    evidence: Option<String>,
    engine_version: Option<String>,
) -> AppResult<GameProjectFact> {
    let project_id = project_id.trim().to_string();
    let engine = validate_enum(&engine, "引擎类型", ENGINES)?;
    let detection_method = validate_enum(&detection_method, "识别方式", DETECTION_METHODS)?;
    let engine_version = validate_text(
        &engine_version.unwrap_or_default(),
        "引擎版本",
        MAX_TEXT_CHARS,
        true,
    )?;
    let evidence = validate_text(
        &evidence.unwrap_or_default(),
        "识别证据",
        MAX_EVIDENCE_CHARS,
        true,
    )?;

    let saved_id = db.with_conn(|conn| {
        ensure_game_project(conn, &project_id, true)?;
        let now = now_iso();
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM game_project_facts WHERE project_id = ?1",
                params![project_id],
                |r| r.get(0),
            )
            .optional()?;
        match existing {
            Some(id) => {
                conn.execute(
                    "UPDATE game_project_facts
                     SET engine = ?1, detection_method = ?2, engine_version = ?3,
                         evidence = ?4, updated_at = ?5
                     WHERE id = ?6",
                    params![engine, detection_method, engine_version, evidence, now, id],
                )?;
                Ok::<String, AppError>(id)
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO game_project_facts
                     (id, project_id, engine, detection_method, engine_version, evidence,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![id, project_id, engine, detection_method, engine_version, evidence, now],
                )?;
                Ok(id)
            }
        }
    })?;

    db.with_read(|conn| {
        conn.query_row(
            "SELECT id, project_id, engine, detection_method, engine_version, evidence,
                    created_at, updated_at
             FROM game_project_facts WHERE id = ?1",
            params![saved_id],
            row_to_fact,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("引擎事实不存在: {saved_id}")))
    })
}

pub fn game_project_facts_get_impl(db: &Db, project_id: &str) -> AppResult<GameFactGot> {
    Ok(GameFactGot {
        facts: fact_get_impl(db, project_id)?,
    })
}

// ── 游戏资源 ───────────────────────────────────────────────────────────

fn row_to_asset(row: &rusqlite::Row<'_>, root: Option<&Path>) -> rusqlite::Result<GameAsset> {
    let path: String = row.get("path")?;
    let path_exists = Path::new(&path).exists();
    // 相对关系按当前根目录重新计算（根目录可能被修改）。
    let (relative_path, location) = match Path::new(&path).canonicalize() {
        Ok(abs) => rel_and_location(root, &abs),
        Err(_) => rel_and_location(root, Path::new(&path)),
    };
    Ok(GameAsset {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        kind: row.get("kind")?,
        name: row.get("name")?,
        path,
        relative_path,
        location,
        size_bytes: row.get("size_bytes")?,
        modified_at: row.get("modified_at")?,
        item_id: row.get("item_id")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        path_exists,
    })
}

pub fn game_asset_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<GameAsset>> {
    db.with_read(|conn| {
        ensure_game_project(conn, project_id, false)?;
        let root = project_root(conn, project_id)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, name, path, relative_path, location, size_bytes,
                    modified_at, item_id, note, created_at, updated_at
             FROM game_assets
             WHERE project_id = ?1
             ORDER BY created_at, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], |r| {
            row_to_asset(r, root.as_deref())
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn game_asset_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    kind: String,
    name: String,
    path: String,
    item_id: Option<String>,
    note: Option<String>,
) -> AppResult<GameAsset> {
    let project_id = project_id.trim().to_string();
    let kind = validate_enum(&kind, "资源类型", ASSET_KINDS)?;
    let name = validate_text(&name, "资源名称", MAX_NAME_CHARS, false)?;
    let path = validate_optional_path(Some(path), "资源路径")?;
    if path.is_empty() {
        return Err(AppError::Validation("资源路径不能为空".into()));
    }
    let item_id = normalize_optional_id(item_id, "关联事项")?;
    let note = validate_text(&note.unwrap_or_default(), "备注", MAX_NOTE_CHARS, true)?;

    let saved_id = db.with_conn(|conn| {
        ensure_game_project(conn, &project_id, true)?;
        ensure_item_belongs(conn, &project_id, item_id.as_deref())?;
        let root = project_root(conn, &project_id)?;
        let abs = normalize_lexical(Path::new(&path));
        let (relative_path, location) = rel_and_location(root.as_deref(), &abs);
        let (size_bytes, modified_at) = metadata_of(&abs);
        let now = now_iso();

        let id = id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match id {
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO game_assets
                     (id, project_id, kind, name, path, relative_path, location, size_bytes,
                      modified_at, item_id, note, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                    params![
                        id, project_id, kind, name, abs.to_string_lossy(), relative_path, location,
                        size_bytes, modified_at, item_id, note, now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM game_assets WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(existing_project) = existing else {
                    return Err(AppError::NotFound(format!("资源不存在: {id}")));
                };
                if existing_project != project_id {
                    return Err(AppError::Validation("资源所属项目不可变更".into()));
                }
                conn.execute(
                    "UPDATE game_assets
                     SET kind = ?1, name = ?2, path = ?3, relative_path = ?4, location = ?5,
                         size_bytes = ?6, modified_at = ?7, item_id = ?8, note = ?9,
                         updated_at = ?10
                     WHERE id = ?11",
                    params![
                        kind, name, abs.to_string_lossy(), relative_path, location, size_bytes,
                        modified_at, item_id, note, now, id
                    ],
                )?;
                Ok(id)
            }
        }
    })?;

    db.with_read(|conn| {
        let root = project_root(conn, &project_id)?;
        conn.query_row(
            "SELECT id, project_id, kind, name, path, relative_path, location, size_bytes,
                    modified_at, item_id, note, created_at, updated_at
             FROM game_assets WHERE id = ?1",
            params![saved_id],
            |r| row_to_asset(r, root.as_deref()),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("资源不存在: {saved_id}")))
    })
}

pub fn game_asset_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id: Option<String> = conn
            .query_row(
                "SELECT project_id FROM game_assets WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(project_id) = project_id else {
            return Err(AppError::NotFound(format!("资源不存在: {id}")));
        };
        ensure_game_project(conn, &project_id, true)?;
        // 只删除登记关联，绝不删除/移动/重命名外部原文件。
        conn.execute("DELETE FROM game_assets WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── 构建记录 ────────────────────────────────────────────────────────────

fn row_to_build(row: &rusqlite::Row<'_>) -> rusqlite::Result<GameBuild> {
    let log_path: String = row.get("log_path")?;
    let artifact_path: String = row.get("artifact_path")?;
    let log_exists = path_exists(&log_path);
    let artifact_exists = path_exists(&artifact_path);
    Ok(GameBuild {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        target: row.get("target")?,
        engine: row.get("engine")?,
        config: row.get("config")?,
        status: row.get("status")?,
        built_at: row.get("built_at")?,
        log_path,
        log_summary: row.get("log_summary")?,
        artifact_path,
        source: row.get("source")?,
        item_id: row.get("item_id")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        log_exists,
        artifact_exists,
    })
}

pub fn game_build_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<GameBuild>> {
    db.with_read(|conn| {
        ensure_game_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, target, engine, config, status, built_at, log_path,
                    log_summary, artifact_path, source, item_id, note, created_at, updated_at
             FROM game_builds
             WHERE project_id = ?1
             ORDER BY built_at DESC, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], row_to_build)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn game_build_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    target: String,
    engine: Option<String>,
    config: Option<String>,
    status: String,
    built_at: Option<String>,
    log_path: Option<String>,
    log_summary: Option<String>,
    artifact_path: Option<String>,
    item_id: Option<String>,
    note: Option<String>,
) -> AppResult<GameBuild> {
    let project_id = project_id.trim().to_string();
    let target = validate_text(&target, "构建目标", MAX_TEXT_CHARS, false)?;
    let engine = validate_text(&engine.unwrap_or_default(), "引擎", MAX_TEXT_CHARS, true)?;
    let config = validate_text(&config.unwrap_or_default(), "构建配置", MAX_TEXT_CHARS, true)?;
    let status = validate_enum(&status, "构建状态", BUILD_STATUSES)?;
    let log_path = validate_optional_path(log_path, "日志路径")?;
    let artifact_path = validate_optional_path(artifact_path, "产物路径")?;
    let log_summary = validate_text(
        &log_summary.unwrap_or_default(),
        "日志摘要",
        MAX_NOTE_CHARS,
        true,
    )?;
    let item_id = normalize_optional_id(item_id, "关联事项")?;
    let note = validate_text(&note.unwrap_or_default(), "备注", MAX_NOTE_CHARS, true)?;
    let built_at = match built_at.map(|s| s.trim().to_string()) {
        Some(s) if !s.is_empty() => s,
        _ => now_iso(),
    };
    if built_at.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation("构建时间含非法控制字符".into()));
    }

    let saved_id = db.with_conn(|conn| {
        ensure_game_project(conn, &project_id, true)?;
        ensure_item_belongs(conn, &project_id, item_id.as_deref())?;
        let now = now_iso();
        let source = "manual"; // 本轮只做手动登记，不接入引擎执行器。

        let id = id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match id {
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO game_builds
                     (id, project_id, target, engine, config, status, built_at, log_path,
                      log_summary, artifact_path, source, item_id, note, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
                    params![
                        id, project_id, target, engine, config, status, built_at, log_path,
                        log_summary, artifact_path, source, item_id, note, now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM game_builds WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(existing_project) = existing else {
                    return Err(AppError::NotFound(format!("构建记录不存在: {id}")));
                };
                if existing_project != project_id {
                    return Err(AppError::Validation("构建记录所属项目不可变更".into()));
                }
                conn.execute(
                    "UPDATE game_builds
                     SET target = ?1, engine = ?2, config = ?3, status = ?4, built_at = ?5,
                         log_path = ?6, log_summary = ?7, artifact_path = ?8, item_id = ?9,
                         note = ?10, updated_at = ?11
                     WHERE id = ?12",
                    params![
                        target, engine, config, status, built_at, log_path, log_summary,
                        artifact_path, item_id, note, now, id
                    ],
                )?;
                Ok(id)
            }
        }
    })?;

    db.with_read(|conn| {
        conn.query_row(
            "SELECT id, project_id, target, engine, config, status, built_at, log_path,
                    log_summary, artifact_path, source, item_id, note, created_at, updated_at
             FROM game_builds WHERE id = ?1",
            params![saved_id],
            row_to_build,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("构建记录不存在: {saved_id}")))
    })
}

pub fn game_build_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id: Option<String> = conn
            .query_row(
                "SELECT project_id FROM game_builds WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(project_id) = project_id else {
            return Err(AppError::NotFound(format!("构建记录不存在: {id}")));
        };
        ensure_game_project(conn, &project_id, true)?;
        conn.execute("DELETE FROM game_builds WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── 测试记录 ──────────────────────────────────────────────────────────

fn row_to_test(row: &rusqlite::Row<'_>) -> rusqlite::Result<GameTestRecord> {
    Ok(GameTestRecord {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        build_id: row.get("build_id")?,
        title: row.get("title")?,
        scope: row.get("scope")?,
        result: row.get("result")?,
        tested_at: row.get("tested_at")?,
        summary: row.get("summary")?,
        defect_count: row.get("defect_count")?,
        item_id: row.get("item_id")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn game_test_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<GameTestRecord>> {
    db.with_read(|conn| {
        ensure_game_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, build_id, title, scope, result, tested_at, summary,
                    defect_count, item_id, note, created_at, updated_at
             FROM game_tests
             WHERE project_id = ?1
             ORDER BY tested_at DESC, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], row_to_test)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn game_test_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    build_id: Option<String>,
    title: String,
    scope: Option<String>,
    result: String,
    tested_at: Option<String>,
    summary: Option<String>,
    defect_count: Option<i64>,
    item_id: Option<String>,
    note: Option<String>,
) -> AppResult<GameTestRecord> {
    let project_id = project_id.trim().to_string();
    let build_id = normalize_optional_id(build_id, "关联构建")?;
    let title = validate_text(&title, "测试标题", MAX_NAME_CHARS, false)?;
    let scope = validate_text(&scope.unwrap_or_default(), "测试范围", MAX_TEXT_CHARS, true)?;
    let result = validate_enum(&result, "测试结果", TEST_RESULTS)?;
    let summary = validate_text(&summary.unwrap_or_default(), "测试摘要", MAX_NOTE_CHARS, true)?;
    let item_id = normalize_optional_id(item_id, "关联事项")?;
    let note = validate_text(&note.unwrap_or_default(), "备注", MAX_NOTE_CHARS, true)?;
    let defect_count = defect_count.unwrap_or(0).clamp(0, 100_000);
    let tested_at = match tested_at.map(|s| s.trim().to_string()) {
        Some(s) if !s.is_empty() => s,
        _ => now_iso(),
    };
    if tested_at.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation("测试时间含非法控制字符".into()));
    }

    let saved_id = db.with_conn(|conn| {
        ensure_game_project(conn, &project_id, true)?;
        ensure_build_belongs(conn, &project_id, build_id.as_deref())?;
        ensure_item_belongs(conn, &project_id, item_id.as_deref())?;
        let now = now_iso();

        let id = id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match id {
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO game_tests
                     (id, project_id, build_id, title, scope, result, tested_at, summary,
                      defect_count, item_id, note, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                    params![
                        id, project_id, build_id, title, scope, result, tested_at, summary,
                        defect_count, item_id, note, now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM game_tests WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(existing_project) = existing else {
                    return Err(AppError::NotFound(format!("测试记录不存在: {id}")));
                };
                if existing_project != project_id {
                    return Err(AppError::Validation("测试记录所属项目不可变更".into()));
                }
                conn.execute(
                    "UPDATE game_tests
                     SET build_id = ?1, title = ?2, scope = ?3, result = ?4, tested_at = ?5,
                         summary = ?6, defect_count = ?7, item_id = ?8, note = ?9,
                         updated_at = ?10
                     WHERE id = ?11",
                    params![
                        build_id, title, scope, result, tested_at, summary, defect_count, item_id,
                        note, now, id
                    ],
                )?;
                Ok(id)
            }
        }
    })?;

    db.with_read(|conn| {
        conn.query_row(
            "SELECT id, project_id, build_id, title, scope, result, tested_at, summary,
                    defect_count, item_id, note, created_at, updated_at
             FROM game_tests WHERE id = ?1",
            params![saved_id],
            row_to_test,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("测试记录不存在: {saved_id}")))
    })
}

pub fn game_test_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id: Option<String> = conn
            .query_row(
                "SELECT project_id FROM game_tests WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(project_id) = project_id else {
            return Err(AppError::NotFound(format!("测试记录不存在: {id}")));
        };
        ensure_game_project(conn, &project_id, true)?;
        conn.execute("DELETE FROM game_tests WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── 薄 Tauri 命令（注册进 lib.rs 由集成负责人完成）─────────────────────

#[tauri::command]
pub fn game_project_detect(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<GameDetection> {
    game_project_detect_impl(&db, &project_id)
}

#[tauri::command]
pub fn game_project_facts_get(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<GameFactGot> {
    game_project_facts_get_impl(&db, &project_id)
}

#[tauri::command]
pub fn game_project_facts_save(
    db: State<'_, Arc<Db>>,
    project_id: String,
    engine: String,
    detection_method: String,
    evidence: Option<String>,
    engine_version: Option<String>,
) -> AppResult<GameFactSaved> {
    Ok(GameFactSaved {
        facts: game_project_facts_save_impl(
            &db,
            project_id,
            engine,
            detection_method,
            evidence,
            engine_version,
        )?,
    })
}

#[tauri::command]
pub fn game_asset_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<GameAssetList> {
    Ok(GameAssetList {
        assets: game_asset_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn game_asset_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    kind: String,
    name: String,
    path: String,
    item_id: Option<String>,
    note: Option<String>,
) -> AppResult<GameAssetSaved> {
    Ok(GameAssetSaved {
        asset: game_asset_save_impl(
            &db, id, project_id, kind, name, path, item_id, note,
        )?,
    })
}

#[tauri::command]
pub fn game_asset_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<GameOk> {
    game_asset_delete_impl(&db, &id)?;
    Ok(GameOk { ok: true })
}

#[tauri::command]
pub fn game_build_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<GameBuildList> {
    Ok(GameBuildList {
        builds: game_build_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn game_build_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    target: String,
    engine: Option<String>,
    config: Option<String>,
    status: String,
    built_at: Option<String>,
    log_path: Option<String>,
    log_summary: Option<String>,
    artifact_path: Option<String>,
    item_id: Option<String>,
    note: Option<String>,
) -> AppResult<GameBuildSaved> {
    Ok(GameBuildSaved {
        build: game_build_save_impl(
            &db,
            id,
            project_id,
            target,
            engine,
            config,
            status,
            built_at,
            log_path,
            log_summary,
            artifact_path,
            item_id,
            note,
        )?,
    })
}

#[tauri::command]
pub fn game_build_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<GameOk> {
    game_build_delete_impl(&db, &id)?;
    Ok(GameOk { ok: true })
}

#[tauri::command]
pub fn game_test_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<GameTestList> {
    Ok(GameTestList {
        tests: game_test_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn game_test_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    build_id: Option<String>,
    title: String,
    scope: Option<String>,
    result: String,
    tested_at: Option<String>,
    summary: Option<String>,
    defect_count: Option<i64>,
    item_id: Option<String>,
    note: Option<String>,
) -> AppResult<GameTestSaved> {
    Ok(GameTestSaved {
        test: game_test_save_impl(
            &db,
            id,
            project_id,
            build_id,
            title,
            scope,
            result,
            tested_at,
            summary,
            defect_count,
            item_id,
            note,
        )?,
    })
}

#[tauri::command]
pub fn game_test_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<GameOk> {
    game_test_delete_impl(&db, &id)?;
    Ok(GameOk { ok: true })
}

// ── 自测 ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::backup::{read_bundle, write_bundle, BackupKind, BackupSources};
    use crate::commands::data::{import_parsed_with, validate_bundle, ImportOptions};
    use crate::commands::project_workspace::{
        workspace_item_save_impl, workspace_project_delete_impl,
        workspace_project_save_impl, workspace_project_set_status_impl,
    };

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-game-g1-{}-{}",
            tag,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn make_game_project(
        db: &Db,
        name: &str,
        root: Option<&Path>,
    ) -> crate::commands::project_workspace::WorkspaceProject {
        workspace_project_save_impl(
            db,
            None,
            name.to_string(),
            "game".to_string(),
            root.map(|p| p.to_string_lossy().into_owned()),
            None,
            None,
        )
        .expect("创建游戏项目")
    }

    /// 构造最小但结构真实的 Unity / Godot / 自定义 / 空目录 fixtures。
    fn write_fixture(dir: &Path, kind: &str) {
        match kind {
            "unity" => {
                std::fs::create_dir_all(dir.join("ProjectSettings")).unwrap();
                std::fs::create_dir_all(dir.join("Assets")).unwrap();
                std::fs::create_dir_all(dir.join("Packages")).unwrap();
                std::fs::write(
                    dir.join("ProjectSettings").join("ProjectVersion.txt"),
                    "m_EditorVersion: 2022.3.10f1\n",
                )
                .unwrap();
                std::fs::write(dir.join("Packages").join("manifest.json"), "{}").unwrap();
            }
            "godot" => {
                std::fs::create_dir_all(dir.join(".godot")).unwrap();
                std::fs::write(
                    dir.join("project.godot"),
                    "[application]\nconfig_version=5\n",
                )
                .unwrap();
            }
            "unreal" => {
                std::fs::create_dir_all(dir.join("Content")).unwrap();
                std::fs::create_dir_all(dir.join("Config")).unwrap();
                std::fs::write(dir.join("MyGame.uproject"), "{}").unwrap();
                std::fs::write(dir.join("Config").join("DefaultEngine.ini"), "[]").unwrap();
            }
            "custom" => {
                std::fs::write(dir.join("README.txt"), "自定义游戏工程").unwrap();
            }
            _ => {}
        }
    }

    #[test]
    fn detect_recognizes_unity_unreal_godot_custom_unknown_by_real_features() {
        let db = memdb();
        let unity = temp_dir("unity");
        let unreal = temp_dir("unreal");
        let godot = temp_dir("godot");
        let custom = temp_dir("custom");
        let empty = temp_dir("empty");
        write_fixture(&unity, "unity");
        write_fixture(&unreal, "unreal");
        write_fixture(&godot, "godot");
        write_fixture(&custom, "custom");

        let project = make_game_project(&db, "识别项目", Some(&unity));
        let report = game_project_detect_impl(&db, &project.id).unwrap();
        assert_eq!(report.detection.engine, "unity");
        assert_eq!(report.detection.engine_version, "2022.3.10f1");
        assert!(report
            .detection
            .evidence
            .iter()
            .any(|e| e == "ProjectSettings/ProjectVersion.txt"));
        assert!(report.detection.root_exists);

        // 换成 unreal 根目录再扫。
        workspace_project_save_impl(
            &db,
            Some(project.id.clone()),
            "识别项目".into(),
            "game".into(),
            Some(unreal.to_string_lossy().into_owned()),
            None,
            None,
        )
        .unwrap();
        let report = game_project_detect_impl(&db, &project.id).unwrap();
        assert_eq!(report.detection.engine, "unreal");
        assert!(report.detection.evidence.iter().any(|e| e.ends_with(".uproject")));

        workspace_project_save_impl(
            &db,
            Some(project.id.clone()),
            "识别项目".into(),
            "game".into(),
            Some(godot.to_string_lossy().into_owned()),
            None,
            None,
        )
        .unwrap();
        let report = game_project_detect_impl(&db, &project.id).unwrap();
        assert_eq!(report.detection.engine, "godot");

        workspace_project_save_impl(
            &db,
            Some(project.id.clone()),
            "识别项目".into(),
            "game".into(),
            Some(custom.to_string_lossy().into_owned()),
            None,
            None,
        )
        .unwrap();
        let report = game_project_detect_impl(&db, &project.id).unwrap();
        assert_eq!(report.detection.engine, "custom");

        workspace_project_save_impl(
            &db,
            Some(project.id.clone()),
            "识别项目".into(),
            "game".into(),
            Some(empty.to_string_lossy().into_owned()),
            None,
            None,
        )
        .unwrap();
        let report = game_project_detect_impl(&db, &project.id).unwrap();
        assert_eq!(report.detection.engine, "unknown");

        // 根目录不存在：未知，不猜测。
        let missing = temp_dir("missing").join("gone");
        workspace_project_save_impl(
            &db,
            Some(project.id.clone()),
            "识别项目".into(),
            "game".into(),
            Some(missing.to_string_lossy().into_owned()),
            None,
            None,
        )
        .unwrap();
        let report = game_project_detect_impl(&db, &project.id).unwrap();
        assert_eq!(report.detection.engine, "unknown");
        assert!(!report.detection.root_exists);

        std::fs::remove_dir_all(unity).ok();
        std::fs::remove_dir_all(unreal).ok();
        std::fs::remove_dir_all(godot).ok();
        std::fs::remove_dir_all(custom).ok();
        std::fs::remove_dir_all(empty).ok();
    }

    #[test]
    fn facts_persist_auto_and_manual_with_evidence() {
        let db = memdb();
        let project = make_game_project(&db, "事实项目", None);

        let saved = game_project_facts_save_impl(
            &db,
            project.id.clone(),
            "godot".into(),
            "manual".into(),
            Some("project.godot".into()),
            Some("4.3".into()),
        )
        .unwrap();
        assert_eq!(saved.engine, "godot");
        assert_eq!(saved.detection_method, "manual");

        let got = game_project_facts_get_impl(&db, &project.id)
            .unwrap()
            .facts
            .unwrap();
        assert_eq!(got.engine_version, "4.3");
        assert_eq!(got.evidence, "project.godot");

        // 非法引擎枚举必须拒绝。
        assert!(game_project_facts_save_impl(
            &db,
            project.id.clone(),
            "dos".into(),
            "auto".into(),
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn assets_builds_tests_crud_and_project_isolation() {
        let db = memdb();
        let dir_a = temp_dir("proj-a");
        let dir_b = temp_dir("proj-b");
        let project_a = make_game_project(&db, "项目A", Some(&dir_a));
        let project_b = make_game_project(&db, "项目B", Some(&dir_b));

        let item_a = workspace_item_save_impl(
            &db,
            None,
            project_a.id.clone(),
            None,
            "关卡设计".into(),
            Some("level".into()),
            Some("doing".into()),
            None,
            None,
        )
        .unwrap();

        // 项目 A 登记一个根内资源。
        let tex = dir_a.join("player.png");
        std::fs::write(&tex, [1, 2, 3]).unwrap();
        let asset = game_asset_save_impl(
            &db,
            None,
            project_a.id.clone(),
            "image".into(),
            "玩家贴图".into(),
            tex.to_string_lossy().into_owned(),
            Some(item_a.id.clone()),
            None,
        )
        .unwrap();
        assert_eq!(asset.location, "inside");
        assert_eq!(asset.relative_path, "player.png");
        assert!(asset.path_exists);
        assert!(asset.size_bytes > 0);

        // 项目 B 看不到 A 的资源。
        let b_assets = game_asset_list_impl(&db, &project_b.id).unwrap();
        assert!(b_assets.is_empty());
        let a_assets = game_asset_list_impl(&db, &project_a.id).unwrap();
        assert_eq!(a_assets.len(), 1);

        // 跨项目绑定事项必须拒绝。
        let item_b = workspace_item_save_impl(
            &db,
            None,
            project_b.id.clone(),
            None,
            "B 事项".into(),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(game_asset_save_impl(
            &db,
            None,
            project_a.id.clone(),
            "image".into(),
            "越界".into(),
            dir_a.join("x.png").to_string_lossy().into_owned(),
            Some(item_b.id.clone()),
            None,
        )
        .is_err());

        // 构建 + 测试记录。
        let build = game_build_save_impl(
            &db,
            None,
            project_a.id.clone(),
            "Windows".into(),
            Some("Godot".into()),
            Some("Release".into()),
            "success".into(),
            None,
            None,
            Some("编译通过".into()),
            None,
            Some(item_a.id.clone()),
            None,
        )
        .unwrap();
        assert_eq!(build.source, "manual");
        assert_eq!(build.status, "success");

        let test = game_test_save_impl(
            &db,
            None,
            project_a.id.clone(),
            Some(build.id.clone()),
            "主流程回归".into(),
            Some("关卡进入".into()),
            "passed".into(),
            None,
            Some("3 项通过".into()),
            Some(0),
            Some(item_a.id.clone()),
            None,
        )
        .unwrap();
        assert_eq!(test.build_id, Some(build.id.clone()));

        assert_eq!(game_build_list_impl(&db, &project_b.id).unwrap().len(), 0);
        assert_eq!(game_test_list_impl(&db, &project_b.id).unwrap().len(), 0);
        assert_eq!(game_build_list_impl(&db, &project_a.id).unwrap().len(), 1);
        assert_eq!(game_test_list_impl(&db, &project_a.id).unwrap().len(), 1);

        // 更新构建状态。
        let updated = game_build_save_impl(
            &db,
            Some(build.id.clone()),
            project_a.id.clone(),
            "Windows".into(),
            None,
            None,
            "failed".into(),
            None,
            None,
            Some("报错".into()),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(updated.status, "failed");

        std::fs::remove_dir_all(dir_a).ok();
        std::fs::remove_dir_all(dir_b).ok();
    }

    #[test]
    fn missing_path_reports_lost_and_delete_does_not_touch_source_file() {
        let db = memdb();
        let dir = temp_dir("lost");
        let project = make_game_project(&db, "失效项目", Some(&dir));

        // 登记一个尚未存在的路径（计划中的资源）。
        let asset = game_asset_save_impl(
            &db,
            None,
            project.id.clone(),
            "model".into(),
            "待导入模型".into(),
            dir.join("pending.glb").to_string_lossy().into_owned(),
            None,
            None,
        )
        .unwrap();
        assert!(!asset.path_exists);

        // 真实文件登记后删除关联：原文件必须保留。
        let real = dir.join("scene.tscn");
        std::fs::write(&real, "scene").unwrap();
        let real_asset = game_asset_save_impl(
            &db,
            None,
            project.id.clone(),
            "scene".into(),
            "场景".into(),
            real.to_string_lossy().into_owned(),
            None,
            None,
        )
        .unwrap();
        assert!(real_asset.path_exists);
        game_asset_delete_impl(&db, &real_asset.id).unwrap();
        assert!(real.exists(), "删除资源登记不得删除外部原文件");

        // 根目录之外的路径标注 outside，不复制文件。
        let outside = temp_dir("outside");
        let out_file = outside.join("ref.wav");
        std::fs::write(&out_file, [9]).unwrap();
        let outside_asset = game_asset_save_impl(
            &db,
            None,
            project.id.clone(),
            "audio".into(),
            "外部音频".into(),
            out_file.to_string_lossy().into_owned(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(outside_asset.location, "outside");
        assert!(outside_asset.relative_path.is_empty());

        std::fs::remove_dir_all(dir).ok();
        std::fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn non_game_writes_rejected_and_archived_is_read_only() {
        let db = memdb();
        let novel = workspace_project_save_impl(
            &db,
            None,
            "小说项目".into(),
            "novel".into(),
            None,
            None,
            None,
        )
        .unwrap();

        // 非 game 类型：写入命令必须明确拒绝。
        assert!(game_asset_save_impl(
            &db,
            None,
            novel.id.clone(),
            "image".into(),
            "串线".into(),
            "C:/x.png".into(),
            None,
            None,
        )
        .is_err());
        assert!(game_build_save_impl(
            &db,
            None,
            novel.id.clone(),
            "Win".into(),
            None,
            None,
            "planned".into(),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .is_err());
        assert!(game_test_save_impl(
            &db,
            None,
            novel.id.clone(),
            None,
            "串线测试".into(),
            None,
            "unknown".into(),
            None,
            None,
            None,
            None,
            None,
        )
        .is_err());

        let game = make_game_project(&db, "游戏项目", None);
        // 归档后写入被拒，读取仍可用。
        workspace_project_set_status_impl(&db, &game.id, "archived".into()).unwrap();
        assert!(game_asset_save_impl(
            &db,
            None,
            game.id.clone(),
            "image".into(),
            "归档写入".into(),
            "C:/y.png".into(),
            None,
            None,
        )
        .is_err());
        assert!(game_asset_list_impl(&db, &game.id).unwrap().is_empty());
        assert!(game_build_list_impl(&db, &game.id).unwrap().is_empty());
        assert!(game_test_list_impl(&db, &game.id).unwrap().is_empty());
    }

    #[test]
    fn game_tables_roundtrip_in_full_and_quick_backup() {
        let db = memdb();
        let project = make_game_project(&db, "备份项目", None);
        let item = workspace_item_save_impl(
            &db,
            None,
            project.id.clone(),
            None,
            "核心机制".into(),
            Some("system".into()),
            Some("doing".into()),
            None,
            None,
        )
        .unwrap();

        game_project_facts_save_impl(
            &db,
            project.id.clone(),
            "unity".into(),
            "auto".into(),
            Some("ProjectSettings/ProjectVersion.txt".into()),
            Some("2022.3.10f1".into()),
        )
        .unwrap();
        let asset = game_asset_save_impl(
            &db,
            None,
            project.id.clone(),
            "image".into(),
            "贴图".into(),
            "C:/proj/tex.png".into(),
            Some(item.id.clone()),
            Some("备注".to_string()),
        )
        .unwrap();
        let build = game_build_save_impl(
            &db,
            None,
            project.id.clone(),
            "Android".into(),
            Some("Unity".into()),
            Some("Development".into()),
            "success".into(),
            None,
            None,
            Some("构建成功".into()),
            None,
            Some(item.id.clone()),
            None,
        )
        .unwrap();
        let test = game_test_save_impl(
            &db,
            None,
            project.id.clone(),
            Some(build.id.clone()),
            "冒烟测试".into(),
            Some("启动流程".into()),
            "passed".into(),
            None,
            Some("通过".into()),
            Some(1),
            Some(item.id.clone()),
            None,
        )
        .unwrap();

        for kind in [BackupKind::Full, BackupKind::Quick] {
            let dir = temp_dir("roundtrip");
            let target = dir.join("backup.json");
            write_bundle(&db, BackupSources::default(), &target, kind).unwrap();
            let read = read_bundle(&target, &dir.join("staging")).unwrap();

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

            let restored_facts = game_project_facts_get_impl(&dst, &project.id)
                .unwrap()
                .facts
                .unwrap();
            assert_eq!(restored_facts.engine, "unity", "{kind:?} 引擎事实丢失");
            assert_eq!(restored_facts.engine_version, "2022.3.10f1");

            let restored_assets = game_asset_list_impl(&dst, &project.id).unwrap();
            assert_eq!(restored_assets.len(), 1, "{kind:?} 资源丢失");
            assert_eq!(restored_assets[0].name, "贴图");
            assert_eq!(restored_assets[0].item_id, Some(item.id.clone()));
            assert_eq!(restored_assets[0].note, "备注");

            let restored_builds = game_build_list_impl(&dst, &project.id).unwrap();
            assert_eq!(restored_builds.len(), 1, "{kind:?} 构建记录丢失");
            assert_eq!(restored_builds[0].target, "Android");
            assert_eq!(restored_builds[0].status, "success");

            let restored_tests = game_test_list_impl(&dst, &project.id).unwrap();
            assert_eq!(restored_tests.len(), 1, "{kind:?} 测试记录丢失");
            assert_eq!(restored_tests[0].build_id, Some(build.id.clone()));
            assert_eq!(restored_tests[0].defect_count, 1);
            assert_eq!(restored_tests[0].id, test.id);

            let violations: i64 = dst
                .with_read(|conn| {
                    Ok(conn.query_row(
                        "SELECT COUNT(*) FROM pragma_foreign_key_check",
                        [],
                        |r| r.get(0),
                    )?)
                })
                .unwrap();
            assert_eq!(violations, 0, "{kind:?} 恢复后外键存在违例");
            std::fs::remove_dir_all(dir).ok();
        }

        // 项目删除级联四张表。
        workspace_project_delete_impl(&db, &project.id).unwrap();
        let counts: (i64, i64, i64, i64) = db
            .with_read(|conn| {
                let f: i64 = conn
                    .query_row("SELECT COUNT(*) FROM game_project_facts", [], |r| r.get(0))?;
                let a: i64 = conn
                    .query_row("SELECT COUNT(*) FROM game_assets", [], |r| r.get(0))?;
                let b: i64 = conn
                    .query_row("SELECT COUNT(*) FROM game_builds", [], |r| r.get(0))?;
                let t: i64 = conn
                    .query_row("SELECT COUNT(*) FROM game_tests", [], |r| r.get(0))?;
                Ok((f, a, b, t))
            })
            .unwrap();
        assert_eq!(counts, (0, 0, 0, 0));
        let _ = asset;
    }
}
