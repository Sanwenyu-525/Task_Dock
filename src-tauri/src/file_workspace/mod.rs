//! 文件工作区核心层：通用目录浏览与文件操作（多目录文件工作区，2026-11-14）。
//!
//! 语义约定：
//! - 只接受**绝对路径**；所有操作 fail-closed：名称经 `sanitize_name` 清洗，
//!   目标目录先校验存在且为目录，冲突策略显式给定，绝不静默覆盖；
//! - 删除默认走回收站（SHFileOperationW FOF_ALLOWUNDO）；永久删除单独命令语义
//!   （`permanent=true`），并有深度上限与重解析点（符号链接/junction）不跟随保护；
//! - 目录复制/移动递归受深度上限与重解析点保护，不做无界递归；
//! - 受保护目录（应用数据目录）拒绝作为删除/移动/复制的目标或源；
//! - 报告逐条给出结果（ok/failed/skipped + 原因），部分成功如实返回，不伪造全成功。
//!
//! 本模块不依赖 Tauri/前端类型，纯 std + windows，便于单测（临时目录）。

pub mod thumbnail;

use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 单次列目录上限：超出返回 truncated 标记（前端提示，不做无限分页）。
pub const MAX_LIST_ENTRIES: usize = 8000;
/// 单批操作（复制/移动/删除）路径数上限：与 shelf::MAX_LOCAL_PATHS 对齐。
pub const MAX_OP_PATHS: usize = 500;
/// 名称长度上限（单路径分量）。
pub const MAX_NAME_CHARS: usize = 200;
/// 递归深度上限：防环（重解析点已不跟随，这里是第二道保险）。
const MAX_RECURSE_DEPTH: usize = 64;
/// 递归条目总数上限：防误删超大目录失控。
const MAX_RECURSE_ITEMS: usize = 200_000;

/// Windows 隐藏/系统/重解析点属性位（std MetadataExt::attributes()）。
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// SystemTime → Unix 毫秒（chrono 转换；失败返回 None 的分支由调用方 map 处理）。
fn unix_ms(t: std::time::SystemTime) -> i64 {
    chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis()
}

// ── 路径与名称校验 ───────────────────────────────────────────────────────

/// 绝对路径基本校验：存在性由调用方按语义自行决定（列表要求存在，创建目标不要求）。
pub fn validate_abs_path(raw: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("路径为空".into()));
    }
    if trimmed.chars().count() > 4096 {
        return Err(AppError::Validation("路径过长".into()));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(AppError::Validation("路径含非法控制字符".into()));
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err(AppError::Validation("必须是绝对路径".into()));
    }
    Ok(p)
}

/// 校验「已存在的目录」；不存在/不是目录分别报错（前端按错误类型提示失效目录）。
pub fn validate_dir(path: &Path) -> AppResult<PathBuf> {
    let meta = fs::metadata(path).map_err(|e| {
        AppError::NotFound(format!("目录不可访问: {}（{e}）", path.display()))
    })?;
    if !meta.is_dir() {
        return Err(AppError::Validation(format!("不是目录: {}", path.display())));
    }
    Ok(path.to_path_buf())
}

/// Windows 保留设备名（不含扩展名判断前的主名）。
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 名称清洗（单路径分量）：禁止分隔符/保留名/`.`/`..`/结尾点空格；不做路径拼接安全假设。
pub fn sanitize_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::Validation("名称不能为空".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::Validation(format!("名称超过 {MAX_NAME_CHARS} 字符")));
    }
    if name == "." || name == ".." {
        return Err(AppError::Validation("名称不能是 . 或 ..".into()));
    }
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err(AppError::Validation("名称含非法字符".into()));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(AppError::Validation("名称不能以点或空格结尾".into()));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(AppError::Validation(format!("名称是 Windows 保留名: {stem}")));
    }
    Ok(name.to_string())
}

/// 路径是否位于受保护目录之内（应用数据目录）。比较前规范化分隔符与大小写。
fn is_under(path: &Path, root: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    norm(path).starts_with(&norm(root))
}

