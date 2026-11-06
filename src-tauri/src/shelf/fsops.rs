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

use super::drop_targets::{DropTarget, OP_COPY, OP_MOVE};
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
            entries: vec![(String::new(), root_meta.len(), modified_nanos(&root_meta))],
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

/// 物理路径占用：文件操作同时保护**源**与**目标**两侧。
///
/// 只用「完全相同的路径」做互斥不足以保护目录树：批次 A 向 `D:\Archive` 复制、
/// 批次 B 同时把 `D:\Archive` 整个搬走时，两边源路径毫不相干，却会互相破坏
/// （目标目录在写入过程中消失、日志里的目标路径失效）。因此占用按
/// **路径分量 + 读写模式**判定：
///
/// - `Exclusive`：会改变该路径及其子树的存在/内容的操作（移动源、最终写入目标）；
/// - `Shared`：只要求该路径保持原位、可以并行的操作（向同一目录复制、复制时读取源）。
///
/// 冲突规则：
/// - Exclusive vs Exclusive：相等或互为祖先/后代 → 冲突；
/// - Exclusive vs Shared：Exclusive 是 Shared 的祖先或同一路径 → 冲突
///   （移动父目录会毁掉写入方；移动无关子目录不影响写入）；
/// - Shared vs Shared：从不冲突（同目录并行复制不同文件是安全的）。
static ACTIVE_PATHS: OnceLock<Mutex<Vec<ActiveClaim>>> = OnceLock::new();

fn active_paths() -> &'static Mutex<Vec<ActiveClaim>> {
    ACTIVE_PATHS.get_or_init(|| Mutex::new(Vec::new()))
}

static CLAIM_OWNER_SEQ: OnceLock<Mutex<u64>> = OnceLock::new();

fn next_claim_owner() -> u64 {
    let mut seq = CLAIM_OWNER_SEQ
        .get_or_init(|| Mutex::new(0))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *seq += 1;
    *seq
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimMode {
    /// 只读 / 只要求保持原位（并行安全）
    Shared,
    /// 独占：会移动、删除或最终写入该路径
    Exclusive,
}

/// 一次占用的规范化路径。`parts` 用于比较，`label` 只用于错误信息。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClaimKey {
    parts: Vec<String>,
    label: String,
    mode: ClaimMode,
}

#[derive(Debug, Clone)]
struct ActiveClaim {
    key: ClaimKey,
    /// 每次 `claim_paths` 生成一个 owner：释放时只删除自己的登记，
    /// 不会误删其他批次同路径的占用。
    owner: u64,
}

/// 规范化路径分量：`canonicalize` 解析重解析点、8.3 短名与大小写；路径尚不存在时
/// 逐级上溯到最近的已存在祖先，再把尾部拼回去——否则「父目录已规范化、子路径只做
/// 了词法归一」会漏判父子关系。
fn claim_components(path: &Path) -> Vec<String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut tail: Vec<String> = Vec::new();
    let mut cur = absolute.as_path();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(cur) {
            let mut out: Vec<String> = canonical
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
                .collect();
            for part in tail.iter().rev() {
                out.push(part.clone());
            }
            return out;
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_string_lossy().to_lowercase());
                cur = parent;
            }
            _ => break,
        }
    }
    canonical_components(&absolute)
}

fn claim_key(path: &Path, mode: ClaimMode) -> ClaimKey {
    ClaimKey {
        parts: claim_components(path),
        label: path.to_string_lossy().into_owned(),
        mode,
    }
}

/// 相等或互为祖先/后代即冲突（按分量比较，避免 `C:\a` 与 `C:\ab` 被误判）。
fn claim_keys_overlap(a: &[String], b: &[String]) -> bool {
    components_prefix(a, b) || components_prefix(b, a)
}

/// 两条占用是否冲突（见上方规则）。
fn claims_conflict(a: &ClaimKey, b: &ClaimKey) -> bool {
    match (a.mode, b.mode) {
        (ClaimMode::Shared, ClaimMode::Shared) => false,
        // 独占方是共享方本身或它的祖先：共享方脚下的路径会被搬走/删除。
        (ClaimMode::Shared, ClaimMode::Exclusive) => components_prefix(&b.parts, &a.parts),
        (ClaimMode::Exclusive, ClaimMode::Shared) => components_prefix(&a.parts, &b.parts),
        (ClaimMode::Exclusive, ClaimMode::Exclusive) => claim_keys_overlap(&a.parts, &b.parts),
    }
}

#[derive(Debug)]
struct PathClaim {
    owner: u64,
}

impl Drop for PathClaim {
    fn drop(&mut self) {
        let mut set = active_paths().lock().unwrap_or_else(|e| e.into_inner());
        // 只删除本次 owner 的登记：成功、失败、提前返回都由 Drop 统一释放。
        set.retain(|active| active.owner != self.owner);
    }
}

/// 占用一批物理路径。任一占用与在途操作冲突时整体拒绝，不做「部分占用」，
/// 避免调用方拿到不完整的保护。
fn claim_paths(claims: &[(PathBuf, ClaimMode)]) -> AppResult<PathClaim> {
    if claims.is_empty() {
        return Ok(PathClaim {
            owner: next_claim_owner(),
        });
    }
    let keys: Vec<ClaimKey> = claims.iter().map(|(p, m)| claim_key(p, *m)).collect();
    let owner = next_claim_owner();
    let mut set = active_paths().lock().unwrap_or_else(|e| e.into_inner());
    for key in &keys {
        // 同一批次内部的多个占用互不冲突（例如共享目标目录 + 独占其中的目标文件）
        if let Some(active) = set
            .iter()
            .filter(|active| active.owner != owner)
            .find(|active| claims_conflict(&active.key, key))
        {
            let what = match key.mode {
                ClaimMode::Shared => "只读",
                ClaimMode::Exclusive => "写入/移动",
            };
            return Err(AppError::Conflict(format!(
                "路径 {}（{what}）与正在进行的文件操作（{}）冲突：两者是同一路径或父子目录，请等该操作结束后重试",
                key.label, active.key.label
            )));
        }
    }
    for key in keys {
        let exists = set
            .iter()
            .any(|active| active.key.parts == key.parts && active.key.mode == key.mode);
        if !exists {
            set.push(ActiveClaim { key, owner });
        }
    }
    Ok(PathClaim { owner })
}

/// 批次级占用：源路径（复制=Shared 可并行读；移动=Exclusive）+ 目标目录（Shared）。
///
/// 目标目录只要求「保持原位」：另一个批次向同一目录复制不同文件是安全的（Shared vs
/// Shared 不冲突）；但任何把该目录或其祖先搬走/删除的操作（Exclusive）都会冲突。
fn claim_batch(
    sources: &[PathBuf],
    source_mode: ClaimMode,
    target_dir: &Path,
) -> AppResult<PathClaim> {
    let mut claims: Vec<(PathBuf, ClaimMode)> =
        sources.iter().map(|p| (p.clone(), source_mode)).collect();
    claims.push((target_dir.to_path_buf(), ClaimMode::Shared));
    claim_paths(&claims)
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
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    Ok(rows.into_iter().map(|i| (i.id.clone(), i)).collect())
}

