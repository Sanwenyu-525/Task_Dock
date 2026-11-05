//! 暂存架文件操作：移动原文件、复制到目录、最近目录与失效重定位。
//!
//! 安全边界：
//! - 条目路径一律从数据库按 id 读取，前端传入的源路径不予采信；
//! - managed 托管副本只能「导出副本」，绝不当外部原文件移动；
//! - 同名冲突默认跳过，或按 `名称 (1).ext` 自动改名，绝不静默覆盖；
//! - 跨卷移动先流式复制到 `.shelf-part`，完整校验后才删除源文件；
//! - 磁盘移动与 SQLite 引用更新非原子，通过 `shelf_file_ops` 日志在启动时恢复。

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use super::*;

/// 单批允许处理的条目上限（与添加接口一致量级，避免一次卡住阻塞线程过久）。
const MAX_BATCH: usize = 200;
/// 最近目录保留数量（含固定项）。
pub const MAX_RECENT_DIRS: usize = 8;
/// 跨卷复制临时文件后缀：崩溃恢复只清理带此后缀的文件。
const PART_SUFFIX: &str = ".shelf-part";
/// 文件夹递归复制深度上限（防御联接点/异常目录结构）。
const MAX_TREE_DEPTH: u32 = 64;
/// Windows 重解析点属性（符号链接、联接点、挂载点等）。
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// 测试专用故障注入：线程本地，避免并行用例互相影响；生产构建不包含。
#[cfg(test)]
pub(crate) mod test_support {
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        static POINTS: RefCell<HashMap<&'static str, u32>> = RefCell::new(HashMap::new());
    }

    pub(crate) fn set_once(name: &'static str) {
        POINTS.with(|p| {
            p.borrow_mut().insert(name, 1);
        });
    }

    pub(crate) fn set_always(name: &'static str) {
        POINTS.with(|p| {
            p.borrow_mut().insert(name, u32::MAX);
        });
    }

    pub(crate) fn enabled(name: &'static str) -> bool {
        POINTS.with(|p| p.borrow().get(name).copied().unwrap_or(0) > 0)
    }

    pub(crate) fn take(name: &'static str) -> bool {
        POINTS.with(|p| {
            let mut map = p.borrow_mut();
            match map.get_mut(name) {
                Some(n) if *n > 0 => {
                    *n = u32::MAX.min(*n - 1);
                    true
                }
                _ => false,
            }
        })
    }

    pub(crate) fn clear() {
        POINTS.with(|p| p.borrow_mut().clear());
    }
}

fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// 目录/文件快照：相对路径、大小、修改时间。用于检测复制/校验期间源发生变化。
#[derive(Debug, PartialEq, Eq)]
struct SourceSnapshot {
    /// 相对路径（小写），目录以 `/` 结尾以区分空目录。
    entries: Vec<(String, u64, u128)>,
}

fn rel_key(path: &Path, root: &Path, is_dir: bool) -> AppResult<String> {
    let rel = path
        .strip_prefix(root)
        .map_err(|_| AppError::Validation("校验路径越界".into()))?;
    let mut key = rel.to_string_lossy().replace('\\', "/").to_lowercase();
    if is_dir && !key.is_empty() {
        key.push('/');
    }
    Ok(key)
}

