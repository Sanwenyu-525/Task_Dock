//! 场景工作区（v0.11，迁移 v38）：用户命名的「一键进入」预设工作环境。
//!
//! 数据边界（与相邻功能严格分离）：
//! - `workspace_snapshots`：某一次真实现场的捕获，恢复即重放当时窗口状态；
//! - `workflows`：有序步骤的执行序列，有运行态与全局单实例约束；
//! - 本模块：静态清单 + 可空现场/工作流软引用，以及 `shelf_items.scene_id` 文件关联。
//!   删除现场或工作流只置空引用，绝不级联删除场景（外键 ON DELETE SET NULL）。
//!
//! 启动一律复用导航层：`targetId` 命中已登记目标时直接 `router::navigate`；只有 exe
//! 路径时经 `target_resolver::save_target` 落一个常规导航目标（按 app_key 去重，与工作
//! 现场恢复的 `ensure_target` 同一口径）。本模块不自己拼 `Command::spawn`，因此校验、
//! 降级与导航日志和其他入口完全一致。
//!
//! 进入顺序固定为：现场 → 应用 → 网址 → 目录 → 工作流。工作流放最后，因为它的步骤
//! 常依赖前面已经打开的应用。现场恢复与工作流各自受全局单实例约束，冲突时如实返回
//! failed 并保留已完成项——本功能绝不假装「全部成功」。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::navigation::router::NavigateOptions;
use crate::navigation::{self, router, target_resolver};
use crate::workflows::{self, engine};
use crate::workspace;

/// 场景数量上限：面板一屏卡片，超过后管理成本高于收益。
pub const MAX_SCENARIOS: usize = 32;
pub const MAX_APPS: usize = 16;
pub const MAX_URLS: usize = 16;
pub const MAX_FOLDERS: usize = 8;
const NAME_MAX_CHARS: usize = 40;
const PATH_MAX_CHARS: usize = 500;

// ── 模型（字段全部 camelCase，与 src/lib/bridge.ts 的 Scenario* 一一对应）──

/// 场景内的应用目标：优先引用已登记导航目标，否则用 exe 路径直启。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScenarioAppTarget {
    pub target_id: Option<String>,
    pub exe_path: Option<String>,
    pub args: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSummary {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub app_count: usize,
    pub url_count: usize,
    pub folder_count: usize,
    pub linked_workflow_id: Option<String>,
    pub last_entered_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 详情 = 摘要字段平铺 + 清单本体（前端 `ScenarioDetail extends ScenarioSummary`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioDetail {
    #[serde(flatten)]
    pub summary: ScenarioSummary,
    pub apps: Vec<ScenarioAppTarget>,
    pub urls: Vec<String>,
    pub folders: Vec<String>,
    pub snapshot_id: Option<String>,
    pub shelf_item_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScenarioSaveInput {
    pub id: Option<String>,
    pub name: String,
    pub icon: Option<String>,
    pub apps: Vec<ScenarioAppTarget>,
    pub urls: Vec<String>,
    pub folders: Vec<String>,
    pub shelf_item_ids: Vec<String>,
    pub linked_workflow_id: Option<String>,
    pub snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioEnterItemResult {
    /// app | url | folder | snapshot | workflow
    pub kind: String,
    pub label: String,
    /// ok | skipped | failed
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioEnterResult {
    pub items: Vec<ScenarioEnterItemResult>,
    pub started_at: String,
}

impl ScenarioEnterItemResult {
    fn ok(kind: &str, label: String) -> Self {
        Self {
            kind: kind.into(),
            label,
            status: "ok".into(),
            detail: None,
        }
    }
    fn skipped(kind: &str, label: String, detail: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            label,
            status: "skipped".into(),
            detail: Some(detail.into()),
        }
    }
    fn failed(kind: &str, label: String, detail: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            label,
            status: "failed".into(),
            detail: Some(detail.into()),
        }
    }
}

const LIST_SQL: &str = "SELECT id, name, icon, apps_json, urls_json, folders_json, \
     linked_workflow_id, last_entered_at, created_at, updated_at FROM scenarios";

/// JSON 清单只在这里数长度：列表载荷不带正文，避免整表 JSON 进 IPC。
fn json_len(raw: &str) -> usize {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.as_array().map(|a| a.len()))
        .unwrap_or(0)
}

fn summary_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ScenarioSummary> {
    Ok(ScenarioSummary {
        id: r.get(0)?,
        name: r.get(1)?,
        icon: r.get(2)?,
        app_count: json_len(&r.get::<_, String>(3)?),
        url_count: json_len(&r.get::<_, String>(4)?),
        folder_count: json_len(&r.get::<_, String>(5)?),
        linked_workflow_id: r.get(6)?,
        last_entered_at: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}

fn parse_apps(raw: &str) -> Vec<ScenarioAppTarget> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn parse_strings(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn load_detail(conn: &rusqlite::Connection, id: &str) -> AppResult<ScenarioDetail> {
    let found = conn
        .query_row(
            "SELECT id, name, icon, apps_json, urls_json, folders_json, linked_workflow_id, \
                    snapshot_id, last_entered_at, created_at, updated_at \
             FROM scenarios WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    ScenarioSummary {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        icon: r.get(2)?,
                        app_count: json_len(&r.get::<_, String>(3)?),
                        url_count: json_len(&r.get::<_, String>(4)?),
                        folder_count: json_len(&r.get::<_, String>(5)?),
                        linked_workflow_id: r.get(6)?,
                        last_entered_at: r.get(8)?,
                        created_at: r.get(9)?,
                        updated_at: r.get(10)?,
                    },
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()?;
    let (summary, apps_json, urls_json, folders_json, snapshot_id) =
        found.ok_or_else(|| AppError::Validation(format!("场景不存在: {id}")))?;
    let mut shelf_stmt =
        conn.prepare("SELECT id FROM shelf_items WHERE scene_id = ?1 ORDER BY id")?;
    let shelf_rows = shelf_stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
    let shelf_item_ids = shelf_rows.collect::<Result<Vec<_>, _>>()?;
    Ok(ScenarioDetail {
        summary,
        apps: parse_apps(&apps_json),
        urls: parse_strings(&urls_json),
        folders: parse_strings(&folders_json),
        snapshot_id,
        shelf_item_ids,
    })
}

// ── 校验 ─────────────────────────────────────────────────────────────

fn clean_name(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("场景名称不能为空".into()));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation("场景名称包含不可见控制字符".into()));
    }
    Ok(trimmed.chars().take(NAME_MAX_CHARS).collect())
}

/// 图标只作短标记展示，超长一律截断，避免撑破卡片。
fn clean_icon(raw: &Option<String>) -> Option<String> {
    let v = raw
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.chars().any(|c| c.is_control()))?;
    Some(v.chars().take(4).collect())
}

