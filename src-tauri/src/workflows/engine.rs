//! 工作流执行引擎：顺序执行、暂停 / 取消、失败策略、幂等回执与事件推送。
//!
//! 状态机（持久化态 ↔ 过渡态）：
//! ```text
//! idle --start--> running --pause--> pausing(过渡) --> paused --resume--> running
//! running --cancel--> cancelling(过渡) --> cancelled
//! running --全部成功--> completed
//! running --失败且 stop--> failed（后续步骤 cancelled）
//! 应用退出：running/paused --> interrupted（recover_stale_runs，绝不自动重放）
//! ```
//! 过渡态（pausing/cancelling）只存在于内存与事件流；持久层只写稳定态，
//! 崩溃恢复不会把「正在暂停」误标成别的状态。
//!
//! 并发与互斥：
//! - 进程内全局单槽 [`ACTIVE`]：同一时刻最多一个工作流运行（v1 约束）；
//!   释放只认自己的 run_id（借鉴 workspace::gate 的防错清理语义）；
//! - 会抢焦点的步骤执行前等待工作现场恢复退出（轮询 `restore_status`，
//!   有界 30s，超时则该步骤失败并如实说明，绝不与恢复争夺焦点）；
//! - 锁（`ACTIVE` 的 Mutex）内只做内存读写，绝不在锁内执行步骤 / IO。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::workspace;

use super::store::{self, RunProgress, RunStepUpdate};
use super::{StepType, ValidatedStep, WorkflowStepRow};

/// 单步执行前等待工作现场恢复退出的上限。
const DESKTOP_FREE_TIMEOUT: Duration = Duration::from_secs(30);
/// 桌面互斥轮询间隔。
const DESKTOP_FREE_POLL: Duration = Duration::from_millis(150);
/// 现场恢复步骤等待恢复完成的上限（超时后如实报告，不强制终止系统操作）。
const RESTORE_WAIT_TIMEOUT: Duration = Duration::from_secs(120);

// ── 控制位 ──────────────────────────────────────────────────

/// 运行控制：暂停 / 取消位 + 唤醒。可从任意线程（IPC 命令）置位。
pub struct RunControl {
    paused: AtomicBool,
    cancelled: AtomicBool,
    wake: Mutex<()>,
    cv: Condvar,
}

impl RunControl {
    pub fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            wake: Mutex::new(()),
            cv: Condvar::new(),
        }
    }

    pub fn set_paused(&self, v: bool) {
        self.paused.store(v, Ordering::Release);
        self.notify();
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify();
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// 取消位引用（长操作在自身安全点主动让路）。
    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancelled
    }

    fn notify(&self) {
        let _g = self.wake.lock().unwrap_or_else(|e| e.into_inner());
        self.cv.notify_all();
    }

    /// 暂停等待：直到恢复或取消。200ms 轮询兜底，错过通知也不会永久卡住。
    fn wait_while_paused(&self) {
        let mut g = self.wake.lock().unwrap_or_else(|e| e.into_inner());
        while self.is_paused() && !self.is_cancelled() {
            let (guard, _) = self
                .cv
                .wait_timeout(g, Duration::from_millis(200))
                .unwrap_or_else(|e| e.into_inner());
            g = guard;
        }
    }
}

impl Default for RunControl {
    fn default() -> Self {
        Self::new()
    }
}

// ── 执行器抽象（生产实现与测试假实现共用）──────────────────

/// 单步执行上下文。
pub struct StepExecContext<'a> {
    pub db: &'a Db,
    pub step: &'a WorkflowStepRow,
    /// 本次执行的持久化操作 ID（副作用前去重 / 审计依据）。
    pub operation_id: &'a str,
    /// 取消位：长操作（如现场恢复）应主动让路，其余步骤在安全边界后退出。
    pub cancel: &'a AtomicBool,
}

