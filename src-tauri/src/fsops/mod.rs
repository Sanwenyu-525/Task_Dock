//! 统一文件操作服务（FileOperationService 的实现层）。
//!
//! 所有「批量、长耗时、可取消」的文件操作都在这里排队执行：
//! - `copy` / `move`：复用 [`crate::file_workspace::copy_paths`] /
//!   [`crate::file_workspace::move_paths`]；
//! - `delete` / `delete_permanent`：复用 [`crate::file_workspace::delete_paths`]
//!   （分批调用，不重复实现删除语义）；
//! - `restore` / `purge`：交给回收站原生层（`IFileOperation`），成功后更新索引；
//! - `empty`：逐卷 `SHEmptyRecycleBinW`，某卷失败不影响其他卷；
//! - 进度、成功/失败/跳过/部分完成计数、失败原因、取消：统一 `JobSnapshot`。
//!
//! ## 调度模型（2026-11 收敛）
//! - **固定工作线程池**（[`MAX_CONCURRENT_HEAVY`] 个 worker），不是「每个任务一个
//!   线程」：任务先进入 `pending`，被 worker 取走才变 `running`；
//! - 高 IO 操作受全局并发上限约束，轻量查询（列表/统计）根本不走任务队列；
//! - 队列有界（[`MAX_PENDING`]），满时显式拒绝而不是无限堆积；
//! - 取消：`pending` 直接终止；`running` 进入 `cancelling`，由任务在批次边界停止
//!   （已落地的不可逆操作无法回滚，文案必须如实说明）；复制/移动/重命名在顶层
//!   条目之间检查取消，当前单个文件/目录不能中途打断，取消不承诺立即结束。
//!
//! ## 约束
//! - 失败明细有界（最多 [`MAX_FAILURES`] 条），避免 4 万条失败把内存与事件载荷撑爆；
//! - 成功/失败逐条记录，单个条目失败不会中断整批；
//! - 任务只在进程内存在：应用退出后**不能恢复执行**，重启后注册表为空，
//!   不伪造「仍在运行」；
//! - `JobRegistry` 只淘汰**终态**任务；运行中的任务无论历史多长都不会被移除。

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::recycle::index as recycle_index;
use crate::recycle::ops::{self, NativeTarget, RestoreConflict};

/// 进度事件名（前端 `bridge.ts` 订阅同一常量）。
pub const JOB_EVENT: &str = "recycle:job-progress";

/// 每批交给文件工作区删除的条数（与其 `MAX_OP_PATHS` 一致）。
const DELETE_BATCH: usize = 500;
/// 回收站原生操作每批条数（Shell 队列一次提交，减少 COM 往返）。
const NATIVE_BATCH: usize = 40;
/// 失败明细上限。
const MAX_FAILURES: usize = 200;
/// 历史任务上限（只统计终态任务）。
const MAX_HISTORY: usize = 24;
/// 排队任务上限：超过时显式拒绝，避免无界堆积。
const MAX_PENDING: usize = 32;
/// 全局高 IO 并发上限（同时执行的批量文件任务数）。
const MAX_CONCURRENT_HEAVY: usize = 2;

/// 条目结果码：系统操作无法执行、本次**只从索引移除**（数据已不存在或元数据损坏）。
/// 不是失败，也绝不是「永久删除成功」——磁盘上的 `$I`/`$R` 没有被修改。
pub const RECYCLE_INDEX_ONLY: &str = "RECYCLE_INDEX_ONLY";

fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "partial" | "failed" | "cancelled")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEntryResult {
    /// 展示名（不写完整路径，避免诊断/事件载荷泄露用户目录）。
    pub label: String,
    /// ok | failed | skipped | partial
    pub status: String,
    pub code: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    /// copy | move | rename | delete | delete_permanent | restore | purge | empty
    pub kind: String,
    /// pending | running | cancelling | completed | partial | failed | cancelled
    pub status: String,
    pub total: usize,
    pub done: usize,
    pub ok: usize,
    pub failed: usize,
    /// 内容已落地但源未删除等「部分完成」条数。
    pub partial: usize,
    pub skipped: usize,
    /// queued | executing | verifying | done
    pub phase: String,
    pub cancelable: bool,
    pub cancel_requested: bool,
    /// 任务创建时间（含排队）。
    pub started_ms: i64,
    pub finished_ms: i64,
    /// 失败/跳过明细（有界）。
    pub failures: Vec<JobEntryResult>,
    pub message: Option<String>,
    /// 系统操作成功但索引写入失败的条数（已标记该卷需要重新对账）。
    pub index_pending: usize,
    /// 已处理字节数（只有需要读内容的阶段才有意义：哈希、复制；其余恒为 0）。
    ///
    /// 与 `done/total`（条目数）正交：大文件哈希时条目数长时间不变，只有字节数在动。
    pub bytes_done: u64,
    /// 本轮字节总量；0 表示本任务不提供字节进度。
    pub bytes_total: u64,
}

struct JobInner {
    snapshot: Mutex<JobSnapshot>,
    /// 完整路径只供按需 IPC 查询，不放入广播事件；最多 500 项，随任务历史淘汰。
    report: Mutex<Option<crate::file_workspace::FsOpReport>>,
    cancel: AtomicBool,
    executing_cancelable: bool,
    /// 终态通知：让同步等待方（资源清理面板）不必轮询。
    finished: Mutex<bool>,
    finished_signal: Condvar,
}

#[derive(Clone)]
pub struct JobHandle {
    inner: Arc<JobInner>,
}

impl JobHandle {
    pub fn report(&self) -> Option<crate::file_workspace::FsOpReport> {
        self.inner.report.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn snapshot(&self) -> JobSnapshot {
        self.inner
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn is_terminal(&self) -> bool {
        is_terminal(&self.snapshot().status)
    }

    fn update(&self, f: impl FnOnce(&mut JobSnapshot)) {
        let mut guard = self.inner.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        let was_terminal = is_terminal(&guard.status);
        f(&mut guard);
        if !was_terminal && is_terminal(&guard.status) {
            // 终态只通知一次；等待方（资源清理）由此与任务状态严格同步。
            let mut finished = self.inner.finished.lock().unwrap_or_else(|e| e.into_inner());
            *finished = true;
            self.inner.finished_signal.notify_all();
        }
    }

    /// 等待任务到达终态；超时返回 false（任务可能仍在执行，绝不伪装完成）。
    pub fn wait_terminal(&self, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        let mut finished = self.inner.finished.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if *finished {
                return true;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return false;
            }
            let (guard, _) = self
                .inner
                .finished_signal
                .wait_timeout(finished, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            finished = guard;
        }
    }

    /// 请求取消。返回是否发生了变化（已终态、或执行期不可安全取消时返回 false）。
    ///
    /// - `pending`：还没有动磁盘，直接终止；
    /// - `running` 且 `cancelable`：进入 `cancelling`，由任务在批次边界停止；
    /// - `running` 且不可取消：拒绝并返回 false，UI 不显示假取消。
    pub fn cancel(&self) -> bool {
        let mut effective = false;
        self.update(|s| {
            if is_terminal(&s.status) {
                return;
            }
            if s.status == "running" && !s.cancelable {
                return;
            }
            let first = !self.inner.cancel.swap(true, Ordering::SeqCst);
            s.cancel_requested = true;
            if !first {
                effective = false;
                return;
            }
            effective = true;
            if s.status == "pending" {
                s.status = "cancelled".into();
                s.phase = "done".into();
                s.cancelable = false;
                s.finished_ms = chrono::Utc::now().timestamp_millis();
            } else {
                s.status = "cancelling".into();
            }
        });
        effective
    }

    pub fn cancel_requested(&self) -> bool {
        self.inner.cancel.load(Ordering::Relaxed)
    }

    fn begin_running(&self, cancelable: bool) -> bool {
        let mut started = false;
        self.update(|s| {
            // 与 cancel 使用同一把快照锁裁决，取消已成功的 pending 任务不得复活。
            if s.status != "pending" || self.cancel_requested() {
                return;
            }
            s.status = "running".into();
            s.phase = "executing".into();
            s.cancelable = cancelable;
            started = true;
        });
        started
    }
}

/// 任务注册表（应用级单例）。只保留最近 [`MAX_HISTORY`] 个**终态**任务；
/// **运行中/排队中的任务永不淘汰**——否则 UI 会拿不到进度、也无法取消。
#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, JobHandle>>,
    order: Mutex<Vec<String>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, handle: JobHandle) -> String {
        let id = handle.snapshot().id.clone();
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let mut order = self.order.lock().unwrap_or_else(|e| e.into_inner());
        jobs.insert(id.clone(), handle);
        order.push(id.clone());
        while order.len() > 1 {
            let terminal = jobs.values().filter(|handle| handle.is_terminal()).count();
            if terminal <= MAX_HISTORY {
                break;
            }
            // 从最旧开始找第一个终态任务；运行中的直接跳过，绝不删除。
            let Some(position) = order.iter().position(|candidate| {
                jobs.get(candidate)
                    .map(JobHandle::is_terminal)
                    .unwrap_or(true)
            }) else {
                break;
            };
            let victim = order.remove(position);
            jobs.remove(&victim);
        }
        id
    }

    pub fn get(&self, id: &str) -> Option<JobHandle> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    /// 快照列表：按创建时间倒序（最新的在前），同一时间用 id 稳定排序。
    pub fn snapshots(&self) -> Vec<JobSnapshot> {
        let mut list: Vec<JobSnapshot> = self
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(JobHandle::snapshot)
            .collect();
        list.sort_by(|a, b| {
            b.started_ms
                .cmp(&a.started_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        list
    }
}

/// 一次任务的执行体。由固定 worker 线程调度，闭包内不得再创建线程。
type JobWork = Box<dyn FnOnce(&AppHandle, &JobHandle) + Send + 'static>;

struct QueuedJob {
    handle: JobHandle,
    work: JobWork,
}

/// 固定 worker 池：任务排队执行，全局高 IO 并发受 [`MAX_CONCURRENT_HEAVY`] 约束。
pub struct Scheduler {
    app: AppHandle,
    queue: Mutex<VecDeque<QueuedJob>>,
    signal: Condvar,
}

impl Scheduler {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let scheduler = Arc::new(Self {
            app,
            queue: Mutex::new(VecDeque::new()),
            signal: Condvar::new(),
        });
        for index in 0..MAX_CONCURRENT_HEAVY {
            let weak = Arc::downgrade(&scheduler);
            let spawned = std::thread::Builder::new()
                .name(format!("fsops-worker-{index}"))
                .spawn(move || loop {
                    let Some(scheduler) = weak.upgrade() else {
                        return;
                    };
                    let job = {
                        let mut queue =
                            scheduler.queue.lock().unwrap_or_else(|e| e.into_inner());
                        while queue.is_empty() {
                            queue = scheduler
                                .signal
                                .wait(queue)
                                .unwrap_or_else(|e| e.into_inner());
                        }
                        queue.pop_front()
                    };
                    let Some(job) = job else { return };
                    if !job.handle.begin_running(job.handle.inner.executing_cancelable) {
                        // 排队期间被取消：不执行任何磁盘动作。
                        job.handle.update(|s| {
                            s.status = "cancelled".into();
                            s.phase = "done".into();
                            s.cancelable = false;
                            s.finished_ms = chrono::Utc::now().timestamp_millis();
                        });
                        emit_progress(&scheduler.app, &job.handle);
                        continue;
                    }
                    emit_progress(&scheduler.app, &job.handle);
                    // 执行体 panic 不得带走 worker 线程（否则后续任务永久排队）：
                    // 捕获后如实收尾为失败；占用声明由 ClaimsGuard 在栈展开时释放。
                    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        (job.work)(&scheduler.app, &job.handle);
                    }))
                    .is_err();
                    if panicked {
                        if !job.handle.is_terminal() {
                            job.handle.update(|s| {
                                s.status = "failed".into();
                                s.phase = "done".into();
                                s.cancelable = false;
                                s.finished_ms = chrono::Utc::now().timestamp_millis();
                                s.message = Some("任务执行体异常中止".into());
                            });
                        }
                        emit_progress(&scheduler.app, &job.handle);
                    } else if !job.handle.is_terminal() {
                        // 执行体异常返回（不应发生）：如实收尾为失败，不伪装成功。
                        job.handle.update(|s| {
                            s.status = "failed".into();
                            s.phase = "done".into();
                            s.cancelable = false;
                            s.finished_ms = chrono::Utc::now().timestamp_millis();
                            s.message = Some("任务执行体异常结束".into());
                        });
                        emit_progress(&scheduler.app, &job.handle);
                    }
                });
            if let Err(e) = spawned {
                crate::diagnostics::event(
                    crate::diagnostics::DiagLevel::Error,
                    "file",
                    "scheduler",
                    "worker_spawn_failed",
                )
                .status(crate::diagnostics::DiagStatus::Failed)
                .metadata("worker", serde_json::json!(index))
                .metadata("error", serde_json::json!(e.to_string()))
                .emit();
            }
        }
        scheduler
    }

    fn enqueue(&self, handle: JobHandle, work: JobWork) -> AppResult<()> {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        if queue.len() >= MAX_PENDING {
            return Err(AppError::Validation(format!(
                "文件操作任务过多（排队上限 {MAX_PENDING}），请等待已有任务完成"
            )));
        }
        queue.push_back(QueuedJob { handle, work });
        self.signal.notify_one();
        Ok(())
    }
}