fn check_limit(len: usize, max: usize, what: &str) -> AppResult<()> {
    if len > max {
        return Err(AppError::Validation(format!(
            "{what}数量超限：{len} > {max}"
        )));
    }
    Ok(())
}

/// 清单里的一条路径：非空、无控制字符、有长度上限。
/// 存在性到进入时才判定——离线盘或换机后仍能保存与编辑场景，只在启动时降级为 skipped。
fn clean_path(raw: &str, what: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(format!("{what}不能为空")));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(format!("{what}包含不可见控制字符")));
    }
    if trimmed.chars().count() > PATH_MAX_CHARS {
        return Err(AppError::Validation(format!(
            "{what}过长（上限 {PATH_MAX_CHARS} 字符）"
        )));
    }
    Ok(trimmed.to_string())
}

fn trim_ref(raw: &Option<String>) -> Option<String> {
    raw.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 归一化后的待写入数据（JSON 文本已就绪）。
struct Normalized {
    name: String,
    icon: Option<String>,
    apps_json: String,
    urls_json: String,
    folders_json: String,
    shelf_item_ids: Vec<String>,
    linked_workflow_id: Option<String>,
    snapshot_id: Option<String>,
}

/// 校验并规范化保存载荷：应用条目必须至少有 targetId 或 exePath 之一；
/// URL 走导航层同一套 `validate_url`，杜绝 `file://`、`javascript:` 之类伪装。
fn normalize(input: &ScenarioSaveInput) -> AppResult<Normalized> {
    let name = clean_name(&input.name)?;
    let icon = clean_icon(&input.icon);
    check_limit(input.apps.len(), MAX_APPS, "场景应用")?;
    check_limit(input.urls.len(), MAX_URLS, "场景网址")?;
    check_limit(input.folders.len(), MAX_FOLDERS, "场景目录")?;

    let mut apps: Vec<ScenarioAppTarget> = Vec::with_capacity(input.apps.len());
    for a in &input.apps {
        let target_id = trim_ref(&a.target_id);
        let exe_path = match &a.exe_path {
            Some(raw) if !raw.trim().is_empty() => Some(clean_path(raw, "应用路径")?),
            _ => None,
        };
        if target_id.is_none() && exe_path.is_none() {
            return Err(AppError::Validation(
                "应用条目需要已登记目标或可执行路径之一".into(),
            ));
        }
        apps.push(ScenarioAppTarget {
            target_id,
            exe_path,
            args: a
                .args
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(PATH_MAX_CHARS).collect()),
            display_name: a
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(NAME_MAX_CHARS).collect()),
        });
    }

    let mut urls: Vec<String> = Vec::with_capacity(input.urls.len());
    for u in &input.urls {
        let v = clean_path(u, "网址")?;
        navigation::validate_url(&v)?;
        urls.push(v);
    }

    let mut folders: Vec<String> = Vec::with_capacity(input.folders.len());
    for f in &input.folders {
        folders.push(clean_path(f, "目录")?);
    }

    let mut shelf_item_ids = Vec::with_capacity(input.shelf_item_ids.len());
    let mut seen_shelf_ids = std::collections::HashSet::new();
    for raw_id in &input.shelf_item_ids {
        let item_id = raw_id.trim();
        if item_id.is_empty() {
            return Err(AppError::Validation("暂存条目 ID 不能为空".into()));
        }
        if seen_shelf_ids.insert(item_id.to_string()) {
            shelf_item_ids.push(item_id.to_string());
        }
    }

    Ok(Normalized {
        name,
        icon,
        apps_json: serde_json::to_string(&apps)
            .map_err(|e| AppError::Validation(format!("应用清单序列化失败: {e}")))?,
        urls_json: serde_json::to_string(&urls)
            .map_err(|e| AppError::Validation(format!("网址清单序列化失败: {e}")))?,
        folders_json: serde_json::to_string(&folders)
            .map_err(|e| AppError::Validation(format!("目录清单序列化失败: {e}")))?,
        shelf_item_ids,
        linked_workflow_id: trim_ref(&input.linked_workflow_id),
        snapshot_id: trim_ref(&input.snapshot_id),
    })
}