/// 确认路径不在任何受保护目录内（删除/移动目标、复制目标等写入侧调用）。
pub fn ensure_not_protected(path: &Path, protected: &[PathBuf]) -> AppResult<()> {
    for root in protected {
        if is_under(path, root) {
            return Err(AppError::Validation(format!(
                "不允许操作 TaskDock 数据目录内部: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

// ── 目录列举 ─────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    /// dir | file | link
    pub kind: &'static str,
    /// 小写扩展名（不含点）；目录为空串。
    pub ext: String,
    /// 字节；目录/不可得时为 null。
    pub size: Option<u64>,
    /// 修改时间（Unix 毫秒）；不可得时为 null。
    pub modified_ms: Option<i64>,
    pub hidden: bool,
    /// 展示类别（前端映射图标与 --file-tone-* 配色）：folder/image/video/audio/
    /// doc/sheet/slide/archive/code/data/program/text/link/other
    pub category: &'static str,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<FsEntry>,
    pub truncated: bool,
}

/// 按扩展名的展示类别映射（与前端 `--file-tone-*` Token 对齐）。
pub fn category_of(is_dir: bool, is_link: bool, ext: &str) -> &'static str {
    if is_dir {
        return "folder";
    }
    if is_link {
        return "link";
    }
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "tif" | "tiff" => "image",
        "mp4" | "mkv" | "mov" | "avi" | "webm" | "wmv" | "flv" | "m4v" => "video",
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "wma" => "audio",
        "md" | "txt" | "log" | "rst" => "text",
        "doc" | "docx" | "pdf" | "rtf" | "odt" => "doc",
        "xls" | "xlsx" | "csv" | "ods" | "tsv" => "sheet",
        "ppt" | "pptx" | "odp" | "key" => "slide",
        "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" | "cab" | "iso" => "archive",
        "rs" | "ts" | "tsx" | "jsx" | "js" | "mjs" | "cjs" | "py" | "cs" | "cpp" | "cc" | "c"
        | "h" | "hpp" | "java" | "kt" | "swift" | "go" | "lua" | "php" | "rb" | "vue" | "svelte"
        | "html" | "htm" | "css" | "scss" | "less" => "code",
        "json" | "toml" | "yaml" | "yml" | "xml" | "ini" | "cfg" | "conf" | "env" | "sql"
        | "db" | "sqlite" | "sqlite3" | "bin" | "dll" | "so" | "dylib" | "pdb" => "data",
        "exe" | "msi" | "bat" | "cmd" | "ps1" | "com" | "scr" | "apk" => "program",
        _ => "other",
    }
}

/// 列目录：逐项容错（单项元数据失败跳过并计入 truncated 之外，不整体失败）。
pub fn list_dir(path: &Path, show_hidden: bool) -> AppResult<DirListing> {
    let dir = validate_dir(path)?;
    let mut entries: Vec<FsEntry> = Vec::new();
    let mut truncated = false;
    let read = fs::read_dir(&dir).map_err(|e| {
        AppError::Validation(format!("读取目录失败: {}（{e}）", dir.display()))
    })?;
    for item in read {
        if entries.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(item) = item else { continue };
        let Ok(file_type) = item.file_type() else { continue };
        // 元数据取「不跟随」版本：符号链接显示链接本身的信息，不读目标。
        let meta = item.metadata().ok();
        let is_link = file_type.is_symlink();
        let is_dir = file_type.is_dir();
        let name = item.file_name().to_string_lossy().into_owned();
        let hidden = meta
            .as_ref()
            .map(|m| m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0)
            .unwrap_or(false);
        if hidden && !show_hidden {
            continue;
        }
        let ext = if is_dir {
            String::new()
        } else {
            Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default()
        };
        entries.push(FsEntry {
            category: category_of(is_dir, is_link, &ext),
            ext,
            kind: if is_dir {
                "dir"
            } else if is_link {
                "link"
            } else {
                "file"
            },
            size: meta.as_ref().map(|m| m.len()),
            modified_ms: meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| unix_ms(t)),
            hidden,
            name,
        });
    }
    Ok(DirListing {
        path: dir.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

/// 轻量目录签名（轮询刷新用）：只做一次 metadata，不读内容。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirSignature {
    pub exists: bool,
    pub is_dir: bool,
    pub modified_ms: Option<i64>,
}

pub fn dir_signature(path: &Path) -> DirSignature {
    match fs::metadata(path) {
        Ok(meta) => DirSignature {
            exists: true,
            is_dir: meta.is_dir(),
            modified_ms: meta.modified().ok().map(|t| unix_ms(t)),
        },
        Err(_) => DirSignature {
            exists: false,
            is_dir: false,
            modified_ms: None,
        },
    }
}

// ── 常用位置 ─────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    pub path: String,
    /// fixed | removable | network | optical | ram | unknown
    pub drive_kind: &'static str,
}

/// 快速位置：主目录/桌面/下载/文档/图片（env 缺失时跳过，不猜路径）。
pub fn quick_places() -> Vec<Place> {
    let mut out = Vec::new();
    let profile = std::env::var("USERPROFILE").ok();
    if let Some(home) = profile {
        for (name, rel) in [
            ("主目录", ""),
            ("桌面", "Desktop"),
            ("下载", "Downloads"),
            ("文档", "Documents"),
            ("图片", "Pictures"),
        ] {
            let p = if rel.is_empty() {
                PathBuf::from(&home)
            } else {
                Path::new(&home).join(rel)
            };
            if p.is_dir() {
                out.push(Place {
                    name: name.to_string(),
                    path: p.to_string_lossy().into_owned(),
                    drive_kind: "fixed",
                });
            }
        }
    }
    out
}

/// 枚举盘符 A–Z（存在即返回；类型用 GetDriveTypeW，失败按 unknown）。
/// DRIVE_* 常量是稳定 ABI 值（GetDriveTypeW 文档）；当前 windows crate feature
/// 未导出这 6 个整数，本地定义，不为常量新增 feature。
pub fn drives() -> Vec<Place> {
    #[cfg(windows)]
    {
        use windows::Win32::Storage::FileSystem::GetDriveTypeW;
        const DRIVE_NO_ROOT_DIR: u32 = 1;
        const DRIVE_REMOVABLE: u32 = 2;
        const DRIVE_FIXED: u32 = 3;
        const DRIVE_REMOTE: u32 = 4;
        const DRIVE_CDROM: u32 = 5;
        const DRIVE_RAMDISK: u32 = 6;
        let mut out = Vec::new();
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            let root_path = PathBuf::from(&root);
            if !root_path.is_dir() {
                continue;
            }
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            let kind = unsafe { GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) };
            let kind_str = match kind {
                DRIVE_REMOVABLE => "removable",
                DRIVE_FIXED => "fixed",
                DRIVE_REMOTE => "network",
                DRIVE_CDROM => "optical",
                DRIVE_RAMDISK => "ram",
                DRIVE_NO_ROOT_DIR | _ => "unknown",
            };
            out.push(Place {
                name: format!("{} 盘", letter as char),
                path: root,
                drive_kind: kind_str,
            });
        }
        out
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

// ── 冲突策略与目标命名 ───────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Conflict {
    /// 目标已存在 → 该条跳过并报告。
    Skip,
    /// 目标已存在 → 「名称 (2).ext」保留两者。
    Rename,
    /// 文件直接覆盖；目录并入已有目录（递归合并）。
    Overwrite,
}

pub fn parse_conflict(raw: &str) -> AppResult<Conflict> {
    match raw {
        "skip" => Ok(Conflict::Skip),
        "rename" => Ok(Conflict::Rename),
        "overwrite" => Ok(Conflict::Overwrite),
        _ => Err(AppError::Validation(format!(
            "未知冲突策略: {raw}（允许 skip/rename/overwrite）"
        ))),
    }
}

/// 目标已存在时按策略给出「 (n)」序号名：base(2).ext、base(3).ext…
fn unique_target(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem_ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().into_owned());
    let stem = match &stem_ext {
        Some(ext) => name
            .strip_suffix(&format!(".{ext}"))
            .unwrap_or(name)
            .to_string(),
        None => name.to_string(),
    };
    for n in 2..=1000u32 {
        let attempt = match &stem_ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dir.join(&attempt);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} (dup)"))
}

/// 单条操作结果（复制/移动/删除共用）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEntryReport {
    pub source: String,
    pub target: Option<String>,
    /// ok | failed | skipped
    pub status: &'static str,
    pub reason: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsOpReport {
    pub attempted: usize,
    pub ok: usize,
    pub failed: usize,
    pub skipped: usize,
    pub entries: Vec<FsEntryReport>,
}

impl FsOpReport {
    fn empty() -> Self {
        Self {
            attempted: 0,
            ok: 0,
            failed: 0,
            skipped: 0,
            entries: Vec::new(),
        }
    }
    fn push(&mut self, report: FsEntryReport) {
        self.attempted += 1;
        match report.status {
            "ok" => self.ok += 1,
            "failed" => self.failed += 1,
            _ => self.skipped += 1,
        }
        self.entries.push(report);
    }
}

/// 逐条失败报告（自由函数：FsEntryReport 是数据结构，不带构造语义）。
fn fail_report(source: &Path, reason: String) -> FsEntryReport {
    FsEntryReport {
        source: source.to_string_lossy().into_owned(),
        target: None,
        status: "failed",
        reason: Some(reason),
    }
}

/// 复制单个文件；目标存在时按策略处理（Rename 由调用侧先解析成唯一名）。
fn copy_file(src: &Path, dst: &Path, conflict: Conflict) -> Result<(), String> {
    if dst.exists() {
        match conflict {
            Conflict::Skip => return Err("目标已存在".into()),
            Conflict::Rename => return Err("目标已存在（rename 冲突未解析）".into()),
            Conflict::Overwrite => {
                fs::remove_file(dst).map_err(|e| format!("覆盖旧文件失败: {e}"))?;
            }
        }
    }
    fs::copy(src, dst).map(|_| ()).map_err(|e| format!("{e}"))
}

/// 递归复制目录：重解析点（符号链接/junction）不跟随；深度与总量有上限。
/// 子项一律按 Overwrite：父层已确定唯一目标名，子项名称在父目录内部天然无冲突。
fn copy_dir(
    src: &Path,
    dst: &Path,
    conflict: Conflict,
    depth: usize,
    budget: &mut usize,
) -> Result<(), String> {
    if depth > MAX_RECURSE_DEPTH {
        return Err(format!("目录嵌套超过 {MAX_RECURSE_DEPTH} 层，已中止"));
    }
    fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
    let read = fs::read_dir(src).map_err(|e| format!("读取目录失败: {e}"))?;
    for item in read {
        *budget -= 1;
        if *budget <= 0 {
            return Err("目录内容超过上限（20 万项），已中止".into());
        }
        let Ok(item) = item else {
            continue;
        };
        let Ok(ft) = item.file_type() else { continue };
        let child_src = item.path();
        let child_dst = dst.join(item.file_name());
        // 重解析点（symlink/junction）：不跟随、不复制内容，跳过并留给报告。
        let attrs = item
            .metadata()
            .map(|m| m.file_attributes())
            .map_err(|e| format!("{e}"))?;
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 || ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            copy_dir(&child_src, &child_dst, Conflict::Overwrite, depth + 1, budget)?;
        } else {
            copy_file(&child_src, &child_dst, Conflict::Overwrite)?;
        }
    }
    Ok(())
}

