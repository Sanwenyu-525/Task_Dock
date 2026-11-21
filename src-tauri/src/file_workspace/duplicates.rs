//! 重复文件删除：身份快照 + 删除前复核 + 只走回收站。
//!
//! 与普通 `fs_delete_job_start` 分开的原因：普通删除不知道「重复组」语义，
//! 前端传来的 `verified` 状态可以被绕过。这里把保留项与待删项一起复核，
//! 任何一项缺失、被修改、哈希失败都**只跳过该项并报告**，绝不默认删除；
//! 保留项本身不可验证时整批拒绝（此时待删项可能是唯一副本）。
//!
//! 身份口径见 [`crate::file_workspace::identity`]：卷序列号 + 文件索引 + 大小 +
//! 修改时间 + 句柄最终路径。只比较类型与大小不足以证明「还是同一个文件」。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::file_workspace::{self as fw, identity};

/// 一个重复组的删除请求。`keep_path` 必须实际存在且与 `delete_paths` 内容一致。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateDeleteGroup {
    pub keep_path: String,
    pub delete_paths: Vec<String>,
    pub expected_size: u64,
    pub expected_hash: String,
}

/// 被跳过的文件（不删除，但必须让用户看到原因）。
#[derive(Debug, Clone)]
pub struct DuplicateSkip {
    pub path: String,
    pub code: &'static str,
    pub reason: String,
}

/// 复核通过、可以提交删除的一组文件。
#[derive(Debug)]
pub struct VerifiedGroup {
    pub keep_path: String,
    /// 保留项在哈希阶段的身份快照：提交前用它复核「保留项没变」，
    /// 否则无法证明待删项不是唯一副本。
    pub keep_identity: identity::FileIdentity,
    pub deletes: Vec<VerifiedTarget>,
}

#[derive(Debug)]
pub struct VerifiedTarget {
    pub path: String,
    pub identity: identity::FileIdentity,
}

/// 复核阶段的产出：可删除项 + 跳过项。两者都返回，调用方不能只看其一看。
#[derive(Debug, Default)]
pub struct DuplicatePlan {
    pub groups: Vec<VerifiedGroup>,
    pub skipped: Vec<DuplicateSkip>,
}