fn row_exists(conn: &rusqlite::Connection, table: &str, id: &str) -> AppResult<bool> {
    let n: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    Ok(n > 0)
}

/// 软引用完整性：工作流/现场必须真实存在。进入时的 skipped 只用于磁盘或程序消失，
/// 不用来掩盖本库里已被删除的引用。
fn validate_refs(conn: &rusqlite::Connection, n: &Normalized) -> AppResult<()> {
    if let Some(wf) = &n.linked_workflow_id {
        if !row_exists(conn, "workflows", wf)? {
            return Err(AppError::Validation(format!("关联工作流不存在: {wf}")));
        }
    }
    if let Some(sn) = &n.snapshot_id {
        if !row_exists(conn, "workspace_snapshots", sn)? {
            return Err(AppError::Validation(format!("关联工作现场不存在: {sn}")));
        }
    }
    Ok(())
}

fn validate_shelf_refs(
    conn: &rusqlite::Connection,
    scene_id: &str,
    shelf_item_ids: &[String],
) -> AppResult<()> {
    for item_id in shelf_item_ids {
        let item: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT kind, scene_id FROM shelf_items WHERE id = ?1",
                params![item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (kind, owner_scene_id) =
            item.ok_or_else(|| AppError::Validation(format!("暂存条目不存在: {item_id}")))?;
        if kind != "file" && kind != "folder" {
            return Err(AppError::Validation(format!(
                "只有文件和文件夹可以关联场景: {item_id}"
            )));
        }
        if owner_scene_id
            .as_deref()
            .is_some_and(|owner| owner != scene_id)
        {
            return Err(AppError::Validation(format!(
                "暂存条目已关联其他场景: {item_id}"
            )));
        }
    }
    Ok(())
}

// ── CRUD ─────────────────────────────────────────────────────────────

pub fn list(db: &Db) -> AppResult<Vec<ScenarioSummary>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(&format!("{LIST_SQL} ORDER BY updated_at DESC, id DESC"))?;
        let rows = stmt.query_map([], summary_from_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

pub fn get(db: &Db, id: &str) -> AppResult<ScenarioDetail> {
    db.with_read(|conn| load_detail(conn, id))
}

/// 保存：`input.id` 为空即新建，否则整体覆盖清单（清单语义，不做局部补丁）。
/// 新建受 MAX_SCENARIOS 约束；更新保留 created_at。同名为合法用法，不加唯一约束。
pub fn save(db: &Db, input: &ScenarioSaveInput) -> AppResult<String> {
    let n = normalize(input)?;
    let now = now_iso();
    let id = trim_ref(&input.id).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    workflows::validate_scene_graph_for_scene(db, &id, n.linked_workflow_id.as_deref())?;
    let selected_shelf_ids: std::collections::HashSet<&str> =
        n.shelf_item_ids.iter().map(String::as_str).collect();
    db.with_transaction(|tx| {
        validate_refs(tx, &n)?;
        validate_shelf_refs(tx, &id, &n.shelf_item_ids)?;
        let current: Option<String> = tx
            .query_row(
                "SELECT created_at FROM scenarios WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if current.is_none() {
            let total: i64 = tx
                .query_row("SELECT COUNT(*) FROM scenarios", [], |r| r.get(0))
                .optional()?
                .unwrap_or(0);
            if total as usize >= MAX_SCENARIOS {
                return Err(AppError::Validation(format!(
                    "场景数量已达上限 {MAX_SCENARIOS}，请先删除不用的场景"
                )));
            }
        }
        let created_at = current.unwrap_or_else(|| now.clone());
        tx.execute(
            "INSERT INTO scenarios (id, name, icon, apps_json, urls_json, folders_json,
                 linked_workflow_id, snapshot_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               icon = excluded.icon,
               apps_json = excluded.apps_json,
               urls_json = excluded.urls_json,
               folders_json = excluded.folders_json,
               linked_workflow_id = excluded.linked_workflow_id,
               snapshot_id = excluded.snapshot_id,
               updated_at = excluded.updated_at",
            params![
                id,
                n.name,
                n.icon,
                n.apps_json,
                n.urls_json,
                n.folders_json,
                n.linked_workflow_id,
                n.snapshot_id,
                created_at,
                now
            ],
        )?;

        let previous_shelf_ids = {
            let mut stmt = tx.prepare("SELECT id FROM shelf_items WHERE scene_id = ?1")?;
            let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for previous_id in previous_shelf_ids {
            if !selected_shelf_ids.contains(previous_id.as_str()) {
                tx.execute(
                    "UPDATE shelf_items SET scene_id = NULL, updated_at = ?1
                     WHERE id = ?2 AND scene_id = ?3",
                    params![now, previous_id, id],
                )?;
            }
        }
        for item_id in &n.shelf_item_ids {
            tx.execute(
                "UPDATE shelf_items SET scene_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![id, now, item_id],
            )?;
        }
        Ok(())
    })?;
    Ok(id)
}

pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    db.with_transaction(|tx| {
        if tx.execute("DELETE FROM scenarios WHERE id = ?1", params![id])? == 0 {
            return Err(AppError::Validation(format!("场景不存在: {id}")));
        }
        tx.execute(
            "UPDATE shelf_items SET scene_id = NULL, updated_at = ?1 WHERE scene_id = ?2",
            params![now_iso(), id],
        )?;
        Ok(())
    })
}

/// 复制为一个新场景（名称加「副本」后缀）：清单与两个软引用一并复制，
/// `last_entered_at` 不带走——副本还没被进过。
pub fn duplicate(db: &Db, id: &str) -> AppResult<String> {
    let now = now_iso();
    let new_id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let name: String = tx
            .query_row(
                "SELECT name FROM scenarios WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::Validation(format!("场景不存在: {id}")))?;
        let base: String = name
            .chars()
            .take(NAME_MAX_CHARS.saturating_sub(3))
            .collect();
        let copy_name = format!("{base} 副本");
        tx.execute(
            "INSERT INTO scenarios (id, name, icon, apps_json, urls_json, folders_json,
                 linked_workflow_id, snapshot_id, created_at, updated_at)
             SELECT ?1, ?2, icon, apps_json, urls_json, folders_json,
                    linked_workflow_id, snapshot_id, ?3, ?3
             FROM scenarios WHERE id = ?4",
            params![new_id, copy_name, now, id],
        )?;
        tx.commit()?;
        Ok(())
    })?;
    Ok(new_id)
}