/// 目录是否包含 target（移动目录进自身子树拒绝）。按小写规范化比较。
fn contains_path(outer: &Path, inner: &Path) -> bool {
    let norm = |p: &Path| {
        p.to_string_lossy()
            .to_ascii_lowercase()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_string()
    };
    let inner = norm(inner);
    let outer = norm(outer);
    inner != outer && inner.starts_with(&format!("{outer}\\"))
}

/// 通用复制入口：paths → target_dir，逐条报告。目录复制失败保留已复制部分（如实报告）。
pub fn copy_paths(
    paths: &[String],
    target_dir: &Path,
    conflict: Conflict,
    protected: &[PathBuf],
) -> AppResult<FsOpReport> {
    if paths.len() > MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            MAX_OP_PATHS
        )));
    }
    ensure_not_protected(target_dir, protected)?;
    let dir = validate_dir(target_dir)?;
    let mut report = FsOpReport::empty();
    // 父目录优先：先复制父目录时子项随父复制，再单独复制会重复 → 跳过。
    let mut sources: Vec<PathBuf> = paths
        .iter()
        .map(|p| validate_abs_path(p))
        .collect::<AppResult<Vec<_>>>()?;
    sources.sort_by_key(|p| p.components().count());
    let mut copied_roots: Vec<PathBuf> = Vec::new();
    let mut budget = MAX_RECURSE_ITEMS;
    for src in &sources {
        ensure_not_protected(src, protected)?;
        if copied_roots
            .iter()
            .any(|root| contains_path(root, src) || same_path(root, src))
        {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("父目录已在本批次中复制".into()),
            });
            continue;
        }
        if !src.exists() {
            report.push(fail_report(src, "源不存在或已被移动".into()));
            continue;
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| AppError::Validation("源路径缺少文件名".into()))?;
        let meta = fs::symlink_metadata(src).map_err(|e| AppError::Io(e))?;
        if meta.file_type().is_symlink() {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("符号链接不复制（避免跟随出目录边界）".into()),
            });
            continue;
        }
        // 目标命名：冲突 rename 时先求唯一名；其余策略直接用原名。
        let dst = if conflict == Conflict::Rename && dir.join(&name).exists() {
            unique_target(&dir, &name)
        } else {
            dir.join(&name)
        };
        if contains_path(src, &dir) {
            report.push(fail_report(
                src,
                "不能把目录复制到其自身内部".into(),
            ));
            continue;
        }
        let outcome = if meta.is_dir() {
            copy_dir(src, &dst, conflict, 0, &mut budget)
        } else {
            copy_file(src, &dst, conflict)
        };
        match outcome {
            Ok(()) => {
                copied_roots.push(src.clone());
                report.push(FsEntryReport {
                    source: src.to_string_lossy().into_owned(),
                    target: Some(dst.to_string_lossy().into_owned()),
                    status: "ok",
                    reason: None,
                });
            }
            Err(reason) => report.push(fail_report(src, reason)),
        }
    }
    Ok(report)
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        p.to_string_lossy()
            .to_ascii_lowercase()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_string()
    };
    norm(a) == norm(b)
}

