//! 应用数据目录的**只读**占用分布。
//!
//! 目标：让用户看清「磁盘被什么占了」，而不是新增删除范围。因此：
//! - 只扫描应用自己的数据目录（`TASK_DOCK_DATA_DIR` / 默认 app data），
//!   不递归整个磁盘、不进入用户目录、不跟随符号链接或 reparse point；
//! - 每个条目带 `kind`：`regenerable`（可重新生成的缓存）或 `persistent`
//!   （业务数据/备份/数据库，绝不因本功能删除）；
//! - 有硬上限（条目数、深度、时间预算），超限返回 `truncated` / `partial`，
//!   不把不完整统计当成完整结果。

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;

/// 单次扫描最多检查的文件系统条目数。
const MAX_ENTRIES: usize = 20_000;
/// 单次扫描时间预算；超时后停止并标记不完整。
const TIME_BUDGET: Duration = Duration::from_secs(3);
/// 相对数据根的最大递归深度（正常布局不超过 3 层）。
const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    /// 稳定类别 ID（前端按 ID 取文案，不依赖目录名）。
    pub id: String,
    pub bytes: u64,
    pub files: u64,
    /// `regenerable` | `persistent`
    pub kind: String,
    /// `ready` | `missing` | `partial`
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageBreakdown {
    pub sampled_at: String,
    pub entries: Vec<StorageEntry>,
    pub total_bytes: u64,
    /// 任一类别达到条目/时间上限时为真。
    pub truncated: bool,
}

/// 目录规格：ID + 相对数据根的路径 + 归属。
struct Spec {
    id: &'static str,
    relative: &'static [&'static str],
    kind: &'static str,
    /// 独立根（TTS 缓存在非便携模式位于 app_cache_dir，不在数据根下）。
    use_tts_root: bool,
}

/// 只列出已知的应用自有目录；新增条目必须能说明归属与是否可重新生成。
const SPECS: &[Spec] = &[
    Spec { id: "tts_cache", relative: &[], kind: "regenerable", use_tts_root: true },
    Spec { id: "clipboard_images", relative: &["clipboard", "images"], kind: "persistent", use_tts_root: false },
    Spec { id: "clipboard_thumbs", relative: &["clipboard", "thumbs"], kind: "persistent", use_tts_root: false },
    Spec { id: "shelf_files", relative: &["shelf", "files"], kind: "persistent", use_tts_root: false },
    Spec { id: "shelf_images", relative: &["shelf", "images"], kind: "persistent", use_tts_root: false },
    Spec { id: "shelf_thumbs", relative: &["shelf", "thumbs"], kind: "persistent", use_tts_root: false },
    Spec { id: "agent_inbox", relative: &["agent-inbox"], kind: "persistent", use_tts_root: false },
    Spec { id: "backups", relative: &["backups"], kind: "persistent", use_tts_root: false },
    Spec { id: "diagnostics", relative: &["diagnostics"], kind: "persistent", use_tts_root: false },
];

/// 独立根：数据根之外、但仍属应用自有的目录。
pub struct Roots<'a> {
    /// 数据根（数据库、备份、剪贴板、暂存架都在这里面）。
    pub data: &'a Path,
    /// TTS 语音缓存目录（`audio-cache/tts` 或 `app_cache_dir/audio/tts`）。
    pub tts_cache: Option<&'a Path>,
}

/// 数据库文件（含 WAL/SHM）单独统计：强制保留，且不计入缓存。
const DATABASE_FILES: &[&str] = &["task-dock.db", "task-dock.db-wal", "task-dock.db-shm"];

struct Totals {
    bytes: u64,
    files: u64,
    truncated: bool,
}

/// 扫描数据根下的已知类别。根不存在或类别缺失时返回 `missing`，不以 0 冒充可用。
pub fn scan(roots: Roots<'_>) -> StorageBreakdown {
    let started = Instant::now();
    let mut entries = Vec::with_capacity(SPECS.len() + 1);
    let mut truncated = false;

    for spec in SPECS {
        let path = if spec.use_tts_root {
            match roots.tts_cache {
                Some(path) => path.to_path_buf(),
                None => data_path(roots.data, spec.relative),
            }
        } else {
            data_path(roots.data, spec.relative)
        };
        let mut budget_entries = MAX_ENTRIES;
        let result = scan_entry(&path, started, &mut budget_entries);
        let (bytes, files, status) = match result {
            Some(totals) => {
                truncated |= totals.truncated;
                (
                    totals.bytes,
                    totals.files,
                    if totals.truncated { "partial" } else { "ready" },
                )
            }
            None => (0, 0, "missing"),
        };
        entries.push(StorageEntry {
            id: spec.id.into(),
            bytes,
            files,
            kind: spec.kind.into(),
            status: status.into(),
        });
    }

    // 数据库：只统计固定文件名，不扫描目录。
    let mut db_bytes = 0u64;
    let mut db_files = 0u64;
    for name in DATABASE_FILES {
        if let Ok(metadata) = std::fs::metadata(roots.data.join(name)) {
            if metadata.is_file() {
                db_bytes = db_bytes.saturating_add(metadata.len());
                db_files += 1;
            }
        }
    }
    entries.push(StorageEntry {
        id: "database".into(),
        bytes: db_bytes,
        files: db_files,
        kind: "persistent".into(),
        status: if db_files > 0 { "ready" } else { "missing" }.into(),
    });

    let total_bytes = entries.iter().map(|entry| entry.bytes).sum();
    StorageBreakdown {
        sampled_at: chrono::Utc::now().to_rfc3339(),
        entries,
        total_bytes,
        truncated,
    }
}

