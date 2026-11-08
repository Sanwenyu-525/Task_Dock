//! 只读卷容量采样：枚举本机全部逻辑卷（本地 / 可移动 / 网络 / 光驱 / 内存盘）。
//!
//! 设计边界：
//! - 只读：仅调用 `GetLogicalDrives` / `GetDriveTypeW` / `GetDiskFreeSpaceExW`；
//! - 每个卷 800ms 超时：断连的网络盘不会拖住整个资源快照，也不会让界面永久等待；
//! - 同一卷同时只允许一个探测线程（在途去重）：反复刷新不会因某个挂死的卷堆线程；
//! - 读不到的卷保留一条「暂无数据」记录（界面显示「暂不可用」），不伪造 0；
//! - 光驱没有媒体时直接跳过，不长期占位；
//! - 清理范围不因枚举所有卷而扩大：删除仍然只接受三类应用自有缓存。

use super::DiskSnapshot;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 单卷探测超时。网络盘正常响应通常远低于此值；超时按「暂不可用」处理。
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

// GetDriveTypeW 的返回值（Win32 稳定常量；windows-sys 将它们放在
// Win32_System_WindowsProgramming，为不新增依赖 feature 在此按官方数值定义）。
const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_FIXED: u32 = 3;
const DRIVE_REMOTE: u32 = 4;
const DRIVE_CDROM: u32 = 5;
const DRIVE_RAMDISK: u32 = 6;

struct VolumeProbe {
    /// None = 该盘符没有根目录/类型未知，不展示。
    kind: Option<&'static str>,
    total: Option<u64>,
    available: Option<u64>,
}

fn unknown_probe() -> VolumeProbe {
    VolumeProbe {
        kind: Some("unknown"),
        total: None,
        available: None,
    }
}

fn kind_for(drive_type: u32) -> Option<&'static str> {
    match drive_type {
        DRIVE_FIXED => Some("fixed"),
        DRIVE_REMOVABLE => Some("removable"),
        DRIVE_REMOTE => Some("remote"),
        DRIVE_CDROM => Some("optical"),
        DRIVE_RAMDISK => Some("ramdisk"),
        _ => None,
    }
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "fixed" => 0,
        "removable" => 1,
        "remote" => 2,
        "ramdisk" => 3,
        "optical" => 4,
        _ => 5,
    }
}

/// 数据目录所在卷（`C:` 或 UNC 前缀）；用于把它排在列表首位，而不是另造一份状态。
fn primary_volume(path: &Path) -> String {
    path.components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .unwrap_or_default()
}

/// `GetLogicalDrives` 的位图 → `["A:", "C:", ...]`（大写、稳定顺序）。
fn drive_roots_from_mask(mask: u32) -> Vec<String> {
    (0..26u8)
        .filter(|index| mask & (1u32 << index) != 0)
        .map(|index| format!("{}:", (b'A' + index) as char))
        .collect()
}

/// 稳定排序：数据目录所在卷优先，其次固定盘 → 可移动 → 网络 → 内存盘 → 光驱 → 未知，
/// 同类型按盘符。界面因此可以稳定地把 `disks[0]` 当作「系统盘」。
fn sort_volumes(items: &mut [DiskSnapshot], primary: &str) {
    items.sort_by(|left, right| {
        let left_primary = !primary.is_empty() && left.volume.eq_ignore_ascii_case(primary);
        let right_primary = !primary.is_empty() && right.volume.eq_ignore_ascii_case(primary);
        right_primary
            .cmp(&left_primary)
            .then_with(|| kind_rank(&left.kind).cmp(&kind_rank(&right.kind)))
            .then_with(|| {
                left.volume
                    .to_ascii_uppercase()
                    .cmp(&right.volume.to_ascii_uppercase())
            })
    });
}

/// 在途去重：同一个卷的探测线程未返回前，后续快照不再为它新建线程。
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn claim(volume: &str) -> bool {
    match in_flight().lock() {
        Ok(mut set) => set.insert(volume.to_ascii_uppercase()),
        Err(_) => false,
    }
}

fn release(volume: &str) {
    if let Ok(mut set) = in_flight().lock() {
        set.remove(&volume.to_ascii_uppercase());
    }
}

/// 采集所有卷。非 Windows 返回空列表（界面显示「暂无可读取的卷」）。
pub(super) fn collect(data_root: &Path) -> Vec<DiskSnapshot> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;

        let primary = primary_volume(data_root);
        let mask = unsafe { GetLogicalDrives() };
        let mut roots = drive_roots_from_mask(mask);
        // UNC/非常规数据目录：把它补进列表首位，保证主卷一定被采样。
        if !primary.is_empty() && !roots.iter().any(|root| root.eq_ignore_ascii_case(&primary)) {
            roots.insert(0, primary.clone());
        }

        let mut volumes = Vec::new();
        for root in roots {
            let probe = probe_with_timeout(&root);
            let Some(kind) = probe.kind else {
                continue;
            };
            // 无媒体的光驱：只有确实读到容量才展示，避免常驻一个空条目。
            if kind == "optical" && probe.total.is_none() {
                continue;
            }
            volumes.push(DiskSnapshot {
                volume: root,
                kind: kind.to_string(),
                total_bytes: probe.total,
                available_bytes: probe.available,
            });
        }
        sort_volumes(&mut volumes, &primary);
        volumes
    }

    #[cfg(not(windows))]
    {
        let _ = data_root;
        Vec::new()
    }
}