// ── 进入场景 ─────────────────────────────────────────────────────────

fn navigate_and_report(
    db: &Db,
    app: &AppHandle,
    kind: &str,
    label: String,
    target_id: &str,
) -> ScenarioEnterItemResult {
    let res = router::navigate(db, app, target_id, &NavigateOptions::default());
    if res.success {
        ScenarioEnterItemResult::ok(kind, label)
    } else {
        ScenarioEnterItemResult::failed(
            kind,
            label,
            res.reason.unwrap_or_else(|| "导航层未给出原因".into()),
        )
    }
}

/// 应用条目：已登记目标优先；目标已被删除但有 exe 路径时按路径重建目标；
/// 两者都没有或程序文件不存在 → skipped（不是 failed：用户能一眼看出该改哪一条）。
fn enter_app(db: &Db, app: &AppHandle, a: &ScenarioAppTarget) -> ScenarioEnterItemResult {
    let label = app_label(a);
    if let Some(tid) = &a.target_id {
        match target_resolver::get_target(db, tid) {
            Ok(Some(t)) => return navigate_and_report(db, app, "app", label, &t.id),
            Ok(None) => {
                let fallback = a.exe_path.as_deref().unwrap_or("").trim();
                if fallback.is_empty() {
                    return ScenarioEnterItemResult::skipped(
                        "app",
                        label,
                        "导航目标已被删除，请重新选择应用",
                    );
                }
            }
            Err(e) => return ScenarioEnterItemResult::failed("app", label, e.to_string()),
        }
    }
    let exe = match a.exe_path.as_deref() {
        Some(e) if !e.trim().is_empty() => e.trim().to_string(),
        _ => return ScenarioEnterItemResult::skipped("app", label, "缺少可执行路径"),
    };
    if !Path::new(&exe).exists() {
        return ScenarioEnterItemResult::skipped("app", label, "程序文件不存在");
    }
    let input = target_resolver::TargetInput {
        target_type: "application".into(),
        display_name: label.clone(),
        exe_path: exe.clone(),
        launch_args: a.args.clone().unwrap_or_default(),
        ..Default::default()
    };
    match target_resolver::save_target(db, &input) {
        Ok(t) => navigate_and_report(db, app, "app", label, &t.id),
        Err(e) => ScenarioEnterItemResult::failed("app", label, e.to_string()),
    }
}

fn app_label(a: &ScenarioAppTarget) -> String {
    if let Some(n) = a.display_name.as_deref() {
        if !n.trim().is_empty() {
            return n.trim().to_string();
        }
    }
    if let Some(e) = a.exe_path.as_deref() {
        if let Some(stem) = Path::new(e).file_stem().and_then(|s| s.to_str()) {
            if !stem.is_empty() {
                return stem.to_string();
            }
        }
    }
    a.target_id.clone().unwrap_or_else(|| "应用".into())
}

/// 网址 / 目录条目：与现场恢复同一条路——落一个常规导航目标再交给 router。
fn enter_path_entry(db: &Db, app: &AppHandle, kind: &str, value: &str) -> ScenarioEnterItemResult {
    let (target_type, label) = match kind {
        "url" => ("url", value.to_string()),
        _ => ("directory", Path::new(value).to_string_lossy().into_owned()),
    };
    if target_type == "directory" && !Path::new(value).is_dir() {
        return ScenarioEnterItemResult::skipped(kind, label, "目录不存在");
    }
    let mut input = target_resolver::TargetInput {
        target_type: target_type.to_string(),
        display_name: label.clone(),
        ..Default::default()
    };
    if kind == "url" {
        input.url = value.to_string();
    } else {
        input.path = value.to_string();
    }
    match target_resolver::save_target(db, &input) {
        Ok(t) => navigate_and_report(db, app, kind, label, &t.id),
        Err(e) => ScenarioEnterItemResult::failed(kind, label, e.to_string()),
    }
}