/// 步骤执行器：Ok(JSON) = 结果摘要（写入回执 result）；Err(String) = 失败原因。
/// 实现必须保证：不可中断的操作要在返回中如实报告结果，绝不谎报成功。
pub trait StepExecutor: Send {
    fn execute(&self, ctx: &StepExecContext<'_>) -> Result<serde_json::Value, String>;
}

/// 事件出口：执行进度推送给前端（生产 = Tauri emit；测试 = 收集到 Vec）。
pub trait RunEventSink: Send {
    fn emit(&self, payload: serde_json::Value);
}

/// 生产事件出口：`workflow-run-progress` 事件，payload 为完整运行详情。
pub struct AppEventSink {
    pub app: AppHandle,
}

impl RunEventSink for AppEventSink {
    fn emit(&self, payload: serde_json::Value) {
        let _ = self.app.emit("workflow-run-progress", payload);
    }
}

// ── 活动槽（全局单工作流）──────────────────────────────────

struct ActiveRun {
    run_id: String,
    workflow_id: String,
    control: Arc<RunControl>,
}

fn active_slot() -> &'static Mutex<Option<ActiveRun>> {
    static SLOT: OnceLock<Mutex<Option<ActiveRun>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// 活动运行概览（UI 顶栏 / 命令层使用）。
#[derive(Debug, Clone, Serialize)]
pub struct ActiveRunView {
    pub run_id: String,
    pub workflow_id: String,
    pub paused: bool,
    pub cancel_requested: bool,
}

/// 读取当前活动运行（若有）。
pub fn active_run() -> Option<ActiveRunView> {
    let g = active_slot().lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref().map(|r| ActiveRunView {
        run_id: r.run_id.clone(),
        workflow_id: r.workflow_id.clone(),
        paused: r.control.is_paused(),
        cancel_requested: r.control.is_cancelled(),
    })
}

/// 释放只认自己的 run_id：迟到的清理绝不清掉新一轮运行。
fn release_active(run_id: &str) {
    let mut g = active_slot().lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().map(|r| r.run_id == run_id).unwrap_or(false) {
        *g = None;
    }
}

/// 引擎线程持有的槽 guard：正常结束 / 取消 / panic 都会释放。
struct ActiveSlotGuard {
    run_id: String,
}

impl Drop for ActiveSlotGuard {
    fn drop(&mut self) {
        release_active(&self.run_id);
    }
}

// ── 启动 / 控制 ─────────────────────────────────────────────

/// 在全局槽锁内执行闭包。锁内只允许毫秒级 SQLite 事务与内存读写
/// （无窗口启动 / 文件 / IPC 阻塞调用），用于彻底消除「双击两个请求都通过检查」的竞态。
fn with_slot<R>(f: impl FnOnce(&mut Option<ActiveRun>) -> AppResult<R>) -> AppResult<R> {
    let mut slot = active_slot().lock().unwrap_or_else(|e| e.into_inner());
    f(&mut slot)
}

/// 启动一次运行。幂等保护：全局槽占用时返回 Conflict（连续双击「运行」只执行一次）。
pub fn start_run(db: Arc<Db>, app: AppHandle, workflow_id: &str) -> AppResult<String> {
    // 先清理上次异常退出的遗留运行（幂等空操作），再检查库内状态。
    store::recover_stale_runs(&db)?;

    let (run_id, steps, control) = with_slot(|slot| {
        if slot.is_some() {
            return Err(AppError::Conflict(
                "已有工作流正在执行，同一时刻只能运行一个工作流".into(),
            ));
        }
        let (wf, steps) = store::get_workflow(&db, workflow_id)?;
        if !wf.enabled {
            return Err(AppError::Validation("工作流已停用，无法运行".into()));
        }
        if steps.is_empty() {
            return Err(AppError::Validation("工作流没有任何步骤，无法运行".into()));
        }
        if steps.iter().all(|s| !s.enabled) {
            return Err(AppError::Validation(
                "工作流的所有步骤均已停用，无法运行".into(),
            ));
        }
        let scene_ids = steps
            .iter()
            .filter(|s| s.enabled && s.step_type == StepType::EnterScene.as_str())
            .map(|s| s.params.scene_id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        super::validate_scene_graph_for_workflow(&db, workflow_id, &scene_ids)?;
        // 运行前快速校验启用的步骤（目标 / 快照仍存在），给出带序号的明确错误，
        // 避免创建运行后逐步失败浪费时间窗。
        for (idx, step) in steps.iter().enumerate() {
            if !step.enabled {
                continue;
            }
            if let Err(e) = super::validate_step(&db, &step.step_type, &step.params, true) {
                return Err(AppError::Validation(format!(
                    "第 {} 步（{}）无法执行: {}",
                    idx + 1,
                    StepType::parse(&step.step_type)
                        .map(|t| t.label().to_string())
                        .unwrap_or_else(|| step.step_type.clone()),
                    e
                )));
            }
        }
        let new_run = store::create_run(&db, workflow_id, &wf.name, &steps)?;
        let control = Arc::new(RunControl::new());
        *slot = Some(ActiveRun {
            run_id: new_run.run_id.clone(),
            workflow_id: workflow_id.to_string(),
            control: control.clone(),
        });
        Ok((new_run.run_id, steps, control))
    })?;

    let wf_id = workflow_id.to_string();
    let db2 = db.clone();
    let sink: Box<dyn RunEventSink> = Box::new(AppEventSink { app: app.clone() });
    let executor: Box<dyn StepExecutor> = Box::new(LiveExecutor { app, db });
    let run_id2 = run_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_engine(db2, sink, executor, run_id2, wf_id, steps, control);
    });
    Ok(run_id)
}

