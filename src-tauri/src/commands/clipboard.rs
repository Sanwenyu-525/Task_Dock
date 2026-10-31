//! 智能剪贴板命令层：历史/分组/复制/逐项粘贴/任务关联/Agent 导出。
//!
//! 列表接口只返回预览（正文与 HTML 清空），完整内容通过 `clipboard_item` 单条获取，
//! 避免一次把数百条大文本/网页塞进前端内存。

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::clipboard::agent_bridge::{self, AgentClipboardTarget, ExportPackage};
use crate::clipboard::paste::{self, PasteStartReport};
use crate::clipboard::platform::{self, ClipboardPayload, TargetWindow};
use crate::clipboard::store::{self, ClipboardFilter, ClipboardTaskLink, PasteJob};
use crate::clipboard::{
    engine, CleanupReport, ClipboardGroup, ClipboardItem, ClipboardRuntime, ClipboardStats,
    ClipboardView, CopyReport, DeleteReport, KIND_FILES, KIND_IMAGE,
};
use crate::db::Settings;
use crate::error::{AppError, AppResult};

fn compact(mut item: ClipboardItem) -> ClipboardItem {
    item.text = item.preview.clone();
    item.html.clear();
    item
}

fn runtime<'a>(state: &'a State<'_, Arc<ClipboardRuntime>>) -> &'a Arc<ClipboardRuntime> {
    state.inner()
}

#[tauri::command]
pub fn clipboard_view(
    state: State<'_, Arc<ClipboardRuntime>>,
    filter: Option<ClipboardFilter>,
) -> AppResult<ClipboardView> {
    let rt = runtime(&state);
    let settings = Settings::load_clipboard(&rt.db).settings;
    let filter = filter.unwrap_or_default();
    let mut view = store::view(&rt.db, &filter, &settings)?;
    for item in &mut view.items {
        *item = compact(item.clone());
    }
    Ok(view)
}

#[tauri::command]
pub fn clipboard_item(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
) -> AppResult<ClipboardItem> {
    store::get_item(&runtime(&state).db, &item_id)
}

#[tauri::command]
pub fn clipboard_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let mut group = store::get_group(&rt.db, &group_id)?;
    for item in &mut group.items {
        *item = compact(item.clone());
    }
    Ok(group)
}

#[tauri::command]
pub fn clipboard_stats(state: State<'_, Arc<ClipboardRuntime>>) -> AppResult<ClipboardStats> {
    let rt = runtime(&state);
    let settings = Settings::load_clipboard(&rt.db).settings;
    store::stats(&rt.db, &settings)
}

#[tauri::command]
pub fn clipboard_thumb(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
) -> AppResult<Option<String>> {
    let rt = runtime(&state);
    store::thumb_data_url(&rt.db, &rt.root, &item_id)
}

#[tauri::command]
pub fn clipboard_image(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
) -> AppResult<Option<String>> {
    let rt = runtime(&state);
    store::image_data_url(&rt.db, &rt.root, &item_id)
}

fn variant_mode(payload: &ClipboardPayload) -> &'static str {
    match payload {
        ClipboardPayload::Text { html: Some(_), .. } => "html",
        ClipboardPayload::Text { .. } => "text",
        ClipboardPayload::Image { .. } => "image",
        ClipboardPayload::Files { .. } => "files",
    }
}

fn payload_bytes(payload: &ClipboardPayload) -> i64 {
    match payload {
        ClipboardPayload::Text { text, html } => {
            (text.len() + html.as_ref().map(|h| h.len()).unwrap_or(0)) as i64
        }
        ClipboardPayload::Image { png, .. } => png.len() as i64,
        ClipboardPayload::Files { paths } => paths.iter().map(|p| p.len()).sum::<usize>() as i64,
    }
}

