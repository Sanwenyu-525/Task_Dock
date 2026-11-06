//! 文件暂存架：用户**主动**收纳的临时资料区（文件 / 图片 / 截图 / 文档 / 文件夹 / 链接 / 文本片段）。
//!
//! 与智能剪贴板的职责边界（强约束）：
//! - 剪贴板被动记录复制历史；暂存架由用户显式添加、整理与清理；
//! - **不共享** `clipboard_assets`：该表删除按路径反查、无跨模块引用计数，直接共享
//!   必须改动剪贴板清理策略（AGENTS.md 禁止）。暂存架托管副本写入独立目录
//!   `data_dir/shelf/`，「从剪贴板添加」复制字节生成独立副本 —— 两边删除、清空、
//!   备份互不影响；
//! - 引用模式只存原始路径，**删除暂存记录绝不删除用户原文件**；托管副本只删
//!   Task Dock 自己拥有的文件（uuid 命名 + 归一化校验 + canonical 边界复核）。
//!
//! 安全边界：
//! - 托管文件名由后端生成（`{uuid}.{ext}`），前端传入的任何字符串都不进入路径成分；
//!   `safe_managed_rel` 只接受 `files|images|thumbs` 前缀且无 `..`/分隔符注入；
//! - 删除前用 canonical 路径复核托管文件仍在 shelf 根目录内（防符号链接/重解析点绕过）；
//! - 托管复制写 `.part` 临时文件后原子改名，中断不产生半份"完整"文件；启动时清理残留 `.part`；
//! - 复制前检查磁盘剩余空间与配额；流式分块复制，不整读进内存。

use std::collections::HashSet;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use chrono::{Duration, SecondsFormat, Utc};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

// ── 常量 ────────────────────────────────────────────────────

pub const KIND_FILE: &str = "file";
pub const KIND_FOLDER: &str = "folder";
pub const KIND_IMAGE: &str = "image";
pub const KIND_LINK: &str = "link";
pub const KIND_TEXT: &str = "text";

pub const MODE_REFERENCE: &str = "reference";
pub const MODE_MANAGED: &str = "managed";
pub const MODE_LINK: &str = "link";

/// 文本片段 / 文本文件预览上限（对齐剪贴板 MAX_TEXT_BYTES）。
pub const MAX_TEXT_BYTES: usize = 512 * 1024;
/// 链接 URL 上限（对齐 navigation::validate_url）。
pub const MAX_URL_BYTES: usize = 2048;
/// 单个托管文件上限：引用模式无上限；托管副本超过该值应改用引用模式。
pub const MAX_MANAGED_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 复制分块：流式处理，不把大文件读进内存。
const COPY_CHUNK: usize = 256 * 1024;
/// 复制前要求的磁盘剩余余量：文件本身 + 128MB 安全边界。
const DISK_FREE_MARGIN: u64 = 128 * 1024 * 1024;
/// 并发托管复制上限：防止批量拖入打满磁盘带宽与线程池。
const COPY_CONCURRENCY: usize = 4;
/// 文本类扩展名白名单（预览用；小写、无点）。
const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "json", "log", "csv", "ini", "cfg", "conf", "yaml", "yml", "toml",
    "xml", "html", "htm", "js", "mjs", "ts", "tsx", "jsx", "py", "rs", "go", "c", "h", "cpp",
    "hpp", "cs", "java", "css", "bat", "cmd", "ps1", "sh", "sql",
];
/// 图片类扩展名白名单（小写、无点）。
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

// ── 数据模型 ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ShelfItem {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub source_kind: String,
    pub storage_mode: String,
    pub original_path: Option<String>,
    pub managed_path: Option<String>,
    /// link=URL；text=正文片段；列表不返回（单独 shelf_read_text 拉取）
    pub content: Option<String>,
    pub byte_size: i64,
    pub file_ext: Option<String>,
    pub favorite: bool,
    pub pinned: bool,
    pub exists_state: String,
    pub group_id: Option<String>,
    pub scene_id: Option<String>,
    pub note: String,
    pub expire_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShelfGroup {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub sort_order: i64,
    pub item_count: i64,
}

#[derive(Debug, Serialize)]
pub struct ShelfPage {
    pub items: Vec<ShelfItem>,
    pub total: i64,
}

#[derive(Debug, Serialize)]
pub struct ShelfStats {
    pub total: i64,
    pub file_count: i64,
    pub image_count: i64,
    pub folder_count: i64,
    pub link_count: i64,
    pub text_count: i64,
    /// 托管条目 byte_size 之和（不含缩略图等索引开销）
    pub managed_bytes: i64,
    /// shelf 目录实际磁盘占用（含缩略图与可能的孤儿残留）
    pub disk_bytes: u64,
    pub quota_mb: i64,
}

#[derive(Debug, Serialize)]
pub struct ShelfDeleteReport {
    pub deleted: i64,
    /// 因收藏/置顶被保护而跳过的条目数
    pub skipped: i64,
    pub freed_bytes: i64,
    /// 数据库记录已删除但托管文件或缩略图删除失败的文件数；下次清理重试
    pub failed_files: i64,
}

#[derive(Debug, Serialize)]
pub struct ShelfCleanupReport {
    pub dry_run: bool,
    /// 将被/已被清理的条目数
    pub candidates: i64,
    /// 因收藏/置顶保护被跳过的过期条目数
    pub skipped_protected: i64,
    /// 未尝试删除的 .part/.tmp 文件数；正在写入或生命周期不明时保留。
    pub temporary_files_skipped: i64,
    /// 预计/实际释放的托管字节
    pub freed_bytes: i64,
    pub failed_files: i64,
    /// 数据库不再引用、已从磁盘移除的孤儿文件数（复制中断/删除失败残留兜底）
    pub orphan_files_removed: i64,
}

#[derive(Debug, Serialize)]
pub struct ShelfExistsReport {
    pub id: String,
    pub exists_state: String,
}

#[derive(Debug, Serialize)]
pub struct ShelfTaskLink {
    pub task_id: String,
    pub item_id: String,
    pub task_title: String,
    pub created_at: String,
}

/// 并发复制闸：阻塞式（spawn_blocking 线程内使用），限制同时落盘的副本数，
/// 防止批量拖入打满磁盘带宽与线程池。
pub(crate) struct CopyGate {
    state: Mutex<CopyGateState>,
    cv: Condvar,
}

#[derive(Default)]
struct CopyGateState {
    active: usize,
    maintenance: bool,
}

/// RAII 许可：Drop 归还名额并唤醒等待者。
pub struct CopyPermit {
    gate: Arc<CopyGate>,
}

impl Drop for CopyPermit {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().expect("复制闸锁");
        state.active -= 1;
        self.gate.cv.notify_all();
    }
}

/// 独占暂存架文件区的维护许可；持有期间不会有新的写入许可。
pub struct ShelfMaintenancePermit {
    gate: Arc<CopyGate>,
}

impl Drop for ShelfMaintenancePermit {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().expect("暂存架维护闸锁");
        state.maintenance = false;
        self.gate.cv.notify_all();
    }
}

impl CopyGate {
    fn new() -> Self {
        Self {
            state: Mutex::new(CopyGateState::default()),
            cv: Condvar::new(),
        }
    }

    fn acquire(self: &Arc<Self>) -> CopyPermit {
        let mut state = self.state.lock().expect("复制闸锁");
        while state.maintenance || state.active >= COPY_CONCURRENCY {
            state = self.cv.wait(state).expect("复制闸锁");
        }
        state.active += 1;
        CopyPermit {
            gate: Arc::clone(self),
        }
    }

    fn try_acquire_maintenance(self: &Arc<Self>) -> Option<ShelfMaintenancePermit> {
        let mut state = self.state.try_lock().ok()?;
        if state.maintenance || state.active > 0 {
            return None;
        }
        state.maintenance = true;
        Some(ShelfMaintenancePermit {
            gate: Arc::clone(self),
        })
    }
}

/// 运行时状态：数据库 + 独立托管根目录 + 复制并发闸 + 应用句柄（打开/复制用）。
pub struct ShelfState {
    pub db: Arc<Db>,
    pub root: PathBuf,
    pub app: tauri::AppHandle,
    copy_gate: Arc<CopyGate>,
}

impl ShelfState {
    pub fn new(db: Arc<Db>, root: PathBuf, app: tauri::AppHandle) -> AppResult<Self> {
        validate_shelf_path(&root)?;
        std::fs::create_dir_all(&root)?;
        let canonical_root = canonical_shelf_root(&root)?
            .ok_or_else(|| AppError::Validation("暂存架根目录不可用".into()))?;
        for sub in ["files", "images", "thumbs"] {
            let dir = root.join(sub);
            validate_shelf_path(&dir)?;
            std::fs::create_dir_all(&dir)?;
            let metadata = std::fs::symlink_metadata(&dir)?;
            if !metadata.is_dir()
                || is_reparse_point(&metadata)
                || std::fs::canonicalize(&dir)?.parent() != Some(canonical_root.as_path())
            {
                return Err(AppError::Validation(format!("暂存架目录不安全（{sub}）")));
            }
        }
        purge_part_files(&root)?;
        // 上次退出/崩溃留下的移动日志：启动时按最小恢复规则对齐磁盘与数据库。
        fsops::recover_pending_file_ops(&db);
        Ok(Self {
            db,
            root,
            app,
            copy_gate: Arc::new(CopyGate::new()),
        })
    }

