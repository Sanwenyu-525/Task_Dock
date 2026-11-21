//! UI 侧 Tauri 命令：Agent 接入管理、活动、交接、同步与权限。
//!
//! 全部命令只调用统一服务层，不另写 SQL；返回结构与 CLI/REST 尽量一致，
//! 前端无需为同一功能维护第二套解析逻辑。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{
    context, handoff, projection, sync as file_sync, watch, workspace, Principal, Source,
};

fn local() -> Principal {
    Principal::local(Source::Ui)
}

#[tauri::command]
pub fn agent_access_status(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    let workspace = workspace::status(&db)?;
    let sync = file_sync::status(&db)?;
    let rest = super::rest::status(&db);
    let cli_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("taskdock.exe")))
        .map(|p| p.to_string_lossy().to_string());
    let cli_installed = cli_path
        .as_deref()
        .map(|p| std::path::Path::new(p).exists())
        .unwrap_or(false);
    let agents = crate::mcp::auth::list_agents(&db)?;
    let (recent, _) = handoff::activity(&db, &local(), None, None, None, 10, 0)?;
    Ok(json!({
        "workspace": workspace,
        "sync": sync,
        "rest": rest,
        "cli": {
            "binary": "taskdock",
            "path": cli_path,
            "installed": cli_installed,
            "json_output": true,
            "requires_ui_open": false,
        },
        "agents": {
            "total": agents.len(),
            "active": agents.iter().filter(|a| a.revoked_at.is_none()).count(),
            "items": agents,
        },
        "recent_activity": recent,
        "watch": watch::status(),
    }))
}

#[tauri::command]
pub fn agent_access_init(
    db: State<'_, Arc<Db>>,
    path: Option<String>,
    name: Option<String>,
) -> AppResult<Value> {
    let row = workspace::init(&db, path.as_deref(), name.as_deref())?;
    let report = projection::export_all(&db, &row)?;
    let settings = crate::db::Settings::load(&db)?;
    let _ = watch::apply(db.inner().clone(), settings.agent_workspace_watch_enabled);
    Ok(json!({ "workspace": row, "export": report }))
}

#[tauri::command]
pub fn agent_access_manifest(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    workspace::manifest(&db)
}

