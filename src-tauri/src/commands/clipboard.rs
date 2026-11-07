//! 智能剪贴板命令层：历史/分组/复制/逐项粘贴/任务关联/Agent 导出。
//!
//! 列表接口只返回预览（正文与 HTML 清空），完整内容通过 `clipboard_item` 单条获取，
//! 避免一次把数百条大文本/网页塞进前端内存。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::clipboard::agent_bridge::{self, AgentTargetsSnapshot, ExportPackage};
use crate::clipboard::export;
use crate::clipboard::paste::{self, PasteStartReport};
use crate::clipboard::platform::{self, ClipboardPayload, TargetWindow};
use crate::clipboard::store::{self, ClipboardFilter, ClipboardTaskLink, PasteJob};
use crate::clipboard::{
    engine, ocr::OcrReport, CleanupReport, ClearReport, ClipboardGroup, ClipboardGroupItemPosition,
    ClipboardGroupPage, ClipboardItem, ClipboardRuntime, ClipboardStats, ClipboardView, CopyReport,
    DeleteReport, KIND_FILES, KIND_IMAGE, KIND_URL,
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

/// Lite 分组有界分页：SQL 阶段排序/筛选/LIMIT，不读正文与原图字节。
///
/// `imagesOnly=true` 时只返回图片条目；`limit` 超过 `store::GROUP_PAGE_MAX_LIMIT` 时
/// 按上限截断，实际生效值随响应返回。完整分组详情仍走 `clipboard_group`（行为不变）。
#[tauri::command]
pub fn clipboard_group_page(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    images_only: Option<bool>,
) -> AppResult<ClipboardGroupPage> {
    store::get_group_page(
        &runtime(&state).db,
        &group_id,
        limit,
        offset,
        images_only.unwrap_or(false),
    )
}

/// Lite 原图预览的条目定位：返回条目在组内「图片序列」中的 0-based 序位与组版本。
///
/// 与 `clipboard_group_page` 同风格（同步命令、有界查询），供前端在组内容变化后按
/// 图片 ID 恢复当前预览。组不存在 → NotFound；条目不在组内或不是图片 → found=false。
#[tauri::command]
pub fn clipboard_group_item_position(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    item_id: String,
) -> AppResult<ClipboardGroupItemPosition> {
    store::get_group_item_position(&runtime(&state).db, &group_id, &item_id)
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
    // 剪贴板写入成功即复制成功。使用次数只是附带统计：统计持久化失败不能把一次
    // 真实成功的复制改判为失败（用户会看到「复制失败」并重复复制）。失败时通过
    // warnings 让前端显示「部分成功」，且不本地累加次数（没落库的次数不能显示）；
    // 绝不为了补偿统计而重复写剪贴板，也不改变列表排序语义。
    let mut warnings = item_copy_warnings(&item);
    let stats_recorded = match store::bump_copy(&rt.db, &item_id) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("剪贴板使用次数记录失败：{e}");
            warnings.push("使用次数未能记录（统计写入失败），不影响本次复制".into());
            false
        }
    };
    Ok(CopyReport {
        mode: mode.into(),
        bytes,
        warnings,
        sequence: seq,
        item_count: 1,
        stats_recorded,
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

/// 有界并发闸门（图片保存与路径状态检查共用）。
///
/// 满额直接返回可重试的 `Overloaded`，不排队、不新开线程；配额由 [`QuotaGuard`]
/// 在后台任务真正结束（成功、失败或 panic 展开）时归还，进程内后台任务数有上界。
struct Quota {
    active: &'static AtomicUsize,
    limit: usize,
    busy: &'static str,
}

impl Quota {
    fn acquire(&'static self) -> AppResult<QuotaGuard> {
        self.active
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < self.limit).then_some(n + 1)
            })
            .map(|_| QuotaGuard {
                active: self.active,
            })
            .map_err(|_| AppError::Overloaded(self.busy.into()))
    }
}

/// 一个已占用的配额；移入后台闭包后随闭包结束归还，`Drop` 在 panic 展开时同样执行。
struct QuotaGuard {
    active: &'static AtomicUsize,
}

