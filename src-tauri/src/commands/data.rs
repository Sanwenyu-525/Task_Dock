//! 数据导入导出与本地自动备份。
//!
//! 所有用户数据仅保存在本地；导出为纯 JSON，不包含任何 Agent Prompt/代码内容。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, State};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

const EXPORT_VERSION: i64 = 1;

fn app_data(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_data_dir()?)
}

fn backup_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app_data(app)?.join("backups");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 收集全量数据（导出/备份共用）。
fn collect(db: &Db) -> AppResult<serde_json::Value> {
    let tasks = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at FROM tasks",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "description": r.get::<_, String>(2)?,
                "priority": r.get::<_, i64>(3)?,
                "status": r.get::<_, String>(4)?,
                "category": r.get::<_, String>(5)?,
                "tags": r.get::<_, String>(6)?,
                "due_at": r.get::<_, Option<String>>(7)?,
                "remind_at": r.get::<_, Option<String>>(8)?,
                "advance_minutes": r.get::<_, i64>(9)?,
                "recurrence_rule_id": r.get::<_, Option<String>>(10)?,
                "created_at": r.get::<_, String>(11)?,
                "updated_at": r.get::<_, String>(12)?,
                "completed_at": r.get::<_, Option<String>>(13)?,
            }))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let rules = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, freq, interval, by_weekday, by_monthday, until, anchor, created_at FROM recurrence_rules",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "freq": r.get::<_, String>(1)?,
                "interval": r.get::<_, i64>(2)?,
                "by_weekday": r.get::<_, String>(3)?,
                "by_monthday": r.get::<_, Option<u32>>(4)?,
                "until": r.get::<_, Option<String>>(5)?,
                "anchor": r.get::<_, String>(6)?,
                "created_at": r.get::<_, String>(7)?,
            }))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let reminders = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, task_id, remind_at, occurrence, kind, fired, fired_at FROM task_reminders",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "task_id": r.get::<_, String>(1)?,
                "remind_at": r.get::<_, String>(2)?,
                "occurrence": r.get::<_, String>(3)?,
                "kind": r.get::<_, String>(4)?,
                "fired": r.get::<_, i64>(5)? != 0,
                "fired_at": r.get::<_, Option<String>>(6)?,
            }))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let links = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, task_id, source_id, session_external_id, run_external_id, created_at FROM task_agent_links",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "task_id": r.get::<_, String>(1)?,
                "source_id": r.get::<_, String>(2)?,
                "session_external_id": r.get::<_, String>(3)?,
                "run_external_id": r.get::<_, Option<String>>(4)?,
                "created_at": r.get::<_, String>(5)?,
            }))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let categories = db.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT id, name, color, sort_order, created_at FROM task_categories")?;
        let rows = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "color": r.get::<_, String>(2)?,
                "sort_order": r.get::<_, i64>(3)?,
                "created_at": r.get::<_, String>(4)?,
            }))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let runs = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, ended_at, pending_items, meta FROM agent_runs",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "session_id": r.get::<_, String>(1)?,
                "source_id": r.get::<_, String>(2)?,
                "external_run_id": r.get::<_, Option<String>>(3)?,
                "task_title": r.get::<_, String>(4)?,
                "status": r.get::<_, String>(5)?,
                "started_at": r.get::<_, String>(6)?,
                "updated_at": r.get::<_, String>(7)?,
                "ended_at": r.get::<_, Option<String>>(8)?,
                "pending_items": r.get::<_, String>(9)?,
                "meta": r.get::<_, String>(10)?,
            }))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let notifications = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at FROM notification_history ORDER BY created_at DESC LIMIT 500",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "kind": r.get::<_, String>(1)?,
                "title": r.get::<_, String>(2)?,
                "body": r.get::<_, String>(3)?,
                "ref_type": r.get::<_, Option<String>>(4)?,
                "ref_id": r.get::<_, Option<String>>(5)?,
                "occurrence": r.get::<_, Option<String>>(6)?,
                "is_read": r.get::<_, i64>(7)? != 0,
                "created_at": r.get::<_, String>(8)?,
            }))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let settings = db.all_settings()?;
    Ok(serde_json::json!({
        "app": "task-dock",
        "version": EXPORT_VERSION,
        "exported_at": now_iso(),
        "tasks": tasks,
        "recurrence_rules": rules,
        "task_reminders": reminders,
        "task_agent_links": links,
        "task_categories": categories,
        "agent_runs": runs,
        "notification_history": notifications,
        "settings": settings,
    }))
}