/// 同卷优先 rename；跨卷回退「复制 + 删除源」。返回目标路径或失败原因。
fn move_one(src: &Path, dst: &Path, conflict: Conflict, depth: usize, budget: &mut usize) -> Result<PathBuf, String> {
    if dst.exists() {
        match conflict {
            Conflict::Skip => return Err("目标已存在".into()),
            Conflict::Rename => return Err("目标已存在（rename 冲突未解析）".into()),
            Conflict::Overwrite => {
                let meta = fs::symlink_metadata(dst).map_err(|e| format!("{e}"))?;
                if meta.is_dir() {
                    // 目录并入：递归复制后删除源（不删除已有目标内容）。
                    copy_dir(src, &dst, Conflict::Overwrite, depth, budget)?;
                    delete_tree(src)?;
                    return Ok(dst.to_path_buf());
                }
                fs::remove_file(dst).map_err(|e| format!("覆盖旧文件失败: {e}"))?;
            }
        }
    }
    match fs::rename(src, dst) {
        Ok(()) => Ok(dst.to_path_buf()),
        Err(_) => {
            // 跨卷或被占用：回退复制 + 删除源。目录复制失败时保留源（不丢数据）。
            let meta = fs::symlink_metadata(src).map_err(|e| format!("{e}"))?;
            if meta.is_dir() {
                copy_dir(src, &dst, conflict, depth, budget)?;
                delete_tree(src)?;
            } else {
                fs::copy(src, dst).map_err(|e| format!("{e}"))?;
                fs::remove_file(src).map_err(|e| {
                    let _ = fs::remove_file(dst); // 回退失败：目标副本也清掉，不留半个文件
                    format!("删除源失败（目标副本已回滚）: {e}")
                })?;
            }
            Ok(dst.to_path_buf())
        }
    }
}

