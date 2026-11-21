//! 文件工作区核心层：通用目录浏览与文件操作（多目录文件工作区，2026-11-14）。
//!
//! 语义约定：
//! - 只接受**绝对路径**；所有操作 fail-closed：名称经 `sanitize_name` 清洗，
//!   目标目录先校验存在且为目录，冲突策略显式给定，绝不静默覆盖；
//! - 删除默认走回收站（SHFileOperationW FOF_ALLOWUNDO）；永久删除单独命令语义
//!   （`permanent=true`），并有深度上限与重解析点（符号链接/junction）不跟随保护；
//! - 回收站删除整批只调 **一次** `SHFileOperationW`，但它只有整批返回码与整批
//!   中止标志、没有逐项回调：逐项证明需要 `IFileOperation` + 进度 sink（本轮不
//!   重写）。因此「读不到源状态」「整批报错但源已消失」一律标记
//!   `FS_OP_UNVERIFIED`（未确认），绝不伪造成功。详见「删除」节的评估结论。
//! - 目录复制/移动递归受深度上限与重解析点保护，不做无界递归；
//! - 受保护目录（应用数据目录）拒绝作为删除/移动/复制的目标或源；
//! - 报告逐条给出结果（ok/failed/skipped + 原因），部分成功如实返回，不伪造全成功。
//!
//! 本模块不依赖 Tauri/前端类型，纯 std + windows，便于单测（临时目录）。

pub mod duplicates;
pub mod identity;
pub mod preview;
pub mod stage;
pub mod thumbnail;
pub mod volume;
pub mod watch;

use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 单次列目录分页大小：超出返回 has_more 标记（前端按 `nextOffset` 续拉，
/// 万级目录不再只能看到前 8000 项）。单页最多返回的可见条目数。
pub const MAX_LIST_ENTRIES: usize = 8000;
/// 单页最多**扫描**的磁盘条目数（含被隐藏过滤/元数据失败的项）。
///
/// 没有这个上限时，`show_hidden=false` 遇到「大量隐藏项 + 少量可见项」的目录会
/// 在一次 IPC 里遍历整个目录（10 万级条目时长时间占住调用线程）。
/// 达到上限即返回 `has_more`，由前端按 `nextOffset` 继续分页。
pub const MAX_SCAN_PER_PAGE: usize = 16_000;
/// 分页 offset 上限：超过它说明调用方在无意义地遍历超大目录，直接钳制。
pub const MAX_LIST_OFFSET: usize = 5_000_000;
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
const FILE_ATTRIBUTE_READONLY: u32 = 0x1;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;
const FILE_ATTRIBUTE_TEMPORARY: u32 = 0x100;
const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x200;
const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x800;
const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
const FILE_ATTRIBUTE_ENCRYPTED: u32 = 0x4000;

/// 把 Windows 属性位转成稳定的小写代码；前端负责本地化展示。
/// `normal` 只在没有任何其他位时出现，避免「普通文件 + 只读」同时显示 normal。
fn attribute_names(attrs: u32) -> Vec<&'static str> {
    let mut names = Vec::new();
    if attrs & FILE_ATTRIBUTE_READONLY != 0 {
        names.push("readonly");
    }
    if attrs & FILE_ATTRIBUTE_HIDDEN != 0 {
        names.push("hidden");
    }
    if attrs & FILE_ATTRIBUTE_SYSTEM != 0 {
        names.push("system");
    }
    if attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
        names.push("directory");
    }
    if attrs & FILE_ATTRIBUTE_ARCHIVE != 0 {
        names.push("archive");
    }
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        names.push("reparse");
    }
    if attrs & FILE_ATTRIBUTE_COMPRESSED != 0 {
        names.push("compressed");
    }
    if attrs & FILE_ATTRIBUTE_ENCRYPTED != 0 {
        names.push("encrypted");
    }
    if attrs & FILE_ATTRIBUTE_OFFLINE != 0 {
        names.push("offline");
    }
    if attrs & FILE_ATTRIBUTE_SPARSE_FILE != 0 {
        names.push("sparse");
    }
    if attrs & FILE_ATTRIBUTE_TEMPORARY != 0 {
        names.push("temporary");
    }
    if names.is_empty() {
        // FILE_ATTRIBUTE_NORMAL(0x80) 只有在单独设置时才有意义；按结果兜底。
        names.push("normal");
    }
    names
}

/// SystemTime → Unix 毫秒（chrono 转换；失败返回 None 的分支由调用方 map 处理）。
fn unix_ms(t: std::time::SystemTime) -> i64 {
    chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis()
}

// ── 路径与名称校验 ───────────────────────────────────────────────────────

/// Windows 路径词法规范化（不访问文件系统，比较与操作共用同一形态）：
/// - 拒绝设备路径 `\\.\`（文件管理器语义下无意义且危险）；
/// - 剥离 `\\?\` / `\\?\UNC\` verbatim 前缀（canonicalize 的产物还原为普通路径）；
/// - `/` 统一为 `\`、合并重复分隔符、去掉尾部 `\`（根除外）；
/// - 词法解析 `.` 与 `..`（越出根时停在根，不产生 ".." 分量）；
/// - 盘符统一大写；UNC 保持 `\\server\share\...` 结构（server/share 两段是基底）。
pub fn normalize_lexical(raw: &Path) -> PathBuf {
    let s = raw.to_string_lossy().trim().to_string();
    if s.is_empty() {
        return PathBuf::new();
    }
    // 前缀分类：verbatim UNC / verbatim 盘符 / 普通 UNC / 盘符。
    let (is_unc, body): (bool, String) = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        (true, rest.to_string())
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        if rest.starts_with(r"\\") {
            (true, rest[2..].to_string())
        } else {
            (false, rest.to_string())
        }
    } else if let Some(rest) = s.strip_prefix(r"\\.\") {
        // 设备路径：保留原样返回（validate_abs_path 拒绝；这里不拼装）。
        return PathBuf::from(format!(r"\\.\{rest}"));
    } else if let Some(rest) = s.strip_prefix(r"\\") {
        (true, rest.to_string())
    } else {
        (false, s.clone())
    };
    let normalized_body = body.replace('/', "\\");
    let parts: Vec<&str> = normalized_body.split('\\').collect();
    if is_unc {
        // UNC：server 与 share 是根基底，`..` 不可越过。
        let mut base: Vec<String> = parts.iter().take(2).map(|p| (*p).to_string()).collect();
        let mut stack: Vec<String> = Vec::new();
        for part in parts.iter().skip(2) {
            match *part {
                "" | "." => {}
                ".." => {
                    stack.pop();
                }
                other => stack.push(other.to_string()),
            }
        }
        let mut out = String::from(r"\\");
        out.push_str(&base.remove(0));
        if let Some(share) = base.pop() {
            out.push('\\');
            out.push_str(&share);
            for seg in &stack {
                out.push('\\');
                out.push_str(seg);
            }
        }
        return PathBuf::from(out);
    }
    // 盘符路径：第一段若是 `C:` 形态则作为基底（`..` 不可越过盘符根）。
    let drive_base: Option<String> = parts.first().and_then(|p| {
        let b = p.as_bytes();
        if b.len() == 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            Some(p.to_ascii_uppercase())
        } else {
            None
        }
    });
    let mut stack: Vec<String> = Vec::new();
    for part in parts.iter().skip(if drive_base.is_some() { 1 } else { 0 }) {
        match *part {
            "" | "." => {}
            ".." => {
                stack.pop(); // 空栈时停：`..` 越出根只停在根，不产生 ".." 分量
            }
            other => stack.push(other.to_string()),
        }
    }
    match drive_base {
        Some(drive) => {
            if stack.is_empty() {
                PathBuf::from(format!("{drive}\\"))
            } else {
                PathBuf::from(format!("{drive}\\{}", stack.join("\\")))
            }
        }
        None if stack.is_empty() => PathBuf::new(),
        None => PathBuf::from(stack.join("\\")),
    }
}

/// 绝对路径校验 + 词法规范化：所有文件操作与比较统一使用规范化结果，
/// 使 `C:\a\..\protected` 这类穿越写法在比较与操作前就被解析为真实形态。
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
    if trimmed.starts_with(r"\\.\") || trimmed.starts_with(r"\\??\") {
        return Err(AppError::Validation("不支持设备路径".into()));
    }
    let p = normalize_lexical(Path::new(trimmed));
    if !p.is_absolute() {
        return Err(AppError::Validation("必须是绝对路径".into()));
    }
    Ok(p)
}

/// 是否为「根」（盘符根 / UNC share 根）：这类路径绝不允许删除。
fn is_root_path(path: &Path) -> bool {
    let n = normalize_lexical(path);
    if n.as_os_str().is_empty() {
        return true;
    }
    match n.parent() {
        None => true,
        Some(par) => par == n,
    }
}

/// 比较键：词法规范化 + 小写 + 统一去尾分隔符（根 "C:\" → "c:"）。
/// 边界安全：`C:\AppData` 与 `C:\AppDataBackup` 的键互不为前缀（比较带 `\` 边界）。
fn path_key(path: &Path) -> String {
    let mut s = normalize_lexical(path).to_string_lossy().to_ascii_lowercase();
    while s.len() > 1 && s.ends_with('\\') {
        s.pop();
    }
    // 根 "c:" 与 UNC "\\\\srv\\share" 保持无尾分隔符形态。
    s
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

/// 路径是否位于 root 之内（含相等）。词法规范化 + 分量边界比较：
/// `C:\AppData` 与 `C:\AppDataBackup` 互不匹配；`/`、`..`、大小写、重复分隔符先归一。
fn is_under(path: &Path, root: &Path) -> bool {
    let inner = path_key(path);
    let outer = path_key(root);
    inner == outer || inner.starts_with(&format!("{outer}\\"))
}

/// 解析真实路径（junction/symlink 防绕过）：对已存在的最深祖先 canonicalize
/// （重解析点在此被解析为真实目标），不存在的尾部保持词法形式拼接。
/// 结果可能带 `\\?\` 前缀——比较统一走 path_key（会剥离）。
fn real_path(path: &Path) -> PathBuf {
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }
    let mut cur = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match cur.parent() {
            Some(par) if par != cur => {
                if let Some(name) = cur.file_name() {
                    tail.push(name.to_os_string());
                }
                cur = par.to_path_buf();
            }
            _ => break,
        }
    }
    let mut real = fs::canonicalize(&cur).unwrap_or(cur);
    for part in tail.into_iter().rev() {
        real.push(part);
    }
    real
}

