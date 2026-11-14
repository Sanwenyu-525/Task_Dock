//! 外部真实文件回收站安全网关。
//!
//! 只负责校验、预览与结果报告；真正的删除复用
//! `crate::file_workspace::delete_paths(..., permanent = false, ...)`，绝不复制或改写
//! 删除实现，也**绝不回退永久删除**。
//!
//! 安全边界（任一不满足即 blocked/skipped，不做「尽力删除」）：
//! - 只接受真实本地绝对路径：拒绝空/相对/UNC/设备路径、`..`、超长路径与盘符根；
//! - 拒绝符号链接/重解析点、不存在或无法读取元数据的路径；
//! - 拒绝系统受保护目录（SystemRoot/Program Files/ProgramData/用户目录等）与调用方
//!   传入的数据目录，包括其本身、祖先与后代；
//! - 同一批中的父子路径只保留最浅层，子项标记 blocked；
//! - 执行前重新校验并比对确认时的指纹（类型/大小/修改时间），变化即 skipped。

use std::collections::{HashMap, HashSet};
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::file_workspace::delete_paths;

/// `execute` 单批上限（远小于 file_workspace::MAX_OP_PATHS，面向人工确认删除）。
pub const MAX_EXECUTE_PATHS: usize = 100;
/// Windows 传统路径长度上限：超长路径一律拒绝（不启用 \\?\ 绕过）。
const MAX_PATH_CHARS: usize = 260;
/// FILE_ATTRIBUTE_REPARSE_POINT（std MetadataExt::file_attributes）。
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[derive(Debug, Clone, Serialize)]
pub struct RecycleEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub byte_size: i64,
    pub modified_ms: i64,
    /// "ready" | "blocked"
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecyclePreview {
    pub entries: Vec<RecycleEntry>,
    pub ready: usize,
    pub blocked: usize,
    pub has_dirs: bool,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecycleExpectation {
    pub path: String,
    pub is_dir: bool,
    pub byte_size: i64,
    pub modified_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecycleReportEntry {
    pub path: String,
    pub name: String,
    /// "ok" | "skipped" | "failed"
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecycleReport {
    pub deleted: usize,
    pub skipped: usize,
    pub failed: usize,
    pub entries: Vec<RecycleReportEntry>,
}

struct Candidate {
    raw: String,
    name: String,
    /// 词法规范化路径：用于确认指纹匹配。
    key: String,
    /// canonical（可行时）路径：用于父子关系判定。
    tree_key: String,
    meta: Option<ValidMeta>,
    reason: Option<String>,
}

struct ValidMeta {
    is_dir: bool,
    byte_size: i64,
    modified_ms: i64,
}

// ── 预览 ────────────────────────────────────────────────────

/// 校验并预览一批路径；只读元数据，不执行任何删除。
pub fn preview(raw_paths: &[String], protected: &[PathBuf]) -> RecyclePreview {
    let analyzed = analyze(raw_paths, protected);
    let entries: Vec<RecycleEntry> = analyzed
        .iter()
        .map(|candidate| {
            let meta = candidate.meta.as_ref();
            RecycleEntry {
                path: candidate.raw.clone(),
                name: candidate.name.clone(),
                is_dir: meta.map(|m| m.is_dir).unwrap_or(false),
                byte_size: meta.map(|m| m.byte_size).unwrap_or(0),
                modified_ms: meta.map(|m| m.modified_ms).unwrap_or(0),
                status: if candidate.reason.is_none() {
                    "ready".to_string()
                } else {
                    "blocked".to_string()
                },
                reason: candidate.reason.clone(),
            }
        })
        .collect();
    let ready = entries
        .iter()
        .filter(|entry| entry.status == "ready")
        .count();
    let blocked = entries.len() - ready;
    let has_dirs = entries
        .iter()
        .any(|entry| entry.status == "ready" && entry.is_dir);
    let total_bytes = entries
        .iter()
        .filter(|entry| entry.status == "ready")
        .map(|entry| entry.byte_size)
        .sum();
    RecyclePreview {
        entries,
        ready,
        blocked,
        has_dirs,
        total_bytes,
    }
}

// ── 执行 ────────────────────────────────────────────────────

/// 重新校验并逐项调用 `delete_paths`（permanent=false）。
/// 指纹与确认时不一致、缺少确认信息或校验不通过时 skipped；删除失败如实计入 failed。
pub fn execute(
    raw_paths: &[String],
    expected: &[RecycleExpectation],
    protected: &[PathBuf],
) -> AppResult<RecycleReport> {
    if raw_paths.len() > MAX_EXECUTE_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多删除 {MAX_EXECUTE_PATHS} 项"
        )));
    }
    let expected_map: HashMap<String, &RecycleExpectation> = expected
        .iter()
        .filter(|entry| !entry.path.trim().is_empty())
        .map(|entry| (normalize_key(Path::new(entry.path.trim())), entry))
        .collect();

    let analyzed = analyze(raw_paths, protected);
    let mut report = RecycleReport {
        deleted: 0,
        skipped: 0,
        failed: 0,
        entries: Vec::new(),
    };
    for candidate in analyzed {
        if let Some(reason) = candidate.reason.clone() {
            report.skipped += 1;
            report.entries.push(report_entry(&candidate, "skipped", Some(reason)));
            continue;
        }
        let Some(meta) = candidate.meta.as_ref() else {
            report.skipped += 1;
            report.entries.push(report_entry(
                &candidate,
                "skipped",
                Some("无法读取文件元数据".into()),
            ));
            continue;
        };
        let Some(expectation) = expected_map.get(candidate.key.as_str()).copied() else {
            report.skipped += 1;
            report.entries.push(report_entry(
                &candidate,
                "skipped",
                Some("缺少确认信息".into()),
            ));
            continue;
        };
        if expectation.is_dir != meta.is_dir
            || expectation.byte_size != meta.byte_size
            || expectation.modified_ms != meta.modified_ms
        {
            report.skipped += 1;
            report.entries.push(report_entry(
                &candidate,
                "skipped",
                Some("确认后文件已变化".into()),
            ));
            continue;
        }

        match delete_paths(std::slice::from_ref(&candidate.raw), false, protected) {
            Ok(fs_report) => match fs_report.entries.into_iter().next() {
                Some(entry) if entry.status == "ok" => {
                    report.deleted += 1;
                    report.entries.push(report_entry(&candidate, "ok", None));
                }
                Some(entry) => {
                    report.failed += 1;
                    report.entries.push(report_entry(
                        &candidate,
                        "failed",
                        Some(entry.reason.unwrap_or_else(|| "删除失败".into())),
                    ));
                }
                None => {
                    report.failed += 1;
                    report.entries.push(report_entry(
                        &candidate,
                        "failed",
                        Some("删除未执行".into()),
                    ));
                }
            },
            Err(error) => {
                report.failed += 1;
                report.entries
                    .push(report_entry(&candidate, "failed", Some(error.to_string())));
            }
        }
    }
    Ok(report)
}

