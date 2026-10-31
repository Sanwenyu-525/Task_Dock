//! Agent 相关命令：快照、来源管理（动态注册）、自动发现、接入向导、模拟控制、通知。

use rusqlite::OptionalExtension;
use std::sync::Arc;
use tauri::State;

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

/// 删除来源。
///
/// P1 修复（外键冲突）：agent_sessions/agent_instances 以外键引用 agent_sources，
/// 旧实现在 also_delete_data=false 时直接 DELETE 来源 → FOREIGN KEY constraint failed，
/// 来源一旦有过事件就永远删不掉。新语义：
/// - 会话/轮次/实例（FK 绑定的观测数据）总是随之删除，保证删除必成功；
/// - agent_events 按 also_delete_data 决定去留（false 保留历史流水，source_id 为普通列）；
/// - 用户任务与 task_agent_links 永不级联删除（任务侧显示「来源已移除」）。
///
/// 数据生命周期（v0.4 收尾定稿）：
/// - agent_sources 删除 ⇒ agent_sessions/agent_runs/agent_instances 必须删除（外键约束）；
/// - task_agent_links 保留为历史记录（无外键，v5 起带 origin 所有权语义）；
/// - navigation_targets 中的 agent_session 目标保留，运行态如实显示 `unavailable`，
///   用户可解除或重新关联；删除来源绝不让用户任务消失。
/// - 因此「删除来源之后」的备份仍然合法可恢复：导入侧将这类引用判为
///   历史失效（保留）而非伪造（拒绝），见 commands::data 模块注释。
#[tauri::command]
pub fn delete_source(db: State<'_, Arc<Db>>, id: String, also_delete_data: bool) -> AppResult<()> {
    delete_source_inner(&db, &id, also_delete_data)
}

pub(crate) fn delete_source_inner(db: &Db, id: &str, also_delete_data: bool) -> AppResult<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        // 先删子表（runs 经 session 级联，但显式删除顺序更稳）
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
        if also_delete_data {
            tx.execute(
                "DELETE FROM agent_events WHERE source_id = ?1",
                rusqlite::params![id],
            )?;
        }
        // task_agent_links 保留任务历史（不删 tasks，links 留作记录）
        tx.execute(
            "DELETE FROM agent_sources WHERE id = ?1",
            rusqlite::params![id],
        )?;
        tx.commit()?;
        Ok::<_, AppError>(())
    })
}

// ── 自动发现（第二阶段）────────────────────────────────────

/// 发现扫描是重 IO（注册表枚举、where 探测、进程列表，逐适配器执行），
/// 在 Tauri v2 里**同步命令跑在主线程**——点击 Agent 页挂载时触发扫描会把
/// 整个 UI 冻结到扫描结束（真机复现的「点 Agent 页卡死」）。
/// 因此必须 spawn_blocking 移出主线程；前端本来就是 promise 调用，签名不变。
#[tauri::command]
pub async fn discovery_scan(db: State<'_, Arc<Db>>) -> AppResult<Vec<discovery::DiscoveredAgent>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || discovery::scan_all(&db))
        .await
        .map_err(|e| AppError::Agent(format!("发现扫描任务失败: {e}")))
}

// ── 接入向导（一键接入：预览 → 确认 → 安装 → 验证）────────

/// 接入向导动作同样会做文件/配置写入与测试事件发送（秒级 IO），统一移出主线程。
/// 适配器实例是 `Box<dyn ManagedAdapter>`（Send + Sync），可以直接搬进阻塞线程。
#[tauri::command]
pub async fn adapter_preview(
    adapter_id: String,
    app: tauri::AppHandle,
) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = crate::app_data_dir(&app);
    tauri::async_runtime::spawn_blocking(move || a.preview(&app_data))
        .await
        .map_err(|e| AppError::Agent(format!("适配器预览任务失败: {e}")))?
}