/// 确认路径不在任何受保护目录内（删除/移动目标、复制目标等写入侧调用）。
/// 两道检查：①词法路径（规范化 + 边界）；②真实路径（junction/symlink 指进
/// 保护目录的绕过写法）。TOCTOU 说明：预检查无法完全消除「检查后目录被换成
/// junction」的窗口；递归层对重解析点不跟随、深度/总量有界构成第二道防线，
/// 完全消除需 open-by-handle +FILE_FLAG_OPEN_REPARSE_POINT（后续工作）。
pub fn ensure_not_protected(path: &Path, protected: &[PathBuf]) -> AppResult<()> {
    for root in protected {
        if is_under(path, root) {
            return Err(AppError::Validation(format!(
                "不允许操作 TaskDock 数据目录内部: {}",
                path.display()
            )));
        }
    }
    let real = real_path(path);
    for root in protected {
        // 受保护根本身也可能经链接/短路径给出：同样取真实路径再比较。
        if is_under(&real, &real_path(root)) {
            return Err(AppError::Validation(format!(
                "路径经链接指向受保护目录，拒绝操作: {}",
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
    /// 本轮结束时从目录开头累计的已消费磁盘位置（磁盘原始序，含隐藏过滤项与
    /// 元数据失败项）；恒 `>= offset`（offset 超界时等于目录条目总数且
    /// `has_more=false`）。翻页不要用本字段自行累加，见 `next_offset`。
    pub scanned: usize,
    /// 下一页的**绝对偏移**，显式等于 `scanned`；前端翻页一律用本字段，
    /// 禁止再 `offset + scanned` 自行累加。`has_more=true` 时必 `> offset`。
    pub next_offset: usize,
    /// 目录里还有更多未返回的条目：仅因返回条数上限或扫描预算停止、且目录尚有
    /// 未读条目时为 true；遍历到末尾必为 false。
    pub has_more: bool,
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

/// 列目录：逐项容错（单项元数据失败跳过，不整体失败）。
///
/// 分页契约（前端一律按 `nextOffset` 翻页，禁止 `offset + scanned` 自行累加）：
/// 1. `offset` 为**绝对磁盘序偏移**，指向本页第一个候选条目（read_dir 原始序，
///    含隐藏项与元数据失败项）；
/// 2. `scanned` 为本轮结束时从目录开头累计的已消费位置，恒 `>= offset`
///    （offset 超界时等于目录条目总数且 `has_more=false`）；
/// 3. `next_offset` 显式等于 `scanned`；`has_more=true` 时保证 `next_offset > offset`；
/// 4. `has_more` 仅表示「因返回条数上限或扫描预算停止、且目录尚有未读条目」，
///    遍历到末尾必为 false；
/// 5. 隐藏项与元数据失败项都消耗偏移（不阻塞翻页）。
pub fn list_dir(path: &Path, show_hidden: bool, offset: usize) -> AppResult<DirListing> {
    list_dir_with_limits(path, show_hidden, offset, MAX_LIST_ENTRIES, MAX_SCAN_PER_PAGE)
}

/// 内部可注入上限版本：公开 IPC 契约不变；仅测试用更小的页/扫描预算真实跨多页
/// 遍历边界，避免为 7999/8000/…/32000 量级用例真造数万文件。
fn list_dir_with_limits(
    path: &Path,
    show_hidden: bool,
    offset: usize,
    max_entries: usize,
    max_scan: usize,
) -> AppResult<DirListing> {
    let dir = validate_dir(path)?;
    let read = fs::read_dir(&dir).map_err(|e| {
        AppError::Validation(format!("读取目录失败: {}（{e}）", dir.display()))
    })?;
    Ok(list_entries(read, &dir, show_hidden, offset, max_entries, max_scan))
}

/// 核心列举逻辑：迭代器可注入（测试可混入读取失败项）；`dir` 仅用于回填路径字段。
fn list_entries(
    read: impl Iterator<Item = std::io::Result<fs::DirEntry>>,
    dir: &Path,
    show_hidden: bool,
    offset: usize,
    max_entries: usize,
    max_scan: usize,
) -> DirListing {
    let mut entries: Vec<FsEntry> = Vec::new();
    let mut scanned: usize = 0;
    let mut has_more = false;
    let scan_budget = offset.saturating_add(max_scan);
    for item in read {
        // 扫描预算：先判上限再消费；本条未消费，scanned 保持已消费位置。
        if scanned >= scan_budget {
            has_more = true;
            break;
        }
        scanned += 1;
        if scanned <= offset {
            continue;
        }
        // 返回条数上限：本条未消费，scanned 回退一条，下一页从它开始。
        if entries.len() >= max_entries {
            has_more = true;
            scanned -= 1;
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
    DirListing {
        path: dir.to_string_lossy().into_owned(),
        entries,
        scanned,
        next_offset: scanned,
        has_more,
    }
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

/// 为「工作篮 → 文件目标」解析单个写入目标：
/// 校验目录存在、清洗单段名称、按冲突策略给出最终路径。
///
/// 返回 `None` 表示 `skip` 策略下目标已存在，调用方应把该条如实标记为 skipped。
/// 覆盖目录会被拒绝（不能用文件覆盖目录）。
pub fn resolve_write_target(
    dir: &Path,
    name: &str,
    conflict: Conflict,
) -> AppResult<Option<PathBuf>> {
    let dir = validate_dir(dir)?;
    let name = sanitize_name(name)?;
    let target = dir.join(&name);
    if !target.exists() {
        return Ok(Some(target));
    }
    match conflict {
        Conflict::Skip => Ok(None),
        Conflict::Rename => Ok(Some(unique_target(&dir, &name))),
        Conflict::Overwrite => {
            if target.is_dir() {
                return Err(AppError::Validation(
                    "目标已存在且是目录，不能用文件覆盖".into(),
                ));
            }
            Ok(Some(target))
        }
    }
}

/// 路径是否在 `root` 之内（公开只读版本，供跨模块做目标归属判断）。
pub fn path_is_under(path: &Path, root: &Path) -> bool {
    is_under(path, root)
}

// ── 稳定失败分类 ────────────────────────────────────────────────────────
//
// 逐条 `reason` 是给人读的中文 / OS 文案，**不可用于聚合与筛选**。诊断中心需要
// 稳定错误码，因此每个失败在产生点就带上 `FS_OP_*` 码与阶段，前端与 Rust 共用
// 同一套取值（与暂存架 `SHELF_DROP_*` 同构，不新建第二套日志语义）。

/// 源不存在或已被移动。
pub const FS_OP_SOURCE_MISSING: &str = "FS_OP_SOURCE_MISSING";
/// 权限不足（ACL / 只读 / 拒绝访问）。
pub const FS_OP_ACCESS_DENIED: &str = "FS_OP_ACCESS_DENIED";
/// 被其他进程占用（共享冲突 / 锁）。
pub const FS_OP_FILE_BUSY: &str = "FS_OP_FILE_BUSY";
/// 同名冲突且策略不允许覆盖。
pub const FS_OP_CONFLICT: &str = "FS_OP_CONFLICT";
/// 其他 IO 故障（含磁盘满、路径过长、跨卷中断）。
pub const FS_OP_IO: &str = "FS_OP_IO";
/// 校验拒绝（自身内部、路径策略、递归上限）。
pub const FS_OP_VALIDATION: &str = "FS_OP_VALIDATION";
/// 当前平台 / 不支持的操作。
pub const FS_OP_UNSUPPORTED: &str = "FS_OP_UNSUPPORTED";
/// 用户或系统中止（回收站取消），不是内部故障。
pub const FS_OP_CANCELLED: &str = "FS_OP_CANCELLED";
/// 无法确认回收站操作是否生效（源路径状态不可读 / Shell 整批返回错误但源已消失）。
///
/// 这是「既不能证明成功、也不能断言失败」的第三态：`SHFileOperationW` 只有整批
/// 返回码与整批中止标志，没有逐项回调，因此这些条目的真实归属不可证明。
/// 宁可显式标为未确认，也不伪造成功（旧实现把所有读取错误当成功，属 P1 缺陷）。
pub const FS_OP_UNVERIFIED: &str = "FS_OP_UNVERIFIED";
/// 未分类。
pub const FS_OP_UNKNOWN: &str = "FS_OP_UNKNOWN";
/// 多种错误码并存时汇总使用。
pub const FS_OP_MULTI_FAILURE: &str = "FS_OP_MULTI_FAILURE";

/// 稳定错误码 → 诊断分类（取值与 `error::ErrorCategory` 的字符串一致）。
pub fn fs_op_category(code: &str) -> &'static str {
    match code {
        FS_OP_SOURCE_MISSING => "not_found",
        FS_OP_ACCESS_DENIED => "permission",
        FS_OP_FILE_BUSY | FS_OP_IO => "io",
        FS_OP_CONFLICT => "conflict",
        FS_OP_VALIDATION => "validation",
        FS_OP_UNSUPPORTED => "unsupported",
        FS_OP_CANCELLED => "cancelled",
        // 未确认不是「已确认的 IO 故障」：归到 io 会把它与磁盘错误、占用混在
        // 一起统计，掩盖「结果不可证明」这一独立性质；归到 unknown 更诚实。
        FS_OP_UNVERIFIED => "unknown",
        _ => "unknown",
    }
}

/// 由 `std::io::Error` 判定稳定错误码。Windows 的 `raw_os_error` 比 `ErrorKind`
/// 更精确：5=拒绝访问、32/33=共享冲突、80/183=已存在。
fn classify_io_error(err: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::NotFound => FS_OP_SOURCE_MISSING,
        ErrorKind::PermissionDenied => FS_OP_ACCESS_DENIED,
        ErrorKind::AlreadyExists => FS_OP_CONFLICT,
        _ => match err.raw_os_error() {
            Some(2) | Some(3) => FS_OP_SOURCE_MISSING,
            Some(5) => FS_OP_ACCESS_DENIED,
            Some(32) | Some(33) => FS_OP_FILE_BUSY,
            Some(80) | Some(183) => FS_OP_CONFLICT,
            _ => FS_OP_IO,
        },
    }
}

/// 内部失败：稳定错误码 + 阶段 + 可读原因。
///
/// `reason` 只用于界面展示；诊断事件只取 `code` / `stage`，**不写原因文本**
/// （其中可能包含完整路径）。
#[derive(Debug, Clone)]
pub struct FsFailure {
    pub code: &'static str,
    /// prepare | transfer | recycle | cleanup
    pub stage: &'static str,
    pub reason: String,
    /// 源已部分处理（如目录已并入目标但删除源失败）：逐条状态记为 partial。
    pub partial: bool,
}

impl FsFailure {
    fn new(code: &'static str, stage: &'static str, reason: impl Into<String>) -> Self {
        Self {
            code,
            stage,
            reason: reason.into(),
            partial: false,
        }
    }

    /// 由 IO 错误构造（原因保留 OS 文案，便于用户判断）。
    fn io(stage: &'static str, err: &std::io::Error) -> Self {
        Self::new(classify_io_error(err), stage, err.to_string())
    }

    /// 由 IO 错误构造并加中文前缀（界面文案与旧实现保持一致）。
    fn io_ctx(stage: &'static str, what: &str, err: &std::io::Error) -> Self {
        Self::new(classify_io_error(err), stage, format!("{what}: {err}"))
    }

    fn mark_partial(mut self) -> Self {
        self.partial = true;
        self
    }
}

/// 单条操作结果（复制/移动/删除共用）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEntryReport {
    pub source: String,
    pub target: Option<String>,
    /// ok | failed | skipped | partial
    pub status: &'static str,
    pub reason: Option<String>,
    /// 稳定失败分类（诊断聚合用；界面仍展示 `reason`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// 失败阶段：prepare / transfer / recycle / cleanup。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsOpReport {
    /// 与前端共享的操作 ID（诊断按此关联；前端未传时后端生成）。
    pub operation_id: String,
    pub attempted: usize,
    pub ok: usize,
    pub failed: usize,
    pub skipped: usize,
    /// 「部分完成」条数（内容已落地但源未删除等）。
    pub partial: usize,
    pub entries: Vec<FsEntryReport>,
}

impl FsOpReport {
    fn empty() -> Self {
        Self {
            operation_id: crate::diagnostics::new_operation_id(),
            attempted: 0,
            ok: 0,
            failed: 0,
            skipped: 0,
            partial: 0,
            entries: Vec::new(),
        }
    }
    fn with_operation(mut self, operation_id: Option<String>) -> Self {
        if let Some(id) = operation_id.map(|id| id.trim().to_string()) {
            if !id.is_empty() {
                self.operation_id = id;
            }
        }
        self
    }
    fn push(&mut self, report: FsEntryReport) {
        self.attempted += 1;
        match report.status {
            "ok" => self.ok += 1,
            "failed" => self.failed += 1,
            "partial" => self.partial += 1,
            _ => self.skipped += 1,
        }
        self.entries.push(report);
    }
}

/// 逐条失败报告（自由函数：FsEntryReport 是数据结构，不带构造语义）。
fn fail_report(source: &Path, failure: FsFailure) -> FsEntryReport {
    FsEntryReport {
        source: source.to_string_lossy().into_owned(),
        target: None,
        status: if failure.partial { "partial" } else { "failed" },
        reason: Some(failure.reason),
        code: Some(failure.code.to_string()),
        stage: Some(failure.stage.to_string()),
    }
}

/// 临时文件的**可展示名**：只取文件名，绝不带目录。reason 会进 UI 与诊断日志，
/// 完整绝对路径（含 Windows 用户目录）对外既无必要也不安全（D-11）。
fn tmp_display_name(tmp: &Path) -> String {
    tmp.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "临时文件".to_string())
}

fn transfer_cancelled() -> FsFailure {
    FsFailure::new(FS_OP_CANCELLED, "transfer", "文件操作已取消")
}

#[cfg(windows)]
fn copy_file_to_stage(
    src: &Path,
    stage: &Path,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<()> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            CopyFileExW, COPY_FILE_FAIL_IF_EXISTS, PROGRESS_CANCEL, PROGRESS_CONTINUE,
        },
    };

    unsafe extern "system" fn on_progress(
        _: i64,
        _: i64,
        _: i64,
        _: i64,
        _: u32,
        _: u32,
        _: HANDLE,
        _: HANDLE,
        context: *const c_void,
    ) -> u32 {
        // CopyFileExW invokes this synchronously. Never unwind through its callback.
        let cancelled = unsafe { &*context.cast::<&dyn Fn() -> bool>() };
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cancelled())) {
            Ok(false) => PROGRESS_CONTINUE,
            _ => PROGRESS_CANCEL,
        }
    }

    let src = src.canonicalize()?;
    let stage = stage
        .parent()
        .expect("stage has a parent")
        .canonicalize()?
        .join("data");
    let wide = |path: &Path| -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    // The paths and callback context remain valid until CopyFileExW returns.
    let result = unsafe {
        CopyFileExW(
            wide(&src).as_ptr(),
            wide(&stage).as_ptr(),
            Some(on_progress),
            (&cancelled as *const &dyn Fn() -> bool).cast(),
            std::ptr::null_mut(),
            COPY_FILE_FAIL_IF_EXISTS,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn copy_file_to_stage(src: &Path, stage: &Path, _: &dyn Fn() -> bool) -> std::io::Result<()> {
    fs::copy(src, stage).map(|_| ())
}

fn commit_file(src: &Path, dst: &Path, conflict: Conflict) -> std::io::Result<()> {
    if conflict == Conflict::Overwrite {
        fs::rename(src, dst)
    } else {
        crate::shelf::fsops::rename_no_replace(src, dst)
    }
}

/// Stage the copy beside its final destination. Cancel or failed commit never removes a user target.
///
/// 暂存目录由 `stage` 账本托管：目录名固定前缀、内含归属标记、账本登记。
/// 正常结束/失败/取消都清掉；进程被杀时账本条目留下，由启动恢复按标记校验后清理。
fn copy_file(
    src: &Path,
    dst: &Path,
    conflict: Conflict,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), FsFailure> {
    if cancelled() {
        return Err(transfer_cancelled());
    }
    let guard =
        stage::begin_file_stage(src, dst).map_err(|e| FsFailure::io("transfer", &e))?;
    let stage_path = guard.data_path();
    let result = match copy_file_to_stage(src, &stage_path, cancelled) {
        _ if cancelled() => Err(transfer_cancelled()),
        Err(error) => Err(FsFailure::io("transfer", &error)),
        Ok(()) => commit_file(&stage_path, dst, conflict)
            .map_err(|error| FsFailure::io_ctx("transfer", "目标提交失败", &error)),
    };
    if result.is_err() {
        // Windows may copy the read-only attribute. Only change the operation's own staged file.
        #[cfg(windows)]
        if let Ok(meta) = stage_path.metadata() {
            let mut permissions = meta.permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                let _ = fs::set_permissions(&stage_path, permissions);
            }
        }
    }
    // 无论成功失败都注销账本；目录里若还有未知内容，`finish` 会保留目录与条目。
    guard.finish();
    result
}

/// 递归复制目录：重解析点（符号链接/junction）不跟随；深度与总量有上限。
/// 只有 Overwrite 允许合并已有目录；子项沿用同一策略。
fn copy_dir(
    src: &Path,
    dst: &Path,
    depth: usize,
    budget: &mut usize,
    cancelled: &dyn Fn() -> bool,
    conflict: Conflict,
) -> Result<(), FsFailure> {
    if cancelled() {
        return Err(transfer_cancelled());
    }
    if depth > MAX_RECURSE_DEPTH {
        return Err(FsFailure::new(
            FS_OP_VALIDATION,
            "transfer",
            format!("目录嵌套超过 {MAX_RECURSE_DEPTH} 层，已中止"),
        ));
    }
    let mut changed = match fs::create_dir(dst) {
        Ok(()) => true,
        Err(error)
            if conflict == Conflict::Overwrite
                && error.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            let meta = fs::symlink_metadata(dst).map_err(|e| FsFailure::io("transfer", &e))?;
            if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(FsFailure::new(
                    FS_OP_CONFLICT,
                    "transfer",
                    "目标目录不可合并",
                ));
            }
            false
        }
        Err(error) => return Err(FsFailure::io_ctx("transfer", "创建目录失败", &error)),
    };
    let result = (|| {
        let read =
            fs::read_dir(src).map_err(|e| FsFailure::io_ctx("transfer", "读取目录失败", &e))?;
        for item in read {
            if cancelled() {
                return Err(transfer_cancelled());
            }
            if *budget == 0 {
                return Err(FsFailure::new(
                    FS_OP_VALIDATION,
                    "transfer",
                    "目录内容超过上限（20 万项），已中止",
                ));
            }
            *budget -= 1;
            let item =
                item.map_err(|e| FsFailure::io_ctx("transfer", "枚举目录条目失败，源已保留", &e))?;
            let ft = item
                .file_type()
                .map_err(|e| FsFailure::io_ctx("transfer", "读取条目类型失败，源已保留", &e))?;
            let child_src = item.path();
            let child_dst = dst.join(item.file_name());
            // 不完整复制必须失败，否则跨卷移动随后删源会把被跳过的条目也删除。
            let attrs = item
                .metadata()
                .map(|m| m.file_attributes())
                .map_err(|e| FsFailure::io("transfer", &e))?;
            if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 || ft.is_symlink() {
                return Err(FsFailure::new(
                    FS_OP_UNSUPPORTED,
                    "transfer",
                    "目录含重解析点，未完整复制；源已保留",
                ));
            }
            if ft.is_dir() {
                copy_dir(
                    &child_src,
                    &child_dst,
                    depth + 1,
                    budget,
                    cancelled,
                    conflict,
                )?;
            } else {
                copy_file(&child_src, &child_dst, conflict, cancelled)?;
            }
            changed = true;
        }
        Ok(())
    })();
    result.map_err(|failure: FsFailure| {
        if changed {
            failure.mark_partial()
        } else {
            failure
        }
    })
}

/// 目录是否包含 target（移动目录进自身子树拒绝）。词法规范化 + 小写比较。
fn contains_path(outer: &Path, inner: &Path) -> bool {
    let inner = path_key(inner);
    let outer = path_key(outer);
    inner != outer && inner.starts_with(&format!("{outer}\\"))
}

/// 通用复制入口：paths → target_dir，逐条报告。目录复制失败保留已复制部分（如实报告）。
pub fn copy_paths(
    paths: &[String],
    target_dir: &Path,
    conflict: Conflict,
    operation_id: Option<String>,
    protected: &[PathBuf],
) -> AppResult<FsOpReport> {
    copy_paths_with_progress(paths, target_dir, conflict, operation_id, protected, &|| false, &|_| {})
}

/// 在顶层条目边界取消；当前单个文件/目录必须完成后才停止，不回滚已完成结果。
pub fn copy_paths_with_progress(
    paths: &[String],
    target_dir: &Path,
    conflict: Conflict,
    operation_id: Option<String>,
    protected: &[PathBuf],
    cancelled: &dyn Fn() -> bool,
    progress: &dyn Fn(&FsEntryReport),
) -> AppResult<FsOpReport> {
    if paths.len() > MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            MAX_OP_PATHS
        )));
    }
    ensure_not_protected(target_dir, protected)?;
    let dir = validate_dir(target_dir)?;
    let mut report = FsOpReport::empty().with_operation(operation_id);
    // 父目录优先：先复制父目录时子项随父复制，再单独复制会重复 → 跳过。
    let mut sources: Vec<PathBuf> = paths
        .iter()
        .map(|p| validate_abs_path(p))
        .collect::<AppResult<Vec<_>>>()?;
    sources.sort_by_key(|p| p.components().count());
    let mut copied_roots: Vec<PathBuf> = Vec::new();
    let mut budget = MAX_RECURSE_ITEMS;
    let mut notified = 0;
    for src in &sources {
        for entry in &report.entries[notified..] { progress(entry); }
        notified = report.entries.len();
        if cancelled() { break; }
        if let Err(error) = ensure_not_protected(src, protected) {
            report.push(fail_report(src, FsFailure::new(FS_OP_VALIDATION, "prepare", error.to_string())));
            continue;
        }
        if copied_roots
            .iter()
            .any(|root| contains_path(root, src) || same_path(root, src))
        {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("父目录已在本批次中复制".into()),
                code: None,
                stage: None,
            });
            continue;
        }
        if !src.exists() {
            report.push(fail_report(
                src,
                FsFailure::new(FS_OP_SOURCE_MISSING, "prepare", "源不存在或已被移动"),
            ));
            continue;
        }
        // 单条目的命名/元数据错误不得整批中止：源可能被其他程序并发删除或替换，
        // 一个坏条目只应该失败它自己（否则批量复制/移动时，第一个坏源就让整批不动）。
        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => {
                report.push(fail_report(
                    src,
                    FsFailure::new(FS_OP_VALIDATION, "prepare", "源路径缺少文件名"),
                ));
                continue;
            }
        };
        let meta = match fs::symlink_metadata(src) {
            Ok(meta) => meta,
            Err(e) => {
                report.push(fail_report(src, FsFailure::io("prepare", &e)));
                continue;
            }
        };
        if meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("符号链接不复制（避免跟随出目录边界）".into()),
                code: None,
                stage: None,
            });
            continue;
        }
        // 目标命名：冲突 rename 时先求唯一名；其余策略直接用原名。
        let dst = if conflict == Conflict::Rename && dir.join(&name).exists() {
            unique_target(&dir, &name)
        } else {
            dir.join(&name)
        };
        if same_path(src, &dir) {
            report.push(fail_report(
                src,
                FsFailure::new(FS_OP_VALIDATION, "prepare", "源与目标目录相同"),
            ));
            continue;
        }
        if contains_path(src, &dir) {
            report.push(fail_report(
                src,
                FsFailure::new(FS_OP_VALIDATION, "prepare", "不能把目录复制到其自身内部"),
            ));
            continue;
        }
        // skip 策略：目标已存在直接跳过并如实报告（不是失败）。
        if conflict == Conflict::Skip && dir.join(&name).exists() {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("目标已存在（skip 策略）".into()),
                code: None,
                stage: None,
            });
            continue;
        }
        let outcome = if meta.is_dir() {
            // 目录复制没有暂存目录：只在账本里留一条中断记录（进程被杀时用于「上次未完成」报告），
            // 成功/失败/取消都会注销；目标目录内容永不自动清理。
            let note = stage::note_dir_copy(src, &dst);
            let result = copy_dir(src, &dst, 0, &mut budget, cancelled, conflict);
            note.finish();
            result
        } else {
            copy_file(src, &dst, conflict, cancelled)
        };
        match outcome {
            Ok(()) => {
                copied_roots.push(src.clone());
                report.push(FsEntryReport {
                    source: src.to_string_lossy().into_owned(),
                    target: Some(dst.to_string_lossy().into_owned()),
                    status: "ok",
                    reason: None,
                    code: None,
                    stage: None,
                });
            }
            Err(failure) => report.push(fail_report(src, failure)),
        }
    }
    for entry in &report.entries[notified..] { progress(entry); }
    Ok(report)
}

fn same_path(a: &Path, b: &Path) -> bool {
    path_key(a) == path_key(b)
}

