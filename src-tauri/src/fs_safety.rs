use std::path::Path;

/// Revalidates a scanned file through an open handle and marks that same object for deletion.
/// Returns `false` when identity/fingerprint/path validation fails or the platform cannot
/// provide handle-based deletion semantics. On Windows leaf handles deny all sharing and
/// the immediate category directory is opened with delete access and no write/delete sharing;
/// final-path validation requires exact equality with the canonical scanned path after only
/// normalizing case, separators, and equivalent extended-path prefixes. Ancestors above that
/// app-managed category directory are validated by the caller but are not held open here.
pub(crate) fn remove_file_if_unchanged(
    path: &Path,
    expected_size: u64,
    expected_modified_ns: u128,
    expected_identity: u128,
) -> std::io::Result<bool> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::{
            Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION, INVALID_HANDLE_VALUE},
            Storage::FileSystem::{
                CreateFileW, FileDispositionInfo, GetFileInformationByHandle,
                GetFinalPathNameByHandleW, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
                DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
                FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
                OPEN_EXISTING,
            },
        };

        let expected_path = std::fs::canonicalize(path)?;
        let Some(expected_parent) = expected_path.parent() else {
            return Ok(false);
        };
        // Lock only the validated app-managed category directory (for example `thumbs/` or the
        // TTS cache directory). Any missing, reparse, renamed, or unverifiable parent skips.
        let Some(_directory_handle) = lock_category_directory(expected_parent) else {
            return Ok(false);
        };
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                DELETE | FILE_READ_ATTRIBUTES,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(code) if code == ERROR_SHARING_VIOLATION as i32 || code == ERROR_LOCK_VIOLATION as i32)
            {
                return Ok(false);
            }
            return Err(error);
        }
        let _guard = HandleGuard(handle);

        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        if unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Ok(false);
        }
        let identity = ((info.dwVolumeSerialNumber as u128) << 64)
            | ((info.nFileIndexHigh as u128) << 32)
            | info.nFileIndexLow as u128;
        if identity != expected_identity {
            return Ok(false);
        }

        let mut final_path = vec![0u16; 32768];
        let path_len = unsafe {
            GetFinalPathNameByHandleW(handle, final_path.as_mut_ptr(), final_path.len() as u32, 0)
        } as usize;
        if path_len == 0 || path_len >= final_path.len() {
            return Err(std::io::Error::last_os_error());
        }
        final_path.truncate(path_len);
        let actual_path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&final_path));
        if normalized_windows_path(&actual_path) != normalized_windows_path(&expected_path) {
            return Ok(false);
        }

        // Excluding write/delete sharing rejects concurrent handles that modify or rename this
        // file; disposition is applied to the verified open object, not a fresh path lookup.
        let file =
            std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle as _) });
        let metadata = file.metadata()?;
        let modified_ns = metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid file timestamp")
            })?
            .as_nanos();
        let size = ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64;
        if size != expected_size || modified_ns != expected_modified_ns {
            return Ok(false);
        }

        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                handle,
                FileDispositionInfo,
                &disposition as *const _ as *const _,
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = (path, expected_size, expected_modified_ns, expected_identity);
        Ok(false)
    }
}

#[cfg(windows)]
struct HandleGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for HandleGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(windows)]
fn lock_category_directory(path: &Path) -> Option<HandleGuard> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, OPEN_EXISTING,
        },
    };

    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir() || crate::shelf::is_reparse_point(&metadata) {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    if normalized_windows_path(&canonical) != normalized_windows_path(path) {
        return None;
    }

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            DELETE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let guard = HandleGuard(handle);
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    if unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) } == 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || final_path_for_handle(handle)
            .as_deref()
            .map_or(true, |actual| {
                normalized_windows_path(actual) != normalized_windows_path(&canonical)
            })
    {
        return None;
    }
    // Verify again while the non-delete-sharing handle remains open.
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    if unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) } == 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || final_path_for_handle(handle)
            .as_deref()
            .map_or(true, |actual| {
                normalized_windows_path(actual) != normalized_windows_path(&canonical)
            })
    {
        return None;
    }
    Some(guard)
}

#[cfg(windows)]
fn final_path_for_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> Option<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let mut buffer = vec![0u16; 32768];
    let length =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) }
            as usize;
    if length == 0 || length >= buffer.len() {
        return None;
    }
    buffer.truncate(length);
    Some(std::path::PathBuf::from(std::ffi::OsString::from_wide(
        &buffer,
    )))
}

#[cfg(windows)]
fn normalized_windows_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\");
    let value = if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else {
        value.strip_prefix("\\\\?\\").unwrap_or(&value).to_string()
    };
    value.to_lowercase()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn handle_delete_rejects_same_path_replacement() {
        let path =
            std::env::temp_dir().join(format!("td-handle-delete-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"same-size").unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        let modified_ns = metadata
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let identity = crate::shelf::file_identity(&path).unwrap();
        let replacement = path.with_extension("replacement");
        std::fs::rename(&path, &replacement).unwrap();
        std::fs::write(&path, b"same-size").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(metadata.modified().unwrap())
            .unwrap();

        assert!(!remove_file_if_unchanged(&path, metadata.len(), modified_ns, identity).unwrap());
        assert!(path.exists());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(replacement).unwrap();
    }

    #[test]
    fn locked_category_directory_prevents_rename() {
        let root = std::env::temp_dir().join(format!("td-dir-lock-{}", uuid::Uuid::new_v4()));
        let parent = root.join("parent");
        std::fs::create_dir_all(&parent).unwrap();
        let file = parent.join("candidate.bin");
        std::fs::write(&file, b"candidate").unwrap();
        let canonical_parent = std::fs::canonicalize(&parent).unwrap();
        let moved = root.join("parent-moved");

        let lock = lock_category_directory(&canonical_parent).expect("分类目录应能安全锁定");
        assert!(std::fs::rename(&parent, &moved).is_err());
        drop(lock);
        std::fs::rename(&parent, &moved).unwrap();
        std::fs::remove_file(moved.join("candidate.bin")).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_file_handle_prevents_delete_until_released() {
        use std::os::windows::fs::OpenOptionsExt;

        let path =
            std::env::temp_dir().join(format!("td-open-file-lock-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"playing-cache").unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        let modified_ns = metadata
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let identity = crate::shelf::file_identity(&path).unwrap();
        let open_file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();

        assert!(!remove_file_if_unchanged(&path, metadata.len(), modified_ns, identity).unwrap());
        assert!(path.exists(), "占用中的缓存不得被标记删除");
        drop(open_file);
        assert!(remove_file_if_unchanged(&path, metadata.len(), modified_ns, identity).unwrap());
        assert!(!path.exists());
    }
}