/// 导出到指定路径（由前端对话框选择）。
#[tauri::command]
pub fn export_data(db: State<'_, Arc<Db>>, path: String) -> AppResult<String> {
    let data = collect(&db)?;
    let pretty = serde_json::to_string_pretty(&data)?;
    std::fs::write(&path, pretty)?;
    tracing::info!("数据已导出: {}", path);
    Ok(path)
}

/// 立即备份到应用数据目录。
#[tauri::command]
pub fn backup_now(app: tauri::AppHandle, db: State<'_, Arc<Db>>) -> AppResult<String> {
    let dir = backup_dir(&app)?;
    let data = collect(&db)?;
    let pretty = serde_json::to_string_pretty(&data)?;
    let path = dir.join(format!("backup-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&path, pretty)?;
    prune_backups(&app, &db)?;
    tracing::info!("本地备份完成: {}", path.display());
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_backups(app: tauri::AppHandle) -> AppResult<Vec<serde_json::Value>> {
    let dir = backup_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_file() {
            out.push(serde_json::json!({
                "name": entry.file_name().to_string_lossy().to_string(),
                "size": meta.len(),
                "modified": chrono::DateTime::<chrono::Utc>::from(meta.modified()?).to_rfc3339(),
            }));
        }
    }
    out.sort_by(|a, b| {
        b.get("modified").and_then(|v| v.as_str()).unwrap_or("")
            .cmp(a.get("modified").and_then(|v| v.as_str()).unwrap_or(""))
    });
    Ok(out)
}

fn prune_backups(app: &tauri::AppHandle, db: &Db) -> AppResult<()> {
    let settings = crate::db::Settings::load(db)?;
    let retain = settings.backup_retain_days.max(1) as i64;
    let dir = backup_dir(app)?;
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs((retain * 86400) as u64);
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_file() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(())
}

/// 启动时自动备份（距上次备份超过 24 小时才执行）。
pub fn auto_backup_if_needed_inner(app: &tauri::AppHandle, db: &Db) -> AppResult<Option<String>> {
    let settings = crate::db::Settings::load(db)?;
    if !settings.auto_backup {
        return Ok(None);
    }
    let dir = backup_dir(app)?;
    let last = std::fs::read_dir(&dir)
        .ok()
        .and_then(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| e.metadata().ok())
                .filter_map(|m| m.modified().ok())
                .max()
        });
    let stale = match last {
        Some(t) => {
            t.elapsed()
                .map(|d| d > std::time::Duration::from_secs(24 * 3600))
                .unwrap_or(true)
        }
        None => true,
    };
    if stale {
        let data = collect(db)?;
        let pretty = serde_json::to_string_pretty(&data)?;
        let path = dir.join(format!("backup-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        std::fs::write(&path, pretty)?;
        prune_backups(app, db)?;
        tracing::info!("启动自动备份完成: {}", path.display());
        return Ok(Some(path.to_string_lossy().to_string()));
    }
    Ok(None)
}

#[tauri::command]
pub fn auto_backup_if_needed(app: tauri::AppHandle, db: State<'_, Arc<Db>>) -> AppResult<Option<String>> {
    auto_backup_if_needed_inner(&app, &db)
}

/// 从 JSON 文件导入（整体替换，导入前自动备份）。
#[tauri::command]
pub fn import_data(app: tauri::AppHandle, db: State<'_, Arc<Db>>, path: String) -> AppResult<()> {
    let raw = std::fs::read_to_string(&path)?;
    let data: serde_json::Value = serde_json::from_str(&raw)?;
    if data.get("app").and_then(|v| v.as_str()) != Some("task-dock") {
        return Err(AppError::Validation("不是 Task Dock 的导出文件".into()));
    }
    let version = data.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
    if version < 1 || version > EXPORT_VERSION {
        return Err(AppError::Validation(format!("不支持的数据版本: {}", version)));
    }
    // 导入前备份当前数据
    let _ = backup_now(app.clone(), db.clone())?;

    let get_arr = |key: &str| -> Vec<serde_json::Value> {
        data.get(key)
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };

    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> AppResult<()> {
            for table in [
                "task_agent_links",
                "task_reminders",
                "agent_runs",
                "agent_sessions",
                "agent_events",
                "notification_history",
                "recurrence_rules",
                "tasks",
                "task_categories",
            ] {
                conn.execute(&format!("DELETE FROM {}", table), [])?;
            }
            let insert = |table: &str, columns: &[&str], rows: &[serde_json::Value]| -> AppResult<()> {
                if rows.is_empty() {
                    return Ok(());
                }
                let placeholders: Vec<String> = (1..=columns.len()).map(|i| format!("?{}", i)).collect();
                let sql = format!(
                    "INSERT INTO {} ({}) VALUES ({})",
                    table,
                    columns.join(", "),
                    placeholders.join(", ")
                );
                let mut stmt = conn.prepare(&sql)?;
                for row in rows {
                    let params: Vec<serde_json::Value> = columns
                        .iter()
                        .map(|c| row.get(*c).cloned().unwrap_or(serde_json::Value::Null))
                        .collect();
                    let refs: Vec<&dyn rusqlite::ToSql> = params
                        .iter()
                        .map(|p| p as &dyn rusqlite::ToSql)
                        .collect();
                    stmt.execute(refs.as_slice())?;
                }
                Ok(())
            };
            insert(
                "task_categories",
                &["id", "name", "color", "sort_order", "created_at"],
                &get_arr("task_categories"),
            )?;
            insert(
                "recurrence_rules",
                &["id", "freq", "interval", "by_weekday", "by_monthday", "until", "anchor", "created_at"],
                &get_arr("recurrence_rules"),
            )?;
            insert(
                "tasks",
                &[
                    "id", "title", "description", "priority", "status", "category", "tags",
                    "due_at", "remind_at", "advance_minutes", "recurrence_rule_id",
                    "created_at", "updated_at", "completed_at",
                ],
                &get_arr("tasks"),
            )?;
            insert(
                "task_reminders",
                &["id", "task_id", "remind_at", "occurrence", "kind", "fired", "fired_at"],
                &get_arr("task_reminders"),
            )?;
            insert(
                "task_agent_links",
                &["id", "task_id", "source_id", "session_external_id", "run_external_id", "created_at"],
                &get_arr("task_agent_links"),
            )?;
            insert(
                "agent_runs",
                &[
                    "id", "session_id", "source_id", "external_run_id", "task_title", "status",
                    "started_at", "updated_at", "ended_at", "pending_items", "meta",
                ],
                &get_arr("agent_runs"),
            )?;
            insert(
                "notification_history",
                &["id", "kind", "title", "body", "ref_type", "ref_id", "occurrence", "is_read", "created_at"],
                &get_arr("notification_history"),
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT")?;
                Ok::<_, AppError>(())
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })?;

    // 设置单独应用（不动 http_token 等安全项）
    if let Some(settings) = data.get("settings").and_then(|v| v.as_object()) {
        for (k, v) in settings {
            if k != "http_token" {
                let _ = db.set_setting(k, v.clone());
            }
        }
    }
    tracing::info!("数据导入完成: {}", path);
    Ok(())
}
