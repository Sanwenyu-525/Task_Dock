//! 诊断日志 IPC：上报、查询、摘要、状态、清理、导出、打开目录。
//!
//! 约定：
//! - 上报命令**永不因为日志内容非法而失败整批**：非法条目计入 `rejected`；
//! - 查询/摘要/导出都是重 IO，走 `spawn_blocking`，不占命令线程；
//! - 清理只删除诊断目录内本模块命名规则的文件（见 `diagnostics::writer`）。

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::diagnostics::{
    self, query, DiagnosticPage, DiagnosticQuery, DiagnosticSummary, Diagnostics,
};
use crate::error::{AppError, AppResult};

/// 单批上报上限（前端正常批量远小于此值）。
const MAX_BATCH: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResult {
    pub accepted: u32,
    pub rejected: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsStatus {
    pub session_id: String,
    pub started_at: String,
    pub log_dir: String,
    /// `normal` | `verbose`
    pub mode: String,
    pub verbose_remaining_ms: u64,
    pub files: Vec<query::LogFile>,
    pub total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_archive_files: usize,
    pub written: u64,
    pub dropped: u64,
    pub queue_full: u64,
    pub aggregated: u64,
    pub rotations: u64,
    pub failures: u64,
    pub skipped_lines: u64,
    /// true = 日志目录不可用，当前只降级计数（业务不受影响）。
    pub degraded: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    pub removed_bytes: u64,
    /// 是否真正执行完成（超时/取消时为 false，日志未被删除）。
    pub completed: bool,
    pub status: DiagnosticsStatus,
}

fn status_of(diag: &Diagnostics) -> DiagnosticsStatus {
    let counters = diag.counters().snapshot();
    DiagnosticsStatus {
        session_id: diag.session_id().to_string(),
        started_at: diag.started_at().to_string(),
        log_dir: diag.dir().display().to_string(),
        mode: if diag.is_verbose() {
            "verbose"
        } else {
            "normal"
        }
        .to_string(),
        verbose_remaining_ms: diag.verbose_remaining_ms(),
        total_bytes: diag.total_bytes(),
        files: diag.file_snapshot(),
        max_file_bytes: diagnostics::MAX_FILE_BYTES,
        max_total_bytes: diagnostics::MAX_TOTAL_BYTES,
        max_archive_files: diagnostics::MAX_ARCHIVE_FILES,
        written: counters[0],
        dropped: counters[1],
        queue_full: counters[2],
        aggregated: counters[3],
        rotations: counters[4],
        failures: counters[5],
        skipped_lines: counters[6],
        degraded: diag.is_disabled(),
        last_error: diag.last_writer_error(),
    }
}

/// 把一条前端上报的 JSON 解析为合法事件；非法返回 `None`。
///
/// 只信任尽量少的字段：`level`/`module`/`action` 必须存在；`session_id`/`timestamp`/
/// `count`/`source` 一律由后端重写，避免多窗口伪造时钟、计数或来源。
fn parse_frontend_event(raw: Value) -> Option<diagnostics::DiagnosticEvent> {
    let object = raw.as_object()?;
    for required in ["level", "module", "action"] {
        let value = object.get(required)?.as_str()?.trim();
        if value.is_empty() {
            return None;
        }
    }
    let mut event: diagnostics::DiagnosticEvent = serde_json::from_value(raw).ok()?;
    event.session_id.clear();
    event.timestamp.clear();
    event.count = 1;
    event.source = diagnostics::DiagSource::Frontend;
    Some(event)
}

/// 批量上报前端诊断事件（非阻塞入队）。永远返回 Ok，除非参数整体不是数组。
#[tauri::command]
pub fn diagnostics_record(
    diag: State<'_, Arc<Diagnostics>>,
    events: Vec<Value>,
) -> AppResult<RecordResult> {
    let mut accepted = 0u32;
    let mut rejected = 0u32;
    for (index, raw) in events.into_iter().enumerate() {
        if index >= MAX_BATCH {
            rejected = rejected.saturating_add(1);
            continue;
        }
        match parse_frontend_event(raw) {
            Some(event) => {
                if diag.record(event) {
                    accepted = accepted.saturating_add(1);
                } else {
                    rejected = rejected.saturating_add(1);
                }
            }
            None => rejected = rejected.saturating_add(1),
        }
    }
    Ok(RecordResult { accepted, rejected })
}

#[tauri::command]
pub fn diagnostics_status(diag: State<'_, Arc<Diagnostics>>) -> AppResult<DiagnosticsStatus> {
    Ok(status_of(&diag))
}

/// 切换诊断模式（`normal` / `verbose`）。详细模式默认 30 分钟，最长 120 分钟。
#[tauri::command]
pub fn diagnostics_set_mode(
    diag: State<'_, Arc<Diagnostics>>,
    mode: String,
    minutes: Option<u32>,
) -> AppResult<DiagnosticsStatus> {
    let verbose = match mode.trim().to_ascii_lowercase().as_str() {
        "verbose" => true,
        "normal" => false,
        other => {
            return Err(AppError::Validation(format!(
                "未知诊断模式: {other}（可选 normal/verbose）"
            )))
        }
    };
    diag.set_mode(verbose, minutes);
    Ok(status_of(&diag))
}

/// 分页查询（新→旧）。
#[tauri::command]
pub async fn diagnostics_query(
    diag: State<'_, Arc<Diagnostics>>,
    filter: DiagnosticQuery,
) -> AppResult<DiagnosticPage> {
    let diag = diag.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = diag.dir().to_path_buf();
        Ok(query::query(&dir, &filter, diag.counters()))
    })
    .await
    .map_err(|e| AppError::Agent(format!("诊断查询任务失败: {e}")))?
}