/// 回收站条目/卷的分层操作占用声明。
///
/// 两类资源：
/// - **卷**（父键 = `bin_root`）：整卷清空独占该卷；
/// - **条目**（父键 + `record_key`）：单个恢复/永久删除。
///
/// 冲突判定不是「字符串完全相同」——条目请求必须检查同卷是否被整卷独占，
/// 整卷请求必须检查该卷是否还有任何条目操作。不同卷之间互不影响，仍然并行。
/// 声明进程内生效；崩溃后任务本身也不存在，真实状态由下一次同步按 `$I`/`$R` 对账。
#[derive(Default)]
pub struct RecycleClaims {
    inner: Mutex<ClaimTable>,
}

#[derive(Default)]
struct ClaimTable {
    /// `bin_root` → 独占整卷的任务（清空）。
    volumes: HashMap<String, ClaimEntry>,
    /// `(bin_root, record_key)` → 条目任务（恢复 / 永久删除）。
    entries: HashMap<(String, String), ClaimEntry>,
}

#[derive(Clone)]
struct ClaimEntry {
    job_id: String,
    kind: &'static str,
}

/// 占用冲突：只描述「谁占着」，不含 `bin_root`（里面有用户 SID，不得进事件与日志）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClaimConflict {
    holder: &'static str,
    /// 冲突来自整卷独占（而不是同一条目）。
    volume_wide: bool,
}

impl ClaimConflict {
    /// 条目请求被拒时的用户文案。
    fn for_entry(self) -> String {
        if self.volume_wide {
            format!("该磁盘正在被其他任务（{}）清空，本次未执行", self.holder)
        } else {
            format!("该项目正在被其他任务（{}）处理，本次未执行", self.holder)
        }
    }
}

impl RecycleClaims {
    pub fn new() -> Self {
        Self::default()
    }

    /// 声明一个条目。返回 `None` 表示占用成功（同一任务重复声明是幂等的）。
    fn try_claim_entry(
        &self,
        bin_root: &str,
        record_key: &str,
        job_id: &str,
        kind: &'static str,
    ) -> Option<ClaimConflict> {
        let mut table = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        // 1. 整卷已被别的任务独占（清空进行中）→ 该卷内任何条目都不能再动。
        if let Some(holder) = table.volumes.get(bin_root) {
            if holder.job_id != job_id {
                return Some(ClaimConflict { holder: holder.kind, volume_wide: true });
            }
            // 同一任务已持有整卷：条目声明被卷覆盖，无需重复登记。
            return None;
        }
        // 2. 同一条目已被别的任务占用（恢复 vs 永久删除）。
        let key = entry_claim_key(bin_root, record_key);
        if let Some(holder) = table.entries.get(&key) {
            if holder.job_id != job_id {
                return Some(ClaimConflict { holder: holder.kind, volume_wide: false });
            }
            // 同一任务重复声明同一个 ID：幂等，不自我冲突。
            return None;
        }
        table.entries.insert(key, ClaimEntry { job_id: job_id.to_string(), kind });
        None
    }

    /// 声明整卷（清空）。返回 `None` 表示占用成功。
    fn try_claim_volume(&self, bin_root: &str, job_id: &str, kind: &'static str) -> Option<ClaimConflict> {
        let mut table = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(holder) = table.volumes.get(bin_root) {
            if holder.job_id != job_id {
                return Some(ClaimConflict { holder: holder.kind, volume_wide: true });
            }
            return None;
        }
        // 该卷还有任何条目操作（含即将恢复的条目）→ 拒绝整卷清空。
        // 条目数受 MAX_OP_PATHS 与并发任务数约束，这里线性扫描足够。
        let conflict = table
            .entries
            .iter()
            .find(|((root, _), entry)| root == bin_root && entry.job_id != job_id)
            .map(|(_, entry)| entry.kind);
        if let Some(holder) = conflict {
            return Some(ClaimConflict { holder, volume_wide: false });
        }
        table.volumes.insert(volume_claim_key(bin_root).to_string(), ClaimEntry {
            job_id: job_id.to_string(),
            kind,
        });
        None
    }

    /// 释放某任务持有的全部声明（含取消、失败、panic 展开路径）。
    fn release_job(&self, job_id: &str) {
        let mut table = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        table.volumes.retain(|_, entry| entry.job_id != job_id);
        table.entries.retain(|_, entry| entry.job_id != job_id);
    }

    #[cfg(test)]
    fn active(&self) -> usize {
        let table = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        table.volumes.len() + table.entries.len()
    }
}

/// 进程级占用声明表：恢复、永久删除、清空在进程生命周期内互斥。
/// 用 `OnceLock` 而不是 App State，避免把共享枢纽文件（`lib.rs`）纳入本模块写入范围；
/// 声明本身不持有任务数据，任务注册表仍由 App State 管理。
fn recycle_claims() -> &'static RecycleClaims {
    static CLAIMS: std::sync::OnceLock<RecycleClaims> = std::sync::OnceLock::new();
    CLAIMS.get_or_init(RecycleClaims::new)
}

/// 任务结束时释放自己持有的全部声明（含取消、失败与 panic 展开路径）。
struct ClaimsGuard {
    claims: &'static RecycleClaims,
    job_id: String,
}

impl Drop for ClaimsGuard {
    fn drop(&mut self) {
        self.claims.release_job(&self.job_id);
    }
}

/// 条目资源键：卷父键（`bin_root`）+ 记录键。
///
/// `bin_root` 形如 `D:\$Recycle.Bin\S-1-5-21-...`，含用户 SID：**只在这里做内部键**，
/// 不得写入前端事件、诊断日志或用户可见消息。
fn entry_claim_key(bin_root: &str, record_key: &str) -> (String, String) {
    (bin_root.to_string(), record_key.to_string())
}

/// 卷资源父键：直接用 `bin_root`，这样「清空 D 盘」与「恢复 D 盘某条目」
/// 落在同一个资源命名空间里，不会因为一个用盘符、一个用 bin_root 而互不可见。
fn volume_claim_key(bin_root: &str) -> &str {
    bin_root
}

/// 成功操作后的索引写入失败：主结果不伪装成功，逐条记 `partial` 并标记对账。
fn record_index_failure(
    worker: &JobHandle,
    db: &Arc<Db>,
    bin_root: &str,
    volume: &str,
    label: String,
    error: String,
) {
    let marked = db
        .with_conn(|conn| recycle_index::mark_reconcile_required(conn, bin_root, volume, "INDEX_UPDATE_FAILED"))
        .is_ok();
    worker.update(|s| s.index_pending += 1);
    record_result(
        worker,
        JobEntryResult {
            label,
            status: "partial".into(),
            code: "INDEX_UPDATE_FAILED".into(),
            message: Some(if marked {
                format!("系统操作已完成，但回收站索引更新失败，已标记重新对账：{error}")
            } else {
                format!("系统操作已完成，但回收站索引更新与对账标记均失败：{error}")
            }),
        },
    );
}

/// 任务构造参数。
struct JobSpec {
    kind: &'static str,
    total: usize,
    message: Option<String>,
    /// 执行期间是否允许在安全边界取消。
    cancelable: bool,
}

fn new_handle(spec: JobSpec) -> JobHandle {
    JobHandle {
        inner: Arc::new(JobInner {
            report: Mutex::new(None),
            snapshot: Mutex::new(JobSnapshot {
                id: uuid::Uuid::new_v4().to_string(),
                kind: spec.kind.to_string(),
                status: "pending".into(),
                total: spec.total,
                done: 0,
                ok: 0,
                failed: 0,
                partial: 0,
                skipped: 0,
                phase: "queued".into(),
                cancelable: true,
                cancel_requested: false,
                started_ms: chrono::Utc::now().timestamp_millis(),
                finished_ms: 0,
                failures: Vec::new(),
                message: spec.message,
                index_pending: 0,
                bytes_done: 0,
                bytes_total: 0,
            }),
            cancel: AtomicBool::new(false),
            executing_cancelable: spec.cancelable,
            finished: Mutex::new(false),
            finished_signal: Condvar::new(),
        }),
    }
}

fn emit_progress(app: &AppHandle, handle: &JobHandle) {
    let snapshot = handle.snapshot();
    let _ = app.emit(JOB_EVENT, snapshot);
}

fn record_result(handle: &JobHandle, entry: JobEntryResult) {
    handle.update(|s| {
        match entry.status.as_str() {
            "ok" => s.ok += 1,
            "skipped" => s.skipped += 1,
            "partial" => s.partial += 1,
            _ => s.failed += 1,
        }
        s.done += 1;
        if entry.status != "ok" && s.failures.len() < MAX_FAILURES {
            s.failures.push(entry);
        }
    });
}

/// 一条 `FsEntryReport` → 任务条目结果（只保留展示名，不落完整路径）。
fn entry_of(entry: &crate::file_workspace::FsEntryReport) -> JobEntryResult {
    JobEntryResult {
        label: label_of(&entry.source),
        status: entry.status.to_string(),
        code: entry.code.clone().unwrap_or_else(|| "OK".into()),
        message: entry.reason.clone(),
    }
}

fn record_transfer_report(
    handle: &JobHandle,
    result: AppResult<crate::file_workspace::FsOpReport>,
    paths: &[String],
    operation_id: Option<&str>,
) {
    use crate::file_workspace::{FsEntryReport, FsOpReport};
    let report = result.unwrap_or_else(|error| FsOpReport {
        operation_id: operation_id.map(str::to_owned).unwrap_or_else(|| handle.snapshot().id),
        attempted: paths.len(), ok: 0, failed: paths.len(), skipped: 0, partial: 0,
        entries: paths.iter().map(|path| FsEntryReport {
            source: path.clone(), target: None, status: "failed",
            reason: Some(error.to_string()), code: Some(error.code().to_string()),
            stage: Some("prepare".into()),
        }).collect(),
    });
    // 流式回调已经登记的前缀不重复计数；预检失败和旧调用仍从第一项登记。
    let recorded = handle.snapshot().done;
    for entry in report.entries.iter().skip(recorded) {
        record_result(handle, entry_of(entry));
    }
    *handle.inner.report.lock().unwrap_or_else(|e| e.into_inner()) = Some(report);
}

fn finish(handle: &JobHandle, cancelled: bool) {
    handle.update(|s| {
        s.phase = "done".into();
        s.finished_ms = chrono::Utc::now().timestamp_millis();
        s.status = if cancelled {
            "cancelled".into()
        } else if s.done < s.total {
            // 没有跑完全部条目却自称完成，是虚假成功：如实标记部分完成。
            s.message
                .get_or_insert_with(|| format!("仅处理 {}/{} 项，其余未执行", s.done, s.total));
            "partial".into()
        } else if s.failed > 0 && s.ok == 0 && s.partial == 0 {
            "failed".into()
        } else if s.failed > 0 || s.skipped > 0 || s.partial > 0 {
            "partial".into()
        } else {
            "completed".into()
        };
        s.cancelable = false;
    });
}

