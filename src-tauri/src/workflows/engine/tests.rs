//! 引擎测试：用假执行器 / 假事件出口驱动 [`run_engine`]，覆盖顺序、失败策略、
//! 暂停 / 取消、停用步骤、桌面互斥、槽互斥与 panic 隔离。不依赖 AppHandle。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::db::Db;
use crate::error::AppError;
use crate::workflows::store;
use crate::workflows::{OnError, StepInput, StepParams, WorkflowInput};

// ── 测试基建 ────────────────────────────────────────────────

fn temp_db(tag: &str) -> Db {
    let dir = std::env::temp_dir().join(format!("td-wf-eng-{}-{}", tag, uuid::Uuid::new_v4()));
    Db::open(&dir.join("t.db")).expect("打开测试库失败")
}

#[derive(Clone, Default)]
struct FakeSink {
    events: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl FakeSink {
    fn count(&self) -> usize {
        self.events.lock().unwrap().len()
    }
}

impl RunEventSink for FakeSink {
    fn emit(&self, payload: serde_json::Value) {
        self.events.lock().unwrap().push(payload);
    }
}

type Outcome = Result<serde_json::Value, String>;

/// 假执行器：记录调用序；按「第 N 次调用」脚本化失败 / panic（同类型多步骤可分别控制），
/// 并可在执行时注入动作（取消 / 暂停）。脚本读取不在 panic 传播路径上持锁，避免毒化。
struct FakeExecutor {
    calls: Arc<Mutex<Vec<String>>>,
    fail_calls: Mutex<std::collections::HashSet<usize>>,
    fail_reason: Mutex<String>,
    panic_calls: Mutex<std::collections::HashSet<usize>>,
    hooks: Mutex<std::collections::HashMap<String, Box<dyn Fn(&StepExecContext<'_>) + Send>>>,
}

impl FakeExecutor {
    fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            fail_calls: Mutex::new(std::collections::HashSet::new()),
            fail_reason: Mutex::new("模拟失败".to_string()),
            panic_calls: Mutex::new(std::collections::HashSet::new()),
            hooks: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// 调用记录句柄（执行器被移动后仍可断言）。
    fn calls_handle(&self) -> Arc<Mutex<Vec<String>>> {
        self.calls.clone()
    }

    /// 第 n 次调用（1 起）返回失败。
    fn fail_nth(mut self, n: usize, reason: &str) -> Self {
        self.fail_calls.lock().unwrap().insert(n);
        *self.fail_reason.lock().unwrap() = reason.to_string();
        self
    }

    /// 第 n 次调用（1 起）模拟 panic。
    fn panic_nth(mut self, n: usize) -> Self {
        self.panic_calls.lock().unwrap().insert(n);
        self
    }

    fn hook(mut self, step_type: &str, f: impl Fn(&StepExecContext<'_>) + Send + 'static) -> Self {
        self.hooks
            .lock()
            .unwrap()
            .insert(step_type.to_string(), Box::new(f));
        self
    }
}

impl StepExecutor for FakeExecutor {
    fn execute(&self, ctx: &StepExecContext<'_>) -> Outcome {
        let call_no = {
            let mut calls = self.calls.lock().unwrap_or_else(|e| e.into_inner());
            calls.push(ctx.step.step_type.clone());
            calls.len()
        };
        if let Some(hook) = self
            .hooks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&ctx.step.step_type)
        {
            hook(ctx);
        }
        if self
            .panic_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&call_no)
        {
            panic!("模拟执行器 panic");
        }
        if self
            .fail_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&call_no)
        {
            return Err(self
                .fail_reason
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone());
        }
        Ok(serde_json::json!({"summary": format!("{} 完成", ctx.step.step_type)}))
    }
}

fn task_step(title: &str) -> StepInput {
    StepInput {
        id: uuid::Uuid::new_v4().to_string(),
        step_type: "create_task".into(),
        params: StepParams {
            title: title.into(),
            ..Default::default()
        },
        enabled: true,
        on_error: "stop".into(),
    }
}

