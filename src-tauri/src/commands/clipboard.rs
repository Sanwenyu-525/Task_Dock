//! 智能剪贴板命令层：历史/分组/复制/逐项粘贴/任务关联/Agent 导出。
//!
//! 列表接口只返回预览（正文与 HTML 清空），完整内容通过 `clipboard_item` 单条获取，
//! 避免一次把数百条大文本/网页塞进前端内存。

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::clipboard::agent_bridge::{self, AgentClipboardTarget, ExportPackage};
use crate::clipboard::paste::{self, PasteStartReport};
use crate::clipboard::platform::{self, ClipboardPayload, TargetWindow};
use crate::clipboard::store::{self, ClipboardFilter, ClipboardTaskLink, PasteJob};
use crate::clipboard::{
    engine, CleanupReport, ClearReport, ClipboardGroup, ClipboardItem, ClipboardRuntime,
    ClipboardStats, ClipboardView, CopyReport, DeleteReport, KIND_FILES, KIND_IMAGE, KIND_URL,
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
    // 只累加使用次数，列表顺序不变；前端局部更新该条目，无需整表刷新。
    store::bump_copy(&rt.db, &item_id)?;
    Ok(CopyReport {
        mode: mode.into(),
        bytes,
        warnings: item_copy_warnings(&item),
        sequence: seq,
        item_count: 1,
    })
}

/// 通用文本写入（路径、目录、令牌等）：与单项复制共用同一条受控写入路径。
///
/// 必须走 Rust 端 `write_payload_notifying`：WebView 的 Clipboard API 写入
/// 无法登记自写序列号，监听线程会把它当成外部复制重新入库。
#[tauri::command]
pub fn clipboard_copy_text(state: State<'_, Arc<ClipboardRuntime>>, text: String) -> AppResult<()> {
    let rt = runtime(&state);
    let payload = ClipboardPayload::Text { text, html: None };
    platform::write_payload_notifying(&payload, &rt.self_write)?;
    Ok(())
}

// ── 多类型内容专属操作（v0.7）：图片另存 / 链接打开 / 文件打开与定位 ──

/// 图片另存为：把落盘的原始 PNG 写入用户经系统保存对话框选择的路径。
///
/// 覆盖确认由系统保存对话框完成（用户在对话框里确认覆盖即非静默）；
/// 这里只校验路径形态并如实写入，失败（权限/占用/盘满）原样上报。
#[tauri::command]
pub fn clipboard_save_image(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
    path: String,
) -> AppResult<u64> {
    let rt = runtime(&state);
    let abs = store::image_abs_path(&rt.db, &rt.root, &item_id)
        .ok_or_else(|| AppError::NotFound("图片缓存不存在或已被清理，无法保存".into()))?;
    let bytes = std::fs::read(&abs)?;
    let target = validate_save_path(&path)?;
    std::fs::write(&target, &bytes).map_err(|e| {
        AppError::Io(std::io::Error::new(
            e.kind(),
            format!("写入失败（{}）：{}", target.display(), e),
        ))
    })?;
    Ok(bytes.len() as u64)
}

/// 另存路径校验：绝对路径 + .png 扩展名（存储格式是 PNG，防止写出打不开的文件）。
fn validate_save_path(path: &str) -> AppResult<std::path::PathBuf> {
    let target = std::path::PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err(AppError::Validation("保存路径为空".into()));
    }
    if !target.is_absolute() {
        return Err(AppError::Validation("保存路径必须是绝对路径".into()));
    }
    match target.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("png") => Ok(target),
        _ => Err(AppError::Validation(
            "保存路径必须以 .png 结尾（存储格式为 PNG）".into(),
        )),
    }
}

/// 用系统默认浏览器打开链接条目。
///
/// URL 取自库内条目正文（不信任前端回传），复用导航模块的 URL 校验
/// （仅允许 http/https、长度与非法字符限制），打开委托给 opener 插件，
/// 结果是委派性质——不宣称浏览器已成功加载。
#[tauri::command]
pub fn clipboard_open_url(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
) -> AppResult<()> {
    let rt = runtime(&state);
    let item = store::get_item(&rt.db, &item_id)?;
    if item.kind != KIND_URL {
        return Err(AppError::Validation("该条目不是链接类型".into()));
    }
    crate::navigation::validate_url(&item.text)?;
    use tauri_plugin_opener::OpenerExt;
    rt.app
        .opener()
        .open_url(item.text.trim(), None::<&str>)
        .map_err(|e| AppError::Validation(format!("打开链接失败：{}", e)))
}

