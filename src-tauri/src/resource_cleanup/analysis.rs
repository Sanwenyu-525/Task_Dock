//! 只读磁盘空间分析：给定一个目录，统计直接子目录占用与最大的文件。
//!
//! 边界：
//! - **只读**：只读取目录项元数据（名称、大小、类型），不打开文件内容、不写入、不删除；
//! - 不跟随符号链接 / reparse point（junction），避免把目录外的数据算进来或形成环；
//! - 有硬上限（条目数 / 时间预算 / 递归深度），超限标记 `truncated`，结果按「已扫描部分」展示；
//! - 无法读取的目录计入 `skipped_errors`，链接计入 `skipped_links`，不静默当成 0；
//! - 只接受本地盘符路径（`C:\...`）；网络/UNC 路径暂不支持，避免长时间阻塞。

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 单次分析最多检查的文件系统条目数。
const MAX_ENTRIES: usize = 240_000;
/// 单次分析时间预算；超时停止并标记不完整。
const TIME_BUDGET: Duration = Duration::from_secs(8);
/// 最大递归深度（防御异常深的目录链）。
const MAX_DEPTH: usize = 40;
/// 返回的直接子目录数量上限。
const MAX_FOLDERS: usize = 40;
/// 返回的最大文件数量上限。
const MAX_FILES: usize = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskScanFolder {
    pub name: String,
    pub path: String,
    /// 未扫描（达到上限）时为 None：界面显示「未扫描」，不能当成 0 B。
    pub bytes: Option<u64>,
    pub files: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskScanFile {
    pub name: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskScanReport {
    /// 实际扫描的目录（去除末尾分隔符，保留盘符根）。
    pub path: String,
    /// 上一级目录；盘符根为 null。
    pub parent: Option<String>,
    pub sampled_at: String,
    pub total_bytes: u64,
    pub total_files: u64,
    /// 实际进入的子目录数（不含扫描根，不含链接）。
    pub total_dirs: u64,
    /// 扫描根下直接存放的文件（如 pagefile.sys），不计入 `folders`。
    pub root_files_bytes: u64,
    pub root_files: u64,
    /// 跳过且未跟随的符号链接 / reparse point 数量。
    pub skipped_links: u64,
    /// 无法读取的目录/项数量（权限、IO 错误）。
    pub skipped_errors: u64,
    /// 达到条目/时间/深度上限：结果为已扫描部分。
    pub truncated: bool,
    pub elapsed_ms: u64,
    /// 直接子目录，按占用降序。
    pub folders: Vec<DiskScanFolder>,
    /// 最大的文件，按大小降序。
    pub files: Vec<DiskScanFile>,
}

struct Walk {
    started: Instant,
    entries_left: usize,
    budget: Duration,
    max_depth: usize,
    truncated: bool,
    skipped_links: u64,
    skipped_errors: u64,
    total_bytes: u64,
    total_files: u64,
    total_dirs: u64,
    root_files_bytes: u64,
    root_files: u64,
    largest: BinaryHeap<Reverse<(u64, PathBuf)>>,
}

impl Walk {
    fn out_of_budget(&self) -> bool {
        self.entries_left == 0 || self.started.elapsed() >= self.budget
    }

    fn remember_file(&mut self, size: u64, path: &Path) {
        if self.largest.len() < MAX_FILES {
            self.largest.push(Reverse((size, path.to_path_buf())));
        } else if let Some(Reverse((smallest, _))) = self.largest.peek() {
            if size > *smallest {
                self.largest.pop();
                self.largest.push(Reverse((size, path.to_path_buf())));
            }
        }
    }
}

/// 分析一个本地目录。只读；失败时返回可展示的错误。
pub fn scan(path: &Path) -> AppResult<DiskScanReport> {
    scan_with_limits(path, MAX_ENTRIES, TIME_BUDGET, MAX_DEPTH)
}

fn scan_with_limits(
    path: &Path,
    max_entries: usize,
    budget: Duration,
    max_depth: usize,
) -> AppResult<DiskScanReport> {
    let normalized = normalize_path(path)?;
    let root = Path::new(&normalized);
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|_| AppError::NotFound("目录不存在或不可读取".into()))?;
    if !metadata.is_dir() || crate::shelf::is_reparse_point(&metadata) {
        return Err(AppError::Validation("只能分析普通目录".into()));
    }

    let started = Instant::now();
    let mut walk = Walk {
        started,
        entries_left: max_entries,
        budget,
        max_depth,
        truncated: false,
        skipped_links: 0,
        skipped_errors: 0,
        total_bytes: 0,
        total_files: 0,
        total_dirs: 0,
        root_files_bytes: 0,
        root_files: 0,
        largest: BinaryHeap::new(),
    };

    // 先列出根的直接子目录，保证空目录也能显示；再逐个递归统计。
    let mut children: Vec<(String, PathBuf)> = Vec::new();
    match std::fs::read_dir(root) {
        Ok(read_dir) => {
            for item in read_dir {
                if walk.out_of_budget() {
                    walk.truncated = true;
                    break;
                }
                walk.entries_left -= 1;
                let Ok(item) = item else {
                    walk.skipped_errors = walk.skipped_errors.saturating_add(1);
                    continue;
                };
                let child = item.path();
                let Ok(child_meta) = std::fs::symlink_metadata(&child) else {
                    walk.skipped_errors = walk.skipped_errors.saturating_add(1);
                    continue;
                };
                if child_meta.file_type().is_symlink()
                    || crate::shelf::is_reparse_point(&child_meta)
                {
                    walk.skipped_links = walk.skipped_links.saturating_add(1);
                    continue;
                }
                if child_meta.is_dir() {
                    walk.total_dirs = walk.total_dirs.saturating_add(1);
                    children.push((item.file_name().to_string_lossy().to_string(), child));
                } else if child_meta.is_file() {
                    let size = child_meta.len();
                    walk.total_bytes = walk.total_bytes.saturating_add(size);
                    walk.total_files = walk.total_files.saturating_add(1);
                    walk.root_files_bytes = walk.root_files_bytes.saturating_add(size);
                    walk.root_files = walk.root_files.saturating_add(1);
                    walk.remember_file(size, &child);
                }
            }
        }
        Err(_) => {
            return Err(AppError::Unavailable("目录不可读取".into()));
        }
    }

    let mut folders = Vec::with_capacity(children.len());
    for (name, child) in children {
        // 预算已耗尽：剩余子目录保留条目但标记「未扫描」，不伪造 0 B。
        if walk.truncated || walk.out_of_budget() {
            walk.truncated = true;
            folders.push(DiskScanFolder {
                name,
                path: child.to_string_lossy().to_string(),
                bytes: None,
                files: None,
            });
            continue;
        }
        // 递归统计该子目录；条目/时间上限由同一个 Walk 统一控制。
        let mut sub = SubWalk {
            walk: &mut walk,
            bytes: 0,
            files: 0,
        };
        sub.visit(&child, 1);
        folders.push(DiskScanFolder {
            name,
            path: child.to_string_lossy().to_string(),
            bytes: Some(sub.bytes),
            files: Some(sub.files),
        });
    }

    // 已扫描的按占用降序；未扫描的排在最后，避免被误读为 0 B 的「空目录」。
    folders.sort_by(|left, right| match (left.bytes, right.bytes) {
        (Some(a), Some(b)) => b
            .cmp(&a)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase())),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    });
    folders.truncate(MAX_FOLDERS);

    let mut files: Vec<DiskScanFile> = walk
        .largest
        .drain()
        .map(|Reverse((bytes, path))| DiskScanFile {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string()),
            path: path.to_string_lossy().to_string(),
            bytes,
        })
        .collect();
    files.sort_by(|left, right| right.bytes.cmp(&left.bytes));

    Ok(DiskScanReport {
        path: normalized.clone(),
        parent: parent_display(root),
        sampled_at: chrono::Utc::now().to_rfc3339(),
        total_bytes: walk.total_bytes,
        total_files: walk.total_files,
        total_dirs: walk.total_dirs,
        root_files_bytes: walk.root_files_bytes,
        root_files: walk.root_files,
        skipped_links: walk.skipped_links,
        skipped_errors: walk.skipped_errors,
        truncated: walk.truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
        folders,
        files,
    })
}