fn nav_step(db: &Db, target_type: &str, step_type: &str) -> StepInput {
    let id = format!("tgt-{}-{}", target_type, uuid::Uuid::new_v4().simple());
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO navigation_targets (id, display_name, target_type, created_at, updated_at)
             VALUES (?1, ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            rusqlite::params![id, target_type],
        )
        .map_err(AppError::from)
    })
    .unwrap();
    StepInput {
        id: uuid::Uuid::new_v4().to_string(),
        step_type: step_type.into(),
        params: StepParams {
            target_id: id,
            ..Default::default()
        },
        enabled: true,
        on_error: "stop".into(),
    }
}

/// 建工作流 + 步骤，返回 (workflow_id, 有序 step rows)。
fn setup(db: &Db, name: &str, steps: Vec<StepInput>) -> (String, Vec<WorkflowStepRow>) {
    let wf = store::create_workflow(
        db,
        WorkflowInput {
            name: name.into(),
            description: String::new(),
            steps,
        },
    )
    .unwrap();
    let rows = store::list_steps(db, &wf.id).unwrap();
    (wf.id, rows)
}

fn wait_for(timeout: Duration, pred: impl Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    pred()
}

fn run_status(db: &Db, run_id: &str) -> String {
    store::get_run(db, run_id).unwrap().run.status
}

fn run_steps(db: &Db, run_id: &str) -> Vec<crate::workflows::WorkflowRunStepRow> {
    store::get_run(db, run_id).unwrap().steps
}

// ── 顺序与终态 ──────────────────────────────────────────────

#[test]
fn executes_in_order_and_completes() {
    let db = Arc::new(temp_db("order"));
    let (wf_id, steps) = setup(
        &db,
        "w",
        vec![task_step("a"), task_step("b"), task_step("c")],
    );
    let run = store::create_run(&db, &wf_id, "w", &steps).unwrap();
    let executor = Box::new(FakeExecutor::new());
    let sink = FakeSink::default();
    run_engine(
        db.clone(),
        Box::new(sink.clone()),
        executor,
        run.run_id.clone(),
        wf_id.clone(),
        steps,
        Arc::new(RunControl::new()),
    );
    assert_eq!(run_status(&db, &run.run_id), "completed");
    let rs = run_steps(&db, &run.run_id);
    assert!(rs.iter().all(|s| s.status == "succeeded"));
    assert!(rs
        .iter()
        .all(|s| s.finished_at.is_some() && s.started_at.is_some()));
    assert!(
        rs.iter().all(|s| !s.operation_id.is_empty()),
        "操作 ID 必须在副作用前落库"
    );
    let run_row = store::get_run(&db, &run.run_id).unwrap().run;
    assert_eq!(run_row.completed_steps, 3);
    assert_eq!(run_row.total_steps, 3);
    assert!(run_row.finished_at.is_some());
    assert!(
        sink.count() >= 4,
        "至少：开始 + 每步 + 收尾，实际 {}",
        sink.count()
    );
}

#[test]
fn failure_with_stop_policy_cancels_rest() {
    let db = Arc::new(temp_db("stop"));
    let (wf_id, steps) = setup(
        &db,
        "w",
        vec![task_step("a"), task_step("b"), task_step("c")],
    );
    let run = store::create_run(&db, &wf_id, "w", &steps).unwrap();
    let executor = Box::new(FakeExecutor::new().fail_nth(2, "任务标题非法"));
    run_engine(
        db.clone(),
        Box::new(FakeSink::default()),
        executor,
        run.run_id.clone(),
        wf_id,
        steps,
        Arc::new(RunControl::new()),
    );
    // 第一步成功后第二步失败（stop）→ 第三步 cancelled
    let rs = run_steps(&db, &run.run_id);
    assert_eq!(rs[0].status, "succeeded");
    assert_eq!(rs[1].status, "failed");
    assert_eq!(rs[1].detail, "任务标题非法");
    assert_eq!(rs[2].status, "cancelled");
    assert_eq!(run_status(&db, &run.run_id), "failed");
    let run_row = store::get_run(&db, &run.run_id).unwrap().run;
    assert_eq!(run_row.error.as_deref(), Some("任务标题非法"));
}

