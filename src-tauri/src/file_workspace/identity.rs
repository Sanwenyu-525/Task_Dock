//! 文件身份快照与复核（重复文件删除的安全边界）。
//!
//! 为什么需要它：按路径比较「类型 + 大小」不足以证明「还是同一个文件」。
//! 哈希与真正提交删除之间存在窗口，其间同名同尺寸的文件可以被替换，删除就会
//! 命中用户没确认过的那一份。Windows 上可用的稳定身份是
//! `(卷序列号, 文件索引)`，再叠加大小、修改时间与「句柄最终路径」，
//! 才能证明「我复核的对象就是当初哈希的对象，而且仍在用户给的路径上」。
//!
//! 与 `crate::fs_safety` 的关系：那里用同一套 `GetFileInformationByHandle` 范式
//! 做「扫描后按句柄删除」；这里只做**只读复核**，供删除前的最后一道校验使用，
//! 不重复实现删除语义。

use std::path::Path;

/// 一次身份快照。`stable=false` 表示当前平台拿不到文件索引（只有大小+时间），
/// 属于弱身份，调用方必须在报告里如实标注能力差异。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub volume_serial: u64,
    pub file_index: u64,
    pub size: u64,
    /// 修改时间，单位为 100ns（Windows FILETIME），避免 `SystemTime` 的精度/时区歧义。
    pub modified_100ns: u128,
    pub stable: bool,
}

impl FileIdentity {
    /// 弱身份：只有大小与修改时间可比（非 Windows 或个别文件系统）。
    pub fn is_stable(&self) -> bool {
        self.stable
    }
}

/// 复核结论。语义必须互斥：调用方据此决定「删除 / 跳过 / 拒绝整组」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityCheck {
    /// 身份、大小、修改时间与路径全部一致。
    Match,
    /// 已确认不是同一个文件（被替换/改写/改名）。
    Changed(&'static str),
    /// 文件已不存在。
    Missing,
    /// 无法证明（打不开、属性读不到、平台不支持）：必须按「不可验证」处理，绝不默认删除。
    Unverifiable(&'static str),
}

impl IdentityCheck {
    pub fn is_match(self) -> bool {
        matches!(self, IdentityCheck::Match)
    }

    /// 面向用户的短原因，用于逐项报告。
    pub fn reason(self) -> &'static str {
        match self {
            IdentityCheck::Match => "文件身份一致",
            IdentityCheck::Changed(reason) | IdentityCheck::Unverifiable(reason) => reason,
            IdentityCheck::Missing => "文件已不存在",
        }
    }
}

/// 从已打开的句柄取身份。**必须优先使用句柄**：先按路径 stat 再按路径 open
/// 会让两次解析落在不同对象上，正好给替换留出窗口。
pub fn identity_of_handle(file: &std::fs::File) -> std::io::Result<FileIdentity> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };

        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, info.as_mut_ptr()) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        let modified_100ns =
            ((info.ftLastWriteTime.dwHighDateTime as u128) << 32) | info.ftLastWriteTime.dwLowDateTime as u128;
        Ok(FileIdentity {
            volume_serial: info.dwVolumeSerialNumber as u64,
            file_index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            size: ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64,
            modified_100ns,
            stable: true,
        })
    }
    #[cfg(not(windows))]
    {
        let meta = file.metadata()?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Ok(FileIdentity {
            volume_serial: 0,
            file_index: 0,
            size: meta.len(),
            modified_100ns: modified,
            stable: false,
        })
    }
}

/// 打开文件并读取身份快照（与后续哈希使用同一句柄时请改用 `identity_of_handle`）。
pub fn snapshot_path(path: &Path) -> std::io::Result<FileIdentity> {
    let file = std::fs::File::open(path)?;
    identity_of_handle(&file)
}

