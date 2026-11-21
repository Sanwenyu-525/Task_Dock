//! 复制暂存账本与崩溃恢复。
//!
//! 复制的中间态必须可识别、可回收，但**绝不能误删用户文件**。因此这里分三层：
//!
//! 1. **暂存目录只建在目标旁边**（同卷 rename 才原子），名字固定前缀
//!    `.taskdock-copy-<uuid>`，内含 `data` 与 `.taskdock-copy.json` 标记；
//! 2. **账本** `<data_dir>/copy-stages.json` 记录「哪个暂存目录属于哪次复制」，
//!    正常结束/失败/取消都会注销；进程被杀时账本条目留下来；
//! 3. **恢复**只处理账本里**同时满足**「父目录等于目标父目录 + 目录名前缀正确 +
//!    标记文件里的 id 与账本一致 + app 标记正确」的暂存目录，且只删自己写的
//!    `data` / 标记文件，最后 `rmdir`（目录非空就保留，绝不递归删未知内容）。
//!
//! 目录复制没有暂存目录（逐项写进目标），因此**不自动清理**：中断只在账本里留一条
//! `kind=dir` 记录，恢复时作为「上次复制未完成」报告给调用方，目标目录原样保留。

use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// 与 `file_workspace` 主模块同口径：重解析点（junction/符号链接）不当作普通目录。
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// 暂存目录名前缀（用户可见，明确表达归属）。
pub const STAGE_PREFIX: &str = ".taskdock-copy-";
/// 暂存目录内的归属标记文件。
pub const MARKER_FILE: &str = ".taskdock-copy.json";
/// 暂存数据文件名（与 `copy_file_to_stage` 约定一致）。
pub const DATA_FILE: &str = "data";
/// 账本文件名（位于应用数据根）。
pub const LEDGER_FILE: &str = "copy-stages.json";
/// 归属标记里的应用标识：缺它一律不认。
const APP_TAG: &str = "task-dock";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StageEntry {
    pub id: String,
    /// 暂存目录绝对路径。
    pub stage: String,
    /// 最终目标（文件或目录）。
    pub dst: String,
    pub src: String,
    /// file | dir
    pub kind: String,
    pub created_ms: i64,
    pub pid: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Ledger {
    version: u32,
    #[serde(default)]
    entries: Vec<StageEntry>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 1,
            entries: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct StageMarker {
    app: String,
    version: u32,
    id: String,
    dst: String,
    src: String,
    kind: String,
}

/// 恢复结果：删了什么、留了什么、哪些目录复制被中断。
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    /// 成功清掉的暂存目录数。
    pub removed: usize,
    /// 无法证明归属、原样保留的条目数（不是失败，是拒绝越权）。
    pub kept: usize,
    /// 账本损坏导致的条目丢失数（损坏时不猜内容）。
    pub unreadable: usize,
    /// 上次中断的目录复制目标：只报告，目录内容与用户文件原样保留。
    pub partial_dirs: Vec<String>,
}

impl RecoveryReport {
    pub fn is_empty(&self) -> bool {
        self.removed == 0 && self.kept == 0 && self.unreadable == 0 && self.partial_dirs.is_empty()
    }
}

static ROOT: OnceLock<PathBuf> = OnceLock::new();
static LEDGER_LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn pid() -> u32 {
    std::process::id()
}

/// 绑定数据根并执行一次恢复。重复调用只恢复一次（幂等）。
pub fn init_and_recover(root: &Path) -> RecoveryReport {
    let _ = ROOT.set(root.to_path_buf());
    recover(root)
}

fn ledger_path(root: &Path) -> PathBuf {
    root.join(LEDGER_FILE)
}

fn read_ledger(root: &Path) -> (Ledger, usize) {
    match std::fs::read_to_string(ledger_path(root)) {
        Ok(text) => match serde_json::from_str::<Ledger>(&text) {
            Ok(ledger) => (ledger, 0),
            // 损坏：不猜内容，按空账本处理（于是不会删除任何目录）。
            Err(_) => (Ledger::default(), 1),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Ledger::default(), 0),
        Err(_) => (Ledger::default(), 1),
    }
}

fn write_ledger(root: &Path, ledger: &Ledger) {
    let path = ledger_path(root);
    let Ok(text) = serde_json::to_string_pretty(ledger) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_err() {
        return;
    }
    // 同目录 rename：Windows 上 Rust 的 rename 是 MoveFileEx(REPLACE_EXISTING)。
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn ledger_add(entry: StageEntry) {
    let Some(root) = ROOT.get() else {
        return;
    };
    let _guard = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (mut ledger, _) = read_ledger(root);
    ledger.entries.retain(|existing| existing.id != entry.id);
    ledger.entries.push(entry);
    write_ledger(root, &ledger);
}

fn ledger_remove(id: &str) {
    let Some(root) = ROOT.get() else {
        return;
    };
    let _guard = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (mut ledger, _) = read_ledger(root);
    let before = ledger.entries.len();
    ledger.entries.retain(|entry| entry.id != id);
    if ledger.entries.len() != before {
        write_ledger(root, &ledger);
    }
}

/// 暂存目录是否可能是「为这个目标建的」（纯路径判定，不做 IO）。
pub(crate) fn is_valid_stage_dir(stage: &Path, dst: &Path) -> bool {
    let Some(name) = stage.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if !name.starts_with(STAGE_PREFIX) {
        return false;
    }
    match (stage.parent(), dst.parent()) {
        (Some(stage_parent), Some(dst_parent)) => stage_parent == dst_parent,
        _ => false,
    }
}

fn marker_matches(marker: &StageMarker, entry_id: &str) -> bool {
    marker.app == APP_TAG && marker.version == 1 && marker.id == entry_id
}

fn marker_path(stage: &Path) -> PathBuf {
    stage.join(MARKER_FILE)
}

fn write_marker(stage: &Path, id: &str, src: &Path, dst: &Path, kind: &str) -> std::io::Result<()> {
    let marker = StageMarker {
        app: APP_TAG.to_string(),
        version: 1,
        id: id.to_string(),
        dst: dst.to_string_lossy().into_owned(),
        src: src.to_string_lossy().into_owned(),
        kind: kind.to_string(),
    };
    let text = serde_json::to_vec_pretty(&marker)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(marker_path(stage), text)
}

fn clear_readonly(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    let mut permissions = meta.permissions();
    if permissions.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        let _ = std::fs::set_permissions(path, permissions);
    }
}

/// 删除**我们自己写的**暂存目录。目录非空（有未知内容）就保留：绝不递归删。
fn remove_stage_dir(stage: &Path) -> bool {
    let data = stage.join(DATA_FILE);
    if data.exists() {
        clear_readonly(&data);
        if std::fs::remove_file(&data).is_err() {
            return false;
        }
    }
    let marker = marker_path(stage);
    if marker.exists() {
        clear_readonly(&marker);
        if std::fs::remove_file(&marker).is_err() {
            return false;
        }
    }
    std::fs::remove_dir(stage).is_ok()
}

/// 一次复制的暂存句柄：`finish()` 或 drop 都会尽力清掉自己写的东西。
pub struct StageGuard {
    id: String,
    stage: PathBuf,
    done: bool,
}

impl StageGuard {
    /// 复制中间文件的落点。
    pub fn data_path(&self) -> PathBuf {
        self.stage.join(DATA_FILE)
    }

    pub fn stage_dir(&self) -> &Path {
        &self.stage
    }

    fn cleanup(&self) {
        if remove_stage_dir(&self.stage) {
            ledger_remove(&self.id);
        }
        // 目录没清掉：保留账本条目，下次启动再试（不清就无法证明已清理，不能假装成功）。
    }

    /// 正常结束：清掉暂存目录并注销账本。
    pub fn finish(mut self) {
        self.done = true;
        self.cleanup();
    }
}

impl Drop for StageGuard {
    fn drop(&mut self) {
        if !self.done {
            // 失败/取消/panic：同样只清自己的目录。
            self.cleanup();
        }
    }
}

/// 文件复制：建暂存目录 + 归属标记 + 账本条目。
pub fn begin_file_stage(src: &Path, dst: &Path) -> std::io::Result<StageGuard> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let stage = dst.with_file_name(format!("{STAGE_PREFIX}{id}"));
    std::fs::create_dir(&stage)?;
    let guard = StageGuard {
        id: id.clone(),
        stage: stage.clone(),
        done: false,
    };
    // 标记写不进去就不该继续：没有标记的暂存目录在恢复时无法证明归属。
    if let Err(error) = write_marker(&stage, &id, src, dst, "file") {
        drop(guard);
        return Err(error);
    }
    ledger_add(StageEntry {
        id,
        stage: stage.to_string_lossy().into_owned(),
        dst: dst.to_string_lossy().into_owned(),
        src: src.to_string_lossy().into_owned(),
        kind: "file".to_string(),
        created_ms: now_ms(),
        pid: pid(),
    });
    Ok(guard)
}