/// 同卷优先 rename；跨卷回退「复制 + 删除源」。返回目标路径或失败原因。
/// 跨卷文件先提交完整副本再删除源；提交后取消或删源失败时报告部分完成。
fn move_one(
    src: &Path,
    dst: &Path,
    conflict: Conflict,
    depth: usize,
    budget: &mut usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<PathBuf, FsFailure> {
    if cancelled() {
        return Err(transfer_cancelled());
    }
    if dst.exists() {
        match conflict {
            Conflict::Skip => return Err(FsFailure::new(FS_OP_CONFLICT, "prepare", "目标已存在")),
            Conflict::Rename => {
                return Err(FsFailure::new(
                    FS_OP_CONFLICT,
                    "prepare",
                    "目标已存在（rename 冲突未解析）",
                ))
            }
            Conflict::Overwrite => {
                let meta = fs::symlink_metadata(dst).map_err(|e| FsFailure::io("prepare", &e))?;
                if meta.is_dir() {
                    // 目录并入：递归复制后删除源（不删除已有目标内容）。
                    copy_dir(src, dst, depth, budget, cancelled, conflict)?;
                    if cancelled() {
                        return Err(transfer_cancelled().mark_partial());
                    }
                    if let Err(e) = delete_tree(src) {
                        return Err(FsFailure::new(
                            e.code,
                            "cleanup",
                            format!("内容已并入目标，但删除源失败（源已保留）: {}", e.reason),
                        )
                        .mark_partial());
                    }
                    return Ok(dst.to_path_buf());
                }
                // 不先删除目标：同卷 rename 在 Windows 上原子替换；跨卷回退
                // 也会先复制到临时名、删除源成功后再落位。提前 remove_file
                // 会在后续复制/rename 失败时把用户原有目标文件丢掉。
            }
        }
    }
    match commit_file(src, dst, conflict) {
        Ok(()) => Ok(dst.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(FsFailure::io("transfer", &e))
        }
        Err(_) => {
            // 跨卷或被占用：回退复制 + 删除源。目录复制失败时保留源（不丢数据）。
            let meta = fs::symlink_metadata(src).map_err(|e| FsFailure::io("transfer", &e))?;
            if meta.is_dir() {
                copy_dir(src, dst, depth, budget, cancelled, conflict)?;
                if cancelled() {
                    return Err(transfer_cancelled().mark_partial());
                }
                if let Err(e) = delete_tree(src) {
                    // 源保留 + 目标保留已复制部分：结果可解释，逐条报告给用户。
                    return Err(FsFailure::new(
                        e.code,
                        "cleanup",
                        format!(
                            "复制已完成，但删除源失败（源已保留，目标存在已复制副本）: {}",
                            e.reason
                        ),
                    )
                    .mark_partial());
                }
            } else {
                copy_file(src, dst, conflict, cancelled)?;
                if cancelled() {
                    return Err(transfer_cancelled().mark_partial());
                }
                if let Err(e) = fs::remove_file(src) {
                    // 目标已是完整新内容，源仍在：这是可解释的 partial，不是丢数据。
                    return Err(FsFailure::new(
                        classify_io_error(&e),
                        "cleanup",
                        format!("目标已落位，但删除源失败（源已保留，可重试删除）: {e}"),
                    )
                    .mark_partial());
                }
            }
            Ok(dst.to_path_buf())
        }
    }
}

/// 有界递归删除（永久删除）：重解析点不跟随（只删链接本身），深度与总量有上限。
fn delete_tree(path: &Path) -> Result<(), FsFailure> {
    fn rec(path: &Path, depth: usize, budget: &mut usize) -> Result<(), FsFailure> {
        if depth > MAX_RECURSE_DEPTH {
            return Err(FsFailure::new(
                FS_OP_VALIDATION,
                "transfer",
                format!("目录嵌套超过 {MAX_RECURSE_DEPTH} 层，已中止"),
            ));
        }
        let meta = fs::symlink_metadata(path).map_err(|e| FsFailure::io("transfer", &e))?;
        // 重解析点：直接删链接本身，绝不递归进目标（防环、防越界）。
        if meta.file_type().is_symlink()
            || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            fs::remove_file(path)
                .or_else(|_| fs::remove_dir(path))
                .map_err(|e| {
                    FsFailure::new(
                        classify_io_error(&e),
                        "transfer",
                        format!("删除重解析点 {path:?} 失败: {e}"),
                    )
                })?;
            return Ok(());
        }
        if meta.is_dir() {
            let read = fs::read_dir(path).map_err(|e| FsFailure::io("transfer", &e))?;
            for item in read {
                *budget -= 1;
                if *budget <= 0 {
                    return Err(FsFailure::new(
                        FS_OP_VALIDATION,
                        "transfer",
                        "目录内容超过上限（20 万项），已中止",
                    ));
                }
                let Ok(item) = item else { continue };
                rec(&item.path(), depth + 1, budget)?;
            }
            fs::remove_dir(path).map_err(|e| FsFailure::io("transfer", &e))?;
        } else {
            fs::remove_file(path).map_err(|e| FsFailure::io("transfer", &e))?;
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
    operation_id: Option<String>,
    protected: &[PathBuf],
) -> AppResult<FsOpReport> {
    move_paths_with_progress(paths, target_dir, conflict, operation_id, protected, &|| false, &|_| {})
}

pub fn move_paths_with_progress(
    paths: &[String],
    target_dir: &Path,
    conflict: Conflict,
    operation_id: Option<String>,
    protected: &[PathBuf],
    cancelled: &dyn Fn() -> bool,
    progress: &dyn Fn(&FsEntryReport),
) -> AppResult<FsOpReport> {
    if paths.len() > MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            MAX_OP_PATHS
        )));
    }
    ensure_not_protected(target_dir, protected)?;
    let dir = validate_dir(target_dir)?;
    let mut report = FsOpReport::empty().with_operation(operation_id);
    let mut sources: Vec<PathBuf> = paths
        .iter()
        .map(|p| validate_abs_path(p))
        .collect::<AppResult<Vec<_>>>()?;
    sources.sort_by_key(|p| p.components().count());
    let mut moved_roots: Vec<PathBuf> = Vec::new();
    let mut budget = MAX_RECURSE_ITEMS;
    let mut notified = 0;
    for src in &sources {
        for entry in &report.entries[notified..] { progress(entry); }
        notified = report.entries.len();
        if cancelled() { break; }
        if let Err(error) = ensure_not_protected(src, protected) {
            report.push(fail_report(src, FsFailure::new(FS_OP_VALIDATION, "prepare", error.to_string())));
            continue;
        }
        if moved_roots
            .iter()
            .any(|root| contains_path(root, src) || same_path(root, src))
        {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("父目录已在本批次中移动".into()),
                code: None,
                stage: None,
            });
            continue;
        }
        if !src.exists() {
            report.push(fail_report(
                src,
                FsFailure::new(FS_OP_SOURCE_MISSING, "prepare", "源不存在或已被移动"),
            ));
            continue;
        }
        if contains_path(src, &dir) {
            report.push(fail_report(
                src,
                FsFailure::new(FS_OP_VALIDATION, "prepare", "不能把目录移动到其自身内部"),
            ));
            continue;
        }
        // 单条目的命名/元数据错误不得整批中止：源可能被其他程序并发删除或替换，
        // 一个坏条目只应该失败它自己（否则批量复制/移动时，第一个坏源就让整批不动）。
        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => {
                report.push(fail_report(
                    src,
                    FsFailure::new(FS_OP_VALIDATION, "prepare", "源路径缺少文件名"),
                ));
                continue;
            }
        };
        let meta = match fs::symlink_metadata(src) {
            Ok(meta) => meta,
            Err(e) => {
                report.push(fail_report(src, FsFailure::io("prepare", &e)));
                continue;
            }
        };
        if meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("符号链接不移动".into()),
                code: None,
                stage: None,
            });
            continue;
        }
        if same_path(src.parent().unwrap_or(Path::new("")), &dir) {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("源与目标目录相同".into()),
                code: None,
                stage: None,
            });
            continue;
        }
        // skip 策略：目标已存在直接跳过并如实报告（不是失败）。
        if conflict == Conflict::Skip && dir.join(&name).exists() {
            report.push(FsEntryReport {
                source: src.to_string_lossy().into_owned(),
                target: None,
                status: "skipped",
                reason: Some("目标已存在（skip 策略）".into()),
                code: None,
                stage: None,
            });
            continue;
        }
        let dst = if conflict == Conflict::Rename && dir.join(&name).exists() {
            unique_target(&dir, &name)
        } else {
            dir.join(&name)
        };
        match move_one(src, &dst, conflict, 0, &mut budget, cancelled) {
            Ok(target) => {
                moved_roots.push(src.clone());
                report.push(FsEntryReport {
                    source: src.to_string_lossy().into_owned(),
                    target: Some(target.to_string_lossy().into_owned()),
                    status: "ok",
                    reason: None,
                    code: None,
                    stage: None,
                });
            }
            Err(failure) => report.push(fail_report(src, failure)),
        }
    }
    for entry in &report.entries[notified..] { progress(entry); }
    Ok(report)
}

// ── 删除 ────────────────────────────────────────────────────────────────

// ── 回收站删除的验证边界（评估结论，不重写为 IFileOperation）────────────
//
// 为什么仍是整批 `SHFileOperationW`：
// 1. `SHFileOperationW` 只有**一个**整批返回码与**一个**整批 `fAnyOperationsAborted`，
//    没有任何逐项回调。逐项证明（「这个文件究竟是不是被本次调用移入回收站」）必须
//    改用 `IFileOperation` + `IFileOperationProgressSink`（仓库内
//    `src-tauri/src/recycle/ops.rs` 有同类实现），整条普通文件删除链路都要重写。
// 2. 本轮不重写：批量一次 Shell 调用（500 项 1 次）是明确的性能与用户预期约束，
//    且 `delete_paths` 里的重解析点保护、盘符根/UNC 根保护都挂在现有链路上。
// 3. 代价必须如实呈现：整批报错时无法区分「这条已被 Shell 移入回收站」与
//    「这条被其他进程删掉 / 根本没处理」。因此引入 `FS_OP_UNVERIFIED` 第三态，
//    把不可证明的条目显式标为未确认，再由 UI 提示用户去回收站核对——绝不把
//    「读不到源状态」当成成功（旧实现的 P1 缺陷就在于此）。
// 4. 待办：若要逐项证明，改用 IFileOperation 并用 sink 的 PostDeleteItem 回填
//    每项 HRESULT，届时 `FS_OP_UNVERIFIED` 只会保留给「读状态失败」一种情形。

/// `SHFileOperationW` 的 Shell 错误码 → 稳定错误码。
///
/// 0x71–0x83 是 Shell 的 `DE_*` 区间（不同 Windows 版本的个别常量命名略有差异，
/// 但数值与含义稳定）；其余是 Win32 码（`SHFileOperationW` 也会直接回传）。
fn shell_delete_code(code: i32) -> &'static str {
    match code {
        // DE_ACCESSDENIEDSRC：源拒绝访问（ACL / 只读卷）。
        0x71 => FS_OP_ACCESS_DENIED,
        // DE_ACCESSDENIEDDST：目标（回收站存储）拒绝访问。
        0x78 => FS_OP_ACCESS_DENIED,
        // 路径过长：属于输入侧限制，不是「源不存在」；按校验拒绝归类，
        // 前端提示用户缩短路径/改用上级目录，而不是让用户以为文件消失了。
        0x72 => FS_OP_VALIDATION,
        // DE_INVALIDFILES：文件名无效 / 源无法被 Shell 识别为可删除对象。
        0x7C => FS_OP_SOURCE_MISSING,
        // DE_FILENOTFOUND：源已不存在。
        0x74 => FS_OP_SOURCE_MISSING,
        // DE_SHAREVIOLATION：源被其他进程以不共享方式打开。
        0x75 => FS_OP_FILE_BUSY,
        // DE_LOCKVIOLATION：源被锁（锁字节区间 / 独占）。
        0x76 => FS_OP_FILE_BUSY,
        // DE_DELETESFROMREADONLY：只读属性导致拒绝删除。
        0x7A => FS_OP_ACCESS_DENIED,
        // ERROR_CANCELLED（Win32 1223）：用户在系统确认框/进度框取消。
        1223 => FS_OP_CANCELLED,
        // Win32 ERROR_ACCESS_DENIED。
        5 => FS_OP_ACCESS_DENIED,
        // Win32 ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND。
        2 | 3 => FS_OP_SOURCE_MISSING,
        // Win32 ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION。
        32 | 33 => FS_OP_FILE_BUSY,
        // 其余（含 DE_* 区间里未单列的码与未知 Win32 码）一律按 IO 故障。
        _ => FS_OP_IO,
    }
}

/// 一次「源是否还在」的判定结果。三种状态必须分开：
/// - `Gone`：读取确认不存在（`NotFound` / Win32 2、3）；
/// - `Present`：仍然存在；
/// - `Unknown`：读取失败但不是 `NotFound`（拒绝访问 / 共享冲突 / 其他 IO）——
///   既不能当成功，也不能断言失败。
///
/// 刻意**不用** `Path::exists()`：它把权限错误、共享冲突都吞成 `false`，
/// 会把「读不到」误判成「已经删掉」，正是本模块要修掉的 P1 缺陷。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceState {
    Gone,
    Present,
    Unknown,
}

fn source_state(path: &Path) -> SourceState {
    match fs::symlink_metadata(path) {
        Ok(_) => SourceState::Present,
        Err(err) => {
            use std::io::ErrorKind;
            // `NotFound` 是「确认不存在」的唯一可靠信号；
            // raw 2/3 覆盖 ErrorKind 映射不到的路径不存在场景。
            if err.kind() == ErrorKind::NotFound {
                return SourceState::Gone;
            }
            match err.raw_os_error() {
                Some(2) | Some(3) => SourceState::Gone,
                // 5 拒绝访问、32/33 共享冲突，以及其余一切错误：无法证明。
                _ => SourceState::Unknown,
            }
        }
    }
}

/// 单个条目的回收站结果判定。`code` 是 `SHFileOperationW` 的整批返回码，
/// `aborted` 是整批的 `fAnyOperationsAborted`。
///
/// 语义（整批判定 + 单项状态复核，二者交叉验证）：
/// | 源状态   | 整批返回                        | 结果 |
/// |----------|---------------------------------|------|
/// | Gone     | code == 0 且未中止              | Ok：Shell 报告整批成功，源已离开原位置 |
/// | Gone     | aborted                         | Ok：中止前已处理的条目确实已移走 |
/// | Gone     | code != 0 且未中止              | Err(UNVERIFIED)：整批报错，无法确认这条是被 Shell 移入回收站还是被别的进程删掉 |
/// | Present  | code == 0 且未中止              | Err(IO)：Shell 说成功但源仍在，状态不一致，不能报成功 |
/// | Present  | aborted                         | Err(CANCELLED) |
/// | Present  | code != 0                       | Err(shell_delete_code(code)) |
/// | Unknown  | 任意                            | Err(UNVERIFIED)：读不到源状态，无法证明 |
fn classify_recycle_outcome(
    state: SourceState,
    code: i32,
    aborted: bool,
) -> Result<(), FsFailure> {
    match state {
        SourceState::Gone => {
            if aborted || code == 0 {
                Ok(())
            } else {
                Err(FsFailure::new(
                    FS_OP_UNVERIFIED,
                    "recycle",
                    format!(
                        "Shell 批量删除返回错误码 {code}，源已不在原位置，但无法确认是否由本次操作移入回收站"
                    ),
                ))
            }
        }
        SourceState::Present => {
            if aborted {
                Err(FsFailure::new(FS_OP_CANCELLED, "recycle", "操作被系统中止"))
            } else if code == 0 {
                // Shell 报整批成功却仍有源存在：状态不一致，绝不报成功。
                Err(FsFailure::new(
                    FS_OP_IO,
                    "recycle",
                    "Shell 报告成功但源仍然存在（状态不一致）",
                ))
            } else {
                Err(FsFailure::new(
                    shell_delete_code(code),
                    "recycle",
                    format!("回收站删除失败（Shell 返回码 {code}）"),
                ))
            }
        }
        SourceState::Unknown => Err(FsFailure::new(
            FS_OP_UNVERIFIED,
            "recycle",
            "无法读取源路径状态（拒绝访问或被占用），不能确认回收站删除是否生效",
        )),
    }
}

/// 一次 Shell 调用删除整批路径：`pFrom` 是双 NUL 结尾的多路径列表，
/// 对 500 项只需 **1 次** `SHFileOperationW`，而不是逐项一次。
///
/// 逐项结果以「源是否还留在原位置」复核，并按
/// [`classify_recycle_outcome`] 的三态语义判定：确认成功才 ok，确认失败才 failed，
/// 读不到状态或整批报错但源已消失则标记 `FS_OP_UNVERIFIED`。
/// 注意：`FOF_ALLOWUNDO` 在卷不支持回收站时由系统改为永久删除，这与
/// 逐项调用的既有语义一致，不因批量化而改变。
#[cfg(windows)]
fn recycle_delete_batch(paths: &[PathBuf]) -> Vec<Result<(), FsFailure>> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOERRORUI, FOF_NOCONFIRMATION,
        FOF_SILENT, SHFILEOPSTRUCTW,
    };

    if paths.is_empty() {
        return Vec::new();
    }
    #[cfg(test)]
    shell_recycle_call_count_bump();
    #[cfg(test)]
    if let Some(code) = run_shell_recycle_mock(paths) {
        return verify_recycled(paths, code as i32, shell_recycle_mock_aborted());
    }

    let mut from: Vec<u16> = Vec::with_capacity(paths.len() * 64 + 2);
    for path in paths {
        from.extend(path.to_string_lossy().encode_utf16());
        from.push(0);
    }
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        hwnd: Default::default(),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        pTo: PCWSTR::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        fAnyOperationsAborted: windows::core::BOOL(0),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: PCWSTR::null(),
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    verify_recycled(paths, code, op.fAnyOperationsAborted.as_bool())
}

/// 逐项复核回收站删除：返回与输入同序、等长的结果。
///
/// 只做「读源状态 + 三态判定」，不再出现「任何读取错误都当成功」。
#[cfg(windows)]
fn verify_recycled(paths: &[PathBuf], code: i32, aborted: bool) -> Vec<Result<(), FsFailure>> {
    paths
        .iter()
        .map(|path| classify_recycle_outcome(source_state(path), code, aborted))
        .collect()
}

#[cfg(test)]
mod shell_seam {
    use super::*;
    use std::cell::{Cell, RefCell};

    thread_local! {
        // 计数按测试线程隔离：测试并行运行时全局 AtomicUsize 会互相干扰，
        // 让「整批 = 1 次 Shell 调用」这类断言偶发失败。
        static CALLS: Cell<usize> = const { Cell::new(0) };
        static MOCK: RefCell<Option<Box<dyn FnMut(&[PathBuf]) -> u32>>> = const { RefCell::new(None) };
        // 替身签名只有返回码，无法表达 `fAnyOperationsAborted`：单独存一个标志，
        // 仅被 `recycle_delete_batch` 的测试分支读取，生产路径完全不看它。
        static MOCK_ABORTED: Cell<bool> = const { Cell::new(false) };
    }

    pub(crate) fn shell_recycle_call_count() -> usize {
        CALLS.with(|calls| calls.get())
    }

    pub(crate) fn shell_recycle_call_count_bump() {
        CALLS.with(|calls| calls.set(calls.get() + 1));
    }

    pub(crate) fn set_shell_recycle_mock(mock: Option<Box<dyn FnMut(&[PathBuf]) -> u32>>) {
        MOCK.with(|slot| *slot.borrow_mut() = mock);
        // 每次装/卸替身都清空中止标志与计数，避免线程复用导致跨用例串味。
        MOCK_ABORTED.with(|flag| flag.set(false));
        CALLS.with(|calls| calls.set(0));
    }

    /// 设置整批中止标志；必须在 [`set_shell_recycle_mock`] 之后调用（后者会重置）。
    pub(crate) fn set_shell_recycle_aborted(aborted: bool) {
        MOCK_ABORTED.with(|flag| flag.set(aborted));
    }