#[tauri::command]
pub async fn adapter_install(
    adapter_id: String,
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = crate::app_data_dir(&app);
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || a.install(&app_data, &db))
        .await
        .map_err(|e| AppError::Agent(format!("适配器安装任务失败: {e}")))?
}

#[tauri::command]
pub async fn adapter_verify(
    adapter_id: String,
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = crate::app_data_dir(&app);
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || a.verify(&app_data, &db))
        .await
        .map_err(|e| AppError::Agent(format!("适配器验证任务失败: {e}")))?
}

#[tauri::command]
pub async fn adapter_uninstall(
    adapter_id: String,
    app: tauri::AppHandle,
) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = crate::app_data_dir(&app);
    tauri::async_runtime::spawn_blocking(move || a.uninstall(&app_data))
        .await
        .map_err(|e| AppError::Agent(format!("适配器卸载任务失败: {e}")))?
}

#[tauri::command]
pub async fn adapter_status(
    adapter_id: String,
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<serde_json::Value> {
    let a = managed::find_adapter(&adapter_id)
        .ok_or_else(|| AppError::Agent(format!("未知适配器: {}", adapter_id)))?;
    let app_data = crate::app_data_dir(&app);
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut status = a.config_status(&app_data)?;
        if let Some(obj) = status.as_object_mut() {
            obj.insert("health".into(), managed::source_health(&db, a.id()));
        }
        Ok::<_, AppError>(status)
    })
    .await
    .map_err(|e| AppError::Agent(format!("适配器状态任务失败: {e}")))?
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
    if mock::trigger(MockScenario {
        session_title,
        outcome,
    }) {
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
pub async fn codex_hooks_install(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<serde_json::Value> {
    let a =
        managed::find_adapter("codex").ok_or_else(|| AppError::Agent("codex 适配器缺失".into()))?;
    let app_data = crate::app_data_dir(&app);
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || a.install(&app_data, &db))
        .await
        .map_err(|e| AppError::Agent(format!("钩子安装任务失败: {e}")))?
}

#[tauri::command]
pub async fn codex_hooks_uninstall(app: tauri::AppHandle) -> AppResult<serde_json::Value> {
    let a =
        managed::find_adapter("codex").ok_or_else(|| AppError::Agent("codex 适配器缺失".into()))?;
    let app_data = crate::app_data_dir(&app);
    tauri::async_runtime::spawn_blocking(move || a.uninstall(&app_data))
        .await
        .map_err(|e| AppError::Agent(format!("钩子卸载任务失败: {e}")))?
}

/// 跳转到 Agent 会话（v0.4 起走统一导航系统：证据化能力 + 诚实降级）。
/// 导航会探测/唤起第三方进程（秒级），移出主线程避免 UI 冻结。
/// 返回结构化结果；前端也可用 nav_navigate(target_id) 获得相同语义。
#[tauri::command]
pub async fn open_agent_session(
    db: State<'_, Arc<Db>>,
    source_id: String,
    session_id: String,
) -> AppResult<crate::navigation::NavigationResult> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = crate::navigation::agent_navigation::resume_session(&db, &source_id, &session_id);
        crate::navigation::target_resolver::write_log(
            &db,
            &r,
            &format!("{}:{}", source_id, session_id),
        );
        if r.success {
            Ok(r)
        } else {
            Err(AppError::Agent(
                r.reason.unwrap_or_else(|| "跳转失败".into()),
            ))
        }
    })
    .await
    .map_err(|e| AppError::Agent(format!("会话跳转任务失败: {e}")))?
}

// ── 通知收件箱 ──────────────────────────────────────────────