/// 错误摘要（分组统计）。
#[tauri::command]
pub async fn diagnostics_summary(
    diag: State<'_, Arc<Diagnostics>>,
    filter: DiagnosticQuery,
) -> AppResult<DiagnosticSummary> {
    let diag = diag.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = diag.dir().to_path_buf();
        Ok(query::summary(&dir, &filter, diag.counters()))
    })
    .await
    .map_err(|e| AppError::Agent(format!("诊断摘要任务失败: {e}")))?
}

/// 生成脱敏诊断报告（本机文件，不上传）。
#[tauri::command]
pub async fn diagnostics_export(
    diag: State<'_, Arc<Diagnostics>>,
    filter: DiagnosticQuery,
) -> AppResult<query::ExportResult> {
    let diag = diag.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 先刷盘并取得**可信结果**：无法确认时报告里如实标记，不伪装完整。
        let flush = diag.flush_blocking();
        let dir = diag.dir().to_path_buf();
        query::export(&dir, &diag, &filter, flush)
    })
    .await
    .map_err(|e| AppError::Agent(format!("诊断导出任务失败: {e}")))?
}

/// 清空诊断日志（只动诊断目录，不触碰任务/工作流/备份/恢复记录）。
#[tauri::command]
pub async fn diagnostics_clear(diag: State<'_, Arc<Diagnostics>>) -> AppResult<ClearResult> {
    let handle = diag.inner().clone();
    let worker = handle.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || worker.clear())
        .await
        .map_err(|e| AppError::Agent(format!("诊断清理任务失败: {e}")))??;
    Ok(ClearResult {
        removed_bytes: outcome.removed_bytes,
        completed: outcome.completed,
        status: status_of(&handle),
    })
}

/// 在资源管理器中打开日志目录（目录不存在时先创建）。
#[tauri::command]
pub fn diagnostics_open_dir(diag: State<'_, Arc<Diagnostics>>) -> AppResult<()> {
    let dir = diag.dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(&dir)
            .spawn()
            .map_err(|e| AppError::Unavailable(format!("无法打开日志目录: {e}")))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        // 当前发布目标是 Windows；其它平台不猜测文件管理器行为。
        let _ = dir;
        Err(AppError::Unavailable(
            "当前平台未实现打开日志目录".to_string(),
        ))
    }
}