fn report_entry(candidate: &Candidate, status: &str, reason: Option<String>) -> RecycleReportEntry {
    RecycleReportEntry {
        path: candidate.raw.clone(),
        name: candidate.name.clone(),
        status: status.to_string(),
        reason,
    }
}

// ── 校验与路径分析 ──────────────────────────────────────────

fn analyze(raw_paths: &[String], protected: &[PathBuf]) -> Vec<Candidate> {
    let roots = protected_roots(protected);
    let mut candidates: Vec<Candidate> = raw_paths
        .iter()
        .map(|raw| match validate_one(raw, &roots) {
            Ok((meta, key, tree_key, name)) => Candidate {
                raw: raw.trim().to_string(),
                name,
                key,
                tree_key,
                meta: Some(meta),
                reason: None,
            },
            Err(reason) => Candidate {
                raw: raw.trim().to_string(),
                name: raw.trim().to_string(),
                key: normalize_key(Path::new(raw.trim())),
                tree_key: String::new(),
                meta: None,
                reason: Some(reason),
            },
        })
        .collect();

    // 父子/重复：只在可执行候选之间按深度从浅到深保留最浅层。
    let mut order: Vec<usize> = (0..candidates.len())
        .filter(|index| candidates[*index].meta.is_some())
        .collect();
    order.sort_by_key(|index| {
        (
            candidates[*index].tree_key.matches('\\').count(),
            *index,
        )
    });
    let mut kept: Vec<String> = Vec::new();
    for index in order {
        let tree_key = candidates[index].tree_key.clone();
        if kept.iter().any(|key| key == &tree_key) {
            candidates[index].reason = Some("重复路径".into());
        } else if kept
            .iter()
            .any(|key| is_descendant_key(&tree_key, key))
        {
            candidates[index].reason = Some("父目录已在删除列表".into());
        } else {
            kept.push(tree_key);
        }
    }
    candidates
}