/// 删除前的最后一道复核：重新打开句柄，比对身份、大小、修改时间与最终路径。
///
/// 任何一项无法证明都返回 `Unverifiable`，由调用方跳过并报告，**不能**当成匹配。
pub fn verify_path(path: &Path, expected: &FileIdentity) -> IdentityCheck {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return IdentityCheck::Missing
        }
        Err(_) => return IdentityCheck::Unverifiable("无法打开文件，身份不可验证"),
    };
    let actual = match identity_of_handle(&file) {
        Ok(identity) => identity,
        Err(_) => return IdentityCheck::Unverifiable("无法读取文件身份"),
    };
    if expected.stable && actual.stable {
        if actual.volume_serial != expected.volume_serial
            || actual.file_index != expected.file_index
        {
            return IdentityCheck::Changed("文件已被替换（卷或文件索引不同）");
        }
    } else if actual.stable != expected.stable {
        // 能力不一致（例如快照来自另一个平台/文件系统）：不能跨界断言同一对象。
        return IdentityCheck::Unverifiable("文件身份能力不一致");
    }
    if actual.size != expected.size {
        return IdentityCheck::Changed("文件大小已变化");
    }
    if actual.modified_100ns != expected.modified_100ns {
        return IdentityCheck::Changed("修改时间已变化");
    }
    // 最终路径一致性：句柄指向的对象必须仍是请求里的那个路径，
    // 否则「同名替换 + 目录联接/符号链接」可以绕过上面的比较。
    #[cfg(windows)]
    if let Some(final_path) = final_path_of(&file) {
        let requested = std::fs::canonicalize(path)
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string_lossy().into_owned());
        if normalize_windows_path(&final_path) != normalize_windows_path(&requested) {
            return IdentityCheck::Changed("句柄最终路径与请求路径不一致");
        }
    }
    IdentityCheck::Match
}

#[cfg(windows)]
fn final_path_of(file: &std::fs::File) -> Option<String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let mut buffer = vec![0u16; 32768];
    let written = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as _,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return None;
    }
    buffer.truncate(written as usize);
    Some(String::from_utf16_lossy(&buffer))
}

/// 只归一化大小写、分隔符与等价的长路径前缀；不做任何路径解析。
#[cfg(windows)]
fn normalize_windows_path(path: &str) -> String {
    let mut text = path.replace('/', "\\");
    if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
        text = format!("\\\\{rest}");
    } else if let Some(rest) = text.strip_prefix("\\\\?\\") {
        text = rest.to_string();
    }
    text.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("taskdock-identity-{label}-{stamp}"));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self, name: &str, bytes: &[u8]) -> std::path::PathBuf {
            let path = self.0.join(name);
            let mut file = std::fs::File::create(&path).unwrap();
            file.write_all(bytes).unwrap();
            file.flush().unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn unchanged_file_matches_its_snapshot() {
        let dir = TempDir::new("match");
        let path = dir.file("a.txt", b"same-content");
        let identity = snapshot_path(&path).unwrap();
        assert_eq!(verify_path(&path, &identity), IdentityCheck::Match);
    }

    #[test]
    fn same_size_rewrite_is_detected() {
        let dir = TempDir::new("rewrite");
        let path = dir.file("a.txt", b"abcdefgh");
        let before = snapshot_path(&path).unwrap();
        // 同尺寸重写：大小一致，但修改时间变化（NTFS 100ns 精度足够）。
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, b"01234567").unwrap();
        let check = verify_path(&path, &before);
        assert!(
            matches!(check, IdentityCheck::Changed(_)),
            "同尺寸替换必须被拒绝：{check:?}"
        );
    }

    #[test]
    fn replaced_file_is_detected_by_identity() {
        let dir = TempDir::new("replace");
        let path = dir.file("a.txt", b"same");
        let before = snapshot_path(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let replacement = dir.file("a.txt", b"same");
        assert_eq!(replacement, path);
        let check = verify_path(&path, &before);
        // 文件索引变化（或至少修改时间变化）必须被识别，不能只看大小。
        assert!(
            matches!(check, IdentityCheck::Changed(_)),
            "同名同尺寸重建必须被拒绝：{check:?}"
        );
    }

    #[test]
    fn missing_file_is_reported_as_missing() {
        let dir = TempDir::new("missing");
        let path = dir.file("a.txt", b"x");
        let identity = snapshot_path(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(verify_path(&path, &identity), IdentityCheck::Missing);
    }
}