/// 用系统关联程序打开本地文件/目录：路径复用导航模块校验（绝对路径 + 必须存在）。
#[tauri::command]
pub fn clipboard_open_local_path(path: String, app: AppHandle) -> AppResult<()> {
    let p = crate::navigation::validate_local_path(&path)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(p.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| AppError::Validation(format!("打开失败：{}", e)))
}

/// 在资源管理器中定位文件（/select）。与导航 router 的 reveal 行为一致。
#[tauri::command]
pub fn clipboard_reveal_local_path(path: String) -> AppResult<()> {
    let p = crate::navigation::validate_local_path(&path)?;
    let arg = format!("/select,{}", p.display());
    std::process::Command::new("explorer.exe")
        .arg(&arg)
        .spawn()
        .map_err(|e| AppError::Validation(format!("资源管理器启动失败：{}", e)))?;
    Ok(())
}

/// 批量查询文件路径状态：ok / missing / inaccessible。
///
/// 供详情页区分「已移动/删除」与「无权限」，上限 200 条防止滥用。
#[tauri::command]
pub fn clipboard_path_status(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .take(200)
        .map(|p| match std::fs::metadata(p.trim()) {
            Ok(_) => "ok".into(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "missing".into(),
            Err(_) => "inaccessible".into(),
        })
        .collect()
}

fn load_group_items(rt: &ClipboardRuntime, group_id: &str) -> AppResult<ClipboardGroup> {
    store::get_group(&rt.db, group_id)
}

/// 富文本批量复制共享实现（整组与任意多选共用）：
/// 文字/HTML/链接按传入顺序拼接，图片以 data URI 内嵌（≤6MB）。
fn copy_rich_impl(rt: &ClipboardRuntime, items: &[ClipboardItem]) -> AppResult<CopyReport> {
    let (html, plain, mut warnings) =
        engine::group_rich_html(items, &|id| store::image_png(&rt.db, &rt.root, id));
    let payload = ClipboardPayload::Text {
        text: plain,
        html: Some(html),
    };
    let bytes = payload_bytes(&payload);
    let seq = platform::write_payload_notifying(&payload, &rt.self_write)?;
    warnings.push("已写入富文本；目标应用若不支持 HTML 将退回纯文本".into());
    Ok(CopyReport {
        mode: "html".into(),
        bytes,
        warnings,
        sequence: seq,
        item_count: items.len() as i64,
    })
}

/// 文件列表批量复制共享实现：文件条目取原始路径、图片条目取本地缓存原图。
fn copy_files_impl(rt: &ClipboardRuntime, items: &[ClipboardItem]) -> AppResult<CopyReport> {
    let mut paths: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for (idx, item) in items.iter().enumerate() {
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
        return Err(AppError::Validation("没有可复制的文件或图片".into()));
    }
    if !warnings.is_empty() {
        warnings.push("图片使用 Task Dock 本地缓存路径，清理历史后该路径会失效".into());
    }
    let payload = ClipboardPayload::Files {
        paths: paths.clone(),
    };
    let seq = platform::write_payload_notifying(&payload, &rt.self_write)?;
    Ok(CopyReport {
        mode: "files".into(),
        bytes: paths.iter().map(|p| p.len()).sum::<usize>() as i64,
        warnings,
        sequence: seq,
        item_count: paths.len() as i64,
    })
}

/// 整组富文本复制。
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
    copy_rich_impl(rt, &group.items)
}

/// 任意多选批量富文本复制：按选择顺序整合，不创建永久分组。
#[tauri::command]
pub fn clipboard_copy_items_rich(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_ids: Vec<String>,
) -> AppResult<CopyReport> {
    let rt = runtime(&state);
    let items = store::get_items_by_ids(&rt.db, &item_ids)?;
    if items.is_empty() {
        return Err(AppError::Validation("所选条目不存在或已删除".into()));
    }
    copy_rich_impl(rt, &items)
}