/// 有界递归删除（永久删除）：重解析点不跟随（只删链接本身），深度与总量有上限。
fn delete_tree(path: &Path) -> Result<(), String> {
    fn rec(path: &Path, depth: usize, budget: &mut usize) -> Result<(), String> {
        if depth > MAX_RECURSE_DEPTH {
            return Err(format!("目录嵌套超过 {MAX_RECURSE_DEPTH} 层，已中止"));
        }
        let meta = fs::symlink_metadata(path).map_err(|e| format!("{e}"))?;
        // 重解析点：直接删链接本身，绝不递归进目标（防环、防越界）。
        if meta.file_type().is_symlink()
            || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            fs::remove_file(path)
                .or_else(|_| fs::remove_dir(path))
                .map_err(|e| format!("{e}"))?;
            return Ok(());
        }
        if meta.is_dir() {
            let read = fs::read_dir(path).map_err(|e| format!("{e}"))?;
            for item in read {
                *budget -= 1;
                if *budget <= 0 {
                    return Err("目录内容超过上限（20 万项），已中止".into());
                }
                let Ok(item) = item else { continue };
                rec(&item.path(), depth + 1, budget)?;
            }
            fs::remove_dir(path).map_err(|e| format!("{e}"))?;
        } else {
            fs::remove_file(path).map_err(|e| format!("{e}"))?;
        }
        Ok(())
    }
    let mut budget = MAX_RECURSE_ITEMS;
    rec(path, 0, &mut budget)
}

/// 通用移动入口：语义与复制一致；目录不能移入自身子树。
pub fn move_paths(
    paths: &[String],
    target_dir: &Path,
    conflict: Conflict,
    protected: &[PathBuf],
) -> AppResult<FsOpReport> {
    if paths.len() > MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            MAX_OP_PATHS
        )));
    }
    ensure_not_protected(target_dir, protected)?;
    let dir = validate_dir(target_dir)?;
    let mut report = FsOpReport::empty();
    let mut sources: Vec<PathBuf> = paths
        .iter()
        .map(|p| validate_abs_path(p))
        .collect::<AppResult<Vec<_>>>()?;
    sources.sort_by_key(|p| p.components().count());
    let mut moved_roots: Vec<PathBuf> = Vec::new();
    let mut budget = MAX_RECURSE_ITEMS;
    for src in &sources {
        ensure_not_protected(src, protected)?;
        if moved_roots
            .iter()
            .any(|root| contains_path(root, src) || same_path(root, src))
        {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("父目录已在本批次中移动".into()),
            });
            continue;
        }
        if !src.exists() {
            report.push(fail_report(src, "源不存在或已被移动".into()));
            continue;
        }
        if contains_path(src, &dir) {
            report.push(fail_report(
                src,
                "不能把目录移动到其自身内部".into(),
            ));
            continue;
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| AppError::Validation("源路径缺少文件名".into()))?;
        let meta = fs::symlink_metadata(src).map_err(|e| AppError::Io(e))?;
        if meta.file_type().is_symlink() {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("符号链接不移动".into()),
            });
            continue;
        }
        if same_path(src.parent().unwrap_or(Path::new("")), &dir) {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("源与目标目录相同".into()),
            });
            continue;
        }
        let dst = if conflict == Conflict::Rename && dir.join(&name).exists() {
            unique_target(&dir, &name)
        } else {
            dir.join(&name)
        };
        match move_one(src, &dst, conflict, 0, &mut budget) {
            Ok(target) => {
                moved_roots.push(src.clone());
                report.push(FsEntryReport {
                    source: src.to_string_lossy().into_owned(),
                    target: Some(target.to_string_lossy().into_owned()),
                    status: "ok",
                    reason: None,
                });
            }
            Err(reason) => report.push(fail_report(src, reason)),
        }
    }
    Ok(report)
}

// ── 删除 ────────────────────────────────────────────────────────────────

/// 回收站删除（SHFileOperationW，FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT）。
/// 逐条调用以便逐条报告；失败回退 std 删除失败并如实报错（绝不伪造成功）。
#[cfg(windows)]
fn recycle_delete(path: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHFileOperationW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, SHFILEOPSTRUCTW};

    let abs = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // canonicalize 在 Windows 返回 `\\?\` verbatim 前缀；SHFileOperationW 不认这种
    // 形式（返回 124 DE_INVALIDFILES），必须还原为普通绝对路径（UNC 同理）。
    let display = {
        let raw = abs.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            raw.into_owned()
        }
    };
    let mut from: Vec<u16> = display
        .encode_utf16()
        .chain(std::iter::once(0))
        .chain(std::iter::once(0))
        .collect();
    let mut op = SHFILEOPSTRUCTW {
        hwnd: Default::default(),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_mut_ptr()),
        pTo: PCWSTR::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT).0 as u16,
        fAnyOperationsAborted: windows::core::BOOL(0),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: PCWSTR::null(),
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code == 0 && !op.fAnyOperationsAborted.as_bool() {
        Ok(())
    } else if op.fAnyOperationsAborted.as_bool() {
        Err("操作被系统中止".into())
    } else {
        Err(format!("回收站删除失败（错误码 {code}）"))
    }
}

#[cfg(not(windows))]
fn recycle_delete(_path: &Path) -> Result<(), String> {
    Err("当前平台不支持回收站删除".into())
}