fn modified_nanos(meta: &std::fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// 递归快照（不读取文件内容）：拒绝符号链接/重解析点/不支持类型。
fn snapshot_source(path: &Path) -> AppResult<SourceSnapshot> {
    let root_meta = std::fs::symlink_metadata(path)?;
    if is_reparse_point(&root_meta) {
        return Err(AppError::Validation(format!(
            "路径是符号链接/联接点/重解析点，暂不支持文件操作: {}",
            path.display()
        )));
    }
    if root_meta.is_file() {
        return Ok(SourceSnapshot {
            entries: vec![(
                String::new(),
                root_meta.len(),
                modified_nanos(&root_meta),
            )],
        });
    }
    if !root_meta.is_dir() {
        return Err(AppError::Validation(format!(
            "路径不是普通文件或文件夹: {}",
            path.display()
        )));
    }
    let mut entries = Vec::new();
    let mut visited = HashSet::new();
    let mut stack: Vec<(PathBuf, u32)> = vec![(path.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_TREE_DEPTH {
            return Err(AppError::Validation("文件夹层级过深，已停止校验".into()));
        }
        let canon = std::fs::canonicalize(&dir)?;
        if !visited.insert(canon) {
            return Err(AppError::Validation(format!(
                "检测到目录循环或联接点: {}",
                dir.display()
            )));
        }
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            let child = entry.path();
            if is_reparse_point(&meta) {
                return Err(AppError::Validation(format!(
                    "路径包含符号链接/联接点/重解析点，暂不支持文件操作: {}",
                    child.display()
                )));
            }
            if meta.is_dir() {
                // 目录修改时间在 Windows 上可能因写回延迟而变化，不作为变化判据；
                // 目录结构由路径集合与复制后校验覆盖。
                entries.push((rel_key(&child, path, true)?, 0, 0));
                stack.push((child, depth + 1));
            } else if meta.is_file() {
                entries.push((
                    rel_key(&child, path, false)?,
                    meta.len(),
                    modified_nanos(&meta),
                ));
            } else {
                return Err(AppError::Validation(format!(
                    "路径包含不支持的文件类型: {}",
                    child.display()
                )));
            }
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(SourceSnapshot { entries })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictStrategy {
    Skip,
    Rename,
}

pub fn parse_conflict_strategy(raw: &str) -> AppResult<ConflictStrategy> {
    match raw {
        "" | "skip" => Ok(ConflictStrategy::Skip),
        "rename" => Ok(ConflictStrategy::Rename),
        other => Err(AppError::Validation(format!(
            "未知同名冲突策略: {other}（仅支持 skip / rename）"
        ))),
    }
}

#[derive(Debug, Serialize)]
pub struct ShelfOpEntry {
    pub id: String,
    pub display_name: String,
    pub source: Option<String>,
    pub target: Option<String>,
    /// ok / skipped / failed / partial
    ///
    /// partial：文件已完整复制并校验到目标，但源清理或记录更新未完成。
    /// 该状态不会被 `remove_after` 自动移除记录，保留人工确认入口。
    pub status: String,
    pub reason: Option<String>,
    /// 部分完成时的建议动作（兼容扩展字段，前端可忽略）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    /// 部分完成时仍残留的源路径（兼容扩展字段，前端可忽略）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub residual_source: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ShelfOpReport {
    pub success: i64,
    pub skipped: i64,
    pub failed: i64,
    /// 文件操作成功但源清理/记录更新未完成的数量（兼容扩展字段）
    pub partial: i64,
    /// 操作成功后按用户选择从暂存架移除的记录数
    pub removed: i64,
    /// 记录已移除但托管文件清理失败的数量（下次清理兜底）
    pub remove_failed_files: i64,
    /// 文件操作成功但移除暂存记录失败的数量（兼容扩展字段）
    pub record_cleanup_failed: i64,
    /// 记录清理失败的原因摘要（兼容扩展字段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_cleanup_error: Option<String>,
    pub entries: Vec<ShelfOpEntry>,
}

#[derive(Debug, Serialize)]
pub struct ShelfRecentDir {
    pub path: String,
    pub pinned: bool,
    pub last_used_at: String,
    /// 仅在打开面板/执行时探测；启动阶段不扫描目录
    pub available: bool,
}

// ── 并发保护 ────────────────────────────────────────────────

static ACTIVE_OPS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn active_ops() -> &'static Mutex<HashSet<String>> {
    ACTIVE_OPS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 批次级占用：同一批 id 只允许一个文件操作，重复点击返回可读错误。
struct OpClaim {
    ids: Vec<String>,
}

impl Drop for OpClaim {
    fn drop(&mut self) {
        let mut set = active_ops().lock().unwrap_or_else(|e| e.into_inner());
        for id in &self.ids {
            set.remove(id);
        }
    }
}

fn claim_ids(ids: &[String]) -> AppResult<OpClaim> {
    let mut set = active_ops().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(busy) = ids.iter().find(|id| set.contains(*id)) {
        return Err(AppError::Conflict(format!(
            "条目 {busy} 正在被其他文件操作处理，请稍后再试"
        )));
    }
    for id in ids {
        set.insert(id.clone());
    }
    Ok(OpClaim { ids: ids.to_vec() })
}

/// 物理路径占用：不同条目 id 指向同一路径时也串行化，避免并发批次互相覆盖。
static ACTIVE_PATHS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn active_paths() -> &'static Mutex<HashSet<String>> {
    ACTIVE_PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

struct PathClaim {
    keys: Vec<String>,
}

impl Drop for PathClaim {
    fn drop(&mut self) {
        let mut set = active_paths().lock().unwrap_or_else(|e| e.into_inner());
        for key in &self.keys {
            set.remove(key);
        }
    }
}

fn claim_paths(keys: &[String]) -> AppResult<PathClaim> {
    if keys.is_empty() {
        return Ok(PathClaim { keys: Vec::new() });
    }
    let mut set = active_paths().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(busy) = keys.iter().find(|key| set.contains(*key)) {
        return Err(AppError::Conflict(format!(
            "路径 {busy} 正在被其他文件操作处理，请稍后再试"
        )));
    }
    for key in keys {
        set.insert(key.clone());
    }
    Ok(PathClaim { keys: keys.to_vec() })
}

fn path_claim_key(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_lowercase()
}

fn path_depth(path: &Path) -> usize {
    path.components().count()
}

fn is_strict_descendant(path: &Path, ancestor: &Path) -> bool {
    strip_under_ci(path, ancestor)
        .map(|rest| !rest.as_os_str().is_empty())
        .unwrap_or(false)
}

// ── 公共辅助 ────────────────────────────────────────────────

fn dedup_ids(ids: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        if seen.insert(id.to_string()) {
            out.push(id.to_string());
        }
    }
    if out.is_empty() {
        return Err(AppError::Validation("未选择任何条目".into()));
    }
    if out.len() > MAX_BATCH {
        return Err(AppError::Validation(format!(
            "单批最多处理 {MAX_BATCH} 个条目"
        )));
    }
    Ok(out)
}

fn load_items(db: &Db, ids: &[String]) -> AppResult<HashMap<String, ShelfItem>> {
    let ph = placeholders(ids.len());
    let sql = format!("SELECT {ITEM_COLS} FROM shelf_items WHERE id IN ({ph})");
    let rows = db.with_read(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(ids.iter()), item_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)
    })?;
    Ok(rows.into_iter().map(|i| (i.id.clone(), i)).collect())
}

/// 目标目录：绝对路径、必须存在且为目录；禁止指向暂存架内部（避免被清理兜底误删）。
pub fn normalize_target_dir(raw: &str, root: &Path) -> AppResult<PathBuf> {
    let dir = normalize_original_path(raw)?;
    let meta = std::fs::metadata(&dir).map_err(|e| {
        AppError::NotFound(format!("目标目录不可访问: {}（{e}）", dir.display()))
    })?;
    if !meta.is_dir() {
        return Err(AppError::Validation(format!(
            "目标不是目录: {}",
            dir.display()
        )));
    }
    if let Ok(root_c) = std::fs::canonicalize(root) {
        if let Ok(dir_c) = std::fs::canonicalize(&dir) {
            if dir_c.starts_with(&root_c) {
                return Err(AppError::Validation(
                    "不能把暂存架内部目录作为文件操作目标".into(),
                ));
            }
        }
    }
    Ok(dir)
}

fn source_name(src: &Path) -> AppResult<OsString> {
    src.file_name()
        .map(|n| n.to_os_string())
        .ok_or_else(|| AppError::Validation("源路径缺少文件名".into()))
}

/// 解析条目当前可操作的物理路径；link/text 无文件语义直接拒绝。
fn op_source(root: &Path, item: &ShelfItem) -> AppResult<PathBuf> {
    match (item.kind.as_str(), item.storage_mode.as_str()) {
        (KIND_LINK, _) => Err(AppError::Validation("链接条目没有可操作的文件".into())),
        (KIND_TEXT, _) => Err(AppError::Validation("文本条目没有可操作的文件".into())),
        (_, MODE_MANAGED) => {
            let rel = item
                .managed_path
                .as_deref()
                .ok_or_else(|| AppError::Validation("托管条目缺少文件路径".into()))?;
            let p = root.join(safe_managed_rel(rel)?);
            if !p.exists() {
                return Err(AppError::NotFound(
                    "托管副本已丢失（可能被外部删除），请通过备份恢复".into(),
                ));
            }
            Ok(p)
        }
        _ => {
            let raw = item
                .original_path
                .as_deref()
                .ok_or_else(|| AppError::Validation("条目缺少原路径".into()))?;
            let p = normalize_original_path(raw)?;
            if !p.exists() {
                return Err(AppError::NotFound(
                    "原文件已失效，请先重新定位".into(),
                ));
            }
            Ok(p)
        }
    }
}

fn same_volume(a: &Path, b: &Path) -> bool {
    fn prefix(p: &Path) -> Option<String> {
        p.components().next().and_then(|c| match c {
            Component::Prefix(_) => Some(format!("{:?}", c)),
            _ => None,
        })
    }
    match (prefix(a), prefix(b)) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(&y),
        _ => false,
    }
}

fn components_ci_eq(a: &Component<'_>, b: &Component<'_>) -> bool {
    match (a, b) {
        (Component::Prefix(x), Component::Prefix(y)) => {
            format!("{x:?}").eq_ignore_ascii_case(&format!("{y:?}"))
        }
        (Component::RootDir, Component::RootDir) => true,
        (Component::CurDir, Component::CurDir) => true,
        (Component::ParentDir, Component::ParentDir) => true,
        (Component::Normal(x), Component::Normal(y)) => x
            .to_string_lossy()
            .eq_ignore_ascii_case(&y.to_string_lossy()),
        _ => false,
    }
}

/// candidate 是否位于 base 之内（含 base 本身，Windows 大小写不敏感）。
fn strip_under_ci(candidate: &Path, base: &Path) -> Option<PathBuf> {
    let mut cit = candidate.components();
    for b in base.components() {
        let c = cit.next()?;
        if !components_ci_eq(&c, &b) {
            return None;
        }
    }
    let mut rest = PathBuf::new();
    for c in cit {
        match c {
            Component::Normal(s) => rest.push(s),
            _ => return None,
        }
    }
    Some(rest)
}

fn parent_eq_ci(a: &Path, b: &Path) -> bool {
    match (a.parent(), Some(b)) {
        (Some(p), Some(q)) => {
            let mut pc = p.components();
            let mut qc = q.components();
            loop {
                match (pc.next(), qc.next()) {
                    (None, None) => return true,
                    (Some(x), Some(y)) if components_ci_eq(&x, &y) => {}
                    _ => return false,
                }
            }
        }
        _ => false,
    }
}

/// 生成目标路径：默认跳过同名；rename 时按 `名称 (n).ext`（文件夹不带扩展名拆分）。
fn resolve_target(
    dir: &Path,
    name: &OsString,
    is_dir: bool,
    strategy: ConflictStrategy,
) -> AppResult<(PathBuf, bool)> {
    let first = dir.join(name);
    if !first.exists() {
        return Ok((first, false));
    }
    if strategy == ConflictStrategy::Skip {
        return Ok((first, true));
    }
    let name_path = Path::new(name);
    let (stem, ext) = if is_dir {
        (name.to_string_lossy().into_owned(), String::new())
    } else {
        (
            name_path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| name.to_string_lossy().into_owned()),
            name_path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default(),
        )
    };
    for n in 1..=999u32 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return Ok((candidate, false));
        }
    }
    Err(AppError::Conflict(format!(
        "目标目录中同名文件过多，无法自动重命名: {}",
        first.display()
    )))
}