fn item_copy_warnings(item: &ClipboardItem) -> Vec<String> {
    if item.kind != KIND_FILES {
        return Vec::new();
    }
    let missing = item
        .file_paths
        .iter()
        .filter(|p| !std::path::Path::new(p).is_file())
        .count();
    if missing > 0 {
        vec![format!(
            "{missing} 个文件路径已不存在，粘贴到目标应用后可能缺失"
        )]
    } else {
        Vec::new()
    }
}

/// 单条复制（显式操作）：写入与自写登记在同一访问锁内完成，监听侧不会重复记录。
#[tauri::command]
pub fn clipboard_copy_item(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
) -> AppResult<CopyReport> {
    let rt = runtime(&state);
    let item = store::get_item(&rt.db, &item_id)?;
    let payload = crate::clipboard::paste::payload_for_item(&rt.db, &rt.root, &item)?;
    let mode = variant_mode(&payload);
    let bytes = payload_bytes(&payload);
    let seq = platform::write_payload_notifying(&payload, &rt.self_write)?;
    store::bump_copy(&rt.db, &item_id)?;
    rt.emit_changed("copy-item");
    Ok(CopyReport {
        mode: mode.into(),
        bytes,
        warnings: item_copy_warnings(&item),
        sequence: seq,
        item_count: 1,
    })
}

fn load_group_items(rt: &ClipboardRuntime, group_id: &str) -> AppResult<ClipboardGroup> {
    store::get_group(&rt.db, group_id)
}

/// 整组富文本复制：文字/HTML/链接按顺序拼接，图片以 data URI 内嵌（≤6MB）。
#[tauri::command]
pub fn clipboard_copy_group_rich(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
) -> AppResult<CopyReport> {
    let rt = runtime(&state);
    let group = load_group_items(rt, &group_id)?;
    if group.items.is_empty() {
        return Err(AppError::Validation("分组为空，无可复制内容".into()));
    }
    let (html, plain, mut warnings) =
        engine::group_rich_html(&group.items, &|id| store::image_png(&rt.db, &rt.root, id));
    let payload = ClipboardPayload::Text {
        text: plain,
        html: Some(html),
    };
    let bytes = payload_bytes(&payload);
    let seq = platform::write_payload_notifying(&payload, &rt.self_write)?;
    warnings.push("已写入富文本；目标应用若不支持 HTML 将退回纯文本".into());
    rt.emit_changed("copy-group-rich");
    Ok(CopyReport {
        mode: "html".into(),
        bytes,
        warnings,
        sequence: seq,
        item_count: group.items.len() as i64,
    })
}

/// 整组文件复制：把分组内的文件与图片原图作为文件列表写入剪贴板。
#[tauri::command]
pub fn clipboard_copy_group_files(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
) -> AppResult<CopyReport> {
    let rt = runtime(&state);
    let group = load_group_items(rt, &group_id)?;
    let mut paths: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for (idx, item) in group.items.iter().enumerate() {
        match item.kind.as_str() {
            KIND_FILES => {
                for p in &item.file_paths {
                    if std::path::Path::new(p).is_file() {
                        paths.push(p.clone());
                    } else {
                        warnings.push(format!("第 {} 项的文件已不存在：{}", idx + 1, p));
                    }
                }
            }
            KIND_IMAGE => match store::image_abs_path(&rt.db, &rt.root, &item.id) {
                Some(p) => paths.push(p.to_string_lossy().into_owned()),
                None => warnings.push(format!("第 {} 项图片文件缺失，已跳过", idx + 1)),
            },
            _ => warnings.push(format!(
                "第 {} 项不是文件/图片，未包含在文件复制中",
                idx + 1
            )),
        }
    }
    if paths.is_empty() {
        return Err(AppError::Validation("分组内没有可复制的文件或图片".into()));
    }
    if !warnings.is_empty() {
        warnings.push("图片使用 Task Dock 本地缓存路径，清理历史后该路径会失效".into());
    }
    let payload = ClipboardPayload::Files {
        paths: paths.clone(),
    };
    let seq = platform::write_payload_notifying(&payload, &rt.self_write)?;
    rt.emit_changed("copy-group-files");
    Ok(CopyReport {
        mode: "files".into(),
        bytes: paths.iter().map(|p| p.len()).sum::<usize>() as i64,
        warnings,
        sequence: seq,
        item_count: paths.len() as i64,
    })
}