/// 删除入口：`permanent=false` 走回收站，`permanent=true` 有界递归永久删除。
pub fn delete_paths(
    paths: &[String],
    permanent: bool,
    protected: &[PathBuf],
) -> AppResult<FsOpReport> {
    if paths.len() > MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            MAX_OP_PATHS
        )));
    }
    let mut report = FsOpReport::empty();
    for raw in paths {
        let src = validate_abs_path(raw)?;
        ensure_not_protected(&src, protected)?;
        if !src.exists() {
            report.push(fail_report(&src, "路径不存在".into()));
            continue;
        }
        // 盘符根目录绝不删除（C:\ 这种）：路径分量 ≤1 直接拒绝。
        if src.components().count() <= 1 {
            report.push(fail_report(&src, "不允许删除盘符根目录".into()));
            continue;
        }
        let meta = fs::symlink_metadata(&src).map_err(|e| AppError::Io(e))?;
        let is_dir = meta.is_dir();
        let outcome = if permanent {
            if is_dir {
                delete_tree(&src)
            } else {
                fs::remove_file(&src).map_err(|e| format!("{e}"))
            }
        } else {
            recycle_delete(&src)
        };
        match outcome {
            Ok(()) => report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "ok",
                reason: None,
            }),
            Err(reason) => report.push(fail_report(&src, reason)),
        }
    }
    Ok(report)
}

// ── 创建 / 重命名 / 属性 ────────────────────────────────────────────────

/// 新建目录：父目录必须存在；重名失败（不静默改名）。
pub fn create_dir(parent: &Path, name: &str) -> AppResult<PathBuf> {
    let dir = validate_dir(parent)?;
    let name = sanitize_name(name)?;
    let target = dir.join(&name);
    if target.exists() {
        return Err(AppError::Conflict(format!("已存在同名条目: {name}")));
    }
    fs::create_dir(&target).map_err(|e| AppError::Io(e))?;
    Ok(target)
}

/// 新建空文件：父目录必须存在；重名失败。
pub fn create_file(parent: &Path, name: &str) -> AppResult<PathBuf> {
    let dir = validate_dir(parent)?;
    let name = sanitize_name(name)?;
    let target = dir.join(&name);
    if target.exists() {
        return Err(AppError::Conflict(format!("已存在同名条目: {name}")));
    }
    fs::File::create(&target).map_err(|e| AppError::Io(e))?;
    Ok(target)
}

/// 重命名：只改名称分量（不允许跨目录移动）；重名失败。
pub fn rename(path: &Path, new_name: &str) -> AppResult<PathBuf> {
    if !path.exists() {
        return Err(AppError::NotFound("路径不存在或已被移动".into()));
    }
    let name = sanitize_name(new_name)?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Validation("路径没有父目录".into()))?;
    let target = parent.join(&name);
    if target.exists() {
        return Err(AppError::Conflict(format!("已存在同名条目: {name}")));
    }
    fs::rename(path, &target).map_err(|e| AppError::Io(e))?;
    Ok(target)
}

/// 条目属性（查看用；目录子项计数有上限，超出标 truncated）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub path: String,
    pub exists: bool,
    pub kind: &'static str,
    pub size: Option<u64>,
    pub created_ms: Option<i64>,
    pub modified_ms: Option<i64>,
    pub readonly: bool,
    pub hidden: bool,
    pub child_count: Option<u64>,
    pub child_truncated: bool,
}