/// 暂停：当前步骤处理到安全边界后不再推进。返回是否找到了活动运行。
pub fn pause_run(workflow_id: &str) -> AppResult<ActiveRunView> {
    let slot = active_slot().lock().unwrap_or_else(|e| e.into_inner());
    let ar = slot
        .as_ref()
        .filter(|r| r.workflow_id == workflow_id)
        .ok_or_else(|| AppError::NotFound("该工作流当前没有正在执行的运行".into()))?;
    ar.control.set_paused(true);
    Ok(ActiveRunView {
        run_id: ar.run_id.clone(),
        workflow_id: ar.workflow_id.clone(),
        paused: true,
        cancel_requested: ar.control.is_cancelled(),
    })
}

/// 继续。
pub fn resume_run(workflow_id: &str) -> AppResult<ActiveRunView> {
    let slot = active_slot().lock().unwrap_or_else(|e| e.into_inner());
    let ar = slot
        .as_ref()
        .filter(|r| r.workflow_id == workflow_id)
        .ok_or_else(|| AppError::NotFound("该工作流当前没有正在执行的运行".into()))?;
    ar.control.set_paused(false);
    Ok(ActiveRunView {
        run_id: ar.run_id.clone(),
        workflow_id: ar.workflow_id.clone(),
        paused: false,
        cancel_requested: ar.control.is_cancelled(),
    })
}

/// 取消：阻止后续步骤开始并等待执行器退出（不强制终止系统操作）。
pub fn cancel_run(workflow_id: &str) -> AppResult<ActiveRunView> {
    let slot = active_slot().lock().unwrap_or_else(|e| e.into_inner());
    let ar = slot
        .as_ref()
        .filter(|r| r.workflow_id == workflow_id)
        .ok_or_else(|| AppError::NotFound("该工作流当前没有正在执行的运行".into()))?;
    ar.control.cancel();
    Ok(ActiveRunView {
        run_id: ar.run_id.clone(),
        workflow_id: ar.workflow_id.clone(),
        paused: ar.control.is_paused(),
        cancel_requested: true,
    })
}

// ── 引擎主循环 ──────────────────────────────────────────────

/// 事件负载：完整运行详情（运行头 + 全部步骤回执），前端无需再拼装。
fn emit_progress(db: &Db, sink: &dyn RunEventSink, run_id: &str) {
    match store::get_run(db, run_id) {
        Ok(detail) => sink.emit(serde_json::to_value(&detail).unwrap_or(json!({}))),
        Err(e) => {
            tracing::warn!(run_id = %run_id, "推送运行进度失败（运行记录缺失）: {}", e)
        }
    }
}

enum DesktopWait {
    Free,
    Cancelled,
    Busy,
}

/// 等待桌面互斥：工作现场恢复运行时不抢焦点（轮询，有界，可取消）。
/// `is_desktop_busy` 注入以便测试；生产传入 `|| workspace::restore_status().running`。
fn wait_desktop_free(
    cancel: &AtomicBool,
    timeout: Duration,
    is_desktop_busy: impl Fn() -> bool,
) -> DesktopWait {
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.load(Ordering::Acquire) {
            return DesktopWait::Cancelled;
        }
        if !is_desktop_busy() {
            return DesktopWait::Free;
        }
        if Instant::now() >= deadline {
            return DesktopWait::Busy;
        }
        std::thread::sleep(DESKTOP_FREE_POLL);
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "未知 panic".to_string()
    }
}

