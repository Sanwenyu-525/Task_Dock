//! 真实存储卷判定（2026-11-16，第四轮 P0 补缺）。
//!
//! 仅靠盘符无法区分目录挂载点、符号链接、网络共享：同一盘符下可能挂着
//! 另一个卷。这里用 Win32 的 `GetVolumePathNameW` 找到路径所属的卷挂载根，
//! 再用 `GetVolumeNameForVolumeMountPointW` 取 Volume GUID；两者都失败时
//! 返回稳定前缀兜底。前端只用「相同 / 不同 / 未知」做默认复制/移动判断，
//! 失败时宁可复制，不静默移动。

use std::path::Path;

/// 批量返回每个路径的卷键；空字符串表示无法判定（前端按跨卷安全复制处理）。
pub fn volume_keys(paths: &[String]) -> Vec<Option<String>> {
    paths.iter().map(|path| volume_key(path)).collect()
}

fn volume_key(raw: &str) -> Option<String> {
    let path = crate::file_workspace::validate_abs_path(raw).ok()?;
    volume_key_from_path(&path)
}

#[cfg(windows)]
fn volume_key_from_path(path: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetVolumeNameForVolumeMountPointW, GetVolumePathNameW,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut mount = [0u16; 260];
    let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), mount.as_mut_ptr(), mount.len() as u32) };
    if ok == 0 {
        return fallback_key(&path.to_string_lossy());
    }
    let mount_len = mount.iter().position(|c| *c == 0).unwrap_or(mount.len());
    let mount_path = String::from_utf16_lossy(&mount[..mount_len]);
    let mount_wide: Vec<u16> = mount_path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut guid = [0u16; 260];
    let ok = unsafe {
        GetVolumeNameForVolumeMountPointW(mount_wide.as_ptr(), guid.as_mut_ptr(), guid.len() as u32)
    };
    if ok != 0 {
        let len = guid.iter().position(|c| *c == 0).unwrap_or(guid.len());
        return Some(String::from_utf16_lossy(&guid[..len]).to_ascii_lowercase());
    }
    // volume GUID 查询失败但卷路径可用：用卷挂载根做键，仍能区分目录挂载点。
    Some(mount_path.to_ascii_lowercase())
}

#[cfg(not(windows))]
fn volume_key_from_path(path: &Path) -> Option<String> {
    let text = path.to_string_lossy();
    fallback_key(&text)
}

/// 无法调用 Win32 时的保守键：盘符根 / UNC server-share / 完整路径。
/// 返回完整路径会让不同目录被判定为不同卷，从而默认复制，避免误移动。
fn fallback_key(raw: &str) -> Option<String> {
    let text = raw.replace('/', "\\");
    let bytes = text.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'\\' && bytes[0].is_ascii_alphabetic() {
        return Some(format!("{}:\\", (bytes[0] as char).to_ascii_lowercase()));
    }
    if text.starts_with("\\\\") {
        let parts: Vec<&str> = text.trim_start_matches('\\').split('\\').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 2 {
            return Some(format!("\\\\{}\\{}", parts[0], parts[1]).to_ascii_lowercase());
        }
    }
    Some(text.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_drive_and_unc_are_stable() {
        assert_eq!(fallback_key("C:\\work\\a.txt").as_deref(), Some("c:\\"));
        assert_eq!(fallback_key("c:/work/a.txt").as_deref(), Some("c:\\"));
        assert_eq!(
            fallback_key("\\\\Server\\Share\\dir\\a.txt").as_deref(),
            Some("\\\\server\\share")
        );
        assert!(fallback_key("relative\\a.txt").is_some());
    }

    #[test]
    fn existing_temp_dir_has_a_volume_key() {
        let dir = std::env::temp_dir();
        assert!(volume_key(&dir.to_string_lossy()).is_some());
    }

    #[test]
    fn different_drives_resolve_to_different_volume_keys() {
        if !Path::new("C:\\").exists() || !Path::new("D:\\").exists() {
            return;
        }
        let c = volume_key_from_path(Path::new("C:\\"));
        let d = volume_key_from_path(Path::new("D:\\"));
        assert!(c.is_some() && d.is_some(), "C/D volume key missing");
        assert_ne!(c, d, "C: and D: must not share a volume key");
        let c_sub = volume_key_from_path(Path::new("C:\\Windows"));
        assert_eq!(c, c_sub, "subdirectory must inherit its volume key");
    }
}
