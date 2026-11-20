//! 发送执行：预览、提交真实文件写入/复制/移动、批次终态回写、失败重试、撤销。
//!
//! 职责边界：
//! - 本模块**不实现**文件系统语义，一律复用 `file_workspace`（校验/冲突/复制/移动）与
//!   `fsops`（排队/并发/取消/逐条报告/回收站）；
//! - 目标目录必须显式传入并校验，「当前上下文」只用于推荐，绝不代替显式目标；
//! - 部分成功如实回写：条目状态按逐条结果更新，不用整体布尔值掩盖失败；
//! - 文件名解析只有一处（[`resolve_name`]），预览与执行共用同一函数，
//!   冲突策略（skip / rename / overwrite）在规划阶段就决定，不会「先改名再跳过」。

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
/// 撤销时等待文件任务终态的上限；超过就如实报告「仍在进行」，不谎报成功。
const UNDO_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

fn retention(options: &TransferOptions) -> i64 {
    options
        .sent_retention_days
        .unwrap_or(DEFAULT_SENT_RETENTION_DAYS)
        .max(0)
}

/// 把标题整理成一个「安全的文件名主干」：替换非法字符、截断、去尾部点空格。
/// 只做清洗，不做重名处理；重名与保留名由 [`fw::resolve_write_target`] 负责。
fn clean_stem(title: &str, fallback: &str) -> String {
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

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn name_key(name: &str) -> String {
    name.to_ascii_lowercase()
}

fn suffixed(base: &str, n: u32) -> String {
    match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => format!("{stem} ({n}).{ext}"),
        _ => format!("{base} ({n})"),
    }
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

/// 冲突策略决定「这一条根本不会写」：不产生任务，也不改名，如实报告 skipped。
#[derive(Debug, Clone)]
struct PlannedSkip {
    item_ids: Vec<String>,
    label: String,
    name: String,
    reason: String,
}

struct Plan {
    written: Vec<PlannedWrite>,
    skipped: Vec<PlannedSkip>,
    copies: Vec<PlannedPath>,
    moves: Vec<PlannedPath>,
    unsupported: Vec<PreviewUnsupported>,
    conflicts: Vec<PreviewConflict>,
    counts: PreviewCounts,
    estimated_bytes: i64,
}

impl Plan {
    fn empty() -> Self {
        Self {
            written: Vec::new(),
            skipped: Vec::new(),
            copies: Vec::new(),
            moves: Vec::new(),
            unsupported: Vec::new(),
            conflicts: Vec::new(),
            counts: PreviewCounts::default(),
            estimated_bytes: 0,
        }
    }

    fn units(&self) -> usize {
        let mut ids: Vec<&str> = Vec::new();
        for entry in &self.written {
            ids.extend(entry.item_ids.iter().map(String::as_str));
        }
        for entry in &self.skipped {
            ids.extend(entry.item_ids.iter().map(String::as_str));
        }
        for entry in self.copies.iter().chain(self.moves.iter()) {
            ids.push(entry.item_id.as_str());
        }
        ids.sort_unstable();
        ids.dedup();
        ids.len()
    }
}

/// 批次内文件名预约 + 冲突策略解析（唯一实现，预览与执行共用）。
struct NameBook {
    used: std::collections::HashSet<String>,
}

impl NameBook {
    fn new() -> Self {
        Self {
            used: Default::default(),
        }
    }

    /// 申请最终文件名。
    ///
    /// - `Skip`：目标已存在或批次内已占用 → `None`（调用方记为 skipped，不改名）；
    /// - `Overwrite`：目标已存在 → 沿用原名；批次内已占用 → 追加序号（不能静默丢内容）；
    /// - `Rename`：目标已存在或批次内已占用 → 追加序号。
    fn claim(
        &mut self,
        dir: &Path,
        base: &str,
        conflict: fw::Conflict,
    ) -> AppResult<Option<String>> {
        let base = match fw::sanitize_name(base) {
            Ok(name) => name,
            Err(_) => fw::sanitize_name("工作篮内容")?,
        };
        let first = fw::resolve_write_target(dir, &base, conflict)?;
        let Some(path) = first else {
            return Ok(None);
        };
        let mut name = file_name_of(&path);
        if !self.used.contains(&name_key(&name)) {
            self.used.insert(name_key(&name));
            return Ok(Some(name));
        }
        if matches!(conflict, fw::Conflict::Skip) {
            return Ok(None);
        }
        // 批次内重名：一律让路（overwrite 也不能让两条不同内容互相覆盖）。
        for n in 2..=1000u32 {
            let candidate = suffixed(&base, n);
            let resolved = fw::resolve_write_target(dir, &candidate, fw::Conflict::Rename)?;
            let Some(resolved) = resolved else { continue };
            name = file_name_of(&resolved);
            if !self.used.contains(&name_key(&name)) {
                self.used.insert(name_key(&name));
                return Ok(Some(name));
            }
        }
        Err(AppError::Validation("同名文件过多，无法生成可用文件名".into()))
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

fn conflict_note(conflict: fw::Conflict, dir: &Path, name: &str) -> Option<&'static str> {
    if !dir.join(name).exists() {
        return None;
    }
    Some(match conflict {
        fw::Conflict::Rename => "同名文件已存在，将自动重命名",
        fw::Conflict::Overwrite => "同名文件已存在，将覆盖",
        fw::Conflict::Skip => "同名文件已存在，将跳过",
    })
}

fn build_plan(
    conn: &Connection,
    root: &Path,
    items: &[TransferItem],
    target_dir: &Path,
    options: &TransferOptions,
) -> AppResult<Plan> {
    let mut plan = Plan::empty();
    let mut names = NameBook::new();
    let conflict = fw::parse_conflict(&options.conflict)?;
    let merge_text = options.text_mode == "merge";
    let text_ext = if options.text_format == "md" {
        "md"
    } else {
        "txt"
    };
    let mut merge_parts: Vec<(Vec<String>, String)> = Vec::new();
    let mut seen_sources: std::collections::HashSet<String> = Default::default();

    for item in items {
        count_type(&mut plan.counts, &item.item_type);
        if !item.available {
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
                    let base = format!("{}.{}", clean_stem(&item.title, "工作篮文本"), text_ext);
                    if let Some(note) = conflict_note(conflict, target_dir, &base) {
                        if plan.conflicts.len() < MAX_PREVIEW_CONFLICTS {
                            plan.conflicts.push(PreviewConflict {
                                name: base.clone(),
                                resolution: note.to_string(),
                            });
                        }
                    }
                    match names.claim(target_dir, &base, conflict)? {
                        Some(name) => {
                            plan.estimated_bytes += text.len() as i64;
                            plan.written.push(PlannedWrite {
                                item_ids: vec![item.id.clone()],
                                label: item.title.clone(),
                                name,
                                source: PlannedSource::Text(text),
                            });
                        }
                        None => plan.skipped.push(PlannedSkip {
                            item_ids: vec![item.id.clone()],
                            label: item.title.clone(),
                            name: base,
                            reason: "同名文件已存在，按跳过策略未写入".into(),
                        }),
                    }
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
                    plan.unsupported.push(PreviewUnsupported {
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        reason: "链接为空".into(),
                    });
                    continue;
                }
                let (base, body) = if options.url_mode == "markdown" {
                    (
                        format!("{}.md", clean_stem(&item.title, "工作篮链接")),
                        format!("[{}]({})\n", item.title, url),
                    )
                } else {
                    (
                        format!("{}.url", clean_stem(&item.title, "工作篮链接")),
                        format!("[InternetShortcut]\r\nURL={url}\r\n"),
                    )
                };
                if let Some(note) = conflict_note(conflict, target_dir, &base) {
                    if plan.conflicts.len() < MAX_PREVIEW_CONFLICTS {
                        plan.conflicts.push(PreviewConflict {
                            name: base.clone(),
                            resolution: note.to_string(),
                        });
                    }
                }
                match names.claim(target_dir, &base, conflict)? {
                    Some(name) => {
                        plan.estimated_bytes += body.len() as i64;
                        plan.written.push(PlannedWrite {
                            item_ids: vec![item.id.clone()],
                            label: item.title.clone(),
                            name,
                            source: PlannedSource::Text(body),
                        });
                    }
                    None => plan.skipped.push(PlannedSkip {
                        item_ids: vec![item.id.clone()],
                        label: item.title.clone(),
                        name: base,
                        reason: "同名文件已存在，按跳过策略未写入".into(),
                    }),
                }
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
                        let base = format!("工作篮图片-{}.png", short_id(&item.id));
                        if let Some(note) = conflict_note(conflict, target_dir, &base) {
                            if plan.conflicts.len() < MAX_PREVIEW_CONFLICTS {
                                plan.conflicts.push(PreviewConflict {
                                    name: base.clone(),
                                    resolution: note.to_string(),
                                });
                            }
                        }
                        match names.claim(target_dir, &base, conflict)? {
                            Some(name) => {
                                plan.estimated_bytes += size as i64;
                                plan.written.push(PlannedWrite {
                                    item_ids: vec![item.id.clone()],
                                    label: item.title.clone(),
                                    name,
                                    source: PlannedSource::CopyFrom(
                                        path.to_string_lossy().to_string(),
                                    ),
                                });
                            }
                            None => plan.skipped.push(PlannedSkip {
                                item_ids: vec![item.id.clone()],
                                label: item.title.clone(),
                                name: base,
                                reason: "同名文件已存在，按跳过策略未写入".into(),
                            }),
                        }
                    }
                    _ => plan.unsupported.push(PreviewUnsupported {
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        reason: "剪贴板图片缓存已失效".into(),
                    }),
                }
            }
            "file" | "directory" => {
                let path = item
                    .payload
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if !Path::new(&path).exists() {
                    plan.unsupported.push(PreviewUnsupported {
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        reason: "文件或目录已不存在".into(),
                    });
                    continue;
                }
                // 同一批次里重复选择同一个源路径：只执行一次，避免第二次必然冲突。
                if !seen_sources.insert(path.to_ascii_lowercase()) {
                    continue;
                }
                let size = std::fs::metadata(&path)
                    .map(|m| if m.is_dir() { 0 } else { m.len() })
                    .unwrap_or(0);
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
                            if !seen_sources.insert(path.to_ascii_lowercase()) {
                                continue;
                            }
                            let meta = std::fs::metadata(path).ok();
                            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                            plan.estimated_bytes += size as i64;
                            plan.copies.push(PlannedPath {
                                item_id: item.id.clone(),
                                label: item.title.clone(),
                                path: path.clone(),
                                is_dir: meta.map(|m| m.is_dir()).unwrap_or(false),
                                size,
                            });
                        }
                    }
                    "image" => match clipboard::store::image_abs_path_by_conn(conn, root, cid) {
                        Some(path) if path.is_file() => {
                            let base = format!("工作篮图片-{}.png", short_id(&item.id));
                            if let Some(note) = conflict_note(conflict, target_dir, &base) {
                                if plan.conflicts.len() < MAX_PREVIEW_CONFLICTS {
                                    plan.conflicts.push(PreviewConflict {
                                        name: base.clone(),
                                        resolution: note.to_string(),
                                    });
                                }
                            }
                            match names.claim(target_dir, &base, conflict)? {
                                Some(name) => plan.written.push(PlannedWrite {
                                    item_ids: vec![item.id.clone()],
                                    label: item.title.clone(),
                                    name,
                                    source: PlannedSource::CopyFrom(
                                        path.to_string_lossy().to_string(),
                                    ),
                                }),
                                None => plan.skipped.push(PlannedSkip {
                                    item_ids: vec![item.id.clone()],
                                    label: item.title.clone(),
                                    name: base,
                                    reason: "同名文件已存在，按跳过策略未写入".into(),
                                }),
                            }
                        }
                        _ => plan.unsupported.push(PreviewUnsupported {
                            item_id: item.id.clone(),
                            title: item.title.clone(),
                            reason: "剪贴板图片缓存已失效".into(),
                        }),
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
                            let base = format!(
                                "{}.{}",
                                clean_stem(&item.title, "剪贴板内容"),
                                text_ext
                            );
                            if let Some(note) = conflict_note(conflict, target_dir, &base) {
                                if plan.conflicts.len() < MAX_PREVIEW_CONFLICTS {
                                    plan.conflicts.push(PreviewConflict {
                                        name: base.clone(),
                                        resolution: note.to_string(),
                                    });
                                }
                            }
                            match names.claim(target_dir, &base, conflict)? {
                                Some(name) => {
                                    plan.estimated_bytes += body.len() as i64;
                                    plan.written.push(PlannedWrite {
                                        item_ids: vec![item.id.clone()],
                                        label: item.title.clone(),
                                        name,
                                        source: PlannedSource::Text(body),
                                    });
                                }
                                None => plan.skipped.push(PlannedSkip {
                                    item_ids: vec![item.id.clone()],
                                    label: item.title.clone(),
                                    name: base,
                                    reason: "同名文件已存在，按跳过策略未写入".into(),
                                }),
                            }
                        }
                    }
                }
            }
            _ => {
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
        let base = merge_name(text_ext);
        if let Some(note) = conflict_note(conflict, target_dir, &base) {
            if plan.conflicts.len() < MAX_PREVIEW_CONFLICTS {
                plan.conflicts.push(PreviewConflict {
                    name: base.clone(),
                    resolution: note.to_string(),
                });
            }
        }
        match names.claim(target_dir, &base, conflict)? {
            Some(name) => {
                plan.estimated_bytes += body.len() as i64;
                plan.written.push(PlannedWrite {
                    item_ids: ids,
                    label: "合并文本".into(),
                    name,
                    source: PlannedSource::Text(body),
                });
            }
            None => plan.skipped.push(PlannedSkip {
                item_ids: ids,
                label: "合并文本".into(),
                name: base,
                reason: "同名文件已存在，按跳过策略未写入".into(),
            }),
        }
    }

    // 复制/移动的冲突预览：目标目录已有同名项时按策略提示。
    for copy in plan.copies.iter().chain(plan.moves.iter()) {
        let Some(name) = Path::new(&copy.path).file_name() else {
            continue;
        };
        let name = name.to_string_lossy().to_string();
        if target_dir.join(&name).exists()
            && plan.conflicts.len() < MAX_PREVIEW_CONFLICTS
            && !plan.conflicts.iter().any(|c| c.name == name)
        {
            let resolution = match conflict {
                fw::Conflict::Rename => "将自动重命名",
                fw::Conflict::Overwrite => "将覆盖同名项",
                fw::Conflict::Skip => "同名项已存在，默认跳过",
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
                unsupported: items
                    .iter()
                    .map(|item| PreviewUnsupported {
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        reason: validation.message.clone(),
                    })
                    .collect(),
                counts: PreviewCounts {
                    unsupported: items.len(),
                    ..Default::default()
                },
                ..Plan::empty()
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
///
/// 顺序保证：**先建批次 → 再提交任务 → 回填 jobIds**。任一任务提交失败都会取消
/// 已提交的任务并把批次收尾为 failed，不留下用户看不见的后台文件操作。
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
        let reason = plan
            .skipped
            .first()
            .map(|s| s.reason.clone())
            .or_else(|| plan.unsupported.first().map(|u| u.reason.clone()))
            .unwrap_or_else(|| "没有可发送的内容".into());
        return Err(AppError::Validation(format!("没有可发送的内容：{reason}")));
    }

    let mut job_map: Vec<serde_json::Value> = Vec::new();
    // 真正会执行的条目（被跳过的条目保持 ready，用户可改策略后重发）。
    let mut all_item_ids: Vec<String> = Vec::new();
    for entry in &plan.written {
        all_item_ids.extend(entry.item_ids.clone());
    }
    for entry in plan.copies.iter().chain(plan.moves.iter()) {
        all_item_ids.push(entry.item_id.clone());
    }

    // 撤销路径在规划阶段就能确定（新建/复制的目标文件名），不依赖任务提交结果：
    // 先算清楚再建批次，避免「批次已建但 undo_payload 为空」。
    let mut undo_paths: Vec<String> = Vec::new();
    for entry in &plan.written {
        undo_paths.push(dir.join(&entry.name).to_string_lossy().to_string());
    }
    if options.file_operation != "move" {
        for entry in &plan.copies {
            undo_paths.push(
                dir.join(file_name_of(Path::new(&entry.path)))
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }

    // 规划阶段已决定跳过的条目也要进入批次结果，用户才能看到「为什么没发」。
    if !plan.skipped.is_empty() {
        job_map.push(json!({
            "jobId": "",
            "kind": "skip",
            "items": plan.skipped.iter().map(|entry| json!({
                "itemIds": entry.item_ids.clone(),
                "target": dir.join(&entry.name).to_string_lossy(),
                "label": entry.label.clone(),
                "reason": entry.reason.clone(),
            })).collect::<Vec<_>>(),
        }));
    }

    let total_units = plan.units();
    let undo_state = if undo_paths.is_empty() {
        "unavailable"
    } else if plan.moves.is_empty() {
        "available"
    } else {
        "partial"
    };
    // 先建批次（preparing）：后续任何提交失败都能被用户看到，而不是只有后台任务。
    let batch_id = batches::create(
        &db,
        NewBatch {
            target,
            operation: if plan.moves.is_empty() { "copy" } else { "move" },
            // 迁移 79 的状态白名单里没有 preparing：pending 表示「批次已建、任务未提交完」。
            status: "pending",
            total: total_units,
            plan: json!({
                "jobs": job_map,
                "targetDir": dir.to_string_lossy(),
                "options": options,
            }),
            job_ids: Vec::new(),
            undo_kind: if undo_paths.is_empty() { "none" } else { "recycle" },
            undo_payload: json!({ "paths": undo_paths }),
            undo_state,
            message: "正在准备文件任务",
        },
    )?;

    let mut job_ids: Vec<String> = Vec::new();
    let mut submit_error: Option<String> = None;

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
        match fsops::start_write(app, writes, operation_id.clone()) {
            Ok(snapshot) => {
                job_ids.push(snapshot.id.clone());
            }
            Err(e) => submit_error = Some(format!("提交文本写入任务失败：{e}")),
        }
    }

    if submit_error.is_none() {
        for (kind, list) in [("copy", &plan.copies), ("move", &plan.moves)] {
            if list.is_empty() {
                continue;
            }
            let paths: Vec<String> = list.iter().map(|p| p.path.clone()).collect();
            let started = if kind == "copy" {
                fsops::start_copy(
                    app,
                    paths,
                    dir.to_string_lossy().to_string(),
                    options.conflict.clone(),
                    operation_id.clone(),
                )
            } else {
                fsops::start_move(
                    app,
                    paths,
                    dir.to_string_lossy().to_string(),
                    options.conflict.clone(),
                    operation_id.clone(),
                )
            };
            match started {
                Ok(snapshot) => {
                    job_ids.push(snapshot.id.clone());
                }
                Err(e) => {
                    submit_error = Some(format!("提交文件{kind}任务失败：{e}"));
                    break;
                }
            }
        }
    }

    if let Some(error) = submit_error {
        // 补偿：取消已提交的任务（pending 直接终止，running 在批次边界停止）。
        let registry = app.state::<Arc<fsops::JobRegistry>>().inner().clone();
        for job_id in &job_ids {
            if let Some(handle) = registry.get(job_id) {
                handle.cancel();
            }
        }
        let _ = batches::update(
            &db,
            &batch_id,
            BatchUpdate {
                status: "failed",
                ok: 0,
                failed: total_units.max(1),
                skipped: 0,
                entries: &[],
                undo_state: Some("unavailable"),
                message: &error,
            },
        );
        let _ = tiers_emit(app, &db, &batch_id);
        return Err(AppError::Unavailable(format!(
            "{error}（已取消已提交的任务）"
        )));
    }

    batches::attach_jobs(&db, &batch_id, &job_ids, "running", "正在发送")?;
    let _ = store::mark_sending(&db, &all_item_ids);
    let batch = batches::get(&db, &batch_id)?;
    let app_clone = app.clone();
    let batch_clone = batch_id.clone();
    std::thread::spawn(move || monitor(&app_clone, &batch_clone));
    Ok(batch)
}

fn tiers_emit(app: &AppHandle, db: &Db, batch_id: &str) -> AppResult<()> {
    if let Ok(batch) = batches::get(db, batch_id) {
        let _ = app.emit(BATCH_EVENT, &batch);
    }
    Ok(())
}

/// 刷新批次：读取 `JobRegistry` 真实快照；全部终态后一次性回写条目与批次。
pub fn refresh(app: &AppHandle, batch_id: &str) -> AppResult<TransferBatch> {
    let db = app.state::<Arc<Db>>().inner().clone();
    let row = batches::load_row(&db, batch_id)?;
    if matches!(
        row.status.as_str(),
        "completed" | "partial" | "failed" | "cancelled"
    ) {
        // 终态批次仍可能处于「撤销进行中」：撤销状态由 undo 自己回写。
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
    let plan: serde_json::Value = serde_json::from_str(&row.plan_json).unwrap_or_else(|_| json!({}));
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
        let kind = job.get("kind").and_then(|v| v.as_str()).unwrap_or("write");
        let job_id = job.get("jobId").and_then(|v| v.as_str()).unwrap_or_default();
        let items = job
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if kind == "skip" {
            any_skipped = true;
            for item in &items {
                let reason = item
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("按跳过策略未执行")
                    .to_string();
                let label = item
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                for value in item
                    .get("itemIds")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default()
                {
                    let item_id = value.as_str().unwrap_or_default().to_string();
                    if item_id.is_empty() {
                        continue;
                    }
                    entries.push(BatchEntry {
                        item_id: item_id.clone(),
                        label: label.clone(),
                        status: "skipped".into(),
                        code: "FS_OP_CONFLICT".into(),
                        message: reason.clone(),
                        target: item
                            .get("target")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    });
                    outcomes.push((item_id, false, "FS_OP_CONFLICT".into(), reason.clone()));
                }
            }
            continue;
        }
        let handle = registry.get(job_id);
        let snapshot = handle.as_ref().map(|h| h.snapshot());
        let report = handle.and_then(|h| h.report());
        if snapshot.as_ref().map(|s| s.status.as_str()) == Some("cancelled") {
            cancelled = true;
        }
        let mut matched = 0usize;
        if let Some(report) = &report {
            for fs_entry in &report.entries {
                let index = if kind == "write" {
                    items.iter().position(|it| {
                        it.get("target").and_then(|v| v.as_str()) == fs_entry.target.as_deref()
                    })
                } else {
                    items.iter().position(|it| {
                        it.get("source").and_then(|v| v.as_str()) == Some(fs_entry.source.as_str())
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
                    let code = fs_entry.code.clone().unwrap_or_else(|| "OK".to_string());
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
                    outcomes.push((item_id, false, "FS_OP_UNKNOWN".into(), message.clone()));
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
    // 统计单位 = 条目（合并文本也按条目计数），保证 ok+failed+skipped == total。
    let ok = entries.iter().filter(|e| e.status == "sent").count();
    let failed = entries.iter().filter(|e| e.status == "failed").count();
    let skipped = entries.iter().filter(|e| e.status == "skipped").count();
    let message = match status {
        "completed" => format!("已发送 {ok} 项"),
        "partial" => format!("成功 {ok} 项，失败 {failed} 项，跳过 {skipped} 项"),
        "cancelled" => format!("已取消（成功 {ok} 项）"),
        _ => {
            if ok > 0 {
                format!("部分完成：成功 {ok} 项，失败 {failed} 项")
            } else {
                format!("发送失败：{failed} 项未完成")
            }
        }
    };
    let target_ref = format!("{}|{}", row.target_module, row.target_ref);
    let _ = store::mark_outcome(db, &outcomes, &target_ref, DEFAULT_SENT_RETENTION_DAYS);
    let undo_update = if row.undo_kind == "none" {
        Some("unavailable")
    } else if row.undo_state == "available" || row.undo_state == "partial" {
        // 实际成功数为 0 时没有可撤销文件。
        if ok == 0 {
            Some("unavailable")
        } else {
            None
        }
    } else {
        None
    };
    batches::update(
        db,
        &row.id,
        BatchUpdate {
            status,
            ok,
            failed,
            skipped,
            entries: &entries,
            undo_state: undo_update,
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

/// 失败重试：只重发该批次中真实失败的条目。
///
/// 目标与选项以**批次记录**为准（原始冲突策略 / 文本格式 / 文件操作模式），
/// 调用方传入的 `options` 只在旧批次没有记录选项时兜底。
pub fn retry(
    app: &AppHandle,
    batch_id: &str,
    options: &TransferOptions,
) -> AppResult<TransferBatch> {
    let db = app.state::<Arc<Db>>().inner().clone();
    let row = batches::load_row(&db, batch_id)?;
    let entries: Vec<BatchEntry> = serde_json::from_str(&row.entries_json).unwrap_or_default();
    let mut ids: Vec<String> = Vec::new();
    for entry in entries.iter().filter(|e| e.status == "failed") {
        if !ids.contains(&entry.item_id) {
            ids.push(entry.item_id.clone());
        }
    }
    if ids.is_empty() {
        return Err(AppError::Validation("该批次没有失败条目".into()));
    }
    let plan: serde_json::Value = serde_json::from_str(&row.plan_json).unwrap_or_else(|_| json!({}));
    let stored: Option<TransferOptions> = plan
        .get("options")
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    let effective = stored.unwrap_or_else(|| options.clone());
    let target = TransferTarget {
        module: row.target_module.clone(),
        target_ref: row.target_ref.clone(),
    };
    start(app, &ids, &target, &effective, None)
}

/// 已提交删除任务后等待真实终态；超时返回 None（由调用方如实报告「仍在进行」）。
fn wait_job(registry: &fsops::JobRegistry, job_id: &str) -> Option<fsops::JobSnapshot> {
    let deadline = std::time::Instant::now() + UNDO_WAIT;
    loop {
        let snapshot = registry.get(job_id).map(|handle| handle.snapshot());
        match &snapshot {
            Some(s) if matches!(s.status.as_str(), "completed" | "partial" | "failed" | "cancelled") => {
                return snapshot
            }
            None => return None,
            _ => {}
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// 撤销进行中的批次 id：避免用户连点造成重复删除任务（状态列没有 running，
/// 迁移 79 的 CHECK 白名单不允许扩展；这里用进程内互斥保证幂等）。
static UNDO_IN_FLIGHT: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

fn undo_lock(batch_id: &str) -> bool {
    let mut guard = UNDO_IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    let set = guard.get_or_insert_with(Default::default);
    set.insert(batch_id.to_string())
}

fn undo_unlock(batch_id: &str) {
    let mut guard = UNDO_IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(batch_id);
    }
}

/// 撤销：只把「本批次新生成/复制出的文件」移入回收站；移动类操作不承诺撤销。
///
/// 只有文件任务真实到达终态、且确有文件被移入回收站时才标记 `used`；
/// 失败保留 `available`，用户可以再次撤销。
pub fn undo(app: &AppHandle, batch_id: &str) -> AppResult<BatchUndoResult> {
    let db = app.state::<Arc<Db>>().inner().clone();
    let row = batches::load_row(&db, batch_id)?;
    if !undo_lock(batch_id) {
        return Ok(BatchUndoResult {
            batch_id: batch_id.to_string(),
            ok: false,
            moved: 0,
            message: "撤销仍在进行中，请稍候".into(),
        });
    }
    let result = undo_locked(app, &db, &row);
    undo_unlock(batch_id);
    result
}

fn undo_locked(
    app: &AppHandle,
    db: &Db,
    row: &batches::BatchRow,
) -> AppResult<BatchUndoResult> {
    let batch_id = row.id.clone();
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
    let existing: Vec<String> = batches::undo_paths(row)
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .collect();
    if existing.is_empty() {
        return Ok(BatchUndoResult {
            batch_id: batch_id.clone(),
            ok: false,
            moved: 0,
            message: "可撤销的文件已被移动或删除".into(),
        });
    }
    let protected = fsops::protected_dirs_pub(app);
    let existing_count = existing.len();
    let snapshot = fsops::start_delete(app, existing, false, protected, None)?;
    let job_id = snapshot.id.clone();
    let registry = app.state::<Arc<fsops::JobRegistry>>().inner().clone();
    let Some(terminal) = wait_job(&registry, &job_id) else {
        // 超时：保持 available（用户可再点一次），不提前标记 used、也不谎报成功。
        return Ok(BatchUndoResult {
            batch_id,
            ok: false,
            moved: 0,
            message: "撤销已提交，文件任务仍在处理中".into(),
        });
    };
    let report = registry.get(&job_id).and_then(|handle| handle.report());
    let moved = report
        .as_ref()
        .map(|r| r.entries.iter().filter(|e| e.status == "ok").count())
        .unwrap_or(0);
    let failed = report
        .as_ref()
        .map(|r| r.entries.iter().filter(|e| e.status != "ok").count())
        .unwrap_or_else(|| {
            if terminal.status == "completed" {
                0
            } else {
                existing_count
            }
        });
    let (state, ok, message) = if moved > 0 && failed == 0 {
        ("used", true, format!("已把 {moved} 个生成文件移入回收站"))
    } else if moved > 0 {
        (
            "partial",
            true,
            format!("已撤销 {moved} 项，{failed} 项未能移入回收站"),
        )
    } else {
        (
            "available",
            false,
            format!("撤销未完成：{failed} 个文件未能移入回收站"),
        )
    };
    batches::set_undo_state(db, &batch_id, state)?;
    if let Ok(batch) = batches::get(db, &batch_id) {
        let _ = app.emit(BATCH_EVENT, &batch);
    }
    Ok(BatchUndoResult {
        batch_id,
        ok,
        moved,
        message,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::{store, TransferItemInput};

    fn db() -> Db {
        Db::open_in_memory().expect("内存库应可用")
    }

    fn text_input(title: &str, body: &str) -> TransferItemInput {
        TransferItemInput {
            id: None,
            item_type: "text".into(),
            source_module: "clipboard".into(),
            source_id: String::new(),
            title: title.into(),
            description: String::new(),
            content: body.into(),
            payload: serde_json::json!({}),
            pinned: false,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("taskdock-plan-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("临时目录应可创建");
        dir
    }

    fn plan_of(db: &Db, ids: &[String], dir: &Path, options: &TransferOptions) -> Plan {
        db.with_conn(|conn| {
            let items = store::load_items_in_conn(conn, ids)?;
            build_plan(conn, Path::new("."), &items, dir, options)
        })
        .expect("规划应成功")
    }

    #[test]
    fn rename_policy_keeps_both_files() {
        let dir = temp_dir("rename");
        std::fs::write(dir.join("说明.txt"), "旧内容").unwrap();
        let db = db();
        let id = store::add_items(&db, vec![text_input("说明", "新内容")])
            .unwrap()
            .items[0]
            .id
            .clone();
        let plan = plan_of(&db, &[id], &dir, &TransferOptions::default());
        assert_eq!(plan.written.len(), 1);
        assert_eq!(plan.written[0].name, "说明 (2).txt", "rename 必须让路到新文件名");
        assert!(plan.skipped.is_empty());
        assert_eq!(plan.conflicts.len(), 1, "预览要提示同名冲突");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skip_policy_reports_skipped_without_renaming() {
        let dir = temp_dir("skip");
        std::fs::write(dir.join("说明.txt"), "旧内容").unwrap();
        let db = db();
        let id = store::add_items(&db, vec![text_input("说明", "新内容")])
            .unwrap()
            .items[0]
            .id
            .clone();
        let options = TransferOptions {
            conflict: "skip".into(),
            ..TransferOptions::default()
        };
        let plan = plan_of(&db, &[id.clone()], &dir, &options);
        assert!(plan.written.is_empty(), "skip 不能提前改名再写入");
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].name, "说明.txt");
        assert_eq!(plan.units(), 1);
        assert_eq!(std::fs::read_to_string(dir.join("说明.txt")).unwrap(), "旧内容");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn overwrite_policy_keeps_original_name() {
        let dir = temp_dir("overwrite");
        std::fs::write(dir.join("说明.txt"), "旧内容").unwrap();
        let db = db();
        let id = store::add_items(&db, vec![text_input("说明", "新内容")])
            .unwrap()
            .items[0]
            .id
            .clone();
        let options = TransferOptions {
            conflict: "overwrite".into(),
            ..TransferOptions::default()
        };
        let plan = plan_of(&db, &[id], &dir, &options);
        assert_eq!(plan.written.len(), 1);
        assert_eq!(plan.written[0].name, "说明.txt", "overwrite 必须覆盖原文件而不是改名");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn batch_internal_names_never_collide() {
        let dir = temp_dir("batch");
        let db = db();
        let first = store::add_items(&db, vec![text_input("同名", "内容 A")])
            .unwrap()
            .items[0]
            .id
            .clone();
        let second = store::add_items(&db, vec![text_input("同名", "内容 B")])
            .unwrap()
            .items[0]
            .id
            .clone();
        let ids = vec![first, second];

        let renamed = plan_of(&db, &ids, &dir, &TransferOptions::default());
        assert_eq!(renamed.written.len(), 2);
        assert_ne!(renamed.written[0].name, renamed.written[1].name, "批次内也要去重");

        let skipped_options = TransferOptions {
            conflict: "skip".into(),
            ..TransferOptions::default()
        };
        let skipped = plan_of(&db, &ids, &dir, &skipped_options);
        assert_eq!(skipped.written.len(), 1);
        assert_eq!(skipped.skipped.len(), 1, "skip 策略下第二条如实跳过");

        let overwrite_options = TransferOptions {
            conflict: "overwrite".into(),
            ..TransferOptions::default()
        };
        let overwritten = plan_of(&db, &ids, &dir, &overwrite_options);
        assert_eq!(overwritten.written.len(), 2);
        assert_ne!(
            overwritten.written[0].name, overwritten.written[1].name,
            "overwrite 只针对磁盘已有文件，批次内两条不同内容不能互相覆盖"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merged_text_counts_units_by_item() {
        let dir = temp_dir("merge");
        let db = db();
        let mut ids = Vec::new();
        for index in 0..3 {
            ids.push(
                store::add_items(&db, vec![text_input(&format!("片段{index}"), &format!("段落{index}"))])
                    .unwrap()
                    .items[0]
                    .id
                    .clone(),
            );
        }
        let options = TransferOptions {
            text_mode: "merge".into(),
            ..TransferOptions::default()
        };
        let plan = plan_of(&db, &ids, &dir, &options);
        assert_eq!(plan.written.len(), 1, "三段文本合并成一个文件");
        assert_eq!(plan.written[0].item_ids.len(), 3);
        assert_eq!(plan.units(), 3, "进度单位按条目计，不是按文件数");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn directory_item_is_planned_as_directory_copy() {
        let dir = temp_dir("dircopy");
        let source = temp_dir("dirsrc");
        let db = db();
        let input = TransferItemInput {
            id: None,
            item_type: "directory".into(),
            source_module: "files".into(),
            source_id: source.to_string_lossy().to_string(),
            title: "子目录".into(),
            description: String::new(),
            content: String::new(),
            payload: serde_json::json!({ "path": source.to_string_lossy() }),
            pinned: false,
        };
        let id = store::add_items(&db, vec![input]).unwrap().items[0].id.clone();
        let plan = plan_of(&db, &[id], &dir, &TransferOptions::default());
        assert_eq!(plan.copies.len(), 1);
        assert!(plan.copies[0].is_dir, "目录必须按目录复制");
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&source).ok();
    }

    #[test]
    fn missing_source_is_reported_not_silently_dropped() {
        let dir = temp_dir("missing");
        let db = db();
        // 加入时路径存在，规划前删除：必须出现在 unsupported，而不是被静默跳过。
        let source = temp_dir("vanish");
        let input = TransferItemInput {
            id: None,
            item_type: "file".into(),
            source_module: "files".into(),
            source_id: source.join("a.txt").to_string_lossy().to_string(),
            title: "a.txt".into(),
            description: String::new(),
            content: String::new(),
            payload: serde_json::json!({ "path": source.join("a.txt").to_string_lossy() }),
            pinned: false,
        };
        std::fs::write(source.join("a.txt"), "x").unwrap();
        let id = store::add_items(&db, vec![input]).unwrap().items[0].id.clone();
        std::fs::remove_dir_all(&source).ok();

        let plan = plan_of(&db, &[id], &dir, &TransferOptions::default());
        assert_eq!(plan.copies.len(), 0);
        assert_eq!(plan.unsupported.len(), 1);
        let reason = &plan.unsupported[0].reason;
        assert!(
            reason.contains("失效") || reason.contains("不存在"),
            "失效来源必须给出原因，实际：{reason}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reserved_windows_name_falls_back_to_safe_name() {
        let dir = temp_dir("reserved");
        let mut names = NameBook::new();
        let name = names
            .claim(&dir, "CON.txt", fw::Conflict::Rename)
            .expect("保留名不能导致规划失败")
            .expect("应得到安全文件名");
        assert_ne!(name, "CON.txt");
        std::fs::remove_dir_all(&dir).ok();
    }
}