/// 目录复制的中断记录（不建目录、不写用户目标）：只用于「上次没复制完」的报告。
pub struct DirNote {
    id: String,
    done: bool,
}

impl DirNote {
    pub fn finish(mut self) {
        self.done = true;
        ledger_remove(&self.id);
    }
}

impl Drop for DirNote {
    fn drop(&mut self) {
        if !self.done {
            ledger_remove(&self.id);
        }
    }
}

pub fn note_dir_copy(src: &Path, dst: &Path) -> DirNote {
    let id = uuid::Uuid::new_v4().simple().to_string();
    ledger_add(StageEntry {
        id: id.clone(),
        // 目录复制没有暂存目录：stage 与 dst 相同，恢复时按 kind=dir 只报告不删除。
        stage: dst.to_string_lossy().into_owned(),
        dst: dst.to_string_lossy().into_owned(),
        src: src.to_string_lossy().into_owned(),
        kind: "dir".to_string(),
        created_ms: now_ms(),
        pid: pid(),
    });
    DirNote { id, done: false }
}

/// 恢复：只清「可证明属于我们」的文件暂存目录；目录复制只报告。
pub fn recover(root: &Path) -> RecoveryReport {
    let _guard = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (ledger, unreadable) = read_ledger(root);
    let mut report = RecoveryReport {
        unreadable,
        ..RecoveryReport::default()
    };
    let mut remaining: Vec<StageEntry> = Vec::new();
    let total_entries = ledger.entries.len();

    for entry in ledger.entries {
        if entry.kind == "dir" {
            // 目标目录里可能已有用户文件：只报告，绝不删除。
            if Path::new(&entry.dst).exists() {
                report.partial_dirs.push(entry.dst);
            }
            continue;
        }
        let stage = PathBuf::from(&entry.stage);
        let dst = PathBuf::from(&entry.dst);
        if !is_valid_stage_dir(&stage, &dst) {
            report.kept += 1;
            remaining.push(entry);
            continue;
        }
        match std::fs::symlink_metadata(&stage) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // 已经被清掉了：账本条目是残留，直接丢弃。
            }
            Err(_) => {
                report.kept += 1;
                remaining.push(entry);
            }
            Ok(meta) => {
                if !meta.is_dir()
                    || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                {
                    report.kept += 1;
                    remaining.push(entry);
                    continue;
                }
                // 归属证明：标记文件里的 id 必须与账本一致。
                let verified = std::fs::read(marker_path(&stage))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<StageMarker>(&bytes).ok())
                    .map(|marker| marker_matches(&marker, &entry.id))
                    .unwrap_or(false);
                if !verified {
                    report.kept += 1;
                    remaining.push(entry);
                    continue;
                }
                if remove_stage_dir(&stage) {
                    report.removed += 1;
                } else {
                    report.kept += 1;
                    remaining.push(entry);
                }
            }
        }
    }

    if remaining.len() != total_entries {
        write_ledger(
            root,
            &Ledger {
                version: 1,
                entries: remaining,
            },
        );
    }
    report
}

