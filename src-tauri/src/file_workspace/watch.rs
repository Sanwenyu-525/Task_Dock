//! 目录变更监听（Windows `ReadDirectoryChangesW`）。
//!
//! 为什么需要它：`dir_signature` 只读目录自身的 `mtime`，**外部程序原地改写文件内容
//! 不会改变父目录的 mtime**（大小、修改时间都只落在文件上），前端轮询因此看不到变化。
//! 目录条目新增/删除/改名才会动父目录时间戳，这正好是「外部应用保存/覆盖」场景的盲区。
//!
//! 设计约束（与 P1 要求逐条对应）：
//! - **不按 Tab 起线程**：注册表按规范化路径去重，同一目录多个分栏共用一个监听线程；
//! - **有并发上限**：超过 `MAX_WATCHERS` 时 `touch` 返回 false，前端退回轮询（不排队、
//!   不阻塞调用方）；
//! - **生命周期随「有人还在问」**：每轮 `fs_dir_signature`（可见分栏的轮询入口）刷新
//!   `last_touch`；`IDLE_TTL_MS` 内无人问就自行退出并释放句柄与事件；
//! - **统一退订**：只有一个退出路径（线程自己收尾），不依赖调用方成对调用；
//! - **失败不放大**：打开目录失败、API 失败只退化为「没有事件」，轮询仍在工作。
//!
//! 事件只表示「这个目录可能变了」，前端收到后整体重载目录；不做增量、不猜测具体条目。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

/// 目录内容变化事件（前端 `dirCache` 唯一订阅点）。
pub const EVENT_DIR_CHANGED: &str = "fs-dir-changed";
/// 同时存活的最大监听数：超出后由轮询兜底（每分栏一个监听在 6 分栏时可轻易破百）。
pub const MAX_WATCHERS: usize = 48;
/// 超过这个时间没有 `touch` 就退出：可见分栏每 4s 轮询一次，90s 足够容忍短暂卡顿。
pub const IDLE_TTL_MS: u64 = 90_000;

struct Watcher {
    last_touch: Arc<AtomicU64>,
}

fn registry() -> &'static Mutex<HashMap<String, Watcher>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Watcher>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 注册表键：小写 + 去掉尾部路径分隔符（Windows 路径大小写不敏感）。
pub(crate) fn normalize_key(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        path.to_lowercase()
    } else {
        trimmed.to_lowercase()
    }
}

/// 还能不能再开一个监听（纯函数，便于单测覆盖上限语义）。
pub(crate) fn watcher_budget_available(current: usize) -> bool {
    current < MAX_WATCHERS
}

/// 是否已经闲置超过 TTL（纯函数）。
pub(crate) fn is_idle(last_touch_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(last_touch_ms) >= IDLE_TTL_MS
}

/// 让某个目录的监听继续存活（不存在则在预算内新建）。
///
/// 返回 `true` 表示当前有监听在工作；`false` 表示退回轮询（预算用尽或平台不支持）。
pub fn touch(app: &AppHandle, path: &Path) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let display = path.to_string_lossy().into_owned();
    let key = normalize_key(&display);
    if key.is_empty() {
        return false;
    }
    // 只监听目录：文件路径直接退回轮询，不为打不开的句柄起线程。
    if !path.is_dir() {
        return false;
    }
    let now = now_ms();
    // 新建线程所需的数据在锁内准备好；线程启动放到锁外，避免持锁做系统调用。
    let spawn = {
        let mut map = match registry().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(existing) = map.get(&key) {
            existing.last_touch.store(now, Ordering::Relaxed);
            return true;
        }
        if !watcher_budget_available(map.len()) {
            return false;
        }
        let last_touch = Arc::new(AtomicU64::new(now));
        map.insert(key.clone(), Watcher {
            last_touch: Arc::clone(&last_touch),
        });
        (last_touch, display)
    };
    let (last_touch, display) = spawn;
    let app = app.clone();
    let dir = path.to_path_buf();
    let thread_key = key.clone();
    let fallback_key = key.clone();
    let fallback_touch = Arc::clone(&last_touch);
    std::thread::Builder::new()
        .name("fw-dir-watch".to_string())
        .spawn(move || {
            run(&app, &display, &dir, &last_touch);
            release(&thread_key, &last_touch);
        })
        .map(|_| true)
        .unwrap_or_else(|_| {
            // 线程都建不出来：撤掉登记，退回轮询（不能让注册表留下永不更新的僵尸项）。
            release(&fallback_key, &fallback_touch);
            false
        })
}