    /// 取复制许可（阻塞式；批量拖入时自然排队，不阻塞 UI 线程）。
    pub fn acquire_copy_permit(&self) -> CopyPermit {
        self.copy_gate.acquire()
    }

    /// 立即尝试独占文件区；有复制/添加正在进行或已有维护任务时返回 None。
    pub fn try_acquire_maintenance_permit(&self) -> Option<ShelfMaintenancePermit> {
        self.copy_gate.try_acquire_maintenance()
    }
}

// ── 路径安全 ────────────────────────────────────────────────

/// 托管相对路径校验：仅允许 `files/<name>` / `images/<name>` / `thumbs/<name>`，
/// 两个 Normal 组件，无绝对路径 / 反斜杠 / `..` / 空段。
/// 文件名由本模块生成（uuid），但备份恢复与删除路径仍统一过这道闸。
pub fn safe_managed_rel(rel: &str) -> AppResult<PathBuf> {
    if rel.is_empty() || rel.contains(['\\', '\0']) {
        return Err(AppError::Validation("托管路径为空或包含非法字符".into()));
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(AppError::Validation("托管路径不得为绝对路径".into()));
    }
    let comps: Vec<Component<'_>> = path.components().collect();
    if comps.len() != 2 || !comps.iter().all(|c| matches!(c, Component::Normal(_))) {
        return Err(AppError::Validation(format!("托管路径结构非法: {rel}")));
    }
    let dir = comps[0].as_os_str().to_string_lossy();
    if dir != "files" && dir != "images" && dir != "thumbs" {
        return Err(AppError::Validation(format!("托管目录非法: {rel}")));
    }
    let name = comps[1].as_os_str().to_string_lossy();
    if name == "." || name == ".." || name.len() > 128 {
        return Err(AppError::Validation(format!("托管文件名非法: {rel}")));
    }
    Ok(path.to_path_buf())
}

/// 托管文件必须仍在 shelf 根目录内（canonical 复核，防符号链接/重解析点逃逸）。
fn is_within_root(root: &Path, file: &Path) -> bool {
    let Ok(root_canon) = std::fs::canonicalize(root) else {
        return false;
    };
    let Ok(file_canon) = std::fs::canonicalize(file) else {
        return false;
    };
    file_canon.starts_with(root_canon)
}

fn validate_shelf_path(path: &Path) -> AppResult<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(AppError::Validation("暂存架路径不安全".into()));
    }
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) if is_reparse_point(&metadata) => {
                return Err(AppError::Validation("暂存架路径包含重解析点".into()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn canonical_shelf_root(root: &Path) -> AppResult<Option<PathBuf>> {
    validate_shelf_path(root)?;
    let metadata = match std::fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(AppError::Validation("暂存架根目录不是安全目录".into()));
    }
    Ok(Some(std::fs::canonicalize(root)?))
}

/// 引用路径规范化：绝对路径 + 词法消解 `.`/`..`（不触盘、不改写大小写），
/// 拒绝空路径、空字节与穿越到根之上的结果。仅存引用，删除条目绝不触碰该文件。
pub fn normalize_original_path(raw: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 1024 {
        return Err(AppError::Validation("路径为空或超长".into()));
    }
    if trimmed.contains('\0') {
        return Err(AppError::Validation("路径包含非法字符".into()));
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return Err(AppError::Validation(format!(
            "只接受绝对路径，收到: {trimmed}"
        )));
    }
    let mut prefix: Option<std::ffi::OsString> = None;
    let mut rooted = false;
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for c in p.components() {
        match c {
            Component::Prefix(pre) => {
                if prefix.is_some() {
                    return Err(AppError::Validation("路径包含多个前缀".into()));
                }
                prefix = Some(pre.as_os_str().to_os_string());
            }
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::Normal(name) => parts.push(name.to_os_string()),
            Component::ParentDir => {
                // 根之上没有可回退的成分：显式拒绝穿越（如 C:\..\x）
                if parts.is_empty() {
                    return Err(AppError::Validation("路径穿越超出根目录".into()));
                }
                parts.pop();
            }
        }
    }
    let mut out = PathBuf::new();
    if let Some(pre) = prefix {
        out.push(pre);
    }
    if rooted {
        out.push(std::path::MAIN_SEPARATOR.to_string());
    }
    if out.as_os_str().is_empty() {
        return Err(AppError::Validation("路径解析结果为空".into()));
    }
    for part in parts {
        out.push(part);
    }
    Ok(out)
}

/// 词法规范化 + 存在性校验（添加引用时调用；打开/定位时也复用）。
fn require_existing_path(raw: &str) -> AppResult<PathBuf> {
    let p = normalize_original_path(raw)?;
    if !p.exists() {
        return Err(AppError::NotFound(format!("路径不存在: {}", p.display())));
    }
    Ok(p)
}

/// 小写扩展名清洗：只保留字母数字，最长 16；无扩展名/超长 → "bin"。
fn sanitize_ext(ext: &str) -> String {
    let cleaned: String = ext
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(16)
        .collect();
    if cleaned.is_empty() {
        "bin".into()
    } else {
        cleaned
    }
}

fn ext_of(path: &Path) -> Option<String> {
    path.extension().map(|e| sanitize_ext(&e.to_string_lossy()))
}

fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

fn is_text_ext(ext: &str) -> bool {
    TEXT_EXTS.contains(&ext)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 2);
    out.push('%');
    for c in term.chars() {
        match c {
            '%' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '_' => out.push_str("\\_"),
            _ => out.push(c),
        }
    }
    out.push('%');
    out
}

// ── 磁盘空间 ────────────────────────────────────────────────

/// 目标路径所在卷的剩余空间（拿不到时返回 None，调用方跳过预检不拦截）。
fn disk_free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut avail: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) };
    if ok != 0 {
        Some(free)
    } else {
        None
    }
}

// ── 行映射与基础查询 ────────────────────────────────────────

const ITEM_COLS: &str = "id, kind, display_name, source_kind, storage_mode, original_path, \
managed_path, byte_size, file_ext, favorite, pinned, exists_state, group_id, scene_id, note, \
expire_at, created_at, updated_at";

fn item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ShelfItem> {
    Ok(ShelfItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        display_name: row.get(2)?,
        source_kind: row.get(3)?,
        storage_mode: row.get(4)?,
        original_path: row.get(5)?,
        managed_path: row.get(6)?,
        content: None,
        byte_size: row.get(7)?,
        file_ext: row.get(8)?,
        favorite: row.get::<_, i64>(9)? != 0,
        pinned: row.get::<_, i64>(10)? != 0,
        exists_state: row.get(11)?,
        group_id: row.get(12)?,
        scene_id: row.get(13)?,
        note: row.get(14)?,
        expire_at: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

fn get_item(db: &Db, id: &str) -> AppResult<ShelfItem> {
    // 单条读取带 content（link=URL / text=正文）；列表查询不带（大文本不进前端内存）
    let sql = format!("SELECT {ITEM_COLS}, content FROM shelf_items WHERE id = ?1");
    db.with_read(|conn| {
        conn.query_row(&sql, params![id], |row| {
            let mut item = item_from_row(row)?;
            item.content = row.get(18)?;
            Ok(item)
        })
        .map_err(|_| AppError::NotFound(format!("暂存条目不存在: {id}")))
    })
}

/// 对外暴露的单条读取（复制路径/文件、命令层复用）。
pub fn item(db: &Db, id: &str) -> AppResult<ShelfItem> {
    get_item(db, id)
}

fn insert_item(conn: &Connection, item: &ShelfItem) -> AppResult<()> {
    conn.execute(
        "INSERT INTO shelf_items
           (id, kind, display_name, source_kind, storage_mode, original_path, managed_path,
            content, byte_size, file_ext, favorite, pinned, exists_state, group_id, scene_id,
            note, expire_at, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
        params![
            item.id,
            item.kind,
            item.display_name,
            item.source_kind,
            item.storage_mode,
            item.original_path,
            item.managed_path,
            item.content,
            item.byte_size,
            item.file_ext,
            item.favorite as i64,
            item.pinned as i64,
            item.exists_state,
            item.group_id,
            item.scene_id,
            item.note,
            item.expire_at,
            item.created_at,
            item.updated_at,
        ],
    )?;
    Ok(())
}

fn resolve_group_id(db: &Db, group_id: Option<&str>) -> AppResult<Option<String>> {
    match group_id {
        None => Ok(Some("shelf-default".into())),
        Some("none") => Ok(None),
        Some(id) => {
            let exists: i64 = db.with_read(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM shelf_groups WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })?;
            if exists == 0 {
                return Err(AppError::Validation(format!("分组不存在: {id}")));
            }
            Ok(Some(id.to_string()))
        }
    }
}

// ── 缩略图 ──────────────────────────────────────────────────

/// PNG 缩略图生成（复用剪贴板 image 模块的区域平均缩放）。
/// 非 PNG 源暂不生成缩略图（不为此引入图像解码依赖），UI 显示类型图标。
fn make_thumb_png(png_bytes: &[u8]) -> Option<Vec<u8>> {
    let (rgba, w, h) = crate::clipboard::image::decode_png_rgba(png_bytes).ok()?;
    let (t_rgba, tw, th) = crate::clipboard::image::thumbnail(&rgba, w, h);
    crate::clipboard::image::encode_png(&t_rgba, tw, th).ok()
}

/// 写缩略图（thumbs/{item_id}.png）。失败不阻断添加：缩略图是可再生装饰。
fn write_thumb(root: &Path, item_id: &str, png: &[u8]) {
    let dir = root.join("thumbs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let abs = dir.join(format!("{item_id}.png"));
    let tmp = abs.with_extension("png.part");
    if std::fs::write(&tmp, png).is_ok() {
        let _ = std::fs::rename(&tmp, &abs);
    }
    let _ = std::fs::remove_file(&tmp);
}

// ── 添加 ────────────────────────────────────────────────────

fn validate_add_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("名称不能为空".into()));
    }
    if trimmed.chars().count() > 200 {
        return Err(AppError::Validation("名称超过 200 字符".into()));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation("名称含非法控制字符".into()));
    }
    Ok(trimmed.to_string())
}