/// 临时副本名：`.原名.<uuid>.shelf-part`，仅本次操作创建，绝不预先删除同名文件。
fn part_path(target: &Path) -> AppResult<PathBuf> {
    let name = source_name(target)?;
    let part = format!(
        ".{}.{}{}",
        name.to_string_lossy(),
        uuid::Uuid::new_v4(),
        PART_SUFFIX
    );
    Ok(target.with_file_name(part))
}

fn is_part_name(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().ends_with(PART_SUFFIX))
        .unwrap_or(false)
}

/// 仅用于本次操作创建的临时副本：失败要记录，但绝不吞掉异常或触碰用户数据。
fn remove_best_effort(path: &Path) {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() && !is_reparse_point(&m) => {
            if let Err(e) = std::fs::remove_dir_all(path) {
                tracing::warn!("临时目录清理失败（不影响源与目标）: {} ({e})", path.display());
            }
        }
        Ok(_) => {
            if let Err(e) = std::fs::remove_file(path) {
                tracing::warn!("临时文件清理失败（不影响源与目标）: {} ({e})", path.display());
            }
        }
        Err(_) => {}
    }
}

fn remove_part(part: &Path) {
    if is_part_name(part) {
        remove_best_effort(part);
    }
}

fn copy_file_stream(src: &Path, dst: &Path) -> AppResult<u64> {
    let mut reader = std::fs::File::open(src)?;
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)?;
    let mut written = 0u64;
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
    // 删除源文件之前必须确认落盘（掉电/崩溃恢复依赖完整副本）。
    writer.sync_all()?;
    Ok(written)
}

/// 流式逐字节校验（不整体读入内存）；失败即视为复制不完整。
fn verify_files_equal(src: &Path, dst: &Path) -> AppResult<()> {
    let a = std::fs::metadata(src)?;
    let b = std::fs::metadata(dst)?;
    if a.len() != b.len() {
        return Err(AppError::Conflict(format!(
            "复制校验失败：大小不一致（{} != {}）",
            a.len(),
            b.len()
        )));
    }
    let mut ra = std::fs::File::open(src)?;
    let mut rb = std::fs::File::open(dst)?;
    let mut ba = vec![0u8; COPY_CHUNK];
    let mut bb = vec![0u8; COPY_CHUNK];
    loop {
        let na = ra.read(&mut ba)?;
        let nb = rb.read(&mut bb)?;
        if na != nb {
            return Err(AppError::Conflict("复制校验失败：读取长度不一致".into()));
        }
        if na == 0 {
            return Ok(());
        }
        if ba[..na] != bb[..nb] {
            return Err(AppError::Conflict("复制校验失败：内容不一致".into()));
        }
    }
}

fn entry_meta(path: &Path) -> AppResult<std::fs::Metadata> {
    std::fs::symlink_metadata(path).map_err(AppError::from)
}

/// 递归复制目录；拒绝符号链接/联接点/重解析点，按 canonical 目录去重防循环。
fn copy_tree(src: &Path, dst: &Path) -> AppResult<(u64, u64)> {
    let root_meta = entry_meta(src)?;
    if is_reparse_point(&root_meta) {
        return Err(AppError::Validation(
            "源文件夹是符号链接/联接点/重解析点，暂不支持跨盘移动".into(),
        ));
    }
    if !root_meta.is_dir() {
        return Err(AppError::Validation("源路径不是文件夹".into()));
    }
    std::fs::create_dir(dst)?;
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut visited = HashSet::new();
    let mut stack: Vec<(PathBuf, PathBuf, u32)> = vec![(src.to_path_buf(), dst.to_path_buf(), 0)];
    while let Some((sdir, ddir, depth)) = stack.pop() {
        if depth > MAX_TREE_DEPTH {
            return Err(AppError::Validation("文件夹层级过深，已停止复制".into()));
        }
        let canon = std::fs::canonicalize(&sdir)?;
        if !visited.insert(canon) {
            return Err(AppError::Validation(format!(
                "检测到目录循环或联接点: {}",
                sdir.display()
            )));
        }
        for entry in std::fs::read_dir(&sdir)? {
            let entry = entry?;
            let from = entry.path();
            let to = ddir.join(entry.file_name());
            let meta = std::fs::symlink_metadata(&from)?;
            if is_reparse_point(&meta) {
                return Err(AppError::Validation(format!(
                    "文件夹包含符号链接/联接点/重解析点，暂不支持跨盘移动: {}",
                    from.display()
                )));
            }
            if meta.is_dir() {
                std::fs::create_dir(&to)?;
                stack.push((from, to, depth + 1));
            } else if meta.is_file() {
                let n = copy_file_stream(&from, &to)?;
                files += 1;
                bytes += n;
            } else {
                return Err(AppError::Validation(format!(
                    "文件夹包含不支持的文件类型: {}",
                    from.display()
                )));
            }
        }
    }
    Ok((files, bytes))
}

struct TreeManifest {
    dirs: Vec<String>,
    files: Vec<(String, PathBuf, u64)>,
}

/// 目录清单：包含空目录与全部文件（相对路径小写 + 原始相对路径 + 大小）。
fn walk_tree(root: &Path) -> AppResult<TreeManifest> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path)?;
            if is_reparse_point(&meta) {
                return Err(AppError::Validation(format!(
                    "目录包含符号链接/联接点/重解析点，无法校验: {}",
                    path.display()
                )));
            }
            let rel = path
                .strip_prefix(root)
                .map_err(|_| AppError::Validation("校验路径越界".into()))?
                .to_path_buf();
            if meta.is_dir() {
                dirs.push(format!(
                    "{}/",
                    rel.to_string_lossy().replace('\\', "/").to_lowercase()
                ));
                stack.push(path);
            } else if meta.is_file() {
                files.push((
                    rel.to_string_lossy().replace('\\', "/").to_lowercase(),
                    rel,
                    meta.len(),
                ));
            } else {
                return Err(AppError::Validation(format!(
                    "目录包含不支持的文件类型: {}",
                    path.display()
                )));
            }
        }
    }
    dirs.sort();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(TreeManifest { dirs, files })
}

/// 目录复制后的完整性校验：
/// 1）目录结构（含空目录）一致；2）文件相对路径与大小一致；3）逐文件流式比对内容。
/// 不把整目录读入内存，也不引入哈希依赖。
fn verify_tree(src: &Path, dst: &Path) -> AppResult<()> {
    let a = walk_tree(src)?;
    let b = walk_tree(dst)?;
    if a.dirs != b.dirs {
        return Err(AppError::Conflict(
            "复制校验失败：目录结构不一致（含空目录）".into(),
        ));
    }
    let a_meta: Vec<(&str, u64)> = a.files.iter().map(|(k, _, n)| (k.as_str(), *n)).collect();
    let b_meta: Vec<(&str, u64)> = b.files.iter().map(|(k, _, n)| (k.as_str(), *n)).collect();
    if a_meta != b_meta {
        return Err(AppError::Conflict(
            "复制校验失败：文件集合或大小不一致".into(),
        ));
    }
    for ((key, rel, size), (_, _, _)) in a.files.iter().zip(b.files.iter()) {
        let from = src.join(rel);
        let to = dst.join(rel);
        verify_files_equal(&from, &to).map_err(|e| {
            AppError::Conflict(format!(
                "复制校验失败：文件内容不一致（{}，{size} 字节；{e}）",
                key
            ))
        })?;
    }
    Ok(())
}