/// 统计单个子目录时只累积该子树的字节/文件/目录数，避免重复扫描。
struct SubWalk<'a> {
    walk: &'a mut Walk,
    bytes: u64,
    files: u64,
}

impl SubWalk<'_> {
    fn visit(&mut self, dir: &Path, depth: usize) {
        if self.walk.truncated {
            return;
        }
        if self.walk.out_of_budget() || depth > self.walk.max_depth {
            self.walk.truncated = true;
            return;
        }
        let read_dir = match std::fs::read_dir(dir) {
            Ok(read_dir) => read_dir,
            Err(_) => {
                self.walk.skipped_errors = self.walk.skipped_errors.saturating_add(1);
                return;
            }
        };
        for item in read_dir {
            if self.walk.out_of_budget() {
                self.walk.truncated = true;
                return;
            }
            self.walk.entries_left -= 1;
            let Ok(item) = item else {
                self.walk.skipped_errors = self.walk.skipped_errors.saturating_add(1);
                continue;
            };
            let path = item.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                self.walk.skipped_errors = self.walk.skipped_errors.saturating_add(1);
                continue;
            };
            if metadata.file_type().is_symlink() || crate::shelf::is_reparse_point(&metadata) {
                self.walk.skipped_links = self.walk.skipped_links.saturating_add(1);
                continue;
            }
            if metadata.is_dir() {
                self.walk.total_dirs = self.walk.total_dirs.saturating_add(1);
                self.visit(&path, depth + 1);
            } else if metadata.is_file() {
                let size = metadata.len();
                self.bytes = self.bytes.saturating_add(size);
                self.files = self.files.saturating_add(1);
                self.walk.total_bytes = self.walk.total_bytes.saturating_add(size);
                self.walk.total_files = self.walk.total_files.saturating_add(1);
                self.walk.remember_file(size, &path);
            }
        }
    }
}