/// 引用模式：保存规范化原路径，不复制文件；删除记录不删原文件。
/// PNG 原图尽力生成缩略图（存 shelf/thumbs，由暂存架拥有），失败静默。
pub fn add_reference(
    db: &Db,
    root: &Path,
    raw_path: &str,
    source_kind: &str,
    group_id: Option<&str>,
) -> AppResult<ShelfItem> {
    let path = require_existing_path(raw_path)?;
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::Validation(format!("无法读取文件信息: {}", e)))?;
    let (kind, byte_size, ext) = if meta.is_dir() {
        (KIND_FOLDER, 0i64, None)
    } else {
        let e = ext_of(&path);
        let k = e.as_deref().map(is_image_ext).unwrap_or(false);
        (
            if k { KIND_IMAGE } else { KIND_FILE },
            meta.len().min(i64::MAX as u64) as i64,
            e,
        )
    };
    let display_name = validate_add_name(
        &path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
    )?;
    let item = ShelfItem {
        id: uuid::Uuid::new_v4().to_string(),
        kind: kind.into(),
        display_name,
        source_kind: source_kind.into(),
        storage_mode: MODE_REFERENCE.into(),
        original_path: Some(path.to_string_lossy().to_string()),
        managed_path: None,
        content: None,
        byte_size,
        file_ext: ext,
        favorite: false,
        pinned: false,
        exists_state: "ok".into(),
        group_id: resolve_group_id(db, group_id)?,
        scene_id: None,
        note: String::new(),
        expire_at: None,
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    db.with_conn(|conn| insert_item(conn, &item))?;
    // 引用模式的 PNG 原图尽力生成缩略图；失败不阻断（UI 显示类型图标）
    if kind == KIND_IMAGE && item.file_ext.as_deref() == Some("png") {
        if let Ok(bytes) = std::fs::read(&path) {
            if bytes.len() <= 64 * 1024 * 1024 {
                if let Some(thumb) = make_thumb_png(&bytes) {
                    write_thumb(root, &item.id, &thumb);
                }
            }
        }
    }
    Ok(item)
}

/// 托管模式：流式复制到 shelf 目录（.part 临时文件 + 原子改名）。
/// 文件夹不支持托管（仅引用）；配额与磁盘空间不足直接报错。
pub fn add_managed(
    db: &Db,
    root: &Path,
    raw_path: &str,
    source_kind: &str,
    group_id: Option<&str>,
) -> AppResult<ShelfItem> {
    let src = require_existing_path(raw_path)?;
    let meta = std::fs::metadata(&src)
        .map_err(|e| AppError::Validation(format!("无法读取文件信息: {}", e)))?;
    if meta.is_dir() {
        return Err(AppError::Validation(
            "文件夹仅支持引用模式（不复制目录内容）".into(),
        ));
    }
    let size = meta.len();
    if size > MAX_MANAGED_FILE_BYTES {
        return Err(AppError::Validation(
            "文件超过 2GB 托管上限，请改用引用模式".into(),
        ));
    }
    // 配额：现有托管字节 + 新文件 ≤ quota
    let settings = Settings::load(db).unwrap_or_default();
    let quota_bytes = (settings.shelf_max_storage_mb as u64) * 1024 * 1024;
    let current: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COALESCE(SUM(byte_size),0) FROM shelf_items WHERE storage_mode = 'managed'",
            [],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    if (current as u64).saturating_add(size) > quota_bytes {
        return Err(AppError::Validation(format!(
            "超出托管配额（{} MB）：当前已用 {} MB，本文件 {} MB。可在清理设置中调整配额或改用引用模式",
            settings.shelf_max_storage_mb,
            current / 1024 / 1024,
            size / 1024 / 1024
        )));
    }
    if let Some(free) = disk_free_bytes(root) {
        if free < size.saturating_add(DISK_FREE_MARGIN) {
            return Err(AppError::Validation(
                "磁盘空间不足：剩余空间低于文件大小 + 128MB 安全余量".into(),
            ));
        }
    }

    let ext = ext_of(&src);
    let kind = if ext.as_deref().map(is_image_ext).unwrap_or(false) {
        KIND_IMAGE
    } else {
        KIND_FILE
    };
    let display_name = validate_add_name(
        &src.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名".into()),
    )?;

    let id = uuid::Uuid::new_v4().to_string();
    let sub = if kind == KIND_IMAGE {
        "images"
    } else {
        "files"
    };
    let file_name = match &ext {
        Some(e) => format!("{id}.{e}"),
        None => id.clone(),
    };
    let rel = format!("{sub}/{file_name}");
    let dest = root.join(&rel);
    std::fs::create_dir_all(root.join(sub))?;

    // 流式复制：写 {uuid}.{ext}.part → 校验长度 → 原子改名。
    // 中断只留下 .part（启动与清理时回收），绝不产生被误当完整的半份文件。
    let tmp = root.join(format!("{rel}.part"));
    let mut written: u64 = 0;
    let copy = (|| -> AppResult<()> {
        let mut reader = BufReader::with_capacity(COPY_CHUNK, std::fs::File::open(&src)?);
        let mut writer = BufWriter::with_capacity(COPY_CHUNK, std::fs::File::create(&tmp)?);
        let mut buf = vec![0u8; COPY_CHUNK];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            writer.write_all(&buf[..n])?;
            written += n as u64;
        }
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        if written != size {
            return Err(AppError::Validation(format!(
                "复制不完整：期望 {size} 字节，实际 {written} 字节"
            )));
        }
        std::fs::rename(&tmp, &dest)?;
        Ok(())
    })();
    if let Err(e) = copy {
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&dest);
        return Err(e);
    }

    let item = ShelfItem {
        id: id.clone(),
        kind: kind.into(),
        display_name,
        source_kind: source_kind.into(),
        storage_mode: MODE_MANAGED.into(),
        original_path: Some(src.to_string_lossy().to_string()),
        managed_path: Some(rel),
        content: None,
        byte_size: size.min(i64::MAX as u64) as i64,
        file_ext: ext,
        favorite: false,
        pinned: false,
        exists_state: "ok".into(),
        group_id: resolve_group_id(db, group_id)?,
        scene_id: None,
        note: String::new(),
        expire_at: None,
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    db.with_conn(|conn| insert_item(conn, &item))?;
    // PNG 托管副本生成缩略图；失败不阻断
    if kind == KIND_IMAGE && item.file_ext.as_deref() == Some("png") {
        if let Ok(bytes) = std::fs::read(&dest) {
            if let Some(thumb) = make_thumb_png(&bytes) {
                write_thumb(root, &item.id, &thumb);
            }
        }
    }
    Ok(item)
}