/// 更新引用路径：同一路径的多条记录、父子目录内的记录同步改写。
/// 仅处理 reference 模式；托管记录的 original_path 只是来源信息，不参与外部移动。
fn rewrite_reference_paths(db: &Db, old_root: &Path, new_root: &Path) -> AppResult<usize> {
    let rows: Vec<(String, String)> = db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, original_path FROM shelf_items \
             WHERE storage_mode = 'reference' AND original_path IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut updated = 0usize;
        for (id, raw) in &rows {
            let candidate = Path::new(raw);
            let Some(rest) = strip_under_ci(candidate, old_root) else {
                continue;
            };
            let next = if rest.as_os_str().is_empty() {
                new_root.to_path_buf()
            } else {
                let mut p = new_root.to_path_buf();
                p.push(rest);
                p
            };
            tx.execute(
                "UPDATE shelf_items SET original_path = ?1, exists_state = 'ok', updated_at = ?2 \
                 WHERE id = ?3",
                params![next.to_string_lossy(), now, id],
            )?;
            updated += 1;
        }
        tx.commit()?;
        Ok(updated)
    })
}

// ── 操作日志（最小恢复） ────────────────────────────────────

fn journal_insert(
    db: &Db,
    item_id: &str,
    op: &str,
    source: &Path,
    target: &Path,
) -> AppResult<String> {
    #[cfg(test)]
    if test_support::take("journal_insert_fail") {
        return Err(AppError::Conflict("注入故障：写入操作日志失败".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO shelf_file_ops (id, item_id, op, phase, source, target, created_at) \
             VALUES (?1, ?2, ?3, 'intent', ?4, ?5, ?6)",
            params![
                id,
                item_id,
                op,
                source.to_string_lossy(),
                target.to_string_lossy(),
                now_iso()
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

/// 阶段推进：失败必须由调用方处理，不能无条件继续危险删除。
fn journal_phase(db: &Db, id: &str, phase: &str) -> AppResult<()> {
    #[cfg(test)]
    if test_support::take("journal_phase_fail") {
        return Err(AppError::Conflict("注入故障：写入操作日志阶段失败".into()));
    }
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE shelf_file_ops SET phase = ?1 WHERE id = ?2",
            params![phase, id],
        )?;
        Ok(())
    })
}

/// 复制完成并把临时副本改名为最终目标后，记录最终路径并进入 copied 阶段。
fn journal_mark_copied(db: &Db, id: &str, final_target: &Path) -> AppResult<()> {
    #[cfg(test)]
    if test_support::take("journal_copied_fail") {
        return Err(AppError::Conflict(
            "注入故障：记录复制完成阶段失败".into(),
        ));
    }
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE shelf_file_ops SET phase = 'copied', target = ?1 WHERE id = ?2",
            params![final_target.to_string_lossy(), id],
        )?;
        Ok(())
    })
}

/// 仅更新临时副本路径，保持 intent 阶段（复制尚未完成）。
fn journal_set_target(db: &Db, id: &str, target: &Path) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE shelf_file_ops SET target = ?1 WHERE id = ?2 AND phase = 'intent'",
            params![target.to_string_lossy(), id],
        )?;
        Ok(())
    })
}

fn journal_done(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute("DELETE FROM shelf_file_ops WHERE id = ?1", params![id])?;
        Ok(())
    })
}

fn path_lexists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// 日志对应的暂存记录是否仍指向本次操作的源/目标（防止旧日志误操作后来创建的文件）。
fn journal_item_still_matches(db: &Db, item_id: &str, src: &Path, dst: &Path) -> bool {
    let Ok(item) = get_item(db, item_id) else {
        return false;
    };
    let Some(raw) = item.original_path.as_deref() else {
        return false;
    };
    let current = Path::new(raw);
    strip_under_ci(current, src).is_some() || strip_under_ci(current, dst).is_some()
}

/// 启动恢复：幂等、只做低风险收敛，绝不在状态不明确时删除可能完整的副本。
///
/// 状态判定（phase + 文件系统现状）：
/// - intent + 临时副本：复制未完成，源仍完整时才清理临时副本；
/// - copied：目标已校验完整，源是否残留不推断为失败；
/// - moved：磁盘已移动/删除源，数据库引用待补写；
/// - 源与目标都在：保留两者，仅把引用切到已校验目标（不删任何一方）；
/// - 源与目标都不在：保留日志作为异常诊断，不判成功、不清理。
pub fn recover_pending_file_ops(db: &Db) {
    let rows: Vec<(String, String, String, String, String, String)> = match db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, item_id, op, phase, source, target FROM shelf_file_ops \
             WHERE op IN ('move','copy')",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("读取暂存架文件操作日志失败（跳过恢复）: {e}");
            return;
        }
    };
    for (id, item_id, op, phase, source, target) in rows {
        let src = Path::new(&source);
        let dst = Path::new(&target);
        if !journal_item_still_matches(db, &item_id, src, dst) {
            // 记录已删除或指向完全无关的新路径：旧日志不得触碰当前文件。
            tracing::warn!("暂存架操作日志 {id} 的条目已失效，丢弃日志但不操作文件");
            if journal_done(db, &id).is_err() {
                tracing::warn!("暂存架操作日志 {id} 清理失败，将在下次启动重试");
            }
            continue;
        }
        if op == "copy" {
            if is_part_name(dst) {
                if path_lexists(src) {
                    remove_part(dst);
                    if journal_done(db, &id).is_err() {
                        tracing::warn!("暂存架复制日志 {id} 清理失败，将在下次启动重试");
                    }
                } else {
                    // 源已不在，临时副本可能是唯一完整副本：保留并记录诊断。
                    tracing::warn!(
                        "暂存架复制中断且源已不存在，保留临时副本待人工确认: {}",
                        dst.display()
                    );
                }
            } else if journal_done(db, &id).is_err() {
                tracing::warn!("暂存架复制日志 {id} 清理失败，将在下次启动重试");
            }
            continue;
        }
        // 移动：临时副本阶段。
        if is_part_name(dst) {
            if path_lexists(src) {
                remove_part(dst);
                if journal_done(db, &id).is_err() {
                    tracing::warn!("暂存架移动日志 {id} 清理失败，将在下次启动重试");
                }
            } else {
                tracing::warn!(
                    "暂存架移动中断且源已不存在，保留临时副本待人工确认: {}",
                    dst.display()
                );
            }
            continue;
        }
        let src_exists = path_lexists(src);
        let dst_exists = path_lexists(dst);
        if !src_exists && !dst_exists {
            // 不静默判成功：保留日志供诊断，下次启动仍会看到同一条记录。
            tracing::error!(
                "暂存架移动日志 {id} 的源与目标都不存在，无法判定结果，保留日志待人工处理"
            );
            continue;
        }
        if dst_exists && src_exists && phase == "intent" {
            // 同卷重命名尚未推进日志时两者同时存在：无法判定，保留两者。
            tracing::warn!(
                "暂存架移动日志 {id} 状态不明确（源与目标都存在），保留两者不做处理"
            );
            if journal_done(db, &id).is_err() {
                tracing::warn!("暂存架移动日志 {id} 清理失败，将在下次启动重试");
            }
            continue;
        }
        if dst_exists {
            match rewrite_reference_paths(db, src, dst) {
                Ok(_) => {
                    if src_exists {
                        tracing::warn!(
                            "暂存架移动恢复：目标已完整建立但源仍残留（{}），未删除源",
                            src.display()
                        );
                    }
                    if journal_done(db, &id).is_err() {
                        tracing::warn!("暂存架移动日志 {id} 清理失败，将在下次启动重试");
                    }
                }
                Err(e) => {
                    tracing::warn!("暂存架移动恢复写入引用失败，保留日志重试: {e}");
                }
            }
            continue;
        }
        // 目标不存在、源存在：操作未完成或目标被外部删除；源可能仍完整。
        tracing::warn!(
            "暂存架移动日志 {id} 目标不存在但源仍存在，保留源不动并丢弃日志"
        );
        if journal_done(db, &id).is_err() {
            tracing::warn!("暂存架移动日志 {id} 清理失败，将在下次启动重试");
        }
    }
}

// ── 复制 ────────────────────────────────────────────────────

