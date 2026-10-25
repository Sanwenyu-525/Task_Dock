//! Agent 相关命令：快照、来源管理（动态注册）、自动发现、接入向导、模拟控制、通知。

use std::sync::Arc;
use tauri::{Manager, State};

use crate::agents::codex;
use crate::agents::discovery;
use crate::agents::managed;
use crate::agents::mock::{self, MockScenario};
use crate::agents::{AgentHub, AgentSnapshot};
use crate::db::{Db, NotificationRow};
use crate::error::{AppError, AppResult};

#[tauri::command]
pub fn agent_snapshot(hub: State<'_, std::sync::Arc<AgentHub>>) -> AppResult<AgentSnapshot> {
    hub.snapshot()
}

#[tauri::command]
pub fn set_source_enabled(db: State<'_, Arc<Db>>, id: String, enabled: bool) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_sources SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![enabled as i64, crate::agents::now_iso(), id],
        )?;
        Ok::<_, AppError>(())
    })
}

// ── 动态来源注册（第四阶段）────────────────────────────────

#[tauri::command]
pub fn create_source(
    db: State<'_, Arc<Db>>,
    id: String,
    display_name: String,
    adapter: Option<String>,
    homepage: Option<String>,
    note: Option<String>,
    icon: Option<String>,
) -> AppResult<()> {
    let id = id.trim().to_string();
    crate::agents::validate_session_id(&id)
        .map_err(|_| AppError::Validation("来源 ID 只允许字母数字与 -_.: 字符".into()))?;
    if display_name.trim().is_empty() {
        return Err(AppError::Validation("显示名称不能为空".into()));
    }
    let adapter = adapter.unwrap_or_else(|| "manual".into());
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO agent_sources (id, display_name, kind, enabled, verified, homepage, note, config, adapter, icon, created_at, updated_at)
             VALUES (?1, ?2, 'manual', 1, 0, ?3, ?4, '{}', ?5, ?6, ?7, ?7)",
            rusqlite::params![id, display_name.trim(), homepage.unwrap_or_default(), note.unwrap_or_default(), adapter, icon.unwrap_or_default(), now],
        )?;
        Ok::<_, AppError>(())
    })
}

#[tauri::command]
pub fn update_source(
    db: State<'_, Arc<Db>>,
    id: String,
    display_name: Option<String>,
    homepage: Option<String>,
    note: Option<String>,
    icon: Option<String>,
    hidden: Option<bool>,
) -> AppResult<()> {
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        if let Some(n) = display_name {
            if n.trim().is_empty() {
                return Err(AppError::Validation("显示名称不能为空".into()));
            }
            conn.execute(
                "UPDATE agent_sources SET display_name = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![n.trim(), now, id],
            )?;
        }
        if let Some(h) = homepage {
            conn.execute(
                "UPDATE agent_sources SET homepage = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![h, now, id],
            )?;
        }
        if let Some(nt) = note {
            conn.execute(
                "UPDATE agent_sources SET note = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![nt, now, id],
            )?;
        }
        if let Some(ic) = icon {
            conn.execute(
                "UPDATE agent_sources SET icon = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![ic, now, id],
            )?;
        }
        if let Some(hd) = hidden {
            conn.execute(
                "UPDATE agent_sources SET hidden = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![hd as i64, now, id],
            )?;
        }
        Ok::<_, AppError>(())
    })
}

/// 删除来源：只删 Agent 观测数据；关联的普通任务与 task_agent_links 保留
/// （任务侧显示为「来源已移除」，绝不级联删除用户任务）。
#[tauri::command]
pub fn delete_source(db: State<'_, Arc<Db>>, id: String, also_delete_data: bool) -> AppResult<()> {
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if also_delete_data {
            tx.execute(
                "DELETE FROM agent_runs WHERE source_id = ?1",
                rusqlite::params![id],
            )?;
            tx.execute(
                "DELETE FROM agent_sessions WHERE source_id = ?1",
                rusqlite::params![id],
            )?;
            tx.execute(
                "DELETE FROM agent_instances WHERE source_id = ?1",
                rusqlite::params![id],
            )?;
        }
        // task_agent_links 保留任务历史（不删 tasks，links 留作记录）
        tx.execute("DELETE FROM agent_sources WHERE id = ?1", rusqlite::params![id])?;
        let _ = now;
        tx.commit()?;
        Ok::<_, AppError>(())
    })
}

// ── 自动发现（第二阶段）────────────────────────────────────

#[tauri::command]
pub fn discovery_scan(db: State<'_, Arc<Db>>) -> AppResult<Vec<discovery::DiscoveredAgent>> {
    Ok(discovery::scan_all(&db))
}

// ── 接入向导（一键接入：预览 → 确认 → 安装 → 验证）────────

#[tauri::command]
pub fn adapter_preview(adapter_id: String, app: tauri::AppHandle) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = app.path().app_data_dir()?;
    a.preview(&app_data)
}

#[tauri::command]
pub fn adapter_install(
    adapter_id: String,
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = app.path().app_data_dir()?;
    a.install(&app_data, &db)
}

#[tauri::command]
pub fn adapter_verify(
    adapter_id: String,
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = app.path().app_data_dir()?;
    a.verify(&app_data, &db)
}

#[tauri::command]
pub fn adapter_uninstall(adapter_id: String, app: tauri::AppHandle) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = app.path().app_data_dir()?;
    a.uninstall(&app_data)
}

