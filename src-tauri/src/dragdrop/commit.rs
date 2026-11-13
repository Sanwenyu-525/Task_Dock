//! 把暂存会话**提交**到两个真实落点：最近暂存（shelf 库）与目录目标卡片。
//!
//! 分工（不重复建设）：
//! - 暂存架条目一律复用 `shelf::add_reference` / `add_managed` / `add_managed_from` /
//!   `add_link` / `add_text`：配额、磁盘余量、流式复制、原子改名、缩略图、
//!   去重与分组全部沿用既有实现；
//! - 目录投递一律复用 `fsops::drop_paths`：冲突策略（skip/rename）、复制/移动、
//!   日志与批处理报告都沿用既有实现；
//! - 本模块只负责「把暂存条目翻译成既有入参」，不新写任何文件搬运逻辑。
//!
//! 安全边界：
//! - 暂存条目里的 `path` 只可能来自后端自己的暂存目录（UUID 会话目录下），
//!   前端无法指定；`LocalPath` 则来自 OLE `CF_HDROP` 的真实路径；
//! - 网页链接 / 文本 / HTML **不产生文件**，因此目录落点直接拒绝，
//!   不做「悄悄写一个 .txt」的隐式转换；
//! - 提交成功或失败都会删除暂存目录，`operation_id` 一次消费后即失效。

use std::path::Path;

use serde::Serialize;

use crate::commands::shelf::ShelfFailedEntry;
use crate::error::{AppError, AppResult};
use crate::shelf::drop_targets;
use crate::shelf::fsops::{self, DropReport};
use crate::shelf::{self, ShelfItem, ShelfState, MODE_MANAGED, MODE_REFERENCE};

use super::payload::{DragPayloadView, PayloadFailure};
use super::stage;
use super::{codes, DragDropState, OpPhase, StagedItem, StagedKind};

/// 目录落点拒绝非文件类型时的稳定文案（不含任何来源内容）。
const DIR_UNSUPPORTED_MSG: &str = 
    "此内容不能直接投递到文件夹：链接与文本不会自动生成文件。请先拖入最近暂存";

/// 统一提交报告：暂存架与目录卡片共用一份结构，前端按 `kind` 分流展示。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragCommitReport {
    pub operation_id: String,
    /// `local-files` | `virtual-files` | `image` | `url` | `text` | `html` | `mixed`
    pub kind: String,
    pub added: Vec<ShelfItem>,
    pub failed: Vec<ShelfFailedEntry>,
    /// 拖入阶段就失败/丢弃的条目（与 `failed` 分开：这些从未进入提交）。
    pub failures: Vec<PayloadFailure>,
    pub skipped: usize,
}

/// 提交前的统一校验：会话必须存在、已读取完成、且未被消费。
fn take_ready_op(
    state: &DragDropState,
    operation_id: &str,
) -> AppResult<std::sync::Arc<super::StagedOp>> {
    let Some(op) = state.get(operation_id) else {
        return Err(AppError::NotFound(format!(
            "{}：{}",
            super::codes::DRAG_OPERATION_EXPIRED,
            operation_id
        )));
    };
    if op.snapshot().0 == OpPhase::Reading {
        // 仍在读流：**不**消费会话，让前端重试；此时 take 会把条目吞掉。
        return Err(AppError::Unavailable(
            "拖入内容仍在读取，请稍后重试".into(),
        ));
    }
    state
        .take_for_commit(operation_id)
        .ok_or_else(|| AppError::Conflict("该拖入内容已被处理，请勿重复提交".into()))
}

/// 提交到「最近暂存」。
///
/// `storage_mode` 只影响**真实本地路径**（`reference` 不复制 / `managed` 复制）；
/// 虚拟文件与图片字节本来就是后端副本，必须托管，忽略该参数。
pub fn commit_to_shelf(
    st: &ShelfState,
    drop_state: &DragDropState,
    operation_id: &str,
    storage_mode: &str,
    group_id: Option<&str>,
) -> AppResult<DragCommitReport> {
    if !matches!(storage_mode, MODE_REFERENCE | MODE_MANAGED) {
        return Err(AppError::Validation(format!(
            "未知存储模式: {storage_mode}"
        )));
    }
    let op = take_ready_op(drop_state, operation_id)?;
    let (phase, items, failures, view) = op.snapshot();
    let kind = view
        .as_ref()
        .map(|v| v.kind().to_string())
        .unwrap_or_else(|| "unsupported".into());

    let mut added: Vec<ShelfItem> = Vec::new();
    let mut failed: Vec<ShelfFailedEntry> = Vec::new();
    let mut skipped = 0usize;

    if phase == OpPhase::Failed && items.is_empty() {
        // 全部失败：如实返回失败，不制造「0 条成功」的假象。
        stage::remove_dir(&op.dir);
        return Ok(DragCommitReport {
            operation_id: op.id.clone(),
            kind,
            added,
            failed,
            failures,
            skipped,
        });
    }

    for item in &items {
        match item {
            StagedItem::LocalPath { path } => {
                let _permit = st.acquire_copy_permit();
                let result = if storage_mode == MODE_MANAGED {
                    shelf::add_managed(&st.db, &st.root, path, "drag", group_id)
                } else {
                    shelf::add_reference(&st.db, &st.root, path, "drag", group_id)
                };
                match result {
                    Ok(item) => added.push(item),
                    Err(e) => failed.push(failed_entry(path.clone(), &e)),
                }
            }
            StagedItem::Staged {
                path,
                name,
                kind: item_kind,
                ..
            } => {
                // 图片与虚拟文件都走「无原始路径」的托管入口；
                // **绝不**把暂存临时路径写成 original_path。
                let _permit = st.acquire_copy_permit();
                let display = match item_kind {
                    StagedKind::Image => Some(name.as_str()),
                    StagedKind::VirtualFile => Some(name.as_str()),
                };
                match shelf::add_managed_from(&st.db, &st.root, path, display, "drag", group_id)
                {
                    Ok(item) => added.push(item),
                    Err(e) => failed.push(failed_entry(name.clone(), &e)),
                }
            }
            StagedItem::Text { text, from_html } => {
                let source = if *from_html { "drag-html" } else { "drag" };
                match shelf::add_text(&st.db, text, source, group_id) {
                    Ok(item) => added.push(item),
                    Err(e) => failed.push(failed_entry("文本内容".into(), &e)),
                }
            }
            StagedItem::Url { url, .. } => match shelf::add_link(&st.db, url, group_id) {
                Ok(item) => added.push(item),
                Err(e) => failed.push(failed_entry("网页链接".into(), &e)),
            },
        }
    }

    // 无论成功与否都清理暂存目录：已托管的条目在 shelf 目录里另有副本。
    stage::remove_dir(&op.dir);

    Ok(DragCommitReport {
        operation_id: op.id.clone(),
        kind,
        added,
        failed,
        failures,
        skipped,
    })
}