/// 目标目录：绝对路径、必须存在且为目录；禁止指向暂存架内部（避免被清理兜底误删）。
pub fn normalize_target_dir(raw: &str, root: &Path) -> AppResult<PathBuf> {
    let dir = normalize_original_path(raw)?;
    let meta = std::fs::metadata(&dir)
        .map_err(|e| AppError::NotFound(format!("目标目录不可访问: {}（{e}）", dir.display())))?;
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
                return Err(AppError::NotFound("原文件已失效，请先重新定位".into()));
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

/// 规范化后的路径分量（大小写不敏感）：优先 canonicalize（解析符号链接/8.3 名），
/// 路径尚不存在时退化为词法归一化（处理 `.`/`..`），避免因临时目录不存在而误判。
fn canonical_components(path: &Path) -> Vec<String> {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect();
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut out: Vec<String> = Vec::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str().to_string_lossy().to_lowercase()),
        }
    }
    out
}

fn components_prefix(prefix: &[String], path: &[String]) -> bool {
    path.len() >= prefix.len() && path[..prefix.len()] == *prefix
}

/// 源路径与暂存架根是否重叠（相等 / 互为祖先）。
/// 允许移动暂存架数据目录或其上级目录，会把托管资产与数据库一起搬走，
/// 使所有 `managed_path` 失效；必须在磁盘操作前拒绝。
fn overlaps_shelf_root(src: &Path, root: &Path) -> bool {
    let a = canonical_components(src);
    let b = canonical_components(root);
    components_prefix(&a, &b) || components_prefix(&b, &a)
}

/// 「不覆盖」提交原语：同卷移动与复制最终提交共用。
///
/// `std::fs::rename` 在 Windows 上等价于 `MoveFileExW(REPLACE_EXISTING)`，
/// 与 `resolve_target` / `copy_with_verify` 里的存在性检查之间存在竞态：检查通过后
/// 目标若被并发创建，改名会静默覆盖它（文件被替换、目录被替换为空目录）。
/// 这里显式使用不带 REPLACE 标志的 `MoveFileExW`，目标已存在时返回 `AlreadyExists`，
/// 由调用方按冲突处理，绝不覆盖。文件和目录走同一条系统调用，语义一致。
///
/// 非 Windows 平台 `std` 没有 `RENAME_NOREPLACE` 等价物，只能先检查再改名；
/// 这是明确记录的平台限制，当前交付目标为 Windows。
#[cfg(windows)]
fn rename_no_replace(src: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    let src_w = wide(src);
    let target_w = wide(target);
    // SAFETY: 两个宽字符串都以 NUL 结尾且在调用期间保持存活；没有回调或额外生命周期。
    let ok = unsafe { MoveFileExW(src_w.as_ptr(), target_w.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn rename_no_replace(src: &Path, target: &Path) -> std::io::Result<()> {
    if path_lexists(target) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target already exists",
        ));
    }
    std::fs::rename(src, target)
}

/// 目标已存在的错误码：Windows 183 (ERROR_ALREADY_EXISTS) / 80 (ERROR_FILE_EXISTS)。
fn is_already_exists(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(183) | Some(80))
        || err.kind() == std::io::ErrorKind::AlreadyExists
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
                tracing::warn!(
                    "临时目录清理失败（不影响源与目标）: {} ({e})",
                    path.display()
                );
            }
        }
        Ok(_) => {
            if let Err(e) = std::fs::remove_file(path) {
                tracing::warn!(
                    "临时文件清理失败（不影响源与目标）: {} ({e})",
                    path.display()
                );
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
        return Err(AppError::Conflict("注入故障：记录复制完成阶段失败".into()));
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
        // 投递批次没有暂存条目可改写，按独立分支收敛（只清理本次临时副本）。
        if item_id.starts_with(DROP_JOURNAL_PREFIX) {
            recover_drop_journal(db, &id, &op, &phase, src, dst);
            continue;
        }
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
            tracing::warn!("暂存架移动日志 {id} 状态不明确（源与目标都存在），保留两者不做处理");
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
        tracing::warn!("暂存架移动日志 {id} 目标不存在但源仍存在，保留源不动并丢弃日志");
        if journal_done(db, &id).is_err() {
            tracing::warn!("暂存架移动日志 {id} 清理失败，将在下次启动重试");
        }
    }
}