#[cfg(test)]
fn test_mutate_path(path: &Path, is_dir: bool) {
    let victim = if is_dir {
        walk_tree(path)
            .ok()
            .and_then(|m| m.files.first().map(|(_, rel, _)| path.join(rel)))
    } else {
        Some(path.to_path_buf())
    };
    if let Some(victim) = victim {
        let _ = std::fs::OpenOptions::new()
            .append(true)
            .open(victim)
            .and_then(|mut f| f.write_all(b"x"));
    }
}

fn copy_with_verify(src: &Path, part: &Path, target: &Path, is_dir: bool) -> AppResult<()> {
    if path_lexists(part) {
        return Err(AppError::Conflict(format!(
            "临时副本已存在，拒绝覆盖: {}",
            part.display()
        )));
    }
    if path_lexists(target) {
        return Err(AppError::Conflict(format!(
            "目标已存在: {}",
            target.display()
        )));
    }
    let meta = entry_meta(src)?;
    if is_reparse_point(&meta) {
        return Err(AppError::Validation(
            "源路径是符号链接/联接点/重解析点，暂不支持复制".into(),
        ));
    }
    let before = snapshot_source(src)?;
    let result = (|| -> AppResult<()> {
        if is_dir {
            // 文件夹逐项流式复制；空间不足由写入错误兜底，失败时整块清理临时目录。
            copy_tree(src, &part)?;
        } else {
            let need = meta.len();
            if let Some(free) = disk_free_bytes(target) {
                if need + DISK_FREE_MARGIN > free {
                    return Err(AppError::Unavailable("目标磁盘空间不足".into()));
                }
            }
            copy_file_stream(src, &part)?;
        }
        #[cfg(test)]
        {
            if test_support::take("copy_corrupt") {
                test_mutate_path(part, is_dir);
            }
            if test_support::take("source_mutate") {
                test_mutate_path(src, is_dir);
            }
        }
        if is_dir {
            verify_tree(src, &part)?;
        } else {
            verify_files_equal(src, &part)?;
        }
        // 复制/校验期间源发生变化（增删改、大小或时间戳变化）不得判成功。
        if snapshot_source(src)? != before {
            return Err(AppError::Conflict(
                "源在复制或校验期间发生变化，已中止且未删除源".into(),
            ));
        }
        if path_lexists(target) {
            return Err(AppError::Conflict(format!(
                "目标已存在: {}",
                target.display()
            )));
        }
        #[cfg(test)]
        if test_support::take("target_race") {
            let _ = std::fs::write(target, b"racer");
        }
        if path_lexists(target) {
            return Err(AppError::Conflict(format!(
                "目标在写入前已存在，拒绝覆盖: {}",
                target.display()
            )));
        }
        if is_dir {
            std::fs::rename(&part, target)?;
        } else {
            // 同目录内优先用硬链接建立最终目标：目标已存在时必然失败，避免 rename 覆盖。
            match std::fs::hard_link(&part, target) {
                Ok(()) => {
                    if let Err(e) = std::fs::remove_file(&part) {
                        tracing::warn!("临时副本链接清理失败（最终目标已完整）: {e}");
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Err(AppError::Conflict(format!(
                        "目标已存在: {}",
                        target.display()
                    )));
                }
                Err(_) => {
                    if path_lexists(target) {
                        return Err(AppError::Conflict(format!(
                            "目标已存在: {}",
                            target.display()
                        )));
                    }
                    std::fs::rename(&part, target)?;
                }
            }
        }
        Ok(())
    })();
    if result.is_err() {
        remove_best_effort(&part);
    }
    result
}

/// 禁止复制到自身或自身子目录（规范化后比较祖先关系）。
fn ensure_copy_dest_safe(src: &Path, target_dir: &Path) -> AppResult<()> {
    let src_canon = std::fs::canonicalize(src)?;
    let target_canon = std::fs::canonicalize(target_dir)?;
    if target_canon == src_canon || target_canon.starts_with(&src_canon) {
        return Err(AppError::Validation(
            "不能把文件/文件夹复制到自身或自身子目录".into(),
        ));
    }
    Ok(())
}

fn copy_one(
    db: &Db,
    root: &Path,
    item: &ShelfItem,
    target_dir: &Path,
    strategy: ConflictStrategy,
    seen_sources: &mut HashSet<String>,
) -> ShelfOpEntry {
    let mut entry = ShelfOpEntry {
        id: item.id.clone(),
        display_name: item.display_name.clone(),
        source: None,
        target: None,
        status: "failed".into(),
        reason: None,
        recovery: None,
        residual_source: None,
    };
    let src = match op_source(root, item) {
        Ok(p) => p,
        Err(e) => {
            entry.reason = Some(e.to_string());
            return entry;
        }
    };
    entry.source = Some(src.to_string_lossy().into_owned());
    if !seen_sources.insert(src.to_string_lossy().to_lowercase()) {
        entry.status = "skipped".into();
        entry.reason = Some("同批次存在指向同一文件的重复记录，已跳过".into());
        return entry;
    }
    let is_dir = src.is_dir();
    if let Err(e) = ensure_copy_dest_safe(&src, target_dir) {
        entry.reason = Some(e.to_string());
        return entry;
    }
    // 托管副本在架内使用 uuid 文件名，导出时还原用户可见的原文件名。
    let name = if item.storage_mode == MODE_MANAGED {
        let mut name = item.display_name.clone();
        if let Some(ext) = item.file_ext.as_deref() {
            if Path::new(&name).extension().is_none() {
                name.push('.');
                name.push_str(ext);
            }
        }
        OsString::from(name)
    } else {
        match source_name(&src) {
            Ok(n) => n,
            Err(e) => {
                entry.reason = Some(e.to_string());
                return entry;
            }
        }
    };
    let (target, skipped) = match resolve_target(target_dir, &name, is_dir, strategy) {
        Ok(v) => v,
        Err(e) => {
            entry.reason = Some(e.to_string());
            return entry;
        }
    };
    entry.target = Some(target.to_string_lossy().into_owned());
    if skipped {
        entry.status = "skipped".into();
        entry.reason = Some("目标目录已存在同名文件（同名策略：跳过）".into());
        return entry;
    }
    let part = match part_path(&target) {
        Ok(p) => p,
        Err(e) => {
            entry.reason = Some(e.to_string());
            return entry;
        }
    };
    let journal = match journal_insert(db, &item.id, "copy", &src, &part) {
        Ok(id) => id,
        Err(e) => {
            entry.reason = Some(format!("写入复制日志失败，未执行复制: {e}"));
            return entry;
        }
    };
    match copy_with_verify(&src, &part, &target, is_dir) {
        Ok(()) => {
            if let Err(e) = journal_done(db, &journal) {
                tracing::warn!("复制已完成但清理操作日志失败（不影响结果）: {e}");
            }
            entry.status = "ok".into();
        }
        Err(e) => {
            remove_best_effort(&part);
            if let Err(e2) = journal_done(db, &journal) {
                tracing::warn!("复制失败后清理操作日志失败: {e2}");
            }
            entry.reason = Some(e.to_string());
        }
    }
    entry
}

// ── 移动 ────────────────────────────────────────────────────

fn rewrite_after_move(db: &Db, src: &Path, dst: &Path) -> AppResult<()> {
    #[cfg(test)]
    if test_support::take("db_rewrite_fail") {
        return Err(AppError::Conflict("注入故障：更新暂存架路径失败".into()));
    }
    rewrite_reference_paths(db, src, dst)?;
    Ok(())
}

#[cfg(test)]
fn test_remove_partial(root: &Path, remove_subdir: bool) -> std::io::Result<()> {
    if remove_subdir {
        let mut child_dirs = Vec::new();
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                child_dirs.push(entry.path());
            }
        }
        if let Some(dir) = child_dirs.first() {
            std::fs::remove_dir_all(dir)?;
        }
    } else {
        let manifest = walk_tree(root).map_err(|e| {
            std::io::Error::other(format!("构造部分删除故障失败: {e}"))
        })?;
        if let Some((_, rel, _)) = manifest.files.first() {
            std::fs::remove_file(root.join(rel))?;
        }
    }
    Err(std::io::Error::other("注入故障：源清理部分失败"))
}