    pub(crate) fn shell_recycle_mock_aborted() -> bool {
        MOCK_ABORTED.with(|flag| flag.get())
    }

    /// 测试替身：避免把测试文件真正放进用户回收站；仍走同一逐项复核路径。
    pub(crate) fn run_shell_recycle_mock(paths: &[PathBuf]) -> Option<u32> {
        MOCK.with(|slot| {
            let mut slot = slot.borrow_mut();
            slot.as_mut().map(|mock| mock(paths))
        })
    }
}

#[cfg(test)]
use shell_seam::{
    run_shell_recycle_mock, set_shell_recycle_aborted, set_shell_recycle_mock,
    shell_recycle_call_count, shell_recycle_call_count_bump, shell_recycle_mock_aborted,
};

#[cfg(not(windows))]
fn recycle_delete_batch(paths: &[PathBuf]) -> Vec<Result<(), FsFailure>> {
    paths
        .iter()
        .map(|_| {
            Err(FsFailure::new(
                FS_OP_UNSUPPORTED,
                "recycle",
                "当前平台不支持回收站删除",
            ))
        })
        .collect()
}

/// 删除入口：`permanent=false` 走回收站（整批一次 Shell 调用），
/// `permanent=true` 有界递归永久删除。逐项如实报告，顺序与输入一致。
pub fn delete_paths(
    paths: &[String],
    permanent: bool,
    operation_id: Option<String>,
    protected: &[PathBuf],
) -> AppResult<FsOpReport> {
    if paths.len() > MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            MAX_OP_PATHS
        )));
    }
    let mut report = FsOpReport::empty().with_operation(operation_id);
    // 占位保序：回收站条目统一的 Shell 结果要回填到各自输入下标。
    let mut entries: Vec<Option<FsEntryReport>> = Vec::with_capacity(paths.len());
    let mut recycle: Vec<(usize, PathBuf)> = Vec::new();
    for raw in paths {
        let src = validate_abs_path(raw)?;
        ensure_not_protected(&src, protected)?;
        if !src.exists() {
            entries.push(Some(fail_report(
                &src,
                FsFailure::new(FS_OP_SOURCE_MISSING, "prepare", "路径不存在"),
            )));
            continue;
        }
        // 盘符根 / UNC share 根绝不删除。判定必须在任何删除动作之前——
        // 第一轮用 components().count()<=1 判断，而 `C:\` 的分量数是 2，
        // 检查形同虚设（当时靠 ACL 失败偶然中止，属 P0 级缺陷）。
        if is_root_path(&src) {
            entries.push(Some(fail_report(
                &src,
                FsFailure::new(
                    FS_OP_VALIDATION,
                    "prepare",
                    "不允许删除盘符根目录或共享根",
                ),
            )));
            continue;
        }
        let meta = fs::symlink_metadata(&src).map_err(|e| AppError::Io(e))?;
        // 重解析点（junction/符号链接）必须优先于 is_dir 判定：symlink_metadata
        // 对链接 is_dir()==false，直接走 remove_file 会以「拒绝访问」失败
        // （DeleteFileW 不能删目录重解析点）。删链接本身统一走 delete_tree。
        let is_reparse = meta.file_type().is_symlink()
            || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        let is_dir = meta.is_dir();
        if permanent {
            let outcome = if is_reparse || is_dir {
                delete_tree(&src)
            } else {
                fs::remove_file(&src).map_err(|e| FsFailure::io("transfer", &e))
            };
            entries.push(Some(match outcome {
                Ok(()) => FsEntryReport {
                    source: src.to_string_lossy().into_owned(),
                    target: None,
                    status: "ok",
                    reason: None,
                    code: None,
                    stage: None,
                },
                Err(failure) => fail_report(&src, failure),
            }));
        } else {
            // 词法规范化但不 canonicalize：不跟随重解析点，删链接本身。
            recycle.push((entries.len(), normalize_lexical(&src)));
            entries.push(None);
        }
    }
    if !recycle.is_empty() {
        let batch: Vec<PathBuf> = recycle.iter().map(|(_, path)| path.clone()).collect();
        let results = recycle_delete_batch(&batch);
        for ((index, src), result) in recycle.into_iter().zip(results) {
            entries[index] = Some(match result {
                Ok(()) => FsEntryReport {
                    source: src.to_string_lossy().into_owned(),
                    target: None,
                    status: "ok",
                    reason: None,
                    code: None,
                    stage: None,
                },
                Err(failure) => fail_report(&src, failure),
            });
        }
    }
    for entry in entries.into_iter().flatten() {
        report.push(entry);
    }
    Ok(report)
}

// ── 诊断：一次文件操作的权威业务结果 ──────────────────────────────────

/// 把一次文件工作区操作的业务结果映射为**有界**诊断事件。
///
/// 与暂存架投递共用 [`crate::diagnostics::batch`] 的级别判定与字段集合，因此
/// 诊断中心看到的「一次批量文件操作」形状完全一致：
/// - 汇总一条：全部成功 = INFO/success；部分失败 = WARN/failed；
///   全部失败 = ERROR/failed；
/// - 明细按（错误码, 阶段）聚合，最多 4 条；
/// - 只写计数与稳定错误码，**绝不写路径 / 文件名 / 原始错误文本**；
/// - `operation_id` 由前端生成（`startOperation`）并经 IPC 传入，前端与后端共用
///   同一 ID，所以「用户看到的那次失败」在诊断中心可以精确关联，不会因前后端各
///   记一条而重复膨胀。
pub fn op_diagnostic_events(
    report: &FsOpReport,
    action: &str,
    mode: &str,
    duration_ms: u64,
) -> Vec<crate::diagnostics::DiagnosticEvent> {
    use crate::diagnostics::batch::{self, BatchCounts, BatchSpec};
    use serde_json::Value as Json;

    let failures = batch::aggregate_failures(
        report.entries.iter().map(|entry| {
            (
                entry.status,
                entry.code.as_deref(),
                entry.stage.as_deref(),
            )
        }),
        FS_OP_UNKNOWN,
    );

    batch::events(&BatchSpec {
        module: "file",
        action,
        operation_id: &report.operation_id,
        counts: BatchCounts {
            total: report.attempted as i64,
            success: report.ok as i64,
            skipped: report.skipped as i64,
            failed: report.failed as i64,
            partial: report.partial as i64,
        },
        failures,
        duration_ms,
        noun: "文件操作",
        success_event: "op_completed",
        failed_event: "op_failed",
        partial_event: "op_partial",
        detail_event: "op_item_failed",
        extra_metadata: vec![("mode", Json::from(mode.to_string()))],
        // 文件工作区没有「结构不兼容」这类需要强制 ERROR 的码。
        critical_codes: &[],
        // 校验拒绝、同名冲突、用户取消都属于预期结果：全量出现时仍是 WARN。
        expected_rejection_codes: &[
            FS_OP_VALIDATION,
            FS_OP_CONFLICT,
            FS_OP_UNSUPPORTED,
            FS_OP_CANCELLED,
        ],
        multi_failure_code: FS_OP_MULTI_FAILURE,
        category_of: fs_op_category,
    })
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
    // 大小写-only 改名：Windows 的 exists() 大小写不敏感，若目标是与源同一路径键
    // 则不是外部冲突，交给 fs::rename 真正改大小写。
    if target.exists() && path_key(&target) != path_key(path) {
        return Err(AppError::Conflict(format!("已存在同名条目: {name}")));
    }
    fs::rename(path, &target).map_err(|e| AppError::Io(e))?;
    Ok(target)
}

/// 批量重命名条目（前端预览后提交；后端逐项校验并返回真实逐项结果）。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameItem {
    pub path: String,
    pub new_name: String,
}

// ── 只读内容哈希（文件夹对比的显式用户操作；不在打开目录时后台扫描）────────
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsHashEntry {
    pub path: String,
    pub size: Option<u64>,
    pub hash: Option<String>,
    pub error: Option<String>,
}

/// 一次哈希的进度：按文件（index/total）与按字节（少读大文件时用户能看到动静）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HashProgress {
    /// 已完成（含失败/跳过）的文件数。
    pub index: usize,
    pub total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

/// 单个文件的哈希结果 + 身份快照。
///
/// 两者必须来自**同一个已打开的句柄**：`entry.size` 取句柄属性而不是二次
/// `fs::metadata(path)`，否则「stat 与 open 之间被替换」会让身份与内容错位。
pub struct HashedFile {
    pub entry: FsHashEntry,
    pub identity: Option<identity::FileIdentity>,
}

/// 文本预览（只读、按需读取前 N 字节；不把大文件整读进内存）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsTextPreview {
    pub path: String,
    pub size: u64,
    pub truncated: bool,
    /// 实际解码口径：`UTF-8` / `UTF-8 BOM` / `UTF-16 LE` / `UTF-16 BE` / `UTF-8 (lossy)`。
    /// 前端据此显示编码信息与乱码提示；旧前端忽略该字段仍可工作（兼容新增）。
    pub encoding: String,
    pub content: String,
}

/// 原始字节只读预览（图片原图 / PDF）。上限由调用方给定并在核心层再次钳制；
/// 超限时只返回前缀字节并置 `truncated=true`，绝不整文件读入内存。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsBinaryPreview {
    pub path: String,
    pub size: u64,
    pub truncated: bool,
    pub mime: String,
    /// 前缀字节的 base64；仅用于 WebView 侧构造 Blob（图片/SVG）或交给 pdf.js。
    pub base64: String,
}

pub fn read_text_preview(path: &Path, max_bytes: usize) -> AppResult<FsTextPreview> {
    use std::io::Read as _;
    let meta = fs::metadata(path).map_err(|e| AppError::NotFound(format!("文件不可读: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::Validation("仅支持预览单个文件".into()));
    }
    let cap = max_bytes.clamp(16 * 1024, 2 * 1024 * 1024);
    let mut file = fs::File::open(path).map_err(|e| AppError::Io(e))?;
    let mut buffer = Vec::with_capacity(cap + 1);
    file.by_ref()
        .take((cap + 1) as u64)
        .read_to_end(&mut buffer)
        .map_err(|e| AppError::Io(e))?;
    let truncated = buffer.len() > cap;
    if truncated {
        buffer.truncate(cap);
    }
    let (content, encoding) = decode_text_preview(&buffer)?;
    Ok(FsTextPreview {
        path: path.to_string_lossy().into_owned(),
        size: meta.len(),
        truncated,
        encoding,
        content,
    })
}

/// 文本解码：BOM 优先（UTF-8 / UTF-16 LE / UTF-16 BE），其余按 UTF-8 校验。
/// 无 BOM 且含 NUL 的按二进制拒绝——不把未知二进制造假成文本。
fn decode_text_preview(buffer: &[u8]) -> AppResult<(String, String)> {
    if let Some(body) = buffer.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return Ok((String::from_utf8_lossy(body).into_owned(), "UTF-8 BOM".into()));
    }
    if let Some(body) = buffer.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return Ok((String::from_utf16_lossy(&units), "UTF-16 LE".into()));
    }
    if let Some(body) = buffer.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        return Ok((String::from_utf16_lossy(&units), "UTF-16 BE".into()));
    }
    if buffer.contains(&0) {
        return Err(AppError::Validation("二进制文件不支持文本预览".into()));
    }
    match std::str::from_utf8(buffer) {
        Ok(text) => Ok((text.to_string(), "UTF-8".into())),
        // 截断恰好切在多字节字符中间：只裁掉不完整尾巴，不把整份文件标成乱码。
        Err(err) if err.error_len().is_none() => {
            let valid = &buffer[..err.valid_up_to()];
            Ok((String::from_utf8_lossy(valid).into_owned(), "UTF-8".into()))
        }
        Err(_) => Ok((String::from_utf8_lossy(buffer).into_owned(), "UTF-8 (lossy)".into())),
    }
}

/// 原始字节只读预览：单次读取上限内字节并 base64 返回；不缓存、不落盘。
pub fn read_binary_preview(path: &Path, max_bytes: usize) -> AppResult<FsBinaryPreview> {
    use std::io::Read as _;
    let meta = fs::metadata(path).map_err(|e| AppError::NotFound(format!("文件不可读: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::Validation("仅支持预览单个文件".into()));
    }
    let cap = max_bytes.clamp(64 * 1024, 64 * 1024 * 1024);
    // 预留容量不超过真实文件大小，避免为小文件按上限分配。
    let reserve = usize::try_from(meta.len()).unwrap_or(cap).min(cap) + 1;
    let mut file = fs::File::open(path).map_err(|e| AppError::Io(e))?;
    let mut buffer = Vec::with_capacity(reserve);
    file.by_ref()
        .take((cap + 1) as u64)
        .read_to_end(&mut buffer)
        .map_err(|e| AppError::Io(e))?;
    let truncated = buffer.len() > cap;
    if truncated {
        buffer.truncate(cap);
    }
    Ok(FsBinaryPreview {
        path: path.to_string_lossy().into_owned(),
        size: meta.len(),
        truncated,
        mime: preview::mime_for_path(path).to_string(),
        base64: base64::engine::general_purpose::STANDARD.encode(&buffer),
    })
}

/// 批量 SHA-256（兼容入口：无进度、不可取消）。
pub fn hash_files(paths: &[String], protected: &[PathBuf]) -> Vec<FsHashEntry> {
    hash_files_detailed(paths, protected, &mut |_| {}, &|| false)
        .into_iter()
        .map(|item| item.entry)
        .collect()
}

/// 批量 SHA-256 + 身份快照 + 进度 + 取消。
///
/// 与旧实现的区别（都是为了闭合「哈希 → 删除」之间的替换窗口）：
/// - 先 `File::open`，再从**同一句柄**取身份与大小（不再按路径二次 stat）；
/// - 返回每个文件的 `FileIdentity`，供删除前复核；
/// - 每 4MB / 200ms 回调节流一次，大文件不再「看起来卡死」；
/// - `cancel()` 在文件边界与每 4MB 检查，取消后已算出的条目保留（调用方不会再删除）。
pub fn hash_files_detailed(
    paths: &[String],
    protected: &[PathBuf],
    progress: &mut dyn FnMut(HashProgress),
    cancel: &dyn Fn() -> bool,
) -> Vec<HashedFile> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    /// 进度回调的节流阈值：按字节或时间，二者先到先发。
    const EMIT_BYTES: u64 = 4 * 1024 * 1024;
    const EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

    let total = paths.len().min(MAX_OP_PATHS);
    // 预先统计总字节用于进度分母：最多 500 次 stat，相对于哈希本身可忽略。
    // 读不到的条目按 0 计，不影响正确性，只影响进度百分比。
    let bytes_total: u64 = paths
        .iter()
        .take(total)
        .filter_map(|raw| fs::metadata(raw).ok())
        .map(|meta| meta.len())
        .sum();

    let mut out = Vec::with_capacity(total);
    let mut bytes_done: u64 = 0;
    for (index, raw) in paths.iter().take(total).enumerate() {
        if cancel() {
            break;
        }
        let push_error = |out: &mut Vec<HashedFile>, size: Option<u64>, error: String| {
            out.push(HashedFile {
                entry: FsHashEntry {
                    path: raw.clone(),
                    size,
                    hash: None,
                    error: Some(error),
                },
                identity: None,
            });
        };
        let path = match validate_abs_path(raw) {
            Ok(path) => path,
            Err(e) => {
                push_error(&mut out, None, e.to_string());
                progress(HashProgress { index: index + 1, total, bytes_done, bytes_total });
                continue;
            }
        };
        if let Err(e) = ensure_not_protected(&path, protected) {
            push_error(&mut out, None, e.to_string());
            progress(HashProgress { index: index + 1, total, bytes_done, bytes_total });
            continue;
        }
        let mut file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(e) => {
                push_error(&mut out, None, format!("打开文件失败: {e}"));
                progress(HashProgress { index: index + 1, total, bytes_done, bytes_total });
                continue;
            }
        };
        // 身份与大小都来自这个句柄；后续读取也用同一个句柄。
        let identity = identity::identity_of_handle(&file).ok();
        let meta = match file.metadata() {
            Ok(meta) => meta,
            Err(e) => {
                push_error(&mut out, None, format!("读取属性失败: {e}"));
                progress(HashProgress { index: index + 1, total, bytes_done, bytes_total });
                continue;
            }
        };
        if !meta.is_file() {
            push_error(&mut out, Some(meta.len()), "仅支持对文件计算哈希".into());
            progress(HashProgress { index: index + 1, total, bytes_done, bytes_total });
            continue;
        }

        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut error = None;
        let mut cancelled = false;
        let mut last_emit_bytes = bytes_done;
        let mut last_emit_at = std::time::Instant::now();
        loop {
            match file.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    hasher.update(&buffer[..n]);
                    bytes_done = bytes_done.saturating_add(n as u64);
                    if cancel() {
                        cancelled = true;
                        break;
                    }
                    if bytes_done - last_emit_bytes >= EMIT_BYTES
                        || last_emit_at.elapsed() >= EMIT_INTERVAL
                    {
                        last_emit_bytes = bytes_done;
                        last_emit_at = std::time::Instant::now();
                        progress(HashProgress { index, total, bytes_done, bytes_total });
                    }
                }
                Err(e) => {
                    error = Some(format!("读取失败: {e}"));
                    break;
                }
            }
        }
        if cancelled {
            // 取消不算失败也不产出哈希：调用方据此中止整批，不删除任何东西。
            break;
        }
        out.push(HashedFile {
            entry: FsHashEntry {
                path: raw.clone(),
                size: Some(meta.len()),
                hash: if error.is_some() {
                    None
                } else {
                    Some(format!("{:x}", hasher.finalize()))
                },
                error,
            },
            identity,
        });
        progress(HashProgress { index: index + 1, total, bytes_done, bytes_total });
    }
    out
}

/// 批量重命名：任一非法名称/重复目标/已存在目标都不会被静默覆盖。
///
/// 不做事务性全量回滚：逐项真实执行并返回 ok/failed/skipped，失败项保留原因。
/// 目标与其他待重命名项互换属于冲突（不临时改名的两阶段方案），避免半途名称丢失。
pub fn batch_rename(
    items: &[BatchRenameItem],
    protected: &[PathBuf],
    operation_id: Option<String>,
) -> FsOpReport {
    batch_rename_with_progress(items, protected, operation_id, &|| false, &|_| {})
}

