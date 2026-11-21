//! Windows 回收站索引引擎（持久化缓存 + 增量同步）。
//!
//! ## 数据来源与承诺
//! - 界面打开时的统计与列表**只来自本地索引**（SQLite），毫秒级返回，
//!   不等待任何 Shell 枚举；
//! - 后台按需同步：枚举 `$I` 文件名与 `$R` 存在性（一遍目录遍历），只读取
//!   新增/变化 `$I` 的头部，绝不读取 80GB 文件内容、绝不递归 `$R` 目录树；
//! - 系统口径（`SHQueryRecycleBinW`）在 10 万级项目时本身需要数十秒，因此
//!   **不放在打开路径**，只作为可选的后台校验（见 `volume::system_totals`）；
//! - 索引只是缓存：损坏/丢失可以重建，绝不影响真实回收站数据。

pub mod index;
pub mod meta;
pub mod ops;
pub mod scan;
pub mod volume;

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::Db;
use crate::error::AppResult;

/// 同步进度事件（每个卷、每个批次）。
pub const SYNC_EVENT: &str = "recycle:sync-progress";
/// 同步完成事件（含每个卷的结果摘要）。
pub const SYNC_DONE_EVENT: &str = "recycle:sync-done";

/// 非强制同步的最小间隔：视图轮询/重复打开时避免反复扫描。
const SYNC_THROTTLE_MS: i64 = 8_000;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub running: bool,
    pub started_ms: i64,
    pub finished_ms: i64,
    /// 本轮已完成的卷数 / 总卷数
    pub volumes_done: usize,
    pub volumes_total: usize,
    pub cancel_requested: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub volume: String,
    pub state: String,
    pub items: i64,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub duration_ms: u64,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub started_ms: i64,
    pub finished_ms: i64,
    pub duration_ms: u64,
    pub cancelled: bool,
    pub volumes: Vec<SyncOutcome>,
    pub error: Option<String>,
}

/// 应用级回收站服务：索引查询 + 后台同步协调。
pub struct RecycleService {
    db: Arc<Db>,
    running: AtomicBool,
    cancel: AtomicBool,
    last_start_ms: AtomicI64,
    last_finish_ms: AtomicI64,
    status: Mutex<SyncStatus>,
    cache_gate: Mutex<()>,
    /// 扫描进行中又被请求「重新对账」：不在扫描期间并发启动第二个扫描，
    /// 只登记标记，由当前扫描收尾后补跑一次。
    follow_up: AtomicBool,
}

/// 同步准入结果。三种情况必须分开：`Throttled` 不是「已经在跑」，
/// 不能因此登记补扫，否则每次节流都会多扫一遍。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncAdmission {
    Admitted,
    Running,
    Throttled,
}

/// 需要重新对账的一卷：`bin_root` 含用户 SID，只在本模块内部使用，不外发。
#[derive(Debug)]
pub struct ReconcileTarget {
    pub bin_root: String,
    pub volume: String,
    pub code: String,
}

impl RecycleService {
    pub fn new(db: Arc<Db>) -> Arc<Self> {
        Arc::new(Self {
            db,
            running: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            last_start_ms: AtomicI64::new(0),
            last_finish_ms: AtomicI64::new(0),
            status: Mutex::new(SyncStatus::default()),
            cache_gate: Mutex::new(()),
            follow_up: AtomicBool::new(false),
        })
    }

    pub fn db(&self) -> &Arc<Db> {
        &self.db
    }

    pub fn stats(&self) -> AppResult<index::RecycleStats> {
        self.db.with_read(index::stats)
    }

    pub fn page(&self, query: &index::RecycleQuery) -> AppResult<index::RecyclePage> {
        self.db.with_read(|conn| index::page(conn, query))
    }

    pub fn reconcile_empty(&self, volume: &volume::BinVolume) -> AppResult<()> {
        let _gate = self.cache_gate.lock().unwrap_or_else(|e| e.into_inner());
        let conn = self.db.open_worker_connection()?;
        scan::reconcile_empty(&conn, volume)
    }

