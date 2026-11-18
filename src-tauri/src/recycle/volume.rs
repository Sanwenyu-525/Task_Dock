//! 回收站卷发现与系统级操作（Windows 专属，非 Windows 编译为空实现）。
//!
//! 统一维护「当前用户 SID → 各卷 `$Recycle.Bin\<SID>`」这一事实，避免
//! 资源清理面板、回收站索引、批量操作三处各自推算（旧实现有三份等价代码）。

#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};

/// 一个卷的用户回收站目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinVolume {
    /// 盘符（`C:`）或卷根（`\\?\Volume{...}` 的展示形式）。
    pub volume: String,
    /// 该卷回收站根路径：`C:\$Recycle.Bin\<SID>`。
    pub root: PathBuf,
    /// 卷根（`C:\`），清空/查询系统统计时使用。
    pub drive_root: String,
}

impl BinVolume {
    pub fn is_offline(&self) -> bool {
        !self.root.is_dir()
    }
}

#[cfg(windows)]
struct TokenGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for TokenGuard {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// 当前进程用户的 SID 字符串（`S-1-5-21-...`）。
#[cfg(windows)]
pub fn current_user_sid() -> Option<String> {
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let _guard = TokenGuard(token);

    let mut needed = 0u32;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    if needed < 8 {
        return None;
    }
    let mut buffer = vec![0u8; needed as usize];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut core::ffi::c_void,
            needed,
            &mut needed,
        )
    } == 0
    {
        return None;
    }
    let user = unsafe { std::ptr::read_unaligned(buffer.as_ptr() as *const TOKEN_USER) };
    if user.User.Sid.is_null() {
        return None;
    }
    let sid = user.User.Sid as *const u8;
    let count = unsafe { *sid.add(1) } as usize;
    if count > 15 {
        return None;
    }
    let length = 8 + count * 4;
    if length > buffer.len() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(sid, length) };
    sid_bytes_to_string(bytes)
}

#[cfg(not(windows))]
pub fn current_user_sid() -> Option<String> {
    None
}

/// SID 二进制 → `S-revision-authority-sub1-sub2...`（不依赖额外 Win32 feature）。
pub fn sid_bytes_to_string(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        return None;
    }
    let revision = bytes[0];
    let count = bytes[1] as usize;
    if count > 15 || bytes.len() < 8 + count * 4 {
        return None;
    }
    let authority = bytes[2..8]
        .iter()
        .fold(0u64, |accumulated, byte| (accumulated << 8) | u64::from(*byte));
    let mut text = format!("S-{revision}-{authority}");
    for index in 0..count {
        let offset = 8 + index * 4;
        let value = u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);
        text.push('-');
        text.push_str(&value.to_string());
    }
    Some(text)
}

/// 枚举当前用户在各本地卷上的回收站目录。目录不存在的卷跳过（没有回收站）。
pub fn bin_volumes() -> Result<Vec<BinVolume>, (String, String)> {
    #[cfg(windows)]
    {
        let sid = current_user_sid().ok_or_else(|| {
            (
                "SHELL_FAILED".to_string(),
                "无法确定当前用户标识，暂不能读取回收站".to_string(),
            )
        })?;
        let mut out = Vec::new();
        for volume in crate::resource_cleanup::volumes::local_drive_roots() {
            let drive_root = format!("{volume}\\");
            let root = PathBuf::from(format!(r"{drive_root}$Recycle.Bin\{sid}"));
            if root.is_dir() {
                out.push(BinVolume {
                    volume,
                    root,
                    drive_root,
                });
            }
        }
        Ok(out)
    }
    #[cfg(not(windows))]
    {
        Err((
            "UNSUPPORTED".to_string(),
            "当前平台不支持回收站".to_string(),
        ))
    }
}