/// 整组文件复制：把分组内的文件与图片原图作为文件列表写入剪贴板。
#[tauri::command]
pub fn clipboard_copy_group_files(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
) -> AppResult<CopyReport> {
    let rt = runtime(&state);
    let group = load_group_items(rt, &group_id)?;
    copy_files_impl(rt, &group.items)
}

/// 任意多选批量文件复制：不把普通文字变成文件；缺失文件跳过并在警告中说明。
#[tauri::command]
pub fn clipboard_copy_items_files(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_ids: Vec<String>,
) -> AppResult<CopyReport> {
    let rt = runtime(&state);
    let items = store::get_items_by_ids(&rt.db, &item_ids)?;
    if items.is_empty() {
        return Err(AppError::Validation("所选条目不存在或已删除".into()));
    }
    copy_files_impl(rt, &items)
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

/// 编辑条目标题：非空设为手动标题（自动规则不再覆盖）；空串恢复自动生成。
#[tauri::command]
pub fn clipboard_rename_item(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
    title: String,
) -> AppResult<ClipboardItem> {
    let rt = runtime(&state);
    let item = store::rename_item(&rt.db, &item_id, &title)?;
    // 标题影响列表与分组搜索结果，广播让已打开的列表静默刷新
    rt.emit_changed("rename-item");
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

/// 一键清空：删除全部历史条目与分组（含收藏/置顶），解除任务/现场关联，
/// 并在提交后清理失去引用的内部缓存。系统剪贴板与外部原始文件不受影响。
#[tauri::command]
pub fn clipboard_clear_history(state: State<'_, Arc<ClipboardRuntime>>) -> AppResult<ClearReport> {
    let rt = runtime(&state);
    if rt.paste.is_active() {
        return Err(AppError::Validation(
            "粘贴进行中，暂不清空剪贴板历史".into(),
        ));
    }
    // 与入库线程互斥：先推进采集代数再删库，清空前产生的事件/排队内容
    // 不会在清空完成后把旧内容重新写回历史；清空期间新的外部复制仍会被记录。
    let _gate = rt.capture_gate.lock().unwrap_or_else(|e| e.into_inner());
    rt.capture_epoch.fetch_add(1, Ordering::SeqCst);
    let report = store::clear_history(&rt.db, &rt.root)?;
    rt.emit_changed("clear-history");
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

/// 任意多选逐项粘贴：不依赖永久分组，按传入顺序逐条写入并发送按键。
/// 复用整组粘贴的 PasteManager（互斥、取消、恢复、Unverified 语义全部一致），
/// 审计记录的 group_id 为空串。
#[tauri::command]
pub fn clipboard_paste_items(
    state: State<'_, Arc<ClipboardRuntime>>,
    target_hwnd: isize,
    item_ids: Vec<String>,
) -> AppResult<PasteStartReport> {
    let rt = runtime(&state);
    let items = store::get_items_by_ids(&rt.db, &item_ids)?;
    if items.is_empty() {
        return Err(AppError::Validation("所选条目不存在或已删除".into()));
    }
    let ids: Vec<String> = items.into_iter().map(|i| i.id).collect();
    rt.paste.start("", target_hwnd, &ids)
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
    // 与采集入库/清空互斥：避免在“资产文件已写、条目未插库”之间删除新采集的图片。
    let _gate = rt.capture_gate.lock().unwrap_or_else(|e| e.into_inner());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_path_accepts_absolute_png() {
        assert!(validate_save_path(r"D:\out\clip.png").is_ok());
        assert!(validate_save_path(r"  D:\out\CLIP.PNG  ").is_ok());
    }

    #[test]
    fn save_path_rejects_empty_relative_and_wrong_ext() {
        assert!(validate_save_path("").is_err());
        assert!(validate_save_path("   ").is_err());
        assert!(validate_save_path("clip.png").is_err());
        assert!(validate_save_path(r"D:\out\clip.jpg").is_err());
        assert!(validate_save_path(r"D:\out\clip").is_err());
    }
}