#[tauri::command]
pub fn clipboard_toggle_item(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
    flag: String,
) -> AppResult<ClipboardItem> {
    let rt = runtime(&state);
    let item = store::toggle_item_flag(&rt.db, &item_id, &flag)?;
    rt.emit_changed("toggle-item");
    Ok(item)
}

#[tauri::command]
pub fn clipboard_toggle_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    flag: String,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let group = store::toggle_group_flag(&rt.db, &group_id, &flag)?;
    rt.emit_changed("toggle-group");
    Ok(group)
}

#[tauri::command]
pub fn clipboard_close_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let group = store::close_group(&rt.db, &group_id)?;
    rt.emit_changed("close-group");
    Ok(group)
}

#[tauri::command]
pub fn clipboard_delete_items(
    state: State<'_, Arc<ClipboardRuntime>>,
    ids: Vec<String>,
) -> AppResult<DeleteReport> {
    let rt = runtime(&state);
    if rt.paste.is_active() {
        // 删除会连带删掉图片资产；粘贴队列按 id 逐项读取，
        // 资产先没了，后面的项只能以「图片文件缺失」跳过。
        return Err(AppError::Validation(
            "粘贴进行中，暂不删除剪贴板条目".into(),
        ));
    }
    let report = store::delete_items(&rt.db, &rt.root, &ids)?;
    rt.emit_changed("delete-items");
    Ok(report)
}

#[tauri::command]
pub fn clipboard_delete_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    also_delete_items: bool,
) -> AppResult<DeleteReport> {
    let rt = runtime(&state);
    if rt.paste.is_active() && also_delete_items {
        return Err(AppError::Validation(
            "粘贴进行中，暂不删除剪贴板条目".into(),
        ));
    }
    let report = store::delete_group(&rt.db, &rt.root, &group_id, also_delete_items)?;
    rt.emit_changed("delete-group");
    Ok(report)
}

#[tauri::command]
pub fn clipboard_create_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    name: String,
    item_ids: Vec<String>,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let group = store::create_manual_group(&rt.db, &name, &item_ids)?;
    rt.emit_changed("create-group");
    Ok(group)
}

#[tauri::command]
pub fn clipboard_rename_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    name: String,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let group = store::rename_group(&rt.db, &group_id, &name)?;
    rt.emit_changed("rename-group");
    Ok(group)
}

#[tauri::command]
pub fn clipboard_add_to_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    item_ids: Vec<String>,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let group = store::add_to_group(&rt.db, &group_id, &item_ids)?;
    rt.emit_changed("add-to-group");
    Ok(group)
}

#[tauri::command]
pub fn clipboard_remove_group_item(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    item_id: String,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let group = store::remove_group_item(&rt.db, &group_id, &item_id)?;
    rt.emit_changed("remove-group-item");
    Ok(group)
}

#[tauri::command]
pub fn clipboard_move_group_item(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    item_id: String,
    new_index: i64,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let group = store::move_group_item(&rt.db, &group_id, &item_id, new_index)?;
    rt.emit_changed("move-group-item");
    Ok(group)
}

#[tauri::command]
pub fn clipboard_split_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    item_ids: Vec<String>,
    name: String,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let group = store::split_group(&rt.db, &group_id, &item_ids, &name)?;
    rt.emit_changed("split-group");
    Ok(group)
}

#[tauri::command]
pub fn clipboard_merge_groups(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_ids: Vec<String>,
    name: String,
) -> AppResult<ClipboardGroup> {
    let rt = runtime(&state);
    let group = store::merge_groups(&rt.db, &group_ids, &name)?;
    rt.emit_changed("merge-groups");
    Ok(group)
}