#[test]
fn failure_with_continue_policy_finishes_run() {
    let db = Arc::new(temp_db("continue"));
    let (wf_id, mut steps) = setup(
        &db,
        "w",
        vec![task_step("a"), task_step("b"), task_step("c")],
    );
    steps[1].on_error = OnError::Continue.as_str().to_string();
    let run = store::create_run(&db, &wf_id, "w", &steps).unwrap();
    let executor = Box::new(FakeExecutor::new().fail_nth(2, "失败步骤"));
    run_engine(
        db.clone(),
        Box::new(FakeSink::default()),
        executor,
        run.run_id.clone(),
        wf_id,
        steps,
        Arc::new(RunControl::new()),
    );
    let rs = run_steps(&db, &run.run_id);
    assert_eq!(rs[0].status, "succeeded");
    assert_eq!(rs[1].status, "failed");
    assert_eq!(rs[2].status, "succeeded", "continue 策略应继续执行后续步骤");
    assert_eq!(
        run_status(&db, &run.run_id),
        "completed",
        "失败继续后整体视为完成（失败明细在步骤回执里）"
    );
    assert_eq!(
        store::get_run(&db, &run.run_id)
            .unwrap()
            .run
            .completed_steps,
        3
    );
}

#[test]
fn disabled_steps_are_skipped() {
    let db = Arc::new(temp_db("skip"));
    let (wf_id, mut steps) = setup(&db, "w", vec![task_step("a"), task_step("b")]);
    steps[0].enabled = false;
    let run = store::create_run(&db, &wf_id, "w", &steps).unwrap();
    let executor = Box::new(FakeExecutor::new());
    let calls = executor.calls_handle();
    run_engine(
        db.clone(),
        Box::new(FakeSink::default()),
        executor,
        run.run_id.clone(),
        wf_id,
        steps,
        Arc::new(RunControl::new()),
    );
    assert_eq!(run_status(&db, &run.run_id), "completed");
    let rs = run_steps(&db, &run.run_id);
    assert_eq!(rs[0].status, "skipped");
    assert_eq!(rs[0].detail, "步骤已停用");
    assert_eq!(rs[1].status, "succeeded");
    assert_eq!(calls.lock().unwrap().len(), 1, "停用步骤不得执行");
}

// ── 暂停 / 取消 ─────────────────────────────────────────────

#[test]
fn pause_blocks_until_resume_then_finishes() {
    let db = Arc::new(temp_db("pause"));
    let (wf_id, steps) = setup(&db, "w", vec![task_step("a"), task_step("b")]);
    let run_id = store::create_run(&db, &wf_id, "w", &steps).unwrap().run_id;
    let control = Arc::new(RunControl::new());
    let control2 = control.clone();
    // 第一步执行时请求暂停：引擎应在安全边界（下一步开始前）停下
    let executor =
        Box::new(FakeExecutor::new().hook("create_task", move |_ctx| control2.set_paused(true)));
    let handle = std::thread::spawn({
        let db = db.clone();
        let run_id = run_id.clone();
        let wf_id = wf_id.clone();
        let control = control.clone();
        move || {
            run_engine(
                db,
                Box::new(FakeSink::default()),
                executor,
                run_id,
                wf_id,
                steps,
                control,
            );
        }
    });
    assert!(
        wait_for(Duration::from_secs(5), || run_status(&db, &run_id)
            == "paused"),
        "引擎应在安全边界进入 paused"
    );
    let rs = run_steps(&db, &run_id);
    assert_eq!(rs[0].status, "succeeded");
    assert_eq!(rs[1].status, "pending", "暂停期间不得推进后续步骤");
    // 恢复 → 跑完
    control.set_paused(false);
    assert!(
        wait_for(Duration::from_secs(5), || run_status(&db, &run_id)
            == "completed"),
        "恢复后应完成"
    );
    handle.join().unwrap();
    assert_eq!(run_steps(&db, &run_id)[1].status, "succeeded");
}