/// 现场恢复：`start_restore` 是后台异步，受理成功即记 ok，
/// 真实逐项进度由 `workspace-restore-progress` 事件呈现，这里不冒充「已恢复完成」。
fn enter_snapshot(db: &Arc<Db>, app: &AppHandle, snapshot_id: &str) -> ScenarioEnterItemResult {
    let label = snapshot_id.to_string();
    let exists = db
        .with_read(|conn| row_exists(conn, "workspace_snapshots", snapshot_id))
        .unwrap_or(false);
    if !exists {
        return ScenarioEnterItemResult::skipped("snapshot", label, "关联工作现场已被删除");
    }
    match workspace::start_restore(db.clone(), app.clone(), snapshot_id.to_string()) {
        Ok(_) => ScenarioEnterItemResult::ok("snapshot", label),
        Err(e) => ScenarioEnterItemResult::failed("snapshot", label, e.to_string()),
    }
}

/// 工作流内进入场景时等待现场恢复真正退出；取消只发给当前场景自己的恢复操作。
fn enter_snapshot_and_wait(
    db: &Arc<Db>,
    app: &AppHandle,
    snapshot_id: &str,
    cancel: &AtomicBool,
) -> ScenarioEnterItemResult {
    let label = snapshot_id.to_string();
    if cancel.load(Ordering::Acquire) {
        return ScenarioEnterItemResult::failed(
            "snapshot",
            label,
            "场景进入已取消，现场恢复尚未启动",
        );
    }
    match workspace::start_restore(db.clone(), app.clone(), snapshot_id.to_string()) {
        Ok(_) => {}
        Err(e) => return ScenarioEnterItemResult::failed("snapshot", label, e.to_string()),
    }

    const WAIT_TIMEOUT: Duration = Duration::from_secs(120);
    let deadline = Instant::now() + WAIT_TIMEOUT;
    let initial = workspace::restore_status();
    let operation_id = initial
        .snapshot_id
        .as_deref()
        .filter(|id| *id == snapshot_id)
        .and(initial.operation_id);
    let mut cancel_sent = false;
    loop {
        let status = workspace::restore_status();
        if cancel.load(Ordering::Acquire) && !cancel_sent {
            if status.running
                && status.snapshot_id.as_deref() == Some(snapshot_id)
                && (operation_id.is_none() || status.operation_id == operation_id)
            {
                workspace::request_cancel();
            }
            cancel_sent = true;
        }
        let operation_finished = !status.running
            || operation_id
                .as_deref()
                .is_some_and(|id| status.operation_id.as_deref() != Some(id));
        if operation_finished {
            let detail = match workspace::get_snapshot(db, snapshot_id) {
                Ok(detail) => detail,
                Err(e) => return ScenarioEnterItemResult::failed("snapshot", label, e.to_string()),
            };
            let mut restored = 0usize;
            let mut failed = 0usize;
            let mut skipped = 0usize;
            let mut cancelled = 0usize;
            let mut unknown = 0usize;
            for item in &detail.items {
                match item.last_result.as_str() {
                    "restored" => restored += 1,
                    "failed" => failed += 1,
                    "skipped" => skipped += 1,
                    "cancelled" => cancelled += 1,
                    _ => unknown += 1,
                }
            }
            let summary = format!(
                "工作现场结果：恢复 {}，跳过 {}，失败 {}，取消 {}，未知 {}",
                restored, skipped, failed, cancelled, unknown
            );
            if cancel.load(Ordering::Acquire) || cancelled > 0 {
                return ScenarioEnterItemResult::failed(
                    "snapshot",
                    label,
                    format!("{summary}；场景进入已取消"),
                );
            }
            if failed > 0 || skipped > 0 || unknown > 0 {
                return ScenarioEnterItemResult::failed("snapshot", label, summary);
            }
            return ScenarioEnterItemResult::ok("snapshot", label);
        }
        if Instant::now() >= deadline {
            return ScenarioEnterItemResult::failed(
                "snapshot",
                label,
                "现场恢复等待超过 120 秒，已停止等待；系统恢复操作仍可能继续",
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 工作流：同样受全局单实例约束；已在运行别的工作流时返回 failed 并带冲突原因。
fn enter_workflow(db: &Arc<Db>, app: &AppHandle, workflow_id: &str) -> ScenarioEnterItemResult {
    let label = workflow_id.to_string();
    let exists = db
        .with_read(|conn| row_exists(conn, "workflows", workflow_id))
        .unwrap_or(false);
    if !exists {
        return ScenarioEnterItemResult::skipped("workflow", label, "关联工作流已被删除");
    }
    match engine::start_run(db.clone(), app.clone(), workflow_id) {
        Ok(_) => ScenarioEnterItemResult::ok("workflow", label),
        Err(e) => ScenarioEnterItemResult::failed("workflow", label, e.to_string()),
    }
}

fn finish_enter(db: &Db, id: &str, started_at: &str) -> AppResult<()> {
    let scenario_id = id.to_string();
    let entered_at = started_at.to_string();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE scenarios SET last_entered_at = ?1 WHERE id = ?2",
            params![entered_at, scenario_id],
        )?;
        Ok::<_, AppError>(())
    })
}

/// 进入场景：逐项尽力执行，单项失败不阻断后续；无论结果都刷新 last_entered_at。
fn enter_inner(
    db: &Arc<Db>,
    app: &AppHandle,
    id: &str,
    cancel: Option<&AtomicBool>,
    allow_linked_workflow: bool,
) -> AppResult<ScenarioEnterResult> {
    let detail = get(db, id)?;
    workflows::validate_scene_graph_for_scene(
        db,
        id,
        detail.summary.linked_workflow_id.as_deref(),
    )?;
    let started_at = now_iso();
    let mut items = Vec::new();
    let cancelled = || cancel.is_some_and(|flag| flag.load(Ordering::Acquire));

    if let Some(sn) = &detail.snapshot_id {
        items.push(if let Some(flag) = cancel {
            enter_snapshot_and_wait(db, app, sn, flag)
        } else {
            enter_snapshot(db, app, sn)
        });
    }
    for a in &detail.apps {
        if cancelled() {
            break;
        }
        items.push(enter_app(db, app, a));
    }
    for u in &detail.urls {
        if cancelled() {
            break;
        }
        items.push(enter_path_entry(db, app, "url", u));
    }
    for f in &detail.folders {
        if cancelled() {
            break;
        }
        items.push(enter_path_entry(db, app, "folder", f));
    }
    if let Some(wf) = &detail.summary.linked_workflow_id {
        items.push(if allow_linked_workflow {
            enter_workflow(db, app, wf)
        } else {
            ScenarioEnterItemResult::skipped(
                "workflow",
                wf.clone(),
                "当前工作流持有唯一运行槽，未递归启动场景关联工作流",
            )
        });
    }

    // 进入时间单独一次写：即使部分项失败也要留下「进过」这一事实，失败原因已在 items 里。
    finish_enter(db, id, &started_at)?;

    Ok(ScenarioEnterResult { items, started_at })
}

pub fn enter(db: &Arc<Db>, app: &AppHandle, id: &str) -> AppResult<ScenarioEnterResult> {
    enter_inner(db, app, id, None, true)
}

/// 工作流内调用场景服务：等待现场恢复终态、传递取消位，并禁止场景再次启动工作流。
pub(crate) fn enter_for_workflow(
    db: &Arc<Db>,
    app: &AppHandle,
    id: &str,
    cancel: &AtomicBool,
) -> AppResult<ScenarioEnterResult> {
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::Conflict("进入场景已取消，未启动".into()));
    }
    let result = enter_inner(db, app, id, Some(cancel), false)?;
    if cancel.load(Ordering::Acquire) {
        let completed = result.items.len();
        return Err(AppError::Conflict(format!(
            "进入场景已取消；此前已处理 {completed} 项，结果请检查现场恢复进度"
        )));
    }
    let failed = result
        .items
        .iter()
        .filter(|item| item.status == "failed")
        .count();
    let skipped = result
        .items
        .iter()
        .filter(|item| item.status == "skipped")
        .count();
    if failed > 0 || skipped > 0 {
        let item_summary = result
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| format!("{}#{}={}", item.kind, index + 1, item.status))
            .collect::<Vec<_>>()
            .join("、");
        return Err(AppError::Validation(format!(
            "场景未全部完成：{} 项失败、{} 项跳过；{}",
            failed, skipped, item_summary
        )));
    }
    Ok(result)
}