/// 通知分页：只返回真实来源（测试/压测通知留作审计，不进入用户历史）。
/// 使用 (created_at, id) 键集游标；`has_more` 与 `filtered_total` 都基于同一筛选。
#[derive(Debug, serde::Serialize)]
pub struct NotificationPage {
    pub items: Vec<NotificationRow>,
    pub has_more: bool,
    pub filtered_total: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct NotificationInboxStats {
    pub unread: i64,
    pub total: i64,
}

#[tauri::command]
pub fn notification_page(
    db: State<'_, Arc<Db>>,
    source_id: Option<String>,
    since: Option<String>,
    before: Option<String>,
    limit: Option<i64>,
) -> AppResult<NotificationPage> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    db.with_read(|conn| {
        let mut filter = String::from(" WHERE agent_origin = 'real'");
        let mut filter_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(kind) = source_id.as_deref().filter(|s| !s.is_empty()) {
            filter.push_str(" AND kind = ?");
            filter_params.push(Box::new(kind.to_string()));
        }
        if let Some(since) = since.as_deref().filter(|s| !s.is_empty()) {
            filter.push_str(" AND julianday(created_at) >= julianday(?)");
            filter_params.push(Box::new(since.to_string()));
        }
        let total_refs: Vec<&dyn rusqlite::ToSql> =
            filter_params.iter().map(|p| p.as_ref()).collect();
        let filtered_total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM notification_history{}", filter),
            total_refs.as_slice(),
            |r| r.get(0),
        )?;

        let mut sql = format!(
            "SELECT id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at
             FROM notification_history{}",
            filter
        );
        let mut params = filter_params;
        if let Some(anchor) = before.as_deref().filter(|s| !s.is_empty()) {
            let anchor_ts: Option<String> = conn
                .query_row(
                    "SELECT created_at FROM notification_history WHERE id = ?1",
                    rusqlite::params![anchor],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(anchor_ts) = anchor_ts else {
                return Ok(NotificationPage {
                    items: Vec::new(),
                    has_more: false,
                    filtered_total,
                });
            };
            sql.push_str(" AND (created_at < ? OR (created_at = ? AND id < ?))");
            params.push(Box::new(anchor_ts.clone()));
            params.push(Box::new(anchor_ts));
            params.push(Box::new(anchor.to_string()));
        }
        sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");
        params.push(Box::new(limit + 1));
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| {
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
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        Ok(NotificationPage {
            items,
            has_more,
            filtered_total,
        })
    })
}

/// 全库未读/总数：不受列表分页或筛选影响，1000+ 通知也准确。
#[tauri::command]
pub fn notification_inbox_stats(db: State<'_, Arc<Db>>) -> AppResult<NotificationInboxStats> {
    db.with_read(|conn| {
        conn.query_row(
            "SELECT COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0), COUNT(*)
             FROM notification_history WHERE agent_origin = 'real'",
            [],
            |r| {
                Ok(NotificationInboxStats {
                    unread: r.get(0)?,
                    total: r.get(1)?,
                })
            },
        )
        .map_err(AppError::from)
    })
}

#[tauri::command]
pub fn mark_notification_read(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE notification_history SET is_read = 1 WHERE id = ?1 AND agent_origin = 'real'",
            rusqlite::params![id],
        )?;
        Ok::<_, AppError>(())
    })
}

#[tauri::command]
pub fn mark_all_notifications_read(db: State<'_, Arc<Db>>) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE notification_history SET is_read = 1
             WHERE is_read = 0 AND agent_origin = 'real'",
            [],
        )?;
        Ok::<_, AppError>(())
    })
}

#[tauri::command]
pub fn clear_notifications(db: State<'_, Arc<Db>>) -> AppResult<()> {
    db.with_conn(|conn| {
        // 只清用户可见的真实通知；测试/压测通知保留供数据审计。
        conn.execute(
            "DELETE FROM notification_history WHERE agent_origin = 'real'",
            [],
        )?;
        Ok::<_, AppError>(())
    })
}

/// Agent 事件流水（历史记录；扩展列：occurred_at / transport / evidence_type）。
/// `before` 为上一页最后一行的 id：按 (received_at, id) 键集分页，
/// 同一批次事件时间戳相同时也绝不会翻页丢行；只走只读连接池。
/// 只返回真实来源事件；筛选在数据库内完成，翻页与筛选口径一致。
#[derive(Debug, serde::Serialize)]
pub struct AgentEventPage {
    pub items: Vec<crate::db::AgentEventRow>,
    pub has_more: bool,
    pub filtered_total: i64,
}