impl Drop for QuotaGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 图片另存为：前端已有同步 in-flight 守卫，这里再加一道上限，即使绕过 UI 直接
/// 连发 IPC，也不会把阻塞线程池堆成无界的写盘队列。
const MAX_CONCURRENT_SAVES: usize = 2;
static ACTIVE_SAVES: AtomicUsize = AtomicUsize::new(0);
static SAVE_QUOTA: Quota = Quota {
    active: &ACTIVE_SAVES,
    limit: MAX_CONCURRENT_SAVES,
    busy: "图片保存任务过多，请稍后重试",
};

/// 文件路径状态检查：网络盘/断连盘上的 `metadata` 可能长时间阻塞，限制同时存在的
/// 批量任务数，避免连发请求把阻塞线程池排满；超限同样直接拒绝。
const MAX_CONCURRENT_PATH_CHECKS: usize = 3;
static ACTIVE_PATH_CHECKS: AtomicUsize = AtomicUsize::new(0);
static PATH_STATUS_QUOTA: Quota = Quota {
    active: &ACTIVE_PATH_CHECKS,
    limit: MAX_CONCURRENT_PATH_CHECKS,
    busy: "文件状态检查任务过多，请稍后重试",
};

/// 本地 OCR：同一时刻只允许 1 个识别任务。第二张图直接得到 busy 反馈，
/// 不排队、不新开线程；前端加载态同时禁用按钮，重复点击不会重复启动。
const MAX_CONCURRENT_OCR: usize = 1;
static ACTIVE_OCR: AtomicUsize = AtomicUsize::new(0);
static OCR_QUOTA: Quota = Quota {
    active: &ACTIVE_OCR,
    limit: MAX_CONCURRENT_OCR,
    busy: "另一张图片正在识别，请稍后重试",
};

/// 图片另存为：把落盘的原始 PNG 写入用户选择的路径，返回写入的字节数。
///
/// **覆盖授权**：系统保存对话框只负责选路径，不构成可验证的覆盖授权。前端在目标
/// 已存在时先经应用内确认框取得授权，再把 `overwrite=true` 显式传入；后端不缓存、
/// 不复用授权，也绝不因冲突自行改走覆盖分支。
///
/// **执行**：资源定位（短小的本地查询）在命令线程完成；读取缓存 PNG 与写盘是阻塞
/// I/O，整体移入 Tauri 阻塞线程池，不在主线程/异步运行时等待。失败清理、排他创建
/// 与安全替换的边界都在 [`export::save_png_bytes`]：
/// - `overwrite=false` 时目标已存在返回「目标文件已存在，未覆盖」，绝不静默覆盖；
/// - `overwrite=true` 时用同目录临时文件 + rename 替换，失败不破坏原文件。
#[tauri::command]
pub async fn clipboard_save_image(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
    path: String,
    overwrite: bool,
) -> AppResult<u64> {
    let rt = runtime(&state);
    let abs = store::image_abs_path(&rt.db, &rt.root, &item_id)
        .ok_or_else(|| AppError::NotFound("图片缓存不存在或已被清理，无法保存".into()))?;
    let target = validate_save_path(&path)?;
    let slot = SAVE_QUOTA.acquire()?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<u64> {
        // 配额随闭包存活到后台任务真正结束（含 panic 展开），不会提前归还。
        let _slot = slot;
        let bytes = std::fs::read(&abs)?;
        export::save_png_bytes(&target, &bytes, overwrite)
    })
    .await
    .map_err(|e| {
        // JoinError 只说明后台任务异常结束（panic 或被取消）；如实上报，不伪装成功。
        AppError::Io(std::io::Error::other(format!(
            "图片保存后台任务异常结束：{e}"
        )))
    })?
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