impl DuplicatePlan {
    /// 所有待删路径（跨组展平），顺序稳定。
    pub fn delete_paths(&self) -> Vec<String> {
        self.groups
            .iter()
            .flat_map(|group| group.deletes.iter().map(|item| item.path.clone()))
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_reparse(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// 组形状与路径级校验（不读内容、不算哈希）。
///
/// 这些错误是**请求本身非法**，不是「某个文件不可验证」，因此整批拒绝并返回 Err。
fn validate_shape(
    groups: &[DuplicateDeleteGroup],
    protected: &[PathBuf],
) -> AppResult<Vec<(String, Vec<String>)>> {
    if groups.is_empty() {
        return Err(invalid("没有可删除的重复组"));
    }
    let total_paths: usize = groups.iter().map(|g| 1 + g.delete_paths.len()).sum();
    if total_paths > fw::MAX_OP_PATHS {
        return Err(invalid(format!("单批最多 {} 项", fw::MAX_OP_PATHS)));
    }

    let mut seen = HashSet::new();
    let mut shape = Vec::with_capacity(groups.len());
    for group in groups {
        if group.delete_paths.is_empty() {
            return Err(invalid("每个重复组至少需要一个待删文件，且必须保留一个原文件"));
        }
        // 零字节文件的 SHA-256 固定且可复核（e3b0c442…），不能仅因 size=0 就拒绝。
        if !is_sha256_hex(&group.expected_hash) {
            return Err(invalid("重复组哈希不是有效的 SHA-256"));
        }
        let keep = fw::validate_abs_path(&group.keep_path)?;
        fw::ensure_not_protected(&keep, protected)?;
        let keep_key = path_key(&keep);
        if !seen.insert(keep_key.clone()) {
            return Err(invalid("同一路径在重复组中出现多次"));
        }
        let mut delete_paths = Vec::with_capacity(group.delete_paths.len());
        for raw in &group.delete_paths {
            let path = fw::validate_abs_path(raw)?;
            fw::ensure_not_protected(&path, protected)?;
            let key = path_key(&path);
            if key == keep_key {
                return Err(invalid("保留文件不能出现在待删除列表"));
            }
            if !seen.insert(key) {
                return Err(invalid("待删除路径在多个重复组中重复出现"));
            }
            delete_paths.push(path.to_string_lossy().into_owned());
        }
        shape.push((keep.to_string_lossy().into_owned(), delete_paths));
    }
    Ok(shape)
}

/// 哈希 + 身份快照 + 内容复核。**不执行删除**，便于测试「哈希失败/文件变化必须拒绝」。
pub fn plan(
    groups: &[DuplicateDeleteGroup],
    protected: &[PathBuf],
    progress: &mut dyn FnMut(fw::HashProgress),
    cancel: &dyn Fn() -> bool,
) -> AppResult<DuplicatePlan> {
    let shape = validate_shape(groups, protected)?;

    let mut all_paths = Vec::new();
    for (keep, deletes) in &shape {
        all_paths.push(keep.clone());
        all_paths.extend(deletes.iter().cloned());
    }
    let hashed = fw::hash_files_detailed(&all_paths, protected, progress, cancel);
    if cancel() {
        return Err(AppError::Validation("已取消".into()));
    }
    let mut by_path = std::collections::HashMap::with_capacity(hashed.len());
    for item in hashed {
        by_path.insert(item.entry.path.to_lowercase(), item);
    }

    let mut plan = DuplicatePlan::default();
    for (group, (keep_path, delete_paths)) in groups.iter().zip(shape.iter()) {
        let keep = by_path.get(&keep_path.to_lowercase());
        let keep_problem = match keep {
            None => Some(("KEEP_UNVERIFIABLE", "没有取得保留文件的哈希结果".to_string())),
            Some(item) if item.entry.error.is_some() => Some((
                "KEEP_UNVERIFIABLE",
                format!(
                    "保留文件无法复核：{}",
                    item.entry.error.clone().unwrap_or_default()
                ),
            )),
            Some(item) if item.entry.size != Some(group.expected_size) => {
                Some(("KEEP_CHANGED", "保留文件大小已变化".to_string()))
            }
            Some(item) if item.entry.hash.as_deref() != Some(group.expected_hash.as_str()) => {
                Some(("KEEP_CHANGED", "保留文件内容已变化".to_string()))
            }
            Some(_) => None,
        };
        if let Some((code, reason)) = keep_problem {
            // 保留项不可证明：待删项可能是唯一副本，整组拒绝（逐项报告，不让用户以为删了）。
            for path in delete_paths {
                plan.skipped.push(DuplicateSkip {
                    path: path.clone(),
                    code,
                    reason: reason.clone(),
                });
            }
            continue;
        }
        let keep_identity = keep.and_then(|item| item.identity);
        let Some(keep_identity) = keep_identity else {
            for path in delete_paths {
                plan.skipped.push(DuplicateSkip {
                    path: path.clone(),
                    code: "KEEP_UNVERIFIABLE",
                    reason: "无法取得保留文件身份".into(),
                });
            }
            continue;
        };

        let mut deletes = Vec::new();
        for path in delete_paths {
            let entry = by_path.get(&path.to_lowercase());
            match entry {
                None => plan.skipped.push(DuplicateSkip {
                    path: path.clone(),
                    code: "UNVERIFIABLE",
                    reason: "没有取得哈希结果".into(),
                }),
                Some(item) if item.entry.error.is_some() => plan.skipped.push(DuplicateSkip {
                    path: path.clone(),
                    code: "UNVERIFIABLE",
                    reason: item.entry.error.clone().unwrap_or_default(),
                }),
                Some(item) if item.entry.size != Some(group.expected_size) => {
                    plan.skipped.push(DuplicateSkip {
                        path: path.clone(),
                        code: "CONTENT_CHANGED",
                        reason: "文件大小已变化".into(),
                    })
                }
                Some(item) if item.entry.hash.as_deref() != Some(group.expected_hash.as_str()) => {
                    plan.skipped.push(DuplicateSkip {
                        path: path.clone(),
                        code: "CONTENT_CHANGED",
                        reason: "文件内容已变化".into(),
                    })
                }
                Some(item) => match item.identity {
                    Some(identity) => deletes.push(VerifiedTarget {
                        path: path.clone(),
                        identity,
                    }),
                    None => plan.skipped.push(DuplicateSkip {
                        path: path.clone(),
                        code: "UNVERIFIABLE",
                        reason: "无法取得文件身份".into(),
                    }),
                },
            }
        }
        if !deletes.is_empty() {
            plan.groups.push(VerifiedGroup {
                keep_path: keep_path.clone(),
                keep_identity,
                deletes,
            });
        }
    }
    Ok(plan)
}

/// 提交删除：先逐文件复核身份，再把通过复核的路径一次性交给回收站。
///
/// 返回的报告里逐项覆盖**全部**待删项：通过复核并被回收站处理的为 ok/failed，
/// 复核阶段被拒的为 skipped（带 `IDENTITY_CHANGED` / `UNVERIFIABLE` 等分类）。
pub fn delete_plan(
    plan: DuplicatePlan,
    protected: &[PathBuf],
    operation_id: Option<String>,
) -> fw::FsOpReport {
    let op_id = operation_id.unwrap_or_else(crate::diagnostics::new_operation_id);
    let mut skips = plan.skipped;
    let mut verified: Vec<String> = Vec::new();
    for group in &plan.groups {
        // 保留项在提交前再复核一次：它变了就不再有「重复」关系，整组不删。
        let keep = Path::new(&group.keep_path);
        match identity::verify_path(keep, &group.keep_identity) {
            identity::IdentityCheck::Match => {}
            other => {
                for target in &group.deletes {
                    skips.push(DuplicateSkip {
                        path: target.path.clone(),
                        code: "KEEP_CHANGED",
                        reason: format!("保留文件在提交前发生变化：{}", other.reason()),
                    });
                }
                continue;
            }
        }
        for target in &group.deletes {
            match identity::verify_path(Path::new(&target.path), &target.identity) {
                identity::IdentityCheck::Match => verified.push(target.path.clone()),
                identity::IdentityCheck::Missing => skips.push(DuplicateSkip {
                    path: target.path.clone(),
                    code: "FILE_GONE",
                    reason: "文件已不存在".into(),
                }),
                identity::IdentityCheck::Changed(reason) => skips.push(DuplicateSkip {
                    path: target.path.clone(),
                    code: "IDENTITY_CHANGED",
                    reason: reason.into(),
                }),
                identity::IdentityCheck::Unverifiable(reason) => skips.push(DuplicateSkip {
                    path: target.path.clone(),
                    code: "UNVERIFIABLE",
                    reason: reason.into(),
                }),
            }
        }
    }

    if verified.is_empty() {
        let mut report = fw::FsOpReport {
            operation_id: op_id,
            attempted: skips.len(),
            ok: 0,
            failed: 0,
            skipped: skips.len(),
            partial: 0,
            entries: Vec::new(),
        };
        report.entries = skip_entries(&skips);
        return report;
    }

    // 只走回收站，绝不在这里静默改成永久删除。
    match fw::delete_paths(&verified, false, Some(op_id.clone()), protected) {
        Ok(mut report) => {
            let skipped_entries = skip_entries(&skips);
            let skipped_count = skipped_entries.len();
            let mut entries = skipped_entries;
            entries.extend(report.entries);
            report.attempted += skipped_count;
            report.skipped += skipped_count;
            report.entries = entries;
            report
        }
        Err(error) => {
            // 整批提交失败：每个待删项都要有结果，不能只报一个总数。
            let mut entries = skip_entries(&skips);
            for path in &verified {
                entries.push(fw::FsEntryReport {
                    source: path.clone(),
                    target: None,
                    status: "failed",
                    reason: Some(error.to_string()),
                    code: Some(error.code().to_string()),
                    stage: Some("recycle".into()),
                });
            }
            fw::FsOpReport {
                operation_id: op_id,
                attempted: entries.len(),
                ok: 0,
                failed: verified.len(),
                skipped: skips.len(),
                partial: 0,
                entries,
            }
        }
    }
}

fn skip_entries(skips: &[DuplicateSkip]) -> Vec<fw::FsEntryReport> {
    skips
        .iter()
        .map(|skip| fw::FsEntryReport {
            source: skip.path.clone(),
            target: None,
            status: "skipped",
            reason: Some(skip.reason.clone()),
            code: Some(skip.code.to_string()),
            stage: Some("verify".into()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("taskdock-dupe-{label}-{stamp}"));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, name: &str, content: &[u8]) -> String {
            let path = self.0.join(name);
            fs::write(&path, content).unwrap();
            path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn hash_of(path: &str) -> (u64, String) {
        let entries = fw::hash_files(&[path.to_string()], &[]);
        let entry = &entries[0];
        (entry.size.unwrap(), entry.hash.clone().unwrap())
    }

    fn group(keep: &str, delete: &str) -> DuplicateDeleteGroup {
        let (size, hash) = hash_of(keep);
        DuplicateDeleteGroup {
            keep_path: keep.to_string(),
            delete_paths: vec![delete.to_string()],
            expected_size: size,
            expected_hash: hash,
        }
    }

    fn plan_of(groups: &[DuplicateDeleteGroup]) -> DuplicatePlan {
        plan(groups, &[], &mut |_| {}, &|| false).expect("plan should succeed")
    }

    #[test]
    fn same_size_different_hash_is_skipped() {
        let dir = TempDir::new("different");
        let keep = dir.write("keep.txt", b"same-size-A");
        let delete = dir.write("delete.txt", b"same-size-B");
        let plan = plan_of(&[group(&keep, &delete)]);
        assert!(plan.is_empty(), "内容不同不得进入可删除集合");
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].code, "CONTENT_CHANGED");
    }

    #[test]
    fn same_content_is_verified_and_keep_is_not_deleted() {
        let dir = TempDir::new("same");
        let keep = dir.write("keep.txt", b"same-content");
        let delete = dir.write("delete.txt", b"same-content");
        let plan = plan_of(&[group(&keep, &delete)]);
        assert_eq!(plan.groups.len(), 1);
        assert_eq!(plan.delete_paths(), vec![delete.clone()]);
        assert!(!plan.delete_paths().contains(&keep));
    }

    #[test]
    fn verified_group_deletes_only_delete_path_and_keeps_original() {
        let dir = TempDir::new("delete");
        let keep = dir.write("keep.txt", b"same-content");
        let delete = dir.write("delete.txt", b"same-content");
        let plan = plan_of(&[group(&keep, &delete)]);
        let report = delete_plan(plan, &[], Some("dupe-test".into()));
        assert_eq!(report.ok, 1, "{report:?}");
        assert_eq!(report.failed, 0, "{report:?}");
        assert!(Path::new(&keep).exists(), "保留文件不能被删除");
        assert!(!Path::new(&delete).exists(), "待删文件应离开原路径（进入回收站）");
    }

    #[test]
    fn changed_size_is_skipped() {
        let dir = TempDir::new("size");
        let keep = dir.write("keep.txt", b"x");
        let delete = dir.write("delete.txt", b"x");
        let mut request = group(&keep, &delete);
        request.expected_size = 2;
        let plan = plan_of(&[request]);
        assert!(plan.is_empty());
        // 保留项大小不符 → 整组拒绝，理由是 KEEP_CHANGED。
        assert_eq!(plan.skipped[0].code, "KEEP_CHANGED");
    }

    #[test]
    fn keep_in_delete_list_is_rejected() {
        let dir = TempDir::new("keep");
        let keep = dir.write("keep.txt", b"same");
        let mut request = group(&keep, &keep);
        request.delete_paths = vec![keep.clone()];
        let error = plan(&[request], &[], &mut |_| {}, &|| false).unwrap_err();
        assert!(error.to_string().contains("保留文件"), "{error}");
    }

    #[test]
    fn disappeared_delete_path_is_reported_as_unverifiable() {
        let dir = TempDir::new("gone");
        let keep = dir.write("keep.txt", b"same");
        let delete = dir.write("delete.txt", b"same");
        let request = group(&keep, &delete);
        fs::remove_file(&delete).unwrap();
        let plan = plan_of(&[request]);
        assert!(plan.is_empty(), "消失的文件不能进入待删集合");
        assert_eq!(plan.skipped[0].code, "UNVERIFIABLE");
    }

    #[test]
    fn same_size_content_changed_after_hashing_is_skipped() {
        let dir = TempDir::new("same-size-changed");
        let keep = dir.write("keep.txt", b"same-content");
        let delete = dir.write("delete.txt", b"same-content");
        let request = group(&keep, &delete);
        // 保持大小不变，只替换内容：必须走到 SHA-256 复核。
        fs::write(&delete, b"diff-content").unwrap();
        let plan = plan_of(&[request]);
        assert!(plan.is_empty(), "同尺寸换内容必须被拒绝");
        assert_eq!(plan.skipped[0].code, "CONTENT_CHANGED");
    }

    #[test]
    fn zero_byte_duplicate_is_verified_and_deletes_only_unkept_copy() {
        let dir = TempDir::new("zero");
        let keep = dir.write("keep.txt", b"");
        let delete = dir.write("delete.txt", b"");
        let plan = plan_of(&[group(&keep, &delete)]);
        let report = delete_plan(plan, &[], Some("dupe-zero".into()));
        assert_eq!(report.ok, 1, "{report:?}");
        assert!(Path::new(&keep).exists(), "保留的零字节文件不能被删除");
        assert!(!Path::new(&delete).exists(), "待删零字节文件应进入回收站");
    }

    #[test]
    fn invalid_hash_is_rejected() {
        let dir = TempDir::new("hash");
        let keep = dir.write("keep.txt", b"same");
        let delete = dir.write("delete.txt", b"same");
        let mut request = group(&keep, &delete);
        request.expected_hash = "not-a-sha".into();
        let error = plan(&[request], &[], &mut |_| {}, &|| false).unwrap_err();
        assert!(error.to_string().contains("SHA-256"), "{error}");
    }

    /// 核心安全用例：哈希与提交之间把待删文件换成同名同尺寸的新文件，必须拒绝。
    #[test]
    fn file_replaced_between_plan_and_delete_is_skipped() {
        let dir = TempDir::new("replaced");
        let keep = dir.write("keep.txt", b"same-content");
        let delete = dir.write("delete.txt", b"same-content");
        let planned = plan_of(&[group(&keep, &delete)]);
        assert_eq!(planned.delete_paths(), vec![delete.clone()]);

        // 模拟「确认之后、删除之前」被替换：删掉原文件，重建同名同内容的另一个文件。
        fs::remove_file(&delete).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&delete, b"same-content").unwrap();

        let report = delete_plan(planned, &[], Some("dupe-replaced".into()));
        assert_eq!(report.ok, 0, "被替换的文件不得被删除：{report:?}");
        assert_eq!(report.skipped, 1, "{report:?}");
        assert_eq!(report.entries[0].code.as_deref(), Some("IDENTITY_CHANGED"));
        assert!(Path::new(&delete).exists(), "用户没确认过的新文件必须保留");
        assert!(Path::new(&keep).exists());
    }

    /// 取消发生在哈希阶段：不产出任何可删除项。
    #[test]
    fn cancel_during_hashing_aborts_the_plan() {
        let dir = TempDir::new("cancel");
        let keep = dir.write("keep.txt", b"same");
        let delete = dir.write("delete.txt", b"same");
        let error = plan(&[group(&keep, &delete)], &[], &mut |_| {}, &|| true).unwrap_err();
        assert!(error.to_string().contains("取消"), "{error}");
    }

    #[test]
    fn progress_reports_bytes_and_file_counts() {
        let dir = TempDir::new("progress");
        let keep = dir.write("keep.txt", b"0123456789");
        let delete = dir.write("delete.txt", b"0123456789");
        let mut last = None;
        let planned = plan(&[group(&keep, &delete)], &[], &mut |p| last = Some(p), &|| false).unwrap();
        assert_eq!(planned.groups.len(), 1);
        let last = last.expect("必须至少回调一次进度");
        assert_eq!(last.total, 2, "keep + delete 都要计入进度分母");
        assert_eq!(last.index, 2);
        assert_eq!(last.bytes_total, 20);
        assert_eq!(last.bytes_done, 20);
    }
}