pub fn add_link(db: &Db, raw_url: &str, group_id: Option<&str>) -> AppResult<ShelfItem> {
    // validate_url 只做校验（http/https、长度、非法字符），原文作为链接内容
    crate::navigation::validate_url(raw_url.trim())?;
    let url = raw_url.trim().to_string();
    if url.len() > MAX_URL_BYTES {
        return Err(AppError::Validation("链接超过 2048 字符上限".into()));
    }
    let display_name = validate_add_name(&short_link_name(&url))?;
    let item = ShelfItem {
        id: uuid::Uuid::new_v4().to_string(),
        kind: KIND_LINK.into(),
        display_name,
        source_kind: "url".into(),
        storage_mode: MODE_LINK.into(),
        original_path: None,
        managed_path: None,
        content: Some(url),
        byte_size: 0,
        file_ext: None,
        favorite: false,
        pinned: false,
        exists_state: "ok".into(),
        group_id: resolve_group_id(db, group_id)?,
        scene_id: None,
        note: String::new(),
        expire_at: None,
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    db.with_conn(|conn| insert_item(conn, &item))?;
    Ok(item)
}

/// 链接展示名：协议剥离后取到路径首段，过长截断。
fn short_link_name(url: &str) -> String {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let host_end = rest.find('/').map(|i| i + 1).unwrap_or(rest.len());
    let mut name: String = rest.chars().take(host_end.max(1)).collect();
    if host_end < rest.len() {
        let tail: String = rest[host_end..].trim_end_matches('/').to_string();
        if !tail.is_empty() {
            name.push_str(&tail);
        }
    }
    let mut out: String = name.chars().take(80).collect();
    if name.chars().count() > 80 {
        out.push('…');
    }
    out
}

pub fn add_text(
    db: &Db,
    text: &str,
    source_kind: &str,
    group_id: Option<&str>,
) -> AppResult<ShelfItem> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("文本内容不能为空".into()));
    }
    if trimmed.len() > MAX_TEXT_BYTES {
        return Err(AppError::Validation(
            "文本超过 512KB 上限，请保存为文件后以引用方式添加".into(),
        ));
    }
    let first_line = trimmed.lines().next().unwrap_or("").trim();
    let mut display_name: String = first_line.chars().take(40).collect();
    if first_line.chars().count() > 40 {
        display_name.push('…');
    }
    let display_name = validate_add_name(&display_name)?;
    let item = ShelfItem {
        id: uuid::Uuid::new_v4().to_string(),
        kind: KIND_TEXT.into(),
        display_name,
        source_kind: source_kind.into(),
        storage_mode: MODE_REFERENCE.into(),
        original_path: None,
        managed_path: None,
        content: Some(trimmed.to_string()),
        byte_size: trimmed.len() as i64,
        file_ext: None,
        favorite: false,
        pinned: false,
        exists_state: "ok".into(),
        group_id: resolve_group_id(db, group_id)?,
        scene_id: None,
        note: String::new(),
        expire_at: None,
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    db.with_conn(|conn| insert_item(conn, &item))?;
    Ok(item)
}

// ── 列表 / 统计 ─────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
pub struct ListFilter {
    pub search: Option<String>,
    /// "all" | kind 值
    pub kind: String,
    /// "all" | 分组 id | "none"
    pub group_id: String,
    pub favorite_only: bool,
    pub limit: i64,
    pub offset: i64,
    /// ""/"default" = 置顶优先（完整暂存架）；"recent" = 纯按创建时间倒序（胶囊最近暂存）
    pub sort: String,
}

pub fn list(db: &Db, filter: &ListFilter) -> AppResult<ShelfPage> {
    let mut wheres: Vec<String> = Vec::new();
    let mut bind_values: Vec<String> = Vec::new();
    if let Some(term) = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        wheres.push(
            "(display_name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')"
                .into(),
        );
        let pat = escape_like(term);
        bind_values.push(pat.clone());
        bind_values.push(pat.clone());
        bind_values.push(pat);
    }
    if filter.kind != "all" && !filter.kind.is_empty() {
        wheres.push("kind = ?".into());
        bind_values.push(filter.kind.clone());
    }
    match filter.group_id.as_str() {
        "all" | "" => {}
        "none" => wheres.push("group_id IS NULL".into()),
        gid => {
            wheres.push("group_id = ?".into());
            bind_values.push(gid.to_string());
        }
    }
    if filter.favorite_only {
        wheres.push("favorite = 1".into());
    }
    let where_sql = if wheres.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", wheres.join(" AND "))
    };
    let limit = filter.limit.clamp(1, 500);
    let offset = filter.offset.max(0);
    // 排序是显式契约：默认保持完整暂存架「置顶优先」；
    // recent 只按创建时间，置顶不能把刚添加的普通条目挤出最近列表。
    let order_sql = match filter.sort.as_str() {
        "" | "default" => "pinned DESC, created_at DESC, id DESC",
        "recent" => "created_at DESC, id DESC",
        other => {
            return Err(AppError::Validation(format!("未知的暂存列表排序: {other}")));
        }
    };

    // content 参与 LIKE 但不返回列表（大文本不进前端内存）
    let sql = format!(
        "SELECT {ITEM_COLS} FROM shelf_items {where_sql} \
         ORDER BY {order_sql} LIMIT {limit} OFFSET {offset}"
    );
    let count_sql = format!("SELECT COUNT(*) FROM shelf_items {where_sql}");
    db.with_read(|conn| {
        let total: i64 = {
            let mut stmt = conn.prepare(&count_sql)?;
            stmt.query_row(rusqlite::params_from_iter(bind_values.iter()), |r| r.get(0))?
        };
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(bind_values.iter()), |row| {
            item_from_row(row)
        })?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r?);
        }
        Ok(ShelfPage { items, total })
    })
}

pub fn stats(db: &Db, root: &Path) -> AppResult<ShelfStats> {
    let settings = Settings::load(db).unwrap_or_default();
    db.with_read(|conn| {
        let (total, file_count, image_count, folder_count, link_count, text_count, managed_bytes) =
            conn.query_row(
                "SELECT COUNT(*), \
                        SUM(kind='file'), SUM(kind='image'), SUM(kind='folder'), \
                        SUM(kind='link'), SUM(kind='text'), \
                        COALESCE(SUM(CASE WHEN storage_mode='managed' THEN byte_size ELSE 0 END),0) \
                 FROM shelf_items",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                        r.get::<_, i64>(6)?,
                    ))
                },
            )?;
        Ok(ShelfStats {
            total,
            file_count,
            image_count,
            folder_count,
            link_count,
            text_count,
            managed_bytes,
            disk_bytes: dir_size(root),
            quota_mb: settings.shelf_max_storage_mb as i64,
        })
    })
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

// ── 分组 ────────────────────────────────────────────────────

pub fn list_groups(db: &Db) -> AppResult<Vec<ShelfGroup>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT g.id, g.name, g.builtin, g.sort_order, \
                    (SELECT COUNT(*) FROM shelf_items i WHERE i.group_id = g.id) \
             FROM shelf_groups g ORDER BY g.sort_order ASC, g.created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ShelfGroup {
                id: r.get(0)?,
                name: r.get(1)?,
                builtin: r.get::<_, i64>(2)? != 0,
                sort_order: r.get(3)?,
                item_count: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

fn validate_group_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 40 {
        return Err(AppError::Validation("分组名需为 1~40 字符".into()));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation("分组名含非法控制字符".into()));
    }
    Ok(trimmed.to_string())
}

pub fn group_create(db: &Db, name: &str) -> AppResult<ShelfGroup> {
    let name = validate_group_name(name)?;
    let dup: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM shelf_groups WHERE name = ?1",
            params![&name],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    if dup > 0 {
        return Err(AppError::Conflict(format!("分组已存在: {name}")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let sort: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COALESCE(MAX(sort_order),0)+1 FROM shelf_groups",
            [],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    let created = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO shelf_groups (id, name, builtin, sort_order, created_at) \
             VALUES (?1, ?2, 0, ?3, ?4)",
            params![&id, &name, sort, &created],
        )?;
        Ok(())
    })?;
    Ok(ShelfGroup {
        id,
        name,
        builtin: false,
        sort_order: sort,
        item_count: 0,
    })
}

pub fn group_rename(db: &Db, id: &str, name: &str) -> AppResult<()> {
    let name = validate_group_name(name)?;
    let n = db.with_conn(|conn| {
        conn.execute(
            "UPDATE shelf_groups SET name = ?1 WHERE id = ?2",
            params![&name, id],
        )
        .map_err(AppError::from)
    })?;
    if n == 0 {
        return Err(AppError::NotFound(format!("分组不存在: {id}")));
    }
    Ok(())
}

/// 删除分组：条目归位到默认分组（不删条目、不删文件）。内置分组不可删。
pub fn group_delete(db: &Db, group_id: &str) -> AppResult<()> {
    if group_id == "shelf-default" {
        return Err(AppError::Validation("默认分组不可删除".into()));
    }
    db.with_conn(|conn| {
        let builtin: i64 = conn
            .query_row(
                "SELECT builtin FROM shelf_groups WHERE id = ?1",
                params![group_id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::NotFound(format!("分组不存在: {group_id}")))?;
        if builtin != 0 {
            return Err(AppError::Validation("内置分组不可删除".into()));
        }
        conn.execute(
            "UPDATE shelf_items SET group_id = 'shelf-default' WHERE group_id = ?1",
            params![group_id],
        )?;
        conn.execute("DELETE FROM shelf_groups WHERE id = ?1", params![group_id])?;
        Ok(())
    })
}

// ── 更新 ────────────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
pub struct UpdatePatch {
    pub display_name: Option<String>,
    pub favorite: Option<bool>,
    pub pinned: Option<bool>,
    pub group_id: Option<Option<String>>,
    pub note: Option<String>,
    /// None=不修改；Some(None)=清除过期时间
    pub expire_at: Option<Option<String>>,
}

pub fn update(db: &Db, id: &str, patch: &UpdatePatch) -> AppResult<ShelfItem> {
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(name) = &patch.display_name {
        sets.push("display_name = ?");
        values.push(Box::new(validate_add_name(name)?));
    }
    if let Some(v) = patch.favorite {
        sets.push("favorite = ?");
        values.push(Box::new(v as i64));
    }
    if let Some(v) = patch.pinned {
        sets.push("pinned = ?");
        values.push(Box::new(v as i64));
    }
    if let Some(gid) = &patch.group_id {
        let resolved = resolve_group_id(db, Some(gid.as_deref().unwrap_or("none")))?;
        sets.push("group_id = ?");
        values.push(Box::new(resolved));
    }
    if let Some(note) = &patch.note {
        if note.chars().count() > 2000 {
            return Err(AppError::Validation("备注超过 2000 字符".into()));
        }
        sets.push("note = ?");
        values.push(Box::new(note.trim().to_string()));
    }
    if let Some(exp) = &patch.expire_at {
        if let Some(iso) = exp {
            chrono::DateTime::parse_from_rfc3339(iso)
                .map_err(|_| AppError::Validation("expire_at 必须是 ISO8601 时间字符串".into()))?;
        }
        sets.push("expire_at = ?");
        values.push(Box::new(exp.clone()));
    }
    if sets.is_empty() {
        return get_item(db, id);
    }
    sets.push("updated_at = ?");
    values.push(Box::new(now_iso()));
    values.push(Box::new(id.to_string()));
    let placeholders_sql = sets.join(", ");
    let sql = format!("UPDATE shelf_items SET {placeholders_sql} WHERE id = ?");
    let refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|b| b.as_ref()).collect();
    let n = db.with_conn(|conn| conn.execute(&sql, refs.as_slice()).map_err(AppError::from))?;
    if n == 0 {
        return Err(AppError::NotFound(format!("暂存条目不存在: {id}")));
    }
    get_item(db, id)
}