/// 提交到「目录目标卡片」。
///
/// 只有会变成真实文件的类型可以投递（本地路径 / 虚拟文件 / 图片字节）；
/// 链接、文本、HTML 明确拒绝，绝不隐式生成文件。
pub fn commit_to_directory(
    st: &ShelfState,
    drop_state: &DragDropState,
    operation_id: &str,
    target_id: &str,
    batch_id: &str,
) -> AppResult<DropReport> {
    let op = take_ready_op(drop_state, operation_id)?;
    let (phase, items, _failures, view) = op.snapshot();

    let allow = view
        .as_ref()
        .map(|v| v.can_drop_to_directory())
        .unwrap_or(false)
        || items.iter().any(|i| {
            matches!(
                i,
                StagedItem::LocalPath { .. } | StagedItem::Staged { .. }
            )
        });
    if phase == OpPhase::Failed && items.is_empty() {
        stage::remove_dir(&op.dir);
        return Err(AppError::Validation(format!(
            "{}：{}",
            super::codes::DRAG_NO_READABLE_CONTENT,
            "拖入内容没有可投递的文件"
        )));
    }
    if !allow {
        stage::remove_dir(&op.dir);
        return Err(AppError::Validation(format!(
            "{}：{DIR_UNSUPPORTED_MSG}",
            codes::DRAG_TARGET_UNAVAILABLE
        )));
    }

    let target = drop_targets::get(&st.db, target_id)?;
    let mut paths: Vec<String> = Vec::new();
    for item in &items {
        match item {
            StagedItem::LocalPath { path } => paths.push(path.clone()),
            StagedItem::Staged { path, name, .. } => {
                // 防御：只接受仍在本会话暂存目录内的副本（防止被替换成指向别处的链接）。
                if !staged_path_in_session(&op.dir, path) {
                    tracing::warn!("暂存副本不在会话目录内，已跳过");
                    continue;
                }
                paths.push(path.to_string_lossy().to_string());
                let _ = name;
            }
            // 文本/链接不产生文件：直接忽略，由上面的 `allow` 决定整体是否拒绝。
            _ => {}
        }
    }
    if paths.is_empty() {
        stage::remove_dir(&op.dir);
        return Err(AppError::Validation(format!(
            "{}：{DIR_UNSUPPORTED_MSG}",
            codes::DRAG_TARGET_UNAVAILABLE
        )));
    }

    // 复用既有投递实现：冲突策略、复制/移动、报告与诊断都在 fsops 里。
    let report = fsops::drop_paths(&st.db, &st.root, &target, &paths, batch_id);
    stage::remove_dir(&op.dir);
    report
}

fn failed_entry(label: String, e: &AppError) -> ShelfFailedEntry {
    ShelfFailedEntry {
        path: label,
        reason: e.to_string(),
        code: Some(e.code().to_string()),
        category: Some(e.category().as_str().to_string()),
    }
}

/// 目录落点的可用性预判（供命令层在真正 copy 之前给出稳定错误码）。
pub fn can_drop_to_directory(view: Option<&DragPayloadView>, items: &[StagedItem]) -> bool {
    if let Some(view) = view {
        if view.can_drop_to_directory() {
            return true;
        }
    }
    items
        .iter()
        .any(|i| matches!(i, StagedItem::LocalPath { .. } | StagedItem::Staged { .. }))
}

/// 暂存副本的物理路径是否仍在本会话目录内（防止被替换成指向别处的链接）。
pub fn staged_path_in_session(dir: &Path, path: &Path) -> bool {
    let Ok(canon_dir) = std::fs::canonicalize(dir) else {
        return false;
    };
    let Ok(canon_path) = std::fs::canonicalize(path) else {
        return false;
    };
    canon_path.starts_with(&canon_dir)
}