#[test]
fn cancel_prevents_subsequent_steps() {
    let db = Arc::new(temp_db("cancel"));
    let (wf_id, steps) = setup(
        &db,
        "w",
        vec![task_step("a"), task_step("b"), task_step("c")],
    );
    let run_id = store::create_run(&db, &wf_id, "w", &steps).unwrap().run_id;
    let control = Arc::new(RunControl::new());
    let control2 = control.clone();
    // 已有一步成功后，在下一步执行中请求取消：该步不可中断（如实完成），后续不得开始
    let executor = Box::new(FakeExecutor::new().hook("create_task", move |ctx| {
        let done = ctx
            .db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM workflow_run_steps WHERE status = 'succeeded'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(AppError::from)
            })
            .unwrap_or(0);
        if done >= 1 {
            control2.cancel();
        }
    }));
    run_engine(
        db.clone(),
        Box::new(FakeSink::default()),
        executor,
        run_id.clone(),
        wf_id,
        steps,
        control,
    );
    let rs = run_steps(&db, &run_id);
    assert_eq!(rs[0].status, "succeeded");
    assert_eq!(rs[1].status, "succeeded", "取消时已在执行的步骤如实完成");
    assert_eq!(rs[2].status, "cancelled", "后续步骤不得开始");
    assert_eq!(
        run_status(&db, &run_id),
        "cancelled",
        "用户取消 → cancelled"
    );
}

#[test]
fn cancelled_long_running_step_is_recorded_as_cancelled() {
    let db = Arc::new(temp_db("cancel-current-step"));
    let (wf_id, steps) = setup(&db, "w", vec![task_step("a")]);
    let run_id = store::create_run(&db, &wf_id, "w", &steps).unwrap().run_id;
    let control = Arc::new(RunControl::new());
    let control2 = control.clone();
    let executor = Box::new(
        FakeExecutor::new()
            .hook("create_task", move |_| control2.cancel())
            .fail_nth(1, "场景进入已取消"),
    );
    run_engine(
        db.clone(),
        Box::new(FakeSink::default()),
        executor,
        run_id.clone(),
        wf_id,
        steps,
        control,
    );
    assert_eq!(run_steps(&db, &run_id)[0].status, "cancelled");
    assert_eq!(run_status(&db, &run_id), "cancelled");
}

// ── 桌面互斥 ────────────────────────────────────────────────

#[test]
fn desktop_wait_reports_busy_on_timeout() {
    let control = Arc::new(RunControl::new());
    let result = wait_desktop_free(
        control.cancel_flag(),
        Duration::from_millis(60),
        || true, // 注入：桌面始终繁忙
    );
    assert!(matches!(result, DesktopWait::Busy));
}

#[test]
fn desktop_wait_is_cancellable() {
    let control = Arc::new(RunControl::new());
    let handle = std::thread::spawn({
        let control = control.clone();
        move || {
            wait_desktop_free(
                control.cancel_flag(),
                Duration::from_secs(30),
                || true, // 永远繁忙
            )
        }
    });
    std::thread::sleep(Duration::from_millis(50));
    control.cancel();
    let result = handle.join().unwrap();
    assert!(
        matches!(result, DesktopWait::Cancelled),
        "取消位必须立即打断等待"
    );
}

#[test]
fn desktop_free_when_no_restore_running() {
    // 测试环境中工作现场恢复未运行 → 真实 restore_status 返回 Free → 步骤正常执行
    let db = Arc::new(temp_db("free"));
    let (wf_id, steps) = setup(
        &db,
        "w",
        vec![nav_step(&db, "url", "open_url"), task_step("t")],
    );
    let run_id = store::create_run(&db, &wf_id, "w", &steps).unwrap().run_id;
    run_engine(
        db.clone(),
        Box::new(FakeSink::default()),
        Box::new(FakeExecutor::new()),
        run_id.clone(),
        wf_id,
        steps,
        Arc::new(RunControl::new()),
    );
    let rs = run_steps(&db, &run_id);
    assert_eq!(rs[0].status, "succeeded", "无恢复运行时桌面空闲 → 正常执行");
    assert_eq!(run_status(&db, &run_id), "completed");
}