#[tauri::command]
pub fn clipboard_link_task(
    state: State<'_, Arc<ClipboardRuntime>>,
    task_id: String,
    target_type: String,
    target_id: String,
) -> AppResult<ClipboardTaskLink> {
    let rt = runtime(&state);
    let link = store::link_task(&rt.db, &task_id, &target_type, &target_id)?;
    rt.emit_changed("link-task");
    Ok(link)
}

#[tauri::command]
pub fn clipboard_unlink_task(
    state: State<'_, Arc<ClipboardRuntime>>,
    link_id: String,
) -> AppResult<()> {
    let rt = runtime(&state);
    store::unlink_task(&rt.db, &link_id)?;
    rt.emit_changed("unlink-task");
    Ok(())
}

#[tauri::command]
pub fn clipboard_task_links(
    state: State<'_, Arc<ClipboardRuntime>>,
    task_id: String,
) -> AppResult<Vec<ClipboardTaskLink>> {
    store::task_links(&runtime(&state).db, &task_id)
}

#[tauri::command]
pub fn clipboard_link_snapshot(
    state: State<'_, Arc<ClipboardRuntime>>,
    snapshot_id: String,
    target_type: String,
    target_id: String,
) -> AppResult<store::ClipboardSnapshotLink> {
    let rt = runtime(&state);
    let link = store::link_snapshot(&rt.db, &snapshot_id, &target_type, &target_id)?;
    rt.emit_changed("link-snapshot");
    Ok(link)
}

#[tauri::command]
pub fn clipboard_unlink_snapshot(
    state: State<'_, Arc<ClipboardRuntime>>,
    link_id: String,
) -> AppResult<()> {
    let rt = runtime(&state);
    store::unlink_snapshot(&rt.db, &link_id)?;
    rt.emit_changed("unlink-snapshot");
    Ok(())
}

#[tauri::command]
pub fn clipboard_snapshot_links(
    state: State<'_, Arc<ClipboardRuntime>>,
    snapshot_id: String,
) -> AppResult<Vec<store::ClipboardSnapshotLink>> {
    store::snapshot_links(&runtime(&state).db, &snapshot_id)
}

#[tauri::command]
pub fn clipboard_visible_targets() -> Vec<TargetWindow> {
    platform::visible_targets()
}

#[tauri::command]
pub fn clipboard_foreground_target() -> Option<TargetWindow> {
    platform::foreground_target()
}

#[tauri::command]
pub fn clipboard_paste_precheck(hwnd: isize) -> AppResult<TargetWindow> {
    paste::precheck_target(hwnd)
}

#[tauri::command]
pub fn clipboard_paste_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    target_hwnd: isize,
    item_ids: Option<Vec<String>>,
) -> AppResult<PasteStartReport> {
    let rt = runtime(&state);
    let ids = match item_ids.filter(|v| !v.is_empty()) {
        Some(v) => v,
        None => store::get_group(&rt.db, &group_id)?
            .items
            .into_iter()
            .map(|i| i.id)
            .collect(),
    };
    if ids.is_empty() {
        return Err(AppError::Validation("分组为空，无法逐项粘贴".into()));
    }
    rt.paste.start(&group_id, target_hwnd, &ids)
}

#[tauri::command]
pub fn clipboard_paste_cancel(
    state: State<'_, Arc<ClipboardRuntime>>,
    job_id: String,
) -> AppResult<()> {
    runtime(&state).paste.cancel(&job_id)
}

#[tauri::command]
pub fn clipboard_paste_resume(
    state: State<'_, Arc<ClipboardRuntime>>,
    job_id: String,
    target_hwnd: isize,
) -> AppResult<PasteStartReport> {
    runtime(&state).paste.resume(&job_id, target_hwnd)
}

#[tauri::command]
pub fn clipboard_paste_job(
    state: State<'_, Arc<ClipboardRuntime>>,
    job_id: String,
) -> AppResult<PasteJob> {
    store::get_paste_job(&runtime(&state).db, &job_id)
}

