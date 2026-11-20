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
}

struct JobInner {
    snapshot: Mutex<JobSnapshot>,
    /// 完整路径只供按需 IPC 查询，不放入广播事件；最多 500 项，随任务历史淘汰。
    report: Mutex<Option<crate::file_workspace::FsOpReport>>,
    cancel: AtomicBool,
    executing_cancelable: bool,
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
        f(&mut guard);
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
                    (job.work)(&scheduler.app, &job.handle);
                    if !job.handle.is_terminal() {
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
            }),
            cancel: AtomicBool::new(false),
            executing_cancelable: spec.cancelable,
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
            emit_job_diagnostic("delete", operation_id.as_deref(), None, worker, started);
        },
    )
}

/// 复制任务（无链路标识的兼容入口，供工作篮等旧调用方使用）。
pub fn start_copy(
    app: &AppHandle,
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

/// 恢复任务：从回收站恢复到原位置。成功后同步移除索引记录。
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
    if resolved.is_empty() {
        return Err(AppError::NotFound("回收站索引中没有这些项目，请先同步".into()));
    }
    // 恢复只允许完整存在的项目；缺数据/损坏/孤儿由服务端再兜底拒绝，
    // 不能只依赖前端过滤（IPC 可被直接调用）。
    if resolved.iter().any(|item| item.state != "present") {
        return Err(AppError::Validation(
            "所选项目包含缺少数据或损坏的条目，请刷新回收站列表后重试".into(),
        ));
    }
    let protected = protected_dirs(app);
    for item in &resolved {
        let target = crate::file_workspace::validate_abs_path(&item.original_path)?;
        crate::file_workspace::ensure_not_protected(&target, &protected)?;
    }
    let total = resolved.len();
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
            let mut cancelled = false;
            for chunk in resolved.chunks(NATIVE_BATCH) {
                if worker.cancel_requested() {
                    cancelled = true;
                    break;
                }
                let targets: Vec<NativeTarget> = chunk
                    .iter()
                    .map(|item| NativeTarget {
                        name: item.name.clone(),
                        data_path: format!("{}\\$R{}", item.bin_root, item.record_key),
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
                for (item, outcome) in chunk.iter().zip(outcomes) {
                    if outcome.status == "ok" {
                        let _ = db.with_conn(|conn| {
                            recycle_index::mark_restored(
                                conn,
                                &item.bin_root,
                                &item.record_key,
                            )
                        });
                    }
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

/// 永久删除回收站项目。成功后同步移除索引记录。
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
    if resolved.is_empty() {
        return Err(AppError::NotFound("回收站索引中没有这些项目，请先同步".into()));
    }
    let total = resolved.len();
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
            let mut cancelled = false;
            for chunk in resolved.chunks(NATIVE_BATCH) {
                if worker.cancel_requested() {
                    cancelled = true;
                    break;
                }
                let targets: Vec<NativeTarget> = chunk
                    .iter()
                    .map(|item| NativeTarget {
                        name: item.name.clone(),
                        data_path: format!("{}\\$R{}", item.bin_root, item.record_key),
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
                for (item, outcome) in chunk.iter().zip(outcomes) {
                    if outcome.status == "ok" {
                        let _ = db.with_conn(|conn| {
                            recycle_index::delete_records(
                                conn,
                                &item.bin_root,
                                std::slice::from_ref(&item.record_key),
                            )
                            .map(|_| ())
                        });
                    }
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

/// 清空回收站。逐卷执行并逐卷报告；成功卷清理索引，失败卷保留缓存。
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
            let mut cancelled = false;
            for volume in selected {
                if worker.cancel_requested() {
                    cancelled = true;
                    break;
                }
                let Some(outcome) = crate::recycle::volume::empty_recycle_bin(&volume, || worker.cancel_requested()) else {
                    cancelled = true;
                    break;
                };
                let outcome = outcome.and_then(|()| recycle.reconcile_empty(&volume)
                    .map_err(|error| ("EMPTY_UNVERIFIED".into(), error.to_string())));
                match outcome {
                    Ok(()) => {
                        record_result(
                            worker,
                            JobEntryResult {
                                label: volume.volume.clone(),
                                status: "ok".into(),
                                code: "OK".into(),
                                message: None,
                            },
                        );
                    }
                    Err((code, message)) => {
                        worker.update(|snapshot| snapshot.message = Some(message.clone()));
                        record_result(worker, JobEntryResult {
                            label: volume.volume.clone(),
                            status: "failed".into(),
                            code,
                            message: Some(message),
                        });
                    }
                }
                emit_progress(app, worker);
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