// ── 删除 / 清空 / 过期清理 ──────────────────────────────────

struct PendingFile {
    id: String,
    managed_path: Option<String>,
    size: i64,
}

/// 删除条目：先事务删行（关联随外键级联），提交后删除 Task Dock 拥有的
/// 托管文件与缩略图。原文件（引用模式）绝不触碰。
pub fn delete_items(
    db: &Db,
    root: &Path,
    ids: &[String],
    include_protected: bool,
) -> AppResult<ShelfDeleteReport> {
    if ids.is_empty() {
        return Ok(ShelfDeleteReport {
            deleted: 0,
            skipped: 0,
            freed_bytes: 0,
            failed_files: 0,
        });
    }
    delete_matching(db, root, Some(ids), include_protected)
}

pub fn clear(db: &Db, root: &Path, include_protected: bool) -> AppResult<ShelfDeleteReport> {
    delete_matching(db, root, None, include_protected)
}

/// 读取保护状态并在同一写事务中删除，避免状态在预读与删除之间变化。
/// 指定 ID 分批绑定，避免批量操作超过 SQLite 的参数上限；清空直接按条件删除。
fn delete_matching(
    db: &Db,
    root: &Path,
    ids: Option<&[String]>,
    include_protected: bool,
) -> AppResult<ShelfDeleteReport> {
    const ID_BATCH_SIZE: usize = 500;

    let (deleted, skipped, pending) = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut skipped = 0i64;
        let mut pending = Vec::new();
        let mut deleted = 0i64;

        if let Some(ids) = ids {
            let mut seen = HashSet::with_capacity(ids.len());
            let unique_ids = ids
                .iter()
                .filter(|id| seen.insert(id.as_str()))
                .cloned()
                .collect::<Vec<_>>();

            for id_batch in unique_ids.chunks(ID_BATCH_SIZE) {
                let ph = placeholders(id_batch.len());
                let select_sql = format!(
                    "SELECT id, managed_path, byte_size, favorite, pinned, scene_id FROM shelf_items WHERE id IN ({ph})"
                );
                let mut batch_pending = {
                    let mut stmt = tx.prepare(&select_sql)?;
                    let rows = stmt.query_map(params_from_iter(id_batch.iter()), |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<String>>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, i64>(3)?,
                            r.get::<_, i64>(4)?,
                            r.get::<_, Option<String>>(5)?,
                        ))
                    })?;
                    let mut batch_pending = Vec::new();
                    for row in rows {
                        let (id, managed_path, size, favorite, pinned, scene_id) = row?;
                        if !include_protected
                            && (favorite != 0 || pinned != 0 || scene_id.is_some())
                        {
                            skipped += 1;
                        } else {
                            batch_pending.push(PendingFile {
                                id,
                                managed_path,
                                size,
                            });
                        }
                    }
                    batch_pending
                };

                if batch_pending.is_empty() {
                    continue;
                }
                let delete_ids = batch_pending
                    .iter()
                    .map(|item| item.id.clone())
                    .collect::<Vec<_>>();
                let delete_ph = placeholders(delete_ids.len());
                let protected_clause = if include_protected {
                    ""
                } else {
                    " AND favorite = 0 AND pinned = 0 AND scene_id IS NULL"
                };
                deleted += tx.execute(
                    &format!(
                        "DELETE FROM shelf_items WHERE id IN ({delete_ph}){protected_clause}"
                    ),
                    params_from_iter(delete_ids.iter()),
                )? as i64;
                // 事务内复核：扫描后条目可能被改为收藏/置顶/关联场景，DELETE 会跳过它。
                // 这些行不能进入待删文件列表，否则会出现「数据库行还在、托管文件已删」。
                let survivors = {
                    let mut stmt = tx.prepare(&format!(
                        "SELECT id FROM shelf_items WHERE id IN ({delete_ph})"
                    ))?;
                    let rows = stmt.query_map(params_from_iter(delete_ids.iter()), |r| {
                        r.get::<_, String>(0)
                    })?;
                    rows.collect::<Result<HashSet<String>, _>>()?
                };
                if !survivors.is_empty() {
                    skipped += survivors.len() as i64;
                    batch_pending.retain(|p| !survivors.contains(&p.id));
                }
                pending.extend(batch_pending);
            }
        } else {
            {
                let mut stmt = tx.prepare(
                    "SELECT id, managed_path, byte_size, favorite, pinned, scene_id FROM shelf_items",
                )?;
                let rows = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                })?;
                for row in rows {
                    let (id, managed_path, size, favorite, pinned, scene_id) = row?;
                    if !include_protected
                        && (favorite != 0 || pinned != 0 || scene_id.is_some())
                    {
                        skipped += 1;
                    } else {
                        pending.push(PendingFile {
                            id,
                            managed_path,
                            size,
                        });
                    }
                }
            }
            let sql = if include_protected {
                "DELETE FROM shelf_items"
            } else {
                "DELETE FROM shelf_items WHERE favorite = 0 AND pinned = 0 AND scene_id IS NULL"
            };
            deleted = tx.execute(sql, [])? as i64;
            // 事务内复核：只有确认已从表中删除的行才允许进入待删文件列表。
            let remaining = {
                let mut stmt = tx.prepare("SELECT id FROM shelf_items")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<Result<HashSet<String>, _>>()?
            };
            let before = pending.len();
            pending.retain(|p| !remaining.contains(&p.id));
            skipped += (before - pending.len()) as i64;
        }

        tx.commit()?;
        Ok((deleted, skipped, pending))
    })?;
    let (freed, failed) = remove_owned_files(root, &pending);
    Ok(ShelfDeleteReport {
        deleted,
        skipped,
        freed_bytes: freed,
        failed_files: failed,
    })
}

/// 删除 Task Dock 拥有的文件（托管主文件 + 缩略图），canonical 边界复核。
/// 文件删除失败只计数不谎报；数据库行已删，残留文件由下次清理的孤儿扫描兜底。
fn remove_owned_files(root: &Path, pending: &[PendingFile]) -> (i64, i64) {
    let mut freed = 0i64;
    let mut failed = 0i64;
    for p in pending {
        if let Some(rel) = &p.managed_path {
            match safe_managed_rel(rel) {
                Ok(path) => {
                    let abs = root.join(path);
                    match std::fs::symlink_metadata(&abs) {
                        Ok(_) if is_within_root(root, &abs) => match std::fs::remove_file(&abs) {
                            Ok(()) => freed += p.size,
                            Err(_) => failed += 1,
                        },
                        Ok(_) => failed += 1,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(_) => failed += 1,
                    }
                }
                Err(_) => failed += 1,
            }
        }
        let thumb = root.join(format!("thumbs/{}.png", p.id));
        match std::fs::symlink_metadata(&thumb) {
            Ok(_) if is_within_root(root, &thumb) => {
                if std::fs::remove_file(&thumb).is_err() {
                    failed += 1;
                }
            }
            Ok(_) => failed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failed += 1,
        }
    }
    (freed, failed)
}

/// 单条目的有效过期时间：显式 expire_at，否则 created_at + retention_days。
/// favorite / pinned 永远豁免（除非用户显式确认包含）。
fn effective_expire_at(
    expire_at: Option<&str>,
    created_at: &str,
    retention_days: u32,
) -> Option<chrono::DateTime<Utc>> {
    let explicit = expire_at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
    if let Some(t) = explicit {
        return Some(t.with_timezone(&Utc));
    }
    let created = chrono::DateTime::parse_from_rfc3339(created_at)
        .ok()?
        .with_timezone(&Utc);
    Some(created + Duration::days(retention_days as i64))
}