#[tauri::command]
pub fn clipboard_paste_active(state: State<'_, Arc<ClipboardRuntime>>) -> Option<String> {
    runtime(&state).paste.active_job()
}

#[tauri::command]
pub fn clipboard_cleanup(state: State<'_, Arc<ClipboardRuntime>>) -> AppResult<CleanupReport> {
    let rt = runtime(&state);
    if rt.paste.is_active() {
        // 清理会删除条目与资产；粘贴队列按 id 逐项读取，删除会让后续项直接丢失。
        return Err(AppError::Validation(
            "粘贴进行中，暂不清理剪贴板历史".into(),
        ));
    }
    let config = Settings::load_clipboard(&rt.db);
    if let Some(error) = config.error.as_ref() {
        // 容量/保留参数不可靠时不得按错误上限清理历史数据。
        return Err(AppError::Validation(format!(
            "剪贴板配置异常，已停止清理：{}",
            error.message()
        )));
    }
    let report = store::cleanup(&rt.db, &rt.root, &config.settings)?;
    rt.emit_changed("cleanup");
    Ok(report)
}

#[tauri::command]
pub fn clipboard_status(state: State<'_, Arc<ClipboardRuntime>>) -> serde_json::Value {
    let rt = runtime(&state);
    let config = Settings::load_clipboard(&rt.db);
    serde_json::json!({
        // 配置异常时对外如实报告「未启用 / 已暂停」，避免界面显示“监听中”。
        "enabled": config.error.is_none() && config.settings.clipboard_enabled,
        "paused": config.error.is_some() || config.settings.clipboard_paused,
        "monitoring": rt.monitoring(),
        "configError": config.error,
        "configOrigin": config.origin,
        "captureAllowed": config.capture_allowed(),
        "activeJob": rt.paste.active_job(),
        "platform": std::env::consts::OS,
        "monitor": platform::monitor_stats(),
    })
}

#[tauri::command]
pub fn clipboard_agent_targets(
    state: State<'_, Arc<ClipboardRuntime>>,
) -> Vec<AgentClipboardTarget> {
    agent_bridge::targets(&runtime(&state).db)
}

#[tauri::command]
pub fn clipboard_export_for_agent(
    app: AppHandle,
    state: State<'_, Arc<ClipboardRuntime>>,
    target_type: String,
    target_id: String,
    task_id: Option<String>,
) -> AppResult<ExportPackage> {
    let rt = runtime(&state);
    let data_dir = crate::app_data_dir(&app);
    let pkg = agent_bridge::export_package(
        &rt.db,
        &rt.root,
        &data_dir,
        &target_type,
        &target_id,
        task_id.as_deref(),
    )?;
    rt.emit_changed("export-agent");
    Ok(pkg)
}

#[tauri::command]
pub fn clipboard_export_preview(
    state: State<'_, Arc<ClipboardRuntime>>,
    target_type: String,
    target_id: String,
) -> AppResult<serde_json::Value> {
    agent_bridge::export_preview(&runtime(&state).db, &target_type, &target_id)
}

/// 剪贴板保护自检：读取当前内容并返回格式类型（不返回正文），
/// 供验收与设置页「当前剪贴板可读取」诊断使用。
#[tauri::command]
pub fn clipboard_probe() -> serde_json::Value {
    match platform::read_clipboard(true) {
        platform::ClipboardRead::Content { content: c, .. } => serde_json::json!({
            "readable": true,
            "kind": c.kind,
            "bytes": if c.kind == KIND_IMAGE {
                c.image.as_ref().map(|i| i.png.len()).unwrap_or(0)
            } else {
                c.text.len() + c.html.len()
            },
            "hasImage": c.image.is_some(),
            "fileCount": c.file_paths.len(),
        }),
        platform::ClipboardRead::Skip(reason) => {
            serde_json::json!({ "readable": false, "reason": reason })
        }
        platform::ClipboardRead::Empty(reason) => {
            serde_json::json!({ "readable": false, "reason": reason })
        }
    }
}