pub fn batch_rename_with_progress(
    items: &[BatchRenameItem],
    protected: &[PathBuf],
    operation_id: Option<String>,
    cancelled: &dyn Fn() -> bool,
    progress: &dyn Fn(&FsEntryReport),
) -> FsOpReport {
    let mut report = FsOpReport::empty().with_operation(operation_id);
    if items.len() > MAX_OP_PATHS {
        report.push(FsEntryReport {
            source: String::new(),
            target: None,
            status: "failed",
            reason: Some(format!("批量重命名超过 {MAX_OP_PATHS} 项上限")),
            code: Some("validation".into()),
            stage: Some("prepare".into()),
        });
        return report;
    }

    struct Prepared {
        index: usize,
        source: PathBuf,
        target: PathBuf,
        failure: Option<AppError>,
        unchanged: bool,
    }

    let mut prepared: Vec<Prepared> = Vec::with_capacity(items.len());
    let mut target_keys: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let source = match validate_abs_path(&item.path) {
            Ok(path) => path,
            Err(e) => {
                prepared.push(Prepared {
                    index,
                    source: PathBuf::new(),
                    target: PathBuf::new(),
                    failure: Some(e),
                    unchanged: false,
                });
                continue;
            }
        };
        if let Err(e) = ensure_not_protected(&source, protected) {
            prepared.push(Prepared {
                index,
                source,
                target: PathBuf::new(),
                failure: Some(e),
                unchanged: false,
            });
            continue;
        }
        let name = match sanitize_name(&item.new_name) {
            Ok(name) => name,
            Err(e) => {
                prepared.push(Prepared {
                    index,
                    source,
                    target: PathBuf::new(),
                    failure: Some(e),
                    unchanged: false,
                });
                continue;
            }
        };
        let parent = match source.parent() {
            Some(parent) => parent.to_path_buf(),
            None => {
                prepared.push(Prepared {
                    index,
                    source,
                    target: PathBuf::new(),
                    failure: Some(AppError::Validation("路径没有父目录".into())),
                    unchanged: false,
                });
                continue;
            }
        };
        let target = parent.join(&name);
        // 大小写-only 改名是合法操作；只有“完全相同的名称”才是 skipped。
        // path_key 仍用于重复目标/源集合比较（Windows 文件系统大小写不敏感）。
        let unchanged = source.file_name() == target.file_name();
        if !unchanged {
            target_keys.entry(path_key(&target)).or_default().push(index);
        }
        prepared.push(Prepared {
            index,
            source,
            target,
            failure: None,
            unchanged,
        });
    }

    // 重复目标必须在执行前整体判失败，避免“第一项成功、第二项冲突”的假部分成功。
    let mut duplicate_targets: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for indexes in target_keys.values().filter(|indexes| indexes.len() > 1) {
        duplicate_targets.extend(indexes.iter().copied());
    }
    let source_keys: std::collections::HashSet<String> = prepared
        .iter()
        .filter(|item| item.failure.is_none())
        .map(|item| path_key(&item.source))
        .collect();

    let mut notified = 0;
    for item in prepared {
        for entry in &report.entries[notified..] { progress(entry); }
        notified = report.entries.len();
        if cancelled() { break; }
        if let Some(failure) = item.failure {
            report.push(FsEntryReport {
                source: items[item.index].path.clone(),
                target: None,
                status: "failed",
                reason: Some(failure.to_string()),
                code: Some(failure.code().to_string()),
                stage: Some("prepare".into()),
            });
            continue;
        }
        if duplicate_targets.contains(&item.index) {
            report.push(FsEntryReport {
                source: item.source.to_string_lossy().into_owned(),
                target: Some(item.target.to_string_lossy().into_owned()),
                status: "failed",
                reason: Some("批量内存在重复目标名称，已拒绝整组执行".into()),
                code: Some("conflict".into()),
                stage: Some("prepare".into()),
            });
            continue;
        }
        if item.unchanged {
            report.push(FsEntryReport {
                source: item.source.to_string_lossy().into_owned(),
                target: Some(item.target.to_string_lossy().into_owned()),
                status: "skipped",
                reason: Some("名称未变化".into()),
                code: None,
                stage: None,
            });
            continue;
        }
        if item.target.exists() && path_key(&item.source) != path_key(&item.target) {
            // 目标若是本批另一个源，同样视为冲突：直接改名会破坏该源，暂不支持互换。
            let reason = if source_keys.contains(&path_key(&item.target)) {
                "目标名称与本批其他源文件互换；请分步重命名".to_string()
            } else {
                format!("目标已存在同名条目: {}", item.target.to_string_lossy())
            };
            report.push(FsEntryReport {
                source: item.source.to_string_lossy().into_owned(),
                target: Some(item.target.to_string_lossy().into_owned()),
                status: "failed",
                reason: Some(reason),
                code: Some("conflict".into()),
                stage: Some("prepare".into()),
            });
            continue;
        }
        match rename(&item.source, &items[item.index].new_name) {
            Ok(target) => report.push(FsEntryReport {
                source: item.source.to_string_lossy().into_owned(),
                target: Some(target.to_string_lossy().into_owned()),
                status: "ok",
                reason: None,
                code: None,
                stage: None,
            }),
            Err(e) => report.push(FsEntryReport {
                source: item.source.to_string_lossy().into_owned(),
                target: Some(item.target.to_string_lossy().into_owned()),
                status: "failed",
                reason: Some(e.to_string()),
                code: Some(e.code().to_string()),
                stage: Some("rename".into()),
            }),
        }
    }
    for entry in &report.entries[notified..] { progress(entry); }
    report
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
    /// 最后访问时间；Windows 可能延迟更新（Lazy Update），前端需标注仅供参考。
    pub accessed_ms: Option<i64>,
    /// Windows 属性位的小写代码（readonly/hidden/system/...）；前端本地化。
    pub attributes: Vec<&'static str>,
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
                accessed_ms: None,
                attributes: Vec::new(),
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
            accessed_ms: None,
            attributes: Vec::new(),
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
        accessed_ms: meta.accessed().ok().map(|t| unix_ms(t)),
        attributes: attribute_names(attrs),
        readonly,
        hidden,
        child_count,
        child_truncated,
    }
}

/// 操作预演最多统计的条目数；超过即标记不完整，不无限递归。
const PREVIEW_MAX_ITEMS: usize = 50_000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConflict {
    pub source: String,
    pub target: String,
    /// file | dir | link
    pub kind: &'static str,
}

/// 只读操作预演结果：不复制、不移动、不删除任何文件。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OperationPreview {
    /// copy | move
    pub effect: String,
    pub items: usize,
    pub files: usize,
    pub dirs: usize,
    pub bytes: u64,
    pub conflicts: Vec<PreviewConflict>,
    pub inaccessible: Vec<String>,
    pub duplicates: Vec<String>,
    pub warnings: Vec<String>,
    /// false = 触达条目/深度/读取上限，统计不完整；UI 必须如实提示。
    pub complete: bool,
}

fn measure_tree(
    path: &Path,
    depth: usize,
    items: &mut usize,
    files: &mut usize,
    dirs: &mut usize,
    bytes: &mut u64,
    inaccessible: &mut Vec<String>,
    max_items: usize,
) -> bool {
    if depth > MAX_RECURSE_DEPTH || *items >= max_items {
        return false;
    }
    *items += 1;
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(_) => {
            // 源消失/无权限/被占用：未知字节数不得当作零字节成功，
            // 必须进入 inaccessible 并把整次统计标记为不完整。
            inaccessible.push(path.to_string_lossy().into_owned());
            return false;
        }
    };
    let is_reparse = meta.file_type().is_symlink()
        || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    if meta.is_dir() && !is_reparse {
        *dirs += 1;
        let Ok(read) = fs::read_dir(path) else {
            return false;
        };
        let mut complete = true;
        for item in read {
            if *items >= max_items {
                return false;
            }
            let Ok(item) = item else {
                complete = false;
                continue;
            };
            complete &= measure_tree(
                &item.path(),
                depth + 1,
                items,
                files,
                dirs,
                bytes,
                inaccessible,
                max_items,
            );
        }
        complete
    } else {
        *files += 1;
        *bytes = bytes.saturating_add(meta.len());
        true
    }
}