fn label_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// 任务终态聚合诊断的纯构造：只记计数/耗时与链路标识，不写路径或文件名。
/// `trace_id` 由 worker 闭包按值捕获显式传入（跨线程不依赖 thread_local）。
fn build_job_diagnostic(
    kind: &str,
    operation_id: Option<&str>,
    trace_id: Option<&str>,
    handle: &JobHandle,
    started: std::time::Instant,
) -> crate::diagnostics::DiagnosticEvent {
    let snapshot = handle.snapshot();
    let level = if snapshot.status == "failed" || snapshot.status == "partial" {
        crate::diagnostics::DiagLevel::Warn
    } else {
        crate::diagnostics::DiagLevel::Info
    };
    let status = match snapshot.status.as_str() {
        "completed" => crate::diagnostics::DiagStatus::Success,
        "cancelled" => crate::diagnostics::DiagStatus::Cancelled,
        _ => crate::diagnostics::DiagStatus::Failed,
    };
    let mut builder = crate::diagnostics::event(level, "file", kind, "job_completed")
        .status(status)
        .duration_ms(started.elapsed().as_millis() as u64)
        .metadata("total", serde_json::json!(snapshot.total))
        .metadata("ok", serde_json::json!(snapshot.ok))
        .metadata("failed", serde_json::json!(snapshot.failed))
        .metadata("partial", serde_json::json!(snapshot.partial))
        .metadata("skipped", serde_json::json!(snapshot.skipped));
    if let Some(id) = operation_id {
        builder = builder.operation(id);
    }
    if let Some(trace) = trace_id {
        builder = builder.trace(trace);
    }
    builder.build()
}

/// 任务终态写一条聚合诊断（只记计数/耗时，不写路径或文件名）。
fn emit_job_diagnostic(
    kind: &str,
    operation_id: Option<&str>,
    trace_id: Option<&str>,
    handle: &JobHandle,
    started: std::time::Instant,
) {
    crate::diagnostics::emit(build_job_diagnostic(
        kind,
        operation_id,
        trace_id,
        handle,
        started,
    ));
}

/// 统一提交：建任务 → 入注册表 → 入调度队列。入队失败时任务如实标失败。
fn submit(
    app: &AppHandle,
    spec: JobSpec,
    work: impl FnOnce(&AppHandle, &JobHandle) + Send + 'static,
) -> AppResult<JobSnapshot> {
    let handle = new_handle(spec);
    let registry = app.state::<Arc<JobRegistry>>().inner().clone();
    registry.insert(handle.clone());
    let scheduler = app.state::<Arc<Scheduler>>().inner().clone();
    if let Err(e) = scheduler.enqueue(handle.clone(), Box::new(work)) {
        handle.update(|s| {
            s.status = "failed".into();
            s.phase = "done".into();
            s.cancelable = false;
            s.finished_ms = chrono::Utc::now().timestamp_millis();
            s.message = Some(e.to_string());
        });
        return Err(e);
    }
    Ok(handle.snapshot())
}

fn protected_dirs(app: &AppHandle) -> Vec<PathBuf> {
    std::env::var_os("TASK_DOCK_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .into_iter()
        .collect()
}

/// 供跨模块（工作篮）复用同一套受保护目录判定，不重复实现数据目录规则。
pub fn protected_dirs_pub(app: &AppHandle) -> Vec<PathBuf> {
    protected_dirs(app)
}

/// 删除任务：普通文件路径（进入回收站或永久删除）。复用文件工作区实现。
pub fn start_delete(
    app: &AppHandle,
    paths: Vec<String>,
    permanent: bool,
    protected: Vec<PathBuf>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    if paths.is_empty() {
        return Err(AppError::Validation("没有要删除的项目".into()));
    }
    let kind = if permanent {
        "delete_permanent"
    } else {
        "delete"
    };
    submit(
        app,
        JobSpec {
            kind,
            total: paths.len(),
            message: None,
            cancelable: true,
        },
        move |app, worker| {
            let started = std::time::Instant::now();
            let mut cancelled = false;
            for chunk in paths.chunks(DELETE_BATCH) {
                if worker.cancel_requested() {
                    cancelled = true;
                    break;
                }
                match crate::file_workspace::delete_paths(
                    chunk,
                    permanent,
                    operation_id.clone(),
                    &protected,
                ) {
                    Ok(report) => {
                        for entry in &report.entries {
                            record_result(worker, entry_of(entry));
                        }
                    }
                    Err(e) => {
                        for path in chunk {
                            record_result(
                                worker,
                                JobEntryResult {
                                    label: label_of(path),
                                    status: "failed".into(),
                                    code: e.code().to_string(),
                                    message: Some(e.to_string()),
                                },
                            );
                        }
                    }
                }
                emit_progress(app, worker);
            }
            finish(worker, cancelled);
            emit_progress(app, worker);
            // 普通删除已进入系统回收站：回收站索引是派生缓存，必须由删除方标记失效，
            // 否则资源面板会继续用删除前的条目数（最长 10 分钟，见 recycle_plan_from_stats）。
            // 一次任务只请求一次，卷去重与「扫描中补扫」由 recycle 层保证。
            // 永久删除不产生回收站条目，不标记。
            if !permanent && worker.snapshot().ok > 0 {
                if let Some(service) = app.try_state::<Arc<crate::recycle::RecycleService>>() {
                    let marked = crate::recycle::note_deleted_paths(app, service.inner(), &paths);
                    if marked > 0 {
                        tracing::debug!("删除完成，已标记 {marked} 个卷的回收站索引待对账");
                    }
                }
            }
            emit_job_diagnostic("delete", operation_id.as_deref(), None, worker, started);
        },
    )
}

/// 重复文件删除任务：先逐文件复核身份（哈希 + 卷/文件索引 + 大小 + 修改时间），
/// 再把通过复核的路径交给回收站。未通过复核的文件只跳过并报告，绝不默认删除。
///
/// 为什么进 fsops 而不是在命令里直接调用：进度、取消、逐项报告与其它文件操作
/// 共用同一套任务注册表（`fs_jobs` / `fs_job_cancel` / `fs_job_report`），
/// 避免出现「第二套队列 + 两套进度」。
pub fn start_delete_duplicates(
    app: &AppHandle,
    groups: Vec<crate::file_workspace::duplicates::DuplicateDeleteGroup>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    let total = groups.iter().map(|group| group.delete_paths.len()).sum();
    if total == 0 {
        return Err(AppError::Validation("没有可删除的重复文件".into()));
    }
    submit(
        app,
        JobSpec {
            kind: "delete_duplicates",
            total,
            message: Some("正在校验文件身份…".into()),
            cancelable: true,
        },
        move |app, worker| {
            let started = std::time::Instant::now();
            let protected = protected_dirs(app);
            // 进度节流：哈希每 4MB/200ms 回调一次，这里再压到 150ms 一次事件，
            // 避免大文件哈希把 IPC 事件打满。
            let last_emit = std::cell::Cell::new(std::time::Instant::now());
            let plan = crate::file_workspace::duplicates::plan(
                &groups,
                &protected,
                &mut |progress| {
                    worker.update(|state| {
                        state.bytes_done = progress.bytes_done;
                        state.bytes_total = progress.bytes_total;
                    });
                    if last_emit.get().elapsed() >= std::time::Duration::from_millis(150) {
                        last_emit.set(std::time::Instant::now());
                        emit_progress(app, worker);
                    }
                },
                &|| worker.cancel_requested(),
            );

            let plan = match plan {
                Ok(plan) => plan,
                Err(error) => {
                    let cancelled = worker.cancel_requested();
                    let (status, code, message) = if cancelled {
                        ("skipped", "FS_OP_CANCELLED".to_string(), "已取消，未执行".to_string())
                    } else {
                        (
                            "failed",
                            error.code().to_string(),
                            error.to_string(),
                        )
                    };
                    for group in &groups {
                        for path in &group.delete_paths {
                            record_result(
                                worker,
                                JobEntryResult {
                                    label: label_of(path),
                                    status: status.into(),
                                    code: code.clone(),
                                    message: Some(message.clone()),
                                },
                            );
                        }
                    }
                    finish(worker, cancelled);
                    emit_progress(app, worker);
                    return;
                }
            };

            // 复核阶段的跳过项先入账：用户要能区分「没删」与「删失败」。
            for skip in &plan.skipped {
                record_result(
                    worker,
                    JobEntryResult {
                        label: label_of(&skip.path),
                        status: "skipped".into(),
                        code: skip.code.to_string(),
                        message: Some(skip.reason.clone()),
                    },
                );
            }
            worker.update(|state| {
                state.phase = "executing".into();
                state.message = Some("正在提交到回收站…".into());
            });
            emit_progress(app, worker);

            let report =
                crate::file_workspace::duplicates::delete_plan(plan, &protected, operation_id.clone());
            for entry in &report.entries {
                record_result(worker, entry_of(entry));
            }
            *worker.inner.report.lock().unwrap_or_else(|e| e.into_inner()) = Some(report);
            finish(worker, worker.cancel_requested());
            emit_progress(app, worker);
            emit_job_diagnostic("delete_duplicates", operation_id.as_deref(), None, worker, started);
        },
    )
}

/// 复制任务（无链路标识的兼容入口，供工作篮等旧调用方使用）。
pub fn start_copy(    app: &AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: String,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    start_copy_traced(app, paths, target_dir, conflict, operation_id, None)
}

/// 复制任务：整批一次调用（保持「父目录优先」语义），完成后逐条报告。
/// 复制在顶层条目之间可取消；当前文件/目录完成后才停止，避免留下半写文件。
/// `trace_id` 由命令层解析后按值捕获进 worker 闭包（跨线程显式传参，不读 thread_local）。
pub fn start_copy_traced(
    app: &AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: String,
    operation_id: Option<String>,
    trace_id: Option<String>,
) -> AppResult<JobSnapshot> {
    if paths.is_empty() {
        return Err(AppError::Validation("没有要复制的项目".into()));
    }
    if paths.len() > crate::file_workspace::MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            crate::file_workspace::MAX_OP_PATHS
        )));
    }
    let protected = protected_dirs(app);
    let policy = crate::file_workspace::parse_conflict(&conflict)?;
    submit(
        app,
        JobSpec {
            kind: "copy",
            total: paths.len(),
            message: None,
            cancelable: true,
        },
        move |app, worker| {
            let started = std::time::Instant::now();
            let last_emit = std::cell::Cell::new(std::time::Instant::now());
            let result = crate::file_workspace::copy_paths_with_progress(
                &paths,
                std::path::Path::new(&target_dir),
                policy,
                operation_id.clone(),
                &protected,
                &|| worker.cancel_requested(),
                &|entry| transfer_progress(app, worker, entry, &last_emit),
            );
            record_transfer_report(worker, result, &paths, operation_id.as_deref());
            finish(worker, worker.cancel_requested());
            emit_progress(app, worker);
            emit_job_diagnostic(
                "copy",
                operation_id.as_deref(),
                trace_id.as_deref(),
                worker,
                started,
            );
        },
    )
}

/// 移动任务（无链路标识的兼容入口，供工作篮等旧调用方使用）。
pub fn start_move(
    app: &AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: String,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    start_move_traced(app, paths, target_dir, conflict, operation_id, None)
}