    /// 把若干卷标记为「缓存不可信，需要重新对账」。
    ///
    /// 只改状态、不删缓存：离线或损坏时仍要可浏览，但统计会如实呈现为 `stale`，
    /// 不再冒充最新数据。返回成功标记的卷数。
    pub fn mark_reconcile(&self, targets: &[ReconcileTarget]) -> usize {
        let mut marked = 0;
        for target in targets {
            if self
                .db
                .with_conn(|conn| {
                    index::mark_reconcile_required(
                        conn,
                        &target.bin_root,
                        &target.volume,
                        &target.code,
                    )
                })
                .is_ok()
            {
                marked += 1;
            }
        }
        marked
    }

    /// 标记需要重新对账并请求尽快同步。
    ///
    /// 已有扫描在运行时不会并发启动第二个扫描，而是登记「收尾后补扫」，
    /// 保证本轮扫描结束后待对账卷最终得到一次**有效**同步。
    pub fn request_reconcile(self: &Arc<Self>, app: &AppHandle, targets: &[ReconcileTarget]) -> usize {
        let marked = self.mark_reconcile(targets);
        if marked > 0 {
            let _ = self.start_sync(app, true);
        }
        marked
    }

    /// 请求一次强制同步（等价于用户点「同步」）。
    pub fn request_resync(self: &Arc<Self>, app: &AppHandle) -> SyncStatus {
        self.start_sync(app, true)
    }
    pub fn sync_status(&self) -> SyncStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn cancel_sync(&self) {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        if self.running.load(Ordering::Relaxed) {
            self.cancel.store(true, Ordering::SeqCst);
            status.cancel_requested = true;
        }
    }

    /// 准入、取消和收尾共用状态锁，避免重复扫描及旧一轮收尾覆盖新一轮。
    fn reserve_sync(&self, force: bool, now: i64) -> SyncAdmission {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        let last_activity = self.last_start_ms.load(Ordering::Relaxed)
            .max(self.last_finish_ms.load(Ordering::Relaxed));
        if self.running.load(Ordering::Relaxed) {
            return SyncAdmission::Running;
        }
        if !force && now - last_activity < SYNC_THROTTLE_MS {
            return SyncAdmission::Throttled;
        }
        *status = SyncStatus { running: true, started_ms: now, ..SyncStatus::default() };
        self.cancel.store(false, Ordering::SeqCst);
        self.last_start_ms.store(now, Ordering::SeqCst);
        self.running.store(true, Ordering::SeqCst);
        SyncAdmission::Admitted
    }