fn data_path(root: &Path, relative: &[&str]) -> std::path::PathBuf {
    relative
        .iter()
        .fold(root.to_path_buf(), |acc, part| acc.join(part))
}

/// 扫描单个目录；不存在返回 None。符号链接/reparse point 直接跳过（不跟随）。
fn scan_entry(path: &Path, started: Instant, budget: &mut usize) -> Option<Totals> {    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Some(Totals { bytes: 0, files: 0, truncated: false });
    }
    let mut totals = Totals { bytes: 0, files: 0, truncated: false };
    walk(path, 0, started, budget, &mut totals);
    Some(totals)
}

fn walk(dir: &Path, depth: usize, started: Instant, budget: &mut usize, totals: &mut Totals) {
    if totals.truncated || depth > MAX_DEPTH {
        totals.truncated = true;
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        totals.truncated = true;
        return;
    };
    for item in read_dir {
        if *budget == 0 || started.elapsed() > TIME_BUDGET {
            totals.truncated = true;
            return;
        }
        *budget -= 1;
        let Ok(item) = item else {
            continue;
        };
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        // 不跟随链接：避免把目录外的数据算进应用占用。
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            walk(&item.path(), depth + 1, started, budget, totals);
        } else if file_type.is_file() {
            if let Ok(metadata) = item.metadata() {
                totals.bytes = totals.bytes.saturating_add(metadata.len());
                totals.files += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "td-storage-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn reports_known_directories_and_keeps_persistent_kind() {
        let root = temp_root("layout");
        fs::create_dir_all(root.join("audio-cache/tts")).unwrap();
        let tts = root.join("audio-cache/tts");
        fs::create_dir_all(root.join("clipboard/thumbs")).unwrap();
        fs::create_dir_all(root.join("shelf/files")).unwrap();
        fs::write(root.join("audio-cache/tts/a.wav"), vec![0u8; 100]).unwrap();
        fs::write(root.join("clipboard/thumbs/t.png"), vec![0u8; 40]).unwrap();
        fs::write(root.join("shelf/files/note.txt"), b"hello").unwrap();
        fs::write(root.join("task-dock.db"), vec![0u8; 8]).unwrap();

        let breakdown = scan(Roots { data: &root, tts_cache: Some(&tts) });
        let by_id = |id: &str| breakdown.entries.iter().find(|e| e.id == id).unwrap();
        assert_eq!(by_id("tts_cache").bytes, 100);
        assert_eq!(by_id("tts_cache").kind, "regenerable");
        assert_eq!(by_id("clipboard_thumbs").bytes, 40);
        assert_eq!(by_id("clipboard_thumbs").kind, "persistent");
        assert_eq!(by_id("shelf_files").bytes, 5);
        assert_eq!(by_id("database").bytes, 8);
        assert_eq!(by_id("backups").status, "missing");
        assert!(!breakdown.truncated);
        assert_eq!(
            breakdown.total_bytes,
            breakdown.entries.iter().map(|e| e.bytes).sum::<u64>()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_symlinked_directories_instead_of_following_them() {
        let root = temp_root("link");
        let outside = temp_root("outside");
        fs::write(outside.join("big.bin"), vec![0u8; 4096]).unwrap();
        fs::create_dir_all(root.join("shelf")).unwrap();
        #[cfg(windows)]
        {
            // 无权限创建符号链接时跳过该断言（环境限制，不是代码缺陷）。
            if std::os::windows::fs::symlink_dir(&outside, root.join("shelf/files")).is_err() {
                fs::remove_dir_all(root).unwrap();
                fs::remove_dir_all(outside).unwrap();
                return;
            }
        }
        let breakdown = scan(Roots { data: &root, tts_cache: None });
        let shelf_files = breakdown.entries.iter().find(|e| e.id == "shelf_files").unwrap();
        assert_eq!(shelf_files.bytes, 0, "不得统计链接指向的外部数据");
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }
}