#[tauri::command]
pub fn agent_access_export(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    let row = workspace::active(&db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    Ok(serde_json::to_value(projection::export_all(&db, &row)?)?)
}

#[tauri::command]
pub fn agent_access_scan(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    let row = workspace::active(&db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    // UI 手动扫描：身份是可信任本机，但目录策略与后台扫描完全一致，
    // 未授权文件只会进入待审核队列（人工批准走 agent_access_import_approve）。
    Ok(serde_json::to_value(file_sync::scan(&db, &local(), &row)?)?)
}

/// 待审核的导入请求（只读）。默认只看 pending。
#[tauri::command]
pub fn agent_access_import_requests(
    db: State<'_, Arc<Db>>,
    status: Option<String>,
) -> AppResult<Value> {
    Ok(serde_json::to_value(file_sync::list_import_requests(
        &db,
        status.as_deref().filter(|s| !s.is_empty()),
    )?)?)
}

#[tauri::command]
pub fn agent_access_import_approve(
    db: State<'_, Arc<Db>>,
    request_id: String,
    note: Option<String>,
) -> AppResult<Value> {
    let message = file_sync::approve_import(
        &db,
        &local(),
        &request_id,
        note.as_deref().unwrap_or(""),
    )?;
    Ok(json!({ "message": message }))
}

#[tauri::command]
pub fn agent_access_import_reject(
    db: State<'_, Arc<Db>>,
    request_id: String,
    reason: Option<String>,
) -> AppResult<Value> {
    file_sync::reject_import(&db, &local(), &request_id, reason.as_deref().unwrap_or(""))?;
    Ok(json!({ "ok": true }))
}

/// 目录级导入策略（默认无策略 = 待审核）。
#[tauri::command]
pub fn agent_access_import_policies(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    let row = workspace::active(&db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    Ok(serde_json::to_value(
        super::permissions::list_import_authorizations(&db, &row.id)?,
    )?)
}

#[tauri::command]
pub fn agent_access_import_policy_set(
    db: State<'_, Arc<Db>>,
    rel_dir: String,
    mode: String,
    agent_row_id: Option<String>,
    capabilities: Option<Vec<String>>,
    project_id: Option<String>,
) -> AppResult<Value> {
    let row = workspace::active(&db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    let mode = super::permissions::ImportMode::parse(&mode)
        .ok_or_else(|| AppError::Validation("mode 必须是 off|review|trusted".into()))?;
    let auth = super::permissions::upsert_import_authorization(
        &db,
        &row.id,
        &rel_dir,
        mode,
        agent_row_id.as_deref().filter(|v| !v.is_empty()),
        capabilities.as_deref().unwrap_or(&[]),
        project_id.as_deref().unwrap_or(""),
    )?;
    Ok(serde_json::to_value(auth)?)
}

#[tauri::command]
pub fn agent_access_import_policy_remove(
    db: State<'_, Arc<Db>>,
    authorization_id: String,
) -> AppResult<Value> {
    super::permissions::remove_import_authorization(&db, &authorization_id)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn agent_access_sync_status(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    Ok(serde_json::to_value(file_sync::status(&db)?)?)
}

#[tauri::command]
pub fn agent_access_conflicts(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    Ok(serde_json::to_value(file_sync::list_conflicts(&db)?)?)
}

/// 单条冲突详情：包含外部文件内容与允许的解决方式，供右侧面板展示。
#[tauri::command]
pub fn agent_access_conflict_detail(
    db: State<'_, Arc<Db>>,
    conflict_id: String,
) -> AppResult<Value> {
    file_sync::conflict_detail(&db, &conflict_id)
}

#[tauri::command]
pub fn agent_access_resolve_conflict(
    db: State<'_, Arc<Db>>,
    conflict_id: String,
    resolution: String,
) -> AppResult<Value> {
    Ok(serde_json::to_value(file_sync::resolve_conflict(
        &db,
        &local(),
        &conflict_id,
        &resolution,
    )?)?)
}

#[tauri::command]
pub fn agent_access_activity(
    db: State<'_, Arc<Db>>,
    agent_id: Option<String>,
    interface: Option<String>,
    since: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<Value> {
    let (items, page) = handoff::activity(
        &db,
        &local(),
        agent_id.as_deref(),
        interface.as_deref(),
        since.as_deref(),
        super::store::clamp_limit(limit),
        super::store::clamp_offset(offset),
    )?;
    Ok(json!({ "items": items, "page": page }))
}

#[tauri::command]
pub fn agent_access_handoffs(
    db: State<'_, Arc<Db>>,
    status: Option<String>,
    project_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<Value> {
    let (items, page) = handoff::list_handoffs(
        &db,
        &local(),
        status.as_deref(),
        project_id.as_deref(),
        super::store::clamp_limit(limit),
        super::store::clamp_offset(offset),
    )?;
    Ok(json!({ "items": items, "page": page }))
}

#[tauri::command]
pub fn agent_access_handoff_detail(
    db: State<'_, Arc<Db>>,
    handoff_id: String,
) -> AppResult<Value> {
    Ok(serde_json::to_value(handoff::get_handoff(
        &db,
        &local(),
        &handoff_id,
    )?)?)
}

#[tauri::command]
pub fn agent_access_handoff_transition(
    db: State<'_, Arc<Db>>,
    handoff_id: String,
    action: String,
    base_revision: i64,
    reason: Option<String>,
) -> AppResult<Value> {
    let principal = local();
    let result = match action.as_str() {
        "accept" => handoff::accept_handoff(&db, &principal, &handoff_id, base_revision)?,
        "reject" => handoff::reject_handoff(
            &db,
            &principal,
            &handoff_id,
            base_revision,
            reason.as_deref().unwrap_or(""),
        )?,
        "complete" => handoff::complete_handoff(&db, &principal, &handoff_id, base_revision)?,
        other => {
            return Err(AppError::Validation(format!(
                "action 必须是 accept|reject|complete（当前 {other}）"
            )))
        }
    };
    Ok(serde_json::to_value(result)?)
}

#[tauri::command]
pub fn agent_access_reports(
    db: State<'_, Arc<Db>>,
    agent_id: Option<String>,
    handoff_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<Value> {
    let (items, page) = handoff::list_reports(
        &db,
        &local(),
        agent_id.as_deref(),
        handoff_id.as_deref(),
        super::store::clamp_limit(limit),
        super::store::clamp_offset(offset),
    )?;
    Ok(json!({ "items": items, "page": page }))
}

#[tauri::command]
pub fn agent_access_agents(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    Ok(serde_json::to_value(handoff::list_agents(&db, &local())?)?)
}

#[tauri::command]
pub fn agent_access_permissions(
    db: State<'_, Arc<Db>>,
    agent_row_id: String,
) -> AppResult<Value> {
    let grants = crate::mcp::permissions::list(&db, &agent_row_id)?;
    Ok(json!({
        "capabilities": crate::mcp::permissions::CAPABILITIES,
        "grants": grants,
    }))
}

#[tauri::command]
pub fn agent_access_grant(
    db: State<'_, Arc<Db>>,
    agent_row_id: String,
    capability: String,
    resource_id: Option<String>,
) -> AppResult<Value> {
    Ok(serde_json::to_value(crate::mcp::permissions::grant(
        &db,
        &agent_row_id,
        &capability,
        resource_id.as_deref().unwrap_or(""),
    )?)?)
}

#[tauri::command]
pub fn agent_access_revoke(
    db: State<'_, Arc<Db>>,
    agent_row_id: String,
    capability: String,
    resource_id: Option<String>,
) -> AppResult<Value> {
    Ok(serde_json::to_value(crate::mcp::permissions::revoke(
        &db,
        &agent_row_id,
        &capability,
        resource_id.as_deref().unwrap_or(""),
    )?)?)
}

#[tauri::command]
pub fn agent_access_context(
    db: State<'_, Arc<Db>>,
    project_id: Option<String>,
    task: Option<String>,
    task_id: Option<String>,
    budget_tokens: Option<u32>,
    format: Option<String>,
) -> AppResult<Value> {
    let ctx = context::build(
        &db,
        &local(),
        context::ContextRequest {
            project_id,
            task,
            task_id,
            budget_tokens,
            format,
            ..Default::default()
        },
    )?;
    context::to_json(&ctx)
}

#[tauri::command]
pub fn agent_access_config_info(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    let settings = crate::db::Settings::load(&db)?;
    Ok(json!({
        "workspace_path_setting": settings.agent_workspace_path,
        "default_workspace_path": workspace::default_path(&db).to_string_lossy(),
        "watch_enabled": settings.agent_workspace_watch_enabled,
        "rest_enabled": settings.agent_api_enabled,
        "rest_port": settings.agent_api_port,
        "mcp_enabled": settings.mcp_server_enabled,
        "cli_env": {
            "TASKDOCK_AGENT_TOKEN": "可选：以 Agent 身份调用 CLI（未设置则等价本机用户）",
            "TASKDOCK_CLI_READONLY": "设为 1 强制只读",
            "TASK_DOCK_DATA_DIR": "覆盖数据目录（与桌面端一致）"
        },
        "remote_allowed": false,
    }))
}

// ── Agent 操作生命周期（v86）─────────────────────────────────────
//
// 前端只保留一个游标：启动时全量恢复运行中操作，随后用 `agent_operations_sync`
// 增量补齐。独立 CLI 进程没有 Tauri 事件，因此数据库游标是跨进程的唯一真源。

/// 游标增量同步（跨进程 CLI 与事件丢失恢复）。
#[tauri::command]
pub fn agent_operations_sync(
    db: State<'_, Arc<Db>>,
    cursor: Option<super::operations::OperationCursor>,
    limit: Option<u32>,
) -> AppResult<super::operations::OperationSync> {
    super::operations::sync_since(&db, cursor.as_ref(), limit.unwrap_or(50))
}

/// 当前运行中的操作（支持项目 / 资源过滤，数量受限）。
#[tauri::command]
pub fn agent_operations_active(
    db: State<'_, Arc<Db>>,
    project_id: Option<String>,
    resource_kind: Option<String>,
    resource_id: Option<String>,
    limit: Option<u32>,
) -> AppResult<Value> {
    let filter = super::operations::ActiveFilter {
        project_id,
        resource_kind,
        resource_id,
        limit: limit.unwrap_or(20),
    };
    let items = super::operations::active(&db, &filter)?;
    Ok(json!({ "items": items, "count": items.len() }))
}

/// 历史分页（Agent / 资源类型 / 状态 / 时间范围）。
#[tauri::command]
pub fn agent_operations_list(
    db: State<'_, Arc<Db>>,
    agent_id: Option<String>,
    resource_kind: Option<String>,
    status: Option<String>,
    since: Option<String>,
    until: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<Value> {
    let query = super::operations::OperationQuery {
        agent_id,
        resource_kind,
        status,
        since,
        until,
        limit: limit.unwrap_or(50),
        offset: offset.unwrap_or(0),
    };
    let (items, page) = super::operations::list(&db, &query)?;
    Ok(json!({ "items": items, "page": page }))
}