    fn finish_sync(&self, finished_ms: i64, error: Option<String>) {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        status.running = false;
        status.finished_ms = finished_ms;
        status.cancel_requested = false;
        status.last_error = error;
        self.cancel.store(false, Ordering::SeqCst);
        self.last_finish_ms.store(finished_ms, Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
    }

    /// 启动后台同步。`force=false` 时按 8 秒节流并跳过正在运行的任务。
    ///
    /// 节流的基准是「上一次同步**结束**的时间」，不是开始时间：
    /// 一次 5 分钟的大扫描结束后立刻重开视图，不应该马上再扫一遍。
    /// 扫描进行中由 `running` 拦截，因此 `max(start, finish)` 即最近一次活动时间。
    pub fn start_sync(self: &Arc<Self>, app: &AppHandle, force: bool) -> SyncStatus {
        let now = chrono::Utc::now().timestamp_millis();
        // 存在「索引写入失败/清空未核实」的卷时绕过节流：缓存已知不可信，
        // 必须尽快按真实 `$I`/`$R` 重新对账，而不是继续展示旧结果。
        let reconcile_pending = self
            .db
            .with_read(index::pending_reconcile)
            .map(|volumes| !volumes.is_empty())
            .unwrap_or(false);
        let urgent = force || reconcile_pending;
        match self.reserve_sync(urgent, now) {
            SyncAdmission::Admitted => self.spawn_sync(app),
            SyncAdmission::Throttled => self.sync_status(),
            SyncAdmission::Running => {
                // 已有扫描在跑：绝不并发启动第二个（否则旧快照会覆盖新状态）。
                // 只登记「收尾后补扫」，让待对账卷在本轮结束后得到一次有效同步。
                if urgent {
                    self.follow_up.store(true, Ordering::SeqCst);
                }
                self.sync_status()
            }
        }
    }

    /// 准入已通过后真正启动扫描线程。调用方必须已持有 `running` 标记。
    fn spawn_sync(self: &Arc<Self>, app: &AppHandle) -> SyncStatus {
        let volumes = match volume::bin_volumes() {
            Ok(volumes) => volumes,
            Err((code, message)) => {
                self.finish_sync(chrono::Utc::now().timestamp_millis(), Some(format!("{code}: {message}")));
                return self.sync_status();
            }
        };
        let known = volume::known_bin_volumes();
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        status.volumes_total = volumes.len();
        drop(status);

        let service = self.clone();
        let app = app.clone();
        let spawn = std::thread::Builder::new()
            .name("recycle-sync".into())
            .spawn(move || service.run_sync(app, volumes, known));
        if let Err(e) = spawn {
            self.finish_sync(chrono::Utc::now().timestamp_millis(), Some(format!("无法启动同步线程: {e}")));
            return self.sync_status();
        }
        self.sync_status()
    }

    #[cfg(test)]
    fn take_follow_up(&self) -> bool {
        self.follow_up.swap(false, Ordering::SeqCst)
    }

    fn run_sync(
        self: Arc<Self>,
        app: AppHandle,
        volumes: Vec<volume::BinVolume>,
        known: Vec<volume::BinVolume>,
    ) {
        let started = std::time::Instant::now();
        let started_ms = chrono::Utc::now().timestamp_millis();
        let mut outcomes: Vec<SyncOutcome> = Vec::new();
        let mut cancelled = false;
        let mut error: Option<String> = None;

        // 已知但当前不可访问的卷：标记离线，保留缓存（绝不删除索引）。
        if let Ok(conn) = self.db.open_worker_connection() {
            for vol in &known {
                if vol.root.is_dir() {
                    continue;
                }
                let bin_root = vol.root.to_string_lossy().into_owned();
                let _ = index::set_state(
                    &conn,
                    &bin_root,
                    &vol.volume,
                    "offline",
                    0,
                    0,
                    0,
                    Some("OFFLINE"),
                    chrono::Utc::now().timestamp_millis(),
                );
            }
            for vol in &volumes {
                let _gate = self.cache_gate.lock().unwrap_or_else(|e| e.into_inner());
                let result = scan::scan_volume(&conn, vol, &self.cancel, &|progress| {
                    let _ = app.emit(SYNC_EVENT, progress);
                });
                match result {
                    Ok(outcome) => {
                        outcomes.push(SyncOutcome {
                            volume: outcome.volume,
                            state: outcome.state,
                            items: outcome.items,
                            added: outcome.added,
                            updated: outcome.updated,
                            removed: outcome.removed,
                            duration_ms: outcome.duration_ms,
                            error_code: outcome.error_code,
                        });
                    }
                    Err(e) => {
                        let bin_root = vol.root.to_string_lossy().into_owned();
                        let _ = index::set_state(
                            &conn,
                            &bin_root,
                            &vol.volume,
                            "error",
                            0,
                            0,
                            0,
                            Some(e.code()),
                            chrono::Utc::now().timestamp_millis(),
                        );
                        outcomes.push(SyncOutcome {
                            volume: vol.volume.clone(),
                            state: "error".into(),
                            items: 0,
                            added: 0,
                            updated: 0,
                            removed: 0,
                            duration_ms: 0,
                            error_code: Some(e.code().to_string()),
                        });
                        error = Some(e.to_string());
                    }
                }
                if self.cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
                let done = outcomes.len();
                let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
                status.volumes_done = done;
                status.cancel_requested = self.cancel.load(Ordering::SeqCst);
            }
        } else {
            error = Some("无法打开索引数据库连接".into());
        }

        let summary = SyncSummary {
            started_ms,
            finished_ms: chrono::Utc::now().timestamp_millis(),
            duration_ms: started.elapsed().as_millis() as u64,
            cancelled,
            volumes: outcomes,
            error,
        };
        {
            let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
            status.volumes_done = summary.volumes.len();
        }
        self.finish_sync(summary.finished_ms, summary.error.clone());
        let _ = app.emit(SYNC_DONE_EVENT, summary.clone());
        // 诊断只记聚合数字，不写任何回收站内部路径或用户名。
        let level = if summary.error.is_some() {
            crate::diagnostics::DiagLevel::Warn
        } else {
            crate::diagnostics::DiagLevel::Info
        };
        crate::diagnostics::event(level, "recycle", "sync", "sync_completed")
            .status(if summary.error.is_some() {
                crate::diagnostics::DiagStatus::Failed
            } else if summary.cancelled {
                crate::diagnostics::DiagStatus::Cancelled
            } else {
                crate::diagnostics::DiagStatus::Success
            })
            .duration_ms(summary.duration_ms)
            .metadata("volumes", serde_json::json!(summary.volumes.len()))
            .metadata(
                "items",
                serde_json::json!(summary.volumes.iter().map(|v| v.items).sum::<i64>()),
            )
            .metadata(
                "added",
                serde_json::json!(summary.volumes.iter().map(|v| v.added).sum::<usize>()),
            )
            .metadata(
                "removed",
                serde_json::json!(summary.volumes.iter().map(|v| v.removed).sum::<usize>()),
            )
            .emit();

        // 本轮扫描期间有人请求「重新对账」：已收尾，补跑一次，保证待对账卷在
        // **本轮扫描结束之后**得到一次有效同步。标志位只取一次，不形成轮询或重试环。
        if self.follow_up.swap(false, Ordering::SeqCst) {
            let still_pending = self
                .db
                .with_read(index::pending_reconcile)
                .map(|volumes| !volumes.is_empty())
                .unwrap_or(false);
            if still_pending {
                let _ = self.start_sync(&app, true);
            }
        }
    }
}

/// 普通文件删除落入回收站后，把涉及卷标记为「缓存不可信」并请求一次同步。
///
/// 为什么必须由删除方触发：`fsops::start_delete` 走 Shell 回收站操作，只写
/// fsops 任务结果，不碰 `recycle_index`。索引是 SQLite **派生缓存**，不失效就会
/// 继续用删除前的条目数回答资源面板「回收站占用」，直到用户恰好打开回收站视图
/// 触发一次同步（最长可陈旧 10 分钟，见 `recycle_plan_from_stats` 的新鲜度窗口）。
///
/// 合并语义完全复用既有机制，不新增调度：
/// - 同卷多次删除：`mark_reconcile_required` 是 `ON CONFLICT DO UPDATE`，重复标记幂等；
/// - 一次任务删多个卷：先去重再标记，只请求一次同步；
/// - 扫描进行中：`start_sync` 只登记 `follow_up`，由当前扫描收尾后补跑一次。
/// 因此这里既不会每个文件触发一次扫描，也不会与正在跑的扫描并发。
///
/// 返回成功标记的卷数（0 表示没有可标记的卷，例如网络共享或卷根不存在）。
pub fn note_deleted_paths(
    app: &AppHandle,
    service: &Arc<RecycleService>,
    paths: &[String],
) -> usize {
    let targets = targets_for(paths, volume::bin_root_for_drive);
    if targets.is_empty() {
        return 0;
    }
    let marked = service.mark_reconcile(&targets);
    if marked > 0 {
        // force=false：让 `pending_reconcile` 决定是否绕过 8s 节流；
        // 正在扫描时只会置 follow_up，不会并发第二个扫描。
        let _ = service.start_sync(app, false);
    }
    marked
}

/// 路径列表 → 去重后的待对账卷。`resolve` 注入可替换的 bin_root 解析，便于单测。
///
/// 不在这里判断「是否真的进了回收站」：调用方只在**有成功删除项**时才调用，
/// 多标记一卷最多多一次扫描，漏标记才会让统计长期偏小。
fn targets_for(
    paths: &[String],
    resolve: impl Fn(&str) -> Option<std::path::PathBuf>,
) -> Vec<ReconcileTarget> {
    let mut by_root: std::collections::HashMap<String, ReconcileTarget> =
        std::collections::HashMap::new();
    for raw in paths {
        let volume = volume::volume_label_of_path(raw);
        if volume.is_empty() {
            continue;
        }
        let drive_root = volume::drive_root_of(&volume);
        let Some(bin_root) = resolve(&drive_root) else {
            continue;
        };
        let key = bin_root.to_string_lossy().into_owned();
        by_root.entry(key.clone()).or_insert(ReconcileTarget {
            bin_root: key,
            volume,
            code: "FS_DELETE".to_string(),
        });
    }
    by_root.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_continuation_sync_admission_is_exclusive() {
        let service = RecycleService::new(Arc::new(Db::open_in_memory().unwrap()));
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|_| {
            let service = service.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                service.reserve_sync(true, 100_000)
            })
        }).collect();
        let admitted = threads.into_iter()
            .map(|t| usize::from(t.join().unwrap() == SyncAdmission::Admitted))
            .sum::<usize>();
        assert_eq!(admitted, 1);
        service.cancel_sync();
        assert!(service.sync_status().cancel_requested);
        assert_eq!(service.reserve_sync(true, 100_001), SyncAdmission::Running);
        assert!(service.sync_status().cancel_requested);
        service.finish_sync(200_000, None);
        assert_eq!(service.reserve_sync(false, 200_001), SyncAdmission::Throttled);
        assert_eq!(service.reserve_sync(false, 208_000), SyncAdmission::Admitted);
        assert!(!service.sync_status().cancel_requested);
    }

    /// 扫描中请求对账：不得并发启动第二个扫描，但要留下「收尾后补扫」标记。
    #[test]
    fn reconcile_request_during_running_scan_defers_instead_of_racing() {
        let service = RecycleService::new(Arc::new(Db::open_in_memory().unwrap()));
        assert_eq!(service.reserve_sync(true, 10_000), SyncAdmission::Admitted);
        let marked = service.mark_reconcile(&[ReconcileTarget {
            bin_root: r"D:\$Recycle.Bin\S-1".into(),
            volume: "D:".into(),
            code: "EMPTY_CANCELLED_AFTER_START".into(),
        }]);
        assert_eq!(marked, 1, "标记 stale 必须真实落库");
        // 已有扫描在跑：本次不启动新扫描，只登记补扫。
        assert_eq!(service.reserve_sync(true, 10_001), SyncAdmission::Running);
        service.follow_up.store(true, Ordering::SeqCst);
        assert!(service.take_follow_up(), "补扫标记必须可被取走");
        assert!(!service.take_follow_up(), "补扫只执行一次，不形成轮询环");
        let pending = service.db.with_read(index::pending_reconcile).unwrap();
        assert_eq!(pending, vec![r"D:\$Recycle.Bin\S-1".to_string()]);
        service.finish_sync(20_000, None);
        assert_eq!(service.reserve_sync(true, 20_001), SyncAdmission::Admitted);
    }

    /// 节流拒绝不等于「已在运行」：不得因为节流登记补扫（否则每次节流都多扫一遍）。
    #[test]
    fn throttled_admission_does_not_schedule_follow_up() {
        let service = RecycleService::new(Arc::new(Db::open_in_memory().unwrap()));
        assert_eq!(service.reserve_sync(true, 5_000), SyncAdmission::Admitted);
        service.finish_sync(6_000, None);
        assert_eq!(service.reserve_sync(false, 7_000), SyncAdmission::Throttled);
        assert!(!service.take_follow_up());
    }

    /// 清空后标记 stale：统计必须呈现为「不完整」，不能继续冒充最新。
    #[test]
    fn stale_volume_after_cancelled_empty_is_not_reported_as_fresh() {
        let service = RecycleService::new(Arc::new(Db::open_in_memory().unwrap()));
        let marked = service.mark_reconcile(&[ReconcileTarget {
            bin_root: r"D:\$Recycle.Bin\S-1".into(),
            volume: "D:".into(),
            code: "EMPTY_UNVERIFIED".into(),
        }]);
        assert_eq!(marked, 1);
        let stats = service.stats().unwrap();
        assert_eq!(stats.state, "partial");
        assert_eq!(stats.volumes[0].state, "stale");
        assert_eq!(stats.volumes[0].error_code.as_deref(), Some("EMPTY_UNVERIFIED"));
        assert_eq!(stats.indexed_at_ms, 0, "stale 卷不得带「最新同步时间」");
    }

    #[test]
    fn sync_status_defaults_to_idle() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let service = RecycleService::new(db);
        let status = service.sync_status();
        assert!(!status.running);
        assert_eq!(status.volumes_total, 0);
        assert!(!status.cancel_requested);
    }

    #[test]
    fn empty_stats_are_reported_as_empty() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let service = RecycleService::new(db);
        let stats = service.stats().unwrap();
        assert_eq!(stats.items, 0);
        assert_eq!(stats.state, "empty");
        assert_eq!(stats.source, "index");
    }

    /// 同卷多次删除只产生一个待对账卷：不能一个文件一次扫描。
    #[test]
    fn deleted_paths_of_one_volume_collapse_into_one_target() {
        let paths = vec![
            r"D:\work\a.txt".to_string(),
            r"D:\work\sub\b.txt".to_string(),
            r"d:\other\c.bin".to_string(),
        ];
        let targets = targets_for(&paths, |drive| {
            assert_eq!(drive, r"D:\", "必须先归一成盘符根再解析 bin_root");
            Some(std::path::PathBuf::from(r"D:\$Recycle.Bin\S-1-5-21-9"))
        });
        assert_eq!(targets.len(), 1, "{targets:?}");
        assert_eq!(targets[0].volume, "D:");
        assert_eq!(targets[0].code, "FS_DELETE");
    }

    /// 跨卷删除各自标记，卷名不得串台。
    #[test]
    fn deleted_paths_on_multiple_volumes_are_marked_separately() {
        let paths = vec![
            r"C:\tmp\a.txt".to_string(),
            r"D:\tmp\b.txt".to_string(),
        ];
        let targets = targets_for(&paths, |drive| {
            Some(std::path::PathBuf::from(format!(
                "{}$Recycle.Bin\\S-1",
                drive
            )))
        });
        assert_eq!(targets.len(), 2, "{targets:?}");
        let mut volumes: Vec<_> = targets.iter().map(|t| t.volume.as_str()).collect();
        volumes.sort_unstable();
        assert_eq!(volumes, vec!["C:", "D:"]);
    }

    /// 解析不到 bin_root（网络共享 / 卷根不存在）时跳过：不伪造一个假卷去扫描。
    #[test]
    fn unresolved_volumes_are_skipped() {
        let paths = vec![r"\\server\share\dir\a.txt".to_string(), "relative.txt".to_string()];
        let targets = targets_for(&paths, |_| None);
        assert!(targets.is_empty(), "{targets:?}");
    }
}