pub fn cleanup_expired(
    db: &Db,
    root: &Path,
    settings: &Settings,
    dry_run: bool,
    include_protected: bool,
) -> AppResult<ShelfCleanupReport> {
    let now = Utc::now();
    struct Cand {
        id: String,
        managed_path: Option<String>,
        size: i64,
    }
    let mut candidates: Vec<Cand> = Vec::new();
    let mut skipped_protected = 0i64;
    {
        let sql = "SELECT id, managed_path, byte_size, favorite, pinned, expire_at, created_at, scene_id \
                   FROM shelf_items";
        db.with_read(|conn| {
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<String>>(7)?,
                ))
            })?;
            for r in rows {
                let (id, managed, size, fav, pin, expire_at, created_at, scene_id) = r?;
                // 收藏 / 置顶 / 已被场景引用 的条目都不参与自动过期清理：
                // 场景仍在使用这些文件时清掉会静默破坏场景，且用户无从得知。
                let is_protected = fav != 0 || pin != 0 || scene_id.is_some();
                if is_protected && !include_protected {
                    // 收藏/置顶不参与过期判定（也不计入 skipped_protected：
                    // 它们根本不是候选；此字段只统计「过期但被保护」的条目）
                    if effective_expire_at(
                        expire_at.as_deref(),
                        &created_at,
                        settings.shelf_retention_days,
                    )
                    .is_some_and(|t| t <= now)
                    {
                        skipped_protected += 1;
                    }
                    continue;
                }
                if let Some(t) = effective_expire_at(
                    expire_at.as_deref(),
                    &created_at,
                    settings.shelf_retention_days,
                ) {
                    if t <= now {
                        candidates.push(Cand {
                            id,
                            managed_path: managed,
                            size,
                        });
                    }
                }
            }
            Ok(())
        })?;
    }
    let freed_bytes: i64 = candidates
        .iter()
        .filter(|c| c.managed_path.is_some())
        .map(|c| c.size)
        .sum();
    if dry_run || candidates.is_empty() {
        return Ok(ShelfCleanupReport {
            dry_run,
            candidates: candidates.len() as i64,
            skipped_protected,
            temporary_files_skipped: 0,
            freed_bytes,
            failed_files: 0,
            orphan_files_removed: 0,
        });
    }
    let ids: Vec<String> = candidates.iter().map(|c| c.id.clone()).collect();
    let del = delete_items(db, root, &ids, true)?;
    let orphans = purge_orphan_files(db, root)?;
    Ok(ShelfCleanupReport {
        dry_run: false,
        candidates: del.deleted,
        skipped_protected,
        temporary_files_skipped: orphans.skipped_temporary_files,
        freed_bytes: del.freed_bytes,
        failed_files: del.failed_files + orphans.failed_files,
        orphan_files_removed: orphans.removed_files,
    })
}

#[derive(Debug, Default, Clone, Copy)]
pub struct OrphanCleanupReport {
    pub removed_files: i64,
    pub skipped_files: i64,
    pub skipped_temporary_files: i64,
    pub failed_files: i64,
}

#[cfg(windows)]
pub(crate) fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_REPARSE_POINT also covers junctions, unlike is_symlink alone.
    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
pub(crate) fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// 读取文件系统对象身份，执行清理时用于区分同路径替换后的新文件。
pub(crate) fn file_identity(path: &Path) -> Option<u128> {
    let file = std::fs::File::open(path).ok()?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
        if ok == 0 {
            return None;
        }
        let info = unsafe { info.assume_init() };
        Some(
            ((info.dwVolumeSerialNumber as u128) << 64)
                | ((info.nFileIndexHigh as u128) << 32)
                | info.nFileIndexLow as u128,
        )
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata().ok()?;
        Some(((meta.dev() as u128) << 64) | meta.ino() as u128)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = file;
        None
    }
}

/// 孤儿文件兜底：数据库删除失败或复制中断留下的无主文件，下次清理时移除。
/// 引用集合 = 全部 managed_path + 全部缩略图（thumbs/{id}.png）。
/// 任一引用查询失败时整轮中止，不使用部分引用集合判断孤儿。
pub fn purge_orphan_files(db: &Db, root: &Path) -> AppResult<OrphanCleanupReport> {
    // Both reference queries must succeed before any file is examined. Returning the local set
    // only after the closure completes prevents a partial set from authorizing deletion.
    let referenced = match db.with_read(|conn| {
        let mut set = std::collections::HashSet::new();
        let mut stmt =
            conn.prepare("SELECT managed_path FROM shelf_items WHERE managed_path IS NOT NULL")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for row in rows {
            set.insert(row?);
        }

        let mut stmt = conn.prepare("SELECT id FROM shelf_items WHERE kind = 'image'")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for row in rows {
            set.insert(format!("thumbs/{}.png", row?));
        }
        Ok(set)
    }) {
        Ok(referenced) => referenced,
        Err(error) => {
            tracing::error!("暂存架孤儿清理因数据库引用查询失败而中止: {error}");
            return Err(error);
        }
    };

    let mut report = OrphanCleanupReport::default();
    let Some(canonical_root) = canonical_shelf_root(root)? else {
        return Ok(report);
    };

    for sub in ["files", "images", "thumbs"] {
        let dir = root.join(sub);
        let directory_metadata = match std::fs::symlink_metadata(&dir) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                report.failed_files += 1;
                tracing::warn!("暂存架孤儿目录校验失败（{sub}）: {}", error.kind());
                continue;
            }
        };
        if !directory_metadata.is_dir() || is_reparse_point(&directory_metadata) {
            report.skipped_files += 1;
            tracing::warn!("暂存架孤儿目录不是安全目录（{sub}），已跳过");
            continue;
        }
        let canonical_dir = match std::fs::canonicalize(&dir) {
            Ok(path) if path.parent() == Some(canonical_root.as_path()) => path,
            Ok(_) => {
                report.skipped_files += 1;
                tracing::warn!("暂存架孤儿目录越出根目录（{sub}），已跳过");
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                report.failed_files += 1;
                tracing::warn!("暂存架孤儿目录路径解析失败（{sub}）: {}", error.kind());
                continue;
            }
        };
        let entries = match std::fs::read_dir(&canonical_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                report.failed_files += 1;
                tracing::warn!("暂存架孤儿目录读取失败（{sub}）: {}", error.kind());
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    report.failed_files += 1;
                    tracing::warn!("暂存架孤儿目录项读取失败（{sub}）: {}", error.kind());
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    report.failed_files += 1;
                    tracing::warn!("暂存架孤儿文件元数据读取失败（{sub}）: {}", error.kind());
                    continue;
                }
            };
            if !metadata.is_file() || is_reparse_point(&metadata) {
                report.skipped_files += 1;
                continue;
            }
            let canonical_path = match std::fs::canonicalize(&path) {
                Ok(path) if path.parent() == Some(canonical_dir.as_path()) => path,
                Ok(_) => {
                    report.skipped_files += 1;
                    continue;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    report.failed_files += 1;
                    tracing::warn!("暂存架孤儿文件路径解析失败（{sub}）: {}", error.kind());
                    continue;
                }
            };
            // Retain only a canonical child path before the transactional reference recheck.
            if !canonical_path.starts_with(&canonical_root) {
                report.skipped_files += 1;
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".part") || name.ends_with(".tmp") {
                report.skipped_files += 1;
                report.skipped_temporary_files += 1;
                continue;
            }
            let rel = format!("{sub}/{name}");
            if !referenced.contains(&rel) {
                let Some(modified_ns) = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|time| time.as_nanos())
                else {
                    report.skipped_files += 1;
                    continue;
                };
                let Some(identity) = file_identity(&canonical_path) else {
                    report.skipped_files += 1;
                    continue;
                };
                let outcome = match remove_orphan_if_unreferenced(
                    db,
                    root,
                    &canonical_root,
                    &canonical_dir,
                    sub,
                    &name,
                    metadata.len(),
                    modified_ns,
                    identity,
                ) {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        tracing::error!("暂存架孤儿清理因复查引用失败而中止: {error}");
                        return Err(error);
                    }
                };
                match outcome {
                    OrphanRemoveOutcome::Removed => report.removed_files += 1,
                    OrphanRemoveOutcome::Skipped => report.skipped_files += 1,
                    OrphanRemoveOutcome::Failed(kind) => {
                        report.failed_files += 1;
                        tracing::warn!("暂存架孤儿文件删除失败: {kind}");
                    }
                }
            } else {
                report.skipped_files += 1;
            }
        }
    }
    Ok(report)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrphanRemoveOutcome {
    Removed,
    Skipped,
    Failed(std::io::ErrorKind),
}