/// 本地固定/可移动盘的盘符列表（`["C:", "D:"]`）。光驱、网络盘、内存盘不参与。
/// 供回收站等「按卷处理」的功能复用，避免重复定义 GetDriveTypeW 的类型常量。
pub(super) fn local_drive_roots() -> Vec<String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

        let mask = unsafe { GetLogicalDrives() };
        drive_roots_from_mask(mask)
            .into_iter()
            .filter(|volume| {
                let root = format!("{volume}\\");
                let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
                matches!(
                    unsafe { GetDriveTypeW(wide.as_ptr()) },
                    DRIVE_FIXED | DRIVE_REMOVABLE
                )
            })
            .collect()
    }

    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// 带超时的单卷探测。超时/在途时返回「未知」，界面显示「暂不可用」。
fn probe_with_timeout(volume: &str) -> VolumeProbe {
    if !claim(volume) {
        return unknown_probe();
    }
    let (sender, receiver) = std::sync::mpsc::channel::<VolumeProbe>();
    let owned = volume.to_string();
    let spawned = std::thread::Builder::new()
        .name(format!("volume-probe-{volume}"))
        .spawn(move || {
            let probe = probe_blocking(&owned);
            // 接收方可能已超时退出：发送失败无需处理。
            let _ = sender.send(probe);
            release(&owned);
        });
    if spawned.is_err() {
        release(volume);
        return unknown_probe();
    }
    match receiver.recv_timeout(PROBE_TIMEOUT) {
        Ok(probe) => probe,
        Err(_) => unknown_probe(),
    }
}

#[cfg(windows)]
fn probe_blocking(volume: &str) -> VolumeProbe {
    use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW};

    let root = format!("{volume}\\");
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
    let Some(kind) = kind_for(drive_type) else {
        return VolumeProbe {
            kind: None,
            total: None,
            available: None,
        };
    };
    let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    VolumeProbe {
        kind: Some(kind),
        total: (ok != 0).then_some(total),
        available: (ok != 0).then_some(available),
    }
}

#[cfg(not(windows))]
fn probe_blocking(_volume: &str) -> VolumeProbe {
    VolumeProbe {
        kind: None,
        total: None,
        available: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(volume: &str, kind: &str) -> DiskSnapshot {
        DiskSnapshot {
            volume: volume.into(),
            kind: kind.into(),
            total_bytes: Some(100),
            available_bytes: Some(50),
        }
    }

    #[test]
    fn drive_mask_maps_to_uppercase_roots() {
        assert_eq!(drive_roots_from_mask(0b101), vec!["A:", "C:"]);
        assert_eq!(drive_roots_from_mask(1 << 3), vec!["D:"]);
        assert!(drive_roots_from_mask(0).is_empty());
    }

    #[test]
    fn unknown_drive_types_are_not_classified() {
        assert!(kind_for(0).is_none());
        assert!(kind_for(1).is_none());
        assert_eq!(kind_for(DRIVE_FIXED), Some("fixed"));
        assert_eq!(kind_for(DRIVE_REMOTE), Some("remote"));
    }

    #[test]
    fn sorting_prefers_primary_then_kind_then_letter() {
        let mut disks = vec![
            disk("E:", "remote"),
            disk("D:", "fixed"),
            disk("C:", "fixed"),
            disk("F:", "removable"),
        ];
        sort_volumes(&mut disks, "D:");
        assert_eq!(
            disks.iter().map(|item| item.volume.as_str()).collect::<Vec<_>>(),
            vec!["D:", "C:", "F:", "E:"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn live_probe_includes_the_data_volume_and_has_sane_shapes() {
        let root = std::env::temp_dir();
        let disks = collect(&root);
        assert!(!disks.is_empty(), "至少应读到数据目录所在卷");
        for item in &disks {
            assert_eq!(item.volume.len(), 2, "卷名应为盘符: {}", item.volume);
            assert!(item.volume.ends_with(':'));
            assert!(
                matches!(
                    item.kind.as_str(),
                    "fixed" | "removable" | "remote" | "ramdisk" | "optical" | "unknown"
                ),
                "未知卷类型 {}",
                item.kind
            );
        }
        let primary = primary_volume(&root);
        assert_eq!(disks[0].volume.to_ascii_uppercase(), primary.to_ascii_uppercase());
        assert!(disks.iter().any(|item| item.kind == "fixed"));
        assert!(disks.iter().any(|item| item.total_bytes.is_some()));
    }
}