/// 移动任务：同复制，整批一次调用。`trace_id` 语义同 [`start_copy_traced`]。
pub fn start_move_traced(
    app: &AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: String,
    operation_id: Option<String>,
    trace_id: Option<String>,
) -> AppResult<JobSnapshot> {
    if paths.is_empty() {
        return Err(AppError::Validation("没有要移动的项目".into()));
    }
    if paths.len() > crate::file_workspace::MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            crate::file_workspace::MAX_OP_PATHS
        )));
    }
    let protected = protected_dirs(app);
    let policy = crate::file_workspace::parse_conflict(&conflict)?;
    submit(
        app,
        JobSpec {
            kind: "move",
            total: paths.len(),
            message: None,
            cancelable: true,
        },
        move |app, worker| {
            let started = std::time::Instant::now();
            let last_emit = std::cell::Cell::new(std::time::Instant::now());
            let result = crate::file_workspace::move_paths_with_progress(
                &paths,
                std::path::Path::new(&target_dir),
                policy,
                operation_id.clone(),
                &protected,
                &|| worker.cancel_requested(),
                &|entry| transfer_progress(app, worker, entry, &last_emit),
            );
            record_transfer_report(worker, result, &paths, operation_id.as_deref());
            finish(worker, worker.cancel_requested());
            emit_progress(app, worker);
            emit_job_diagnostic(
                "move",
                operation_id.as_deref(),
                trace_id.as_deref(),
                worker,
                started,
            );
        },
    )
}

fn transfer_progress(
    app: &AppHandle,
    worker: &JobHandle,
    entry: &crate::file_workspace::FsEntryReport,
    last_emit: &std::cell::Cell<std::time::Instant>,
) {
    record_result(worker, entry_of(entry));
    if last_emit.get().elapsed() >= std::time::Duration::from_millis(100) {
        emit_progress(app, worker);
        last_emit.set(std::time::Instant::now());
    }
}

/// 批量重命名复用原有整批冲突预检，条目间可取消，结果按需读取。
pub fn start_rename(
    app: &AppHandle,
    items: Vec<crate::file_workspace::BatchRenameItem>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    if items.is_empty() || items.len() > crate::file_workspace::MAX_OP_PATHS {
        return Err(AppError::Validation(format!("批量重命名需要 1–{} 项", crate::file_workspace::MAX_OP_PATHS)));
    }
    let protected = protected_dirs(app);
    submit(app, JobSpec { kind: "rename", total: items.len(), message: None, cancelable: true },
        move |app, worker| {
            let started = std::time::Instant::now();
            let last_emit = std::cell::Cell::new(std::time::Instant::now());
            let report = crate::file_workspace::batch_rename_with_progress(
                &items, &protected, operation_id.clone(), &|| worker.cancel_requested(),
                &|entry| transfer_progress(app, worker, entry, &last_emit),
            );
            *worker.inner.report.lock().unwrap_or_else(|e| e.into_inner()) = Some(report);
            finish(worker, worker.cancel_requested());
            emit_progress(app, worker);
            emit_job_diagnostic("rename", operation_id.as_deref(), None, worker, started);
        })
}

/// 全部条目都在入队前被拒绝：仍返回可查询的任务快照，逐项如实反馈，
/// 而不是抛一个把范围缩小的错误让调用方误以为整批成功。
fn immediate_job(
    app: &AppHandle,
    kind: &'static str,
    total: usize,
    message: Option<String>,
    failures: Vec<JobEntryResult>,
) -> JobSnapshot {
    let handle = new_handle(JobSpec {
        kind,
        total,
        message,
        cancelable: true,
    });
    for entry in failures {
        record_result(&handle, entry);
    }
    finish(&handle, false);
    let registry = app.state::<Arc<JobRegistry>>().inner().clone();
    registry.insert(handle.clone());
    handle.snapshot()
}

fn unresolved_entry(item: &recycle_index::UnresolvedItem) -> JobEntryResult {
    JobEntryResult {
        label: item
            .id
            .split_once('|')
            .map(|(volume, key)| format!("{volume}|{key}"))
            .unwrap_or_else(|| item.id.clone()),
        status: "failed".into(),
        code: item.code.to_string(),
        message: Some(item.message.to_string()),
    }
}

/// 恢复任务：从回收站恢复到原位置。成功后写墓碑并移除索引记录。
///
/// 逐项反馈：无效/已消失/状态不可恢复/目标受保护/条目被其他任务占用
/// 都各自产生一条失败结果，任务总数始终等于请求条数，不缩小操作范围。
pub fn start_restore(
    app: &AppHandle,
    ids: Vec<String>,
    conflict: RestoreConflict,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    if ids.is_empty() {
        return Err(AppError::Validation("没有要恢复的项目".into()));
    }
    let db = app.state::<Arc<Db>>().inner().clone();
    let resolved = db.with_read(|conn| recycle_index::resolve(conn, &ids))?;
    let protected = protected_dirs(app);
    let mut failures: Vec<JobEntryResult> = resolved.unresolved.iter().map(unresolved_entry).collect();
    let mut runnable = Vec::with_capacity(resolved.items.len());
    for item in resolved.items {
        if item.state != recycle_index::STATE_PRESENT {
            failures.push(JobEntryResult {
                label: item.name.clone(),
                status: "failed".into(),
                code: "RECYCLE_STATE_NOT_RESTORABLE".into(),
                message: Some("该项目缺少数据或元数据损坏，只能从索引移除".into()),
            });
            continue;
        }
        let target = match crate::file_workspace::validate_abs_path(&item.original_path) {
            Ok(target) => target,
            Err(error) => {
                failures.push(JobEntryResult {
                    label: item.name.clone(),
                    status: "failed".into(),
                    code: error.code().to_string(),
                    message: Some(error.to_string()),
                });
                continue;
            }
        };
        if let Err(error) = crate::file_workspace::ensure_not_protected(&target, &protected) {
            failures.push(JobEntryResult {
                label: item.name.clone(),
                status: "failed".into(),
                code: error.code().to_string(),
                message: Some(error.to_string()),
            });
            continue;
        }
        runnable.push(item);
    }
    let total = ids.len();
    if runnable.is_empty() {
        return Ok(immediate_job(
            app,
            "restore",
            total,
            Some("没有可恢复的项目，详见失败明细".into()),
            failures,
        ));
    }
    let pre_failures = failures.clone();
    submit(
        app,
        JobSpec {
            kind: "restore",
            total,
            message: None,
            cancelable: true,
        },
        move |app, worker| {
            let started = std::time::Instant::now();
            let claims = recycle_claims();
            let job_id = worker.snapshot().id;
            let _guard = ClaimsGuard { claims, job_id: job_id.clone() };
            for entry in pre_failures {
                record_result(worker, entry);
            }
            let mut claimed_items: Vec<recycle_index::ResolvedItem> = Vec::with_capacity(runnable.len());
            for item in runnable.into_iter() {
                if let Some(conflict) =
                    claims.try_claim_entry(&item.bin_root, &item.record_key, &job_id, "restore")
                {
                    record_result(worker, JobEntryResult {
                        label: item.name.clone(),
                        status: "failed".into(),
                        code: if conflict.volume_wide { "RECYCLE_VOLUME_BUSY" } else { "RECYCLE_ENTRY_BUSY" }.into(),
                        message: Some(conflict.for_entry()),
                    });
                    continue;
                }
                claimed_items.push(item);
            }
            let mut cancelled = false;
            for chunk in claimed_items.chunks(NATIVE_BATCH) {
                if worker.cancel_requested() {
                    cancelled = true;
                    break;
                }
                let targets: Vec<NativeTarget> = chunk
                    .iter()
                    .map(|item| NativeTarget {
                        name: item.name.clone(),
                        bin_root: item.bin_root.clone(),
                        data_name: item.data_name.clone(),
                        original_path: item.original_path.clone(),
                    })
                    .collect();
                let outcomes = ops::restore_batch(&targets, conflict);
                if outcomes.len() != chunk.len() {
                    // 契约被破坏时宁可整批如实失败，也不按下标错位映射（P0）。
                    for item in chunk {
                        record_result(
                            worker,
                            JobEntryResult {
                                label: item.name.clone(),
                                status: "failed".into(),
                                code: "RESULT_MISMATCH".into(),
                                message: Some("批量结果数量与输入不一致，未更新索引".into()),
                            },
                        );
                    }
                    emit_progress(app, worker);
                    continue;
                }
                let mut index_ok: Vec<(&recycle_index::ResolvedItem, ops::NativeOutcome)> =
                    Vec::with_capacity(chunk.len());
                for (item, outcome) in chunk.iter().zip(outcomes) {
                    if outcome.status == "ok" {
                        index_ok.push((item, outcome));
                    } else {
                        record_result(
                            worker,
                            JobEntryResult {
                                label: outcome.target.clone(),
                                status: outcome.status.clone(),
                                code: outcome.code.clone(),
                                message: outcome.message.clone(),
                            },
                        );
                    }
                }
                if !index_ok.is_empty() {
                    let keys: Vec<(String, String)> = index_ok
                        .iter()
                        .map(|(item, _)| (item.bin_root.clone(), item.record_key.clone()))
                        .collect();
                    match db.with_conn(|conn| recycle_index::mark_removed_batch(conn, &keys)) {
                        Ok(_) => {
                            for (_, outcome) in index_ok {
                                record_result(
                                    worker,
                                    JobEntryResult {
                                        label: outcome.target.clone(),
                                        status: outcome.status.clone(),
                                        code: outcome.code.clone(),
                                        message: outcome.message.clone(),
                                    },
                                );
                            }
                        }
                        Err(error) => {
                            // 整批索引写入失败：逐项如实记 partial，并标记该卷对账。
                            for (item, outcome) in index_ok {
                                record_index_failure(
                                    worker,
                                    &db,
                                    &item.bin_root,
                                    &item.volume,
                                    outcome.target.clone(),
                                    error.to_string(),
                                );
                            }
                        }
                    }
                }
                if worker.cancel_requested() {
                    cancelled = true;
                    break;
                }
                emit_progress(app, worker);
            }
            finish(worker, cancelled);
            emit_progress(app, worker);
            emit_job_diagnostic("restore", operation_id.as_deref(), None, worker, started);
        },
    )
}

/// 「只能从索引移除」的逐条说明。必须让用户明白：磁盘上的 `$I`/`$R` 没有被修改，
/// 因此这不是磁盘空间清理，也不是「永久删除」。
fn index_only_message(item: &recycle_index::ResolvedItem) -> String {
    if item.state == recycle_index::STATE_MISSING_DATA {
        "数据已不存在（$R 缺失），本次仅从索引移除；磁盘上的 $I 元数据未改动".into()
    } else if item.anomaly.as_deref() == Some(crate::recycle::scan::ANOMALY_ORPHAN_DATA) {
        "缺少 $I 元数据的孤儿数据：本次仅从索引隐藏，磁盘上的 $R 数据仍在回收站目录中，未删除".into()
    } else {
        "元数据损坏：本次仅从索引隐藏，磁盘上的 $I/$R 均未改动".into()
    }
}