/// 返回 (元数据, 指纹键, 父子判定键, 展示名)。
fn validate_one(
    raw: &str,
    protected: &[PathBuf],
) -> Result<(ValidMeta, String, String, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("路径为空".into());
    }
    if trimmed.chars().count() > MAX_PATH_CHARS {
        return Err(format!("路径超过 {MAX_PATH_CHARS} 字符"));
    }
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err("不支持 UNC 或设备路径".into());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("只接受绝对路径".into());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("路径包含 .. 穿越".into());
    }
    if path.parent().is_none() || path.components().count() <= 1 {
        return Err("不允许删除盘符根目录".into());
    }

    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("路径不存在".into())
        }
        Err(_) => return Err("无法读取文件元数据".into()),
    };
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("符号链接或重解析点不允许删除".into());
    }
    if protected_conflict(&path, protected) {
        return Err("受保护目录不允许删除".into());
    }

    let is_dir = meta.is_dir();
    let byte_size = if is_dir { 0 } else { meta.len() as i64 };
    let modified_ms = meta
        .modified()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).timestamp_millis())
        .unwrap_or(0);
    let key = normalize_key(&path);
    let tree_key = std::fs::canonicalize(&path)
        .map(|canonical| normalize_key(&canonical))
        .unwrap_or_else(|_| key.clone());
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| trimmed.to_string());
    Ok((
        ValidMeta {
            is_dir,
            byte_size,
            modified_ms,
        },
        key,
        tree_key,
        name,
    ))
}

fn protected_roots(extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for variable in [
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "USERPROFILE",
        "PUBLIC",
    ] {
        if let Some(value) = std::env::var_os(variable) {
            if !value.is_empty() {
                roots.push(PathBuf::from(value));
            }
        }
    }
    for path in extra {
        if !path.as_os_str().is_empty() {
            roots.push(path.clone());
        }
    }
    let mut seen = HashSet::new();
    roots.retain(|root| seen.insert(normalize_key(root)));
    roots
}

fn protected_conflict(path: &Path, protected: &[PathBuf]) -> bool {
    let target = canonical_or_lexical(path);
    protected.iter().any(|root| {
        let root_key = canonical_or_lexical(root);
        is_same_or_under(&target, &root_key) || is_same_or_under(&root_key, &target)
    })
}

fn canonical_or_lexical(path: &Path) -> String {
    std::fs::canonicalize(path)
        .map(|canonical| normalize_key(&canonical))
        .unwrap_or_else(|_| normalize_key(path))
}

/// 大小写/分隔符归一化；去掉 canonical 的 `\\?\` 前缀与尾部反斜杠。
fn normalize_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    let mut key = raw.replace('/', "\\").to_ascii_lowercase();
    while key.len() > 3 && key.ends_with('\\') {
        key.pop();
    }
    key
}

/// child 是否等于 parent 或位于 parent 之下。
fn is_same_or_under(child: &str, parent: &str) -> bool {
    if child == parent {
        return true;
    }
    if parent.ends_with('\\') {
        child.starts_with(parent)
    } else {
        child.starts_with(&format!("{parent}\\"))
    }
}

fn is_descendant_key(child: &str, parent: &str) -> bool {
    child != parent && is_same_or_under(child, parent)
}