/// 已知卷集合（含回收站目录暂时不可访问的卷），用于保留离线卷缓存。
pub fn known_bin_volumes() -> Vec<BinVolume> {
    #[cfg(windows)]
    {
        let Some(sid) = current_user_sid() else {
            return Vec::new();
        };
        crate::resource_cleanup::volumes::local_drive_roots()
            .into_iter()
            .map(|volume| {
                let drive_root = format!("{volume}\\");
                BinVolume {
                    root: PathBuf::from(format!(r"{drive_root}$Recycle.Bin\{sid}")),
                    volume,
                    drive_root,
                }
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// 由盘符根（`C:\`）定位回收站根；`None` 表示该卷没有当前用户回收站。
pub fn bin_root_for_drive(drive_root: &str) -> Option<PathBuf> {
    let sid = current_user_sid()?;
    let root = PathBuf::from(format!(
        "{}\\$Recycle.Bin\\{}",
        drive_root.trim_end_matches('\\'),
        sid
    ));
    root.is_dir().then_some(root)
}

#[cfg(windows)]
const EMPTY_WORKER: &str = "--recycle-empty-worker";

/// 通过独立进程执行单卷 Shell 清空。返回 None 表示已取消，卷实际状态须重新同步。
#[cfg(windows)]
pub fn empty_recycle_bin(
    volume: &BinVolume,
    cancelled: impl Fn() -> bool,
) -> Option<Result<(), (String, String)>> {
    use std::io::{self, Read, Write};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::process::Stdio;
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let run = || -> io::Result<Option<i32>> {
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe { SetInformationJobObject(
            job.as_raw_handle(), JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&info).cast(), std::mem::size_of_val(&info) as u32,
        ) } == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut child = crate::winproc::hidden(std::env::current_exe()?)
            .args([EMPTY_WORKER, &volume.drive_root])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
            let error = io::Error::last_os_error();
            drop(child.stdin.take());
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        // 子进程在加入 Job 前只读握手。父进程退出时系统自动回收该 Job。
        if cancelled() {
            drop(job);
            child.wait()?;
            return Ok(None);
        }
        child.stdin.take().expect("piped stdin").write_all(b"1")?;
        let mut pipe = child.stdout.take().expect("piped stdout");
        let heartbeat = Arc::new(AtomicBool::new(false));
        let signalled = heartbeat.clone();
        let reader = std::thread::Builder::new().name("recycle-clear-progress".into()).spawn(move || {
            let mut buffer = [0; 64];
            while pipe.read(&mut buffer).is_ok_and(|size| size != 0) {
                signalled.store(true, Ordering::Relaxed);
            }
        })?;
        let mut last_progress = Instant::now();
        let outcome = (|| loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status.code());
            }
            if cancelled() {
                return Ok(None);
            }
            if heartbeat.swap(false, Ordering::Relaxed) {
                last_progress = Instant::now();
            }
            if last_progress.elapsed() >= Duration::from_secs(900) {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "Windows 清空连续 15 分钟无批次进展"));
            }
            std::thread::sleep(Duration::from_millis(100));
        })();
        drop(job);
        child.wait()?;
        let _ = reader.join();
        outcome
    };
    match run() {
        Ok(None) => None,
        Ok(Some(0)) => Some(Ok(())),
        Ok(Some(3)) => Some(Err(("EMPTY_REMAINS".into(), "回收站仍有配对条目，请重新同步".into()))),
        Ok(Some(4)) => Some(Err(("EMPTY_UNVERIFIED".into(), "无法核对清空结果，请重新同步".into()))),
        Ok(Some(5)) => Some(Err(("SHELL_FAILED".into(), "Windows 批量删除未完成，请重新同步后重试".into()))),
        Ok(Some(code)) => Some(Err(("SHELL_FAILED".into(), format!("清空回收站失败（Shell 返回 0x{code:08X}）")))),
        Err(err) => Some(Err((
            if err.kind() == io::ErrorKind::TimedOut { "SHELL_TIMEOUT" } else { "SHELL_FAILED" }.into(),
            format!("清空任务未能核实结果，请重新同步：{err}"),
        ))),
    }
}

#[cfg(not(windows))]
pub fn empty_recycle_bin(_volume: &BinVolume, _cancelled: impl Fn() -> bool) -> Option<Result<(), (String, String)>> {
    Some(Err(("UNSUPPORTED".into(), "当前平台不支持回收站".into())))
}

#[cfg(windows)]
pub fn run_empty_worker(args: &[String]) -> i32 {
    use std::io::{Read, Write};
    let [drive_root] = args else { return 2 };
    let [letter, b':', b'\\'] = *drive_root.as_bytes() else { return 2 };
    if !letter.is_ascii_alphabetic() { return 2; }
    let mut ready = [0];
    if std::io::stdin().read_exact(&mut ready).is_err() || ready != *b"1" { return 2; }
    let Ok(volumes) = bin_volumes() else { return 4 };
    let Some(volume) = volumes.into_iter().find(|v| v.drive_root.eq_ignore_ascii_case(drive_root)) else { return 4 };
    let Ok(paths) = paired_payloads(&volume.root) else { return 4 };
    const BATCH_SIZE: usize = 1000;
    let purge = |paths: &[PathBuf]| crate::recycle::ops::purge_volume_batches(paths, BATCH_SIZE, |timing| {
        // 心跳仅携带批次计数和耗时，无条目名称或路径。
        let mut progress = std::io::stdout().lock();
        let _ = writeln!(progress, "{} {} {}", timing.items, timing.prepare.as_millis(), timing.perform.as_millis());
        let _ = progress.flush();
    });
    let result = if paths.len() >= 2 * BATCH_SIZE {
        // 每个线程自己初始化 STA 和回收站 Shell 绑定，只处理不重叠的路径。
        let (first, second) = paths.split_at(paths.len() / 2);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| purge(first));
            let second = purge(second);
            let first = worker.join().unwrap_or_else(|_| Err(crate::error::AppError::Unavailable(
                "回收站删除线程异常退出".into(),
            )));
            first.and(second)
        })
    } else {
        purge(&paths)
    };
    if result.is_err() {
        return 5;
    }
    match paired_payloads(&volume.root) {
        Ok(paths) if paths.is_empty() => 0,
        Ok(_) => 3,
        Err(_) => 4,
    }
}