/// 永久删除回收站项目。
///
/// 分流规则（对应「真正的永久删除」与「从索引移除异常记录」必须区分）：
/// - `present`：走 Windows Shell 真删除，成功后写墓碑并移除索引记录；
/// - `missing_data` / `unreadable`：**不调用 Shell**（没有数据可删、或定位不可信），
///   只写墓碑并移除索引记录，逐条返回 `status=ok` + `code=RECYCLE_INDEX_ONLY`，
///   文案明确说明磁盘未被修改。
///
/// 逐项反馈规则同 [`start_restore`]；条目被占用时该条失败，不影响其余条目。
pub fn start_purge(
    app: &AppHandle,
    ids: Vec<String>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    if ids.is_empty() {
        return Err(AppError::Validation("没有要删除的项目".into()));
    }
    let db = app.state::<Arc<Db>>().inner().clone();
    let resolved = db.with_read(|conn| recycle_index::resolve(conn, &ids))?;
    let failures: Vec<JobEntryResult> = resolved.unresolved.iter().map(unresolved_entry).collect();
    let mut native_items = Vec::with_capacity(resolved.items.len());
    let mut index_only_items = Vec::with_capacity(resolved.items.len());
    for item in resolved.items {
        if recycle_index::supports_native_action(&item.state) {
            native_items.push(item);
        } else {
            index_only_items.push(item);
        }
    }
    let total = ids.len();
    if native_items.is_empty() && index_only_items.is_empty() {
        return Ok(immediate_job(
            app,
            "purge",
            total,
            Some("没有可处理的条目，详见失败明细".into()),
            failures,
        ));
    }
    let pre_failures = failures.clone();
    submit(
        app,
        JobSpec {
            kind: "purge",
            total,
            message: None,
            cancelable: true,
        },
        move |app, worker| {
            let started = std::time::Instant::now();
            let claims = recycle_claims();
            let job_id = worker.snapshot().id;
            let _guard = ClaimsGuard { claims, job_id: job_id.clone() };
            for entry in pre_failures {
                record_result(worker, entry);
            }
            let mut claimed_native: Vec<recycle_index::ResolvedItem> =
                Vec::with_capacity(native_items.len());
            for item in native_items.into_iter() {
                if let Some(conflict) =
                    claims.try_claim_entry(&item.bin_root, &item.record_key, &job_id, "purge")
                {
                    record_result(worker, JobEntryResult {
                        label: item.name.clone(),
                        status: "failed".into(),
                        code: if conflict.volume_wide { "RECYCLE_VOLUME_BUSY" } else { "RECYCLE_ENTRY_BUSY" }.into(),
                        message: Some(conflict.for_entry()),
                    });
                    continue;
                }
                claimed_native.push(item);
            }
            let mut claimed_index_only: Vec<recycle_index::ResolvedItem> =
                Vec::with_capacity(index_only_items.len());
            for item in index_only_items.into_iter() {
                if let Some(conflict) =
                    claims.try_claim_entry(&item.bin_root, &item.record_key, &job_id, "purge")
                {
                    record_result(worker, JobEntryResult {
                        label: item.name.clone(),
                        status: "failed".into(),
                        code: if conflict.volume_wide { "RECYCLE_VOLUME_BUSY" } else { "RECYCLE_ENTRY_BUSY" }.into(),
                        message: Some(conflict.for_entry()),
                    });
                    continue;
                }
                claimed_index_only.push(item);
            }
            // 异常条目：只动索引。写墓碑保证「清空前启动的旧扫描快照」不会把它写回来。
            if !claimed_index_only.is_empty() {
                let keys: Vec<(String, String)> = claimed_index_only
                    .iter()
                    .map(|item| (item.bin_root.clone(), item.record_key.clone()))
                    .collect();
                match db.with_conn(|conn| recycle_index::mark_removed_batch(conn, &keys)) {
                    Ok(_) => {
                        for item in claimed_index_only {
                            record_result(
                                worker,
                                JobEntryResult {
                                    label: item.name.clone(),
                                    status: "ok".into(),
                                    code: RECYCLE_INDEX_ONLY.into(),
                                    message: Some(index_only_message(&item)),
                                },
                            );
                        }
                    }
                    Err(error) => {
                        for item in claimed_index_only {
                            record_index_failure(
                                worker,
                                &db,
                                &item.bin_root,
                                &item.volume,
                                item.name.clone(),
                                error.to_string(),
                            );
                        }
                    }
                }
                emit_progress(app, worker);
            }
            let mut cancelled = false;
            for chunk in claimed_native.chunks(NATIVE_BATCH) {
                if worker.cancel_requested() {
                    cancelled = true;
                    break;
                }
                let targets: Vec<NativeTarget> = chunk
                    .iter()
                    .map(|item| NativeTarget {
                        name: item.name.clone(),
                        bin_root: item.bin_root.clone(),
                        data_name: item.data_name.clone(),
                        original_path: item.original_path.clone(),
                    })
                    .collect();
                let outcomes = ops::purge_batch(&targets);
                if outcomes.len() != chunk.len() {
                    for item in chunk {
                        record_result(
                            worker,
                            JobEntryResult {
                                label: item.name.clone(),
                                status: "failed".into(),
                                code: "RESULT_MISMATCH".into(),
                                message: Some("批量结果数量与输入不一致，未更新索引".into()),
                            },
                        );
                    }
                    emit_progress(app, worker);
                    continue;
                }
                let mut index_ok: Vec<(&recycle_index::ResolvedItem, ops::NativeOutcome)> =
                    Vec::with_capacity(chunk.len());
                for (item, outcome) in chunk.iter().zip(outcomes) {
                    if outcome.status == "ok" {
                        index_ok.push((item, outcome));
                    } else {
                        record_result(
                            worker,
                            JobEntryResult {
                                label: outcome.target.clone(),
                                status: outcome.status.clone(),
                                code: outcome.code.clone(),
                                message: outcome.message.clone(),
                            },
                        );
                    }
                }
                if !index_ok.is_empty() {
                    let keys: Vec<(String, String)> = index_ok
                        .iter()
                        .map(|(item, _)| (item.bin_root.clone(), item.record_key.clone()))
                        .collect();
                    match db.with_conn(|conn| recycle_index::mark_removed_batch(conn, &keys)) {
                        Ok(_) => {
                            for (_, outcome) in index_ok {
                                record_result(
                                    worker,
                                    JobEntryResult {
                                        label: outcome.target.clone(),
                                        status: outcome.status.clone(),
                                        code: outcome.code.clone(),
                                        message: outcome.message.clone(),
                                    },
                                );
                            }
                        }
                        Err(error) => {
                            // 整批索引写入失败：逐项如实记 partial，并标记该卷对账。
                            for (item, outcome) in index_ok {
                                record_index_failure(
                                    worker,
                                    &db,
                                    &item.bin_root,
                                    &item.volume,
                                    outcome.target.clone(),
                                    error.to_string(),
                                );
                            }
                        }
                    }
                }
                if worker.cancel_requested() {
                    cancelled = true;
                    break;
                }
                emit_progress(app, worker);
            }
            finish(worker, cancelled);
            emit_progress(app, worker);
            emit_job_diagnostic("purge", operation_id.as_deref(), None, worker, started);
        },
    )
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyRequest {
    /// `None` = 全部卷；`Some([...])` = 指定盘符（`D:`）。
    #[serde(default)]
    pub volumes: Option<Vec<String>>,
}

/// 单卷清空后的处置计划（纯数据，便于单测穷举所有分支）。
///
/// Shell 结果与索引更新是**两件独立的事**：Shell 成功 + 索引失败必须表现为
/// 「系统操作已完成、索引更新失败、需要重新对账」，既不是纯失败，也不是成功。
#[derive(Debug, Clone, PartialEq, Eq)]
struct EmptyVolumePlan {
    /// 条目结果状态：ok | failed | skipped | partial
    entry_status: &'static str,
    code: String,
    message: Option<String>,
    /// 该卷缓存已不可信：标记 stale 并请求重新对账。
    mark_reconcile: bool,
    /// 任务整体按「取消」收尾（可能发生在已删除部分条目之后）。
    cancelled: bool,
    /// 覆盖任务级说明（解释不可逆后果，避免被误读为「回滚」）。
    job_message: Option<String>,
}

/// 清空结果 → 处置计划。纯函数：不碰磁盘、不碰数据库，所有分支都可单测。
fn plan_empty_outcome(
    outcome: &crate::recycle::volume::EmptyOutcome,
    reconcile: Option<Result<(), String>>,
) -> EmptyVolumePlan {
    use crate::recycle::volume::EmptyOutcome;
    match outcome {
        // 启动前取消：什么都没发生 —— 不标 stale、不清索引、不谎报成功。
        EmptyOutcome::CancelledBeforeStart => EmptyVolumePlan {
            entry_status: "skipped",
            code: "RECYCLE_CANCELLED".into(),
            message: Some("已在启动前取消，未删除任何项目".into()),
            mark_reconcile: false,
            cancelled: true,
            job_message: Some("清空已在开始前取消，回收站未被修改".into()),
        },
        // 启动后取消：已有批次不可逆，必须重新对账；绝不尝试「恢复」已删除的数据。
        EmptyOutcome::CancelledAfterStart { batches } => EmptyVolumePlan {
            entry_status: "skipped",
            code: "RECYCLE_CANCELLED_AFTER_START".into(),
            message: Some(format!("执行中取消：已确认完成 {batches} 批，其余条目状态未知")),
            mark_reconcile: true,
            cancelled: true,
            job_message: Some("清空已取消：部分项目已永久删除，正在按真实 $I/$R 重新核对".into()),
        },
        EmptyOutcome::Completed => match reconcile {
            Some(Ok(())) => EmptyVolumePlan {
                entry_status: "ok",
                code: "OK".into(),
                message: None,
                mark_reconcile: false,
                cancelled: false,
                job_message: None,
            },
            // 系统操作已经完成：不能记成 Shell 失败，也不能记成成功。
            Some(Err(error)) => EmptyVolumePlan {
                entry_status: "partial",
                code: "INDEX_UPDATE_FAILED".into(),
                message: Some(format!(
                    "系统操作已完成（回收站已清空），但索引更新失败，已标记重新对账：{error}"
                )),
                mark_reconcile: true,
                cancelled: false,
                job_message: Some("系统操作已完成，但索引更新失败，正在重新核对".into()),
            },
            // 不应发生：Completed 必须带对账结果；缺失时按未核实处理，绝不冒充成功。
            None => EmptyVolumePlan {
                entry_status: "failed",
                code: "EMPTY_UNVERIFIED".into(),
                message: Some("清空已完成，但未执行索引对账".into()),
                mark_reconcile: true,
                cancelled: false,
                job_message: Some("清空结果未完成对账，正在按真实 $I/$R 重新核对".into()),
            },
        },
        EmptyOutcome::Failed { code, message } => EmptyVolumePlan {
            entry_status: "failed",
            code: code.clone(),
            message: Some(message.clone()),
            mark_reconcile: true,
            cancelled: false,
            // 失败原因必须进任务级说明：UI 的失败文案会把它展示给用户，
            // 否则只会显示任务创建时的「永久删除，无法恢复」。
            job_message: Some(message.clone()),
        },
        EmptyOutcome::Unverified { code, message, batches } => EmptyVolumePlan {
            entry_status: "failed",
            code: code.clone(),
            message: Some(format!("{message}（已确认 {batches} 批）")),
            // 保留 unverified 语义：不用「失败」断言磁盘没变，也不写成成功。
            mark_reconcile: true,
            cancelled: false,
            job_message: Some("清空结果无法确认，正在按真实 $I/$R 重新核对".into()),
        },
    }
}

/// 清空回收站：逐卷执行、逐卷报告。
///
/// 语义要点（与「取消 = 什么都没发生」的直觉不同，必须如实表达）：
/// - 启动前取消 → 未删除任何项目，缓存保持原样；
/// - 启动后取消 → 已删除的不可恢复，卷标记 stale、index_pending+1，并调度重新扫描；
/// - Shell 成功但索引失败 → 条目 `partial` + `INDEX_UPDATE_FAILED`，不是纯失败；
/// - 结果无法确认（子进程异常退出/超时）→ 保留 `EMPTY_UNVERIFIED` 语义，绝不报成功。
pub fn start_empty(
    app: &AppHandle,
    request: EmptyRequest,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    validate_empty_selection(request.volumes.as_deref())?;
    let recycle = app.state::<Arc<crate::recycle::RecycleService>>().inner().clone();
    let volumes = crate::recycle::volume::bin_volumes()
        .map_err(|(code, message)| AppError::Unavailable(format!("{code}: {message}")))?;
    let selected: Vec<_> = match request.volumes.as_ref() {
        Some(list) => volumes
            .into_iter()
            .filter(|v| list.iter().any(|item| item == &v.volume))
            .collect(),
        _ => volumes,
    };
    if selected.is_empty() {
        return Err(AppError::NotFound("没有可清空的回收站".into()));
    }
    let total = selected.len();
    submit(
        app,
        JobSpec {
            kind: "empty",
            total,
            message: Some("永久删除，无法恢复".into()),
            cancelable: true,
        },
        move |app, worker| {
            let started = std::time::Instant::now();
            let claims = recycle_claims();
            let job_id = worker.snapshot().id;
            let _guard = ClaimsGuard { claims, job_id: job_id.clone() };
            let mut cancelled = false;
            let mut needs_resync = false;
            for volume in selected {
                if worker.cancel_requested() {
                    cancelled = true;
                    break;
                }
                let bin_root = volume.root.to_string_lossy().into_owned();
                // 卷级占用：该卷任何条目操作都会拒绝整卷清空，反之亦然。
                if let Some(conflict) =
                    claims.try_claim_volume(volume_claim_key(&bin_root), &job_id, "empty")
                {
                    record_result(
                        worker,
                        JobEntryResult {
                            label: volume.volume.clone(),
                            status: "failed".into(),
                            code: if conflict.volume_wide { "RECYCLE_VOLUME_BUSY" } else { "RECYCLE_ENTRY_BUSY" }.into(),
                            message: Some(if conflict.volume_wide {
                                format!("该磁盘正在被其他任务（{}）清空，本次未执行", conflict.holder)
                            } else {
                                format!("该磁盘仍有其他任务（{}）在处理条目，本次未执行清空", conflict.holder)
                            }),
                        },
                    );
                    emit_progress(app, worker);
                    continue;
                }
                let outcome = crate::recycle::volume::empty_recycle_bin(&volume, || {
                    worker.cancel_requested()
                });
                let reconcile = if matches!(outcome, crate::recycle::volume::EmptyOutcome::Completed) {
                    Some(recycle.reconcile_empty(&volume).map_err(|error| error.to_string()))
                } else {
                    None
                };
                let plan = plan_empty_outcome(&outcome, reconcile);
                if plan.mark_reconcile {
                    let marked = recycle.mark_reconcile(&[crate::recycle::ReconcileTarget {
                        bin_root: bin_root.clone(),
                        volume: volume.volume.clone(),
                        code: plan.code.clone(),
                    }]);
                    worker.update(|snapshot| snapshot.index_pending += marked);
                    needs_resync = true;
                }
                record_result(
                    worker,
                    JobEntryResult {
                        label: volume.volume.clone(),
                        status: plan.entry_status.into(),
                        code: plan.code,
                        message: plan.message,
                    },
                );
                if let Some(message) = plan.job_message {
                    worker.update(|snapshot| snapshot.message = Some(message));
                }
                if plan.cancelled {
                    cancelled = true;
                    emit_progress(app, worker);
                    break;
                }
                emit_progress(app, worker);
            }
            if needs_resync {
                // 不在扫描进行中并发启动第二个扫描：服务端会登记「收尾后补扫」。
                recycle.request_resync(app);
            }
            finish(worker, cancelled);
            emit_progress(app, worker);
            emit_job_diagnostic("empty", operation_id.as_deref(), None, worker, started);
        },
    )
}

/// null 才代表全部卷；空选择绝不能意外扩大为永久清空全部。
fn validate_empty_selection(volumes: Option<&[String]>) -> AppResult<()> {
    if volumes.is_some_and(|items| items.is_empty()) {
        return Err(AppError::Validation("未选择要清空的回收站卷".into()));
    }
    Ok(())
}

/// 工作篮写入任务的一条：文本或「复制已有文件」到固定目标路径。
///
/// 目标路径由上层（`transfer::execute`）用
/// [`crate::file_workspace::resolve_write_target`] 校验目录、清洗名称、按冲突策略解析，
/// 这里只做落盘与逐条结果，不重复冲突命名逻辑。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteEntry {
    /// 工作篮条目 id（写入结果按此回写状态，不用文件名做键）。
    pub item_id: String,
    /// 展示名（事件/报告中不出现完整路径）。
    pub label: String,
    /// 绝对目标路径（含文件名）。
    pub target: String,
    /// 文本内容（`text` 与 `copyFrom` 二选一）。
    #[serde(default)]
    pub text: Option<String>,
    /// 复制源（图片缓存或用户文件）。
    #[serde(default)]
    pub copy_from: Option<String>,
    /// 目标已存在时是否覆盖（`false` 时如实报告 skipped，不静默改名）。
    #[serde(default)]
    pub overwrite: bool,
    /// 该条是否为「合并文本」等无法逐条撤销的写入（仅用于报告文案）。
    #[serde(default)]
    pub merged: bool,
}