/// 引擎主循环。独立函数（不依赖 AppHandle），测试可用假执行器 / 假事件出口驱动。
pub(crate) fn run_engine(
    db: Arc<Db>,
    sink: Box<dyn RunEventSink>,
    executor: Box<dyn StepExecutor>,
    run_id: String,
    workflow_id: String,
    steps: Vec<WorkflowStepRow>,
    control: Arc<RunControl>,
) {
    let _slot = ActiveSlotGuard {
        run_id: run_id.clone(),
    };
    emit_progress(&db, sink.as_ref(), &run_id);

    let mut completed: i64 = 0;
    let mut outcome: Option<(&str, Option<String>)> = None;

    'outer: for (idx, step) in steps.iter().enumerate() {
        // ── 暂停边界：当前步骤完成后不再推进 ──
        if control.is_paused() && !control.is_cancelled() {
            let _ = store::update_run(
                &db,
                &run_id,
                &RunProgress {
                    status: Some("paused".into()),
                    current_step_index: Some(idx as i64),
                    completed_steps: Some(completed),
                    error: None,
                },
            );
            emit_progress(&db, sink.as_ref(), &run_id);
            control.wait_while_paused();
            if !control.is_cancelled() {
                let _ = store::update_run(
                    &db,
                    &run_id,
                    &RunProgress {
                        status: Some("running".into()),
                        current_step_index: None,
                        completed_steps: None,
                        error: None,
                    },
                );
                emit_progress(&db, sink.as_ref(), &run_id);
            }
        }

        // ── 取消边界：本步与后续全部 cancelled ──
        if control.is_cancelled() {
            let _ = store::cancel_pending_steps(&db, &run_id);
            outcome = Some(("cancelled", Some("用户取消".into())));
            break 'outer;
        }

        // ── 停用步骤：记 skipped，不计入执行 ──
        if !step.enabled {
            completed += 1;
            let _ = store::update_run_step(
                &db,
                &run_id,
                &step.id,
                &RunStepUpdate {
                    status: Some("skipped".into()),
                    detail: Some("步骤已停用".into()),
                    result: None,
                    started_at: None,
                    finished_at: Some(now_iso()),
                    operation_id: None,
                },
            );
            let _ = store::update_run(
                &db,
                &run_id,
                &RunProgress {
                    status: None,
                    current_step_index: Some(idx as i64),
                    completed_steps: Some(completed),
                    error: None,
                },
            );
            emit_progress(&db, sink.as_ref(), &run_id);
            continue;
        }

        // ── 标记 running + 持久化操作 ID（副作用前落库）──
        let operation_id = uuid::Uuid::new_v4().to_string();
        let _ = store::update_run_step(
            &db,
            &run_id,
            &step.id,
            &RunStepUpdate {
                status: Some("running".into()),
                detail: None,
                result: None,
                started_at: Some(now_iso()),
                finished_at: None,
                operation_id: Some(operation_id.clone()),
            },
        );
        let _ = store::update_run(
            &db,
            &run_id,
            &RunProgress {
                status: None,
                current_step_index: Some(idx as i64),
                completed_steps: None,
                error: None,
            },
        );
        emit_progress(&db, sink.as_ref(), &run_id);

        // ── 桌面互斥：会抢焦点的步骤等待现场恢复退出 ──
        let desktop_affecting = StepType::parse(&step.step_type)
            .map(|t| t.is_desktop_affecting())
            .unwrap_or(false);
        if desktop_affecting {
            match wait_desktop_free(control.cancel_flag(), DESKTOP_FREE_TIMEOUT, || {
                workspace::restore_status().running
            }) {
                DesktopWait::Free => {}
                DesktopWait::Cancelled => {
                    let _ = store::update_run_step(
                        &db,
                        &run_id,
                        &step.id,
                        &RunStepUpdate {
                            status: Some("cancelled".into()),
                            detail: Some("用户取消".into()),
                            result: None,
                            started_at: None,
                            finished_at: Some(now_iso()),
                            operation_id: None,
                        },
                    );
                    let _ = store::cancel_pending_steps(&db, &run_id);
                    outcome = Some(("cancelled", Some("用户取消".into())));
                    break 'outer;
                }
                DesktopWait::Busy => {
                    let reason = "工作现场恢复正在进行，为避免焦点争夺已跳过本步骤；请稍后重新运行"
                        .to_string();
                    completed += 1;
                    let _ = store::update_run_step(
                        &db,
                        &run_id,
                        &step.id,
                        &RunStepUpdate {
                            status: Some("failed".into()),
                            detail: Some(reason.clone()),
                            result: None,
                            started_at: None,
                            finished_at: Some(now_iso()),
                            operation_id: None,
                        },
                    );
                    let _ = store::update_run(
                        &db,
                        &run_id,
                        &RunProgress {
                            status: None,
                            current_step_index: None,
                            completed_steps: Some(completed),
                            error: None,
                        },
                    );
                    emit_progress(&db, sink.as_ref(), &run_id);
                    if store::parse_on_error(&step.on_error) == super::OnError::Stop {
                        let _ = store::cancel_pending_steps(&db, &run_id);
                        outcome = Some(("failed", Some(reason)));
                        break 'outer;
                    }
                    continue;
                }
            }
        }

        // ── 执行（panic 隔离：单步异常不拖垮引擎线程）──
        let cancel_flag = control.cancel_flag();
        let ctx = StepExecContext {
            db: &db,
            step,
            operation_id: &operation_id,
            cancel: &cancel_flag,
        };
        let outcome_exec =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| executor.execute(&ctx)));
        let now = now_iso();
        match outcome_exec {
            Ok(Ok(value)) => {
                completed += 1;
                let summary = value
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("完成")
                    .to_string();
                let _ = store::update_run_step(
                    &db,
                    &run_id,
                    &step.id,
                    &RunStepUpdate {
                        status: Some("succeeded".into()),
                        detail: Some(summary),
                        result: Some(value.to_string()),
                        started_at: None,
                        finished_at: Some(now),
                        operation_id: None,
                    },
                );
            }
            Ok(Err(reason)) => {
                completed += 1;
                let was_cancelled = control.is_cancelled();
                let _ = store::update_run_step(
                    &db,
                    &run_id,
                    &step.id,
                    &RunStepUpdate {
                        status: Some(if was_cancelled { "cancelled" } else { "failed" }.into()),
                        detail: Some(reason.clone()),
                        result: None,
                        started_at: None,
                        finished_at: Some(now),
                        operation_id: None,
                    },
                );
                if was_cancelled {
                    let _ = store::cancel_pending_steps(&db, &run_id);
                    outcome = Some(("cancelled", Some(reason)));
                    emit_progress(&db, sink.as_ref(), &run_id);
                    break 'outer;
                }
                if store::parse_on_error(&step.on_error) == super::OnError::Stop {
                    let _ = store::cancel_pending_steps(&db, &run_id);
                    outcome = Some(("failed", Some(reason)));
                    emit_progress(&db, sink.as_ref(), &run_id);
                    break 'outer;
                }
            }
            Err(panic) => {
                completed += 1;
                let reason = format!("执行器异常退出: {}", panic_message(panic.as_ref()));
                let _ = store::update_run_step(
                    &db,
                    &run_id,
                    &step.id,
                    &RunStepUpdate {
                        status: Some("failed".into()),
                        detail: Some(reason.clone()),
                        result: None,
                        started_at: None,
                        finished_at: Some(now),
                        operation_id: None,
                    },
                );
                if store::parse_on_error(&step.on_error) == super::OnError::Stop {
                    let _ = store::cancel_pending_steps(&db, &run_id);
                    outcome = Some(("failed", Some(reason)));
                    emit_progress(&db, sink.as_ref(), &run_id);
                    break 'outer;
                }
            }
        }
        let _ = store::update_run(
            &db,
            &run_id,
            &RunProgress {
                status: None,
                current_step_index: None,
                completed_steps: Some(completed),
                error: None,
            },
        );
        emit_progress(&db, sink.as_ref(), &run_id);
    }

    // ── 收尾：终态 + 历史保留 ──
    let (status, error) = outcome
        .map(|(s, e)| (s.to_string(), e))
        .unwrap_or_else(|| ("completed".to_string(), None));
    let _ = store::finish_run(&db, &run_id, &status, error.as_deref());
    let _ = store::prune_runs(&db, &workflow_id, store::RUN_HISTORY_KEEP);
    emit_progress(&db, sink.as_ref(), &run_id);
}

