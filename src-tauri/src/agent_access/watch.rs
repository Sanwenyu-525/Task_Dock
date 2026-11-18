//! 工作空间轮询监听。
//!
//! 不使用 `notify` 之类的递归 watcher：Windows 上自身写入也会触发事件，容易形成回环。
//! 这里按固定间隔（默认 20s）扫描受控导入目录，配合 `exported_hash` 与 `_imported/`
//! 归档实现「自身写入判定 + 幂等导入」。线程可取消、有上限、失败只记事件不再重试。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::db::Db;
use crate::error::AppResult;

use super::{sync, workspace, Principal, Source, DEFAULT_WATCH_SECS};

struct Handle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

fn slot() -> &'static Mutex<Option<Handle>> {
    static SLOT: OnceLock<Mutex<Option<Handle>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

pub fn running() -> bool {
    slot().lock().map(|g| g.is_some()).unwrap_or(false)
}

/// 启动监听（幂等）。真正的开关在 `agent_workspaces.watch_enabled`，本函数只负责线程。
pub fn start(db: Arc<Db>) -> AppResult<()> {
    let mut guard = slot()
        .lock()
        .map_err(|_| crate::error::AppError::Unavailable("监听锁不可用".into()))?;
    if guard.is_some() {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let join = thread::Builder::new()
        .name("taskdock-agent-watch".into())
        .spawn(move || {
            let mut ticks: u32 = 0;
            while !stop_flag.load(Ordering::Relaxed) {
                // 1s 粒度检查停止标记，保证退出及时。
                for _ in 0..DEFAULT_WATCH_SECS {
                    if stop_flag.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
                ticks = ticks.wrapping_add(1);
                let Ok(Some(row)) = workspace::active(&db) else {
                    continue;
                };
                if !row.watch_enabled {
                    continue;
                }
                let principal = Principal::local(Source::File);
                if let Err(err) = sync::scan(&db, &principal, &row) {
                    workspace::log_event(
                        &db,
                        &row.id,
                        "scan",
                        "watch_error",
                        "",
                        "workspace",
                        &row.workspace_id,
                        "failed",
                        &err.user_message(),
                        None,
                        "",
                    );
                }
                // 每小时清理一次过期缓存/事件，避免无限增长。
                if ticks % 180 == 0 {
                    let _ = super::store::prune(&db);
                }
            }
        })
        .map_err(crate::error::AppError::from)?;
    *guard = Some(Handle {
        stop,
        join: Some(join),
    });
    Ok(())
}

/// 停止监听（幂等）。等待线程退出，最多 3 秒，超时不强杀（其内部 1s 粒度会自行退出）。
pub fn stop() {
    let handle = slot().lock().ok().and_then(|mut g| g.take());
    if let Some(mut handle) = handle {
        handle.stop.store(true, Ordering::Relaxed);
        if let Some(join) = handle.join.take() {
            let _ = join.join();
        }
    }
}

/// 根据工作空间设置同步监听状态（初始化/改设置后调用）。
pub fn apply(db: Arc<Db>, enabled: bool) -> AppResult<()> {
    if enabled {
        start(db)
    } else {
        stop();
        Ok(())
    }
}