/// 删除源：失败时绝不推断源完整，也绝不连带删除目标副本。
fn remove_source_path(src: &Path, is_dir: bool) -> std::io::Result<()> {
    #[cfg(test)]
    {
        if test_support::enabled("source_remove_partial_first") {
            return test_remove_partial(src, false);
        }
        if test_support::enabled("source_remove_partial_subdir") {
            return test_remove_partial(src, true);
        }
    }
    if is_dir {
        std::fs::remove_dir_all(src)
    } else {
        std::fs::remove_file(src)
    }
}

fn move_one(
    db: &Db,
    root: &Path,
    item: &ShelfItem,
    target_dir: &Path,
    strategy: ConflictStrategy,
    seen_sources: &mut HashSet<String>,
) -> ShelfOpEntry {
    let mut entry = ShelfOpEntry {
        id: item.id.clone(),
        display_name: item.display_name.clone(),
        source: None,
        target: None,
        status: "failed".into(),
        reason: None,
        recovery: None,
        residual_source: None,
    };
    if item.storage_mode == MODE_MANAGED {
        entry.reason = Some("托管副本不支持移动，请使用「导出副本到…」".into());
        return entry;
    }
    let src = match op_source(root, item) {
        Ok(p) => p,
        Err(e) => {
            entry.reason = Some(e.to_string());
            return entry;
        }
    };
    entry.source = Some(src.to_string_lossy().into_owned());
    if !seen_sources.insert(src.to_string_lossy().to_lowercase()) {
        entry.status = "skipped".into();
        entry.reason = Some("同批次存在指向同一文件的重复记录，已跳过".into());
        return entry;
    }
    let is_dir = src.is_dir();
    let name = match source_name(&src) {
        Ok(n) => n,
        Err(e) => {
            entry.reason = Some(e.to_string());
            return entry;
        }
    };
    if parent_eq_ci(&src, target_dir) {
        entry.status = "skipped".into();
        entry.reason = Some("文件已经在目标目录内，未移动".into());
        return entry;
    }
    if is_dir {
        if let Ok(c) = std::fs::canonicalize(&src) {
            if let Ok(t) = std::fs::canonicalize(target_dir) {
                if t.starts_with(&c) {
                    entry.reason =
                        Some("不能把文件夹移动到它自身或子目录中".into());
                    return entry;
                }
            }
        }
    }
    if let Ok(m) = entry_meta(&src) {
        if is_reparse_point(&m) {
            entry.reason = Some("路径是符号链接/联接点/重解析点，暂不支持移动".into());
            return entry;
        }
    }
    let (target, skipped) = match resolve_target(target_dir, &name, is_dir, strategy) {
        Ok(v) => v,
        Err(e) => {
            entry.reason = Some(e.to_string());
            return entry;
        }
    };
    entry.target = Some(target.to_string_lossy().into_owned());
    if skipped {
        entry.status = "skipped".into();
        entry.reason = Some("目标目录已存在同名文件（同名策略：跳过）".into());
        return entry;
    }
    let journal = match journal_insert(db, &item.id, "move", &src, &target) {
        Ok(id) => id,
        Err(e) => {
            entry.reason = Some(format!("写入移动日志失败，未执行移动: {e}"));
            return entry;
        }
    };

    #[cfg(test)]
    let same_volume = {
        if test_support::enabled("force_cross_volume") {
            false
        } else {
            same_volume(&src, target_dir)
        }
    };
    #[cfg(not(test))]
    let same_volume = same_volume(&src, target_dir);

    if same_volume {
        match std::fs::rename(&src, &target) {
            Ok(()) => {
                if let Err(e) = journal_phase(db, &journal, "moved") {
                    tracing::warn!("同卷移动阶段日志写入失败，继续按目标存在恢复: {e}");
                }
                match rewrite_after_move(db, &src, &target) {
                    Ok(_) => {
                        if let Err(e) = journal_done(db, &journal) {
                            tracing::warn!("移动完成但清理操作日志失败（不影响结果）: {e}");
                        }
                        entry.status = "ok".into();
                    }
                    Err(e) => {
                        // 尝试回滚，避免库与磁盘不一致；回滚失败则由启动恢复补写引用。
                        match std::fs::rename(&target, &src) {
                            Ok(()) => {
                                if let Err(e2) = journal_done(db, &journal) {
                                    tracing::warn!("回滚后清理操作日志失败: {e2}");
                                }
                                entry.reason =
                                    Some(format!("更新暂存架路径失败，已回滚移动: {e}"));
                            }
                            Err(rollback_err) => {
                                entry.status = "partial".into();
                                entry.reason = Some(format!(
                                    "文件已移动到目标但暂存架路径更新失败，回滚也失败（{rollback_err}）；重启后将自动补写引用，请勿手动移动目标"
                                ));
                                entry.recovery =
                                    Some("保持目标文件在原位，重启应用以自动恢复引用".into());
                            }
                        }
                    }
                }
                return entry;
            }
            Err(e) if e.raw_os_error() == Some(17) => {
                // EXDEV：同卷判定失效（如映射盘），降级到复制 + 校验 + 删除源。
            }
            Err(e) => {
                if let Err(e2) = journal_done(db, &journal) {
                    tracing::warn!("移动失败后清理操作日志失败: {e2}");
                }
                entry.reason = Some(format!("移动失败: {e}"));
                return entry;
            }
        }
    }

    // 跨卷：复制 → 内容校验 → 原子建立目标 → 删除源 → 更新数据库。
    let part = match part_path(&target) {
        Ok(p) => p,
        Err(e) => {
            if let Err(e2) = journal_done(db, &journal) {
                tracing::warn!("准备临时副本失败后清理操作日志失败: {e2}");
            }
            entry.reason = Some(e.to_string());
            return entry;
        }
    };
    // 日志先指向临时副本：中途退出时恢复逻辑可精确清理本次创建的 part。
    if let Err(e) = journal_set_target(db, &journal, &part) {
        if let Err(e2) = journal_done(db, &journal) {
            tracing::warn!("记录临时副本路径失败后清理操作日志失败: {e2}");
        }
        entry.reason = Some(format!("记录临时副本路径失败，未执行移动: {e}"));
        return entry;
    }
    if let Err(e) = copy_with_verify(&src, &part, &target, is_dir) {
        remove_best_effort(&part);
        if let Err(e2) = journal_done(db, &journal) {
            tracing::warn!("跨盘复制失败后清理操作日志失败: {e2}");
        }
        entry.reason = Some(format!("跨盘复制或校验失败，源文件未删除: {e}"));
        return entry;
    }
    // 至此目标已完整校验。关键阶段日志失败时绝不继续删除源。
    if let Err(e) = journal_mark_copied(db, &journal, &target) {
        entry.status = "partial".into();
        entry.reason = Some(format!(
            "目标副本已校验完整，但记录复制完成阶段失败，已保留源与目标未删除: {e}"
        ));
        entry.recovery = Some("检查源与目标两份副本，确认后手动删除多余的一份".into());
        return entry;
    }

    match remove_source_path(&src, is_dir) {
        Ok(()) => {
            if let Err(e) = journal_phase(db, &journal, "moved") {
                tracing::warn!("跨盘移动阶段日志写入失败，继续按目标存在恢复: {e}");
            }
            match rewrite_after_move(db, &src, &target) {
                Ok(_) => {
                    if let Err(e) = journal_done(db, &journal) {
                        tracing::warn!("移动完成但清理操作日志失败（不影响结果）: {e}");
                    }
                    entry.status = "ok".into();
                }
                Err(e) => {
                    // 文件系统已完成、数据库未更新：保留目标，交由启动恢复补写。
                    entry.status = "partial".into();
                    entry.reason = Some(format!(
                        "文件已完整移动到目标，但暂存架路径更新失败，重启后将自动恢复: {e}"
                    ));
                    entry.recovery = Some("保持目标文件在原位，重启应用以自动恢复引用".into());
                }
            }
            entry
        }
        Err(e) => {
            // 源清理失败：源可能已部分删除，目标可能是唯一完整副本。绝不删除目标。
            let src_still_there = path_lexists(&src);
            let db_result = rewrite_after_move(db, &src, &target);
            match db_result {
                Ok(_) => {
                    if let Err(e2) = journal_done(db, &journal) {
                        tracing::warn!("部分完成后清理操作日志失败: {e2}");
                    }
                    entry.status = "partial".into();
                    if src_still_there {
                        entry.residual_source = Some(src.to_string_lossy().into_owned());
                        entry.reason = Some(format!(
                            "目标副本已校验完整，但源清理未完成（源可能残留部分文件，{e}）；暂存引用已切到目标位置"
                        ));
                        entry.recovery =
                            Some("目标副本完整可用；请手动检查并删除残留源目录".into());
                    } else {
                        entry.status = "ok".into();
                        entry.reason = Some(format!(
                            "目标副本已校验完整，源清理返回错误但源已不存在: {e}"
                        ));
                    }
                }
                Err(err) => {
                    // 目标完整、源可能残留；不删除任何一方，保留日志供恢复重试。
                    entry.status = "partial".into();
                    entry.reason = Some(format!(
                        "目标副本已校验完整，但源清理未完成且暂存路径更新失败: 清理错误 {e}；更新错误 {err}"
                    ));
                    entry.recovery =
                        Some("保留源与目标，重启应用后检查恢复日志并手动确认".into());
                    if src_still_there {
                        entry.residual_source = Some(src.to_string_lossy().into_owned());
                    }
                }
            }
            entry
        }
    }
}