fn release(key: &str, last_touch: &Arc<AtomicU64>) {
    let mut map = match registry().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    // 只删自己那一份：同一路径可能已经被新一轮 touch 重新登记（旧线程收尾很慢时）。
    let same = map
        .get(key)
        .map(|entry| Arc::ptr_eq(&entry.last_touch, last_touch))
        .unwrap_or(false);
    if same {
        map.remove(key);
    }
}

/// 诊断用：当前存活监听数。
pub fn active_watchers() -> usize {
    registry()
        .lock()
        .map(|map| map.len())
        .unwrap_or_else(|poisoned| poisoned.into_inner().len())
}

#[cfg(windows)]
fn run(app: &AppHandle, display: &str, dir: &Path, last_touch: &AtomicU64) {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED,
        FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_CREATION,
        FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
        FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject};

    const BUFFER_BYTES: usize = 16 * 1024;
    const FILTER: u32 = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_DIR_NAME
        | FILE_NOTIFY_CHANGE_LAST_WRITE
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_CREATION
        | FILE_NOTIFY_CHANGE_ATTRIBUTES;
    /// 等待窗口：到期只用来复查 TTL，不会取消已挂起的读。
    const WAIT_SLICE_MS: u32 = 2_000;

    let wide = |path: &Path| -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let dir_wide = wide(dir);
    // 目录句柄必须带 FILE_FLAG_BACKUP_SEMANTICS 才能打开目录。
    let handle = unsafe {
        CreateFileW(
            dir_wide.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return;
    }
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        unsafe { CloseHandle(handle) };
        return;
    }

    let mut buffer = vec![0u8; BUFFER_BYTES];
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.hEvent = event;
    let mut last_emit = 0u64;

    'watch: loop {
        if is_idle(last_touch.load(Ordering::Relaxed), now_ms()) {
            break;
        }
        unsafe { ResetEvent(event) };
        let started = unsafe {
            ReadDirectoryChangesW(
                handle,
                buffer.as_mut_ptr().cast::<c_void>(),
                buffer.len() as u32,
                0,
                FILTER,
                std::ptr::null_mut(),
                &mut overlapped,
                None,
            )
        };
        if started == 0 {
            // 句柄失效（目录被删/卷卸载）：退出，前端轮询会发现 DIR_MISSING。
            break;
        }
        loop {
            match unsafe { WaitForSingleObject(event, WAIT_SLICE_MS) } {
                WAIT_OBJECT_0 => break,
                WAIT_TIMEOUT => {
                    if is_idle(last_touch.load(Ordering::Relaxed), now_ms()) {
                        // 撤销挂起的读，等它真正完成后再关句柄（否则关句柄可能卡住）。
                        unsafe { CancelIoEx(handle, &overlapped) };
                        unsafe { WaitForSingleObject(event, WAIT_SLICE_MS) };
                        break 'watch;
                    }
                }
                _ => break 'watch,
            }
        }
        let mut transferred = 0u32;
        let ok = unsafe { GetOverlappedResult(handle, &overlapped, &mut transferred, 0) };
        if ok == 0 {
            // 目录被删除/卷卸载后读会失败：退出，交给轮询的 DIR_MISSING 判定。
            break;
        }
        if transferred == 0 {
            continue;
        }
        let now = now_ms();
        // 合并抖动：同一批写入常常连续触发多次，200ms 内只广播一次。
        if now.saturating_sub(last_emit) >= 200 {
            last_emit = now;
            let _ = app.emit(
                EVENT_DIR_CHANGED,
                serde_json::json!({ "path": display, "at": now }),
            );
        }
    }

    unsafe {
        CloseHandle(event);
        CloseHandle(handle);
    }
}

#[cfg(not(windows))]
fn run(_app: &AppHandle, _display: &str, _dir: &Path, _last_touch: &AtomicU64) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_case_insensitive_and_trailing_separator_free() {
        assert_eq!(normalize_key(r"D:\Work\Docs\"), r"d:\work\docs");
        assert_eq!(normalize_key(r"d:\work\docs"), r"d:\work\docs");
        assert_eq!(normalize_key(r"\\server\share\"), r"\\server\share");
    }

    #[test]
    fn budget_refuses_after_cap() {
        assert!(watcher_budget_available(0));
        assert!(watcher_budget_available(MAX_WATCHERS - 1));
        assert!(!watcher_budget_available(MAX_WATCHERS));
        assert!(!watcher_budget_available(MAX_WATCHERS + 3));
    }

    #[test]
    fn idle_is_strictly_ttl_based() {
        let now = 1_000_000u64;
        assert!(!is_idle(now - IDLE_TTL_MS + 1, now));
        assert!(is_idle(now - IDLE_TTL_MS, now));
        assert!(is_idle(0, now));
    }
}