fn write_error_code(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "FS_OP_SOURCE_MISSING",
        std::io::ErrorKind::PermissionDenied => "FS_OP_ACCESS_DENIED",
        std::io::ErrorKind::AlreadyExists => "FS_OP_CONFLICT",
        _ => match error.raw_os_error() {
            Some(32) | Some(33) => "FS_OP_FILE_BUSY",
            Some(112) => "FS_OP_IO",
            _ => "FS_OP_IO",
        },
    }
}

/// 原子替换：同目录临时文件写透后再替换目标。
///
/// - 临时文件与目标同目录 → 同卷，`MoveFileExW(REPLACE_EXISTING)` 才是原子替换；
/// - 先 `sync_all`，磁盘满/写入中断只会留下临时文件，不会截断旧文件；
/// - 替换失败保留原文件（绝不像旧实现那样先 `remove_file` 再 rename）；
/// - 任何失败都清理临时文件，不留 `.tdpart-*` 残留。
fn replace_with_temp(temp: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain([0]).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain([0]).collect();
        unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), MOVEFILE_REPLACE_EXISTING) }
            .map_err(|e| std::io::Error::other(format!("替换目标文件失败: {e}")))
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(temp, target)
    }
}

/// 写文本 / 复制来源到目标路径：临时文件 → 写透 → 原子替换。
fn write_atomic(
    target: &std::path::Path,
    text: Option<&str>,
    copy_from: Option<&std::path::Path>,
) -> std::io::Result<()> {
    use std::io::Write;

    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目标没有父目录"))?;
    let base = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "write".into());
    let temp = parent.join(format!(".{base}.tdpart-{}", uuid::Uuid::new_v4()));

    let result = (|| -> std::io::Result<()> {
        if let Some(body) = text {
            let mut file = std::fs::File::create(&temp)?;
            file.write_all(body.as_bytes())?;
            file.sync_all()?;
        } else if let Some(source) = copy_from {
            std::fs::copy(source, &temp)?;
            // FlushFileBuffers 需要写句柄：只读打开会返回 ERROR_ACCESS_DENIED。
            std::fs::OpenOptions::new()
                .write(true)
                .open(&temp)?
                .sync_all()?;
            // 拷贝完整性校验：大小不一致视为失败，绝不替换目标。
            let expected = std::fs::metadata(source)?.len();
            let actual = std::fs::metadata(&temp)?.len();
            if expected != actual {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("临时文件大小不一致（{actual}/{expected}）"),
                ));
            }
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "没有可写入的内容",
            ));
        }
        replace_with_temp(&temp, target)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn write_one(entry: &WriteEntry, cancelled: &dyn Fn() -> bool) -> crate::file_workspace::FsEntryReport {
    use crate::file_workspace::FsEntryReport;
    let mut report = FsEntryReport {
        source: entry.item_id.clone(),
        target: Some(entry.target.clone()),
        status: "failed",
        reason: None,
        code: None,
        stage: Some("prepare".into()),
    };
    if cancelled() {
        report.reason = Some("已取消，未执行".into());
        report.code = Some("FS_OP_CANCELLED".into());
        report.status = "skipped";
        return report;
    }
    let target = std::path::Path::new(&entry.target);
    let Some(parent) = target.parent() else {
        report.reason = Some("目标路径没有父目录".into());
        report.code = Some("FS_OP_VALIDATION".into());
        return report;
    };
    if !parent.is_dir() {
        report.reason = Some("目标目录不存在或不可访问".into());
        report.code = Some("FS_OP_TARGET_MISSING".into());
        return report;
    }
    if target.file_name().is_none() {
        report.reason = Some("目标缺少文件名".into());
        report.code = Some("FS_OP_VALIDATION".into());
        return report;
    }
    if target.exists() {
        if !entry.overwrite {
            report.status = "skipped";
            report.reason = Some("目标已存在，按跳过策略未覆盖".into());
            report.code = Some("FS_OP_CONFLICT".into());
            return report;
        }
        if target.is_dir() {
            report.reason = Some("目标已存在且是目录，不能用文件覆盖".into());
            report.code = Some("FS_OP_CONFLICT".into());
            return report;
        }
        // 覆盖前先清只读属性：Windows 下只读文件无法直接截断写。
        if let Ok(meta) = std::fs::metadata(target) {
            let mut perms = meta.permissions();
            if perms.readonly() {
                #[allow(clippy::permissions_set_readonly_false)]
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(target, perms);
            }
        }
    }
    report.stage = Some("write".into());
    let source_path = entry.copy_from.as_deref().map(std::path::Path::new);
    if let Some(source) = source_path {
        if !source.is_file() {
            report.reason = Some("来源文件不存在".into());
            report.code = Some("FS_OP_SOURCE_MISSING".into());
            return report;
        }
    }
    // 文本与图片复制都走「同目录临时文件 + 写透 + 原子替换」：
    // 覆盖过程中不会出现截断的旧文件，替换失败也保留原文件。
    let result = write_atomic(target, entry.text.as_deref(), source_path);
    match result {
        Ok(_) => {
            report.status = "ok";
            report.code = Some("OK".into());
            report.reason = None;
            report.stage = None;
        }
        Err(e) => {
            report.code = Some(write_error_code(&e).into());
            report.reason = Some(format!("写入失败: {e}"));
        }
    }
    report
}

/// 工作篮写入任务：逐条独立落盘，条目间可取消，部分成功如实报告。
pub fn start_write(
    app: &AppHandle,
    entries: Vec<WriteEntry>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    if entries.is_empty() {
        return Err(AppError::Validation("没有要写入的内容".into()));
    }
    if entries.len() > crate::file_workspace::MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            crate::file_workspace::MAX_OP_PATHS
        )));
    }
    submit(
        app,
        JobSpec {
            kind: "write",
            total: entries.len(),
            message: None,
            cancelable: true,
        },
        move |app, worker| {
            let started = std::time::Instant::now();
            let mut report = crate::file_workspace::FsOpReport {
                operation_id: operation_id
                    .clone()
                    .unwrap_or_else(|| worker.snapshot().id),
                attempted: entries.len(),
                ok: 0,
                failed: 0,
                skipped: 0,
                partial: 0,
                entries: Vec::new(),
            };
            let last_emit = std::cell::Cell::new(std::time::Instant::now());
            for entry in &entries {
                if worker.cancel_requested() {
                    let skipped = crate::file_workspace::FsEntryReport {
                        source: entry.item_id.clone(),
                        target: Some(entry.target.clone()),
                        status: "skipped",
                        reason: Some("已取消，未执行".into()),
                        code: Some("FS_OP_CANCELLED".into()),
                        stage: Some("prepare".into()),
                    };
                    report.skipped += 1;
                    report.entries.push(skipped.clone());
                    record_result(worker, entry_of(&skipped));
                    continue;
                }
                let result = write_one(entry, &|| worker.cancel_requested());
                match result.status {
                    "ok" => report.ok += 1,
                    "skipped" => report.skipped += 1,
                    _ => report.failed += 1,
                }
                record_result(worker, entry_of(&result));
                report.entries.push(result);
                if last_emit.get().elapsed() >= std::time::Duration::from_millis(100) {
                    emit_progress(app, worker);
                    last_emit.set(std::time::Instant::now());
                }
            }
            *worker.inner.report.lock().unwrap_or_else(|e| e.into_inner()) = Some(report);
            finish(worker, worker.cancel_requested());
            emit_progress(app, worker);
            emit_job_diagnostic("write", operation_id.as_deref(), None, worker, started);
        },
    )
}