// ── 批量入口 ────────────────────────────────────────────────

fn finish_report(
    db: &Db,
    root: &Path,
    dir: &Path,
    mut entries: Vec<ShelfOpEntry>,
    remove_after: bool,
) -> AppResult<ShelfOpReport> {
    let success_ids: Vec<String> = entries
        .iter()
        .filter(|e| e.status == "ok")
        .map(|e| e.id.clone())
        .collect();
    let mut removed = 0i64;
    let mut remove_failed_files = 0i64;
    let mut record_cleanup_failed = 0i64;
    let mut record_cleanup_error = None;
    if remove_after && !success_ids.is_empty() {
        let result = {
            #[cfg(test)]
            {
                if test_support::take("record_delete_fail") {
                    Err(AppError::Conflict("注入故障：移除暂存记录失败".into()))
                } else {
                    delete_items(db, root, &success_ids, true)
                }
            }
            #[cfg(not(test))]
            {
                delete_items(db, root, &success_ids, true)
            }
        };
        match result {
            Ok(report) => {
                removed = report.deleted;
                remove_failed_files = report.failed_files;
            }
            Err(e) => {
                // 文件操作已成功，不能因为记录清理失败把整批报告为失败。
                record_cleanup_failed = success_ids.len() as i64;
                record_cleanup_error = Some(e.to_string());
                for entry in entries.iter_mut().filter(|e| e.status == "ok") {
                    entry.reason = Some(format!(
                        "文件操作成功，但移除暂存记录失败，可稍后重试移除以完成清理: {e}"
                    ));
                }
            }
        }
    }
    let success = entries.iter().filter(|e| e.status == "ok").count() as i64;
    let skipped = entries.iter().filter(|e| e.status == "skipped").count() as i64;
    let failed = entries.iter().filter(|e| e.status == "failed").count() as i64;
    let partial = entries.iter().filter(|e| e.status == "partial").count() as i64;
    if success > 0 {
        // 最近目录只在真实成功使用后记录；失败/取消/部分完成不改动排序。
        if let Err(e) = touch_recent_dir(db, &dir.to_string_lossy()) {
            tracing::warn!("记录最近使用目录失败（不影响操作结果）: {e}");
        }
    }
    Ok(ShelfOpReport {
        success,
        skipped,
        failed,
        partial,
        removed,
        remove_failed_files,
        record_cleanup_failed,
        record_cleanup_error,
        entries,
    })
}