/// 去除末尾分隔符（盘符根保留 `C:\`），拒绝空路径与非本地盘符。
fn normalize_path(path: &Path) -> AppResult<String> {
    let raw = path.to_string_lossy().trim().to_string();
    if raw.is_empty() {
        return Err(AppError::Validation("目录路径为空".into()));
    }
    #[cfg(windows)]
    {
        let bytes = raw.as_bytes();
        let drive_only = bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
        if !drive_only
            && (bytes.len() < 3
                || !bytes[0].is_ascii_alphabetic()
                || bytes[1] != b':'
                || !matches!(bytes[2], b'\\' | b'/'))
        {
            return Err(AppError::Validation(
                "暂只支持本地磁盘目录（如 C:\\ 或 D:\\文件夹）".into(),
            ));
        }
    }
    let trimmed = raw.trim_end_matches(['\\', '/']);
    // `C:` → `C:\`；`C:\Users\` → `C:\Users`
    if trimmed.len() == 2 && trimmed.as_bytes()[1] == b':' {
        return Ok(format!("{trimmed}\\"));
    }
    if trimmed.is_empty() {
        return Ok(raw);
    }
    Ok(trimmed.to_string())
}

fn parent_display(root: &Path) -> Option<String> {
    root.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "td-analysis-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn aggregates_direct_children_and_root_files() {
        let root = temp_root("aggregate");
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::create_dir_all(root.join("beta/nested")).unwrap();
        fs::write(root.join("alpha/a.bin"), vec![0u8; 100]).unwrap();
        fs::write(root.join("alpha/b.bin"), vec![0u8; 100]).unwrap();
        fs::write(root.join("beta/nested/c.bin"), vec![0u8; 50]).unwrap();
        fs::write(root.join("root.txt"), vec![0u8; 10]).unwrap();

        let report = scan(&root).unwrap();
        assert_eq!(report.total_bytes, 260);
        assert_eq!(report.total_files, 4);
        assert_eq!(report.root_files_bytes, 10);
        assert_eq!(report.root_files, 1);
        assert_eq!(report.folders.len(), 2);
        assert_eq!(report.folders[0].name, "alpha");
        assert_eq!(report.folders[0].bytes, Some(200));
        assert_eq!(report.folders[0].files, Some(2));
        assert_eq!(report.folders[1].name, "beta");
        assert_eq!(report.folders[1].bytes, Some(50));
        assert!(!report.truncated);
        assert_eq!(report.parent.as_deref(), Some(root.parent().unwrap().to_string_lossy().as_ref()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn caps_largest_files_and_keeps_descending_order() {
        let root = temp_root("largest");
        // 35 个文件 → 只返回最大的 30 个（1..=35 中的 6..=35）。
        for index in 1..=35u8 {
            fs::write(root.join(format!("f{index:02}.bin")), vec![0u8; index as usize]).unwrap();
        }
        let report = scan_with_limits(&root, 10_000, Duration::from_secs(5), 8).unwrap();
        assert_eq!(report.files.len(), MAX_FILES);
        assert_eq!(report.files.first().map(|f| f.bytes), Some(35));
        assert_eq!(report.files.last().map(|f| f.bytes), Some(35 - (MAX_FILES as u64 - 1)));
        assert!(report.files.windows(2).all(|pair| pair[0].bytes >= pair[1].bytes));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zero_time_budget_marks_truncated() {
        let root = temp_root("budget");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/x.bin"), vec![0u8; 10]).unwrap();
        let report = scan_with_limits(&root, 10_000, Duration::ZERO, 8).unwrap();
        assert!(report.truncated, "零预算必须标记为不完整");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unscanned_folders_are_null_not_zero_and_sort_last() {
        let root = temp_root("unscanned");
        fs::create_dir_all(root.join("first")).unwrap();
        fs::create_dir_all(root.join("second")).unwrap();
        // 根目录列出 2 个子目录后预算耗尽：两个都应标记为未扫描。
        let report = scan_with_limits(&root, 2, Duration::from_secs(5), 8).unwrap();
        assert!(report.truncated);
        assert_eq!(report.folders.len(), 2);
        assert!(report.folders.iter().all(|folder| folder.bytes.is_none()));
        assert!(report.folders.iter().all(|folder| folder.files.is_none()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_relative_paths_and_files() {
        assert!(scan(Path::new("relative")).is_err());
        let root = temp_root("file-root");
        let file = root.join("x.bin");
        fs::write(&file, b"x").unwrap();
        assert!(scan(&file).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_symlinked_directories_instead_of_following_them() {
        let root = temp_root("link");
        let outside = temp_root("outside");
        fs::write(outside.join("big.bin"), vec![0u8; 4096]).unwrap();
        #[cfg(windows)]
        {
            // 无权限创建符号链接时跳过该断言（环境限制，不是代码缺陷）。
            if std::os::windows::fs::symlink_dir(&outside, root.join("link")).is_err() {
                fs::remove_dir_all(root).ok();
                fs::remove_dir_all(outside).ok();
                return;
            }
        }
        let report = scan(&root).unwrap();
        assert_eq!(report.total_bytes, 0, "不得统计链接指向的外部数据");
        assert!(report.skipped_links >= 1);
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }
}