/// 在 SQLite writer transaction 持有期间重新核验引用并删除；事务锁期间不能有并发
/// 写入为同一路径新增引用。删除前重新验证目录与文件身份（大小/mtime/常规文件）。
fn remove_orphan_if_unreferenced(
    db: &Db,
    root: &Path,
    canonical_root: &Path,
    canonical_dir: &Path,
    sub: &str,
    name: &str,
    expected_size: u64,
    expected_modified_ns: u128,
    expected_identity: u128,
) -> AppResult<OrphanRemoveOutcome> {
    let relative = format!("{sub}/{name}");
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> AppResult<OrphanRemoveOutcome> {
            let referenced: bool = if sub == "thumbs" {
                let id = name.strip_suffix(".png").unwrap_or_default();
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM shelf_items WHERE id = ?1 AND kind = 'image')",
                    [id],
                    |row| row.get(0),
                )?
            } else {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM shelf_items WHERE managed_path = ?1)",
                    [&relative],
                    |row| row.get(0),
                )?
            };
            if referenced {
                return Ok(OrphanRemoveOutcome::Skipped);
            }

            let dir = root.join(sub);
            let dir_meta = match std::fs::symlink_metadata(&dir) {
                Ok(meta) if meta.is_dir() && !is_reparse_point(&meta) => meta,
                _ => return Ok(OrphanRemoveOutcome::Skipped),
            };
            let _ = dir_meta;
            if std::fs::canonicalize(&dir).ok().as_deref() != Some(canonical_dir) {
                return Ok(OrphanRemoveOutcome::Skipped);
            }
            let path = canonical_dir.join(name);
            match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_file() && !is_reparse_point(&meta) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(OrphanRemoveOutcome::Skipped)
                }
                Ok(_) => return Ok(OrphanRemoveOutcome::Skipped),
                Err(error) => return Ok(OrphanRemoveOutcome::Failed(error.kind())),
            };
            let canonical_path = match std::fs::canonicalize(&path) {
                Ok(path)
                    if path.parent() == Some(canonical_dir) && path.starts_with(canonical_root) =>
                {
                    path
                }
                _ => return Ok(OrphanRemoveOutcome::Skipped),
            };
            match crate::fs_safety::remove_file_if_unchanged(
                &canonical_path,
                expected_size,
                expected_modified_ns,
                expected_identity,
            ) {
                Ok(true) => Ok(OrphanRemoveOutcome::Removed),
                Ok(false) => Ok(OrphanRemoveOutcome::Skipped),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(OrphanRemoveOutcome::Skipped)
                }
                Err(error) => Ok(OrphanRemoveOutcome::Failed(error.kind())),
            }
        })();
        match result {
            Ok(outcome) => {
                conn.execute_batch("COMMIT")?;
                Ok(outcome)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

/// 仅在暂存架运行时状态创建前清理上次退出遗留的 `.part`/`.tmp` 文件。
pub fn purge_part_files(root: &Path) -> AppResult<()> {
    let Some(canonical_root) = canonical_shelf_root(root)? else {
        return Ok(());
    };
    for sub in ["files", "images", "thumbs"] {
        let dir = root.join(sub);
        let metadata = match std::fs::symlink_metadata(&dir) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                tracing::warn!("启动时暂存架目录检查失败（{sub}）: {}", error.kind());
                continue;
            }
        };
        if !metadata.is_dir() || is_reparse_point(&metadata) {
            tracing::warn!("启动时暂存架目录不是安全目录（{sub}），跳过残留清理");
            continue;
        }
        let canonical_dir = match std::fs::canonicalize(&dir) {
            Ok(path) if path.parent() == Some(canonical_root.as_path()) => path,
            Ok(_) => {
                tracing::warn!("启动时暂存架目录越出根目录（{sub}），跳过残留清理");
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                tracing::warn!("启动时暂存架目录解析失败（{sub}）: {}", error.kind());
                continue;
            }
        };
        let entries = match std::fs::read_dir(&canonical_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                tracing::warn!("启动时暂存架目录读取失败（{sub}）: {}", error.kind());
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    tracing::warn!("启动时暂存架目录项读取失败（{sub}）: {}", error.kind());
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    tracing::warn!("启动时暂存架残留元数据读取失败（{sub}）: {}", error.kind());
                    continue;
                }
            };
            if !metadata.is_file() || is_reparse_point(&metadata) {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".part") || name.ends_with(".tmp") {
                let canonical_path = match std::fs::canonicalize(&path) {
                    Ok(path) if path.parent() == Some(canonical_dir.as_path()) => path,
                    Ok(_) => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        tracing::warn!("启动时暂存架残留路径解析失败（{sub}）: {}", error.kind());
                        continue;
                    }
                };
                if !canonical_path.starts_with(&canonical_root) {
                    continue;
                }
                let Some(modified_ns) = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|time| time.as_nanos())
                else {
                    continue;
                };
                let Some(identity) = file_identity(&canonical_path) else {
                    continue;
                };
                match crate::fs_safety::remove_file_if_unchanged(
                    &canonical_path,
                    metadata.len(),
                    modified_ns,
                    identity,
                ) {
                    Ok(true) => {}
                    Ok(false) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        tracing::warn!("启动时暂存架残留删除失败（{sub}）: {}", error.kind())
                    }
                }
            }
        }
    }
    Ok(())
}

// ── 存在性检查 / 打开 / 预览 ────────────────────────────────

/// 批量刷新存在性：引用模式查原路径，托管模式查托管文件；link/text 恒 ok。
/// 元数据探测对失效网络路径可能阻塞数秒（异步命令内执行，不阻塞 UI）。
pub fn check_exists(db: &Db, root: &Path, ids: &[String]) -> AppResult<Vec<ShelfExistsReport>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let ph = placeholders(ids.len());
    let sql = format!(
        "SELECT id, kind, storage_mode, original_path, managed_path FROM shelf_items WHERE id IN ({ph})"
    );
    let mut reports = Vec::new();
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(ids.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?;
        for r in rows {
            let (id, kind, mode, original, managed) = r?;
            let state = match kind.as_str() {
                KIND_LINK | KIND_TEXT => "ok",
                _ => {
                    let exists = match mode.as_str() {
                        MODE_MANAGED => managed
                            .as_deref()
                            .and_then(|rel| safe_managed_rel(rel).ok())
                            .map(|p| root.join(p).exists())
                            .unwrap_or(false),
                        _ => original
                            .as_deref()
                            .map(|p| std::path::Path::new(p).exists())
                            .unwrap_or(false),
                    };
                    if exists {
                        "ok"
                    } else {
                        "missing"
                    }
                }
            };
            conn.execute(
                "UPDATE shelf_items SET exists_state = ?1 WHERE id = ?2",
                params![state, &id],
            )?;
            reports.push(ShelfExistsReport {
                id,
                exists_state: state.into(),
            });
        }
        Ok(())
    })?;
    Ok(reports)
}

/// 解析条目对应的外部文件路径（打开/定位用）。
/// 返回 (条目, 文件路径)；link/text 无文件语义报错。
pub fn resolve_item_file(db: &Db, root: &Path, id: &str) -> AppResult<(ShelfItem, PathBuf)> {
    let item = get_item(db, id)?;
    match (item.kind.as_str(), item.storage_mode.as_str()) {
        (KIND_LINK, _) => Err(AppError::Validation("链接条目请在应用内打开".into())),
        (KIND_TEXT, _) => Err(AppError::Validation("文本条目请在应用内查看".into())),
        (KIND_FOLDER, MODE_REFERENCE) => {
            let raw = item
                .original_path
                .as_deref()
                .ok_or_else(|| AppError::Validation("条目缺少原路径".into()))?;
            let p = require_existing_path(raw)?;
            Ok((item, p))
        }
        (_, MODE_MANAGED) => {
            let rel = item
                .managed_path
                .as_deref()
                .ok_or_else(|| AppError::Validation("托管条目缺少文件路径".into()))?;
            let path = root.join(safe_managed_rel(rel)?);
            if !path.exists() {
                return Err(AppError::NotFound(
                    "托管文件已丢失（可能被外部删除）".into(),
                ));
            }
            Ok((item, path))
        }
        _ => {
            let raw = item
                .original_path
                .as_deref()
                .ok_or_else(|| AppError::Validation("条目缺少原路径".into()))?;
            let p = require_existing_path(raw)?;
            Ok((item, p))
        }
    }
}

/// 文本内容读取：text 条目读库内 content；文件条目按扩展名白名单读
/// 托管/原文件，超限截断。HTML 文件走同一通道，由前端净化后只读渲染。
pub fn read_text(db: &Db, root: &Path, id: &str) -> AppResult<(String, bool)> {
    let item = get_item(db, id)?;
    if item.kind == KIND_TEXT {
        return Ok((item.content.unwrap_or_default(), false));
    }
    let ext = item.file_ext.clone().unwrap_or_default();
    if !is_text_ext(&ext) {
        return Err(AppError::Validation("该文件类型不支持文本预览".into()));
    }
    let (_, path) = resolve_item_file(db, root, id)?;
    let meta = std::fs::metadata(&path)?;
    if meta.len() > MAX_TEXT_BYTES as u64 {
        let mut file = std::fs::File::open(&path)?;
        let mut buf = vec![0u8; MAX_TEXT_BYTES];
        file.read_exact(&mut buf)?;
        let s = String::from_utf8_lossy(&buf).to_string();
        return Ok((s, true));
    }
    let bytes = std::fs::read(&path)?;
    Ok((String::from_utf8_lossy(&bytes).to_string(), false))
}