// ── 全局槽（双击运行幂等）──────────────────────────────────

#[test]
fn slot_is_exclusive_and_stale_release_ignores_newcomer() {
    let control = Arc::new(RunControl::new());
    {
        let mut slot = active_slot().lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(ActiveRun {
            run_id: "run-1".into(),
            workflow_id: "wf-1".into(),
            control: control.clone(),
        });
    }
    assert!(active_run().is_some());
    // 迟到的清理不得释放新槽
    release_active("run-old");
    assert!(active_run().is_some(), "旧 run_id 不得释放新槽");
    // 本人释放
    release_active("run-1");
    assert!(active_run().is_none());
}

#[test]
fn slot_guard_releases_on_panic() {
    // 引擎线程无论正常结束、取消、失败还是 panic，槽 guard 都必须释放（RAII）
    let handle = std::thread::spawn(|| {
        let _slot = ActiveSlotGuard {
            run_id: "run-panic".into(),
        };
        panic!("模拟引擎线程异常退出");
    });
    assert!(handle.join().is_err(), "线程应带 panic 退出");
    assert!(active_run().is_none(), "panic 后 guard drop 必须释放槽");
}

// ── panic 隔离 ──────────────────────────────────────────────

#[test]
fn executor_panic_isolated_as_step_failure() {
    let db = Arc::new(temp_db("panic"));
    let (wf_id, mut steps) = setup(&db, "w", vec![task_step("boom"), task_step("ok")]);
    steps[0].on_error = OnError::Continue.as_str().to_string();
    let run_id = store::create_run(&db, &wf_id, "w", &steps).unwrap().run_id;
    run_engine(
        db.clone(),
        Box::new(FakeSink::default()),
        Box::new(FakeExecutor::new().panic_nth(1)),
        run_id.clone(),
        wf_id,
        steps,
        Arc::new(RunControl::new()),
    );
    let rs = run_steps(&db, &run_id);
    assert_eq!(rs[0].status, "failed");
    assert!(rs[0].detail.contains("执行器异常退出"), "{}", rs[0].detail);
    assert_eq!(rs[1].status, "succeeded", "后续步骤继续");
    assert_eq!(run_status(&db, &run_id), "completed");
}

// ── 回执链路 ────────────────────────────────────────────────

#[test]
fn create_task_step_writes_receipt_and_operation_id() {
    let db = Arc::new(temp_db("task-op"));
    let (wf_id, steps) = setup(&db, "w", vec![task_step("来自工作流的任务")]);
    let run_id = store::create_run(&db, &wf_id, "w", &steps).unwrap().run_id;
    run_engine(
        db.clone(),
        Box::new(FakeSink::default()),
        Box::new(FakeExecutor::new()),
        run_id.clone(),
        wf_id,
        steps.clone(),
        Arc::new(RunControl::new()),
    );
    let rs = run_steps(&db, &run_id);
    assert_eq!(rs[0].status, "succeeded");
    let result: serde_json::Value = serde_json::from_str(rs[0].result.as_deref().unwrap()).unwrap();
    assert_eq!(result["summary"], "create_task 完成");
    // 假执行器不真建任务；真建任务由 LiveExecutor 覆盖（需 AppHandle，真机验收）。
    // 这里验证回执与 operation_id 链路完整：
    assert!(!rs[0].operation_id.is_empty());
    assert_eq!(steps.len(), 1);
}

#[test]
fn run_control_wait_is_cancel_aware() {
    let control = Arc::new(RunControl::new());
    control.set_paused(true);
    let c2 = control.clone();
    let handle = std::thread::spawn(move || {
        c2.wait_while_paused();
    });
    std::thread::sleep(Duration::from_millis(50));
    control.cancel();
    handle.join().unwrap();
}
