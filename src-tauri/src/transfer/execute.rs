//! 发送执行：预览、提交真实文件写入/复制/移动、批次终态回写、失败重试、撤销。
//!
//! 职责边界：
//! - 本模块**不实现**文件系统语义，一律复用 `file_workspace`（校验/冲突/复制/移动）与
//!   `fsops`（排队/并发/取消/逐条报告/回收站）；
//! - 目标目录必须显式传入并校验，「当前上下文」只用于推荐，绝不代替显式目标；
//! - 部分成功如实回写：条目状态按逐条结果更新，不用整体布尔值掩盖失败。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::Connection;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::clipboard;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::file_workspace as fw;
use crate::fsops::{self, WriteEntry};

use super::batches::{self, BatchUpdate, NewBatch};
use super::store;
use super::{
    BatchEntry, BatchUndoResult, PreviewConflict, PreviewCounts, PreviewUnsupported,
    TargetValidation, TransferBatch, TransferItem, TransferOptions, TransferPreview,
    TransferTarget, DEFAULT_SENT_RETENTION_DAYS, MAX_ADD_BATCH,
};

pub const BATCH_EVENT: &str = "transfer:batch-changed";
const MAX_PREVIEW_CONFLICTS: usize = 50;

fn retention(options: &TransferOptions) -> i64 {
    options
        .sent_retention_days
        .unwrap_or(DEFAULT_SENT_RETENTION_DAYS)
        .max(0)
}

fn stem_of(title: &str, fallback: &str) -> String {
    let base = if title.trim().is_empty() {
        fallback
    } else {
        title.trim()
    };
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .take(80)
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn merge_name(format: &str) -> String {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    format!("工作篮合并-{stamp}.{format}")
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

#[derive(Debug, Clone)]
enum PlannedSource {
    Text(String),
    CopyFrom(String),
}

#[derive(Debug, Clone)]
struct PlannedWrite {
    item_ids: Vec<String>,
    label: String,
    name: String,
    source: PlannedSource,
}

#[derive(Debug, Clone)]
struct PlannedPath {
    item_id: String,
    label: String,
    path: String,
    is_dir: bool,
    size: u64,
}

struct Plan {
    written: Vec<PlannedWrite>,
    copies: Vec<PlannedPath>,
    moves: Vec<PlannedPath>,
    unsupported: Vec<PreviewUnsupported>,
    conflicts: Vec<PreviewConflict>,
    counts: PreviewCounts,
    estimated_bytes: i64,
}

struct NameBook {
    used: std::collections::HashSet<String>,
}

impl NameBook {
    fn new() -> Self {
        Self {
            used: Default::default(),
        }
    }

    fn unique(&mut self, dir: &Path, base: &str) -> String {
        let candidate = base.to_string();
        if !self.used.contains(&candidate.to_ascii_lowercase()) && !dir.join(&candidate).exists() {
            self.used.insert(candidate.to_ascii_lowercase());
            return candidate;
        }
        let (stem, ext) = match base.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), Some(e.to_string())),
            _ => (base.to_string(), None),
        };
        for n in 2..=1000 {
            let attempt = match &ext {
                Some(ext) => format!("{stem} ({n}).{ext}"),
                None => format!("{stem} ({n})"),
            };
            if !self.used.contains(&attempt.to_ascii_lowercase()) && !dir.join(&attempt).exists() {
                self.used.insert(attempt.to_ascii_lowercase());
                return attempt;
            }
        }
        let fallback = format!("{stem} (dup)");
        self.used.insert(fallback.to_ascii_lowercase());
        fallback
    }
}

fn count_type(counts: &mut PreviewCounts, item_type: &str) {
    match item_type {
        "text" => counts.text += 1,
        "richtext" => counts.richtext += 1,
        "image" => counts.image += 1,
        "file" => counts.file += 1,
        "directory" => counts.directory += 1,
        "url" => counts.url += 1,
        "clipboard" => counts.clipboard += 1,
        "task" | "project" | "planning" | "knowledge" | "capture" => counts.entity += 1,
        _ => counts.unsupported += 1,
    }
}