#[tauri::command]
pub fn adapter_status(adapter_id: String, app: tauri::AppHandle, db: State<'_, Arc<Db>>) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = app.path().app_data_dir()?;
    let mut status = a.config_status(&app_data)?;
    if let Some(obj) = status.as_object_mut() {
        obj.insert("health".into(), managed::source_health(&db, a.id()));
    }
    Ok(status)
}

/// 各适配器的静态能力清单（UI 徽标用）。
#[tauri::command]
pub fn adapter_list() -> Vec<serde_json::Value> {
    managed::all_adapters()
        .iter()
        .map(|a| {
            serde_json::json!({
                "id": a.id(),
                "display_name": a.display_name(),
                "transport_kind": a.transport_kind(),
                "docs_url": a.docs_url(),
            })
        })
        .collect()
}

// ── 模拟控制台（P1-6：仅手动触发）──────────────────────────

#[tauri::command]
pub fn mock_start_scenario(session_title: String, outcome: String) -> AppResult<()> {
    let outcome = match outcome.as_str() {
        "completed" | "failed" | "waiting_only" => outcome,
        _ => "completed".to_string(),
    };
    if mock::trigger(MockScenario { session_title, outcome }) {
        Ok(())
    } else {
        Err(AppError::Agent("Mock Adapter 未运行".into()))
    }
}

// ── Codex 钩子（保留旧命令，内部走新安全安装器）────────────

#[tauri::command]
pub fn codex_hooks_status(app: tauri::AppHandle) -> AppResult<serde_json::Value> {
    codex::status(&app)
}

#[tauri::command]
pub fn codex_hooks_install(app: tauri::AppHandle, db: State<'_, Arc<Db>>) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter("codex").ok_or_else(|| AppError::Agent("codex 适配器缺失".into()))?;
    let app_data = app.path().app_data_dir()?;
    a.install(&app_data, &db)
}

#[tauri::command]
pub fn codex_hooks_uninstall(app: tauri::AppHandle) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter("codex").ok_or_else(|| AppError::Agent("codex 适配器缺失".into()))?;
    let app_data = app.path().app_data_dir()?;
    a.uninstall(&app_data)
}

/// 跳转到 Agent 会话（目前支持 Codex：codex resume）。
#[tauri::command]
pub fn open_agent_session(source_id: String, session_id: String) -> AppResult<()> {
    match source_id.as_str() {
        "codex" => codex::open_session(&session_id),
        "mock" => Err(AppError::Agent("模拟会话无需跳转".into())),
        other => Err(AppError::Agent(format!(
            "来源 {} 暂不支持跳转（无可靠官方跳转接口）",
            other
        ))),
    }
}

// ── 通知收件箱 ──────────────────────────────────────────────

#[tauri::command]
pub fn list_notifications(db: State<'_, Arc<Db>>, unread_only: Option<bool>, limit: Option<i64>) -> AppResult<Vec<NotificationRow>> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let mut sql = "SELECT id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at FROM notification_history".to_string();
    if unread_only.unwrap_or(false) {
        sql += " WHERE is_read = 0";
    }
    sql += " ORDER BY created_at DESC LIMIT ?1";
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![limit], |r| {
            Ok(NotificationRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                body: r.get(3)?,
                ref_type: r.get(4)?,
                ref_id: r.get(5)?,
                occurrence: r.get(6)?,
                is_read: r.get::<_, i64>(7)? != 0,
                created_at: r.get(8)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

#[tauri::command]
pub fn mark_notification_read(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE notification_history SET is_read = 1 WHERE id = ?1",
            rusqlite::params![id],
        )?;
        Ok::<_, AppError>(())
    })
}

#[tauri::command]
pub fn mark_all_notifications_read(db: State<'_, Arc<Db>>) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute("UPDATE notification_history SET is_read = 1 WHERE is_read = 0", [])?;
        Ok::<_, AppError>(())
    })
}

#[tauri::command]
pub fn clear_notifications(db: State<'_, Arc<Db>>) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute("DELETE FROM notification_history", [])?;
        Ok::<_, AppError>(())
    })
}

/// Agent 事件流水（历史记录；扩展列：occurred_at / transport / evidence_type）。
#[tauri::command]
pub fn list_agent_events(db: State<'_, Arc<Db>>, source_id: Option<String>, limit: Option<i64>) -> AppResult<Vec<crate::db::AgentEventRow>> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    db.with_conn(|conn| {
        let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match &source_id {
            Some(s) => (
                "SELECT id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, occurred_at, transport, evidence_type
                 FROM agent_events WHERE source_id = ?1 ORDER BY received_at DESC LIMIT ?2"
                    .into(),
                vec![Box::new(s.clone()), Box::new(limit)],
            ),
            None => (
                "SELECT id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, occurred_at, transport, evidence_type
                 FROM agent_events ORDER BY received_at DESC LIMIT ?1"
                    .into(),
                vec![Box::new(limit)],
            ),
        };
        let mut stmt = conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |r| {
            Ok(crate::db::AgentEventRow {
                id: r.get(0)?,
                source_id: r.get(1)?,
                session_external_id: r.get(2)?,
                run_external_id: r.get(3)?,
                event_type: r.get(4)?,
                state: r.get(5)?,
                message: r.get(6)?,
                received_at: r.get(7)?,
                occurred_at: r.get(8)?,
                transport: r.get(9)?,
                evidence_type: r.get(10)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}