/// 预演复制/移动：统计条目/字节，检测同名冲突、无权限源与重复源。
/// 目标目录必须是已存在的目录；源位于目标内（移动进自身子树）直接拒绝。
pub fn preview_transfer(paths: &[String], target_dir: &str, effect: &str) -> AppResult<OperationPreview> {
    let effect = match effect {
        "copy" | "move" => effect,
        other => {
            return Err(AppError::Validation(format!(
                "不支持的操作预演类型: {other}"
            )))
        }
    };
    if paths.is_empty() {
        return Err(AppError::Validation("没有需要预演的文件".into()));
    }
    let target = validate_dir(&validate_abs_path(target_dir)?)?;
    let mut preview = OperationPreview {
        effect: effect.to_string(),
        items: 0,
        files: 0,
        dirs: 0,
        bytes: 0,
        conflicts: Vec::new(),
        inaccessible: Vec::new(),
        duplicates: Vec::new(),
        warnings: Vec::new(),
        complete: true,
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for raw in paths {
        let src = match validate_abs_path(raw) {
            Ok(path) => path,
            Err(_) => {
                // 无法可靠统计的条目必须影响 complete：UI 据此禁止直接确认。
                preview.inaccessible.push(raw.clone());
                preview.complete = false;
                continue;
            }
        };
        let key = path_key(&src);
        if !seen.insert(key) {
            preview.duplicates.push(src.to_string_lossy().into_owned());
            continue;
        }
        let meta = match fs::symlink_metadata(&src) {
            Ok(meta) => meta,
            Err(_) => {
                // 源文件消失/无权限：进入 inaccessible 且统计不完整，不当零字节成功。
                preview.inaccessible.push(src.to_string_lossy().into_owned());
                preview.complete = false;
                continue;
            }
        };
        if meta.is_dir() && is_under(&target, &src) {
            return Err(AppError::Validation(format!(
                "目标目录位于源目录内: {}",
                src.display()
            )));
        }
        if let Some(name) = src.file_name() {
            let candidate = target.join(name);
            if fs::symlink_metadata(&candidate).is_ok() {
                let kind = fs::symlink_metadata(&candidate)
                    .map(|m| {
                        if m.file_type().is_symlink()
                            || m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                        {
                            "link"
                        } else if m.is_dir() {
                            "dir"
                        } else {
                            "file"
                        }
                    })
                    .unwrap_or("file");
                preview.conflicts.push(PreviewConflict {
                    source: src.to_string_lossy().into_owned(),
                    target: candidate.to_string_lossy().into_owned(),
                    kind,
                });
            }
        }
        preview.complete &= measure_tree(
            &src,
            0,
            &mut preview.items,
            &mut preview.files,
            &mut preview.dirs,
            &mut preview.bytes,
            &mut preview.inaccessible,
            PREVIEW_MAX_ITEMS,
        );
    }
    if !preview.complete {
        preview
            .warnings
            .push("存在无法读取的条目或触达条目/深度上限，统计不完整；执行前请缩小范围或解决权限问题".into());
    }
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::OnceLock;

    /// 旧用例不关心操作 ID：本地薄包装固定传 `None`（后端自行生成）。
    /// 局部定义优先于 `use super::*` 的全局导入，避免改动 15 处调用点。
    fn copy_paths(
        paths: &[String],
        dir: &Path,
        conflict: Conflict,
        protected: &[PathBuf],
    ) -> AppResult<FsOpReport> {
        super::copy_paths(paths, dir, conflict, None, protected)
    }

    fn move_paths(
        paths: &[String],
        dir: &Path,
        conflict: Conflict,
        protected: &[PathBuf],
    ) -> AppResult<FsOpReport> {
        super::move_paths(paths, dir, conflict, None, protected)
    }

    fn delete_paths(
        paths: &[String],
        permanent: bool,
        protected: &[PathBuf],
    ) -> AppResult<FsOpReport> {
        super::delete_paths(paths, permanent, None, protected)
    }

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
        // 首尾空白按 trim 处理（用户意图是 "name"），不是错误。
        assert_eq!(sanitize_name("name ").unwrap(), "name");
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
        let listing = list_dir(&root, true, 0).unwrap();
        assert_eq!(listing.has_more, false);
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
        let listing2 = list_dir(&root, false, 0).unwrap();
        assert_eq!(listing2.entries.len(), listing.entries.len());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_dir_pagination_beyond_page_limit() {
        let root = temp_root("pager");
        // 一页上限由 MAX_LIST_ENTRIES 决定；造一个小的 offset 分页场景验证语义：
        // 建 5 项，每轮按 nextOffset 推进，直到 has_more=false。
        for i in 0..5 {
            fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        let mut offset = 0usize;
        let mut rounds = 0;
        let mut seen: Vec<String> = Vec::new();
        loop {
            let page = list_dir(&root, true, offset).unwrap();
            for e in &page.entries {
                seen.push(e.name.clone());
            }
            rounds += 1;
            // 契约：nextOffset 显式等于 scanned；前端一律用 nextOffset 翻页。
            assert_eq!(page.next_offset, page.scanned);
            offset = page.next_offset;
            if !page.has_more {
                break;
            }
            assert!(rounds < 50, "分页不收敛");
        }
        assert_eq!(seen.len(), 5);
        let mut sorted = seen.clone();
        sorted.sort();
        let mut expected: Vec<String> = (0..5).map(|i| format!("f{i}.txt")).collect();
        expected.sort();
        assert_eq!(sorted, expected);
        fs::remove_dir_all(&root).unwrap();
    }

    /// 测试辅助：把文件标记为 Windows 隐藏属性（FILE_ATTRIBUTE_HIDDEN）。
    #[cfg(windows)]
    fn mark_hidden(path: &Path) {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN};
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        unsafe {
            let _ = SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_ATTRIBUTE_HIDDEN);
        }
    }

    /// 跨多页遍历：聚合各页并集，断言不重不漏、has_more 收敛、停滞不变量成立。
    /// 生产上限为 MAX_LIST_ENTRIES=8000 / MAX_SCAN_PER_PAGE=16000；这里注入等比缩小的
    /// 内部参数（4 / 8），真实遍历等价于 7999/8000/8001/12000/16000/16001/24000/32000
    /// 量级的多页边界，避免真造数万文件。
    fn traverse_paged(
        root: &Path,
        show_hidden: bool,
        max_entries: usize,
        max_scan: usize,
    ) -> (Vec<String>, Vec<usize>, usize) {
        let mut offset = 0usize;
        let mut seen: Vec<String> = Vec::new();
        let mut next_offsets: Vec<usize> = Vec::new();
        let mut rounds = 0;
        loop {
            let page = list_dir_with_limits(root, show_hidden, offset, max_entries, max_scan).unwrap();
            // 契约 2/3：scanned 恒 >= offset；nextOffset 显式等于 scanned。
            assert!(page.scanned >= offset, "scanned 不得回退到 offset 之前");
            assert_eq!(page.next_offset, page.scanned);
            if page.has_more {
                // 契约 3：has_more=true 时 nextOffset 必须 > offset（否则前端停滞）。
                assert!(page.next_offset > offset, "分页停滞：nextOffset 未推进");
            }
            for e in &page.entries {
                seen.push(e.name.clone());
            }
            next_offsets.push(page.next_offset);
            rounds += 1;
            offset = page.next_offset;
            if !page.has_more {
                break;
            }
            assert!(rounds < 100, "分页不收敛");
        }
        (seen, next_offsets, rounds)
    }

    #[test]
    fn pagination_union_is_complete_no_dup_no_missing() {
        let root = temp_root("pagerunion");
        const TOTAL: usize = 20;
        for i in 0..TOTAL {
            fs::write(root.join(format!("f{i:02}.txt")), "x").unwrap();
        }
        let (seen, next_offsets, rounds) = traverse_paged(&root, true, 4, 8);
        assert!(rounds >= 3, "必须真实跨多页遍历（>=3 页）");
        assert_eq!(seen.len(), TOTAL, "各页并集必须覆盖全部条目");
        let mut sorted = seen.clone();
        sorted.sort();
        let mut expected: Vec<String> = (0..TOTAL).map(|i| format!("f{i:02}.txt")).collect();
        expected.sort();
        assert_eq!(sorted, expected, "不重不漏");
        // 偏移单调推进，最后一页 nextOffset 等于目录条目总数。
        for pair in next_offsets.windows(2) {
            assert!(pair[1] >= pair[0]);
        }
        assert_eq!(*next_offsets.last().unwrap(), TOTAL);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pagination_hidden_items_consume_offset_but_are_filtered() {
        let root = temp_root("pagerhidden");
        // 6 个可见 + 10 个隐藏，交错创建；隐藏项计入磁盘偏移但不返回。
        for i in 0..6 {
            fs::write(root.join(format!("v{i}.txt")), "x").unwrap();
        }
        for i in 0..10 {
            let hidden = root.join(format!("h{i}.txt"));
            fs::write(&hidden, "x").unwrap();
            #[cfg(windows)]
            mark_hidden(&hidden);
        }
        // show_hidden=false：可见并集 == 6 个 v*；隐藏项不出现在结果里。
        let (visible, _, rounds) = traverse_paged(&root, false, 2, 5);
        assert!(rounds >= 3, "隐藏项消耗偏移后必须跨多页");
        let mut visible_sorted = visible.clone();
        visible_sorted.sort();
        let mut expected: Vec<String> = (0..6).map(|i| format!("v{i}.txt")).collect();
        expected.sort();
        assert_eq!(visible_sorted, expected);
        assert!(visible.iter().all(|n| !n.starts_with('h')));

        // 首页 nextOffset 大于本页返回条数：证明隐藏项确实消耗了偏移。
        let first = list_dir_with_limits(&root, false, 0, 2, 5).unwrap();
        assert!(first.next_offset > first.entries.len());

        // show_hidden=true：16 项全部返回。
        let (all, _, _) = traverse_paged(&root, true, 4, 8);
        assert_eq!(all.len(), 16);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pagination_offset_beyond_end_returns_empty_no_more() {
        let root = temp_root("pageroob");
        for i in 0..3 {
            fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        // offset 超界：空页、has_more=false，scanned/nextOffset 等于目录条目总数。
        let page = list_dir_with_limits(&root, true, 100, 4, 8).unwrap();
        assert!(page.entries.is_empty());
        assert_eq!(page.scanned, 3);
        assert_eq!(page.next_offset, 3);
        assert_eq!(page.has_more, false);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pagination_stops_on_scan_budget_then_completes() {
        let root = temp_root("pagerbudget");
        for i in 0..12 {
            fs::write(root.join(format!("f{i:02}.txt")), "x").unwrap();
        }
        // 扫描预算 5、返回条数上限放到很大：第一条停止路径 = 扫描预算耗尽。
        let first = list_dir_with_limits(&root, true, 0, 100, 5).unwrap();
        assert_eq!(first.has_more, true);
        assert!(first.entries.len() < 100, "预算停止不应触达返回条数上限");
        assert_eq!(first.next_offset, 5);
        assert!(first.next_offset > 0);
        let (seen, _, _) = traverse_paged(&root, true, 100, 5);
        assert_eq!(seen.len(), 12, "预算分页续拉后仍须读全");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pagination_stops_on_entry_count_limit_then_completes() {
        let root = temp_root("pagercount");
        for i in 0..12 {
            fs::write(root.join(format!("f{i:02}.txt")), "x").unwrap();
        }
        // 返回条数上限 3、扫描预算放到很大：第二条停止路径 = 返回条数上限。
        let first = list_dir_with_limits(&root, true, 0, 3, 100).unwrap();
        assert_eq!(first.has_more, true);
        assert_eq!(first.entries.len(), 3);
        assert!(first.next_offset > 0);
        let (seen, _, rounds) = traverse_paged(&root, true, 3, 100);
        assert!(rounds >= 4, "3 条/页 × 12 项必须跨 4 页");
        assert_eq!(seen.len(), 12, "条数上限分页续拉后仍须读全");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pagination_failed_entry_consumes_offset_without_blocking() {
        let root = temp_root("pagerfail");
        for i in 0..5 {
            fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        // 注入一条读取失败项：它消耗偏移但不返回，其余条目正常列举。
        let read = fs::read_dir(&root).unwrap();
        let mut items: Vec<std::io::Result<fs::DirEntry>> = read.collect();
        let total = items.len();
        items[1] = Err(std::io::Error::new(std::io::ErrorKind::Other, "boom"));
        let listing = list_entries(items.into_iter(), &root, true, 0, 100, 100);
        assert_eq!(listing.entries.len(), total - 1, "失败项不返回");
        assert_eq!(listing.scanned, total, "失败项仍计入已消费位置");
        assert_eq!(listing.next_offset, listing.scanned);
        assert_eq!(listing.has_more, false);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_dir_missing_fails_not_found() {
        let root = temp_root("missing");
        let result = list_dir(&root.join("nope"), false, 0);
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
        // 完全相同路径：明确拒绝。
        let report = copy_paths(
            &[src_dir.to_string_lossy().into_owned()],
            &src_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.failed, 1);
        assert!(report.entries[0].reason.as_deref().unwrap().contains("相同"));
        // 复制进自身子树：拒绝（防递归膨胀）。
        let report = copy_paths(
            &[src_dir.to_string_lossy().into_owned()],
            &src_dir.join("inner"),
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.failed, 1);
        assert!(report.entries[0].reason.as_deref().unwrap().contains("自身内部"));
        fs::remove_dir_all(&root).unwrap();
    }

    // ── 操作预演 ───────────────────────────────────────────────────────

    #[test]
    fn preview_transfer_counts_and_detects_conflicts() {
        let root = temp_root("preview");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(src_dir.join("nested")).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("a.txt"), "1234").unwrap();
        fs::write(src_dir.join("nested/b.txt"), "56").unwrap();

        let preview = preview_transfer(
            &[src_dir.to_string_lossy().into_owned()],
            &dst_dir.to_string_lossy(),
            "copy",
        )
        .unwrap();
        // 源目录本身 + a.txt + nested + b.txt。
        assert_eq!(preview.items, 4);
        assert_eq!(preview.files, 2);
        assert_eq!(preview.dirs, 2);
        assert_eq!(preview.bytes, 6);
        assert!(preview.conflicts.is_empty());
        assert!(preview.complete);

        // 单文件同名冲突：目标已有 a.txt。
        fs::write(dst_dir.join("a.txt"), "old").unwrap();
        let preview = preview_transfer(
            &[src_dir.join("a.txt").to_string_lossy().into_owned()],
            &dst_dir.to_string_lossy(),
            "copy",
        )
        .unwrap();
        assert_eq!(preview.conflicts.len(), 1);
        assert_eq!(preview.conflicts[0].kind, "file");

        // 重复源只统计一次，并单独列出。
        let duplicate = src_dir.join("a.txt").to_string_lossy().into_owned();
        let preview = preview_transfer(
            &[duplicate.clone(), duplicate],
            &dst_dir.to_string_lossy(),
            "copy",
        )
        .unwrap();
        assert_eq!(preview.items, 1);
        assert_eq!(preview.duplicates.len(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn preview_transfer_rejects_move_into_own_subtree() {
        let root = temp_root("preview-self");
        let src_dir = root.join("src");
        fs::create_dir_all(src_dir.join("inner")).unwrap();
        let result = preview_transfer(
            &[src_dir.to_string_lossy().into_owned()],
            &src_dir.join("inner").to_string_lossy(),
            "move",
        );
        assert!(result.is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    // r9：预演完整性——任何无法可靠统计的条目都必须影响 complete，绝不伪造完整统计。

    #[test]
    fn preview_transfer_marks_vanished_source_incomplete() {
        let root = temp_root("preview-vanished");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&dst_dir).unwrap();
        let ghost = root.join("ghost.txt");
        fs::write(&ghost, "x").unwrap();
        // 预演前源被删除（复制中途消失的等价场景）。
        fs::remove_file(&ghost).unwrap();
        let preview = preview_transfer(
            &[ghost.to_string_lossy().into_owned()],
            &dst_dir.to_string_lossy(),
            "copy",
        )
        .unwrap();
        assert!(!preview.complete);
        assert_eq!(preview.inaccessible.len(), 1);
        assert_eq!(preview.items, 0);
        assert_eq!(preview.files, 0);
        assert_eq!(preview.bytes, 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn preview_transfer_rejects_missing_target_dir() {
        let root = temp_root("preview-no-target");
        let src = root.join("a.txt");
        fs::write(&src, "x").unwrap();
        let result = preview_transfer(
            &[src.to_string_lossy().into_owned()],
            &root.join("no-such-dir").to_string_lossy(),
            "copy",
        );
        assert!(result.is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn preview_transfer_detects_dir_conflict() {
        let root = temp_root("preview-dir-conflict");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(dst_dir.join("src")).unwrap();
        let preview = preview_transfer(
            &[src_dir.to_string_lossy().into_owned()],
            &dst_dir.to_string_lossy(),
            "copy",
        )
        .unwrap();
        assert_eq!(preview.conflicts.len(), 1);
        assert_eq!(preview.conflicts[0].kind, "dir");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn measure_tree_metadata_failure_marks_incomplete() {
        // 直接调用内部函数模拟「枚举到条目但元数据读取失败」（无权限/被占用的
        // 真实路径都走同一错误分支）：必须进入 inaccessible 且不当作零字节成功。
        let root = temp_root("preview-meta-err");
        let missing = root.join("missing.bin");
        let mut items = 0usize;
        let mut files = 0usize;
        let mut dirs = 0usize;
        let mut bytes = 0u64;
        let mut inaccessible: Vec<String> = Vec::new();
        let complete = measure_tree(
            &missing,
            0,
            &mut items,
            &mut files,
            &mut dirs,
            &mut bytes,
            &mut inaccessible,
            PREVIEW_MAX_ITEMS,
        );
        assert!(!complete);
        assert_eq!(inaccessible.len(), 1);
        assert_eq!(files, 0);
        assert_eq!(dirs, 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn measure_tree_depth_limit_marks_incomplete() {
        let root = temp_root("preview-depth");
        // 物理创建 66+ 层会超出 MAX_PATH（取决于机器 LongPaths 配置），因此：
        // 1) 中等深度（10 层）物理递归应完整；
        // 2) 深度上限分支用「从 MAX_RECURSE_DEPTH 起步」的边界调用验证——
        //    生产路径中同一分支由真实深层目录触发（depth > 64 即失败）。
        let mut deep = root.join("d0");
        for level in 1..10 {
            deep = deep.join(format!("d{level}"));
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("leaf.txt"), "x").unwrap();
        let measure_at = |start_depth: usize| {
            let mut items = 0usize;
            let mut files = 0usize;
            let mut dirs = 0usize;
            let mut bytes = 0u64;
            let mut inaccessible: Vec<String> = Vec::new();
            let complete = measure_tree(
                &root.join("d0"),
                start_depth,
                &mut items,
                &mut files,
                &mut dirs,
                &mut bytes,
                &mut inaccessible,
                PREVIEW_MAX_ITEMS,
            );
            (complete, dirs, files)
        };
        let (complete, dirs, files) = measure_at(0);
        assert!(complete);
        assert_eq!(dirs, 10);
        assert_eq!(files, 1);
        // 深度上限：任何继续递归的调用都必须不完整，不得静默截断当完整。
        let (complete, _dirs, _files) = measure_at(MAX_RECURSE_DEPTH);
        assert!(!complete);
        let (complete, _dirs, _files) = measure_at(MAX_RECURSE_DEPTH + 5);
        assert!(!complete);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn measure_tree_item_limit_marks_incomplete() {
        let root = temp_root("preview-items");
        let dir = root.join("many");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            fs::write(dir.join(format!("f{i}.txt")), "x").unwrap();
        }
        let measure = |max_items: usize| {
            let mut items = 0usize;
            let mut files = 0usize;
            let mut dirs = 0usize;
            let mut bytes = 0u64;
            let mut inaccessible: Vec<String> = Vec::new();
            let complete = measure_tree(
                &dir,
                0,
                &mut items,
                &mut files,
                &mut dirs,
                &mut bytes,
                &mut inaccessible,
                max_items,
            );
            (complete, items, files)
        };
        let (complete, _items, files) = measure(100);
        assert!(complete);
        assert_eq!(files, 5);
        // 条目预算耗尽：不完整，绝不把没读完的部分伪装成完整统计。
        let (complete, _items, files) = measure(3);
        assert!(!complete);
        assert!(files < 5);
        fs::remove_dir_all(&root).unwrap();
    }

    // ── 预览（文本编码 / 原始字节）──────────────────────────────────────

    #[test]
    fn read_text_preview_reports_encoding() {
        let root = temp_root("preview-encoding");
        let plain = root.join("plain.txt");
        fs::write(&plain, "hello 你好\n").unwrap();
        let preview = read_text_preview(&plain, 64 * 1024).unwrap();
        assert_eq!(preview.encoding, "UTF-8");
        assert_eq!(preview.content, "hello 你好\n");
        assert!(!preview.truncated);

        let bom = root.join("bom.txt");
        fs::write(&bom, [&[0xEF, 0xBB, 0xBF][..], "bom 文本".as_bytes()].concat()).unwrap();
        let preview = read_text_preview(&bom, 64 * 1024).unwrap();
        assert_eq!(preview.encoding, "UTF-8 BOM");
        assert_eq!(preview.content, "bom 文本");

        // UTF-16 LE（含 BOM）：以前会因 NUL 被误判为二进制，现在必须正确解码。
        let wide = root.join("wide.txt");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "中文 UTF-16".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(&wide, &bytes).unwrap();
        let preview = read_text_preview(&wide, 64 * 1024).unwrap();
        assert_eq!(preview.encoding, "UTF-16 LE");
        assert_eq!(preview.content, "中文 UTF-16");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_text_preview_rejects_binary_without_bom() {
        let root = temp_root("preview-binary");
        let bin = root.join("blob.bin");
        fs::write(&bin, [0u8, 1, 2, 3, 0, 255]).unwrap();
        let err = read_text_preview(&bin, 64 * 1024).unwrap_err();
        assert!(format!("{err:?}").contains("二进制"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_text_preview_truncates_at_character_boundary() {
        let root = temp_root("preview-truncate");
        let text = root.join("long.txt");
        // 3 字节汉字重复，确保截断点落在字符中间。
        fs::write(&text, "汉".repeat(20_000)).unwrap();
        let preview = read_text_preview(&text, 16 * 1024).unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.encoding, "UTF-8");
        assert!(!preview.content.ends_with('\u{FFFD}'));
        assert!(preview.content.chars().count() >= 5_000);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_binary_preview_caps_and_reports_mime() {
        let root = temp_root("preview-binary-cap");
        let pdf = root.join("sample.pdf");
        fs::write(&pdf, vec![0xABu8; 100 * 1024]).unwrap();
        let preview = read_binary_preview(&pdf, 64 * 1024).unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.size, 100 * 1024);
        assert_eq!(preview.mime, "application/pdf");
        // base64 解码后必须正好是上限字节（只读前缀，不整读）。
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(preview.base64.as_bytes())
            .unwrap();
        assert_eq!(decoded.len(), 64 * 1024);
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
        // 根目录拒绝发生在任何删除动作之前（P0：旧实现 components().count()<=1
        // 判断对 `C:\` 失效，靠 ACL 失败偶然中止；现在确定性地拒绝）。
        let report = delete_paths(&["C:\\".to_string()], true, &protected()).unwrap();
        assert_eq!(report.failed, 1);
        assert!(report.entries[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("根"),);
        // 设备路径直接在校验层拒绝。
        assert!(validate_abs_path(r"\\.\PhysicalDrive0").is_err());
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

    /// P1-D：500 项分批不应再产生 500 次逐文件 Shell 调用。
    /// 测试替身只记录批大小，不真正移动文件；逐项复核仍如实失败。
    ///
    /// 对照口径（同一 Shell 入口）：
    /// - 旧策略=每项单独调用 → 25 项 = 25 次 `SHFileOperationW`；
    /// - 新策略=`delete_paths` 整批一次 → 25 项 = 1 次。
    #[cfg(windows)]
    #[test]
    fn recycle_delete_uses_one_shell_call_for_whole_batch() {
        let root = temp_root("recycle-batch");
        let mut paths = Vec::new();
        for index in 0..25 {
            let file = root.join(format!("entry-{index}.txt"));
            fs::write(&file, b"x").unwrap();
            paths.push(file.to_string_lossy().into_owned());
        }
        let batch_paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let captured = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = captured.clone();
        set_shell_recycle_mock(Some(Box::new(move |batch| {
            sink.lock().unwrap().push(batch.len());
            0
        })));
        // 旧策略对照：逐项调用同一 Shell 入口（计数由入口自身累加）。
        for path in &batch_paths {
            let _ = recycle_delete_batch(std::slice::from_ref(path));
        }
        let per_item_calls = shell_recycle_call_count();
        assert_eq!(per_item_calls, 25, "逐项策略必须产生 25 次 Shell 调用");

        // 新策略：整批一次。
        set_shell_recycle_mock(Some(Box::new({
            let sink = captured.clone();
            move |batch| {
                sink.lock().unwrap().push(batch.len());
                0
            }
        })));
        let report = delete_paths(&paths, false, &protected()).unwrap();
        let batch_calls = shell_recycle_call_count();
        set_shell_recycle_mock(None);
        assert_eq!(batch_calls, 1);
        assert!(captured.lock().unwrap().contains(&25));
        // 替身没有真正移动文件：复核必须逐项失败，不能伪造成 ok。
        assert_eq!(report.attempted, 25);
        assert_eq!(report.ok, 0);
        assert_eq!(report.failed, 25);
        fs::remove_dir_all(&root).unwrap();
    }

    /// 回收站批次保序：缺失项占据自己的下标，其余结果不得错位。
    #[cfg(windows)]
    #[test]
    fn recycle_batch_results_stay_aligned_with_input() {
        let root = temp_root("recycle-order");
        let first = root.join("a.txt");
        fs::write(&first, b"x").unwrap();
        let missing = root.join("missing.txt");
        let second = root.join("b.txt");
        fs::write(&second, b"x").unwrap();
        set_shell_recycle_mock(Some(Box::new(|_| 0)));
        let report = delete_paths(
            &[
                first.to_string_lossy().into_owned(),
                missing.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
            false,
            &protected(),
        ).unwrap();
        set_shell_recycle_mock(None);
        assert_eq!(report.entries.len(), 3);
        assert!(report.entries[0].source.ends_with("a.txt"));
        assert!(report.entries[1].source.ends_with("missing.txt"));
        assert_eq!(report.entries[1].code.as_deref(), Some(FS_OP_SOURCE_MISSING));
        assert!(report.entries[2].source.ends_with("b.txt"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn shell_delete_codes_map_to_stable_codes() {
        // DE_* 区间：拒绝访问 / 路径过长 / 源缺失 / 占用 / 只读。
        assert_eq!(shell_delete_code(0x71), FS_OP_ACCESS_DENIED);
        assert_eq!(shell_delete_code(0x78), FS_OP_ACCESS_DENIED);
        assert_eq!(shell_delete_code(0x7A), FS_OP_ACCESS_DENIED);
        assert_eq!(shell_delete_code(0x72), FS_OP_VALIDATION);
        assert_eq!(shell_delete_code(0x74), FS_OP_SOURCE_MISSING);
        assert_eq!(shell_delete_code(0x7C), FS_OP_SOURCE_MISSING);
        assert_eq!(shell_delete_code(0x75), FS_OP_FILE_BUSY);
        assert_eq!(shell_delete_code(0x76), FS_OP_FILE_BUSY);
        // Win32 回传码。
        assert_eq!(shell_delete_code(1223), FS_OP_CANCELLED);
        assert_eq!(shell_delete_code(5), FS_OP_ACCESS_DENIED);
        assert_eq!(shell_delete_code(2), FS_OP_SOURCE_MISSING);
        assert_eq!(shell_delete_code(3), FS_OP_SOURCE_MISSING);
        assert_eq!(shell_delete_code(32), FS_OP_FILE_BUSY);
        assert_eq!(shell_delete_code(33), FS_OP_FILE_BUSY);
        // 未单列的码（含 0：Shell 成功码不是错误码，但映射函数必须稳定）。
        assert_eq!(shell_delete_code(0), FS_OP_IO);
        assert_eq!(shell_delete_code(0x1234), FS_OP_IO);
    }

    // ── 回收站三态判定（新增，替代「读取错误即成功」）────────────────────

    /// 回收站专项测试目录：唯一前缀 + uuid，绝不与既有测试目录/用户目录混用。
    fn recycle_temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-fw-recycle-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn paths_of(files: &[PathBuf]) -> Vec<String> {
        files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    /// 1) 全部成功：mock 真正删除 3 个文件并返回 0 → 3 个 ok。
    #[cfg(windows)]
    #[test]
    fn recycle_all_success_reports_each_item_ok() {
        let root = recycle_temp_root("all-ok");
        let files: Vec<PathBuf> = (0..3).map(|i| root.join(format!("f{i}.txt"))).collect();
        for file in &files {
            fs::write(file, b"x").unwrap();
        }
        set_shell_recycle_mock(Some(Box::new(|batch: &[PathBuf]| {
            for path in batch {
                fs::remove_file(path).unwrap();
            }
            0
        })));
        let report = delete_paths(&paths_of(&files), false, &protected()).unwrap();
        set_shell_recycle_mock(None);
        assert_eq!(report.attempted, 3);
        assert_eq!(report.ok, 3, "{:?}", report.entries);
        assert_eq!(report.failed, 0);
        for (entry, file) in report.entries.iter().zip(files.iter()) {
            assert_eq!(entry.status, "ok");
            assert!(!file.exists(), "mock 已删除的文件不应仍存在");
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// 2) 全部失败：mock 返回 0x71 且保留文件 → 3 个 failed / ACCESS_DENIED。
    #[cfg(windows)]
    #[test]
    fn recycle_all_failure_reports_access_denied() {
        let root = recycle_temp_root("all-fail");
        let files: Vec<PathBuf> = (0..3).map(|i| root.join(format!("f{i}.txt"))).collect();
        for file in &files {
            fs::write(file, b"x").unwrap();
        }
        set_shell_recycle_mock(Some(Box::new(|_: &[PathBuf]| 0x71)));
        let report = delete_paths(&paths_of(&files), false, &protected()).unwrap();
        set_shell_recycle_mock(None);
        assert_eq!(report.failed, 3);
        for entry in &report.entries {
            assert_eq!(entry.status, "failed");
            assert_eq!(entry.code.as_deref(), Some(FS_OP_ACCESS_DENIED));
            assert_eq!(entry.stage.as_deref(), Some("recycle"));
        }
        for file in &files {
            assert!(file.exists(), "失败条目必须保留在磁盘上");
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// 3) 部分成功：mock 只删第一个却返回整批错误 → 首个 UNVERIFIED，
    ///    其余 ACCESS_DENIED；结果与输入下标一一对应（不错位）。
    #[cfg(windows)]
    #[test]
    fn recycle_partial_success_keeps_input_alignment() {
        let root = recycle_temp_root("partial");
        let files: Vec<PathBuf> = (0..3).map(|i| root.join(format!("f{i}.txt"))).collect();
        for file in &files {
            fs::write(file, b"x").unwrap();
        }
        set_shell_recycle_mock(Some(Box::new(|batch: &[PathBuf]| {
            fs::remove_file(&batch[0]).unwrap();
            0x71
        })));
        let paths = paths_of(&files);
        let report = delete_paths(&paths, false, &protected()).unwrap();
        set_shell_recycle_mock(None);
        assert_eq!(report.entries.len(), 3);
        for (entry, path) in report.entries.iter().zip(paths.iter()) {
            assert_eq!(&entry.source, path, "逐项结果必须与输入顺序一致");
        }
        assert_eq!(report.entries[0].status, "failed");
        // 第一个虽已消失，但整批报错：无法确认是本次移入回收站 → 未确认。
        assert_eq!(report.entries[0].code.as_deref(), Some(FS_OP_UNVERIFIED));
        assert_eq!(report.entries[1].code.as_deref(), Some(FS_OP_ACCESS_DENIED));
        assert_eq!(report.entries[2].code.as_deref(), Some(FS_OP_ACCESS_DENIED));
        assert!(!files[0].exists());
        assert!(files[1].exists());
        assert!(files[2].exists());
        assert_eq!(report.ok, 0);
        assert_eq!(report.failed, 3);
        let _ = fs::remove_dir_all(&root);
    }

    /// 4) 执行前源已消失：Shell 返回 0 → 视为成功（确实已离开原位置）。
    #[cfg(windows)]
    #[test]
    fn recycle_missing_source_with_success_code_is_ok() {
        let root = recycle_temp_root("pre-gone");
        let gone = root.join("gone.txt"); // 从未创建
        set_shell_recycle_mock(Some(Box::new(|_: &[PathBuf]| 0)));
        let results = recycle_delete_batch(std::slice::from_ref(&gone));
        set_shell_recycle_mock(None);
        assert_eq!(results.len(), 1);
        assert!(results[0].is_ok(), "确认不存在 + 整批成功 → ok");
        let _ = fs::remove_dir_all(&root);
    }

    /// 5) 执行期间被其他程序删除：mock 删除文件但返回 0x71 → UNVERIFIED，不是 ok。
    #[cfg(windows)]
    #[test]
    fn recycle_source_deleted_during_operation_is_unverified() {
        let root = recycle_temp_root("racy-gone");
        let file = root.join("racy.txt");
        fs::write(&file, b"x").unwrap();
        set_shell_recycle_mock(Some(Box::new(|batch: &[PathBuf]| {
            // 模拟「其他进程删掉了它」：Shell 并未报告成功。
            fs::remove_file(&batch[0]).unwrap();
            0x71
        })));
        let results = recycle_delete_batch(std::slice::from_ref(&file));
        set_shell_recycle_mock(None);
        let err = results[0].as_ref().unwrap_err();
        assert_eq!(err.code, FS_OP_UNVERIFIED);
        assert_eq!(err.stage, "recycle");
        let root_text = root.to_string_lossy().into_owned();
        assert!(!err.reason.contains(&root_text), "reason 不得包含完整路径");
        let _ = fs::remove_dir_all(&root);
    }

    /// 6) 状态不可读：直接单测分类，不改 ACL。
    #[test]
    fn classify_unknown_state_is_unverified_for_any_code() {
        for code in [0, 0x71, 1223] {
            let err = classify_recycle_outcome(SourceState::Unknown, code, false)
                .unwrap_err();
            assert_eq!(err.code, FS_OP_UNVERIFIED, "code={code} 仍不可证明");
            assert_eq!(err.stage, "recycle");
        }
        // aborted 也不能把「读不到」变成成功或取消。
        let err = classify_recycle_outcome(SourceState::Unknown, 0, true).unwrap_err();
        assert_eq!(err.code, FS_OP_UNVERIFIED);
    }

    /// 纯函数：Gone / Present 的其他分支（不依赖 Shell 替身）。
    #[test]
    fn classify_gone_and_present_matrix() {
        assert!(classify_recycle_outcome(SourceState::Gone, 0, false).is_ok());
        assert!(classify_recycle_outcome(SourceState::Gone, 0x71, true).is_ok());
        assert_eq!(
            classify_recycle_outcome(SourceState::Gone, 0x71, false)
                .unwrap_err()
                .code,
            FS_OP_UNVERIFIED
        );
        assert_eq!(
            classify_recycle_outcome(SourceState::Present, 0, false)
                .unwrap_err()
                .code,
            FS_OP_IO
        );
        assert_eq!(
            classify_recycle_outcome(SourceState::Present, 0x75, false)
                .unwrap_err()
                .code,
            FS_OP_FILE_BUSY
        );
        assert_eq!(
            classify_recycle_outcome(SourceState::Present, 0, true)
                .unwrap_err()
                .code,
            FS_OP_CANCELLED
        );
    }

    /// 8) 用户取消：文件仍在 → CANCELLED；已被删除 → ok。
    #[cfg(windows)]
    #[test]
    fn recycle_aborted_reports_cancelled_only_when_source_remains() {
        let root = recycle_temp_root("aborted");
        let kept = root.join("kept.txt");
        fs::write(&kept, b"x").unwrap();
        set_shell_recycle_mock(Some(Box::new(|_: &[PathBuf]| 0x75)));
        set_shell_recycle_aborted(true);
        let results = recycle_delete_batch(std::slice::from_ref(&kept));
        assert_eq!(
            results[0].as_ref().unwrap_err().code,
            FS_OP_CANCELLED,
            "中止且源仍在 → 取消"
        );
        assert!(kept.exists());

        let removed = root.join("removed.txt");
        fs::write(&removed, b"x").unwrap();
        set_shell_recycle_mock(Some(Box::new(|batch: &[PathBuf]| {
            fs::remove_file(&batch[0]).unwrap();
            0
        })));
        set_shell_recycle_aborted(true);
        let results = recycle_delete_batch(std::slice::from_ref(&removed));
        set_shell_recycle_mock(None);
        assert!(results[0].is_ok(), "中止前已处理的条目确实已移走 → ok");
        let _ = fs::remove_dir_all(&root);
    }

    /// 9) 符号链接：处理链接本身，不跟随目标。环境无法创建链接时如实跳过。
    #[cfg(windows)]
    #[test]
    fn recycle_symlink_removes_link_without_touching_target() {
        use std::os::windows::fs::symlink_file;
        let root = recycle_temp_root("symlink");
        let target = root.join("target.txt");
        fs::write(&target, b"keep").unwrap();
        let link = root.join("link.txt");
        match symlink_file(&target, &link) {
            Ok(()) => {
                assert_eq!(source_state(&link), SourceState::Present);
                set_shell_recycle_mock(Some(Box::new(|batch: &[PathBuf]| {
                    for path in batch {
                        // 删除链接本身（Windows 上 remove_file 不会跟进目标）。
                        fs::remove_file(path).unwrap();
                    }
                    0
                })));
                let report =
                    delete_paths(&[link.to_string_lossy().into_owned()], false, &protected())
                        .unwrap();
                set_shell_recycle_mock(None);
                assert_eq!(report.ok, 1, "{:?}", report.entries);
                assert!(
                    fs::symlink_metadata(&link).is_err(),
                    "链接本身必须被处理"
                );
                assert!(target.exists(), "符号链接目标文件必须仍存在（不跟随）");
            }
            Err(err) => {
                eprintln!("未执行：环境无法创建符号链接（{err}），跳过断言");
            }
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// 10) 500 项整批：500 个 ok，且只有 1 次 Shell 调用。
    #[cfg(windows)]
    #[test]
    fn recycle_500_items_use_single_shell_call() {
        let root = recycle_temp_root("batch-500");
        let mut files = Vec::with_capacity(MAX_OP_PATHS);
        for i in 0..MAX_OP_PATHS {
            let file = root.join(format!("f{i:03}.txt"));
            fs::write(&file, b"x").unwrap();
            files.push(file);
        }
        set_shell_recycle_mock(Some(Box::new(|batch: &[PathBuf]| {
            for path in batch {
                fs::remove_file(path).unwrap();
            }
            0
        })));
        let report = delete_paths(&paths_of(&files), false, &protected()).unwrap();
        let calls = shell_recycle_call_count();
        set_shell_recycle_mock(None);
        assert_eq!(report.attempted, MAX_OP_PATHS);
        assert_eq!(report.ok, MAX_OP_PATHS, "{:?}", report.entries.first());
        assert_eq!(calls, 1, "500 项必须只触发 1 次 Shell 调用");
        let _ = fs::remove_dir_all(&root);
    }

    /// 11) 多批连续执行：每批各 1 次 Shell 调用，结果互不污染。
    #[cfg(windows)]
    #[test]
    fn recycle_consecutive_batches_do_not_leak_results() {
        let root = recycle_temp_root("batches");
        let make_batch = |prefix: &str| -> (Vec<PathBuf>, Vec<String>) {
            let files: Vec<PathBuf> = (0..200)
                .map(|i| root.join(format!("{prefix}{i:03}.txt")))
                .collect();
            for file in &files {
                fs::write(file, b"x").unwrap();
            }
            let paths = paths_of(&files);
            (files, paths)
        };
        let (first_files, first_paths) = make_batch("a");
        let (second_files, second_paths) = make_batch("b");
        set_shell_recycle_mock(Some(Box::new(|batch: &[PathBuf]| {
            for path in batch {
                fs::remove_file(path).unwrap();
            }
            0
        })));
        let first = delete_paths(&first_paths, false, &protected()).unwrap();
        let calls_after_first = shell_recycle_call_count();
        let second = delete_paths(&second_paths, false, &protected()).unwrap();
        let calls_after_second = shell_recycle_call_count();
        set_shell_recycle_mock(None);
        assert_eq!(calls_after_first, 1);
        assert_eq!(calls_after_second, 2);
        assert_eq!(first.ok, 200);
        assert_eq!(second.ok, 200);
        // 互不污染：各自 entries 只指向自己的输入。
        for (entry, path) in first.entries.iter().zip(first_paths.iter()) {
            assert_eq!(&entry.source, path);
        }
        for (entry, path) in second.entries.iter().zip(second_paths.iter()) {
            assert_eq!(&entry.source, path);
        }
        assert!(first_files.iter().all(|f| !f.exists()));
        assert!(second_files.iter().all(|f| !f.exists()));
        let _ = fs::remove_dir_all(&root);
    }

    /// 真实回收站批量删除对照：需显式开启，只创建唯一前缀测试文件。
    /// 运行：`cargo test --lib recycle_batch_native_bench -- --ignored --nocapture`
    /// 会在用户回收站留下 `taskdock-recycle-bench-*` 前缀的测试条目（不清理既有条目）。
    #[cfg(windows)]
    #[test]
    #[ignore = "真实回收站批量删除耗时对照，需 TD_RECYCLE_BATCH_BENCH=1"]
    fn recycle_batch_native_bench() {
        if std::env::var("TD_RECYCLE_BATCH_BENCH").as_deref() != Ok("1") {
            println!("MEASURE skipped: TD_RECYCLE_BATCH_BENCH!=1");
            return;
        }
        let root = std::env::temp_dir().join(format!("taskdock-recycle-bench-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut paths = Vec::new();
        for index in 0..60 {
            let file = root.join(format!("item-{index}.txt"));
            fs::write(&file, b"bench").unwrap();
            paths.push(file.to_string_lossy().into_owned());
        }
        let started = std::time::Instant::now();
        let report = delete_paths(&paths, false, &protected()).unwrap();
        println!(
            "MEASURE recycle_batch items={} ok={} failed={} ms={}",
            report.attempted,
            report.ok,
            report.failed,
            started.elapsed().as_millis()
        );
        assert_eq!(report.ok, 60, "真实回收站批量删除应全部成功");
        let _ = fs::remove_dir_all(&root);
        println!("MEASURE note: 测试条目保留在回收站，前缀 taskdock-recycle-bench-*");
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

    #[test]
    fn rename_allows_case_only_change() {
        let root = temp_root("rename-case");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("CaseOnly.txt");
        fs::write(&source, "x").unwrap();
        let renamed = rename(&source, "caseonly.txt").unwrap();
        assert_eq!(renamed.file_name().unwrap().to_string_lossy(), "caseonly.txt");
        assert!(root.join("caseonly.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn batch_rename_allows_case_only_change() {
        let root = temp_root("batch-case");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("CaseOnly.txt");
        fs::write(&source, "x").unwrap();
        let items = vec![BatchRenameItem {
            path: source.to_string_lossy().into_owned(),
            new_name: "caseonly.txt".into(),
        }];
        let report = batch_rename(&items, &[], None);
        assert_eq!(report.ok, 1, "report: {report:?}");
        assert!(root.join("caseonly.txt").exists());
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
        assert!(stat.attributes.contains(&"directory"));
        let stat = stat_path(&root.join("missing").to_string_lossy());
        assert_eq!(stat.exists, false);
        assert!(stat.attributes.is_empty());
        assert_eq!(stat.accessed_ms, None);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn attribute_names_maps_bits_without_duplicates() {
        assert_eq!(attribute_names(0), vec!["normal"]);
        let names = attribute_names(FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN);
        assert_eq!(names, vec!["readonly", "hidden"]);
        let names = attribute_names(FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY);
        assert!(names.contains(&"reparse"));
        assert!(names.contains(&"directory"));
        assert!(!names.contains(&"normal"));
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

    // ── P0 安全：路径规范化 / 保护边界 / 重解析点 / 占用与回滚 ─────────────

    #[test]
    fn normalize_lexical_resolves_dots_separators_and_prefixes() {
        assert_eq!(normalize_lexical(Path::new(r"C:\a\..\b")), PathBuf::from(r"C:\b"));
        assert_eq!(normalize_lexical(Path::new(r"C:\a\.\b\")), PathBuf::from(r"C:\a\b"));
        assert_eq!(normalize_lexical(Path::new(r"C:\..")), PathBuf::from(r"C:\"));
        assert_eq!(normalize_lexical(Path::new(r"c:/x/Y")), PathBuf::from(r"C:\x\Y"));
        assert_eq!(normalize_lexical(Path::new(r"\\?\C:\a\b")), PathBuf::from(r"C:\a\b"));
        assert_eq!(
            normalize_lexical(Path::new(r"\\?\UNC\srv\share\a")),
            PathBuf::from(r"\\srv\share\a")
        );
        assert_eq!(normalize_lexical(Path::new(r"\\srv\share")), PathBuf::from(r"\\srv\share"));
        assert_eq!(normalize_lexical(Path::new(r"C:\a\..\..\..")), PathBuf::from(r"C:\"));
    }

    #[test]
    fn is_under_respects_component_boundary() {
        let root = temp_root("under");
        let prot = root.join("appdata");
        let lookalike = root.join("appdatabackup");
        assert!(is_under(&prot.join("x"), &prot));
        assert!(is_under(&prot, &prot));
        // 前缀相似但分量不同：不在保护内（P0：旧前缀比较会误伤）。
        assert!(!is_under(&lookalike, &prot));
        // `..` 穿越先被词法解析：跳出保护目录的不匹配，落入的匹配。
        assert!(!is_under(&prot.join("..").join("elsewhere"), &prot));
        assert!(is_under(&root.join("appdata").join("sub").join("..").join("f"), &prot));
        // 大小写与正斜杠分隔符。
        let weird = PathBuf::from(prot.to_string_lossy().to_ascii_uppercase().replace('\\', "/"));
        assert!(is_under(&weird.join("f.txt"), &prot));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn protected_prefix_lookalike_is_deletable_inner_is_not() {
        let root = temp_root("protedge");
        let prot = root.join("protected");
        let lookalike = root.join("protected-backup");
        fs::create_dir_all(&prot).unwrap();
        fs::create_dir_all(&lookalike).unwrap();
        fs::write(lookalike.join("keep.txt"), "x").unwrap();
        // 相似前缀路径不属于保护目录：允许删除。
        let report = delete_paths(
            &[lookalike.join("keep.txt").to_string_lossy().into_owned()],
            true,
            &[prot.clone()],
        )
        .unwrap();
        assert_eq!(report.ok, 1);
        assert!(!lookalike.join("keep.txt").exists());
        // 保护目录内部：整批拒绝。
        fs::write(prot.join("inner.txt"), "x").unwrap();
        let result = delete_paths(
            &[prot.join("inner.txt").to_string_lossy().into_owned()],
            true,
            &[prot.clone()],
        );
        assert!(matches!(result, Err(AppError::Validation(_))));
        assert!(prot.join("inner.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn traversal_into_protected_is_rejected() {
        let root = temp_root("traversal");
        let prot = root.join("protected");
        fs::create_dir_all(prot.join("deep")).unwrap();
        fs::write(prot.join("deep/secret.txt"), "x").unwrap();
        fs::create_dir_all(root.join("unrelated")).unwrap();
        let sneaky = root.join("unrelated").join("..").join("protected").join("deep").join("secret.txt");
        let result = delete_paths(&[sneaky.to_string_lossy().into_owned()], true, &[prot.clone()]);
        assert!(matches!(result, Err(AppError::Validation(_))));
        assert!(prot.join("deep/secret.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    fn make_junction(link: &Path, target: &Path) -> bool {
        let _ = fs::remove_dir_all(link);
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn junction_bypass_into_protected_is_rejected() {
        let root = temp_root("juncbypass");
        let prot = root.join("protected");
        fs::create_dir_all(&prot).unwrap();
        fs::write(prot.join("secret.txt"), "x").unwrap();
        let link = root.join("junk");
        if make_junction(&link, &prot) {
            // 目标目录是 junction（真实路径在保护目录内）：写入侧拒绝。
            let result = copy_paths(
                &[root.join("src.txt").to_string_lossy().into_owned()],
                &link,
                Conflict::Rename,
                &[prot.clone()],
            );
            assert!(matches!(result, Err(AppError::Validation(_))));
            let _ = fs::remove_dir(&link);
        } else {
            eprintln!("ENVIRONMENT BLOCKED: junction 创建失败，跳过真实路径断言");
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn deleting_junction_keeps_target_both_modes() {
        let root = temp_root("juncdel");
        let target = root.join("real-target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("marker.txt"), "keep").unwrap();
        // 回收站删除（permanent=false，SHFileOperationW）：删链接本身，目标完好。
        let link = root.join("to-target");
        if make_junction(&link, &target) {
            let report = delete_paths(&[link.to_string_lossy().into_owned()], false, &protected()).unwrap();
            assert_eq!(report.ok, 1, "回收站删除报告: {:?}", report.entries);
            assert!(!link.exists());
            assert!(target.join("marker.txt").exists());
        } else {
            eprintln!("ENVIRONMENT BLOCKED: junction 创建失败，跳过回收站断言");
        }
        // 永久删除：delete_tree 重解析点分支只删链接本身。
        let link2 = root.join("to-target2");
        if make_junction(&link2, &target) {
            let report = delete_paths(&[link2.to_string_lossy().into_owned()], true, &protected()).unwrap();
            assert_eq!(report.ok, 1, "永久删除报告: {:?}", report.entries);
            assert!(!link2.exists());
            assert!(target.join("marker.txt").exists());
        }
        assert!(target.join("marker.txt").exists(), "目标目录绝不能被误删");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn overwrite_locked_target_keeps_original_data() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = temp_root("ovlock");
        let src_dir = root.join("in");
        fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("new.txt");
        let dst = root.join("new.txt");
        fs::write(&src, "new-content").unwrap();
        fs::write(&dst, "old-content").unwrap();
        // 独占打开目标（share_mode 0）：真实模拟「覆盖复制中途失败」。
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&dst).unwrap();
        let report = copy_paths(
            &[src.to_string_lossy().into_owned()],
            &root,
            Conflict::Overwrite,
            &protected(),
        )
        .unwrap();
        drop(lock);
        assert_eq!(report.failed, 1, "覆盖失败必须如实报告: {:?}", report.entries);
        assert_eq!(fs::read_to_string(&dst).unwrap(), "old-content", "目标原数据必须保留");
        // 解锁后重试成功，且无临时文件残留。
        let report = copy_paths(
            &[src.to_string_lossy().into_owned()],
            &root,
            Conflict::Overwrite,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.ok, 1);
        assert_eq!(fs::read_to_string(&dst).unwrap(), "new-content");
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".taskdock-tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "临时文件必须清理: {leftovers:?}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn move_overwrite_locked_target_keeps_source_and_original() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = temp_root("mvovlock");
        let src_dir = root.join("in");
        fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("new.txt");
        let dst = root.join("new.txt");
        fs::write(&src, "new-content").unwrap();
        fs::write(&dst, "old-content").unwrap();
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&dst).unwrap();
        let report = move_paths(
            &[src.to_string_lossy().into_owned()],
            &root,
            Conflict::Overwrite,
            &protected(),
        )
        .unwrap();
        drop(lock);
        assert_eq!(report.ok, 0, "目标被占用时不能报告移动成功: {:?}", report.entries);
        assert_eq!(report.failed, 1, "{:?}", report.entries);
        assert!(src.exists(), "落位失败时源文件必须保留");
        assert_eq!(fs::read_to_string(&dst).unwrap(), "old-content", "旧目标不能被提前删除");
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".taskdock-tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "临时文件必须清理: {leftovers:?}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn move_locked_source_fails_without_half_state() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = temp_root("mvlock");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        let f = src_dir.join("busy.txt");
        fs::write(&f, "busy").unwrap();
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&f).unwrap();
        let report = move_paths(
            &[f.to_string_lossy().into_owned()],
            &dst_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        drop(lock);
        assert_eq!(report.failed, 1);
        assert!(f.exists(), "源必须保留");
        assert_eq!(fs::read_to_string(&f).unwrap(), "busy");
        assert!(!dst_dir.join("busy.txt").exists(), "不得留下半个状态");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copy_partial_success_reports_each_entry() {
        let root = temp_root("partial");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("good.txt"), "g").unwrap();
        let report = copy_paths(
            &[
                src_dir.join("good.txt").to_string_lossy().into_owned(),
                src_dir.join("missing.txt").to_string_lossy().into_owned(),
            ],
            &dst_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.ok, 1);
        assert_eq!(report.failed, 1);
        assert!(dst_dir.join("good.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copy_fresh_failure_leaves_no_partial_target() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = temp_root("copyfreshfail");
        let src_dir = root.join("in");
        fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("busy.txt");
        fs::write(&src, "busy-content").unwrap();
        // 独占锁定源（share_mode 0）：fs::copy 打开源即被拒绝，模拟复制中途失败。
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&src).unwrap();
        let report = copy_paths(
            &[src.to_string_lossy().into_owned()],
            &root,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        drop(lock);
        assert_eq!(report.failed, 1, "复制失败必须如实报告: {:?}", report.entries);
        assert!(
            !root.join("busy.txt").exists(),
            "失败的全新目标不得残留半截文件"
        );
        assert!(src.exists(), "源必须完整保留");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copy_depth_limit_keeps_source_intact() {
        let root = temp_root("deep");
        let mut cur = root.clone();
        // 用单字符目录名：70 层 × 2 字符仍在 MAX_PATH(260) 内。
        // 旧夹具用 `d{i}`（4 字符/层 ≈ 290 字符），在 Windows 上先撞到路径长度限制，
        // 被测的「深度上限」永远不会触发，断言必然失败。
        for i in 0..70 {
            cur = cur.join(((b'a' + (i % 26) as u8) as char).to_string());
        }
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join("leaf.txt"), "leaf").unwrap();
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let report = copy_paths(
            &[root.join("a").to_string_lossy().into_owned()],
            &out,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        // 深度超限发生在「已经复制了前 64 层」之后：目标目录已有内容，
        // 因此按 partial 上报（内容部分落地 + 原因「已中止」），不是 failed。
        assert_eq!(report.failed, 0);
        assert_eq!(report.partial, 1, "部分复制必须计入 partial，不能算成功");
        assert!(report.entries[0].reason.as_deref().unwrap().contains("中止"));
        // D-11：reason 面向用户与诊断日志，不得带出临时根目录/用户目录的绝对路径
        let reason = report.entries[0].reason.clone().unwrap_or_default();
        assert!(!reason.contains(&root.to_string_lossy().to_string()), "reason 不得泄露绝对路径");
        assert!(cur.join("leaf.txt").exists(), "源必须完整保留");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copy_three_sources_continues_after_bad_item() {
        // D-10：三源批量中的第二项坏掉，第一/第三项仍必须各自处理，整批不得提前中止。
        let root = temp_root("d10copy");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("good1.txt"), "one").unwrap();
        fs::write(src_dir.join("good2.txt"), "two").unwrap();
        let report = copy_paths(
            &[
                src_dir.join("good1.txt").to_string_lossy().into_owned(),
                src_dir.join("missing-middle.txt").to_string_lossy().into_owned(),
                src_dir.join("good2.txt").to_string_lossy().into_owned(),
            ],
            &dst_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.attempted, 3);
        assert_eq!(report.ok, 2, "坏条目不得连坐后续条目");
        assert_eq!(report.failed, 1);
        assert!(dst_dir.join("good1.txt").exists());
        assert!(dst_dir.join("good2.txt").exists(), "第二项失败后第三项仍须复制");
        assert_eq!(fs::read_to_string(dst_dir.join("good2.txt")).unwrap(), "two");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn move_three_sources_continues_after_bad_item() {
        let root = temp_root("d10move");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("m1.txt"), "one").unwrap();
        fs::write(src_dir.join("m2.txt"), "two").unwrap();
        let report = move_paths(
            &[
                src_dir.join("m1.txt").to_string_lossy().into_owned(),
                src_dir.join("missing-middle.txt").to_string_lossy().into_owned(),
                src_dir.join("m2.txt").to_string_lossy().into_owned(),
            ],
            &dst_dir,
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.ok, 2, "移动批次同样逐条独立");
        assert_eq!(report.failed, 1);
        assert!(dst_dir.join("m1.txt").exists() && dst_dir.join("m2.txt").exists());
        assert!(!src_dir.join("m1.txt").exists() && !src_dir.join("m2.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tmp_display_name_never_leaks_directory() {
        // D-11：失败原因里只允许出现临时文件名，不允许整个 Windows 用户目录。
        let tmp = Path::new(r"C:\Users\ASUS\AppData\Local\Temp\taskdock\..taskdock-tmp-123-a.txt");
        assert_eq!(tmp_display_name(tmp), "..taskdock-tmp-123-a.txt");
        assert!(!tmp_display_name(tmp).contains("Users"));
        assert!(!tmp_display_name(tmp).contains("\\"));
        assert_eq!(tmp_display_name(Path::new("C:\\")), "临时文件", "无文件名时用占位词");
    }

    #[test]
    fn move_dir_into_own_subtree_rejected() {
        let root = temp_root("mvsub");
        let src_dir = root.join("src");
        fs::create_dir_all(src_dir.join("inner")).unwrap();
        fs::write(src_dir.join("inner/f.txt"), "f").unwrap();
        let report = move_paths(
            &[src_dir.to_string_lossy().into_owned()],
            &src_dir.join("inner"),
            Conflict::Rename,
            &protected(),
        )
        .unwrap();
        assert_eq!(report.failed, 1);
        assert!(src_dir.join("inner/f.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn round3_cancel_inside_native_copy_preserves_existing_target() {
        let root = temp_root("native-copy-cancel");
        let src = root.join("source.bin");
        let dst = root.join("target.bin");
        fs::write(&src, vec![42; 8 * 1024 * 1024]).unwrap();
        fs::write(&dst, b"original").unwrap();
        let calls = std::cell::Cell::new(0);
        let error = copy_file(&src, &dst, Conflict::Overwrite, &|| {
            calls.set(calls.get() + 1);
            calls.get() >= 2
        })
        .unwrap_err();
        assert_eq!(error.code, FS_OP_CANCELLED);
        assert!(
            calls.get() >= 3,
            "native copy invoked cancellation before returning"
        );
        assert_eq!(fs::read(&dst).unwrap(), b"original");
        assert_eq!(fs::metadata(&src).unwrap().len(), 8 * 1024 * 1024);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn round3_no_replace_preserves_concurrent_target_and_source() {
        let root = temp_root("copy-no-replace");
        let src = root.join("source.txt");
        let dst = root.join("target.txt");
        fs::write(&src, b"source").unwrap();
        let injected = std::cell::Cell::new(false);
        let result = copy_file(&src, &dst, Conflict::Rename, &|| {
            if !injected.get() && fs::read_dir(&root).unwrap().count() > 1 {
                fs::write(&dst, b"concurrent").unwrap();
                injected.set(true);
            }
            false
        });
        assert!(result.is_err());
        assert!(injected.get());
        assert_eq!(fs::read(&dst).unwrap(), b"concurrent");
        assert_eq!(fs::read(&src).unwrap(), b"source");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backend_round2_exhausted_copy_budget_returns_error_instead_of_panicking() {
        let root = temp_root("zero-budget");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("keep.txt"), "keep").unwrap();
        let mut budget = 0;
        assert!(copy_dir(&source, &root.join("first"), 0, &mut budget, &|| false, Conflict::Rename).is_err());
        assert!(copy_dir(&source, &root.join("second"), 0, &mut budget, &|| false, Conflict::Rename).is_err());
        assert!(source.join("keep.txt").exists());
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backend_round2_transfers_cancel_between_items_and_keep_unprocessed_sources() {
        use std::cell::RefCell;
        use std::sync::atomic::{AtomicBool, Ordering};
        for moving in [false, true] {
            let root = temp_root("cancel-transfer");
            let source = root.join("src");
            let target = root.join("dst");
            fs::create_dir_all(&source).unwrap();
            fs::create_dir_all(&target).unwrap();
            for name in ["a.txt", "b.txt", "c.txt"] { fs::write(source.join(name), name).unwrap(); }
            let paths: Vec<_> = ["a.txt", "b.txt", "c.txt"].iter()
                .map(|name| source.join(name).to_string_lossy().into_owned()).collect();
            let cancel = AtomicBool::new(false);
            let notified = RefCell::new(Vec::new());
            let progress = |entry: &FsEntryReport| {
                notified.borrow_mut().push(entry.source.clone());
                cancel.store(true, Ordering::SeqCst);
            };
            let run = if moving { super::move_paths_with_progress } else { super::copy_paths_with_progress };
            let report = run(&paths, &target, Conflict::Rename, None, &[],
                &|| cancel.load(Ordering::SeqCst), &progress).unwrap();
            assert_eq!(report.ok, 1);
            assert_eq!(*notified.borrow(), vec![paths[0].clone()]);
            assert!(target.join("a.txt").exists());
            assert!(!target.join("b.txt").exists());
            assert!(source.join("b.txt").exists() && source.join("c.txt").exists());
            assert_eq!(source.join("a.txt").exists(), !moving);
            assert!(root.starts_with(std::env::temp_dir()));
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn backend_round2_batch_rename_cancel_keeps_unprocessed_names() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let root = temp_root("rename-cancel");
        for name in ["a.txt", "b.txt"] { fs::write(root.join(name), name).unwrap(); }
        let items: Vec<_> = ["a.txt", "b.txt"].iter().map(|name| BatchRenameItem {
            path: root.join(name).to_string_lossy().into_owned(), new_name: format!("new-{name}"),
        }).collect();
        let cancel = AtomicBool::new(false);
        let report = super::batch_rename_with_progress(&items, &[], Some("rename-test".into()),
            &|| cancel.load(Ordering::SeqCst), &|_| { cancel.store(true, Ordering::SeqCst); });
        assert_eq!(report.ok, 1);
        assert_eq!(report.operation_id, "rename-test");
        assert!(root.join("new-a.txt").exists() && root.join("b.txt").exists());
        assert!(!root.join("a.txt").exists() && !root.join("new-b.txt").exists());
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backend_round2_nested_junction_never_claims_complete_copy() {
        let root = temp_root("nested-junction");
        let source = root.join("source");
        let target = root.join("target");
        let external = root.join("external");
        for path in [&source, &target, &external] { fs::create_dir_all(path).unwrap(); }
        fs::write(external.join("keep.txt"), "keep").unwrap();
        let link = source.join("link");
        assert!(make_junction(&link, &external), "测试环境必须能创建 junction");
        let report = super::copy_paths(&[source.to_string_lossy().into_owned()], &target, Conflict::Rename, None, &[]).unwrap();
        assert_eq!(report.ok, 0);
        assert_eq!(report.failed + report.partial, 1);
        assert!(external.join("keep.txt").exists());
        fs::remove_dir(&link).unwrap();
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_rename_success_and_partial_failure_are_reported() {
        let root = temp_root("batchrn");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        let report = batch_rename(
            &[
                BatchRenameItem {
                    path: root.join("a.txt").to_string_lossy().into_owned(),
                    new_name: "001.txt".into(),
                },
                BatchRenameItem {
                    path: root.join("b.txt").to_string_lossy().into_owned(),
                    new_name: "bad/name.txt".into(),
                },
            ],
            &protected(),
            None,
        );
        assert_eq!(report.ok, 1);
        assert_eq!(report.failed, 1);
        assert!(root.join("001.txt").exists());
        assert!(root.join("b.txt").exists(), "失败项不能被静默删除或覆盖");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn batch_rename_duplicate_targets_are_all_rejected_before_write() {
        let root = temp_root("batchdup");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        let report = batch_rename(
            &[
                BatchRenameItem {
                    path: root.join("a.txt").to_string_lossy().into_owned(),
                    new_name: "same.txt".into(),
                },
                BatchRenameItem {
                    path: root.join("b.txt").to_string_lossy().into_owned(),
                    new_name: "same.txt".into(),
                },
            ],
            &protected(),
            None,
        );
        assert_eq!(report.ok, 0);
        assert_eq!(report.failed, 2, "整组重复目标必须在执行前拒绝");
        assert!(root.join("a.txt").exists() && root.join("b.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn batch_rename_existing_target_is_conflict_without_overwrite() {
        let root = temp_root("batchconf");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("target.txt"), "keep").unwrap();
        let report = batch_rename(
            &[BatchRenameItem {
                path: root.join("a.txt").to_string_lossy().into_owned(),
                new_name: "target.txt".into(),
            }],
            &protected(),
            None,
        );
        assert_eq!(report.ok, 0);
        assert_eq!(report.failed, 1);
        assert_eq!(fs::read_to_string(root.join("target.txt")).unwrap(), "keep");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn hash_files_distinguishes_content_and_rejects_directory() {
        let root = temp_root("hash");
        fs::create_dir_all(root.join("d")).unwrap();
        fs::write(root.join("same1.txt"), "same").unwrap();
        fs::write(root.join("same2.txt"), "same").unwrap();
        fs::write(root.join("diff.txt"), "different").unwrap();
        let entries = hash_files(
            &[
                root.join("same1.txt").to_string_lossy().into_owned(),
                root.join("same2.txt").to_string_lossy().into_owned(),
                root.join("diff.txt").to_string_lossy().into_owned(),
                root.join("d").to_string_lossy().into_owned(),
            ],
            &protected(),
        );
        assert_eq!(entries[0].hash, entries[1].hash);
        assert_ne!(entries[0].hash, entries[2].hash);
        assert!(entries[3].error.is_some(), "目录不参与文件哈希");
        fs::remove_dir_all(&root).unwrap();
    }
}