// ── 测试 ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试目录放在仓库 target 下：不能落在 USERPROFILE 等受保护根内，
    /// 否则回收站网关会（正确地）拒绝删除。
    fn test_dir(tag: &str) -> Option<PathBuf> {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("td-recycle-tests");
        std::fs::create_dir_all(&base).ok()?;
        if protected_conflict(&base, &protected_roots(&[])) {
            eprintln!("跳过回收站删除测试：{base:?} 位于受保护目录内");
            return None;
        }
        let dir = base.join(format!("{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn preview_marks_safe_files_ready_and_dangerous_inputs_blocked() {
        let Some(dir) = test_dir("preview") else {
            return;
        };
        let file = dir.join("ready.txt");
        std::fs::write(&file, b"abc").expect("write file");
        let missing = dir.join("missing.txt");
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let raw = vec![
            file.to_string_lossy().into_owned(),
            r"C:\".to_string(),
            system_root.to_string_lossy().into_owned(),
            r"\\server\share\file.txt".to_string(),
            "relative\\file.txt".to_string(),
            missing.to_string_lossy().into_owned(),
        ];

        let preview = preview(&raw, &[]);
        assert_eq!(preview.entries.len(), raw.len());
        assert_eq!(preview.ready, 1);
        assert_eq!(preview.blocked, 5);
        assert_eq!(preview.entries[0].status, "ready");
        assert_eq!(preview.entries[0].byte_size, 3);
        assert_eq!(preview.total_bytes, 3);
        assert!(!preview.has_dirs);
        assert!(preview.entries[1]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("盘符根"));
        assert!(preview.entries[2]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("受保护"));
        assert!(preview.entries[3]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("UNC"));
        assert!(preview.entries[4]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("绝对路径"));
        assert!(preview.entries[5]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("不存在"));

        cleanup(&dir);
    }

    #[test]
    fn preview_blocks_children_of_listed_parent_and_duplicates() {
        let Some(dir) = test_dir("parent") else {
            return;
        };
        let parent = dir.join("folder");
        std::fs::create_dir_all(&parent).expect("create dir");
        let child = parent.join("child.txt");
        std::fs::write(&child, b"child").expect("write child");

        // 子项在前、父目录在后：仍按最浅层保留父目录，子项 blocked。
        let parent_raw = parent.to_string_lossy().into_owned();
        let child_raw = child.to_string_lossy().into_owned();
        let first_preview = preview(&[child_raw.clone(), parent_raw], &[]);
        assert_eq!(first_preview.entries[1].status, "ready");
        assert!(first_preview.entries[1].is_dir);
        assert!(first_preview.has_dirs);
        assert_eq!(first_preview.entries[0].status, "blocked");
        assert!(first_preview.entries[0]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("父目录"));

        // 完全重复的路径只保留第一条。
        let duplicate_preview = preview(&[child_raw.clone(), child_raw], &[]);
        assert_eq!(duplicate_preview.entries[0].status, "ready");
        assert_eq!(duplicate_preview.entries[1].status, "blocked");
        assert!(duplicate_preview.entries[1]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("重复"));

        cleanup(&dir);
    }

    #[test]
    fn execute_skips_when_fingerprint_changed() {
        let Some(dir) = test_dir("fingerprint") else {
            return;
        };
        let file = dir.join("changing.txt");
        std::fs::write(&file, b"abc").expect("write file");
        let preview = preview(&[file.to_string_lossy().into_owned()], &[]);
        let entry = &preview.entries[0];
        assert_eq!(entry.status, "ready");

        std::fs::write(&file, b"abcdef").expect("grow file");
        let expectation = RecycleExpectation {
            path: entry.path.clone(),
            is_dir: entry.is_dir,
            byte_size: entry.byte_size,
            modified_ms: entry.modified_ms,
        };
        let report = execute(&[entry.path.clone()], &[expectation], &[]).expect("execute");
        assert_eq!(report.deleted, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(report.entries[0].status, "skipped");
        assert!(report.entries[0]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("已变化"));
        assert!(file.exists(), "跳过时不得删除文件");

        cleanup(&dir);
    }

    #[test]
    fn execute_requires_expectation_and_never_falls_back_to_permanent_delete() {
        let Some(dir) = test_dir("failure") else {
            return;
        };
        let file = dir.join("keep.txt");
        std::fs::write(&file, b"keep").expect("write file");
        let preview = preview(&[file.to_string_lossy().into_owned()], &[]);
        let entry = &preview.entries[0];

        // 缺少确认信息：skipped，文件仍在。
        let missing = execute(&[entry.path.clone()], &[], &[]).expect("execute missing");
        assert_eq!(missing.skipped, 1);
        assert_eq!(missing.deleted, 0);
        assert!(file.exists());

        // 指纹不符：skipped，文件仍在。
        let wrong = RecycleExpectation {
            path: entry.path.clone(),
            is_dir: entry.is_dir,
            byte_size: entry.byte_size + 1,
            modified_ms: entry.modified_ms,
        };
        let report = execute(&[entry.path.clone()], &[wrong], &[]).expect("execute wrong");
        assert_eq!(report.skipped, 1);
        assert_eq!(report.deleted, 0);
        assert_eq!(report.failed, 0);
        assert!(file.exists(), "绝不回退永久删除");

        cleanup(&dir);
    }

    #[test]
    fn execute_recycles_file_to_recycle_bin() {
        let Some(dir) = test_dir("delete") else {
            return;
        };
        let file = dir.join("to-recycle.txt");
        std::fs::write(&file, b"recycle me").expect("write file");
        let preview = preview(&[file.to_string_lossy().into_owned()], &[]);
        let entry = &preview.entries[0];
        assert_eq!(entry.status, "ready");
        let expectation = RecycleExpectation {
            path: entry.path.clone(),
            is_dir: entry.is_dir,
            byte_size: entry.byte_size,
            modified_ms: entry.modified_ms,
        };

        let report = execute(&[entry.path.clone()], &[expectation], &[]).expect("execute");
        assert_eq!(
            report.deleted, 1,
            "回收站删除未成功: {:?}",
            report.entries
        );
        assert_eq!(report.entries[0].status, "ok");
        assert!(!file.exists(), "文件应已移入回收站");

        cleanup(&dir);
    }

    #[test]
    fn execute_rejects_oversized_batch() {
        let raw: Vec<String> = (0..=MAX_EXECUTE_PATHS)
            .map(|index| format!("D:\\no-such-file-{index}.txt"))
            .collect();
        assert!(execute(&raw, &[], &[]).is_err());
    }
}