#[cfg(not(windows))]
pub fn run_empty_worker(_args: &[String]) -> i32 { 2 }

#[cfg(any(windows, test))]
pub(crate) fn paired_payloads(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut metadata_keys = std::collections::HashSet::new();
    let mut payloads = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(key) = name.strip_prefix("$I").or_else(|| name.strip_prefix("$i")) {
            let ty = entry.file_type()?;
            if ty.is_file() && !ty.is_symlink() {
                metadata_keys.insert(key.to_lowercase());
            }
        } else if let Some(key) = name.strip_prefix("$R").or_else(|| name.strip_prefix("$r")) {
            payloads.push((key.to_lowercase(), entry.path()));
        }
    }
    Ok(payloads.into_iter()
        .filter_map(|(key, path)| metadata_keys.contains(&key).then_some(path))
        .collect())
}

/// 系统级回收站统计（`SHQueryRecycleBinW`）。
///
/// 注意：该接口内部需要枚举 Shell 命名空间，实测在 13 万项目时可达数十秒，
/// **不得放在 UI 打开路径上**。仅用于后台校验 / 用户显式刷新系统统计。
#[cfg(windows)]
pub fn system_totals(drive_root: &str) -> Result<(u64, u64), (String, String)> {
    use windows_sys::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};

    let wide: Vec<u16> = drive_root
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        i64Size: 0,
        i64NumItems: 0,
    };
    let rc = unsafe { SHQueryRecycleBinW(wide.as_ptr(), &mut info) };
    if rc < 0 {
        return Err((
            "SHELL_FAILED".into(),
            format!("系统回收站统计失败（Shell 返回 0x{rc:08X}）"),
        ));
    }
    Ok((
        info.i64NumItems.max(0) as u64,
        info.i64Size.max(0) as u64,
    ))
}

#[cfg(not(windows))]
pub fn system_totals(_drive_root: &str) -> Result<(u64, u64), (String, String)> {
    Err(("UNSUPPORTED".into(), "当前平台不支持回收站".into()))
}

/// 卷根路径（`D:\`）→ 展示用卷名（`D:`）。无法识别时原样返回。
pub fn volume_label_of_path(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return format!("{}:", bytes[0] as char).to_uppercase();
    }
    if path.starts_with("\\\\") {
        let mut parts = path.trim_start_matches('\\').split('\\');
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        return format!("\\\\{server}\\{share}");
    }
    String::new()
}

/// 卷根（不含反斜杠，`C:`）→ 清空/统计使用的根路径（`C:\`）。
pub fn drive_root_of(volume: &str) -> String {
    if volume.len() == 2 && volume.ends_with(':') {
        format!("{volume}\\")
    } else {
        volume.to_string()
    }
}

/// 判断路径是否位于某个回收站目录下（用于拒绝把回收站内部路径当普通文件操作）。
pub fn is_under_recycle_bin(path: &Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase();
    text.contains("\\$recycle.bin\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sid_bytes_roundtrip() {
        // S-1-5-21-1-2-3-1001
        let bytes = [
            1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xE9, 3,
            0, 0,
        ];
        assert_eq!(
            sid_bytes_to_string(&bytes).as_deref(),
            Some("S-1-5-21-1-2-3-1001")
        );
    }

    #[test]
    fn volume_of_paths() {
        assert_eq!(volume_label_of_path(r"d:\dir\file.txt"), "D:");
        assert_eq!(volume_label_of_path(r"\\server\share\dir"), r"\\server\share");
        assert_eq!(drive_root_of("D:"), r"D:\");
        assert_eq!(drive_root_of("D:\\"), r"D:\");
    }

    #[test]
    fn recognizes_recycle_bin_paths() {
        assert!(is_under_recycle_bin(Path::new(
            r"D:\$Recycle.Bin\S-1-5-21-1\$RABC.txt"
        )));
        assert!(!is_under_recycle_bin(Path::new(r"D:\work\$Recycle.Bin.txt")));
    }

    #[test]
    fn empty_verification_distinguishes_unpaired_metadata_from_live_entries() {
        let root = std::env::temp_dir().join(format!("task-dock-empty-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("$Ikept.txt"), b"").unwrap();
        std::fs::write(root.join("$Runpaired.txt"), b"").unwrap();
        assert!(paired_payloads(&root).unwrap().is_empty());
        std::fs::write(root.join("$Rkept.txt"), b"").unwrap();
        assert_eq!(paired_payloads(&root).unwrap(), vec![root.join("$Rkept.txt")]);
        for name in ["$Ikept.txt", "$Runpaired.txt", "$Rkept.txt"] {
            std::fs::remove_file(root.join(name)).unwrap();
        }
        std::fs::remove_dir(&root).unwrap();
        assert!(paired_payloads(&root).is_err());
    }
}