fn build_plan(
    conn: &Connection,
    root: &Path,
    items: &[TransferItem],
    target_dir: &Path,
    options: &TransferOptions,
) -> AppResult<Plan> {
    let mut plan = Plan {
        written: Vec::new(),
        copies: Vec::new(),
        moves: Vec::new(),
        unsupported: Vec::new(),
        conflicts: Vec::new(),
        counts: PreviewCounts::default(),
        estimated_bytes: 0,
    };
    let mut names = NameBook::new();
    let merge_text = options.text_mode == "merge";
    let text_ext = if options.text_format == "md" {
        "md"
    } else {
        "txt"
    };
    let mut merge_parts: Vec<(Vec<String>, String)> = Vec::new();

    for item in items {
        count_type(&mut plan.counts, &item.item_type);
        if !item.available {
            plan.counts.unsupported += 1;
            plan.unsupported.push(PreviewUnsupported {
                item_id: item.id.clone(),
                title: item.title.clone(),
                reason: format!(
                    "来源已失效（{}）",
                    if item.unavailable_reason.is_empty() {
                        "TRANSFER_SOURCE_MISSING"
                    } else {
                        item.unavailable_reason.as_str()
                    }
                ),
            });
            continue;
        }
        match item.item_type.as_str() {
            "text" | "richtext" => {
                let text = store::resolve_text(conn, item)?;
                if text.trim().is_empty() {
                    plan.counts.unsupported += 1;
                    plan.unsupported.push(PreviewUnsupported {
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        reason: "正文为空".into(),
                    });
                    continue;
                }
                if merge_text {
                    merge_parts.push((vec![item.id.clone()], text));
                } else {
                    let name = names.unique(
                        target_dir,
                        &format!("{}.{}", stem_of(&item.title, "工作篮文本"), text_ext),
                    );
                    plan.estimated_bytes += text.len() as i64;
                    plan.written.push(PlannedWrite {
                        item_ids: vec![item.id.clone()],
                        label: item.title.clone(),
                        name,
                        source: PlannedSource::Text(text),
                    });
                }
            }
            "url" => {
                let url = if item.content.trim().is_empty() {
                    item.payload
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string()
                } else {
                    item.content.clone()
                };
                let url = url.trim().to_string();
                if url.is_empty() {
                    plan.counts.unsupported += 1;
                    plan.unsupported.push(PreviewUnsupported {
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        reason: "链接为空".into(),
                    });
                    continue;
                }
                let (name, body) = if options.url_mode == "markdown" {
                    (
                        format!("{}.md", stem_of(&item.title, "工作篮链接")),
                        format!("[{}]({})\n", item.title, url),
                    )
                } else {
                    (
                        format!("{}.url", stem_of(&item.title, "工作篮链接")),
                        format!("[InternetShortcut]\r\nURL={url}\r\n"),
                    )
                };
                let name = names.unique(target_dir, &name);
                plan.estimated_bytes += body.len() as i64;
                plan.written.push(PlannedWrite {
                    item_ids: vec![item.id.clone()],
                    label: item.title.clone(),
                    name,
                    source: PlannedSource::Text(body),
                });
            }
            "image" => {
                let cid = item
                    .payload
                    .get("clipboardItemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                match clipboard::store::image_abs_path_by_conn(conn, root, cid) {
                    Some(path) if path.is_file() => {
                        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        plan.estimated_bytes += size as i64;
                        let name = names.unique(
                            target_dir,
                            &format!("工作篮图片-{}.png", short_id(&item.id)),
                        );
                        plan.written.push(PlannedWrite {
                            item_ids: vec![item.id.clone()],
                            label: item.title.clone(),
                            name,
                            source: PlannedSource::CopyFrom(path.to_string_lossy().to_string()),
                        });
                    }
                    _ => {
                        plan.counts.unsupported += 1;
                        plan.unsupported.push(PreviewUnsupported {
                            item_id: item.id.clone(),
                            title: item.title.clone(),
                            reason: "剪贴板图片缓存已失效".into(),
                        });
                    }
                }
            }
            "file" | "directory" => {
                let path = item
                    .payload
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                plan.estimated_bytes += size as i64;
                let entry = PlannedPath {
                    item_id: item.id.clone(),
                    label: item.title.clone(),
                    path,
                    is_dir: item.item_type == "directory",
                    size,
                };
                if options.file_operation == "move" {
                    plan.moves.push(entry);
                } else {
                    plan.copies.push(entry);
                }
            }
            "clipboard" => {
                let cid = item
                    .payload
                    .get("clipboardItemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let clip = match clipboard::store::get_item_by_conn(conn, cid) {
                    Ok(clip) => clip,
                    Err(_) => {
                        plan.counts.unsupported += 1;
                        plan.unsupported.push(PreviewUnsupported {
                            item_id: item.id.clone(),
                            title: item.title.clone(),
                            reason: "剪贴板条目已被清理".into(),
                        });
                        continue;
                    }
                };
                match clip.kind.as_str() {
                    "files" => {
                        for path in &clip.file_paths {
                            if !Path::new(path).exists() {
                                plan.unsupported.push(PreviewUnsupported {
                                    item_id: item.id.clone(),
                                    title: item.title.clone(),
                                    reason: format!("文件不存在: {path}"),
                                });
                                continue;
                            }
                            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                            plan.estimated_bytes += size as i64;
                            plan.copies.push(PlannedPath {
                                item_id: item.id.clone(),
                                label: item.title.clone(),
                                path: path.clone(),
                                is_dir: Path::new(path).is_dir(),
                                size,
                            });
                        }
                    }
                    "image" => match clipboard::store::image_abs_path_by_conn(conn, root, cid) {
                        Some(path) if path.is_file() => {
                            let name = names.unique(
                                target_dir,
                                &format!("工作篮图片-{}.png", short_id(&item.id)),
                            );
                            plan.written.push(PlannedWrite {
                                item_ids: vec![item.id.clone()],
                                label: item.title.clone(),
                                name,
                                source: PlannedSource::CopyFrom(
                                    path.to_string_lossy().to_string(),
                                ),
                            });
                        }
                        _ => {
                            plan.unsupported.push(PreviewUnsupported {
                                item_id: item.id.clone(),
                                title: item.title.clone(),
                                reason: "剪贴板图片缓存已失效".into(),
                            });
                        }
                    },
                    _ => {
                        let body = if !clip.text.is_empty() {
                            clip.text.clone()
                        } else {
                            clip.html.clone()
                        };
                        if body.trim().is_empty() {
                            plan.unsupported.push(PreviewUnsupported {
                                item_id: item.id.clone(),
                                title: item.title.clone(),
                                reason: "剪贴板内容为空".into(),
                            });
                        } else {
                            let name = names.unique(
                                target_dir,
                                &format!("{}.{}", stem_of(&item.title, "剪贴板内容"), text_ext),
                            );
                            plan.estimated_bytes += body.len() as i64;
                            plan.written.push(PlannedWrite {
                                item_ids: vec![item.id.clone()],
                                label: item.title.clone(),
                                name,
                                source: PlannedSource::Text(body),
                            });
                        }
                    }
                }
            }
            _ => {
                plan.counts.unsupported += 1;
                plan.unsupported.push(PreviewUnsupported {
                    item_id: item.id.clone(),
                    title: item.title.clone(),
                    reason: "该类型暂不支持发送到文件工作区".into(),
                });
            }
        }
    }

    if merge_text && !merge_parts.is_empty() {
        let ids: Vec<String> = merge_parts.iter().flat_map(|(ids, _)| ids.clone()).collect();
        let body = merge_parts
            .into_iter()
            .map(|(_, text)| text)
            .collect::<Vec<_>>()
            .join("\n\n---\n\n");
        let name = names.unique(target_dir, &merge_name(text_ext));
        plan.estimated_bytes += body.len() as i64;
        plan.written.push(PlannedWrite {
            item_ids: ids,
            label: "合并文本".into(),
            name,
            source: PlannedSource::Text(body),
        });
    }

    // 冲突预览：新建文件与复制/移动的同名目标。
    for entry in &plan.written {
        if target_dir.join(&entry.name).exists() && plan.conflicts.len() < MAX_PREVIEW_CONFLICTS {
            let resolution = match options.conflict.as_str() {
                "rename" => "将自动重命名",
                "overwrite" => "将覆盖同名文件",
                _ => "同名文件已存在，默认跳过",
            };
            plan.conflicts.push(PreviewConflict {
                name: entry.name.clone(),
                resolution: resolution.to_string(),
            });
        }
    }
    for copy in plan.copies.iter().chain(plan.moves.iter()) {
        let Some(name) = Path::new(&copy.path).file_name() else {
            continue;
        };
        let name = name.to_string_lossy().to_string();
        if target_dir.join(&name).exists()
            && plan.conflicts.len() < MAX_PREVIEW_CONFLICTS
            && !plan.conflicts.iter().any(|c| c.name == name)
        {
            let resolution = match options.conflict.as_str() {
                "rename" => "将自动重命名",
                "overwrite" => "将覆盖同名项",
                _ => "同名项已存在，默认跳过",
            };
            plan.conflicts.push(PreviewConflict {
                name,
                resolution: resolution.to_string(),
            });
        }
    }
    plan.counts.unsupported = plan.unsupported.len();
    Ok(plan)
}