pub fn move_items(
    db: &Db,
    root: &Path,
    ids: &[String],
    target_dir_raw: &str,
    strategy: ConflictStrategy,
    remove_after: bool,
) -> AppResult<ShelfOpReport> {
    let ids = dedup_ids(ids)?;
    let _claim = claim_ids(&ids)?;
    let dir = normalize_target_dir(target_dir_raw, root)?;
    let items = load_items(db, &ids)?;

    // 先按物理路径排序（父目录优先），再识别父子关系，避免子项被重复移动。
    let mut order: Vec<(String, Option<PathBuf>)> = ids
        .iter()
        .map(|id| {
            let src = items.get(id).and_then(|it| op_source(root, it).ok());
            (id.clone(), src)
        })
        .collect();
    let path_keys: Vec<String> = order
        .iter()
        .filter_map(|(_, src)| src.as_ref().map(|p| path_claim_key(p)))
        .collect();
    let _path_claim = claim_paths(&path_keys)?;
    order.sort_by_key(|(_, src)| src.as_ref().map(|p| path_depth(p)).unwrap_or(usize::MAX));

    let mut completed: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    let mut by_id: HashMap<String, ShelfOpEntry> = HashMap::new();
    let mut seen_sources = HashSet::new();
    for (id, planned_src) in order {
        // 每条重新读库：前一刀可能已把同一路径的其他记录改写为目标路径。
        let item = get_item(db, &id).ok();
        let Some(item) = item else {
            by_id.insert(
                id.clone(),
                ShelfOpEntry {
                    id,
                    display_name: String::new(),
                    source: None,
                    target: None,
                    status: "failed".into(),
                    reason: Some("条目不存在或已被删除".into()),
                    recovery: None,
                    residual_source: None,
                },
            );
            continue;
        };
        let current_src = op_source(root, &item).ok();
        let relevant = planned_src.as_deref().or(current_src.as_deref());
        let under_completed = relevant
            .map(|p| {
                completed.iter().any(|(old, target)| {
                    is_strict_descendant(p, old)
                        || target
                            .as_deref()
                            .map(|t| is_strict_descendant(p, t))
                            .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if under_completed {
            by_id.insert(
                id.clone(),
                ShelfOpEntry {
                    id: id.clone(),
                    display_name: item.display_name.clone(),
                    source: current_src.map(|p| p.to_string_lossy().into_owned()),
                    target: None,
                    status: "skipped".into(),
                    reason: Some(
                        "父目录已在本批次中移动，子项随父目录处理（保留原暂存记录）".into(),
                    ),
                    recovery: None,
                    residual_source: None,
                },
            );
            continue;
        }
        let entry = move_one(db, root, &item, &dir, strategy, &mut seen_sources);
        if entry.status == "ok" || entry.status == "partial" {
            let moved_from = planned_src
                .clone()
                .or_else(|| current_src.clone());
            if let Some(old) = moved_from {
                let new = entry.target.as_ref().map(PathBuf::from);
                completed.push((old, new));
            }
        }
        by_id.insert(id, entry);
    }
    let entries: Vec<ShelfOpEntry> = ids
        .iter()
        .map(|id| {
            by_id.remove(id).unwrap_or(ShelfOpEntry {
                id: id.clone(),
                display_name: String::new(),
                source: None,
                target: None,
                status: "failed".into(),
                reason: Some("条目不存在或已被删除".into()),
                recovery: None,
                residual_source: None,
            })
        })
        .collect();
    finish_report(db, root, &dir, entries, remove_after)
}

pub fn copy_items(
    db: &Db,
    root: &Path,
    ids: &[String],
    target_dir_raw: &str,
    strategy: ConflictStrategy,
    remove_after: bool,
) -> AppResult<ShelfOpReport> {
    let ids = dedup_ids(ids)?;
    let _claim = claim_ids(&ids)?;
    let dir = normalize_target_dir(target_dir_raw, root)?;
    let items = load_items(db, &ids)?;

    let mut order: Vec<(String, Option<PathBuf>)> = ids
        .iter()
        .map(|id| {
            let src = items.get(id).and_then(|it| op_source(root, it).ok());
            (id.clone(), src)
        })
        .collect();
    let path_keys: Vec<String> = order
        .iter()
        .filter_map(|(_, src)| src.as_ref().map(|p| path_claim_key(p)))
        .collect();
    let _path_claim = claim_paths(&path_keys)?;
    order.sort_by_key(|(_, src)| src.as_ref().map(|p| path_depth(p)).unwrap_or(usize::MAX));

    let mut completed: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    let mut by_id: HashMap<String, ShelfOpEntry> = HashMap::new();
    let mut seen_sources = HashSet::new();
    for (id, planned_src) in order {
        let Some(item) = get_item(db, &id).ok() else {
            by_id.insert(
                id.clone(),
                ShelfOpEntry {
                    id,
                    display_name: String::new(),
                    source: None,
                    target: None,
                    status: "failed".into(),
                    reason: Some("条目不存在或已被删除".into()),
                    recovery: None,
                    residual_source: None,
                },
            );
            continue;
        };
        let current_src = op_source(root, &item).ok();
        let relevant = planned_src.as_deref().or(current_src.as_deref());
        let under_completed = relevant
            .map(|p| {
                completed.iter().any(|(old, target)| {
                    is_strict_descendant(p, old)
                        || target
                            .as_deref()
                            .map(|t| is_strict_descendant(p, t))
                            .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if under_completed {
            by_id.insert(
                id.clone(),
                ShelfOpEntry {
                    id: id.clone(),
                    display_name: item.display_name.clone(),
                    source: current_src.map(|p| p.to_string_lossy().into_owned()),
                    target: None,
                    status: "skipped".into(),
                    reason: Some(
                        "父目录已在本批次中复制，子项随父目录处理（保留原暂存记录）".into(),
                    ),
                    recovery: None,
                    residual_source: None,
                },
            );
            continue;
        }
        let entry = copy_one(db, root, &item, &dir, strategy, &mut seen_sources);
        if entry.status == "ok" {
            if let Some(old) = planned_src.clone().or_else(|| current_src.clone()) {
                let new = entry.target.as_ref().map(PathBuf::from);
                completed.push((old, new));
            }
        }
        by_id.insert(id, entry);
    }
    let entries: Vec<ShelfOpEntry> = ids
        .iter()
        .map(|id| {
            by_id.remove(id).unwrap_or(ShelfOpEntry {
                id: id.clone(),
                display_name: String::new(),
                source: None,
                target: None,
                status: "failed".into(),
                reason: Some("条目不存在或已被删除".into()),
                recovery: None,
                residual_source: None,
            })
        })
        .collect();
    finish_report(db, root, &dir, entries, remove_after)
}

// ── 失效重定位 ──────────────────────────────────────────────

/// 引用条目重新指向用户选择的外部文件/文件夹；托管条目明确拒绝。
pub fn relocate_item(db: &Db, id: &str, raw: &str) -> AppResult<ShelfItem> {
    let item = get_item(db, id)?;
    if item.storage_mode == MODE_MANAGED {
        return Err(AppError::Validation(
            "托管副本丢失不能指向外部文件；请通过备份恢复，或删除记录后重新添加".into(),
        ));
    }
    match item.kind.as_str() {
        KIND_LINK | KIND_TEXT => {
            return Err(AppError::Validation("链接/文本条目无需重定位".into()))
        }
        _ => {}
    }
    let path = normalize_original_path(raw)?;
    let meta = std::fs::metadata(&path).map_err(|e| {
        AppError::NotFound(format!("所选路径不可访问: {}（{e}）", path.display()))
    })?;
    let type_ok = if item.kind == KIND_FOLDER {
        meta.is_dir()
    } else {
        meta.is_file()
    };
    if !type_ok {
        return Err(AppError::Validation(
            "所选路径类型与条目类型不匹配".into(),
        ));
    }
    let ext = if meta.is_file() {
        ext_of(&path)
    } else {
        None
    };
    let size = if meta.is_file() {
        meta.len() as i64
    } else {
        item.byte_size
    };
    let now = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE shelf_items SET original_path = ?1, exists_state = 'ok', byte_size = ?2, \
             file_ext = ?3, updated_at = ?4 WHERE id = ?5",
            params![path.to_string_lossy(), size, ext, now, id],
        )?;
        Ok(())
    })?;
    get_item(db, id)
}

// ── 最近目录 ────────────────────────────────────────────────

fn normalize_recent_path(raw: &str) -> AppResult<PathBuf> {
    let p = normalize_original_path(raw)?;
    if !p.is_dir() {
        return Err(AppError::NotFound(format!(
            "目录不存在或不可访问: {}",
            p.display()
        )));
    }
    Ok(p)
}

pub fn list_recent_dirs(db: &Db) -> AppResult<Vec<ShelfRecentDir>> {
    let rows: Vec<(String, i64, String)> = db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT path, pinned, last_used_at FROM shelf_recent_dirs \
             ORDER BY pinned DESC, last_used_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    Ok(rows
        .into_iter()
        .map(|(path, pinned, last_used_at)| ShelfRecentDir {
            available: Path::new(&path).is_dir(),
            path,
            pinned: pinned != 0,
            last_used_at,
        })
        .collect())
}

/// 成功使用后记录目录：去重、按最近使用排序、最多保留 8 个。
pub fn touch_recent_dir(db: &Db, raw: &str) -> AppResult<()> {
    let path = normalize_recent_path(raw)?;
    let key = path.to_string_lossy().into_owned();
    let now = now_iso();
    db.with_conn(|conn| {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM shelf_recent_dirs WHERE path = ?1)",
            params![key],
            |r| r.get::<_, i64>(0),
        )? != 0;
        if !exists {
            let total: i64 =
                conn.query_row("SELECT COUNT(*) FROM shelf_recent_dirs", [], |r| {
                    r.get(0)
                })?;
            if total >= MAX_RECENT_DIRS as i64 {
                let oldest: Option<String> = conn
                    .query_row(
                        "SELECT path FROM shelf_recent_dirs WHERE pinned = 0 \
                         ORDER BY last_used_at ASC, rowid ASC LIMIT 1",
                        [],
                        |r| r.get(0),
                    )
                    .optional()?;
                match oldest {
                    Some(p) => {
                        conn.execute(
                            "DELETE FROM shelf_recent_dirs WHERE path = ?1",
                            params![p],
                        )?;
                    }
                    None => {
                        return Err(AppError::Conflict(
                            "最近目录已满（8 个且均已固定），请先取消固定或移除一个".into(),
                        ))
                    }
                }
            }
        }
        conn.execute(
            "INSERT INTO shelf_recent_dirs (path, pinned, last_used_at, created_at) \
             VALUES (?1, 0, ?2, ?2) \
             ON CONFLICT(path) DO UPDATE SET last_used_at = excluded.last_used_at",
            params![key, now],
        )?;
        Ok(())
    })
}

pub fn set_recent_dir_pinned(db: &Db, raw: &str, pinned: bool) -> AppResult<()> {
    let path = normalize_original_path(raw)?;
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE shelf_recent_dirs SET pinned = ?1 WHERE path = ?2",
            params![i64::from(pinned), path.to_string_lossy()],
        )?;
        Ok(())
    })
}

pub fn remove_recent_dir(db: &Db, raw: &str) -> AppResult<()> {
    let path = normalize_original_path(raw)?;
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM shelf_recent_dirs WHERE path = ?1",
            params![path.to_string_lossy()],
        )?;
        Ok(())
    })
}

pub fn clear_recent_dirs(db: &Db) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute("DELETE FROM shelf_recent_dirs", [])?;
        Ok(())
    })
}