/// 图片数据 URL：thumb=true 读缩略图（≤8MB 原图开销），full=true 读原图（≤40MB）。
/// 引用模式原文件可能已失效 → None，UI 显示失效态。
pub fn read_image_data_url(
    db: &Db,
    root: &Path,
    id: &str,
    full: bool,
) -> AppResult<Option<String>> {
    let item = get_item(db, id)?;
    if item.kind != KIND_IMAGE {
        return Err(AppError::Validation("该条目不是图片".into()));
    }
    let (rel, limit): (Option<String>, u64) = if full {
        (None, 40 * 1024 * 1024)
    } else {
        (Some(format!("thumbs/{}.png", item.id)), 8 * 1024 * 1024)
    };
    let path: PathBuf = if let Some(rel) = rel {
        root.join(rel)
    } else {
        match item.storage_mode.as_str() {
            MODE_MANAGED => root.join(safe_managed_rel(
                item.managed_path.as_deref().unwrap_or_default(),
            )?),
            _ => {
                let raw = item
                    .original_path
                    .as_deref()
                    .ok_or_else(|| AppError::Validation("条目缺少原路径".into()))?;
                let p = PathBuf::from(raw);
                if !p.exists() {
                    return Ok(None);
                }
                p
            }
        }
    };
    if !path.exists() {
        return Ok(None);
    }
    let meta = std::fs::metadata(&path)?;
    if meta.len() > limit {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    let mime = match item.file_ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    };
    use base64::Engine as _;
    Ok(Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    )))
}

// ── 任务关联 ────────────────────────────────────────────────

pub fn task_links(db: &Db, item_id: &str) -> AppResult<Vec<ShelfTaskLink>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT l.task_id, l.item_id, COALESCE(t.title, ''), l.created_at \
             FROM shelf_task_links l LEFT JOIN tasks t ON t.id = l.task_id \
             WHERE l.item_id = ?1 ORDER BY l.created_at DESC",
        )?;
        let rows = stmt.query_map(params![item_id], |r| {
            Ok(ShelfTaskLink {
                task_id: r.get(0)?,
                item_id: r.get(1)?,
                task_title: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// 关联任务：主键约束天然幂等，重复关联静默成功。
/// 任务必须存在（外键校验失败翻译为可读错误）。
pub fn link_task(db: &Db, item_id: &str, task_id: &str) -> AppResult<()> {
    let task_exists: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE id = ?1",
            params![task_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    if task_exists == 0 {
        return Err(AppError::NotFound(format!("任务不存在: {task_id}")));
    }
    get_item(db, item_id)?;
    let r = db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO shelf_task_links (task_id, item_id, created_at) \
             VALUES (?1, ?2, ?3)",
            params![task_id, item_id, now_iso()],
        )
        .map_err(AppError::from)
    })?;
    if r == 0 {
        tracing::debug!("任务关联已存在（幂等忽略）: item={item_id} task={task_id}");
    }
    Ok(())
}

pub fn unlink_task(db: &Db, item_id: &str, task_id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM shelf_task_links WHERE item_id = ?1 AND task_id = ?2",
            params![item_id, task_id],
        )?;
        Ok(())
    })
}

// ── 工具 ────────────────────────────────────────────────────

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// 从剪贴板条目复制资产到暂存架（独立副本，与剪贴板生命周期解耦）。
/// 返回 (clipboard kind, 取到的内容)。
pub(crate) enum ClipboardSnapshot {
    Text { text: String },
    Url { url: String },
    ImagePng { png: Vec<u8> },
    Paths { paths: Vec<String> },
    Unsupported { reason: String },
}

pub(crate) fn snapshot_clipboard_item(
    db: &Db,
    clipboard_root: &Path,
    clipboard_item_id: &str,
) -> AppResult<ClipboardSnapshot> {
    let (kind, text, file_paths_json): (String, Option<String>, Option<String>) =
        db.with_read(|conn| {
            conn.query_row(
                "SELECT kind, text, file_paths FROM clipboard_items WHERE id = ?1",
                params![clipboard_item_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| AppError::NotFound(format!("剪贴板条目不存在: {clipboard_item_id}")))
        })?;
    match kind.as_str() {
        "url" => Ok(ClipboardSnapshot::Url {
            url: text.unwrap_or_default(),
        }),
        "text" => Ok(ClipboardSnapshot::Text {
            text: text.unwrap_or_default(),
        }),
        "html" => Ok(ClipboardSnapshot::Text {
            text: text.unwrap_or_default(),
        }),
        "image" => {
            let rel: Option<String> = db.with_read(|conn| {
                conn.query_row(
                    "SELECT path FROM clipboard_assets WHERE item_id = ?1 AND role = 'image'",
                    params![clipboard_item_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(AppError::from)
            })?;
            let Some(rel) = rel else {
                return Ok(ClipboardSnapshot::Unsupported {
                    reason: "该图片条目缺少资产文件".into(),
                });
            };
            let abs = crate::clipboard::store::asset_abs(clipboard_root, &rel)?;
            if !abs.exists() {
                return Ok(ClipboardSnapshot::Unsupported {
                    reason: "剪贴板图片文件已被清理".into(),
                });
            }
            let png = std::fs::read(&abs)?;
            Ok(ClipboardSnapshot::ImagePng { png })
        }
        "files" => {
            let paths: Vec<String> = file_paths_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            if paths.is_empty() {
                return Ok(ClipboardSnapshot::Unsupported {
                    reason: "文件列表为空".into(),
                });
            }
            Ok(ClipboardSnapshot::Paths { paths })
        }
        other => Ok(ClipboardSnapshot::Unsupported {
            reason: format!("不支持的剪贴板类型: {other}"),
        }),
    }
}

/// 把 PNG 字节落成托管图片副本（从剪贴板添加图片用）。
pub fn add_managed_png(
    db: &Db,
    root: &Path,
    png: &[u8],
    source_name: &str,
    source_kind: &str,
    group_id: Option<&str>,
) -> AppResult<ShelfItem> {
    if png.len() as u64 > MAX_MANAGED_FILE_BYTES {
        return Err(AppError::Validation("图片超过托管大小上限".into()));
    }
    let settings = Settings::load(db).unwrap_or_default();
    let quota_bytes = (settings.shelf_max_storage_mb as u64) * 1024 * 1024;
    let current: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COALESCE(SUM(byte_size),0) FROM shelf_items WHERE storage_mode = 'managed'",
            [],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    if (current as u64).saturating_add(png.len() as u64) > quota_bytes {
        return Err(AppError::Validation(
            "超出托管配额，请在清理设置中调整配额或清理旧条目".into(),
        ));
    }
    if let Some(free) = disk_free_bytes(root) {
        if free < png.len() as u64 + DISK_FREE_MARGIN {
            return Err(AppError::Validation("磁盘空间不足".into()));
        }
    }
    let display_name = validate_add_name(source_name)?;
    let id = uuid::Uuid::new_v4().to_string();
    let rel = format!("images/{id}.png");
    let dest = root.join(&rel);
    std::fs::create_dir_all(root.join("images"))?;
    let tmp = dest.with_extension("png.part");
    std::fs::write(&tmp, png)?;
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    let (width, height) = crate::clipboard::image::decode_png_rgba(png)
        .map(|(_, w, h)| (w as i64, h as i64))
        .unwrap_or((0, 0));
    let _ = (width, height); // 尺寸信息当前不入库；缩略图即时生成
    if let Some(thumb) = make_thumb_png(png) {
        write_thumb(root, &id, &thumb);
    }
    let item = ShelfItem {
        id,
        kind: KIND_IMAGE.into(),
        display_name,
        source_kind: source_kind.into(),
        storage_mode: MODE_MANAGED.into(),
        original_path: None,
        managed_path: Some(rel),
        content: None,
        byte_size: png.len() as i64,
        file_ext: Some("png".into()),
        favorite: false,
        pinned: false,
        exists_state: "ok".into(),
        group_id: resolve_group_id(db, group_id)?,
        scene_id: None,
        note: String::new(),
        expire_at: None,
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    db.with_conn(|conn| insert_item(conn, &item))?;
    Ok(item)
}

// ── 自动清理后台循环 ────────────────────────────────────────

/// 自动清理低频循环：默认关闭；用户启用后每 1 小时执行一次。
/// 挂载说明：调度器 scheduler.rs 属智能提醒模块（跨模块边界禁止修改），
/// 故由暂存架自带线程承载；频率极低（1h）、随进程退出回收、每次运行前
/// 重读设置（fail-closed：设置损坏时跳过本轮，绝不臆测配置继续清理）。
pub fn start_auto_cleanup(state: &ShelfState) {
    let db = Arc::clone(&state.db);
    let root = state.root.clone();
    let gate = Arc::clone(&state.copy_gate);
    let _ = std::thread::Builder::new()
        .name("shelf-auto-cleanup".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
            let settings = match Settings::load(&db) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("暂存架设置不可读，跳过本轮自动清理: {}", e);
                    continue;
                }
            };
            if !settings.shelf_auto_cleanup_enabled {
                continue;
            }
            let Some(_maintenance) = gate.try_acquire_maintenance() else {
                tracing::debug!("暂存架文件操作进行中，跳过本轮自动清理");
                continue;
            };
            match cleanup_expired(&db, &root, &settings, false, false) {
                Ok(r) if r.candidates > 0 || r.orphan_files_removed > 0 => {
                    tracing::info!(
                        cleaned = r.candidates,
                        skipped_protected = r.skipped_protected,
                        freed_bytes = r.freed_bytes,
                        orphans = r.orphan_files_removed,
                        "暂存架自动清理完成"
                    );
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("暂存架自动清理失败: {}", e),
            }
        });
}

pub mod drop_targets;
pub mod fsops;

#[cfg(test)]
mod tests;