fn target_dir_of(target: &TransferTarget) -> AppResult<PathBuf> {
    if target.module != "files" {
        return Err(AppError::Validation(format!(
            "目标模块 {} 尚未接入发送能力",
            target.module
        )));
    }
    let raw = target.target_ref.trim();
    if raw.is_empty() {
        return Err(AppError::Validation(
            "没有选择目标目录，请先在工作篮中选择一个文件夹".into(),
        ));
    }
    fw::validate_abs_path(raw)
}

pub fn validate_target(target: &TransferTarget) -> TargetValidation {
    match target_dir_of(target).and_then(|dir| fw::validate_dir(&dir)) {
        Ok(dir) => TargetValidation {
            valid: true,
            message: String::new(),
            display_name: dir.to_string_lossy().to_string(),
        },
        Err(e) => TargetValidation {
            valid: false,
            message: e.to_string(),
            display_name: String::new(),
        },
    }
}

pub fn preview(
    db: &Db,
    root: &Path,
    ids: &[String],
    target: &TransferTarget,
    options: &TransferOptions,
) -> AppResult<TransferPreview> {
    if ids.is_empty() {
        return Err(AppError::Validation("请先选择要发送的内容".into()));
    }
    options.validate()?;
    let validation = validate_target(target);
    db.with_conn(|conn| {
        let items = store::load_items_in_conn(conn, ids)?;
        if items.len() != ids.len() {
            return Err(AppError::Validation(
                "部分条目已不存在，请刷新工作篮后重试".into(),
            ));
        }
        let plan = match target_dir_of(target).ok() {
            Some(dir) if validation.valid => build_plan(conn, root, &items, &dir, options)?,
            _ => Plan {
                written: Vec::new(),
                copies: Vec::new(),
                moves: Vec::new(),
                unsupported: items
                    .iter()
                    .map(|item| PreviewUnsupported {
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        reason: validation.message.clone(),
                    })
                    .collect(),
                conflicts: Vec::new(),
                counts: PreviewCounts {
                    unsupported: items.len(),
                    ..Default::default()
                },
                estimated_bytes: 0,
            },
        };
        let planned_files = plan.written.len() + plan.copies.len() + plan.moves.len();
        Ok(TransferPreview {
            target_module: target.module.clone(),
            target_ref: target.target_ref.clone(),
            target_valid: validation.valid,
            target_message: validation.message.clone(),
            counts: plan.counts,
            planned_files,
            conflicts: plan.conflicts,
            unsupported: plan.unsupported,
            warnings: if plan.moves.is_empty() {
                Vec::new()
            } else {
                vec!["将移动源文件：原位置文件会消失，撤销只覆盖新建/复制的文件".into()]
            },
            move_removes_sources: plan.moves.len(),
            estimated_bytes: plan.estimated_bytes,
        })
    })
}

