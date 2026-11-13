//! 拖入提交命令：前端只拿 `operation_id`，**拿不到也传不进任意路径**。
//!
//! 三个入口：
//! - `drag_payload_commit_shelf`：落到最近暂存（shelf 库）；
//! - `drag_payload_commit_directory`：落到目录目标卡片；
//! - `drag_payload_discard`：未命中任何落点/用户取消时释放暂存副本。
//!
//! 失败一律写诊断中心（含稳定错误码），因为拖入失败最常见的就是「看起来没反应」，
//! 没有可观测性就永远查不出根因。日志只记码、类型、计数，不记正文/路径。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::shelf::ShelfState;
use crate::diagnostics::{self, DiagLevel, DiagStatus, Diagnostics};
use crate::dragdrop::commit::{self, DragCommitReport};
use crate::dragdrop::{bridge_active, codes, DragDropState};
use crate::error::{AppError, AppResult};
use crate::shelf::fsops::DropReport;

/// 前端据 `active` 决定：走新原生桥，还是退回 Tauri 内置的 `drag-drop` 事件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragBridgeStatus {
    /// 原生桥是否安装成功（false ⇒ 只支持本地文件路径，与改造前一致）。
    pub active: bool,
    pub max_items: usize,
    pub max_text_bytes: usize,
    pub max_image_bytes: u64,
}

#[tauri::command]
pub fn drag_bridge_status() -> DragBridgeStatus {
    DragBridgeStatus {
        active: bridge_active(),
        max_items: crate::dragdrop::MAX_ITEMS,
        max_text_bytes: crate::dragdrop::MAX_TEXT_BYTES,
        max_image_bytes: crate::dragdrop::MAX_IMAGE_BYTES,
    }
}

#[tauri::command]
pub async fn drag_payload_commit_shelf(
    state: State<'_, Arc<ShelfState>>,
    drag: State<'_, Arc<DragDropState>>,
    diag: State<'_, Arc<Diagnostics>>,
    operation_id: String,
    storage_mode: Option<String>,
    group_id: Option<String>,
) -> AppResult<DragCommitReport> {
    let st = state.inner().clone();
    let ds = drag.inner().clone();
    let mode = storage_mode.unwrap_or_else(|| crate::shelf::MODE_REFERENCE.into());
    let op_id = operation_id.clone();
    let started = std::time::Instant::now();

    let result = tauri::async_runtime::spawn_blocking(move || {
        commit::commit_to_shelf(&st, &ds, &operation_id, &mode, group_id.as_deref())
    })
    .await
    .map_err(|e| AppError::Agent(format!("暂存提交任务失败: {e}")))?;

    let elapsed = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    match &result {
        Ok(report) => {
            let failed = report.failed.len();
            diagnostics::emit(
                diagnostics::event(
                    DiagLevel::Info,
                    "dragdrop",
                    "commit-shelf",
                    "drag-payload",
                )
                .status(if failed > 0 {
                    DiagStatus::Failed
                } else {
                    DiagStatus::Success
                })
                .stage("persist")
                .operation(&op_id)
                .duration_ms(elapsed)
                .metadata("kind", serde_json::json!(report.kind))
                .metadata("added", serde_json::json!(report.added.len()))
                .metadata("failed", serde_json::json!(failed))
                .metadata("skipped", serde_json::json!(report.skipped))
                .build(),
            );
        }
        Err(e) => {
            let _ = diag.record(
                diagnostics::event(
                    DiagLevel::Warn,
                    "dragdrop",
                    "commit-shelf",
                    "drag-payload",
                )
                .status(DiagStatus::Failed)
                .stage("persist")
                .operation(&op_id)
                .duration_ms(elapsed)
                .error_code(e.code())
                .error_category(e.category().as_str())
                .message(format!("拖入内容暂存失败: {e}"))
                .build(),
            );
        }
    }
    result
}

#[tauri::command]
pub async fn drag_payload_commit_directory(
    state: State<'_, Arc<ShelfState>>,
    drag: State<'_, Arc<DragDropState>>,
    diag: State<'_, Arc<Diagnostics>>,
    operation_id: String,
    target_id: String,
    batch_id: Option<String>,
) -> AppResult<DropReport> {
    let st = state.inner().clone();
    let ds = drag.inner().clone();
    let op_id = operation_id.clone();
    // 批号必须是我们自己的 UUID/operation id：既有 fsops 会把它写进投递日志。
    let batch = batch_id.unwrap_or_else(|| format!("drag-{op_id}"));
    let started = std::time::Instant::now();

    let result = tauri::async_runtime::spawn_blocking(move || {
        commit::commit_to_directory(&st, &ds, &operation_id, &target_id, &batch)
    })
    .await
    .map_err(|e| AppError::Agent(format!("目录投递任务失败: {e}")))?;

    if let Ok(report) = &result {
        let elapsed = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        for event in crate::shelf::fsops::drop_diagnostic_events(report, elapsed) {
            // 非阻塞入队；队列满/日志降级只计数，不改变投递结果。
            let _ = diag.record(event);
        }
    } else if let Err(e) = &result {
        let _ = diag.record(
            diagnostics::event(
                DiagLevel::Warn,
                "dragdrop",
                "commit-directory",
                "drag-payload",
            )
            .status(DiagStatus::Failed)
            .stage("persist")
            .operation(&op_id)
            .error_code(e.code())
            .error_category(e.category().as_str())
            .message(format!("拖入内容投递到目录失败: {e}"))
            .build(),
        );
    }
    result
}

/// 放弃一次拖入会话（未命中落点、用户取消、面板关闭）：释放暂存副本。
#[tauri::command]
pub fn drag_payload_discard(
    drag: State<'_, Arc<DragDropState>>,
    operation_id: String,
) -> AppResult<bool> {
    Ok(drag.inner().discard(&operation_id))
}

/// 供前端在拖入异常时补一条诊断（例如暂存提交成功但 UI 渲染失败）。
///
/// 只接受**枚举化**的码与短标签，不接受任意文本，避免把内容写进日志。
#[tauri::command]
pub fn drag_report_client_issue(code: String, stage: String) -> AppResult<()> {
    let known = [
        codes::DRAG_FORMAT_UNSUPPORTED,
        codes::DRAG_NO_READABLE_CONTENT,
        codes::DRAG_PAYLOAD_INVALID,
        codes::DRAG_TARGET_UNAVAILABLE,
        codes::DRAG_COMMIT_FAILED,
        codes::DRAG_OPERATION_EXPIRED,
    ];
    if !known.contains(&code.as_str()) {
        return Err(AppError::Validation(format!("未知拖入错误码: {code}")));
    }
    let stage: String = stage
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(32)
        .collect();
    diagnostics::emit(
        diagnostics::event(DiagLevel::Warn, "dragdrop", "client", "drag-payload")
            .status(DiagStatus::Failed)
            .stage(if stage.is_empty() { "ui" } else { &stage })
            .error_code(&code)
            .error_category(codes::category(&code))
            .message(codes::message(&code))
            .build(),
    );
    Ok(())
}