#[cfg(test)]
pub(crate) fn write_one_for_test(entry: &WriteEntry) -> crate::file_workspace::FsEntryReport {
    write_one(entry, &|| false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_one_really_writes_text_and_copies_without_app_handle() {
        let dir = std::env::temp_dir().join(format!("taskdock-write-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let text_target = dir.join("a.txt").to_string_lossy().to_string();
        let entry = WriteEntry {
            item_id: "i1".into(),
            label: "文本".into(),
            target: text_target.clone(),
            text: Some("真实写入内容".into()),
            copy_from: None,
            overwrite: false,
            merged: false,
        };
        let report = write_one_for_test(&entry);
        assert_eq!(report.status, "ok", "{}", report.reason.unwrap_or_default());
        assert_eq!(std::fs::read_to_string(&text_target).unwrap(), "真实写入内容");

        let source = dir.join("src.txt");
        std::fs::write(&source, "复制来源").unwrap();
        let copy_target = dir.join("b.txt").to_string_lossy().to_string();
        let copy = WriteEntry {
            item_id: "i2".into(),
            label: "复制".into(),
            target: copy_target.clone(),
            text: None,
            copy_from: Some(source.to_string_lossy().to_string()),
            overwrite: false,
            merged: false,
        };
        let report = write_one_for_test(&copy);
        assert_eq!(report.status, "ok", "{}", report.reason.unwrap_or_default());
        assert_eq!(std::fs::read_to_string(&copy_target).unwrap(), "复制来源");

        let conflict = write_one_for_test(&entry);
        assert_eq!(conflict.status, "skipped");
        assert_eq!(conflict.code.as_deref(), Some("FS_OP_CONFLICT"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backend_continuation_empty_selection_cannot_empty_all_volumes() {
        assert!(validate_empty_selection(Some(&[])).is_err());
        assert!(validate_empty_selection(None).is_ok());
        assert!(validate_empty_selection(Some(&["C:".into()])).is_ok());
    }

    fn make_handle(kind: &'static str, total: usize) -> JobHandle {
        new_handle(JobSpec {
            kind,
            total,
            message: None,
            cancelable: true,
        })
    }

    const BIN_C: &str = r"C:\$Recycle.Bin\S-1-5-21-1";
    const BIN_D: &str = r"D:\$Recycle.Bin\S-1-5-21-1";

    /// §4.2 并发测试矩阵：条目 ↔ 条目、条目 ↔ 整卷、跨卷互不影响。
    #[test]
    fn layered_claims_match_the_volume_entry_conflict_matrix() {
        let claims = RecycleClaims::new();
        // D 盘 A 条目被恢复任务占用。
        assert_eq!(claims.try_claim_entry(BIN_D, "A", "job-1", "restore"), None);
        // 同条目：恢复 / 永久删除都拒绝，并回报占用方类型。
        assert_eq!(
            claims.try_claim_entry(BIN_D, "A", "job-2", "restore"),
            Some(ClaimConflict { holder: "restore", volume_wide: false })
        );
        assert_eq!(
            claims.try_claim_entry(BIN_D, "A", "job-3", "purge"),
            Some(ClaimConflict { holder: "restore", volume_wide: false })
        );
        // D 盘清空：该卷存在条目操作 → 拒绝。
        assert_eq!(
            claims.try_claim_volume(BIN_D, "job-4", "empty"),
            Some(ClaimConflict { holder: "restore", volume_wide: false })
        );
        // 同卷不同条目、不同卷同条目都允许。
        assert_eq!(claims.try_claim_entry(BIN_D, "B", "job-5", "purge"), None);
        assert_eq!(claims.try_claim_entry(BIN_C, "A", "job-6", "restore"), None);
    }

    /// 先清空再操作条目：同卷条目一律拒绝，其余卷仍可并行。
    #[test]
    fn volume_claim_blocks_entries_on_the_same_disk_only() {
        let claims = RecycleClaims::new();
        assert_eq!(claims.try_claim_volume(BIN_D, "job-empty", "empty"), None);
        assert_eq!(
            claims.try_claim_entry(BIN_D, "A", "job-r", "restore"),
            Some(ClaimConflict { holder: "empty", volume_wide: true })
        );
        assert_eq!(
            claims.try_claim_entry(BIN_D, "B", "job-p", "purge"),
            Some(ClaimConflict { holder: "empty", volume_wide: true })
        );
        assert_eq!(
            claims.try_claim_volume(BIN_D, "job-empty-2", "empty"),
            Some(ClaimConflict { holder: "empty", volume_wide: true })
        );
        // 另一个卷不受影响（不做全局串行）。
        assert_eq!(claims.try_claim_entry(BIN_C, "A", "job-c", "restore"), None);
        // 但 C 盘此时也有在途条目：C 盘清空同样被拒绝（卷级检查对任何卷都成立）。
        assert_eq!(
            claims.try_claim_volume(BIN_C, "job-c-empty", "empty"),
            Some(ClaimConflict { holder: "restore", volume_wide: false })
        );
        claims.release_job("job-c");
        assert_eq!(claims.try_claim_volume(BIN_C, "job-c-empty", "empty"), None);
    }

    /// 同一任务内部重复声明（多次提交同一个 ID）不得自我冲突。
    #[test]
    fn repeated_claims_by_the_same_job_are_idempotent() {
        let claims = RecycleClaims::new();
        for _ in 0..3 {
            assert_eq!(claims.try_claim_entry(BIN_D, "A", "job-1", "restore"), None);
        }
        assert_eq!(claims.active(), 1, "重复声明只登记一条");

        let claims = RecycleClaims::new();
        assert!(claims.try_claim_volume(BIN_D, "job-1", "empty").is_none());
        assert!(claims.try_claim_volume(BIN_D, "job-1", "empty").is_none());
        assert!(claims.try_claim_entry(BIN_D, "A", "job-1", "empty").is_none());
        assert_eq!(claims.active(), 1, "整卷占用已覆盖该卷全部条目");
    }

    /// 多线程同时竞争同一条目：只允许一个赢家。
    #[test]
    fn concurrent_claims_admit_exactly_one_winner() {
        let claims: &'static RecycleClaims = Box::leak(Box::new(RecycleClaims::new()));
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    claims
                        .try_claim_entry(BIN_D, "A", &format!("job-{index}"), "restore")
                        .is_none()
                })
            })
            .collect();
        let winners = threads
            .into_iter()
            .map(|handle| usize::from(handle.join().unwrap()))
            .sum::<usize>();
        assert_eq!(winners, 1, "并发声明必须只有一个成功");
        assert_eq!(claims.active(), 1);
        for index in 0..8 {
            claims.release_job(&format!("job-{index}"));
        }
        assert_eq!(claims.active(), 0);
    }

    /// 正常结束 / 中途取消 / worker panic：占用都必须释放。
    #[test]
    fn claims_are_released_on_finish_cancel_and_panic() {
        let claims: &'static RecycleClaims = Box::leak(Box::new(RecycleClaims::new()));
        {
            let _guard = ClaimsGuard { claims, job_id: "job-finish".into() };
            assert!(claims.try_claim_entry(BIN_D, "A", "job-finish", "restore").is_none());
        }
        assert_eq!(claims.active(), 0);

        {
            let _guard = ClaimsGuard { claims, job_id: "job-cancel".into() };
            assert!(claims.try_claim_entry(BIN_D, "A", "job-cancel", "purge").is_none());
            assert!(claims.try_claim_volume(BIN_C, "job-cancel", "empty").is_none());
        }
        assert_eq!(claims.active(), 0, "取消路径必须释放条目与卷两类占用");

        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = ClaimsGuard { claims, job_id: "job-panic".into() };
            assert!(claims.try_claim_volume(BIN_D, "job-panic", "empty").is_none());
            panic!("worker 异常退出");
        }));
        std::panic::set_hook(previous);
        assert!(panicked.is_err());
        assert_eq!(claims.active(), 0, "panic 展开必须释放占用");
        assert!(
            claims.try_claim_volume(BIN_D, "job-after", "empty").is_none(),
            "释放后其他任务必须能取得整卷"
        );
        claims.release_job("job-after");
    }

    /// 清空结果 → 处置计划：启动前/启动后取消语义完全不同。
    #[test]
    fn empty_plan_distinguishes_cancel_before_start_from_cancel_after_start() {
        use crate::recycle::volume::EmptyOutcome;

        let before = plan_empty_outcome(&EmptyOutcome::CancelledBeforeStart, None);
        assert_eq!(before.entry_status, "skipped");
        assert!(!before.mark_reconcile, "启动前取消不得把缓存标成失效");
        assert!(before.cancelled);
        assert!(before.job_message.unwrap().contains("未被修改"));

        for batches in [0usize, 1, 9] {
            let after = plan_empty_outcome(&EmptyOutcome::CancelledAfterStart { batches }, None);
            assert_eq!(after.code, "RECYCLE_CANCELLED_AFTER_START");
            assert!(after.mark_reconcile, "启动后取消必须按真实 $I/$R 重新对账");
            assert!(after.cancelled);
            assert_ne!(after.entry_status, "ok", "已发生删除的取消不是成功");
            assert!(after.message.unwrap().contains(&batches.to_string()));
        }
    }

    /// Shell 结果与 SQLite 更新必须分开表达。
    #[test]
    fn empty_plan_separates_shell_result_from_index_update() {
        use crate::recycle::volume::EmptyOutcome;

        let ok = plan_empty_outcome(&EmptyOutcome::Completed, Some(Ok(())));
        assert_eq!((ok.entry_status, ok.code.as_str()), ("ok", "OK"));
        assert!(!ok.mark_reconcile);

        let index_failed = plan_empty_outcome(&EmptyOutcome::Completed, Some(Err("db locked".into())));
        assert_eq!(index_failed.entry_status, "partial", "系统操作已完成，不能记成 Shell 失败");
        assert_eq!(index_failed.code, "INDEX_UPDATE_FAILED");
        assert!(index_failed.mark_reconcile, "索引失败必须触发重新对账");

        let failed = plan_empty_outcome(
            &EmptyOutcome::Failed { code: "EMPTY_REMAINS".into(), message: "仍有条目".into() },
            None,
        );
        assert_eq!(failed.entry_status, "failed");
        assert!(failed.mark_reconcile);

        let unverified = plan_empty_outcome(
            &EmptyOutcome::Unverified {
                code: "EMPTY_UNVERIFIED".into(),
                message: "无法核对清空结果".into(),
                batches: 2,
            },
            None,
        );
        assert_eq!(unverified.entry_status, "failed");
        assert_eq!(unverified.code, "EMPTY_UNVERIFIED", "未核实必须有独立稳定码");
        assert!(unverified.mark_reconcile);
        assert!(unverified.message.as_deref().unwrap_or_default().contains('2'));
        assert!(unverified.job_message.is_some(), "UI 必须被告知结果待核对");
    }

    /// 进程异常退出（子进程被杀）也不得被当成成功。
    #[test]
    fn empty_plan_never_reports_success_for_unknown_outcomes() {
        use crate::recycle::volume::EmptyOutcome;
        for outcome in [
            EmptyOutcome::CancelledBeforeStart,
            EmptyOutcome::CancelledAfterStart { batches: 0 },
            EmptyOutcome::Unverified {
                code: "EMPTY_UNVERIFIED".into(),
                message: "清空子进程异常退出".into(),
                batches: 4,
            },
            EmptyOutcome::Completed,
        ] {
            let plan = plan_empty_outcome(&outcome, None);
            assert_ne!(
                (plan.entry_status, plan.code.as_str()),
                ("ok", "OK"),
                "缺少对账结果的 {outcome:?} 不得报成功"
            );
        }
    }

    #[test]
    fn wait_terminal_wakes_on_finish_and_times_out_otherwise() {
        let handle = make_handle("purge", 1);
        assert!(!handle.wait_terminal(std::time::Duration::from_millis(20)));
        let waiter = handle.clone();
        let thread = std::thread::spawn(move || {
            waiter.wait_terminal(std::time::Duration::from_secs(2))
        });
        std::thread::sleep(std::time::Duration::from_millis(20));
        finish(&handle, false);
        assert!(thread.join().unwrap());
        assert!(handle.is_terminal());
    }

    #[test]
    fn index_write_failure_is_reported_as_partial_not_success() {
        let handle = make_handle("purge", 1);
        record_result(&handle, JobEntryResult {
            label: "a.txt".into(),
            status: "partial".into(),
            code: "INDEX_UPDATE_FAILED".into(),
            message: Some("索引更新失败".into()),
        });
        handle.update(|snapshot| snapshot.index_pending += 1);
        finish(&handle, false);
        let snapshot = handle.snapshot();
        assert_eq!(snapshot.status, "partial");
        assert_eq!(snapshot.index_pending, 1);
        assert_eq!(snapshot.ok, 0);
    }

    #[test]
    fn copy_move_diagnostic_carries_worker_trace_unchanged() {
        // worker 闭包按值捕获命令层解析后的 trace_id，纯构造边界断言：
        // 同一 trace 原样进入复制/移动的终态诊断事件，不重生成、不串号。
        let trace = crate::diagnostics::trace::new_trace_id();
        for kind in ["copy", "move"] {
            let handle = make_handle(kind, 1);
            let event = build_job_diagnostic(
                kind,
                Some("op-1"),
                Some(&trace),
                &handle,
                std::time::Instant::now(),
            );
            assert_eq!(event.action, kind);
            assert_eq!(event.operation_id.as_deref(), Some("op-1"));
            assert_eq!(event.trace_id.as_deref(), Some(trace.as_str()));
        }
    }

    #[test]
    fn diagnostic_without_trace_leaves_trace_empty() {
        // None（旧调用方不传）：事件不挂链路，行为与旧版一致。
        let handle = make_handle("copy", 1);
        let event = build_job_diagnostic("copy", None, None, &handle, std::time::Instant::now());
        assert!(event.trace_id.is_none());
    }

    #[test]
    fn backend_round2_streamed_transfer_report_does_not_count_twice() {
        let handle = make_handle("copy", 1);
        let entry = crate::file_workspace::FsEntryReport {
            source: "source".into(), target: Some("target".into()), status: "ok",
            reason: None, code: None, stage: None,
        };
        record_result(&handle, entry_of(&entry));
        record_transfer_report(&handle, Ok(crate::file_workspace::FsOpReport {
            operation_id: "stream".into(), attempted: 1, ok: 1, failed: 0, skipped: 0,
            partial: 0, entries: vec![entry],
        }), &[], None);
        finish(&handle, false);
        assert_eq!((handle.snapshot().done, handle.snapshot().ok), (1,1));
        assert_eq!(handle.snapshot().status, "completed");
        assert_eq!(handle.report().unwrap().entries.len(), 1);
    }

    #[test]
    fn failure_entries_are_bounded() {
        let handle = make_handle("purge", 1000);
        for i in 0..(MAX_FAILURES + 50) {
            record_result(
                &handle,
                JobEntryResult {
                    label: format!("f{i}"),
                    status: "failed".into(),
                    code: "X".into(),
                    message: None,
                },
            );
        }
        let snapshot = handle.snapshot();
        assert_eq!(snapshot.failed, MAX_FAILURES + 50);
        assert_eq!(snapshot.done, MAX_FAILURES + 50);
        assert_eq!(snapshot.failures.len(), MAX_FAILURES);
    }

    #[test]
    fn partial_status_counts_partial_entries() {
        let handle = make_handle("move", 2);
        record_result(
            &handle,
            JobEntryResult {
                label: "a".into(),
                status: "partial".into(),
                code: "FS_OP_MULTI_FAILURE".into(),
                message: None,
            },
        );
        record_result(
            &handle,
            JobEntryResult {
                label: "b".into(),
                status: "ok".into(),
                code: "OK".into(),
                message: None,
            },
        );
        finish(&handle, false);
        let snapshot = handle.snapshot();
        assert_eq!(snapshot.partial, 1);
        assert_eq!(snapshot.status, "partial");
        assert!(!snapshot.cancelable);
    }

    #[test]
    fn unfinished_job_is_not_reported_as_completed() {
        let handle = make_handle("delete", 10);
        handle.update(|s| s.ok = 5);
        finish(&handle, false);
        let snapshot = handle.snapshot();
        assert_eq!(snapshot.status, "partial");
        assert!(snapshot.message.is_some(), "必须说明未跑完");
    }

    #[test]
    fn finish_state_reflects_partial_and_cancel() {
        let handle = make_handle("delete", 10);
        handle.update(|s| {
            s.ok = 5;
            s.failed = 1;
            s.done = 6;
        });
        finish(&handle, false);
        let snapshot = handle.snapshot();
        assert_eq!(snapshot.status, "partial");
        assert!(!snapshot.cancelable);

        let handle = make_handle("delete", 10);
        finish(&handle, true);
        assert_eq!(handle.snapshot().status, "cancelled");
    }

    #[test]
    fn cancel_sets_flag_and_snapshot_field() {
        let handle = make_handle("delete", 10);
        assert!(!handle.cancel_requested());
        assert!(handle.cancel());
        assert!(handle.cancel_requested());
        assert!(handle.snapshot().cancel_requested);
        assert_eq!(handle.snapshot().status, "cancelled");
        // 终态任务不可再次取消。
        assert!(!handle.cancel());
    }

    #[test]
    fn running_non_cancelable_job_refuses_cancel() {
        let handle = new_handle(JobSpec {
            kind: "copy",
            total: 3,
            message: None,
            cancelable: false,
        });
        assert!(handle.snapshot().cancelable, "排队中的复制仍可取消");
        handle.begin_running(false);
        assert!(!handle.cancel(), "复制执行中不得谎称可取消");
        assert!(!handle.snapshot().cancel_requested);
        assert_eq!(handle.snapshot().status, "running");
    }

    #[test]
    fn backend_continuation_cancelled_job_cannot_be_restarted() {
        let handle = make_handle("delete", 1);
        assert!(!handle.cancel_requested());
        assert!(handle.cancel());
        // worker 的排队检查刚结束后发生取消，仍不能重新进入 running。
        handle.begin_running(true);
        assert_eq!(handle.snapshot().status, "cancelled");
        assert!(!handle.snapshot().cancelable);
    }

    #[test]
    fn backend_continuation_transfer_report_keeps_paths_and_real_results() {
        let root = std::env::temp_dir().join(format!("td-transfer-report-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let target = root.join("target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.join("a.txt"), b"source").unwrap();
        std::fs::write(target.join("a.txt"), b"existing").unwrap();
        std::fs::write(source.join("b.txt"), b"new").unwrap();
        let paths = vec![source.join("a.txt").to_string_lossy().into_owned(),
            source.join("missing.txt").to_string_lossy().into_owned(),
            source.join("b.txt").to_string_lossy().into_owned()];
        let handle = make_handle("copy", paths.len());
        assert!(handle.report().is_none());
        let result = crate::file_workspace::copy_paths(
            &paths, &target, crate::file_workspace::parse_conflict("skip").unwrap(),
            Some("report-fixture".into()), &[],
        );
        record_transfer_report(&handle, result, &paths, Some("report-fixture"));
        finish(&handle, false);
        let report = handle.report().unwrap();
        assert_eq!((report.ok, report.failed, report.skipped), (1, 1, 1));
        assert_eq!(report.operation_id, "report-fixture");
        assert_eq!(report.entries.iter().map(|e| &e.source).collect::<Vec<_>>(), paths.iter().collect::<Vec<_>>());
        assert_eq!(report.entries[2].target.as_deref(), Some(target.join("b.txt").to_str().unwrap()));
        assert_eq!(handle.snapshot().status, "partial");
        assert_eq!(std::fs::read(target.join("a.txt")).unwrap(), b"existing");
        assert_eq!(std::fs::read(target.join("b.txt")).unwrap(), b"new");
        for path in [source.join("a.txt"), source.join("b.txt"), target.join("a.txt"), target.join("b.txt")] {
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_dir(source).unwrap();
        std::fs::remove_dir(target).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn backend_continuation_transfer_preflight_error_is_a_full_failed_report() {
        let handle = make_handle("move", 2);
        let paths = vec!["source-a".into(), "source-b".into()];
        record_transfer_report(&handle, Err(AppError::Validation("invalid target".into())), &paths, None);
        finish(&handle, false);
        let report = handle.report().unwrap();
        assert_eq!(report.operation_id, handle.snapshot().id);
        assert_eq!(report.failed, 2);
        assert_eq!(report.entries.len(), 2);
        assert!(report.entries.iter().all(|e| e.status == "failed" && e.stage.as_deref() == Some("prepare")));
        assert_eq!(handle.snapshot().status, "failed");
    }

    #[test]
    fn registry_never_evicts_running_jobs() {
        let registry = JobRegistry::new();
        let running = make_handle("delete", 10);
        running.begin_running(true);
        let running_id = registry.insert(running);
        for _ in 0..(MAX_HISTORY + 5) {
            let terminal = make_handle("purge", 1);
            terminal.update(|s| {
                s.status = "completed".into();
                s.finished_ms = 1;
            });
            registry.insert(terminal);
        }
        assert!(
            registry.get(&running_id).is_some(),
            "运行中的任务不得被历史任务挤出注册表"
        );
        let snapshots = registry.snapshots();
        assert!(snapshots.iter().any(|s| s.id == running_id));
        assert!(
            snapshots.len() <= MAX_HISTORY + 1,
            "终态历史应收敛到上限（运行中任务除外），实际 {}",
            snapshots.len()
        );
    }

    #[test]
    fn registry_snapshots_are_sorted_newest_first() {
        let registry = JobRegistry::new();
        for _ in 0..3 {
            let job = make_handle("delete", 1);
            job.update(|s| s.started_ms = chrono::Utc::now().timestamp_millis());
            registry.insert(job);
        }
        let snapshots = registry.snapshots();
        assert_eq!(snapshots.len(), 3);
        for pair in snapshots.windows(2) {
            assert!(pair[0].started_ms >= pair[1].started_ms);
        }
    }
}

#[cfg(test)]
mod atomic_write_tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("taskdock-atomic-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(target: &std::path::Path, text: Option<&str>, copy_from: Option<&str>, overwrite: bool) -> WriteEntry {
        WriteEntry {
            item_id: "i1".into(),
            label: "x".into(),
            target: target.to_string_lossy().to_string(),
            text: text.map(|s| s.to_string()),
            copy_from: copy_from.map(|s| s.to_string()),
            overwrite,
            merged: false,
        }
    }

    #[test]
    fn overwrite_replaces_content_and_leaves_no_temp_files() {
        let dir = temp_dir("replace");
        let target = dir.join("a.txt");
        std::fs::write(&target, "旧内容").unwrap();
        let report = write_one_for_test(&entry(&target, Some("新内容"), None, true));
        assert_eq!(report.status, "ok", "{}", report.reason.unwrap_or_default());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "新内容");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("tdpart"))
            .collect();
        assert!(leftovers.is_empty(), "临时文件必须清理：{leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failed_copy_keeps_original_file_untouched() {
        let dir = temp_dir("keep");
        let target = dir.join("a.txt");
        std::fs::write(&target, "原始内容").unwrap();
        // 来源不存在 + overwrite：必须失败并保留原文件（旧实现会先删再写）。
        let report = write_one_for_test(&entry(
            &target,
            None,
            Some(&dir.join("missing.png").to_string_lossy()),
            true,
        ));
        assert_eq!(report.status, "failed");
        assert_eq!(report.code.as_deref(), Some("FS_OP_SOURCE_MISSING"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "原始内容");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skipped_when_target_exists_without_overwrite() {
        let dir = temp_dir("skip");
        let target = dir.join("a.txt");
        std::fs::write(&target, "保留").unwrap();
        let report = write_one_for_test(&entry(&target, Some("覆盖？"), None, false));
        assert_eq!(report.status, "skipped");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "保留");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copy_source_writes_identical_bytes() {
        let dir = temp_dir("copy");
        let source = dir.join("src.bin");
        let payload: Vec<u8> = (0..2048u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&source, &payload).unwrap();
        let target = dir.join("dst.bin");
        let report = write_one_for_test(&entry(
            &target,
            None,
            Some(&source.to_string_lossy()),
            false,
        ));
        assert_eq!(report.status, "ok", "{}", report.reason.unwrap_or_default());
        assert_eq!(std::fs::read(&target).unwrap(), payload);
        std::fs::remove_dir_all(&dir).ok();
    }
}