// ── 生产执行器 ──────────────────────────────────────────────

/// 生产实现：导航复用 router::navigate，任务复用 create_task_inner，
/// 场景复用 scenario 服务，现场恢复复用 workspace::start_restore（恢复门禁）。
pub struct LiveExecutor {
    pub app: AppHandle,
    pub db: Arc<Db>,
}

impl StepExecutor for LiveExecutor {
    fn execute(&self, ctx: &StepExecContext<'_>) -> Result<serde_json::Value, String> {
        let ty = StepType::parse(&ctx.step.step_type)
            .ok_or_else(|| format!("未知步骤类型: {}", ctx.step.step_type))?;
        // 执行时重新校验（目标可能已删除 / 参数被外部改动）。
        let validated = super::validate_step(ctx.db, &ctx.step.step_type, &ctx.step.params, true)
            .map_err(|e| e.to_string())?
            .1;
        match (ty, validated) {
            (
                StepType::OpenApp | StepType::OpenUrl | StepType::OpenPath,
                ValidatedStep::OpenNav { target_id },
            ) => {
                let options = crate::navigation::router::NavigateOptions::default();
                let result =
                    crate::navigation::router::navigate(ctx.db, &self.app, &target_id, &options);
                if result.success {
                    Ok(json!({
                        "summary": format!("导航完成（验证级别: {}）", result.verification_level),
                        "target_id": result.target_id,
                        "requested_action": result.requested_action,
                        "actual_action": result.actual_action,
                        "verification_level": result.verification_level,
                        "fallback_used": result.fallback_used,
                    }))
                } else {
                    Err(result
                        .reason
                        .unwrap_or_else(|| "导航失败（原因未知）".into()))
                }
            }
            (
                StepType::CreateTask,
                ValidatedStep::CreateTask {
                    title,
                    description,
                    priority,
                    remind_at,
                    advance_minutes,
                },
            ) => {
                let input = crate::commands::tasks::TaskInput {
                    title,
                    description,
                    priority: Some(priority),
                    category: None,
                    tags: None,
                    due_at: None,
                    remind_at: remind_at.map(Some),
                    advance_minutes: Some(advance_minutes),
                    recurrence: None,
                };
                let task = crate::commands::tasks::create_task_inner(ctx.db, input)
                    .map_err(|e| e.to_string())?;
                Ok(json!({
                    "summary": format!("已创建任务「{}」", task.title),
                    "task_id": task.id,
                    "operation_id": ctx.operation_id,
                }))
            }
            (StepType::EnterScene, ValidatedStep::EnterScene { scene_id }) => {
                let result = crate::commands::scenario::enter_for_workflow(
                    &self.db, &self.app, &scene_id, ctx.cancel,
                )
                .map_err(|e| e.to_string())?;
                let items = result
                    .items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        json!({
                            "index": index + 1,
                            "kind": item.kind,
                            "status": item.status,
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({
                    "summary": format!("场景「{}」已完成 {} 项", scene_id, items.len()),
                    "items": items,
                }))
            }
            (StepType::RestoreWorkspace, ValidatedStep::RestoreWorkspace { snapshot_id }) => {
                self.execute_restore(ctx, &snapshot_id)
            }
            _ => Err("步骤类型与参数不匹配".into()),
        }
    }
}

impl LiveExecutor {
    /// 现场恢复：走统一恢复门禁（start_restore），等待其真正退出后返回；
    /// 工作流取消会传递给恢复操作；超时只停止等待，绝不强制终止系统操作。
    fn execute_restore(
        &self,
        ctx: &StepExecContext<'_>,
        snapshot_id: &str,
    ) -> Result<serde_json::Value, String> {
        workspace::start_restore(self.db.clone(), self.app.clone(), snapshot_id.to_string())
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + RESTORE_WAIT_TIMEOUT;
        loop {
            if ctx.cancel.load(Ordering::Acquire) {
                workspace::request_cancel();
                return Err("已请求取消，工作现场恢复正在退出".into());
            }
            let status = workspace::restore_status();
            if !status.running {
                let detail = workspace::get_snapshot(&self.db, snapshot_id)
                    .map_err(|e| format!("工作现场已退出，但读取逐项结果失败: {e}"))?;
                let mut restored = 0usize;
                let mut failed = 0usize;
                let mut skipped = 0usize;
                let mut cancelled = 0usize;
                let mut unknown = 0usize;
                for item in &detail.items {
                    match item.last_result.as_str() {
                        "restored" => restored += 1,
                        "failed" => failed += 1,
                        "skipped" => skipped += 1,
                        "cancelled" => cancelled += 1,
                        _ => unknown += 1,
                    }
                }
                let summary = format!(
                    "工作现场结果：恢复 {}，跳过 {}，失败 {}，取消 {}，未知 {}",
                    restored, skipped, failed, cancelled, unknown
                );
                if failed > 0 || skipped > 0 || cancelled > 0 || unknown > 0 {
                    return Err(summary);
                }
                return Ok(json!({
                    "summary": summary,
                    "snapshot_id": snapshot_id,
                    "restored": restored,
                    "total": detail.items.len(),
                }));
            }
            if Instant::now() >= deadline {
                return Err(
                    "工作现场恢复超过 120 秒仍未结束，已停止等待（未强制终止系统操作）".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}

#[cfg(test)]
mod tests;