fn clipboard_root(app: &AppHandle) -> PathBuf {
    app.try_state::<Arc<clipboard::ClipboardRuntime>>()
        .map(|state| state.inner().root.clone())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 提交真实任务：文本/图片写入 + 文件复制/移动，落库批次并启动终态监控。
pub fn start(
    app: &AppHandle,
    ids: &[String],
    target: &TransferTarget,
    options: &TransferOptions,
    operation_id: Option<String>,
) -> AppResult<TransferBatch> {
    if ids.is_empty() {
        return Err(AppError::Validation("请先选择要发送的内容".into()));
    }
    if ids.len() > MAX_ADD_BATCH {
        return Err(AppError::Validation(format!(
            "单批最多 {MAX_ADD_BATCH} 条"
        )));
    }
    options.validate()?;
    let validation = validate_target(target);
    if !validation.valid {
        return Err(AppError::Validation(validation.message));
    }
    let dir = fw::validate_dir(&target_dir_of(target)?)?;
    let protected = fsops::protected_dirs_pub(app);
    fw::ensure_not_protected(&dir, &protected)?;

    let db = app.state::<Arc<Db>>().inner().clone();
    let root = clipboard_root(app);
    let (plan, _items) = db.with_conn(|conn| {
        let items = store::load_items_in_conn(conn, ids)?;
        if items.len() != ids.len() {
            return Err(AppError::Validation(
                "部分条目已不存在，请刷新工作篮后重试".into(),
            ));
        }
        let plan = build_plan(conn, &root, &items, &dir, options)?;
        Ok((plan, items))
    })?;
    if plan.written.is_empty() && plan.copies.is_empty() && plan.moves.is_empty() {
        return Err(AppError::Validation(
            plan.unsupported
                .first()
                .map(|u| format!("没有可发送的内容：{}", u.reason))
                .unwrap_or_else(|| "没有可发送的内容".into()),
        ));
    }

    let mut job_ids: Vec<String> = Vec::new();
    let mut job_map: Vec<serde_json::Value> = Vec::new();
    let mut undo_paths: Vec<String> = Vec::new();
    let mut all_item_ids: Vec<String> = Vec::new();

    if !plan.written.is_empty() {
        let overwrite = options.conflict == "overwrite";
        let writes: Vec<WriteEntry> = plan
            .written
            .iter()
            .map(|entry| WriteEntry {
                item_id: entry.item_ids.first().cloned().unwrap_or_default(),
                label: entry.label.clone(),
                target: dir.join(&entry.name).to_string_lossy().to_string(),
                text: match &entry.source {
                    PlannedSource::Text(body) => Some(body.clone()),
                    _ => None,
                },
                copy_from: match &entry.source {
                    PlannedSource::CopyFrom(path) => Some(path.clone()),
                    _ => None,
                },
                overwrite,
                merged: entry.item_ids.len() > 1,
            })
            .collect();
        let snapshot = fsops::start_write(app, writes, operation_id.clone())?;
        job_ids.push(snapshot.id.clone());
        job_map.push(json!({
            "jobId": snapshot.id,
            "kind": "write",
            "items": plan.written.iter().map(|entry| json!({
                "itemIds": entry.item_ids.clone(),
                "target": dir.join(&entry.name).to_string_lossy(),
                "label": entry.label.clone(),
            })).collect::<Vec<_>>(),
        }));
        for entry in &plan.written {
            all_item_ids.extend(entry.item_ids.clone());
            undo_paths.push(dir.join(&entry.name).to_string_lossy().to_string());
        }
    }

    for (kind, list) in [("copy", &plan.copies), ("move", &plan.moves)] {
        if list.is_empty() {
            continue;
        }
        let paths: Vec<String> = list.iter().map(|p| p.path.clone()).collect();
        let snapshot = if kind == "copy" {
            fsops::start_copy(
                app,
                paths.clone(),
                dir.to_string_lossy().to_string(),
                options.conflict.clone(),
                operation_id.clone(),
            )?
        } else {
            fsops::start_move(
                app,
                paths.clone(),
                dir.to_string_lossy().to_string(),
                options.conflict.clone(),
                operation_id.clone(),
            )?
        };
        job_ids.push(snapshot.id.clone());
        job_map.push(json!({
            "jobId": snapshot.id,
            "kind": kind,
            "items": list.iter().map(|entry| json!({
                "itemIds": [entry.item_id],
                "source": entry.path,
                "label": entry.label,
            })).collect::<Vec<_>>(),
        }));
        for entry in list {
            all_item_ids.push(entry.item_id.clone());
            if kind == "copy" {
                let name = Path::new(&entry.path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                undo_paths.push(dir.join(name).to_string_lossy().to_string());
            }
        }
    }

    let undo_state = if undo_paths.is_empty() {
        "unavailable"
    } else if plan.moves.is_empty() {
        "available"
    } else {
        "partial"
    };
    let total_units = plan.written.len() + plan.copies.len() + plan.moves.len();
    let batch_id = batches::create(
        &db,
        NewBatch {
            target,
            operation: if plan.moves.is_empty() { "copy" } else { "move" },
            total: total_units,
            plan: json!({ "jobs": job_map, "targetDir": dir.to_string_lossy() }),
            job_ids: job_ids.clone(),
            undo_kind: if undo_paths.is_empty() { "none" } else { "recycle" },
            undo_payload: json!({ "paths": undo_paths }),
            undo_state,
            message: "",
        },
    )?;

    let _ = store::mark_sending(&db, &all_item_ids);
    let batch = batches::get(&db, &batch_id)?;
    let app_clone = app.clone();
    let batch_clone = batch_id.clone();
    std::thread::spawn(move || monitor(&app_clone, &batch_clone));
    Ok(batch)
}

/// 刷新批次：读取 `JobRegistry` 真实快照；全部终态后一次性回写条目与批次。
pub fn refresh(app: &AppHandle, batch_id: &str) -> AppResult<TransferBatch> {
    let db = app.state::<Arc<Db>>().inner().clone();
    let row = batches::load_row(&db, batch_id)?;
    if matches!(
        row.status.as_str(),
        "completed" | "partial" | "failed" | "cancelled"
    ) {
        return batches::get(&db, batch_id);
    }
    let registry = app.state::<Arc<fsops::JobRegistry>>().inner().clone();
    let mut all_terminal = true;
    for job_id in batches::job_ids(&row) {
        match registry.get(&job_id) {
            // 注册表已淘汰（进程重启/历史超限）= 无法再拿到结果：按未知处理并收尾为失败，
            // 不能让批次永远停在 running。
            Some(handle) if !handle.is_terminal() => all_terminal = false,
            _ => {}
        }
    }
    if !all_terminal {
        return batches::get(&db, batch_id);
    }
    finalize(&db, &row, &registry)
}

fn finalize(
    db: &Db,
    row: &batches::BatchRow,
    registry: &fsops::JobRegistry,
) -> AppResult<TransferBatch> {
    let plan: serde_json::Value =
        serde_json::from_str(&row.plan_json).unwrap_or_else(|_| json!({}));
    let jobs = plan
        .get("jobs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut entries: Vec<BatchEntry> = Vec::new();
    let mut outcomes: Vec<(String, bool, String, String)> = Vec::new();
    let mut any_ok = false;
    let mut any_failed = false;
    let mut any_skipped = false;
    let mut cancelled = false;

    for job in &jobs {
        let job_id = job.get("jobId").and_then(|v| v.as_str()).unwrap_or_default();
        let kind = job.get("kind").and_then(|v| v.as_str()).unwrap_or("write");
        let handle = registry.get(job_id);
        let snapshot = handle.as_ref().map(|h| h.snapshot());
        let report = handle.and_then(|h| h.report());
        if snapshot.as_ref().map(|s| s.status.as_str()) == Some("cancelled") {
            cancelled = true;
        }
        let items = job
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut matched = 0usize;
        if let Some(report) = &report {
            for fs_entry in &report.entries {
                let index = if kind == "write" {
                    items.iter().position(|it| {
                        it.get("target").and_then(|v| v.as_str()) == fs_entry.target.as_deref()
                    })
                } else {
                    items.iter().position(|it| {
                        it.get("source").and_then(|v| v.as_str())
                            == Some(fs_entry.source.as_str())
                    })
                };
                let Some(index) = index else { continue };
                matched += 1;
                let row_items = items[index]
                    .get("itemIds")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let label = items[index]
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let status = match fs_entry.status {
                    "ok" => "sent",
                    "skipped" => "skipped",
                    _ => "failed",
                };
                match status {
                    "sent" => any_ok = true,
                    "skipped" => any_skipped = true,
                    _ => any_failed = true,
                }
                for value in &row_items {
                    let item_id = value.as_str().unwrap_or_default().to_string();
                    if item_id.is_empty() {
                        continue;
                    }
                    let code = fs_entry
                        .code
                        .clone()
                        .unwrap_or_else(|| "OK".to_string());
                    let message = fs_entry.reason.clone().unwrap_or_default();
                    entries.push(BatchEntry {
                        item_id: item_id.clone(),
                        label: label.clone(),
                        status: status.to_string(),
                        code: code.clone(),
                        message: message.clone(),
                        target: fs_entry.target.clone(),
                    });
                    outcomes.push((item_id, status == "sent", code, message));
                }
            }
        }
        if matched == 0 {
            any_failed = true;
            let message = snapshot
                .as_ref()
                .and_then(|s| s.message.clone())
                .unwrap_or_else(|| "文件任务未返回结果".into());
            for item in &items {
                let row_items = item
                    .get("itemIds")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for value in row_items {
                    let item_id = value.as_str().unwrap_or_default().to_string();
                    if item_id.is_empty() {
                        continue;
                    }
                    entries.push(BatchEntry {
                        item_id: item_id.clone(),
                        label: item
                            .get("label")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        status: "failed".into(),
                        code: "FS_OP_UNKNOWN".into(),
                        message: message.clone(),
                        target: None,
                    });
                    outcomes.push((
                        item_id,
                        false,
                        "FS_OP_UNKNOWN".into(),
                        message.clone(),
                    ));
                }
            }
        }
    }

    let status = if entries.is_empty() {
        "failed"
    } else if cancelled && !any_ok {
        "cancelled"
    } else if any_failed || any_skipped {
        if any_ok {
            "partial"
        } else {
            "failed"
        }
    } else if any_ok {
        "completed"
    } else {
        "failed"
    };
    let ok = entries.iter().filter(|e| e.status == "sent").count();
    let failed = entries.iter().filter(|e| e.status == "failed").count();
    let skipped = entries.iter().filter(|e| e.status == "skipped").count();
    let message = match status {
        "completed" => format!("已发送 {ok} 项"),
        "partial" => format!("成功 {ok} 项，失败 {failed} 项，跳过 {skipped} 项"),
        "cancelled" => format!("已取消（成功 {ok} 项）"),
        _ => format!("发送失败：{failed} 项未完成"),
    };
    let target_ref = format!("{}|{}", row.target_module, row.target_ref);
    let _ = store::mark_outcome(db, &outcomes, &target_ref, DEFAULT_SENT_RETENTION_DAYS);
    batches::update(
        db,
        &row.id,
        BatchUpdate {
            status,
            ok,
            failed,
            skipped,
            entries: &entries,
            undo_state: None,
            message: &message,
        },
    )?;
    batches::get(db, &row.id)
}

/// 终态监控：轮询 `JobRegistry`（单一事实来源），完成即回写；最长 30 分钟。
fn monitor(app: &AppHandle, batch_id: &str) {
    for _ in 0..(30 * 60 * 2) {
        std::thread::sleep(std::time::Duration::from_millis(500));
        match refresh(app, batch_id) {
            Ok(batch) => {
                let _ = app.emit(BATCH_EVENT, &batch);
                if matches!(
                    batch.status.as_str(),
                    "completed" | "partial" | "failed" | "cancelled"
                ) {
                    return;
                }
            }
            Err(_) => return,
        }
    }
    if let Some(db) = app.try_state::<Arc<Db>>().map(|s| s.inner().clone()) {
        let _ = batches::update(
            &db,
            batch_id,
            BatchUpdate {
                status: "failed",
                ok: 0,
                failed: 1,
                skipped: 0,
                entries: &[],
                undo_state: None,
                message: "发送超时：文件任务未在 30 分钟内结束",
            },
        );
    }
}

/// 失败重试：只重发该批次中真实失败的条目，目标与选项保持一致。
pub fn retry(
    app: &AppHandle,
    batch_id: &str,
    options: &TransferOptions,
) -> AppResult<TransferBatch> {
    let db = app.state::<Arc<Db>>().inner().clone();
    let row = batches::load_row(&db, batch_id)?;
    let entries: Vec<BatchEntry> = serde_json::from_str(&row.entries_json).unwrap_or_default();
    let ids: Vec<String> = entries
        .iter()
        .filter(|e| e.status == "failed")
        .map(|e| e.item_id.clone())
        .collect();
    if ids.is_empty() {
        return Err(AppError::Validation("该批次没有失败条目".into()));
    }
    let target = TransferTarget {
        module: row.target_module.clone(),
        target_ref: row.target_ref.clone(),
    };
    start(app, &ids, &target, options, None)
}

/// 撤销：只把「本批次新生成/复制出的文件」移入回收站；移动类操作不承诺撤销。
pub fn undo(app: &AppHandle, batch_id: &str) -> AppResult<BatchUndoResult> {
    let db = app.state::<Arc<Db>>().inner().clone();
    let row = batches::load_row(&db, batch_id)?;
    if row.undo_state != "available" && row.undo_state != "partial" {
        return Ok(BatchUndoResult {
            batch_id: batch_id.to_string(),
            ok: false,
            moved: 0,
            message: match row.undo_state.as_str() {
                "used" => "该批次已撤销过".into(),
                _ => "该批次包含移动操作或没有可撤销的文件".into(),
            },
        });
    }
    let existing: Vec<String> = batches::undo_paths(&row)
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .collect();
    if existing.is_empty() {
        return Ok(BatchUndoResult {
            batch_id: batch_id.to_string(),
            ok: false,
            moved: 0,
            message: "可撤销的文件已被移动或删除".into(),
        });
    }
    let protected = fsops::protected_dirs_pub(app);
    let snapshot = fsops::start_delete(app, existing, false, protected, None)?;
    let moved = snapshot.total;
    batches::mark_undo_used(&db, batch_id)?;
    let _ = app.emit(
        BATCH_EVENT,
        json!({ "batchId": batch_id, "undoState": "used", "moved": moved }),
    );
    Ok(BatchUndoResult {
        batch_id: batch_id.to_string(),
        ok: true,
        moved,
        message: format!("已把 {moved} 个生成文件移入回收站"),
    })
}

/// 供命令层读取批次进度（不触发收尾）。
pub fn batch(app: &AppHandle, batch_id: &str) -> AppResult<TransferBatch> {
    let db = app.state::<Arc<Db>>().inner().clone();
    batches::get(&db, batch_id)
}

/// 发送成功后的保留天数（设置项在命令层读取后传入）。
pub fn retention_days(options: &TransferOptions) -> i64 {
    retention(options)
}