// ── Tauri 命令 ───────────────────────────────────────────────────────

#[tauri::command]
pub fn scenario_list(db: State<'_, Arc<Db>>) -> AppResult<Vec<ScenarioSummary>> {
    list(&db)
}

#[tauri::command]
pub fn scenario_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<ScenarioDetail> {
    get(&db, &id)
}

#[tauri::command]
pub fn scenario_save(
    db: State<'_, Arc<Db>>,
    input: ScenarioSaveInput,
) -> AppResult<serde_json::Value> {
    Ok(serde_json::json!({ "id": save(&db, &input)? }))
}

#[tauri::command]
pub fn scenario_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    delete(&db, &id)
}

#[tauri::command]
pub fn scenario_duplicate(db: State<'_, Arc<Db>>, id: String) -> AppResult<serde_json::Value> {
    Ok(serde_json::json!({ "id": duplicate(&db, &id)? }))
}

/// 进入场景可能启动多个程序并等待窗口校验（导航层单次最长 5s），必须走阻塞线程。
#[tauri::command]
pub async fn scenario_enter(
    db: State<'_, Arc<Db>>,
    app: AppHandle,
    id: String,
) -> AppResult<ScenarioEnterResult> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || enter(&db, &app, &id))
        .await
        .map_err(|e| AppError::Validation(format!("进入场景失败: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn app_by_exe(exe: &str) -> ScenarioAppTarget {
        ScenarioAppTarget {
            target_id: None,
            exe_path: Some(exe.into()),
            args: None,
            display_name: None,
        }
    }

    fn base_input(name: &str) -> ScenarioSaveInput {
        ScenarioSaveInput {
            id: None,
            name: name.into(),
            icon: None,
            apps: vec![
                app_by_exe("C:\\Windows\\System32\\notepad.exe"),
                ScenarioAppTarget {
                    target_id: Some("tid-1".into()),
                    exe_path: None,
                    args: Some("--flag".into()),
                    display_name: Some("浏览器".into()),
                },
            ],
            urls: vec!["https://example.com".into()],
            folders: vec!["C:\\Users\\public".into()],
            shelf_item_ids: vec![],
            linked_workflow_id: None,
            snapshot_id: None,
        }
    }

    fn insert_shelf_item(
        db: &Db,
        id: &str,
        kind: &str,
        scene_id: Option<&str>,
        exists_state: &str,
    ) {
        let now = now_iso();
        db.with_transaction(|conn| {
            conn.execute(
                "INSERT INTO shelf_items
                 (id, kind, display_name, storage_mode, original_path, exists_state, scene_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'reference', ?4, ?5, ?6, ?7, ?7)",
                params![
                    id,
                    kind,
                    format!("{id}.{kind}"),
                    format!("C:\\references\\{id}"),
                    exists_state,
                    scene_id,
                    now
                ],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn count(db: &Db, sql: &str) -> i64 {
        db.with_conn(|c| c.query_row(sql, [], |r| r.get(0)).map_err(AppError::from))
            .unwrap()
    }

    #[test]
    fn save_creates_then_lists_counts_from_json() {
        let db = memdb();
        let id = save(&db, &base_input("写作现场")).unwrap();
        let all = list(&db).unwrap();
        assert_eq!(all.len(), 1, "新建后应恰好一条");
        let s = &all[0];
        assert_eq!(s.name, "写作现场");
        assert_eq!(s.app_count, 2, "计数必须来自清单 JSON 实际长度");
        assert_eq!(s.url_count, 1);
        assert_eq!(s.folder_count, 1);
        assert!(s.last_entered_at.is_none(), "新建场景不得声称被进入过");

        let d = get(&db, &id).unwrap();
        assert_eq!(d.summary.id, id, "详情平铺后必须仍带 id");
        assert_eq!(d.apps.len(), 2);
        assert_eq!(d.apps[1].args.as_deref(), Some("--flag"));
        assert!(d.snapshot_id.is_none());
    }

    #[test]
    fn save_update_keeps_created_at_and_replaces_lists() {
        let db = memdb();
        let id = save(&db, &base_input("v1")).unwrap();
        let created = get(&db, &id).unwrap().summary.created_at.clone();

        let mut second = base_input("v2");
        second.id = Some(id.clone());
        second.apps = vec![app_by_exe("C:\\a.exe")];
        second.urls = vec![];
        second.folders = vec![];
        save(&db, &second).unwrap();

        let d = get(&db, &id).unwrap();
        assert_eq!(d.summary.created_at, created, "更新不得改 created_at");
        assert_eq!(d.summary.app_count, 1, "清单是整体覆盖而非追加");
        assert_eq!(d.summary.url_count, 0);
        assert_eq!(d.summary.folder_count, 0);
    }

    #[test]
    fn rejects_blank_name_control_chars_and_oversize_lists() {
        let db = memdb();
        let e = save(&db, &base_input("   ")).unwrap_err();
        assert!(e.to_string().contains("名称不能为空"), "实际: {e}");

        let e = save(&db, &base_input("名字\u{7}带响铃")).unwrap_err();
        assert!(e.to_string().contains("控制字符"), "实际: {e}");

        let mut many = base_input("太多应用");
        many.apps = (0..MAX_APPS + 1)
            .map(|i| app_by_exe(&format!("C:\\{i}.exe")))
            .collect();
        let e = save(&db, &many).unwrap_err();
        assert!(e.to_string().contains("数量超限"), "实际: {e}");
    }

    #[test]
    fn app_entry_without_target_or_exe_is_rejected() {
        let db = memdb();
        let mut input = base_input("空应用条目");
        input.apps = vec![ScenarioAppTarget::default()];
        let e = save(&db, &input).unwrap_err();
        assert!(
            e.to_string().contains("已登记目标或可执行路径"),
            "两个定位方式都缺时必须拒绝: {e}"
        );
    }

    #[test]
    fn non_http_urls_are_rejected_by_navigation_rules() {
        let db = memdb();
        for bad in ["javascript:alert(1)", "file:///C:/Windows", "ftp://x/y"] {
            let mut input = base_input("危险网址");
            input.urls = vec![bad.into()];
            let e = save(&db, &input).unwrap_err();
            assert!(
                e.to_string().contains("http") || e.to_string().contains("非法"),
                "{bad} 应被拒绝，实际: {e}"
            );
        }
    }

    #[test]
    fn dangling_refs_are_rejected_at_save_time() {
        let db = memdb();
        let mut input = base_input("引用不存在");
        input.linked_workflow_id = Some("no-such-workflow".into());
        let e = save(&db, &input).unwrap_err();
        assert!(e.to_string().contains("工作流不存在"), "实际: {e}");

        let mut input = base_input("引用不存在");
        input.snapshot_id = Some("no-such-snapshot".into());
        let e = save(&db, &input).unwrap_err();
        assert!(e.to_string().contains("工作现场不存在"), "实际: {e}");
    }

    #[test]
    fn dropping_snapshot_nulls_reference_without_deleting_scenario() {
        let db = memdb();
        let snap = db
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO workspace_snapshots (id, name, note, source, item_count, created_at, updated_at)
                     VALUES ('snap-1','现场',' ','manual',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                    [],
                )?;
                Ok::<_, AppError>(())
            })
            .is_ok();
        assert!(snap, "测试夹具需要能写入工作现场");

        let mut input = base_input("带现场的场景");
        input.snapshot_id = Some("snap-1".into());
        let id = save(&db, &input).unwrap();
        assert_eq!(
            get(&db, &id).unwrap().snapshot_id.as_deref(),
            Some("snap-1")
        );

        db.with_conn(|c| {
            c.execute("DELETE FROM workspace_snapshots WHERE id = 'snap-1'", [])?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let d = get(&db, &id).unwrap();
        assert_eq!(d.snapshot_id, None, "删除现场只应置空引用，不得级联删场景");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM scenarios"), 1);
    }

    #[test]
    fn duplicate_copies_lists_and_resets_entered_time() {
        let db = memdb();
        let id = save(&db, &base_input("原始场景")).unwrap();
        db.with_conn(|c| {
            c.execute(
                "UPDATE scenarios SET last_entered_at = '2026-01-01T00:00:00Z' WHERE id = ?1",
                params![id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let copy = duplicate(&db, &id).unwrap();
        assert_ne!(copy, id);
        let d = get(&db, &copy).unwrap();
        assert!(
            d.summary.name.ends_with(" 副本"),
            "实际名称: {}",
            d.summary.name
        );
        assert_eq!(d.summary.app_count, 2, "副本必须带走完整清单");
        assert_eq!(d.summary.url_count, 1);
        assert!(
            d.summary.last_entered_at.is_none(),
            "副本还没被进入过，不得继承进入时间"
        );

        let e = duplicate(&db, "missing").unwrap_err();
        assert!(e.to_string().contains("场景不存在"), "实际: {e}");
    }

    #[test]
    fn scene_shelf_links_keep_ids_and_never_delete_items() {
        let db = memdb();
        insert_shelf_item(&db, "file-a", "file", None, "missing");
        insert_shelf_item(&db, "folder-b", "folder", None, "ok");

        let mut input = base_input("带暂存引用");
        input.shelf_item_ids = vec!["file-a".into(), "folder-b".into()];
        let id = save(&db, &input).unwrap();
        assert_eq!(
            get(&db, &id).unwrap().shelf_item_ids,
            vec!["file-a", "folder-b"]
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM shelf_items WHERE scene_id IS NOT NULL"
            ),
            2
        );

        let copy = duplicate(&db, &id).unwrap();
        assert!(get(&db, &copy).unwrap().shelf_item_ids.is_empty());

        input.id = Some(id.clone());
        input.shelf_item_ids = vec!["folder-b".into()];
        save(&db, &input).unwrap();
        let scene_of = |item_id: &str| {
            db.with_read(|conn| {
                conn.query_row(
                    "SELECT scene_id FROM shelf_items WHERE id = ?1",
                    params![item_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(AppError::from)
            })
            .unwrap()
        };
        assert_eq!(scene_of("file-a"), None);
        assert_eq!(scene_of("folder-b"), Some(id.clone()));
        assert_eq!(get(&db, &id).unwrap().shelf_item_ids, vec!["folder-b"]);

        delete(&db, &id).unwrap();
        assert_eq!(scene_of("folder-b"), None);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM shelf_items"), 2);
    }

    #[test]
    fn scene_shelf_links_reject_missing_wrong_kind_and_other_owner_atomically() {
        let db = memdb();
        insert_shelf_item(&db, "text-a", "text", None, "ok");
        insert_shelf_item(&db, "file-a", "file", None, "ok");

        let mut invalid = base_input("错误类型");
        invalid.shelf_item_ids = vec!["text-a".into()];
        assert!(save(&db, &invalid).is_err());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM scenarios"), 0);

        let mut missing = base_input("缺失条目");
        missing.shelf_item_ids = vec!["missing-item".into()];
        assert!(save(&db, &missing).is_err());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM scenarios"), 0);

        let mut first = base_input("场景一");
        first.shelf_item_ids = vec!["file-a".into()];
        let owner = save(&db, &first).unwrap();
        let mut second = base_input("场景二");
        second.shelf_item_ids = vec!["file-a".into()];
        assert!(save(&db, &second).is_err());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM scenarios"), 1);
        assert_eq!(get(&db, &owner).unwrap().shelf_item_ids, vec!["file-a"]);
    }

    #[test]
    fn scenario_count_is_capped() {
        let db = memdb();
        for i in 0..MAX_SCENARIOS {
            save(&db, &base_input(&format!("场景 {i}"))).unwrap();
        }
        let e = save(&db, &base_input("超出上限")).unwrap_err();
        assert!(e.to_string().contains("上限"), "实际: {e}");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM scenarios"),
            MAX_SCENARIOS as i64
        );
    }

    #[test]
    fn delete_reports_missing_and_name_may_repeat() {
        let db = memdb();
        let a = save(&db, &base_input("同名")).unwrap();
        let b = save(&db, &base_input("同名")).unwrap();
        assert_ne!(a, b, "同名场景是合法用法");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM scenarios"), 2);

        delete(&db, &a).unwrap();
        let e = delete(&db, &a).unwrap_err();
        assert!(e.to_string().contains("场景不存在"), "实际: {e}");
    }

    #[test]
    fn icon_is_truncated_and_blank_icon_becomes_null() {
        let db = memdb();
        let mut input = base_input("图标");
        input.icon = Some("  ".to_string());
        let id = save(&db, &input).unwrap();
        assert_eq!(get(&db, &id).unwrap().summary.icon, None);

        let mut input = base_input("图标");
        input.icon = Some("🧪🧪🧪🧪🧪🧪".into());
        let id = save(&db, &input).unwrap();
        let icon = get(&db, &id).unwrap().summary.icon.unwrap();
        assert_eq!(icon.chars().count(), 4, "图标必须截断到 4 字符");
    }
}