pub fn stat_path(raw: &str) -> FsStat {
    let path = match validate_abs_path(raw) {
        Ok(p) => p,
        Err(_) => {
            return FsStat {
                path: raw.to_string(),
                exists: false,
                kind: "missing",
                size: None,
                created_ms: None,
                modified_ms: None,
                readonly: false,
                hidden: false,
                child_count: None,
                child_truncated: false,
            }
        }
    };
    let meta = fs::symlink_metadata(&path);
    let Ok(meta) = meta else {
        return FsStat {
            path: raw.to_string(),
            exists: false,
            kind: "missing",
            size: None,
            created_ms: None,
            modified_ms: None,
            readonly: false,
            hidden: false,
            child_count: None,
            child_truncated: false,
        };
    };
    let attrs = meta.file_attributes();
    let readonly = attrs & 0x1 != 0;
    let hidden = attrs & FILE_ATTRIBUTE_HIDDEN != 0;
    let is_dir = meta.is_dir();
    let (child_count, child_truncated) = if is_dir {
        let mut n: u64 = 0;
        let mut truncated = false;
        if let Ok(read) = fs::read_dir(&path) {
            for item in read {
                n += 1;
                if n >= 20_000 {
                    truncated = true;
                    break;
                }
            }
        }
        (Some(n), truncated)
    } else {
        (None, false)
    };
    FsStat {
        path: path.to_string_lossy().into_owned(),
        exists: true,
        kind: if is_dir {
            "dir"
        } else if meta.file_type().is_symlink() {
            "link"
        } else {
            "file"
        },
        size: (!is_dir).then_some(meta.len()),
        created_ms: meta.created().ok().map(|t| unix_ms(t)),
        modified_ms: meta.modified().ok().map(|t| unix_ms(t)),
        readonly,
        hidden,
        child_count,
        child_truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::OnceLock;

    /// 每个测试独占的临时根目录（编号递增，进程退出由系统清理）。
    fn temp_root(tag: &str) -> PathBuf {
        static SEQ: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
        let seq = SEQ.get_or_init(|| Mutex::new(HashMap::new()));
        let mut guard = seq.lock().unwrap();
        let counter = guard.entry(tag.to_string()).or_insert(0);
        *counter += 1;
        let dir = std::env::temp_dir().join(format!(
            "taskdock-fw-test-{}-{}-{}",
            tag,
            std::process::id(),
            *counter
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn protected() -> Vec<PathBuf> {
        vec![std::env::temp_dir().join("taskdock-fw-protected")]
    }

    // ── 名称清洗 ────────────────────────────────────────────────────────

    #[test]
    fn sanitize_rejects_traversal_and_reserved() {
        assert!(sanitize_name("..").is_err());
        assert!(sanitize_name(".").is_err());
        assert!(sanitize_name("a/b").is_err());
        assert!(sanitize_name("a\\b").is_err());
        assert!(sanitize_name("a:b").is_err());
        assert!(sanitize_name("").is_err());
        assert!(sanitize_name("name.").is_err());
        assert!(sanitize_name("name ").is_err());
        assert!(sanitize_name("CON").is_err());
        // 保留名检查看主名（首段）：nul.txt 同样被拒。
        assert!(sanitize_name("nul.txt").is_err());
    }

    #[test]
    fn sanitize_allows_common_names() {
        assert_eq!(sanitize_name("  设计文档.md  ").unwrap(), "设计文档.md");
        assert_eq!(sanitize_name("MyGame.exe").unwrap(), "MyGame.exe");
    }

    // ── 列目录 ─────────────────────────────────────────────────────────

    #[test]
    fn list_dir_reports_entries_and_hidden_filter() {
        let root = temp_root("list");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.png"), [1, 2, 3]).unwrap();
        fs::write(root.join("b.txt"), "hi").unwrap();
        let listing = list_dir(&root, true).unwrap();
        assert_eq!(listing.truncated, false);
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"sub"));
        assert!(names.contains(&"a.png"));
        assert!(names.contains(&"b.txt"));
        let png = listing.entries.iter().find(|e| e.name == "a.png").unwrap();
        assert_eq!(png.category, "image");
        assert_eq!(png.size, Some(3));
        let sub = listing.entries.iter().find(|e| e.name == "sub").unwrap();
        assert_eq!(sub.kind, "dir");
        assert_eq!(sub.category, "folder");
        let txt = listing.entries.iter().find(|e| e.name == "b.txt").unwrap();
        assert_eq!(txt.category, "text");
        // 隐藏过滤：无隐藏属性时 show_hidden=false 不改变结果。
        let listing2 = list_dir(&root, false).unwrap();
        assert_eq!(listing2.entries.len(), listing.entries.len());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_dir_missing_fails_not_found() {
        let root = temp_root("missing");
        let result = list_dir(&root.join("nope"), false);
        assert!(matches!(result, Err(AppError::NotFound(_))));
        fs::remove_dir_all(&root).unwrap();
    }

    // ── 复制 ───────────────────────────────────────────────────────────

    #[test]
    fn copy_files_with_skip_and_rename_conflict() {
        let root = temp_root("copy");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("f.txt"), "v1").unwrap();
        fs::write(dst_dir.join("f.txt"), "old").unwrap();

        // skip：目标已存在 → 跳过，内容不变。
        let report = copy_paths(
            &[src_dir.join("f.txt").to_string_lossy().into_owned()],
            &dst_dir,
            Conflict::Skip,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.skipped, 1);
        assert_eq!(fs::read_to_string(dst_dir.join("f.txt")).unwrap(), "old");

        // rename：目标已存在 → f (2).txt，两者保留。
        let report = copy_paths(
            &[src_dir.join("f.txt").to_string_lossy().into_owned()],
            &dst_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.ok, 1);
        assert_eq!(
            fs::read_to_string(dst_dir.join("f (2).txt")).unwrap(),
            "v1"
        );
        assert_eq!(fs::read_to_string(dst_dir.join("f.txt")).unwrap(), "old");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copy_dir_recursively_and_parent_dedup() {
        let root = temp_root("copydir");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(src_dir.join("nested/deep")).unwrap();
        fs::write(src_dir.join("nested/deep/leaf.txt"), "leaf").unwrap();
        fs::write(src_dir.join("top.txt"), "top").unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        let report = copy_paths(
            &[
                src_dir.join("nested/deep/leaf.txt").to_string_lossy().into_owned(),
                src_dir.join("nested").to_string_lossy().into_owned(),
            ],
            &dst_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        // 父目录 nested 先处理；leaf 是其子项 → skipped 随父。
        assert_eq!(report.ok, 1);
        assert_eq!(report.skipped, 1);
        assert!(dst_dir.join("nested/deep/leaf.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copy_rejects_dir_into_itself() {
        let root = temp_root("selfcopy");
        let src_dir = root.join("src");
        fs::create_dir_all(src_dir.join("inner")).unwrap();
        let report = copy_paths(
            &[src_dir.to_string_lossy().into_owned()],
            &src_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.failed, 1);
        assert!(report.entries[0].reason.as_deref().unwrap().contains("自身内部"));
        fs::remove_dir_all(&root).unwrap();
    }

    // ── 移动 ───────────────────────────────────────────────────────────

    #[test]
    fn move_file_updates_source_and_target() {
        let root = temp_root("move");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("m.txt"), "data").unwrap();
        let report = move_paths(
            &[src_dir.join("m.txt").to_string_lossy().into_owned()],
            &dst_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.ok, 1);
        assert!(!src_dir.join("m.txt").exists());
        assert_eq!(fs::read_to_string(dst_dir.join("m.txt")).unwrap(), "data");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn move_same_dir_is_skipped() {
        let root = temp_root("samedir");
        let src_dir = root.join("src");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(src_dir.join("x.txt"), "x").unwrap();
        let report = move_paths(
            &[src_dir.join("x.txt").to_string_lossy().into_owned()],
            &src_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.skipped, 1);
        assert!(src_dir.join("x.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    // ── 删除 ───────────────────────────────────────────────────────────

    #[test]
    fn permanent_delete_removes_file_and_dir() {
        let root = temp_root("del");
        fs::write(root.join("gone.txt"), "x").unwrap();
        fs::create_dir_all(root.join("tree/deep")).unwrap();
        fs::write(root.join("tree/deep/f.bin"), [0u8; 16]).unwrap();
        let report = delete_paths(
            &[
                root.join("gone.txt").to_string_lossy().into_owned(),
                root.join("tree").to_string_lossy().into_owned(),
            ],
            true,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.ok, 2);
        assert!(!root.join("gone.txt").exists());
        assert!(!root.join("tree").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn delete_refuses_drive_root_and_missing() {
        let root = temp_root("delroot");
        let report = delete_paths(&["C:\\".to_string()], true, &protected()).unwrap();
        assert_eq!(report.failed, 1);
        let report = delete_paths(
            &[root.join("not-there").to_string_lossy().into_owned()],
            true,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.failed, 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn delete_refuses_protected_dir() {
        let prot = std::env::temp_dir().join("taskdock-fw-protected");
        fs::create_dir_all(&prot).unwrap();
        fs::write(prot.join("x.txt"), "x").unwrap();
        let result = delete_paths(
            &[prot.join("x.txt").to_string_lossy().into_owned()],
            true,
            &protected(),
        );
        // 整批因保护校验失败：ensure_not_protected 直接报 Validation。
        assert!(matches!(result, Err(AppError::Validation(_))));
        let _ = fs::remove_dir_all(&prot);
    }

    // ── 创建 / 重命名 ──────────────────────────────────────────────────

    #[test]
    fn create_dir_and_file_no_silent_overwrite() {
        let root = temp_root("create");
        fs::create_dir(root.join("newdir")).unwrap();
        let made = create_dir(&root, "newdir");
        assert!(matches!(made, Err(AppError::Conflict(_))));
        fs::write(root.join("exists.txt"), "").unwrap();
        assert!(create_file(&root, "exists.txt").is_err());
        let created = create_file(&root, "新建.md").unwrap();
        assert!(created.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rename_rejects_cross_dir_and_conflict() {
        let root = temp_root("rename");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/old.txt"), "").unwrap();
        fs::write(root.join("a/new.txt"), "").unwrap();
        // 重名冲突
        assert!(rename(&root.join("a/old.txt"), "new.txt").is_err());
        // 跨目录名称（含分隔符）拒绝
        assert!(rename(&root.join("a/old.txt"), "..\\old.txt").is_err());
        let renamed = rename(&root.join("a/old.txt"), "renamed.txt").unwrap();
        assert!(renamed.exists());
        assert!(!root.join("a/old.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    // ── 属性 / 签名 / 类别 ─────────────────────────────────────────────

    #[test]
    fn stat_reports_kind_and_children() {
        let root = temp_root("stat");
        fs::create_dir_all(root.join("d")).unwrap();
        fs::write(root.join("d/f.txt"), "abc").unwrap();
        let stat = stat_path(&root.join("d").to_string_lossy());
        assert_eq!(stat.exists, true);
        assert_eq!(stat.kind, "dir");
        assert_eq!(stat.child_count, Some(1));
        let stat = stat_path(&root.join("missing").to_string_lossy());
        assert_eq!(stat.exists, false);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn dir_signature_tracks_existence() {
        let root = temp_root("sig");
        let sig = dir_signature(&root);
        assert!(sig.exists && sig.is_dir);
        let sig = dir_signature(&root.join("nope"));
        assert!(!sig.exists);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn category_mapping_aligns_tones() {
        assert_eq!(category_of(true, false, ""), "folder");
        assert_eq!(category_of(false, true, ""), "link");
        assert_eq!(category_of(false, false, "png"), "image");
        assert_eq!(category_of(false, false, "mp4"), "video");
        assert_eq!(category_of(false, false, "zip"), "archive");
        assert_eq!(category_of(false, false, "rs"), "code");
        assert_eq!(category_of(false, false, "xlsx"), "sheet");
        assert_eq!(category_of(false, false, "exe"), "program");
        assert_eq!(category_of(false, false, "md"), "text");
        assert_eq!(category_of(false, false, "xyz"), "other");
    }
}