/// 投递批次的启动收敛：没有数据库引用需要补写，只处理「本次操作自己创建的临时副本」。
///
/// 与条目操作的关键区别：**任何分支都不删除源或用户目标文件**。目标已存在即视为磁盘
/// 动作完成（投递不登记记录）；源与目标都在时保留两者并记录残留；两者都不在时保留日志
/// 供人工诊断，不判成功。
fn recover_drop_journal(db: &Db, journal_id: &str, op: &str, phase: &str, src: &Path, dst: &Path) {
    if is_part_name(dst) {
        if path_lexists(src) {
            remove_part(dst);
            if journal_done(db, journal_id).is_err() {
                tracing::warn!("投递日志 {journal_id} 清理失败，将在下次启动重试");
            }
        } else {
            // 源已不在，临时副本可能是唯一完整副本：保留并记录诊断。
            tracing::warn!(
                "投递中断且源已不存在，保留临时副本待人工确认: {}",
                dst.display()
            );
        }
        return;
    }
    if op == "copy" {
        // 复制到最终目标后才写 completed；无论成功失败都没有引用要改。
        if journal_done(db, journal_id).is_err() {
            tracing::warn!("投递复制日志 {journal_id} 清理失败，将在下次启动重试");
        }
        return;
    }
    // move：目标存在 = 磁盘移动已完成（阶段字段仅供诊断）。
    if path_lexists(dst) {
        if path_lexists(src) {
            tracing::warn!(
                "投递移动（阶段 {phase}）目标已建立但源仍残留（{}），未删除源",
                src.display()
            );
        }
        if journal_done(db, journal_id).is_err() {
            tracing::warn!("投递移动日志 {journal_id} 清理失败，将在下次启动重试");
        }
        return;
    }
    if path_lexists(src) {
        tracing::warn!("投递移动（阶段 {phase}）目标不存在但源仍存在，保留源不动并丢弃日志");
        if journal_done(db, journal_id).is_err() {
            tracing::warn!("投递移动日志 {journal_id} 清理失败，将在下次启动重试");
        }
        return;
    }
    tracing::error!("投递移动日志 {journal_id} 的源与目标都不存在，保留日志待人工处理");
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
        // 故障注入：在最后一次检查之后、真正提交之前创建目标，模拟并发方的写入。
        // 提交本身必须依赖系统级「不覆盖」语义，而不能依赖上面的检查。
        #[cfg(test)]
        if test_support::take("target_appears_before_commit") {
            let _ = std::fs::write(target, b"racer");
        }
        #[cfg(test)]
        if test_support::take("target_dir_removed_before_commit") {
            if let Some(parent) = target.parent() {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
        // 目标目录在复制/校验期间可能被外部程序移除（盘符重挂载、用户清空目录）。
        // 提交前重新确认父目录仍是目录：给出可读原因，而不是把 rename 的
        // 「系统找不到路径」直接抛给用户；真正的无覆盖仍由下面的原子提交保证。
        if let Some(parent) = target.parent() {
            if !parent.is_dir() {
                return Err(AppError::Unavailable(format!(
                    "目标目录在提交前已不存在或不可访问: {}",
                    parent.display()
                )));
            }
        }
        if is_dir {
            // 目录也用「不覆盖」改名提交：`std::fs::rename` 在 Windows 上等价于
            // MoveFileExW(REPLACE_EXISTING)，上面两次 exists 检查与提交之间仍有窗口，
            // 目录同样不能靠「先检查再改名」保证无覆盖。
            match rename_no_replace(&part, target) {
                Ok(()) => {}
                Err(e) if is_already_exists(&e) => {
                    return Err(AppError::Conflict(format!(
                        "目标在提交时已存在，拒绝覆盖: {}",
                        target.display()
                    )));
                }
                Err(e) => return Err(e.into()),
            }
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
                    // 硬链接不可用（FAT32/exFAT、网络盘等）：回退仍必须无覆盖。
                    match rename_no_replace(&part, target) {
                        Ok(()) => {}
                        Err(e) if is_already_exists(&e) => {
                            return Err(AppError::Conflict(format!(
                                "目标在提交时已存在，拒绝覆盖: {}",
                                target.display()
                            )));
                        }
                        Err(e) => return Err(e.into()),
                    }
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

/// 单条**物理路径**操作的结果（不含暂存条目字段）。
///
/// 暂存条目操作（copy_one / move_one）与收集箱投递（drop_paths）共用同一套磁盘语义，
/// 只在「记录/引用更新」这一步分叉：前者改写 `original_path`，后者没有记录可改。
#[derive(Clone)]
struct PathOutcome {
    /// ok / skipped / failed / partial
    status: &'static str,
    target: Option<PathBuf>,
    reason: Option<String>,
    recovery: Option<String>,
    residual_source: Option<PathBuf>,
}

impl PathOutcome {
    fn failed(reason: impl Into<String>) -> Self {
        Self {
            status: "failed",
            target: None,
            reason: Some(reason.into()),
            recovery: None,
            residual_source: None,
        }
    }

    fn skipped(reason: impl Into<String>, target: Option<PathBuf>) -> Self {
        Self {
            status: "skipped",
            target,
            reason: Some(reason.into()),
            recovery: None,
            residual_source: None,
        }
    }

    fn ok(target: PathBuf) -> Self {
        Self {
            status: "ok",
            target: Some(target),
            reason: None,
            recovery: None,
            residual_source: None,
        }
    }
}

/// 复制单个路径到目标目录（流式 + 校验 + 临时副本原子提交）。
///
/// `journal_item` 只用于操作日志归属：暂存条目传条目 id，投递批次传 `drop:<batch>`。
fn copy_path_core(
    db: &Db,
    journal_item: &str,
    src: &Path,
    name: &OsString,
    target_dir: &Path,
    strategy: ConflictStrategy,
) -> PathOutcome {
    let is_dir = src.is_dir();
    if let Err(e) = ensure_copy_dest_safe(src, target_dir) {
        return PathOutcome::failed(e.to_string());
    }
    let (target, skipped) = match resolve_target(target_dir, name, is_dir, strategy) {
        Ok(v) => v,
        Err(e) => return PathOutcome::failed(e.to_string()),
    };
    if skipped {
        return PathOutcome::skipped("目标目录已存在同名文件（同名策略：跳过）", Some(target));
    }
    // 最终写入目标独占：两个批次同时解析出同一个目标路径时，后到者拿到可重试冲突，
    // 不会各自写临时副本再互相覆盖（提交本身也已有原子无覆盖语义兜底）。
    let _target_claim = match claim_paths(&[(target.clone(), ClaimMode::Exclusive)]) {
        Ok(c) => c,
        Err(e) => return PathOutcome::failed(e.to_string()),
    };
    let part = match part_path(&target) {
        Ok(p) => p,
        Err(e) => return PathOutcome::failed(e.to_string()),
    };
    let journal = match journal_insert(db, journal_item, "copy", src, &part) {
        Ok(id) => id,
        Err(e) => return PathOutcome::failed(format!("写入复制日志失败，未执行复制: {e}")),
    };
    match copy_with_verify(src, &part, &target, is_dir) {
        Ok(()) => {
            if let Err(e) = journal_done(db, &journal) {
                tracing::warn!("复制已完成但清理操作日志失败（不影响结果）: {e}");
            }
            PathOutcome::ok(target)
        }
        Err(e) => {
            remove_best_effort(&part);
            if let Err(e2) = journal_done(db, &journal) {
                tracing::warn!("复制失败后清理操作日志失败: {e2}");
            }
            let mut out = PathOutcome::failed(e.to_string());
            out.target = Some(target);
            out
        }
    }
}

/// 移动单个路径到目标目录：同卷原子改名，跨卷「复制 → 校验 → 删源」。
///
/// `rewrite` 在磁盘移动之后调用，用于把数据库里的引用切到新位置；投递批次没有
/// 引用可改，传恒 `Ok` 的空实现。**rewrite 失败绝不删除源或目标**。
fn move_path_core(
    db: &Db,
    journal_item: &str,
    src: &Path,
    name: &OsString,
    target_dir: &Path,
    strategy: ConflictStrategy,
    rewrite: &dyn Fn(&Path, &Path) -> AppResult<()>,
) -> PathOutcome {
    let is_dir = src.is_dir();
    if parent_eq_ci(src, target_dir) {
        return PathOutcome::skipped("文件已经在目标目录内，未移动", None);
    }
    if is_dir {
        if let Ok(c) = std::fs::canonicalize(src) {
            if let Ok(t) = std::fs::canonicalize(target_dir) {
                if t.starts_with(&c) {
                    return PathOutcome::failed("不能把文件夹移动到它自身或子目录中");
                }
            }
        }
    }
    if let Ok(m) = entry_meta(src) {
        if is_reparse_point(&m) {
            return PathOutcome::failed("路径是符号链接/联接点/重解析点，暂不支持移动");
        }
    }
    let (target, skipped) = match resolve_target(target_dir, name, is_dir, strategy) {
        Ok(v) => v,
        Err(e) => return PathOutcome::failed(e.to_string()),
    };
    if skipped {
        return PathOutcome::skipped("目标目录已存在同名文件（同名策略：跳过）", Some(target));
    }
    // 最终目标独占：同路径的另一个移动/复制批次会拿到可重试冲突，
    // 而不是在同一目标上互相 rename（提交本身也保证不覆盖）。
    let _target_claim = match claim_paths(&[(target.clone(), ClaimMode::Exclusive)]) {
        Ok(c) => c,
        Err(e) => return PathOutcome::failed(e.to_string()),
    };
    // 目标目录可能在解析之后被外部程序移除：在真正移动前给出可读原因。
    if let Some(parent) = target.parent() {
        if !parent.is_dir() {
            return PathOutcome::failed(format!(
                "目标目录在移动前已不存在或不可访问: {}",
                parent.display()
            ));
        }
    }
    let journal = match journal_insert(db, journal_item, "move", src, &target) {
        Ok(id) => id,
        Err(e) => return PathOutcome::failed(format!("写入移动日志失败，未执行移动: {e}")),
    };

    #[cfg(test)]
    let same_volume = {
        if test_support::enabled("force_cross_volume") {
            false
        } else {
            same_volume(src, target_dir)
        }
    };
    #[cfg(not(test))]
    let same_volume = same_volume(src, target_dir);

    if same_volume {
        // 不用 std::fs::rename：Windows 上它会带 REPLACE_EXISTING，
        // 与 resolve_target 的检查之间存在覆盖竞态。
        match rename_no_replace(src, &target) {
            Ok(()) => {
                if let Err(e) = journal_phase(db, &journal, "moved") {
                    tracing::warn!("同卷移动阶段日志写入失败，继续按目标存在恢复: {e}");
                }
                return match rewrite(src, &target) {
                    Ok(()) => {
                        if let Err(e) = journal_done(db, &journal) {
                            tracing::warn!("移动完成但清理操作日志失败（不影响结果）: {e}");
                        }
                        PathOutcome::ok(target)
                    }
                    Err(e) => {
                        // 尝试回滚，避免库与磁盘不一致；回滚失败则由启动恢复补写引用。
                        match rename_no_replace(&target, src) {
                            Ok(()) => {
                                if let Err(e2) = journal_done(db, &journal) {
                                    tracing::warn!("回滚后清理操作日志失败: {e2}");
                                }
                                PathOutcome::failed(format!(
                                    "更新暂存架路径失败，已回滚移动: {e}"
                                ))
                            }
                            Err(rollback_err) => PathOutcome {
                                status: "partial",
                                target: Some(target),
                                reason: Some(format!(
                                    "文件已移动到目标但暂存架路径更新失败，回滚也失败（{rollback_err}）；重启后将自动补写引用，请勿手动移动目标"
                                )),
                                recovery: Some(
                                    "保持目标文件在原位，重启应用以自动恢复引用".into(),
                                ),
                                residual_source: None,
                            },
                        }
                    }
                };
            }
            Err(e) if is_already_exists(&e) => {
                // 检查后目标被并发创建：绝不覆盖，交给用户重试（可重新选择冲突策略）。
                if let Err(e2) = journal_done(db, &journal) {
                    tracing::warn!("目标被占用后清理操作日志失败: {e2}");
                }
                return PathOutcome::failed(
                    "目标位置在移动过程中出现同名文件，未覆盖任何文件；请确认后重试",
                );
            }
            Err(e) if e.raw_os_error() == Some(17) => {
                // EXDEV：同卷判定失效（如映射盘），降级到复制 + 校验 + 删除源。
            }
            Err(e) => {
                if let Err(e2) = journal_done(db, &journal) {
                    tracing::warn!("移动失败后清理操作日志失败: {e2}");
                }
                return PathOutcome::failed(format!("移动失败: {e}"));
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
            return PathOutcome::failed(e.to_string());
        }
    };
    // 日志先指向临时副本：中途退出时恢复逻辑可精确清理本次创建的 part。
    if let Err(e) = journal_set_target(db, &journal, &part) {
        if let Err(e2) = journal_done(db, &journal) {
            tracing::warn!("记录临时副本路径失败后清理操作日志失败: {e2}");
        }
        return PathOutcome::failed(format!("记录临时副本路径失败，未执行移动: {e}"));
    }
    if let Err(e) = copy_with_verify(src, &part, &target, is_dir) {
        remove_best_effort(&part);
        if let Err(e2) = journal_done(db, &journal) {
            tracing::warn!("跨盘复制失败后清理操作日志失败: {e2}");
        }
        return PathOutcome::failed(format!("跨盘复制或校验失败，源文件未删除: {e}"));
    }
    // 至此目标已完整校验。关键阶段日志失败时绝不继续删除源。
    if let Err(e) = journal_mark_copied(db, &journal, &target) {
        return PathOutcome {
            status: "partial",
            target: Some(target),
            reason: Some(format!(
                "目标副本已校验完整，但记录复制完成阶段失败，已保留源与目标未删除: {e}"
            )),
            recovery: Some("检查源与目标两份副本，确认后手动删除多余的一份".into()),
            residual_source: None,
        };
    }

    match remove_source_path(src, is_dir) {
        Ok(()) => {
            if let Err(e) = journal_phase(db, &journal, "moved") {
                tracing::warn!("跨盘移动阶段日志写入失败，继续按目标存在恢复: {e}");
            }
            match rewrite(src, &target) {
                Ok(()) => {
                    if let Err(e) = journal_done(db, &journal) {
                        tracing::warn!("移动完成但清理操作日志失败（不影响结果）: {e}");
                    }
                    PathOutcome::ok(target)
                }
                Err(e) => {
                    // 文件系统已完成、数据库未更新：保留目标，交由启动恢复补写。
                    PathOutcome {
                        status: "partial",
                        target: Some(target),
                        reason: Some(format!(
                            "文件已完整移动到目标，但暂存架路径更新失败，重启后将自动恢复: {e}"
                        )),
                        recovery: Some("保持目标文件在原位，重启应用以自动恢复引用".into()),
                        residual_source: None,
                    }
                }
            }
        }
        Err(e) => {
            // 源清理失败：源可能已部分删除，目标可能是唯一完整副本。绝不删除目标。
            let src_still_there = path_lexists(src);
            match rewrite(src, &target) {
                Ok(()) => {
                    if let Err(e2) = journal_done(db, &journal) {
                        tracing::warn!("部分完成后清理操作日志失败: {e2}");
                    }
                    if src_still_there {
                        PathOutcome {
                            status: "partial",
                            target: Some(target),
                            reason: Some(format!(
                                "目标副本已校验完整，但源清理未完成（源可能残留部分文件，{e}）；暂存引用已切到目标位置"
                            )),
                            recovery: Some(
                                "目标副本完整可用；请手动检查并删除残留源目录".into(),
                            ),
                            residual_source: Some(src.to_path_buf()),
                        }
                    } else {
                        let mut out = PathOutcome::ok(target);
                        out.reason = Some(format!(
                            "目标副本已校验完整，源清理返回错误但源已不存在: {e}"
                        ));
                        out
                    }
                }
                Err(err) => {
                    // 目标完整、源可能残留；不删除任何一方，保留日志供恢复重试。
                    PathOutcome {
                        status: "partial",
                        target: Some(target),
                        reason: Some(format!(
                            "目标副本已校验完整，但源清理未完成且暂存路径更新失败: 清理错误 {e}；更新错误 {err}"
                        )),
                        recovery: Some(
                            "保留源与目标，重启应用后检查恢复日志并手动确认".into(),
                        ),
                        residual_source: if src_still_there {
                            Some(src.to_path_buf())
                        } else {
                            None
                        },
                    }
                }
            }
        }
    }
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
    let outcome = copy_path_core(db, &item.id, &src, &name, target_dir, strategy);
    entry.status = outcome.status.into();
    entry.target = outcome.target.map(|p| p.to_string_lossy().into_owned());
    entry.reason = outcome.reason;
    entry.recovery = outcome.recovery;
    entry.residual_source = outcome
        .residual_source
        .map(|p| p.to_string_lossy().into_owned());
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
        let manifest = walk_tree(root)
            .map_err(|e| std::io::Error::other(format!("构造部分删除故障失败: {e}")))?;
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
    if overlaps_shelf_root(&src, root) {
        entry.reason = Some(
            "不能移动 Task Dock 暂存架数据目录或其上级/内部目录，否则会破坏托管文件引用".into(),
        );
        return entry;
    }
    if !seen_sources.insert(src.to_string_lossy().to_lowercase()) {
        entry.status = "skipped".into();
        entry.reason = Some("同批次存在指向同一文件的重复记录，已跳过".into());
        return entry;
    }
    let name = match source_name(&src) {
        Ok(n) => n,
        Err(e) => {
            entry.reason = Some(e.to_string());
            return entry;
        }
    };
    let outcome = move_path_core(
        db,
        &item.id,
        &src,
        &name,
        target_dir,
        strategy,
        &|old, new| rewrite_after_move(db, old, new),
    );
    entry.status = outcome.status.into();
    entry.target = outcome.target.map(|p| p.to_string_lossy().into_owned());
    entry.reason = outcome.reason;
    entry.recovery = outcome.recovery;
    entry.residual_source = outcome
        .residual_source
        .map(|p| p.to_string_lossy().into_owned());
    entry
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
    let claim_targets: Vec<PathBuf> = order.iter().filter_map(|(_, src)| src.clone()).collect();
    // 移动会改变源（独占）；目标目录只要求保持原位（同目录并发复制安全）。
    let _path_claim = claim_batch(&claim_targets, ClaimMode::Exclusive, &dir)?;
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
            let moved_from = planned_src.clone().or_else(|| current_src.clone());
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
    let claim_targets: Vec<PathBuf> = order.iter().filter_map(|(_, src)| src.clone()).collect();
    // 复制只读取源（共享，可与其他复制并行）；目标目录同样只要求保持原位。
    let _path_claim = claim_batch(&claim_targets, ClaimMode::Shared, &dir)?;
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

// ── 收集箱直接投递（任意外部路径 → 目标目录） ────────────────
//
// 与 `copy_items` / `move_items` 的区别只有两点：
// 1. 源是**用户拖入的任意绝对路径**，不是暂存条目；因此没有 `original_path` 可改写，
//    也没有「条目已删除/已失效」这类判定；
// 2. 目标由**目标 id** 解析（后端按 id 取权威路径），前端不传目录字符串。
// 磁盘语义（冲突策略、流式复制、校验、原子提交、跨卷删源顺序）全部复用同一套 core。

/// 投递日志的归属前缀：`shelf_file_ops.item_id` 没有外键，用前缀区分「条目操作」
/// 与「投递批次」，启动恢复据此走各自的收敛分支。
pub const DROP_JOURNAL_PREFIX: &str = "drop:";

#[derive(Debug, Serialize)]
pub struct DropEntry {
    pub source: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// ok / skipped / failed / partial
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub residual_source: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DropReport {
    pub batch_id: String,
    pub target_id: String,
    pub target_path: String,
    /// 实际使用的模式：copy | move
    pub op: String,
    /// 去重后的待处理条数
    pub total: i64,
    pub success: i64,
    pub skipped: i64,
    pub failed: i64,
    pub partial: i64,
    pub entries: Vec<DropEntry>,
}

/// 校验并去重拖入路径：只接受绝对路径，重复项按大小写不敏感去重。
fn dedup_drop_paths(paths: &[String]) -> AppResult<Vec<(PathBuf, String)>> {
    let mut out: Vec<(PathBuf, String)> = Vec::new();
    let mut seen = HashSet::new();
    for raw in paths {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let p = normalize_original_path(raw)?;
        let key = p.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            out.push((p, raw.to_string()));
        }
    }
    if out.is_empty() {
        return Err(AppError::Validation("没有可投递的文件".into()));
    }
    if out.len() > MAX_BATCH {
        return Err(AppError::Validation(format!(
            "单次最多投递 {MAX_BATCH} 项，请分批拖入"
        )));
    }
    Ok(out)
}

/// 把拖入的路径投递到某个已配置的目标目录。
///
/// 失败一律落到**单条结果**而不是整批报错：单个文件被占用/无权限不能阻断其他独立文件。
/// 只有「目标不可用」「参数非法」这类前置条件才返回 Err（此时没有执行任何文件操作）。
pub fn drop_paths(
    db: &Db,
    root: &Path,
    target: &DropTarget,
    paths: &[String],
    batch_id: &str,
) -> AppResult<DropReport> {
    let dir = normalize_target_dir(&target.path, root).map_err(|e| {
        AppError::NotFound(format!(
            "目标目录不可用: {}（{e}）。请检查磁盘是否连接，或重新选择目录",
            target.path
        ))
    })?;
    let strategy = parse_conflict_strategy(&target.conflict)?;
    let move_mode = target.op_mode == OP_MOVE;
    let mut sources = dedup_drop_paths(paths)?;

    // 父目录先处理：拖入「文件夹 + 其中的文件」时，子项随父目录走，不重复操作。
    sources.sort_by_key(|(p, _)| path_depth(p));

    let claim_targets: Vec<PathBuf> = sources.iter().map(|(p, _)| p.clone()).collect();
    // 投递同时占用源与目标：复制只读源（共享），移动独占源；目标目录只要求保持原位。
    let source_mode = if move_mode {
        ClaimMode::Exclusive
    } else {
        ClaimMode::Shared
    };
    let _path_claim = claim_batch(&claim_targets, source_mode, &dir)?;

    let journal_item = format!("{DROP_JOURNAL_PREFIX}{batch_id}");
    // 本批次已处理的父目录及其结果。**必须在操作前记录类型**：移动成功后源目录
    // 已不存在，用 `src.is_dir()` 反查会得到 false，子项就会绕过「随父目录处理」
    // 的判断被重复执行并误报失败。
    let mut processed_dirs: Vec<(PathBuf, PathOutcome)> = Vec::new();
    let mut entries: Vec<DropEntry> = Vec::with_capacity(sources.len());

    for (src, raw) in sources {
        let display_name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw.clone());

        // 源类型在任何磁盘操作之前确定（移动/删除会改变源路径的存在性）。
        let src_is_dir = src.is_dir();

        // 父目录已处理时，子项的最终去向由父目录决定：即使子项的源路径已被父目录
        // 的移动带走（`src.exists()` 为 false），也不能据此断言它失败。
        let outcome = if let Some((parent, parent_outcome)) = processed_dirs
            .iter()
            .find(|(d, _)| is_strict_descendant(&src, d))
        {
            match parent_outcome.status {
                "ok" => PathOutcome::skipped(
                    format!(
                        "父目录「{}」已在本批次中处理，子项随其一起完成",
                        parent.display()
                    ),
                    None,
                ),
                _ if parent_outcome.status == "skipped" => PathOutcome::skipped(
                    format!(
                        "父目录「{}」已在本批次中跳过，子项未单独处理",
                        parent.display()
                    ),
                    None,
                ),
                _ => {
                    // 父目录只完成了一部分：子项可能已随父目录到达目标，也可能残留在
                    // 源目录里。不冒充成功，也不重复执行文件操作。
                    let residual = parent_outcome
                        .residual_source
                        .clone()
                        .unwrap_or_else(|| parent.clone());
                    PathOutcome {
                        status: "partial",
                        target: None,
                        reason: Some(format!(
                            "父目录「{}」本批次仅部分完成，子项可能残留在源目录，需要人工确认",
                            parent.display()
                        )),
                        recovery: Some("检查源目录残留副本与目标目录，删除多余的一份".into()),
                        residual_source: Some(residual),
                    }
                }
            }
        } else if !src.exists() {
            PathOutcome::failed("源文件已不存在（可能已被移动或删除）")
        } else if parent_eq_ci(&src, &dir) {
            PathOutcome::skipped("已经在目标目录内，未重复处理", None)
        } else if let Ok(canon_src) = std::fs::canonicalize(&src) {
            match std::fs::canonicalize(root) {
                Ok(canon_root) if canon_src.starts_with(&canon_root) => {
                    PathOutcome::failed("不能把暂存架自己的托管目录投递到外部目录")
                }
                _ => run_drop_one(db, &journal_item, &src, &dir, strategy, move_mode),
            }
        } else {
            PathOutcome::failed("无法读取源路径（权限不足或路径不可访问）")
        };

        // 只要父目录有明确结果（成功/按策略跳过/部分完成），子项就不再单独操作；
        // 只有失败的父目录才允许子项按独立条目继续尝试。
        if src_is_dir && outcome.status != "failed" {
            processed_dirs.push((src.clone(), outcome.clone()));
        }
        entries.push(DropEntry {
            source: raw,
            display_name,
            target: outcome.target.map(|p| p.to_string_lossy().into_owned()),
            status: outcome.status.to_string(),
            reason: outcome.reason,
            recovery: outcome.recovery,
            residual_source: outcome
                .residual_source
                .map(|p| p.to_string_lossy().into_owned()),
        });
    }

    if entries.iter().any(|e| e.status == "ok") {
        // 与文件操作面板共用「最近目录」：投递成功过的目录也会出现在移动/复制面板里。
        if let Err(e) = touch_recent_dir(db, &dir.to_string_lossy()) {
            tracing::warn!("记录最近使用目录失败（不影响投递结果）: {e}");
        }
    }

    let count = |s: &str| entries.iter().filter(|e| e.status == s).count() as i64;
    Ok(DropReport {
        batch_id: batch_id.to_string(),
        target_id: target.id.clone(),
        target_path: dir.to_string_lossy().into_owned(),
        op: if move_mode { OP_MOVE } else { OP_COPY }.to_string(),
        total: entries.len() as i64,
        success: count("ok"),
        skipped: count("skipped"),
        failed: count("failed"),
        partial: count("partial"),
        entries,
    })
}

/// 单个路径的投递；`rewrite` 恒成功——投递不产生任何数据库引用需要改写。
fn run_drop_one(
    db: &Db,
    journal_item: &str,
    src: &Path,
    dir: &Path,
    strategy: ConflictStrategy,
    move_mode: bool,
) -> PathOutcome {
    let name = match source_name(src) {
        Ok(n) => n,
        Err(e) => return PathOutcome::failed(e.to_string()),
    };
    if move_mode {
        move_path_core(db, journal_item, src, &name, dir, strategy, &|_, _| Ok(()))
    } else {
        copy_path_core(db, journal_item, src, &name, dir, strategy)
    }
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
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::NotFound(format!("所选路径不可访问: {}（{e}）", path.display())))?;
    let type_ok = if item.kind == KIND_FOLDER {
        meta.is_dir()
    } else {
        meta.is_file()
    };
    if !type_ok {
        return Err(AppError::Validation("所选路径类型与条目类型不匹配".into()));
    }
    let ext = if meta.is_file() { ext_of(&path) } else { None };
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
                conn.query_row("SELECT COUNT(*) FROM shelf_recent_dirs", [], |r| r.get(0))?;
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
                        conn.execute("DELETE FROM shelf_recent_dirs WHERE path = ?1", params![p])?;
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

#[cfg(test)]
mod move_safety_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-fsops-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rename_no_replace_refuses_to_overwrite_existing_target() {
        let dir = temp_dir("no-replace");
        let src = dir.join("src.txt");
        let dst = dir.join("dst.txt");
        std::fs::write(&src, b"source").unwrap();
        std::fs::write(&dst, b"existing").unwrap();

        let err = rename_no_replace(&src, &dst).unwrap_err();
        assert!(is_already_exists(&err), "unexpected error: {err}");
        // 两边内容都必须保持原样（源未移动、目标未被覆盖）。
        assert_eq!(std::fs::read(&src).unwrap(), b"source");
        assert_eq!(std::fs::read(&dst).unwrap(), b"existing");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_no_replace_moves_when_target_absent() {
        let dir = temp_dir("move-ok");
        let src = dir.join("src.txt");
        let dst = dir.join("dst.txt");
        std::fs::write(&src, b"payload").unwrap();
        rename_no_replace(&src, &dst).unwrap();
        assert!(!src.exists());
        assert_eq!(std::fs::read(&dst).unwrap(), b"payload");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_no_replace_refuses_to_overwrite_existing_directory() {
        let dir = temp_dir("dir-no-replace");
        let src = dir.join("src-dir");
        let dst = dir.join("dst-dir");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("a.txt"), b"src").unwrap();
        std::fs::write(dst.join("keep.txt"), b"keep").unwrap();

        let err = rename_no_replace(&src, &dst).unwrap_err();
        // 关键是「绝不覆盖」，具体错误码由系统决定（183 / 5 都代表目标存在）。
        assert!(src.join("a.txt").exists(), "源目录不得被移走");
        assert_eq!(
            std::fs::read(dst.join("keep.txt")).unwrap(),
            b"keep",
            "已有目录与其内容不得被替换（err={err}）"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copy_commit_never_replaces_file_target_created_after_final_check() {
        let dir = temp_dir("commit-race-file");
        test_support::clear();
        let src = dir.join("a.txt");
        std::fs::write(&src, b"payload").unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let target = out.join("a.txt");
        let part = part_path(&target).unwrap();

        // 目标在最后一次 exists 检查之后、真正提交之前出现（并发方写入）。
        test_support::set_once("target_appears_before_commit");
        let err = copy_with_verify(&src, &part, &target, false).unwrap_err();

        assert!(
            err.to_string().contains("拒绝覆盖") || err.to_string().contains("已存在"),
            "必须以冲突失败而不是静默覆盖: {err}"
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"racer",
            "绝不能覆盖并发创建的目标文件"
        );
        assert!(!part.exists(), "提交失败后必须回收临时副本");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copy_commit_never_replaces_directory_target_created_after_final_check() {
        let dir = temp_dir("commit-race-dir");
        test_support::clear();
        let src = dir.join("folder");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("sub").join("x.txt"), b"x").unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let target = out.join("folder");
        let part = part_path(&target).unwrap();

        test_support::set_once("target_appears_before_commit");
        let err = copy_with_verify(&src, &part, &target, true).unwrap_err();

        assert!(
            err.to_string().contains("拒绝覆盖") || err.to_string().contains("已存在"),
            "目录提交同样必须 fail-closed: {err}"
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"racer",
            "不得覆盖目标路径"
        );
        assert!(!part.exists(), "提交失败后必须回收临时副本");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claim_paths_rejects_same_and_nested_paths_until_released() {
        let dir = temp_dir("claim-tree");
        let tree = dir.join("tree");
        std::fs::create_dir_all(tree.join("sub")).unwrap();
        let child = tree.join("sub").join("a.txt");
        std::fs::write(&child, b"a").unwrap();
        let decoy = dir.join("tree2");
        std::fs::create_dir_all(&decoy).unwrap();
        let other = dir.join("other");
        std::fs::create_dir_all(&other).unwrap();

        let held = claim_paths(&[(tree.clone(), ClaimMode::Exclusive)]).unwrap();
        // 相同路径
        let err = claim_paths(&[(tree.clone(), ClaimMode::Exclusive)]).unwrap_err();
        assert!(err.to_string().contains("父子目录"), "{err}");
        // 后代路径（父目录移动 VS 子文件移动）
        let err = claim_paths(&[(child.clone(), ClaimMode::Exclusive)]).unwrap_err();
        assert!(err.to_string().contains("父子目录"), "{err}");
        // 大小写不同仍是同一路径
        let upper = PathBuf::from(tree.to_string_lossy().to_uppercase());
        assert!(
            claim_paths(&[(upper, ClaimMode::Exclusive)]).is_err(),
            "大小写不敏感"
        );
        // 名字前缀相近但不是祖先：不得误伤无关目录
        let decoy_claim = claim_paths(&[(decoy.clone(), ClaimMode::Exclusive)]).unwrap();
        drop(decoy_claim);
        let other_claim = claim_paths(&[(other.clone(), ClaimMode::Exclusive)]).unwrap();
        drop(other_claim);

        // 释放后立即可再次占用（成功/失败/提前返回都走 Drop）
        drop(held);
        let child_claim = claim_paths(&[(child.clone(), ClaimMode::Exclusive)]).unwrap();
        assert!(
            claim_paths(&[(tree.clone(), ClaimMode::Exclusive)]).is_err(),
            "子路径占用期间父目录同样冲突（双向保护）"
        );
        drop(child_claim);
        assert!(claim_paths(&[(tree.clone(), ClaimMode::Exclusive)]).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 读写分层：同一稳定目录可以并行写入不同文件；独占目标文件仍互斥。
    #[test]
    fn shared_directory_claim_allows_parallel_writers() {
        let dir = temp_dir("claim-shared");
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();

        // 两个批次都只要求目标目录保持原位：允许并行
        let a = claim_paths(&[(out.clone(), ClaimMode::Shared)]).unwrap();
        let b = claim_paths(&[(out.clone(), ClaimMode::Shared)]).unwrap();
        // 各自的最终目标文件独占，互不干扰
        let fa = claim_paths(&[(out.join("a.txt"), ClaimMode::Exclusive)]).unwrap();
        let fb = claim_paths(&[(out.join("b.txt"), ClaimMode::Exclusive)]).unwrap();
        drop((fa, fb, a, b));

        // 同一最终目标：后到者必须冲突
        let first = claim_paths(&[(out.join("same.txt"), ClaimMode::Exclusive)]).unwrap();
        let err = claim_paths(&[(out.join("same.txt"), ClaimMode::Exclusive)]).unwrap_err();
        assert!(err.to_string().contains("冲突"), "{err}");
        drop(first);
        assert!(claim_paths(&[(out.join("same.txt"), ClaimMode::Exclusive)]).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 目录被独占（正在被移动/删除）时，写入方必须被拒绝；
    /// 反过来，正在写入的目录也不能被搬走。
    #[test]
    fn exclusive_directory_blocks_shared_writers_in_both_directions() {
        let dir = temp_dir("claim-rw");
        let out = dir.join("out");
        std::fs::create_dir_all(out.join("sub")).unwrap();

        let moving = claim_paths(&[(out.clone(), ClaimMode::Exclusive)]).unwrap();
        let err = claim_paths(&[(out.clone(), ClaimMode::Shared)]).unwrap_err();
        assert!(err.to_string().contains("冲突"), "{err}");
        // 祖先独占同样挡住后代写入（把 D:\Archive 搬走会毁掉 D:\Archive\Docs 的写入）
        let err = claim_paths(&[(out.join("sub"), ClaimMode::Shared)]).unwrap_err();
        assert!(err.to_string().contains("冲突"), "{err}");
        drop(moving);

        let writing = claim_paths(&[(out.join("sub"), ClaimMode::Shared)]).unwrap();
        let err = claim_paths(&[(out.clone(), ClaimMode::Exclusive)]).unwrap_err();
        assert!(err.to_string().contains("冲突"), "{err}");
        drop(writing);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 一次失败的占用不能留下「部分占用」：要么全占用，要么全不占。
    #[test]
    fn failed_claim_does_not_partially_reserve_paths() {
        let dir = temp_dir("claim-atomic");
        let busy = dir.join("busy");
        let free = dir.join("free");
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::create_dir_all(&free).unwrap();

        let held = claim_paths(&[(busy.clone(), ClaimMode::Exclusive)]).unwrap();
        let err = claim_paths(&[
            (free.clone(), ClaimMode::Exclusive),
            (busy.clone(), ClaimMode::Exclusive),
        ])
        .unwrap_err();
        assert!(err.to_string().contains("冲突"), "{err}");
        // free 没有被前一次失败留下
        let free_claim = claim_paths(&[(free.clone(), ClaimMode::Exclusive)]).unwrap();
        drop(free_claim);
        drop(held);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn drop_target_for(
        db: &Db,
        root: &Path,
        dir: &Path,
        mode: &str,
    ) -> super::super::drop_targets::DropTarget {
        std::fs::create_dir_all(dir).unwrap();
        super::super::drop_targets::create(
            db,
            root,
            "归档",
            &dir.to_string_lossy(),
            true,
            mode,
            "rename",
        )
        .unwrap()
    }

    /// 目标目录正被其他批次移动时，复制/移动投递都必须整批拒绝（不写任何文件）。
    #[test]
    fn drop_into_directory_being_moved_is_rejected() {
        let dir = temp_dir("claim-target-move");
        let db = Db::open_in_memory().unwrap();
        let root = dir.join("shelf");
        let src = dir.join("a.txt");
        std::fs::write(&src, b"payload").unwrap();
        let out = dir.join("out");
        let copy_target = drop_target_for(&db, &root, &out, "copy");
        // 同一目录上的「移动模式」配置：直接改内存结构，避免重复路径被 create 拒绝
        let mut move_target = copy_target.clone();
        move_target.op_mode = "move".into();

        let moving = claim_paths(&[(out.clone(), ClaimMode::Exclusive)]).unwrap();
        for target in [&copy_target, &move_target] {
            let err = drop_paths(
                &db,
                &root,
                target,
                &[src.to_string_lossy().into_owned()],
                "b-target-claim",
            )
            .unwrap_err();
            assert!(err.to_string().contains("冲突"), "{err}");
        }
        assert!(src.exists(), "被拒绝的批次不得动源文件");
        assert!(!out.join("a.txt").exists(), "被拒绝的批次不得写目标目录");

        drop(moving);
        let report = drop_paths(
            &db,
            &root,
            &copy_target,
            &[src.to_string_lossy().into_owned()],
            "b-target-claim",
        )
        .unwrap();
        assert_eq!(report.success, 1, "{:?}", report.entries);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 另一个批次已在向同一目录复制另一个文件：本批次必须能并行完成，不被无谓串行化。
    #[test]
    fn parallel_drop_into_same_directory_only_blocks_same_target() {
        let dir = temp_dir("claim-parallel");
        let db = Db::open_in_memory().unwrap();
        let root = dir.join("shelf");
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        let out = dir.join("out");
        let target = drop_target_for(&db, &root, &out, "copy");

        // 模拟另一个在途批次：共享目标目录 + 独占 out/a.txt
        let _other_dir = claim_paths(&[(out.clone(), ClaimMode::Shared)]).unwrap();
        let _other_file = claim_paths(&[(out.join("a.txt"), ClaimMode::Exclusive)]).unwrap();

        let report = drop_paths(
            &db,
            &root,
            &target,
            &[b.to_string_lossy().into_owned()],
            "b-parallel",
        )
        .unwrap();
        assert_eq!(
            report.success, 1,
            "不同目标文件必须可并行: {:?}",
            report.entries
        );
        assert_eq!(std::fs::read(out.join("b.txt")).unwrap(), b"b");

        // 同一目标文件则必须冲突（而不是两个批次各写一份）
        let err = drop_paths(
            &db,
            &root,
            &target,
            &[a.to_string_lossy().into_owned()],
            "b-parallel",
        )
        .unwrap();
        assert_eq!(err.failed, 1, "{:?}", err.entries);
        assert!(
            err.entries[0]
                .reason
                .as_deref()
                .unwrap_or("")
                .contains("冲突"),
            "{:?}",
            err.entries
        );
        assert!(a.exists(), "冲突时源文件保持原样");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 复制过程中目标目录被外部删除：必须失败并保留源，不得声称成功。
    #[test]
    fn target_dir_removed_before_commit_keeps_source_and_fails() {
        let dir = temp_dir("claim-dir-removed");
        let db = Db::open_in_memory().unwrap();
        let root = dir.join("shelf");
        let src = dir.join("a.txt");
        std::fs::write(&src, b"payload").unwrap();
        let out = dir.join("out");
        let target = drop_target_for(&db, &root, &out, "copy");

        test_support::clear();
        test_support::set_once("target_dir_removed_before_commit");
        let report = drop_paths(
            &db,
            &root,
            &target,
            &[src.to_string_lossy().into_owned()],
            "b-dir-gone",
        )
        .unwrap();

        assert_eq!(report.success, 0, "{:?}", report.entries);
        assert_eq!(report.failed, 1, "{:?}", report.entries);
        let reason = report.entries[0].reason.as_deref().unwrap_or("");
        assert!(reason.contains("已不存在"), "{reason}");
        assert_eq!(std::fs::read(&src).unwrap(), b"payload", "源文件必须完好");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 集成层：父目录正被移动时，同一目录树里的子文件复制必须被拒绝（而不是并发执行）。
    #[test]
    fn drop_batch_is_rejected_while_parent_directory_is_claimed() {
        let dir = temp_dir("claim-drop");
        let db = Db::open_in_memory().unwrap();
        let root = dir.join("shelf");
        let tree = dir.join("tree");
        std::fs::create_dir_all(&tree).unwrap();
        let child = tree.join("a.txt");
        std::fs::write(&child, b"a").unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let target = super::super::drop_targets::create(
            &db,
            &root,
            "归档",
            &out.to_string_lossy(),
            true,
            "copy",
            "rename",
        )
        .unwrap();

        let held = claim_paths(&[(tree.clone(), ClaimMode::Exclusive)]).unwrap();
        let err = drop_paths(
            &db,
            &root,
            &target,
            &[child.to_string_lossy().into_owned()],
            "b-claim",
        )
        .unwrap_err();
        assert!(err.to_string().contains("父子目录"), "{err}");
        assert!(!out.join("a.txt").exists(), "冲突时不得写入任何文件");

        drop(held);
        let report = drop_paths(
            &db,
            &root,
            &target,
            &[child.to_string_lossy().into_owned()],
            "b-claim",
        )
        .unwrap();
        assert_eq!(report.success, 1, "{:?}", report.entries);
        assert!(out.join("a.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 批次失败（校验失败/异常返回）后路径占用必须释放，下一批能正常拿到锁。
    #[test]
    fn failed_drop_batch_releases_path_claim() {
        let dir = temp_dir("claim-release");
        let db = Db::open_in_memory().unwrap();
        let root = dir.join("shelf");
        let src = dir.join("a.txt");
        std::fs::write(&src, b"payload").unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let target = super::super::drop_targets::create(
            &db,
            &root,
            "归档",
            &out.to_string_lossy(),
            true,
            "copy",
            "rename",
        )
        .unwrap();
        test_support::clear();
        test_support::set_once("copy_corrupt");

        let first = drop_paths(
            &db,
            &root,
            &target,
            &[src.to_string_lossy().into_owned()],
            "b-fail",
        )
        .unwrap();
        assert_eq!(first.failed, 1, "{:?}", first.entries);

        let second = drop_paths(
            &db,
            &root,
            &target,
            &[src.to_string_lossy().into_owned()],
            "b-retry",
        )
        .unwrap();
        assert_eq!(second.success, 1, "{:?}", second.entries);
        assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"payload");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn overlaps_shelf_root_rejects_root_ancestor_and_child() {
        let root = temp_dir("shelf-root");
        let child = root.join("files");
        std::fs::create_dir_all(&child).unwrap();
        let other = temp_dir("outside");
        let ancestor = root.parent().unwrap().to_path_buf();

        assert!(overlaps_shelf_root(&root, &root));
        assert!(overlaps_shelf_root(&child, &root));
        assert!(overlaps_shelf_root(&ancestor, &root));
        assert!(!overlaps_shelf_root(&other, &root));
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&other).ok();
    }
}