#[tauri::command]
pub fn list_agent_events(
    db: State<'_, Arc<Db>>,
    source_id: Option<String>,
    since: Option<String>,
    before: Option<String>,
    limit: Option<i64>,
) -> AppResult<AgentEventPage> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    db.with_read(|conn| {
        let mut filter = String::from(" WHERE origin = 'real'");
        let mut filter_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(s) = source_id.as_deref().filter(|s| !s.is_empty()) {
            filter.push_str(" AND source_id = ?");
            filter_params.push(Box::new(s.to_string()));
        }
        if let Some(since) = since.as_deref().filter(|s| !s.is_empty()) {
            filter.push_str(" AND julianday(received_at) >= julianday(?)");
            filter_params.push(Box::new(since.to_string()));
        }
        let total_refs: Vec<&dyn rusqlite::ToSql> =
            filter_params.iter().map(|p| p.as_ref()).collect();
        let filtered_total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM agent_events{}", filter),
            total_refs.as_slice(),
            |r| r.get(0),
        )?;

        let mut sql = format!(
            "SELECT id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, occurred_at, transport, evidence_type
             FROM agent_events{}",
            filter
        );
        let mut params = filter_params;
        if let Some(anchor) = before.as_deref().filter(|s| !s.is_empty()) {
            let anchor_ts: Option<String> = conn
                .query_row(
                    "SELECT received_at FROM agent_events WHERE id = ?1",
                    rusqlite::params![anchor],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(anchor_ts) = anchor_ts else {
                return Ok(AgentEventPage {
                    items: Vec::new(),
                    has_more: false,
                    filtered_total,
                });
            };
            sql.push_str(" AND (received_at < ? OR (received_at = ? AND id < ?))");
            params.push(Box::new(anchor_ts.clone()));
            params.push(Box::new(anchor_ts));
            params.push(Box::new(anchor.to_string()));
        }
        sql.push_str(" ORDER BY received_at DESC, id DESC LIMIT ?");
        params.push(Box::new(limit + 1));
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| {
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
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        Ok(AgentEventPage {
            items,
            has_more,
            filtered_total,
        })
    })
}

// ── 事件保留 / 归档（P1）────────────────────────────────

/// 当前事件表规模与保护策略快照（诊断面板使用）。
#[tauri::command]
pub fn agent_retention_status(db: State<'_, Arc<Db>>) -> AppResult<serde_json::Value> {
    let settings = crate::db::Settings::load(&db)?;
    crate::agents::retention::retention_status(&db, &settings)
}

/// 手动执行一次保留策略（设置页按钮；归档完成才删除，失败不删）。
#[tauri::command]
pub async fn agent_retention_run(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<crate::agents::retention::RetentionReport> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = crate::db::Settings::load(&db)?;
        let dir = Some(crate::app_data_dir(&app));
        crate::agents::retention::run_retention(
            &db,
            &settings,
            dir.as_deref(),
            crate::agents::retention::MAX_PRUNE_PER_RUN,
        )
    })
    .await
    .map_err(|e| AppError::Agent(format!("事件保留任务中断: {}", e)))?
}

/// 归档文件清单（JSONL，可在文件管理器中打开/复制备份）。
#[tauri::command]
pub fn agent_archive_list(app: tauri::AppHandle) -> AppResult<Vec<serde_json::Value>> {
    let dir = crate::app_data_dir(&app);
    crate::agents::retention::list_archives(&dir)
}

/// 手动重试文件投递失败队列（failed/ 原文件移回收件箱，不删除）。
#[tauri::command]
pub fn agent_inbox_retry(app: tauri::AppHandle) -> AppResult<usize> {
    crate::agents::file_drop::retry_failed_inbox(&app)
}