/// 诊断：当前账本条目数（含未恢复的）。
pub fn pending_entries() -> usize {
    ROOT.get()
        .map(|root| read_ledger(root).0.entries.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "taskdock-stage-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_test_ledger(root: &Path, entries: Vec<StageEntry>) {
        write_ledger(root, &Ledger { version: 1, entries });
    }

    fn entry_for(id: &str, stage: &Path, dst: &Path, kind: &str) -> StageEntry {
        StageEntry {
            id: id.to_string(),
            stage: stage.to_string_lossy().into_owned(),
            dst: dst.to_string_lossy().into_owned(),
            src: r"C:\src\file.bin".to_string(),
            kind: kind.to_string(),
            created_ms: 1,
            pid: 999,
        }
    }

    #[test]
    fn stage_dir_must_be_sibling_with_prefix() {
        let dst = Path::new(r"D:\Work\a.txt");
        assert!(is_valid_stage_dir(
            Path::new(r"D:\Work\.taskdock-copy-abc"),
            dst
        ));
        // 前缀不对
        assert!(!is_valid_stage_dir(Path::new(r"D:\Work\a.copy"), dst));
        // 不是同一父目录
        assert!(!is_valid_stage_dir(
            Path::new(r"D:\Other\.taskdock-copy-abc"),
            dst
        ));
    }

    #[test]
    fn marker_requires_app_version_and_id() {
        let marker = StageMarker {
            app: APP_TAG.into(),
            version: 1,
            id: "abc".into(),
            dst: "d".into(),
            src: "s".into(),
            kind: "file".into(),
        };
        assert!(marker_matches(&marker, "abc"));
        assert!(!marker_matches(&marker, "other"));
        let mut wrong_app = marker.clone();
        wrong_app.app = "someone-else".into();
        assert!(!marker_matches(&wrong_app, "abc"));
    }

    #[test]
    fn recovery_removes_verified_stage_and_keeps_target() {
        let root = temp_root("recover-ok");
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let dst = work.join("report.txt");
        std::fs::write(&dst, b"user data").unwrap();
        let stage = work.join(format!("{STAGE_PREFIX}good"));
        std::fs::create_dir(&stage).unwrap();
        std::fs::write(stage.join(DATA_FILE), b"partial").unwrap();
        write_marker(&stage, "good", Path::new("s"), &dst, "file").unwrap();
        write_test_ledger(&root, vec![entry_for("good", &stage, &dst, "file")]);

        let report = recover(&root);
        assert_eq!(report.removed, 1, "{report:?}");
        assert_eq!(report.kept, 0);
        assert!(!stage.exists(), "暂存目录必须清掉");
        assert!(dst.exists(), "目标文件是用户的，绝不能删");
        assert_eq!(std::fs::read(&dst).unwrap(), b"user data");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recovery_refuses_stage_without_marker() {
        let root = temp_root("recover-nomarker");
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let dst = work.join("a.txt");
        let stage = work.join(format!("{STAGE_PREFIX}sneaky"));
        std::fs::create_dir(&stage).unwrap();
        std::fs::write(stage.join(DATA_FILE), b"x").unwrap();
        write_test_ledger(&root, vec![entry_for("sneaky", &stage, &dst, "file")]);

        let report = recover(&root);
        assert_eq!(report.removed, 0);
        assert_eq!(report.kept, 1);
        assert!(stage.exists(), "无法证明归属时不得删除");
        // 账本条目保留，下次启动还能再判定。
        let (ledger, _) = read_ledger(&root);
        assert_eq!(ledger.entries.len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recovery_drops_stage_with_wrong_id() {
        let root = temp_root("recover-wrong-id");
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let dst = work.join("a.txt");
        let stage = work.join(format!("{STAGE_PREFIX}other"));
        std::fs::create_dir(&stage).unwrap();
        write_marker(&stage, "different-id", Path::new("s"), &dst, "file").unwrap();
        write_test_ledger(&root, vec![entry_for("expected-id", &stage, &dst, "file")]);

        let report = recover(&root);
        assert_eq!(report.removed, 0);
        assert_eq!(report.kept, 1);
        assert!(stage.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recovery_reports_interrupted_dir_copy_without_touching_it() {
        let root = temp_root("recover-dir");
        let dst = root.join("copied-dir");
        std::fs::create_dir_all(&dst).unwrap();
        let partial = dst.join("half.bin");
        std::fs::write(&partial, b"partial").unwrap();
        write_test_ledger(&root, vec![entry_for("d1", &dst, &dst, "dir")]);

        let report = recover(&root);
        assert_eq!(report.partial_dirs, vec![dst.to_string_lossy().into_owned()]);
        assert!(partial.exists(), "目录复制中断保留已复制内容，不自动清理");
        let (ledger, _) = read_ledger(&root);
        assert!(ledger.entries.is_empty(), "报告过就不再重复提示");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn corrupt_ledger_never_deletes_anything() {
        let root = temp_root("recover-corrupt");
        std::fs::write(ledger_path(&root), b"{not json").unwrap();
        let report = recover(&root);
        assert_eq!(report.removed, 0);
        assert_eq!(report.unreadable, 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stage_guard_cleans_only_its_own_directory() {
        let root = temp_root("guard");
        let _ = init_and_recover(&root);
        let dst = root.join("out.bin");
        let guard = begin_file_stage(Path::new(r"C:\src\in.bin"), &dst).unwrap();
        let stage = guard.stage_dir().to_path_buf();
        assert!(stage.exists());
        std::fs::write(guard.data_path(), b"tmp").unwrap();
        // 别人的文件放在暂存目录里（防御：未知内容不得被删）
        let foreign = stage.join("foreign.txt");
        std::fs::write(&foreign, b"keep me").unwrap();
        guard.finish();
        assert!(stage.exists(), "目录非空时必须保留（不递归删未知内容）");
        assert!(foreign.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