/// 图片文字识别（本地 Windows OCR）：入参只有已有条目 id，Rust 侧直接读图片缓存，
/// 不通过 IPC 传整张 PNG。识别在阻塞线程池执行，同一时刻最多 1 个任务。
///
/// 返回结构化状态而不是抛错：busy / unavailable / empty / cancelled 都是正常结果，
/// 前端据此恢复按钮并给出明确提示。`request_id` 由前端生成，用于精准取消当前任务。
#[tauri::command]
pub async fn clipboard_ocr(
    state: State<'_, Arc<ClipboardRuntime>>,
    item_id: String,
    request_id: String,
) -> AppResult<OcrReport> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() || request_id.len() > 64 {
        return Err(AppError::Validation("识别请求标识无效".into()));
    }
    let rt = runtime(&state).clone();
    let slot = match OCR_QUOTA.acquire() {
        Ok(slot) => slot,
        // 并发上限：不排队、不报错，回结构化忙碌状态让前端恢复按钮。
        Err(_) => return Ok(OcrReport::busy("另一张图片正在识别，请稍后重试")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        rt.ocr.recognize(&rt.db, &rt.root, &item_id, &request_id)
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(format!("识别后台任务异常结束：{e}"))))
}

/// 取消进行中的识别（只匹配同一个 `request_id`，切换条目后的旧取消不会误伤新请求）。
/// 返回是否真的命中当前任务；未命中不算错误。
#[tauri::command]
pub fn clipboard_ocr_cancel(
    state: State<'_, Arc<ClipboardRuntime>>,
    request_id: String,
) -> AppResult<bool> {
    Ok(runtime(&state).ocr.cancel(request_id.trim()))
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

/// 批量路径状态的执行体（纯函数，便于单测）：最多处理 200 条，保留输入顺序。
fn path_states(paths: Vec<String>) -> Vec<String> {
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

/// 批量查询文件路径状态：ok / missing / inaccessible。
///
/// 供详情页区分「已移动/删除」与「无权限」，上限 200 条防止滥用。
///
/// `metadata` 在机械盘、网络共享或断连盘上可能长时间阻塞；这里把整批查询放进
/// **一个**阻塞线程池任务（不按路径开线程），避免卡住 UI 线程。同时最多允许
/// [`MAX_CONCURRENT_PATH_CHECKS`] 个批量任务并行：超出立即以可重试的 `Overloaded`
/// 拒绝，不排无界队列。成功返回值与字段不变；后台任务异常结束时以错误拒绝，
/// 前端按「未知」处理，绝不把所有路径当成存在，也不把「繁忙」误当成文件丢失。
#[tauri::command]
pub async fn clipboard_path_status(paths: Vec<String>) -> AppResult<Vec<String>> {
    // 配额在进入线程池前获取：超限时立即拒绝，不形成等待队列。
    let slot = PATH_STATUS_QUOTA.acquire()?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<String>> {
        // 配额随闭包存活到批量查询真正结束（含 panic 展开），不会提前归还。
        let _slot = slot;
        Ok(path_states(paths))
    })
    .await
    .map_err(|e| {
        AppError::Io(std::io::Error::other(format!(
            "路径状态检查后台任务异常结束：{e}"
        )))
    })?
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
        // 批量复制不累加单条使用次数，不存在统计失败。
        stats_recorded: true,
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
        // 批量复制不累加单条使用次数，不存在统计失败。
        stats_recorded: true,
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
    // 只失效被删条目的 OCR 结果缓存，其余条目不受影响；确实删除了才推进代数。
    if report.deleted > 0 {
        rt.ocr.invalidate_items(&ids);
    }
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
    // 按「条目仍存在且内容哈希未变」校正缓存：删掉的随组失效，未删的保留；
    // 实际删除了条目时即使缓存为空也推进代数，避免在跑的旧任务回写已删条目。
    rt.ocr.retain_existing(&rt.db, report.deleted > 0);
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
    // 记录清空时刻的剪贴板序列号：清空前入队、清空后才派发的旧事件
    // 即使拿到新代数，采集侧也会因「不晚于清空水位」把它丢弃。
    rt.clear_seq.store(
        crate::clipboard::platform::current_sequence(),
        Ordering::SeqCst,
    );
    rt.capture_epoch.fetch_add(1, Ordering::SeqCst);
    let report = store::clear_history(&rt.db, &rt.root)?;
    // 清空后整体失效；识别中的旧任务因代数变化不会再写回缓存。
    rt.ocr.clear_cache();
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

/// 目标窗口图标提取：轻量但会读盘，限制同时解码的数量，避免多窗口刷新时堆积。
const MAX_CONCURRENT_ICON_EXTRACTS: usize = 2;
static ACTIVE_ICON_EXTRACTS: AtomicUsize = AtomicUsize::new(0);
static ICON_QUOTA: Quota = Quota {
    active: &ACTIVE_ICON_EXTRACTS,
    limit: MAX_CONCURRENT_ICON_EXTRACTS,
    busy: "图标提取任务过多，请稍后重试",
};

/// 目标窗口的真实应用图标：按当前窗口身份重新解析可执行路径（PID 必须与选中时
/// 一致，防止 HWND/PID 复用后显示成别的应用），在阻塞线程池中按 exe 路径提取。
/// 返回 `None` 表示无图标或任务被限流，前端统一回退到通用窗口图标。
#[tauri::command]
pub async fn clipboard_target_icon(hwnd: isize, expected_pid: Option<u32>) -> Option<String> {
    let slot = ICON_QUOTA.acquire().ok()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        let target = platform::window_target(hwnd)?;
        if let Some(pid) = expected_pid {
            if pid != target.pid {
                return None;
            }
        }
        if target.pid == std::process::id() {
            return None;
        }
        crate::navigation::app_icons::extract_icon_for_exe(&target.exe_path)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub fn clipboard_foreground_target() -> Option<TargetWindow> {
    platform::foreground_target()
}

#[tauri::command]
pub fn clipboard_paste_precheck(hwnd: isize, expected_pid: Option<u32>) -> AppResult<TargetWindow> {
    paste::precheck_target(hwnd, expected_pid)
}

/// 跳转到目标窗口：只激活并核实前台，不写入剪贴板、不发送按键。
///
/// 校验顺序：窗口存在 → PID 与选中时一致（防 HWND 复用）→ 非本应用 → 权限 →
/// `focus_window` 激活 → 再次核实身份与前台。任何一步失败都返回具体原因，
/// 绝不把「已请求切换」当成成功。
#[tauri::command]
pub fn clipboard_focus_target(hwnd: isize, expected_pid: Option<u32>) -> AppResult<TargetWindow> {
    use crate::navigation::window_manager::{focus_window, FocusError};

    let target = paste::precheck_target(hwnd, expected_pid)?;
    match focus_window(hwnd) {
        Ok(_) => {}
        Err(FocusError::WindowVanished) => {
            return Err(AppError::Validation(
                "目标窗口已关闭（句柄失效），请刷新后重新选择".into(),
            ))
        }
        Err(e) => {
            return Err(AppError::Validation(format!(
                "未能切换到目标窗口：{}",
                e.reason_cn()
            )))
        }
    }
    // 切换动画期间窗口可能关闭或句柄被复用：以最终身份与前台状态为准。
    let after = platform::window_target(hwnd)
        .ok_or_else(|| AppError::Validation("目标窗口已关闭".into()))?;
    if after.pid != target.pid {
        return Err(AppError::Validation(
            "目标窗口已被其他窗口复用，请刷新后重新选择".into(),
        ));
    }
    if !platform::is_foreground(hwnd) {
        return Err(AppError::Validation(
            "已请求切换，但目标窗口未确认位于前台".into(),
        ));
    }
    Ok(after)
}

#[tauri::command]
pub fn clipboard_paste_group(
    state: State<'_, Arc<ClipboardRuntime>>,
    group_id: String,
    target_hwnd: isize,
    expected_pid: Option<u32>,
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
    let _gate = rt.capture_gate.lock().unwrap_or_else(|e| e.into_inner());
    rt.paste.start(&group_id, target_hwnd, expected_pid, &ids)
}

/// 任意多选逐项粘贴：不依赖永久分组，按传入顺序逐条写入并发送按键。
/// 复用整组粘贴的 PasteManager（互斥、取消、恢复、Unverified 语义全部一致），
/// 审计记录的 group_id 为空串。
#[tauri::command]
pub fn clipboard_paste_items(
    state: State<'_, Arc<ClipboardRuntime>>,
    target_hwnd: isize,
    expected_pid: Option<u32>,
    item_ids: Vec<String>,
) -> AppResult<PasteStartReport> {
    let rt = runtime(&state);
    let items = store::get_items_by_ids(&rt.db, &item_ids)?;
    if items.is_empty() {
        return Err(AppError::Validation("所选条目不存在或已删除".into()));
    }
    let ids: Vec<String> = items.into_iter().map(|i| i.id).collect();
    let _gate = rt.capture_gate.lock().unwrap_or_else(|e| e.into_inner());
    rt.paste.start("", target_hwnd, expected_pid, &ids)
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
    expected_pid: Option<u32>,
) -> AppResult<PasteStartReport> {
    let rt = runtime(&state);
    let _gate = rt.capture_gate.lock().unwrap_or_else(|e| e.into_inner());
    rt.paste.resume(&job_id, target_hwnd, expected_pid)
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
    // 自动过期/超额清理后校正 OCR 缓存：已删除或内容变化的条目不再命中。
    rt.ocr.retain_existing(&rt.db, report.items_deleted > 0);
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
        // 维护线程（看门狗 + 过期清理）是否仍在运行：暂停后据此区分
        // 「已暂停」与「仍在收尾」，前端不得只凭 paused 文案冒充已释放资源。
        "maintenance": rt.maintenance_running(),
        // 采集实例是否正在异步回收（暂停不再阻塞 UI；回收完成前不算 paused）。
        "draining": rt.capture_draining(),
        "configError": config.error,
        "configOrigin": config.origin,
        "captureAllowed": config.capture_allowed(),
        "activeJob": rt.paste.active_job(),
        "platform": std::env::consts::OS,
        "monitor": platform::monitor_stats(),
    })
}

/// 探测含注册表/安装路径/进程与窗口枚举，单次实测 17–28s；同步命令会冻结主线程，
/// 因此移入 spawn_blocking。前端默认收起面板时不调用；`refresh=true` 由用户「重新探测」触发。
/// 返回真实快照时间与是否命中缓存，前端不得把响应到达时间当作扫描时间。
#[tauri::command]
pub async fn clipboard_agent_targets(
    state: State<'_, Arc<ClipboardRuntime>>,
    refresh: Option<bool>,
) -> AppResult<AgentTargetsSnapshot> {
    let db = runtime(&state).db.clone();
    let force = refresh.unwrap_or(false);
    let snapshot = tauri::async_runtime::spawn_blocking(move || agent_bridge::targets(&db, force))
        .await
        .map_err(|e| AppError::Agent(format!("Agent 探测任务失败: {e}")))?;
    Ok(snapshot)
}

/// 导出包需要复制/解码图片并写多个文件；大分组可能耗时，放到后台线程避免冻结主线程。
/// 只做线程迁移，导出格式与目录策略不变；前端关闭面板不会取消此任务，文件仍会保留。
#[tauri::command]
pub async fn clipboard_export_for_agent(
    app: AppHandle,
    state: State<'_, Arc<ClipboardRuntime>>,
    target_type: String,
    target_id: String,
    task_id: Option<String>,
) -> AppResult<ExportPackage> {
    let rt = runtime(&state).clone();
    let data_dir = crate::app_data_dir(&app);
    let worker = rt.clone();
    let pkg = tauri::async_runtime::spawn_blocking(move || {
        agent_bridge::export_package(
            &worker.db,
            &worker.root,
            &data_dir,
            &target_type,
            &target_id,
            task_id.as_deref(),
        )
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(format!("导出后台任务异常结束：{e}"))))??;
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
    use std::sync::Barrier;

    use super::*;

    /// 独立临时目录：只清理本测试创建的这一份。
    struct TempDir {
        path: std::path::PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "task-dock-cmd-{}-{}-{}",
                tag,
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path).expect("创建测试临时目录");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn save_slots_are_bounded_and_released_impl() {
        let first = SAVE_QUOTA.acquire().expect("第 1 个配额应可用");
        let second = SAVE_QUOTA.acquire().expect("第 2 个配额应可用");
        assert!(
            matches!(SAVE_QUOTA.acquire(), Err(AppError::Overloaded(_))),
            "超过上限必须返回可重试的 Overloaded，而不是排队或无界写入"
        );
        drop(first);
        let third = SAVE_QUOTA.acquire().expect("配额归还应允许再次获取");
        drop(second);
        drop(third);
        assert!(SAVE_QUOTA.acquire().is_ok(), "全部归还后必须恢复可获取");
    }

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

    #[test]
    fn save_slots_are_bounded_and_released() {
        save_slots_are_bounded_and_released_impl();
    }

    /// 并发抢占：配额上限是硬上界，超额请求全部收到 Overloaded，不会排队等待。
    #[test]
    fn quota_is_bounded_under_concurrent_acquire() {
        // 函数级 static：测试并行执行时也不会与其他用例共享计数器。
        static ACTIVE: AtomicUsize = AtomicUsize::new(0);
        static QUOTA: Quota = Quota {
            active: &ACTIVE,
            limit: 3,
            busy: "测试任务过多",
        };

        let held: Vec<QuotaGuard> = (0..3)
            .map(|_| QUOTA.acquire().expect("配额内应可用"))
            .collect();
        let barrier = Arc::new(Barrier::new(9)); // 8 个竞争线程 + 主线程
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    QUOTA.acquire().map(|_| ())
                })
            })
            .collect();
        barrier.wait();
        for handle in handles {
            let result = handle.join().expect("竞争线程不应 panic");
            assert!(
                matches!(result, Err(AppError::Overloaded(_))),
                "满额后并发请求必须被明确拒绝，实际: {result:?}"
            );
        }
        assert_eq!(ACTIVE.load(Ordering::SeqCst), 3, "拒绝不得改变已占用配额");

        drop(held);
        assert_eq!(ACTIVE.load(Ordering::SeqCst), 0, "全部归还后计数必须归零");
        assert!(QUOTA.acquire().is_ok(), "配额归还后必须恢复可获取");
    }

    /// 后台任务 panic 展开时，配额仍必须归还，不能永久占死。
    #[test]
    fn quota_is_released_when_holder_panics() {
        static ACTIVE: AtomicUsize = AtomicUsize::new(0);
        static QUOTA: Quota = Quota {
            active: &ACTIVE,
            limit: 1,
            busy: "测试任务过多",
        };

        let result = std::thread::spawn(|| {
            let _slot = QUOTA.acquire().expect("唯一配额应可用");
            panic!("模拟后台任务 panic");
        })
        .join();
        assert!(result.is_err(), "线程应因 panic 结束");
        assert_eq!(ACTIVE.load(Ordering::SeqCst), 0, "panic 展开后配额必须归还");
        assert!(QUOTA.acquire().is_ok(), "panic 后必须能重新获取配额");
    }

    /// 批量状态语义与 200 条上限：保留输入顺序，存在的报 ok、缺失的报 missing。
    #[test]
    fn path_states_keeps_order_and_truncates_to_200() {
        let dir = TempDir::new("path-status");
        let existing = dir.path.join("exists.png");
        std::fs::write(&existing, b"x").expect("写入测试文件");
        let existing = existing.display().to_string();
        let missing = dir.path.join("missing.png").display().to_string();

        let states = path_states(vec![
            format!("  {existing}  "), // 前后空白应被裁剪
            missing.clone(),
        ]);
        assert_eq!(states, vec!["ok".to_string(), "missing".to_string()]);

        // 超过 200 条只处理前 200 条（防止滥用），且前两条语义不变。
        let mut paths = vec![existing, missing];
        paths.extend((0..204).map(|i| format!(r"C:\definitely-missing-{i}.png")));
        assert_eq!(paths.len(), 206);
        let states = path_states(paths);
        assert_eq!(states.len(), 200, "超过上限必须截断到 200 条");
        assert_eq!(states[0], "ok");
        assert_eq!(states[1], "missing");
    }
}
