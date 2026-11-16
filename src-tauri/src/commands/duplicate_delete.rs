//! 重复文件删除命令：只在服务端重新校验每个“保留文件”和“待删文件”的
//! 大小与 SHA-256 后，才调用现有回收站删除入口。
//!
//! 为什么单独建命令而不是复用 `fs_delete_paths`：普通删除不知道“重复组”语义，
//! 前端传入的 verified 状态可被绕过；这里把保留项与待删项一起复核，任何一项
//! 缺失、被修改、哈希失败或与组内不一致都会在删除前 fail-closed。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::file_workspace::{self as fw, FsOpReport};

/// 一个重复组的删除请求。`keep_path` 必须实际存在且与 `delete_paths` 内容一致。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateDeleteGroup {
    pub keep_path: String,
    pub delete_paths: Vec<String>,
    pub expected_size: u64,
    pub expected_hash: String,
}

#[derive(Debug)]
struct VerifiedGroup {
    keep_path: String,
    delete_paths: Vec<String>,
    expected_size: u64,
    expected_hash: String,
}

fn protected_dirs(app: &AppHandle) -> Vec<PathBuf> {
    std::env::var_os("TASK_DOCK_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .into_iter()
        .collect()
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

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn require_regular_file(path: &Path, expected_size: u64) -> AppResult<()> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| invalid(format!("读取文件属性失败：{}（{e}）", path.display())))?;
    if is_reparse(&meta) || !meta.is_file() {
        return Err(invalid(format!("仅允许删除普通文件：{}", path.display())));
    }
    if meta.len() != expected_size {
        return Err(invalid(format!(
            "文件大小已变化：{}（期望 {}，实际 {}）",
            path.display(),
            expected_size,
            meta.len()
        )));
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 先做组形状与文件身份校验，再用一次 SHA-256 复核全部路径。
/// 这个函数不执行删除，便于测试“哈希失败/文件变化必须拒绝”。
fn verify_duplicate_groups(
    groups: &[DuplicateDeleteGroup],
    protected: &[PathBuf],
) -> AppResult<Vec<VerifiedGroup>> {
    if groups.is_empty() {
        return Err(invalid("没有可删除的重复组"));
    }
    let total_paths: usize = groups.iter().map(|g| 1 + g.delete_paths.len()).sum();
    if total_paths > fw::MAX_OP_PATHS {
        return Err(invalid(format!("单批最多 {} 项", fw::MAX_OP_PATHS)));
    }

    let mut all_paths = Vec::with_capacity(total_paths);
    let mut seen = HashSet::new();
    let mut verified = Vec::with_capacity(groups.len());

    for group in groups {
        if group.delete_paths.is_empty() {
            return Err(invalid("每个重复组至少需要一个待删文件，且必须保留一个原文件"));
        }
        if group.expected_size == 0 {
            return Err(invalid("空文件不能进入重复删除流程"));
        }
        if !is_sha256_hex(&group.expected_hash) {
            return Err(invalid("重复组哈希不是有效的 SHA-256"));
        }

        let keep = fw::validate_abs_path(&group.keep_path)?;
        fw::ensure_not_protected(&keep, protected)?;
        let keep_key = path_key(&keep);
        if !seen.insert(keep_key.clone()) {
            return Err(invalid("同一路径在重复组中出现多次"));
        }
        require_regular_file(&keep, group.expected_size)?;
        all_paths.push(keep.to_string_lossy().into_owned());

        let mut delete_paths = Vec::with_capacity(group.delete_paths.len());
        for raw in &group.delete_paths {
            let path = fw::validate_abs_path(raw)?;
            fw::ensure_not_protected(&path, protected)?;
            let key = path_key(&path);
            if key == keep_key {
                return Err(invalid("保留文件不能出现在待删除列表"));
            }
            if !seen.insert(key.clone()) {
                return Err(invalid("待删除路径在多个重复组中重复出现"));
            }
            require_regular_file(&path, group.expected_size)?;
            let text = path.to_string_lossy().into_owned();
            all_paths.push(text.clone());
            delete_paths.push(text);
        }

        verified.push(VerifiedGroup {
            keep_path: keep.to_string_lossy().into_owned(),
            delete_paths,
            expected_size: group.expected_size,
            expected_hash: group.expected_hash.clone(),
        });
    }

    let entries = fw::hash_files(&all_paths, protected);
    let mut by_path = std::collections::HashMap::with_capacity(entries.len());
    for entry in entries {
        by_path.insert(entry.path.to_lowercase(), entry);
    }

    for group in &verified {
        for raw in std::iter::once(&group.keep_path).chain(group.delete_paths.iter()) {
            let entry = by_path
                .get(&raw.to_lowercase())
                .ok_or_else(|| invalid(format!("没有取得哈希结果：{raw}")))?;
            if entry.error.is_some() {
                return Err(invalid(format!("哈希失败：{raw}")));
            }
            if entry.size != Some(group.expected_size) {
                return Err(invalid(format!("哈希复核时文件大小不一致：{raw}")));
            }
            if entry.hash.as_deref() != Some(group.expected_hash.as_str()) {
                return Err(invalid(format!("文件内容已变化，拒绝删除：{raw}")));
            }
        }
    }

    // 在真正进入回收站前再做一次轻量身份检查；内容已在上一轮 SHA-256 复核，
    // 这里拦截“复核后文件被删除/替换/改大小”的常见窗口。
    for group in &verified {
        require_regular_file(
            &fw::validate_abs_path(&group.keep_path)?,
            group.expected_size,
        )?;
        for raw in &group.delete_paths {
            require_regular_file(&fw::validate_abs_path(raw)?, group.expected_size)?;
        }
    }

    Ok(verified)
}

fn delete_verified_duplicates(
    groups: Vec<DuplicateDeleteGroup>,
    operation_id: Option<String>,
    protected: &[PathBuf],
) -> AppResult<FsOpReport> {
    let checked = verify_duplicate_groups(&groups, protected)?;
    let paths: Vec<String> = checked
        .into_iter()
        .flat_map(|group| group.delete_paths)
        .collect();
    // 只走回收站，绝不在这里静默改成永久删除。
    fw::delete_paths(&paths, false, operation_id, protected)
}

/// 删除已在 SHA-256 上确认的重复文件。每个组至少保留 `keepPath`，
/// 服务端重新哈希后才进入回收站；任何校验失败都不会执行删除。
#[tauri::command]
pub async fn fs_delete_verified_duplicates(
    app: AppHandle,
    groups: Vec<DuplicateDeleteGroup>,
    operation_id: Option<String>,
) -> AppResult<FsOpReport> {
    let protected = protected_dirs(&app);
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        delete_verified_duplicates(groups, operation_id, &protected)
    })
    .await
    .map_err(|e| AppError::Agent(format!("文件操作任务失败: {e}")))?;

    if let Ok(report) = &result {
        let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        for event in fw::op_diagnostic_events(
            report,
            "workspace_delete_duplicates",
            "recycle",
            duration_ms,
        ) {
            crate::diagnostics::emit(event);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("taskdock-dupe-{label}-{stamp}"));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(dir: &TempDir, name: &str, content: &[u8]) -> String {
        let path = dir.0.join(name);
        fs::write(&path, content).unwrap();
        path.to_string_lossy().into_owned()
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

    #[test]
    fn same_size_different_hash_is_rejected() {
        let dir = TempDir::new("different");
        let keep = write(&dir, "keep.txt", b"same-size-A");
        let delete = write(&dir, "delete.txt", b"same-size-B");
        let err = verify_duplicate_groups(&[group(&keep, &delete)], &[]).unwrap_err();
        assert!(err.to_string().contains("拒绝删除"), "{err}");
    }

    #[test]
    fn same_content_is_verified_and_keep_is_not_deleted() {
        let dir = TempDir::new("same");
        let keep = write(&dir, "keep.txt", b"same-content");
        let delete = write(&dir, "delete.txt", b"same-content");
        let verified = verify_duplicate_groups(&[group(&keep, &delete)], &[]).unwrap();
        assert_eq!(verified.len(), 1);
        assert_eq!(verified[0].delete_paths.len(), 1);
        assert!(!verified[0].delete_paths.contains(&keep));
    }

    #[test]
    fn changed_size_is_rejected() {
        let dir = TempDir::new("size");
        let keep = write(&dir, "keep.txt", b"x");
        let delete = write(&dir, "delete.txt", b"x");
        let mut request = group(&keep, &delete);
        request.expected_size = 2;
        let err = verify_duplicate_groups(&[request], &[]).unwrap_err();
        assert!(err.to_string().contains("大小"), "{err}");
    }

    #[test]
    fn keep_in_delete_list_is_rejected() {
        let dir = TempDir::new("keep");
        let keep = write(&dir, "keep.txt", b"same");
        let mut request = group(&keep, &keep);
        request.delete_paths = vec![keep.clone()];
        let err = verify_duplicate_groups(&[request], &[]).unwrap_err();
        assert!(err.to_string().contains("保留文件"), "{err}");
    }

    #[test]
    fn invalid_hash_is_rejected() {
        let dir = TempDir::new("hash");
        let keep = write(&dir, "keep.txt", b"same");
        let delete = write(&dir, "delete.txt", b"same");
        let mut request = group(&keep, &delete);
        request.expected_hash = "not-a-sha".into();
        let err = verify_duplicate_groups(&[request], &[]).unwrap_err();
        assert!(err.to_string().contains("SHA-256"), "{err}");
    }
}
