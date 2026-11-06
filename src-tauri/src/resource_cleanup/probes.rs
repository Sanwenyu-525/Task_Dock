//! 只读资源采样探针：系统内存、单进程指标与进程表枚举。
//!
//! 约束：
//! - 只在用户显式请求的 blocking worker 中调用，不注册后台线程或定时器；
//! - 只读取指标，绝不结束、挂起或修改任何进程；
//! - 不读取命令行，也不把可执行文件完整路径返回给前端（路径仅用于本地归属判定）；
//! - 读取失败统一返回 `None`，由上层呈现「暂不可用」，绝不以 0 冒充未知。

use std::path::PathBuf;

/// 单进程一次读数。CPU 时间为内核 + 用户态累计（100ns）。
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessMetrics {
    pub cpu_100ns: u64,
    pub working_set_bytes: u64,
    pub private_bytes: u64,
    /// 创建时间（Unix 秒）；读取失败时为 `None`。
    pub created_unix: Option<i64>,
}

/// 进程表一行（ToolHelp 快照）。父子关系只作关联线索，不作为所有权证明。
#[derive(Debug, Clone)]
pub struct RawProcess {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
}

/// 系统物理内存（总字节、可用字节）。
#[cfg(windows)]
pub fn system_memory() -> (Option<u64>, Option<u64>) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        return (None, None);
    }
    (Some(status.ullTotalPhys), Some(status.ullAvailPhys))
}

#[cfg(not(windows))]
pub fn system_memory() -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[cfg(windows)]
pub fn current_pid() -> u32 {
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    unsafe { GetCurrentProcessId() }
}

#[cfg(not(windows))]
pub fn current_pid() -> u32 {
    std::process::id()
}

/// 当前可执行文件名（不含路径），用于自身进程展示。
pub fn current_process_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_string()))
        .unwrap_or_else(|| "task-dock".into())
}

/// 读取单进程指标。`None` 表示无法打开/读取（退出、权限或受限进程）。
#[cfg(windows)]
pub fn process_metrics(pid: u32) -> Option<ProcessMetrics> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut creation: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let times_ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let mem_ok = GetProcessMemoryInfo(handle, &mut counters, counters.cb);
        CloseHandle(handle);
        if times_ok == 0 {
            return None;
        }
        let cpu_100ns =
            filetime_to_u64(kernel).saturating_add(filetime_to_u64(user));
        let created_unix = filetime_to_unix(filetime_to_u64(creation));
        Some(ProcessMetrics {
            cpu_100ns,
            working_set_bytes: if mem_ok != 0 { counters.WorkingSetSize as u64 } else { 0 },
            private_bytes: if mem_ok != 0 { counters.PagefileUsage as u64 } else { 0 },
            created_unix,
        })
    }
}

#[cfg(not(windows))]
pub fn process_metrics(_pid: u32) -> Option<ProcessMetrics> {
    None
}

/// 进程是否仍存在（用于区分「已退出」与「指标不可读」）。只查询存在性，不读内容。
#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(not(windows))]
pub fn process_alive(pid: u32) -> bool {
    pid != 0
}

/// 可执行文件路径（小写）。只用于归属判定，不返回给前端、不写日志。
#[cfg(windows)]
pub fn image_path(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 || size as usize > buf.len() {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..size as usize]).to_lowercase())
    }
}

#[cfg(not(windows))]
pub fn image_path(_pid: u32) -> Option<String> {
    None
}

/// 一次性进程表快照。条目数有硬上限，避免异常环境下的无界读取。
#[cfg(windows)]
pub fn enumerate_processes() -> Vec<RawProcess> {
    const MAX_ENTRIES: usize = 4096;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot as usize == usize::MAX {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|ch| *ch == 0)
                    .unwrap_or(entry.szExeFile.len());
                out.push(RawProcess {
                    pid: entry.th32ProcessID,
                    parent_pid: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..name_len]).to_lowercase(),
                });
                if out.len() >= MAX_ENTRIES || Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    out
}

#[cfg(not(windows))]
pub fn enumerate_processes() -> Vec<RawProcess> {
    Vec::new()
}

/// 构建期注入的工程目录（仅开发构建）。用于本地归属判定，绝不返回或记录。
pub fn project_root() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    option_env!("CARGO_MANIFEST_DIR").map(|dir| {
        std::path::Path::new(dir)
            .parent()
            .map(|parent| parent.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(dir))
    })
}

#[cfg(windows)]
fn filetime_to_u64(time: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64
}

#[cfg(windows)]
fn filetime_to_unix(time: u64) -> Option<i64> {
    /// 1601-01-01 到 1970-01-01 的 100ns 计数。
    const EPOCH_DIFF: u64 = 116_444_736_000_000_000;
    if time < EPOCH_DIFF {
        return None;
    }
    Some(((time - EPOCH_DIFF) / 10_000_000) as i64)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn self_metrics_are_readable() {
        let pid = current_pid();
        let metrics = process_metrics(pid).expect("当前进程指标应可读");
        assert!(metrics.working_set_bytes > 0);
        assert!(metrics.created_unix.is_some());
    }

    #[test]
    fn system_memory_is_plausible() {
        let (total, available) = system_memory();
        let total = total.expect("系统内存总量应可读");
        let available = available.expect("系统可用内存应可读");
        assert!(total > 0);
        assert!(available <= total);
    }

    #[test]
    fn process_table_contains_self() {
        let pid = current_pid();
        let table = enumerate_processes();
        assert!(table.iter().any(|process| process.pid == pid));
    }

    #[test]
    fn invalid_pid_is_reported_unavailable() {
        // 0 与不存在的高位 PID 都必须返回 None，而不是伪造 0 指标。
        assert!(process_metrics(0).is_none());
        assert!(!process_alive(0));
    }
}
