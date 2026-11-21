//! 本地 REST API（默认关闭，仅监听 127.0.0.1）。
//!
//! 安全约束：
//! - 远程访问本轮不实现：只绑定环回地址，设置项里只有「未开放」；
//! - 必须携带 `Authorization: Bearer tdm_...`（Agent Token，库内只存 SHA-256）；
//! - 拒绝带 `Origin` 的请求，不返回 CORS 头（浏览器页面无法直接调用）；
//! - body ≤ 1MiB（Content-Length 与流式累计双重校验，缺 Content-Length 也受限）、
//!   请求预算 20s（body 读取与 dispatch 共享同一 deadline，超时 408）、
//!   限流 120 次/分（固定窗口）、POST 支持 `Idempotency-Key` 24h（指纹 + 进行中占位）。
//!
//! 生命周期：连接任务与「迟到完成」后台任务统一登记进任务表，`stop()` 依次
//! 停止接受新连接 → 有界 drain 活跃请求 → 取消剩余任务 → 清理状态。
//!
//! 超时语义：超时**不等于**业务事务已回滚（事务可能已 commit，只是响应还没
//! 写回）。因此超时后保留幂等占位，业务执行在后台宽限期内继续跑完并写缓存；
//! 客户端重试只会拿到重放结果或 409，绝不重复写业务数据。
//!
//! 路由与 `ROUTES` 常量共用，`/api/v1/openapi.json` 由同一份数据生成，避免文档漂移。

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CONTENT_TYPE};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};
use crate::mcp::auth::{self, McpAgentRow};
use crate::mcp::permissions::Capability;

use super::{
    context, error_code, handoff, http_status, operations, permissions as perms, service, store,
    sync as file_sync, workspace, Envelope, Meta, Page, Principal, Source,
};

pub const MAX_BODY: usize = 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
pub const RATE_LIMIT_PER_MIN: u32 = 120;
pub const BASE_PATH: &str = "/api/v1";

/// 实际生效的请求预算。测试构建缩短到 2s（并行测试套件负载较高时仍能稳定
/// 区分「慢请求」与「正常请求」），生产路径没有任何环境变量后门，
/// 恒等于 `REQUEST_TIMEOUT`。
#[cfg(test)]
pub(crate) const REQUEST_TIMEOUT_EFFECTIVE: Duration = Duration::from_secs(2);
#[cfg(not(test))]
pub(crate) const REQUEST_TIMEOUT_EFFECTIVE: Duration = REQUEST_TIMEOUT;

/// 幂等占位的进行中租约（秒）：执行者崩溃后最多占用 Key 5 分钟。
const IDEMPOTENCY_LEASE_SECS: i64 = 300;
/// 幂等结果缓存寿命（小时）。
const IDEMPOTENCY_TTL_HOURS: i64 = 24;
/// 相同 Key 正在处理时的有界等待上限与轮询间隔。
const IN_PROGRESS_WAIT: Duration = Duration::from_secs(2);
const IN_PROGRESS_POLL: Duration = Duration::from_millis(25);
/// 停止监听的有界等待（以监听任务结束计数为准，不看端口能否再绑）。
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
/// 停止时等待「活跃请求任务」结束的有界 drain 预算。
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// 取消剩余任务后等待取消真正生效的短预算。
const CANCEL_SETTLE: Duration = Duration::from_millis(500);
/// 请求超时后的「迟到完成」宽限期。
///
/// 超时**不等于**业务事务已回滚：业务写入在 `with_transaction` 内，事务可能
/// 已经 commit，只是响应还没写回客户端。此时若释放幂等占位，客户端用同一个
/// `Idempotency-Key` 重试就会把业务写入**执行两次**。
/// 因此超时后业务执行在后台继续跑（登记进统一任务表），给出这段时间把结论
/// 写进幂等缓存；有界，不允许无限执行。
const LATE_GRACE: Duration = Duration::from_secs(10);

/// 路由表：`(method, path, summary)`。openapi 与 dispatch 都以此为真源。
pub const ROUTES: &[(&str, &str, &str)] = &[
    ("GET", "/api/v1/status", "系统与工作空间状态"),
    ("GET", "/api/v1/manifest", "Agent 工作空间 manifest"),
    ("GET", "/api/v1/openapi.json", "本 API 的 OpenAPI 描述"),
    ("GET", "/api/v1/projects", "项目列表（每个项目根一行，含 activePlanId）"),
    ("POST", "/api/v1/projects", "创建项目（需 projects.create）"),
    ("GET", "/api/v1/projects/{id}", "项目详情"),
    ("GET", "/api/v1/projects/{id}/status", "项目状态与下一步"),
    ("GET", "/api/v1/tasks", "任务列表（支持 status/search/limit/offset）"),
    ("GET", "/api/v1/tasks/{id}", "任务详情"),
    ("POST", "/api/v1/tasks", "创建任务"),
    ("PATCH", "/api/v1/tasks/{id}", "更新任务（需 base_revision）"),
    ("POST", "/api/v1/tasks/{id}/complete", "完成任务"),
    ("GET", "/api/v1/plans", "规划列表"),
    ("GET", "/api/v1/plans/current", "当前规划"),
    ("GET", "/api/v1/plans/{id}", "规划详情"),
    ("GET", "/api/v1/knowledge/search", "知识检索"),
    ("GET", "/api/v1/knowledge/{id}", "知识文档"),
    ("POST", "/api/v1/knowledge", "写入知识"),
    ("PATCH", "/api/v1/knowledge/{id}", "更新知识（需 base_revision）"),
    ("GET", "/api/v1/decisions", "决策列表（需 decisions.read）"),
    ("GET", "/api/v1/decisions/{id}", "决策详情（需 decisions.read）"),
    ("POST", "/api/v1/decisions", "记录决策（需 decisions.write）"),
    ("GET", "/api/v1/context", "上下文（Markdown 或 JSON）"),
    ("GET", "/api/v1/context/search", "上下文关键词过滤"),
    ("GET", "/api/v1/agents/handoffs", "交接列表"),
    ("POST", "/api/v1/agents/handoffs", "创建交接"),
    ("GET", "/api/v1/agents/handoffs/{id}", "交接详情"),
    ("POST", "/api/v1/agents/handoffs/{id}/accept", "接收交接"),
    ("POST", "/api/v1/agents/handoffs/{id}/reject", "拒绝交接"),
    ("POST", "/api/v1/agents/handoffs/{id}/complete", "完成交接"),
    ("GET", "/api/v1/agents/reports", "工作报告列表"),
    ("POST", "/api/v1/agents/reports", "提交工作报告"),
    ("GET", "/api/v1/agents/activity", "Agent 活动记录（按授权过滤）"),
    ("GET", "/api/v1/sync/status", "同步状态（需 projects.read）"),
    ("GET", "/api/v1/sync/conflicts", "冲突列表（需 projects.read）"),
    ("POST", "/api/v1/sync/conflicts/{id}/resolve", "解决冲突"),
    ("POST", "/api/v1/sync/scan", "立即扫描导入目录"),
];

/// 真实运行状态。与「配置期望运行」分开：`enabled=true` 不代表正在监听。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RestRuntimeStatus {
    Stopped,
    Starting,
    Listening,
    Failed,
    Stopping,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct RestStatus {
    pub enabled: bool,
    pub running: bool,
    pub state: RestRuntimeStatus,
    /// 实际生效端口；未监听时回退为配置端口。
    pub port: u16,
    pub configured_port: u16,
    pub bound_port: Option<u16>,
    pub base_url: String,
    pub openapi_url: String,
    pub last_error: Option<String>,
    pub started_at: Option<String>,
    pub request_count: u64,
    pub rejected_count: u64,
    pub remote_allowed: bool,
}

struct RateState {
    window: Instant,
    count: u32,
}

struct RestState {
    db: Arc<Db>,
    port: u16,
    shutdown: Arc<Notify>,
    rate: Mutex<RateState>,
}

struct RunningRest {
    port: u16,
    shutdown: Arc<Notify>,
    task: tauri::async_runtime::JoinHandle<()>,
    /// 监听任务结束计数：任务 future 被 drop（含 abort 未启动）时置位。
    finished: Arc<AtomicU64>,
}

/// 监听任务的生命周期标记：与监听 future 一同被持有，正常结束或被 abort
/// 都会在 future 被 drop 时递增计数，`stop()` 据此做有界等待。
struct TaskDone(Arc<AtomicU64>);

impl Drop for TaskDone {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

// ── 统一任务登记表 ──────────────────────────────────────────────
//
// 停止监听只结束 accept 循环；`tokio::spawn` 出来的**请求处理任务**仍在后台跑
// （孤儿任务），它们还会继续改业务数据、继续持有数据库连接。
// 因此 REST 把「连接任务」与「迟到完成的后台任务」都登记进同一张表，
// `stop()` 才能证明「没有活跃请求任务」之后才释放端口、清状态。

/// 任务登记表：登记所有 REST 后台任务，统计活跃数并支持统一取消。
struct TaskRegistry {
    inner: Mutex<RegistryInner>,
}

struct RegistryInner {
    /// 尚未结束的任务数
    live: usize,
    /// 各任务的取消句柄（已结束的会被剔除）
    cancels: Vec<tokio::task::AbortHandle>,
    /// 置位后不再登记新任务：`stop()` 的第一步（停止接受新连接）
    closed: bool,
}

/// 进程级任务登记表。
fn task_registry() -> &'static Arc<TaskRegistry> {
    static REG: OnceLock<Arc<TaskRegistry>> = OnceLock::new();
    REG.get_or_init(|| {
        Arc::new(TaskRegistry {
            inner: Mutex::new(RegistryInner {
                live: 0,
                cancels: Vec::new(),
                closed: false,
            }),
        })
    })
}

impl TaskRegistry {
    /// 锁中毒时也要能继续（登记表只是计数器，poison 不该让 REST 整体失效）。
    fn with_inner<R>(&self, f: impl FnOnce(&mut RegistryInner) -> R) -> R {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    /// 登记一个新任务；`None` 表示已停止接收新任务。
    fn register(self: &Arc<Self>) -> Option<TaskGuard> {
        let accepted = self.with_inner(|inner| {
            if inner.closed {
                false
            } else {
                inner.live += 1;
                true
            }
        });
        if accepted {
            Some(TaskGuard {
                registry: Arc::clone(self),
            })
        } else {
            None
        }
    }

    /// 登记任务的取消句柄。
    fn attach(&self, abort: tokio::task::AbortHandle) {
        self.with_inner(|inner| {
            inner.cancels.retain(|h| !h.is_finished());
            inner.cancels.push(abort);
        });
    }

    /// 活跃（尚未结束）任务数。
    fn live_count(&self) -> usize {
        self.with_inner(|inner| inner.live)
    }

    /// 停止登记新任务：`stop()` 的第一步。
    fn close(&self) {
        self.with_inner(|inner| inner.closed = true);
    }

    /// 重新开放登记（`start()` 时调用）。
    fn open(&self) {
        self.with_inner(|inner| inner.closed = false);
    }

    /// 有界等待活跃任务结束。`true` = 已全部结束。
    fn drain(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.live_count() == 0 {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// 取消全部仍在运行的任务。
    fn cancel_all(&self) {
        let handles: Vec<tokio::task::AbortHandle> = self.with_inner(|inner| {
            inner.cancels.retain(|h| !h.is_finished());
            std::mem::take(&mut inner.cancels)
        });
        for handle in handles {
            handle.abort();
        }
    }
}

/// 任务守卫：任务结束（正常结束 / 被取消）时自动从登记表注销。
struct TaskGuard {
    registry: Arc<TaskRegistry>,
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.registry.with_inner(|inner| {
            inner.live = inner.live.saturating_sub(1);
            inner.cancels.retain(|h| !h.is_finished());
        });
    }
}

/// 启动一个被登记表管理的任务。`None` 表示登记已关闭（正在停止）。
///
/// 只能在 tokio 运行时上下文里调用（连接任务与后台任务都在其中）。
fn spawn_tracked<F>(future: F) -> Option<tokio::task::JoinHandle<F::Output>>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let registry = task_registry();
    let guard = registry.register()?;
    let handle = tokio::spawn(async move {
        let _guard = guard;
        future.await
    });
    registry.attach(handle.abort_handle());
    Some(handle)
}

/// 活跃 REST 后台任务数（测试可观测）：登记表里尚未结束的任务数。
pub(crate) fn active_task_count() -> usize {
    task_registry().live_count()
}

#[derive(Clone, Debug)]
struct RuntimeState {
    status: RestRuntimeStatus,
    bound_port: Option<u16>,
    last_error: Option<String>,
    started_at: Option<String>,
}

/// 进程内生命周期闸门：`start / stop / apply` 全部在闸门内串行执行，
/// 避免「先查 slot 再 bind」被两个并发调用同时通过而各自绑定端口。
fn lifecycle_gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

fn lock_lifecycle() -> AppResult<std::sync::MutexGuard<'static, ()>> {
    lifecycle_gate()
        .lock()
        .map_err(|_| AppError::Unavailable("REST 生命周期锁不可用".into()))
}

fn slot() -> &'static Mutex<Option<RunningRest>> {
    static SLOT: OnceLock<Mutex<Option<RunningRest>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn runtime() -> &'static Mutex<RuntimeState> {
    static RUNTIME: OnceLock<Mutex<RuntimeState>> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        Mutex::new(RuntimeState {
            status: RestRuntimeStatus::Stopped,
            bound_port: None,
            last_error: None,
            started_at: None,
        })
    })
}

fn update_runtime(f: impl FnOnce(&mut RuntimeState)) {
    if let Ok(mut guard) = runtime().lock() {
        f(&mut guard);
    }
}

fn mark_failed(message: String) {
    update_runtime(|rt| {
        rt.status = RestRuntimeStatus::Failed;
        rt.bound_port = None;
        rt.started_at = None;
        rt.last_error = Some(message);
    });
}

fn counters() -> &'static (AtomicU64, AtomicU64) {
    static COUNTERS: OnceLock<(AtomicU64, AtomicU64)> = OnceLock::new();
    COUNTERS.get_or_init(|| (AtomicU64::new(0), AtomicU64::new(0)))
}

fn runtime_snapshot() -> RuntimeState {
    runtime()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or(RuntimeState {
            status: RestRuntimeStatus::Failed,
            bound_port: None,
            last_error: Some("REST 运行时状态锁不可用".into()),
            started_at: None,
        })
}

pub fn status(db: &Db) -> RestStatus {
    let settings = Settings::load(db).ok();
    let enabled = settings.as_ref().map(|s| s.agent_api_enabled).unwrap_or(false);
    let configured_port = settings.map(|s| s.agent_api_port).unwrap_or(47911);
    let runtime = runtime_snapshot();
    // 真实监听必须以「持有任务句柄 + 状态为 listening」同时成立。
    let listening = runtime.status == RestRuntimeStatus::Listening
        && runtime.bound_port.is_some()
        && slot().lock().map(|g| g.is_some()).unwrap_or(false);
    let port = if listening {
        runtime.bound_port.unwrap_or(configured_port)
    } else {
        configured_port
    };
    RestStatus {
        enabled,
        running: listening,
        state: if listening {
            RestRuntimeStatus::Listening
        } else {
            runtime.status
        },
        port,
        // 配置端口只反映设置值，绝不把历史运行端口「补」进来。
        configured_port,
        bound_port: if listening { runtime.bound_port } else { None },
        base_url: format!("http://127.0.0.1:{port}{BASE_PATH}"),
        openapi_url: format!("http://127.0.0.1:{port}{BASE_PATH}/openapi.json"),
        last_error: runtime.last_error,
        started_at: if listening { runtime.started_at } else { None },
        request_count: counters().0.load(Ordering::Relaxed),
        rejected_count: counters().1.load(Ordering::Relaxed),
        remote_allowed: false,
    }
}

/// 按设置应用启停（设置保存、启动恢复时调用）。
/// - 关闭 → stopped；
/// - 开启且未运行 → start；
/// - 开启且端口变化 → 先停旧监听，再绑新端口；
/// - 绑定失败 → 返回明确错误，同时把真实状态置为 failed（配置保持原样）。
pub fn apply(db: Arc<Db>) -> AppResult<RestStatus> {
    let _gate = lock_lifecycle()?;
    let settings = Settings::load(&db)?;
    let desired = settings.agent_api_port;
    let running = slot().lock().map(|g| g.is_some()).unwrap_or(true);
    if !settings.agent_api_enabled {
        if running {
            stop_locked()?;
        } else {
            update_runtime(|rt| {
                rt.status = RestRuntimeStatus::Stopped;
                rt.bound_port = None;
                rt.started_at = None;
            });
        }
        return Ok(status(&db));
    }
    if running {
        if runtime_snapshot().bound_port == Some(desired) {
            return Ok(status(&db));
        }
        stop_locked()?;
    }
    start_locked(&db, desired)
}

/// 启动：整个「检查 slot → bind → spawn → 登记 slot」都在生命周期闸门内完成。
/// 重复 start 同一端口直接返回当前状态；不同端口返回 Conflict。
pub fn start(db: Arc<Db>, port: u16) -> AppResult<RestStatus> {
    let _gate = lock_lifecycle()?;
    start_locked(&db, port)
}

fn start_locked(db: &Arc<Db>, port: u16) -> AppResult<RestStatus> {
    if port == 0 {
        return Err(AppError::Validation("REST 端口不能为 0".into()));
    }
    let occupied = match slot().lock() {
        Ok(guard) => guard.is_some(),
        Err(_) => return Err(AppError::Unavailable("REST 监听锁不可用".into())),
    };
    if occupied {
        let bound = runtime_snapshot().bound_port;
        if bound == Some(port) {
            return Ok(status(db));
        }
        return Err(AppError::Conflict(format!(
            "REST 已在端口 {} 监听；请先停止再切换端口",
            bound.unwrap_or(0)
        )));
    }
    let listener = match std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)) {
        Ok(listener) => listener,
        Err(err) => {
            mark_failed(format!("端口 {port} 绑定失败: {err}"));
            return Err(AppError::Unavailable(format!(
                "Agent REST 端口 {port} 绑定失败: {err}"
            )));
        }
    };
    if let Err(err) = listener.set_nonblocking(true) {
        mark_failed(format!("设置监听非阻塞失败: {err}"));
        return Err(AppError::Unavailable(format!(
            "设置监听非阻塞失败: {err}"
        )));
    }
    update_runtime(|rt| {
        rt.status = RestRuntimeStatus::Starting;
        rt.bound_port = None;
        rt.last_error = None;
        rt.started_at = None;
    });
    let shutdown = Arc::new(Notify::new());
    let finished = Arc::new(AtomicU64::new(0));
    // 新一轮监听开始：重新开放任务登记（上一轮 stop() 关过）。
    task_registry().open();
    let state = Arc::new(RestState {
        db: db.clone(),
        port,
        shutdown: shutdown.clone(),
        rate: Mutex::new(RateState {
            window: Instant::now(),
            count: 0,
        }),
    });
    // 结束标记在 future 构造时就被捕获：即使任务从未被轮询就被 abort，
    // 只要 future 被 drop 计数也会 +1，`stop()` 不会误判超时。
    let done = TaskDone(finished.clone());
    let task = tauri::async_runtime::spawn(async move {
        let _done = done;
        run_listener(listener, state).await;
    });
    {
        let mut guard = match slot().lock() {
            Ok(guard) => guard,
            Err(_) => {
                // 登记失败必须回收已启动的监听，不能留下无主 socket。
                task.abort();
                mark_failed("REST 监听锁不可用，已回收监听任务".into());
                return Err(AppError::Unavailable("REST 监听锁不可用".into()));
            }
        };
        *guard = Some(RunningRest {
            port,
            shutdown,
            task,
            finished: finished.clone(),
        });
    }
    if finished.load(Ordering::SeqCst) > 0 {
        // 任务在登记前已退出（句柄转换失败等）：不谎报 Listening。
        if let Ok(mut guard) = slot().lock() {
            let _ = guard.take();
        }
        mark_failed("监听任务启动后立即退出".into());
        return Err(AppError::Unavailable(
            "Agent REST 监听任务启动失败".into(),
        ));
    }
    update_runtime(|rt| {
        rt.status = RestRuntimeStatus::Listening;
        rt.bound_port = Some(port);
        rt.last_error = None;
        rt.started_at = Some(crate::agents::now_iso());
    });
    tracing::info!("Agent REST 监听 127.0.0.1:{port}{BASE_PATH}");
    Ok(status(db))
}

/// 停止：停止接受新连接 → 有界 drain 活跃请求任务 → 取消剩余任务 → 清理状态。
///
/// 顺序不能变：先把任务登记关掉（新任务登记不进来），再结束 accept 循环，
/// 然后**等**已在跑的请求任务自己结束；等不到才取消它们。若反过来先取消，
/// 正在提交的业务写入会被硬生生打断，留下「业务写了一半」的状态。
pub fn stop() -> AppResult<()> {
    let _gate = lock_lifecycle()?;
    stop_locked()
}

fn stop_locked() -> AppResult<()> {
    let registry = task_registry();
    // 1) 停止接受新连接：关闭任务登记，任何新任务都登记不进来。
    registry.close();
    let handle = match slot().lock() {
        Ok(mut guard) => guard.take(),
        // slot 锁被 poison 也必须清空，否则会留下无人持有的监听。
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            guard.take()
        }
    };
    let Some(handle) = handle else {
        // 没有在运行：仍然兜底取消残留任务，绝不留下孤儿。
        registry.cancel_all();
        update_runtime(|rt| {
            if rt.status != RestRuntimeStatus::Failed {
                rt.status = RestRuntimeStatus::Stopped;
            }
            rt.bound_port = None;
            rt.started_at = None;
        });
        return Ok(());
    };
    update_runtime(|rt| {
        rt.status = RestRuntimeStatus::Stopping;
        rt.bound_port = None;
        rt.started_at = None;
    });
    // 2) 结束 accept 循环（释放端口），但不动已在跑的请求任务。
    handle.shutdown.notify_waiters();
    handle.task.abort();
    // 判据是「任务结束计数」而不是「端口能否再绑」：后者会被 TIME_WAIT
    // 或其它进程占用误导。slot 在进入本函数时已清空。
    let listener_deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < listener_deadline && handle.finished.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(Duration::from_millis(5));
    }
    let listener_timed_out = handle.finished.load(Ordering::SeqCst) == 0;
    // 3) 有界 drain：等待活跃请求任务（连接任务 + 迟到完成后台任务）自己结束。
    let drained = registry.drain(DRAIN_TIMEOUT);
    // 4) 超时 → 取消剩余任务，绝不让请求任务变成孤儿继续改业务数据。
    let cancelled = !drained;
    if cancelled {
        registry.cancel_all();
        registry.drain(CANCEL_SETTLE);
    }
    // 5) 清理状态。
    update_runtime(|rt| {
        rt.status = RestRuntimeStatus::Stopped;
        rt.bound_port = None;
        rt.started_at = None;
        if listener_timed_out {
            rt.last_error = Some("停止超时（2s）".into());
        } else if cancelled {
            rt.last_error = Some("已取消未在预算内结束的请求任务".into());
        }
    });
    if listener_timed_out {
        tracing::warn!("Agent REST 监听任务未在 2s 内结束，已释放 slot");
    }
    Ok(())
}

async fn run_listener(listener: std::net::TcpListener, state: Arc<RestState>) {
    let listener = match TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("Agent REST 监听句柄转换失败: {err}");
            update_runtime(|rt| {
                rt.status = RestRuntimeStatus::Failed;
                rt.last_error = Some(format!("监听句柄转换失败: {err}"));
                rt.bound_port = None;
            });
            return;
        }
    };
    loop {
        tokio::select! {
            _ = state.shutdown.notified() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let io = TokioIo::new(stream);
                let state = state.clone();
                // 每个连接任务都登记进统一任务表：`stop()` 才能有界地等它结束，
                // 否则监听停了请求任务还在后台跑（孤儿任务）。
                let spawned = spawn_tracked(async move {
                    let service = service_fn(move |req| {
                        let state = state.clone();
                        async move { Ok::<_, Infallible>(handle(req, state).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .timer(hyper_util::rt::TokioTimer::new())
                        .serve_connection(io, service)
                        .await;
                });
                if spawned.is_none() {
                    // 正在停止：不再接受新连接，直接关掉这个 socket。
                    tracing::debug!("Agent REST 正在停止，拒绝新连接");
                    break;
                }
            }
        }
    }
}

fn plain(status: StatusCode, body: Value, request_id: &str) -> Response<Full<Bytes>> {
    let data = serde_json::to_vec(&body).unwrap_or_default();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header("cache-control", "no-store")
        .header("x-request-id", request_id)
        .body(Full::new(Bytes::from(data)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"{}"))))
}

fn meta_of(principal: &Principal, request_id: &str, page: Option<Page>) -> Meta {
    let meta = Meta::new(principal, request_id);
    match page {
        Some(page) => meta.with_page(page),
        None => meta,
    }
}

fn unauthorized(request_id: &str, detail: &str) -> Response<Full<Bytes>> {
    fail_with_code(
        StatusCode::UNAUTHORIZED,
        "UNAUTHORIZED",
        detail,
        &Principal::local(Source::Rest),
        request_id,
    )
}

/// 统一信封格式的错误响应：错误码显式给出。
///
/// `http_status()` 无法映射的码（UNAUTHORIZED / FORBIDDEN / RATE_LIMITED）走这里；
/// `meta.request_id` 与 `X-Request-Id` 头永远一致。
fn fail_with_code(
    status: StatusCode,
    code: &str,
    message: &str,
    principal: &Principal,
    request_id: &str,
) -> Response<Full<Bytes>> {
    let meta = meta_of(principal, request_id, None);
    plain(
        status,
        json!({
            "success": false,
            "data": null,
            "error": { "code": code, "message": message, "details": null, "retryable": false },
            "meta": serde_json::to_value(meta).unwrap_or(Value::Null),
        }),
        request_id,
    )
}

fn bearer(req: &Request<Incoming>) -> Option<String> {
    let raw = req.headers().get(AUTHORIZATION)?.to_str().ok()?.trim();
    raw.strip_prefix("Bearer ").map(|t| t.trim().to_string())
}

fn authenticate(
    state: &RestState,
    req: &Request<Incoming>,
    request_id: &str,
) -> Result<Principal, Response<Full<Bytes>>> {
    let Some(token) = bearer(req) else {
        return Err(unauthorized(request_id, "缺少 Authorization: Bearer <agent token>"));
    };
    if token.len() < 8 || token.chars().any(|c| c.is_control()) {
        return Err(unauthorized(request_id, "token 格式非法"));
    }
    let row: Option<McpAgentRow> = state
        .db
        .with_read(|conn| auth::find_agent_by_token(conn, &token))
        .map_err(|_| unauthorized(request_id, "数据库不可用"))?;
    match row {
        Some(row) => Ok(Principal::agent(row.row_id, row.agent_id, Source::Rest)),
        None => Err(unauthorized(request_id, "token 无效或已撤销")),
    }
}

fn rate_check(state: &RestState) -> bool {
    let Ok(mut rate) = state.rate.lock() else {
        return false;
    };
    if rate.window.elapsed() >= Duration::from_secs(60) {
        rate.window = Instant::now();
        rate.count = 0;
    }
    rate.count += 1;
    rate.count <= RATE_LIMIT_PER_MIN
}

/// 幂等作用域：只有「POST + 合法 Idempotency-Key + 已注册 Agent」才走幂等。
///
/// 本机用户 / 系统身份没有 `agent_row_id`，**绝不**与 Agent 共用幂等记录
/// （唯一键含 `agent_row_id`，本机身份根本进不了这张表）。
/// 返回 `(key, agent_row_id)`；`None` 表示本次请求完全不走幂等逻辑。
pub(crate) fn idempotency_scope(
    principal: &Principal,
    method: &hyper::Method,
    raw_key: Option<&str>,
) -> Option<(String, String)> {
    if method != hyper::Method::POST {
        return None;
    }
    let key = raw_key
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 128)?;
    let row_id = principal.agent_row_id.as_deref()?;
    Some((key.to_string(), row_id.to_string()))
}

/// 一次幂等占位：执行权 + 指纹 + fencing token。
#[derive(Clone, Debug)]
struct IdemClaim {
    key: String,
    row_id: String,
    fingerprint: String,
    /// fencing token：只有 attempt 匹配时才能完成/释放本占位。
    attempt: u32,
}

/// 一次成功执行的响应（信封已序列化）。
struct Completed {
    value: Value,
    status: StatusCode,
}

/// 幂等占位释放守卫：任务被取消（stop / 应用退出）时释放占位。
///
/// `cache_fail` 只删 `state='inflight'` 且 attempt 匹配的占位，因此
/// 「成功写缓存后再 drop」是空操作，不会误删已完成的缓存。
struct PlaceholderRelease {
    db: Arc<Db>,
    claim: IdemClaim,
}

impl Drop for PlaceholderRelease {
    fn drop(&mut self) {
        let _ = store::cache_fail(
            &self.db,
            &self.claim.row_id,
            "rest",
            &self.claim.key,
            &self.claim.fingerprint,
            self.claim.attempt,
        );
    }
}

/// 幂等占位持有者的一次业务执行：跑完业务 → 写缓存（成功）或释放占位（失败）。
///
/// 由「迟到完成」模型驱动：请求超时后本任务继续在后台跑（有界宽限期），
/// 因此占位在后台给出结论前必须保留 —— 否则客户端重试会把业务写入执行两次。
/// 认证通过后开始一次 REST 写操作。
///
/// 幂等重放（缓存命中 Done/Committed）在调用本函数之前就返回了，因此
/// **不会**为同一次业务写入创建第二条 Operation。
fn begin_rest_operation(
    db: &Db,
    principal: &Principal,
    method: &hyper::Method,
    path: &str,
    request_id: &str,
) -> Option<operations::AgentOperation> {
    let (action, kind) = operations::describe_rest_write(method.as_str(), path)?;
    let target_id = operations::rest_target_id(path);
    operations::try_start(
        db,
        principal,
        &operations::OperationInput {
            action,
            resource_kind: kind,
            resource_id: &target_id,
            project_id: "",
            request_id,
            detail: "",
        },
    )
}

async fn run_claim_execution(
    state: Arc<RestState>,
    principal: Principal,
    method: hyper::Method,
    path: String,
    query: HashMap<String, String>,
    body: Vec<u8>,
    claim: IdemClaim,
    grace_deadline: Instant,
    request_id: String,
    reply: Option<tokio::sync::oneshot::Sender<AppResult<Completed>>>,
) {
    // 任务被取消时释放占位，避免 Key 被长期占死。
    let _release = PlaceholderRelease {
        db: state.db.clone(),
        claim: claim.clone(),
    };

    // 业务写入与幂等占位绑定在同一事务：提交即标记 committed 并记录 operation 指针，
    // 进程在「提交后、写响应前」退出时可据此重建响应，绝不重复写入。
    let claim_guard = store::RequestCacheGuard::new(
        &claim.row_id,
        "rest",
        &claim.key,
        &claim.fingerprint,
        claim.attempt,
    );
    // 幂等占位已取得 → 才可能出现真实业务写入；此时开始记录操作。
    let operation = begin_rest_operation(&state.db, &principal, &method, &path, &request_id);
    // v86.1：把「业务提交 + 幂等占位置 committed + 操作置 committed」放进同一个事务。
    // 业务回滚时三者一起回滚；提交时三者一起生效，不再存在
    // 「业务已提交、操作记录还是 running」的窗口。
    let operation_guard = operations::OperationGuard::new(
        operation
            .as_ref()
            .map(|op| op.id.clone())
            .unwrap_or_default(),
    );
    let guarded = operations::CompositeGuard::new(&claim_guard, &operation_guard);
    let outcome = tokio::time::timeout_at(
        grace_deadline.into(),
        dispatch(&state, &principal, &method, &path, &query, &body, &guarded),
    )
    .await;
    match outcome {
        Ok(Ok((data, page))) => {
            if let Some(op) = &operation {
                // 事务内已完成时 `complete` 返回 None（事件未发），补发一次；
                // 未被守卫覆盖的端点在事务外收敛，`complete` 自己会广播。
                let result = operations::OperationResult::from_value(&op.resource_kind, &data);
                match operations::complete(&state.db, &op.id, &result) {
                    Ok(Some(_)) => {}
                    _ => operations::notify_current(&state.db, &op.id),
                }
            }
            let meta = meta_of(&principal, &request_id, page);
            let envelope = Envelope::ok(data, meta);
            let value = serde_json::to_value(&envelope).unwrap_or(Value::Null);
            let status = if method == hyper::Method::POST {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            let text = serde_json::to_string(&value).unwrap_or_default();
            match store::cache_complete(
                &state.db,
                &claim.row_id,
                "rest",
                &claim.key,
                &claim.fingerprint,
                claim.attempt,
                &text,
                status.as_u16(),
            ) {
                Ok(true) => {}
                // fencing：占位已被他人抢占，本次结果不得覆盖对方响应。
                Ok(false) => {
                    tracing::warn!(%request_id, "幂等占位已被抢占，本次结果未缓存");
                }
                Err(err) => {
                    tracing::warn!(%request_id, "幂等结果写入失败: {err}");
                }
            }
            if let Some(tx) = reply {
                let _ = tx.send(Ok(Completed { value, status }));
            }
        }
        Ok(Err(err)) => {
            // 失败绝不缓存：释放占位，允许客户端重试。
            if let Some(op) = &operation {
                let _ = operations::fail(&state.db, &op.id, &err);
            }
            let _ = store::cache_fail(
                &state.db,
                &claim.row_id,
                "rest",
                &claim.key,
                &claim.fingerprint,
                claim.attempt,
            );
            if let Some(tx) = reply {
                let _ = tx.send(Err(err));
            }
        }
        Err(_) => {
            // 宽限期耗尽仍未完成 → 操作必须以明确终态收敛，不能长期停在 running。
            // 结论是「未核实」而不是「失败」：业务事务可能已提交，只是响应没写回，
            // 因此用 interrupted + 稳定错误码，让人/Agent 复核，绝不伪造 committed。
            if let Some(op) = &operation {
                let _ = operations::fail_with(
                    &state.db,
                    &op.id,
                    operations::OperationStatus::Interrupted,
                    "REST_GRACE_EXHAUSTED",
                    "请求超过宽限期仍未完成，业务结果未核实",
                );
            }
            // 释放占位（允许后续重试）并记录 last_error。
            let _ = store::cache_fail(
                &state.db,
                &claim.row_id,
                "rest",
                &claim.key,
                &claim.fingerprint,
                claim.attempt,
            );
            update_runtime(|rt| {
                rt.last_error = Some(format!(
                    "REST 幂等请求 {} 超过 {}s 宽限期未完成，已释放占位",
                    claim.key,
                    LATE_GRACE.as_secs()
                ));
            });
            // 不回传：客户端早已收到 408。
        }
    }
}

/// 统一信封的错误响应。`request_id` 同时用于 body.meta 与 `X-Request-Id` 头。
fn fail_response(
    status: StatusCode,
    err: &AppError,
    principal: &Principal,
    request_id: &str,
) -> Response<Full<Bytes>> {
    let meta = meta_of(principal, request_id, None);
    let value = serde_json::to_value(Envelope::fail(err, meta)).unwrap_or(Value::Null);
    plain(status, value, request_id)
}

fn timeout_response(principal: &Principal, request_id: &str) -> Response<Full<Bytes>> {
    let err = AppError::Unavailable(format!(
        "请求超过 {} 秒未完成（含请求体读取）",
        REQUEST_TIMEOUT_EFFECTIVE.as_secs_f32()
    ));
    fail_response(StatusCode::REQUEST_TIMEOUT, &err, principal, request_id)
}

fn conflict_response(
    message: impl Into<String>,
    principal: &Principal,
    request_id: &str,
) -> Response<Full<Bytes>> {
    fail_response(
        StatusCode::CONFLICT,
        &AppError::Conflict(message.into()),
        principal,
        request_id,
    )
}

/// `committed` 行的响应重建：只读取已提交的业务数据，**绝不重新执行写入**。
///
/// 读取全部走既有授权读函数，因此恢复响应不会绕过权限，也不会放大可见范围。
/// 无法定位资源（已删除 / 非创建类操作）或未知类型时返回错误，由调用方转 409
/// `IDEMPOTENCY_RECOVERY_REQUIRED`。
fn rebuild_committed_response(
    db: &Db,
    principal: &Principal,
    operation_kind: &str,
    operation_id: &str,
) -> AppResult<Value> {
    if operation_id.trim().is_empty() {
        return Err(AppError::Conflict(
            "未记录可恢复的资源指针（operation_id 为空），禁止重新执行".into(),
        ));
    }
    match operation_kind {
        "task" => Ok(serde_json::to_value(service::fetch_task(
            db,
            principal,
            operation_id,
        )?)?),
        "knowledge" => Ok(serde_json::to_value(service::get_knowledge(
            db,
            principal,
            operation_id,
        )?)?),
        "decision" => Ok(serde_json::to_value(service::get_decision_authorized(
            db,
            principal,
            operation_id,
        )?)?),
        "handoff" => Ok(serde_json::to_value(handoff::get_handoff(
            db,
            principal,
            operation_id,
        )?)?),
        "report" => Ok(serde_json::to_value(handoff::get_report(
            db,
            principal,
            operation_id,
        )?)?),
        other => Err(AppError::Conflict(format!(
            "operation_kind={other} 不是可恢复的创建类操作，禁止重新执行"
        ))),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 幂等指纹：`sha256("{method}\n{path}\n{sorted_query}\n{body_hash}")`。
/// query 先按 `(key, value)` 排序，避免参数顺序不同被判成不同请求。
pub(crate) fn fingerprint(
    method: &hyper::Method,
    path: &str,
    query: &HashMap<String, String>,
    body_hash: &str,
) -> String {
    let mut pairs: Vec<(&str, &str)> = query
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    pairs.sort_unstable();
    let sorted_query = pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    sha256_hex(format!("{method}\n{path}\n{sorted_query}\n{body_hash}").as_bytes())
}

/// 重放缓存响应：数据与首次响应一致，只把 `meta.replayed` 置真，
/// 并把 `meta.request_id` 换成当前请求（与 `X-Request-Id` 头保持一致）。
fn replay_response(
    response_json: &str,
    status_code: u16,
    principal: &Principal,
    request_id: &str,
) -> Response<Full<Bytes>> {
    let Ok(mut value) = serde_json::from_str::<Value>(response_json) else {
        return fail_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &AppError::Unavailable("幂等缓存响应不可解析".into()),
            principal,
            request_id,
        );
    };
    if let Some(meta) = value.get_mut("meta").and_then(Value::as_object_mut) {
        meta.insert("request_id".into(), json!(request_id));
        meta.insert("replayed".into(), json!(true));
    }
    plain(
        StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK),
        value,
        request_id,
    )
}

/// 只读轮询已完成结果（不重新抢租约，避免抢走 holder 的 inflight 占位）。
async fn wait_for_cached(
    db: &Db,
    agent_row_id: &str,
    key: &str,
    deadline: Instant,
) -> Option<(String, String, u16)> {
    let wait_until = deadline.min(Instant::now() + IN_PROGRESS_WAIT);
    loop {
        if let Ok(Some(row)) = read_cached_done(db, agent_row_id, key) {
            return Some(row);
        }
        if Instant::now() >= wait_until {
            return None;
        }
        tokio::time::sleep(IN_PROGRESS_POLL).await;
    }
}

fn read_cached_done(
    db: &Db,
    agent_row_id: &str,
    key: &str,
) -> AppResult<Option<(String, String, u16)>> {
    db.with_read(|conn| {
        conn.query_row(
            "SELECT request_hash, response_json, status_code FROM agent_request_cache
             WHERE agent_row_id = ?1 AND interface = 'rest' AND idempotency_key = ?2
               AND state = 'done'
               AND expires_at > strftime('%Y-%m-%dT%H:%M:%S','now')",
            rusqlite::params![agent_row_id, key],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as u16,
                ))
            },
        )
        .optional()
        .map_err(AppError::from)
    })
}

async fn handle(req: Request<Incoming>, state: Arc<RestState>) -> Response<Full<Bytes>> {
    let request_id = format!("rest-{}", uuid::Uuid::new_v4().simple());
    // 预算从进入 handler 立刻起算：body 读取与 dispatch 共享同一份 deadline，
    // 避免「慢速发 body」把连接无限占住。
    let deadline = Instant::now() + REQUEST_TIMEOUT_EFFECTIVE;
    counters().0.fetch_add(1, Ordering::Relaxed);
    if req.headers().contains_key("origin") {
        counters().1.fetch_add(1, Ordering::Relaxed);
        return fail_with_code(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "浏览器跨域请求被拒绝（本地 API 仅允许命令行 Agent）",
            &Principal::local(Source::Rest),
            &request_id,
        );
    }
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = parse_query(req.uri().query().unwrap_or(""));
    let principal = match authenticate(&state, &req, &request_id) {
        Ok(p) => p,
        Err(resp) => {
            counters().1.fetch_add(1, Ordering::Relaxed);
            return resp;
        }
    };
    if !rate_check(&state) {
        counters().1.fetch_add(1, Ordering::Relaxed);
        return fail_with_code(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "超过每分钟 120 次限制",
            &principal,
            &request_id,
        );
    }

    // 幂等：仅 POST + Idempotency-Key + 已注册 Agent（本地人/系统身份没有 agent_row_id）。
    // Key 先取出成独立字符串：`read_body_limited` 会拿走整个 `req`。
    let raw_idem_key: Option<String> = req
        .headers()
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let body = match read_body_limited(req, &principal, deadline, &request_id).await {
        Ok(body) => body,
        Err(resp) => return resp,
    };
    let idem = idempotency_scope(&principal, &method, raw_idem_key.as_deref()).map(|(key, row_id)| {
        (
            key,
            row_id,
            fingerprint(&method, &path, &query, &sha256_hex(&body)),
        )
    });

    let mut claim: Option<IdemClaim> = None;
    if let Some((key, row_id, fp)) = &idem {
        match store::cache_claim(
            &state.db,
            row_id,
            "rest",
            key,
            fp,
            method.as_str(),
            &path,
            IDEMPOTENCY_LEASE_SECS,
            IDEMPOTENCY_TTL_HOURS,
        ) {
            Ok(store::CacheClaim::Acquired { attempt }) => {
                claim = Some(IdemClaim {
                    key: key.clone(),
                    row_id: row_id.clone(),
                    fingerprint: fp.clone(),
                    attempt,
                });
            }
            Ok(store::CacheClaim::Done {
                fingerprint: cached_fp,
                response_json,
                status_code,
            }) => {
                if cached_fp == *fp {
                    return replay_response(&response_json, status_code, &principal, &request_id);
                }
                return conflict_response(
                    "IDEMPOTENCY_CONFLICT: 该 Idempotency-Key 已绑定其它请求（方法/路径/查询/请求体不一致），请换用新的 Key",
                    &principal,
                    &request_id,
                );
            }
            Ok(store::CacheClaim::Committed {
                fingerprint: cached_fp,
                attempt: committed_attempt,
                operation_kind,
                operation_id,
                committed_at,
            }) => {
                if cached_fp != *fp {
                    return conflict_response(
                        "IDEMPOTENCY_CONFLICT: 该 Idempotency-Key 已绑定其它请求（方法/路径/查询/请求体不一致），请换用新的 Key",
                        &principal,
                        &request_id,
                    );
                }
                // 业务事务已提交、响应未落缓存（进程在两者之间退出）。
                // **只重建响应，绝不重新执行**：重建走已有授权读取，不产生任何业务写入。
                match rebuild_committed_response(&state.db, &principal, &operation_kind, &operation_id)
                {
                    Ok(data) => {
                        let mut meta = meta_of(&principal, &request_id, None);
                        meta.replayed = true;
                        let value = serde_json::to_value(Envelope::ok(data, meta))
                            .unwrap_or(Value::Null);
                        let status = StatusCode::CREATED;
                        let text = serde_json::to_string(&value).unwrap_or_default();
                        // committed → done：补写响应供后续重试直接重放（不触发业务写入）。
                        match store::cache_complete(
                            &state.db,
                            row_id,
                            "rest",
                            key,
                            fp,
                            committed_attempt,
                            &text,
                            status.as_u16(),
                        ) {
                            Ok(true) => {}
                            Ok(false) => tracing::warn!(
                                %request_id,
                                "幂等结果恢复时占位已变化，本次响应未缓存"
                            ),
                            Err(err) => {
                                tracing::warn!(%request_id, "幂等结果恢复写入失败: {err}")
                            }
                        }
                        return plain(status, value, &request_id);
                    }
                    Err(err) => {
                        return conflict_response(
                            format!(
                                "IDEMPOTENCY_RECOVERY_REQUIRED: 该请求已提交（operation_kind={operation_kind} operation_id={operation_id} committed_at={committed_at}），但响应无法重建：{}；请读取资源状态，不要重试写入",
                                err.user_message()
                            ),
                            &principal,
                            &request_id,
                        );
                    }
                }
            }
            Ok(store::CacheClaim::InProgress { .. }) => {
                match wait_for_cached(&state.db, row_id, key, deadline).await {
                    Some((cached_fp, text, code)) if cached_fp == *fp => {
                        return replay_response(&text, code, &principal, &request_id);
                    }
                    Some(_) => {
                        return conflict_response(
                            "IDEMPOTENCY_CONFLICT: 该 Idempotency-Key 已绑定其它请求（方法/路径/查询/请求体不一致），请换用新的 Key",
                            &principal,
                            &request_id,
                        );
                    }
                    None => {
                        // 有界等待（≤2s）后仍在处理中 → 409，绝不重复执行业务写入。
                        return conflict_response(
                            "IDEMPOTENCY_IN_PROGRESS: 相同 Idempotency-Key 的请求正在处理中，请稍后重试",
                            &principal,
                            &request_id,
                        );
                    }
                }
            }
            Err(err) => {
                // 占位不可用时失败关闭：降级执行会造成重复写入。
                return fail_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &err,
                    &principal,
                    &request_id,
                );
            }
        }
    }

    let completed = match &claim {
        Some(claim) => {
            // ── 迟到完成模型 ──
            // 超时**不等于**业务事务已回滚：事务可能已 commit，只是响应还没写回。
            // 因此业务执行交给被登记的后台任务，超时后继续在宽限期内跑完；
            // 幂等占位在后台给出结论前**保留**（不释放、不删除），
            // 客户端重试只能拿到「重放」或「进行中」，绝不会把业务写入执行两次。
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            let grace_deadline = deadline + LATE_GRACE;
            let bg_state = state.clone();
            let bg_principal = principal.clone();
            let bg_method = method.clone();
            let bg_path = path.clone();
            let bg_query = query.clone();
            let bg_body = body.clone();
            let bg_claim = claim.clone();
            let bg_request_id = request_id.clone();
            let spawned = spawn_tracked(async move {
                run_claim_execution(
                    bg_state,
                    bg_principal,
                    bg_method,
                    bg_path,
                    bg_query,
                    bg_body,
                    bg_claim,
                    grace_deadline,
                    bg_request_id,
                    Some(reply_tx),
                )
                .await;
            });
            if spawned.is_none() {
                // 正在停止：无法兜底 → 失败关闭，绝不放行「无幂等」的执行。
                return fail_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &AppError::Unavailable("REST 正在停止，无法处理请求".into()),
                    &principal,
                    &request_id,
                );
            }
            match tokio::time::timeout_at(deadline.into(), reply_rx).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(AppError::Unavailable("REST 后台执行通道异常关闭".into())),
                Err(_) => {
                    // 超时：占位保留（后台继续在宽限期内跑完），返回 408。
                    return timeout_response(&principal, &request_id);
                }
            }
        }
        None => {
            // 无幂等占位：超时即取消（事务未提交则随 future drop 回滚）。
            let operation = begin_rest_operation(&state.db, &principal, &method, &path, &request_id);
            // 无幂等占位的写路径：用空业务守卫 + 操作守卫，同样把状态收尾放进业务事务。
            let operation_guard = operations::OperationGuard::new(
                operation
                    .as_ref()
                    .map(|op| op.id.clone())
                    .unwrap_or_default(),
            );
            let guarded = operations::CompositeGuard::new(&store::NoGuard, &operation_guard);
            match tokio::time::timeout_at(
                deadline.into(),
                dispatch(
                    &state,
                    &principal,
                    &method,
                    &path,
                    &query,
                    &body,
                    &guarded,
                ),
            )
            .await
            {
                Ok(Ok((data, page))) => {
                    let data = match query.get("fields").filter(|_| method == hyper::Method::GET) {
                        Some(fields) => match project_read_fields(data, fields) {
                            Ok(data) => data,
                            Err(err) => {
                                return fail_response(
                                    StatusCode::BAD_REQUEST, &err, &principal, &request_id,
                                );
                            }
                        },
                        None => data,
                    };
                    if let Some(op) = &operation {
                        let result =
                            operations::OperationResult::from_value(&op.resource_kind, &data);
                        match operations::complete(&state.db, &op.id, &result) {
                            Ok(Some(_)) => {}
                            _ => operations::notify_current(&state.db, &op.id),
                        }
                    }
                    let meta = meta_of(&principal, &request_id, page);
                    let envelope = Envelope::ok(data, meta);
                    let value = serde_json::to_value(&envelope).unwrap_or(Value::Null);
                    let status = if method == hyper::Method::POST {
                        StatusCode::CREATED
                    } else {
                        StatusCode::OK
                    };
                    Ok(Completed { value, status })
                }
                Ok(Err(err)) => {
                    if let Some(op) = &operation {
                        let _ = operations::fail(&state.db, &op.id, &err);
                    }
                    Err(err)
                }
                Err(_) => {
                    // 无幂等占位的超时：future 已被取消，事务未提交（回滚），
                    // 操作收敛为 interrupted 并记录明确原因，避免悬挂 90s。
                    if let Some(op) = &operation {
                        let _ = operations::fail_with(
                            &state.db,
                            &op.id,
                            operations::OperationStatus::Interrupted,
                            "REQUEST_TIMEOUT",
                            "请求超时，业务执行已取消",
                        );
                    }
                    return timeout_response(&principal, &request_id);
                }
            }
        }
    };
    match completed {
        Ok(done) => plain(done.status, done.value, &request_id),
        Err(err) => {
            let code = error_code(&err);
            let status =
                StatusCode::from_u16(http_status(code)).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let meta = meta_of(&principal, &request_id, None);
            let envelope = Envelope::fail(&err, meta);
            let value = serde_json::to_value(&envelope).unwrap_or(Value::Null);
            store::log_activity(
                &state.db,
                &store::ActivityEntry {
                    principal: &principal,
                    action: "rest.failed",
                    resource_kind: "",
                    resource_id: "",
                    project_id: "",
                    request_id: &request_id,
                    success: false,
                    error_code: code,
                    detail: &err.user_message(),
                    revision: None,
                    duration_ms: 0,
                },
            );
            plain(status, value, &request_id)
        }
    }
}

/// 只投影已完成鉴权的 GET 数据，信封和分页元数据不参与筛选。
fn project_read_fields(mut data: Value, raw: &str) -> AppResult<Value> {
    let fields: Vec<_> = raw.split(',').map(str::trim).collect();
    if fields.len() > 50 || fields.iter().any(|field| field.is_empty()) {
        return Err(AppError::Validation("fields 需要 1–50 个非空字段".into()));
    }
    let rows = match &mut data {
        Value::Object(row) => vec![row],
        Value::Array(rows) => rows
            .iter_mut()
            .map(|row| row.as_object_mut().ok_or_else(|| {
                AppError::Validation("该响应不支持字段筛选".into())
            }))
            .collect::<AppResult<Vec<_>>>()?,
        _ => return Err(AppError::Validation("该响应不支持字段筛选".into())),
    };
    if !rows.is_empty() {
        for field in &fields {
            if !rows.iter().any(|row| row.contains_key(*field)) {
                return Err(AppError::Validation(format!("未知响应字段: {field}")));
            }
        }
    }
    for row in rows {
        row.retain(|key, _| fields.contains(&key.as_str()));
    }
    Ok(data)
}

/// 读取请求体：Content-Length 与流式累计字节双重限长，且每一帧都受同一 deadline 约束。
async fn read_body_limited(
    req: Request<Incoming>,
    principal: &Principal,
    deadline: Instant,
    request_id: &str,
) -> Result<Vec<u8>, Response<Full<Bytes>>> {
    if let Some(len) = req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if len > MAX_BODY as u64 {
            return Err(fail_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                &AppError::Validation(format!("body 超过 {MAX_BODY} 字节上限")),
                principal,
                request_id,
            ));
        }
    }
    let mut body = req.into_body();
    let mut out: Vec<u8> = Vec::new();
    loop {
        let frame = match tokio::time::timeout_at(deadline.into(), body.frame()).await {
            Ok(Some(Ok(frame))) => frame,
            Ok(Some(Err(_))) => {
                return Err(fail_response(
                    StatusCode::BAD_REQUEST,
                    &AppError::Validation("请求体不可读".into()),
                    principal,
                    request_id,
                ));
            }
            Ok(None) => break,
            Err(_) => return Err(timeout_response(principal, request_id)),
        };
        if let Some(data) = frame.data_ref() {
            // 缺 Content-Length（chunked）时同样受限。
            if out.len() + data.len() > MAX_BODY {
                return Err(fail_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    &AppError::Validation(format!("body 超过 {MAX_BODY} 字节上限")),
                    principal,
                    request_id,
                ));
            }
            out.extend_from_slice(data);
        }
    }
    Ok(out)
}

fn parse_query(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in raw.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = url_decode(k);
        let value = url_decode(v);
        out.insert(key, value);
    }
    out
}

fn url_decode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        match c {
            '%' => {
                let a = chars.next();
                let b = chars.next();
                if let (Some(a), Some(b)) = (a, b) {
                    if let Ok(byte) = u8::from_str_radix(&format!("{a}{b}"), 16) {
                        out.push(byte as char);
                        continue;
                    }
                }
            }
            '+' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

fn q_num(query: &HashMap<String, String>, key: &str, default: u32) -> u32 {
    query
        .get(key)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default)
        .clamp(1, 200)
}

fn q_off(query: &HashMap<String, String>) -> u32 {
    query
        .get("offset")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0)
}

fn parse_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> AppResult<T> {
    serde_json::from_slice(body)
        .map_err(|e| AppError::Validation(format!("请求体 JSON 非法: {e}")))
}

/// 统一分发。`guard` 为事务内写守卫：有幂等占位时是 `RequestCacheGuard`，
/// 否则是 `NoGuard`。泛型而非 `&dyn`，是为了让「引用可跨线程」在编译期成立
/// （spawn 的后台执行 future 必须 `Send`）。
/// `POST /api/v1/projects` 请求体。
///
/// 与 IPC/MCP/CLI 共用同一创建服务；这里只做字段搬运与默认值，不含业务规则。
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct RestCreateProject {
    #[serde(default, alias = "requestId")]
    client_request_id: Option<String>,
    name: String,
    kind: Option<String>,
    description: Option<String>,
    goal: Option<String>,
    target_date: Option<String>,
    template_id: Option<String>,
    root_path: Option<String>,
    directory_mode: Option<String>,
    dev_project_id: Option<String>,
    note: Option<String>,
    plan_name: Option<String>,
    #[serde(default)]
    initial_plan: Option<RestInitialPlan>,
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct RestInitialPlan {
    #[serde(default)]
    goals: Vec<crate::project_hub::service::CreateGoalInput>,
    #[serde(default)]
    phases: Vec<crate::project_hub::service::CreatePhaseInput>,
    #[serde(default)]
    features: Vec<crate::project_hub::service::CreateFeatureInput>,
    #[serde(default)]
    tasks: Vec<crate::project_hub::service::CreateTaskInput>,
    #[serde(default)]
    capabilities: Vec<crate::project_hub::service::CreateCapabilityInput>,
}

async fn dispatch<G>(
    state: &RestState,
    principal: &Principal,
    method: &hyper::Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &[u8],
    guard: &G,
) -> AppResult<(Value, Option<Page>)>
where
    G: store::WriteGuard + Sync,
{
    let db = state.db.as_ref();
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    if segments.first() != Some(&"api") || segments.get(1) != Some(&"v1") {
        return Err(AppError::NotFound(format!("未知路径 {path}")));
    }
    let rest = &segments[2..];
    let m = method.as_str();
    // 仅测试：注入一个「先等待、后写入」的慢路径，验证超时取消不会留下半条数据，
    // 以及超时后的「迟到完成」语义。`delay_ms` 可调，用来构造
    // 「比请求预算长、但比宽限期短」的窗口（后台能在宽限期内写完）。
    // 生产构建中该分支不存在，也不进入路由表/OpenAPI。
    #[cfg(test)]
    if m == "POST" && rest.len() == 2 && rest[0] == "__test" && rest[1] == "slow-create-task" {
        let delay_ms = query
            .get("delay_ms")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(30_000);
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        let input: service::TaskCreateInput = parse_body(body)?;
        let task = service::create_task_guarded(db, principal, input, guard, "")?;
        return Ok((serde_json::to_value(task)?, None));
    }
    let seg = |i: usize| rest.get(i).copied().unwrap_or("");
    match (m, rest) {
        ("GET", ["status"]) => Ok((service::status_snapshot(db, principal)?, None)),
        ("GET", ["manifest"]) => Ok((workspace::manifest(db)?, None)),
        ("GET", ["openapi.json"]) => Ok((openapi(), None)),
        ("GET", ["projects"]) => {
            let (items, page) = service::list_projects(
                db,
                principal,
                query.get("kind").map(String::as_str),
                query.get("q").map(String::as_str),
                q_num(query, "limit", 50),
                q_off(query),
            )?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["projects"]) => {
            // 创建是独立能力；scope=project_rw 不隐含创建权。
            perms::require(db, principal, Capability::ProjectsCreate, "")?;
            let input: RestCreateProject = parse_body(body)?;
            let mode = match input.directory_mode.as_deref().map(str::trim) {
                None | Some("") => crate::project_hub::creation::DirectoryMode::default_for(
                    input.root_path.as_deref().unwrap_or_default(),
                ),
                Some(raw) => crate::project_hub::creation::DirectoryMode::parse(raw)
                    .ok_or_else(|| {
                        AppError::Validation(format!("未知的 directoryMode：{raw}"))
                    })?,
            };
            if mode == crate::project_hub::creation::DirectoryMode::CreateNew {
                // REST 是 Agent 接口：不代任何客户端创建目录（目录必须由人类在 UI/CLI 明确确认）。
                return Err(AppError::Validation(
                    "REST 不支持 directoryMode=create_new；请由人类在 UI 或 CLI 创建目录".into(),
                ));
            }
            let draft = input.initial_plan.unwrap_or_default();
            let request = crate::project_hub::creation::CreateProjectRequest {
                client_request_id: input.client_request_id.unwrap_or_default(),
                name: input.name,
                kind: input.kind.unwrap_or_else(|| "general".into()),
                description: input.description.unwrap_or_default(),
                goal: input.goal.unwrap_or_default(),
                target_date: input.target_date,
                template_id: input.template_id,
                root_path: input.root_path,
                directory_mode: mode,
                dev_project_id: input.dev_project_id,
                note: input.note,
                plan_name: input.plan_name,
                plan_description: None,
                plan_status: None,
                draft: crate::project_hub::creation::InitialPlanDraft {
                    goals: draft.goals,
                    phases: draft.phases,
                    features: draft.features,
                    tasks: draft.tasks,
                    capabilities: draft.capabilities,
                },
                agent_access_policy:
                    crate::project_hub::creation::AgentAccessPolicy::CreatorProjectAndPlan,
            };
            let created = crate::project_hub::creation::create(db, request)?;
            if let Some(row_id) = principal.agent_row_id.as_deref() {
                perms::grant_created_project(
                    db,
                    row_id,
                    &created.project.id,
                )?;
            }
            Ok((serde_json::to_value(&created)?, None))
        }
        ("GET", ["projects", _, "status"]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::project_status(db, principal, id)?)?, None))
        }
        ("GET", ["projects", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::get_project(db, principal, id)?)?, None))
        }
        ("GET", ["tasks"]) => {
            let filter = crate::commands::tasks::TaskFilter {
                view: query.get("view").cloned(),
                status: query.get("status").cloned(),
                category: query.get("category").cloned(),
                tag: query.get("tag").cloned(),
                priority: query.get("priority").and_then(|v| v.parse().ok()),
                search: query.get("q").or_else(|| query.get("search")).cloned(),
                sort: query.get("sort").cloned(),
                limit: None,
            };
            let (items, page) =
                service::list_tasks(db, principal, filter, q_num(query, "limit", 50), q_off(query))?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["tasks"]) => {
            let task = service::create_task_guarded(db, principal, parse_body(body)?, guard, "")?;
            Ok((serde_json::to_value(task)?, None))
        }
        ("GET", ["tasks", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::fetch_task(db, principal, id)?)?, None))
        }
        ("PATCH", ["tasks", _]) => {
            let id = seg(1);
            let value: Value = parse_body(body)?;
            let base = value
                .get("base_revision")
                .and_then(Value::as_i64)
                .or_else(|| query.get("base_revision").and_then(|v| v.parse().ok()));
            let patch: service::TaskPatch = serde_json::from_value(value)
                .map_err(|e| AppError::Validation(format!("请求体字段非法: {e}")))?;
            Ok((
                serde_json::to_value(service::update_task_guarded(
                    db, principal, id, patch, base, guard,
                )?)?,
                None,
            ))
        }
        ("POST", ["tasks", _, "complete"]) => {
            let id = seg(1);
            let base = query.get("base_revision").and_then(|v| v.parse().ok());
            Ok((
                serde_json::to_value(service::complete_task_guarded(
                    db, principal, id, base, guard,
                )?)?,
                None,
            ))
        }
        ("GET", ["plans", "current"]) => {
            Ok((serde_json::to_value(service::current_plan(db, principal)?)?, None))
        }
        ("GET", ["plans"]) => {
            let project = query.get("project").map(String::as_str);
            let (items, page) =
                service::list_plans(db, principal, project, q_num(query, "limit", 50), q_off(query))?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("GET", ["plans", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::get_plan(db, principal, id)?)?, None))
        }
        ("GET", ["knowledge", "search"]) => {
            let q = query.get("q").cloned().unwrap_or_default();
            if q.trim().is_empty() {
                return Err(AppError::Validation("缺少 q 查询参数".into()));
            }
            let kb_ids: Vec<String> = query
                .get("kb")
                .map(|v| vec![v.clone()])
                .unwrap_or_default();
            let (items, page) =
                service::search_knowledge(db, principal, &q, &kb_ids, q_num(query, "limit", 20), q_off(query))?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("GET", ["knowledge", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::get_knowledge(db, principal, id)?)?, None))
        }
        ("POST", ["knowledge"]) => {
            let doc =
                service::create_knowledge_guarded(db, principal, parse_body(body)?, guard)?;
            Ok((serde_json::to_value(doc)?, None))
        }
        ("PATCH", ["knowledge", _]) => {
            let id = seg(1);
            let patch: service::KnowledgePatch = parse_body(body)?;
            let base = query.get("base_revision").and_then(|v| v.parse().ok());
            Ok((
                serde_json::to_value(service::update_knowledge_guarded(
                    db, principal, id, patch, base, guard,
                )?)?,
                None,
            ))
        }
        ("GET", ["decisions"]) => {
            let project = query.get("project").map(String::as_str);
            let status = query.get("status").map(String::as_str);
            let (items, page) = service::list_decisions_authorized(
                db,
                principal,
                project,
                status,
                q_num(query, "limit", 50),
                q_off(query),
            )?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["decisions"]) => {
            perms::require(db, principal, Capability::DecisionsWrite, "")?;
            let created = store::create_decision_guarded(db, principal, parse_body(body)?, guard)?;
            Ok((serde_json::to_value(created)?, None))
        }
        ("GET", ["decisions", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::get_decision_authorized(db, principal, id)?)?, None))
        }
        ("GET", ["context"]) => {
            let format = query.get("format");
            let req = context::ContextRequest {
                task: query.get("task").cloned(),
                task_id: query.get("task_id").cloned(),
                project_id: query.get("project").cloned(),
                budget_tokens: query.get("budget").and_then(|v| v.parse().ok()),
                format: format.cloned(),
                ..Default::default()
            };
            let ctx = context::build(db, principal, req)?;
            Ok((context::response(&ctx, format.map(String::as_str))?, None))
        }
        ("GET", ["context", "search"]) => {
            let q = query.get("q").cloned().unwrap_or_default();
            let items = context::recent(db, principal, q_num(query, "limit", 20))?;
            let keywords: Vec<String> = q.split_whitespace().map(str::to_string).collect();
            let filtered: Vec<_> = items
                .into_iter()
                .filter(|i| {
                    let hay = format!("{} {}", i.title, i.summary).to_lowercase();
                    keywords.iter().any(|k| hay.contains(&k.to_lowercase()))
                })
                .collect();
            Ok((serde_json::to_value(filtered)?, None))
        }
        ("GET", ["agents", "handoffs"]) => {
            let (items, page) = handoff::list_handoffs(
                db,
                principal,
                query.get("status").map(String::as_str),
                query.get("project").map(String::as_str),
                q_num(query, "limit", 50),
                q_off(query),
            )?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["agents", "handoffs"]) => {
            let created =
                handoff::create_handoff_guarded(db, principal, parse_body(body)?, guard)?;
            Ok((serde_json::to_value(created)?, None))
        }
        ("GET", ["agents", "handoffs", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(handoff::get_handoff(db, principal, id)?)?, None))
        }
        ("POST", ["agents", "handoffs", _, "accept"]) => {
            let id = seg(1);
            let base = query
                .get("base_revision")
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| AppError::Validation("需要 base_revision 查询参数".into()))?;
            Ok((serde_json::to_value(handoff::accept_handoff(db, principal, id, base)?)?, None))
        }
        ("POST", ["agents", "handoffs", _, "reject"]) => {
            let id = seg(1);
            let base = query
                .get("base_revision")
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| AppError::Validation("需要 base_revision 查询参数".into()))?;
            let reason = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_string))
                .unwrap_or_default();
            Ok((serde_json::to_value(handoff::reject_handoff(db, principal, id, base, &reason)?)?, None))
        }
        ("POST", ["agents", "handoffs", _, "complete"]) => {
            let id = seg(1);
            let base = query
                .get("base_revision")
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| AppError::Validation("需要 base_revision 查询参数".into()))?;
            Ok((serde_json::to_value(handoff::complete_handoff(db, principal, id, base)?)?, None))
        }
        ("GET", ["agents", "reports"]) => {
            let (items, page) = handoff::list_reports(
                db,
                principal,
                query.get("agent").map(String::as_str),
                query.get("handoff").map(String::as_str),
                q_num(query, "limit", 50),
                q_off(query),
            )?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["agents", "reports"]) => {
            let out = handoff::create_report_guarded(db, principal, parse_body(body)?, guard)?;
            Ok((serde_json::to_value(out)?, None))
        }
        ("GET", ["agents", "activity"]) => {
            let activity_query = store::ActivityQuery {
                agent_id: query.get("agent").cloned(),
                interface: query.get("interface").cloned(),
                since: query.get("since").cloned(),
                limit: q_num(query, "limit", 50),
                offset: q_off(query),
            };
            let (items, page) = service::list_activity_authorized(db, principal, &activity_query)?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("GET", ["sync", "status"]) => {
            perms::require(db, principal, Capability::ProjectsRead, "")?;
            Ok((serde_json::to_value(file_sync::status(db)?)?, None))
        }
        ("GET", ["sync", "conflicts"]) => {
            // 先授权再查询：未通过 ProjectsRead 时不得先取数据再过滤。
            perms::require(db, principal, Capability::ProjectsRead, "")?;
            Ok((serde_json::to_value(file_sync::list_conflicts(db)?)?, None))
        }
        ("POST", ["sync", "conflicts", _, "resolve"]) => {
            let id = seg(1);
            let resolution = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| v.get("resolution").and_then(|r| r.as_str()).map(str::to_string))
                .or_else(|| query.get("resolution").cloned())
                .ok_or_else(|| AppError::Validation("需要 resolution: db|file|dismiss".into()))?;
            Ok((
                serde_json::to_value(file_sync::resolve_conflict(db, principal, id, &resolution)?)?,
                None,
            ))
        }
        ("POST", ["sync", "scan"]) => {
            let row = workspace::active(db)?
                .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
            // 调用者身份原样传入：REST 都是已认证 Agent，会被扫描入口拒绝。
            // 文件导入只能由本机用户/后台监听触发，避免「Agent 授权自己」。
            Ok((serde_json::to_value(file_sync::scan(db, principal, &row)?)?, None))
        }
        _ => Err(AppError::NotFound(format!("未知路由 {method} {path}"))),
    }
}

fn openapi() -> Value {
    let paths = ROUTES
        .iter()
        .map(|(method, path, summary)| {
            (
                path.to_string(),
                json!({
                    method.to_lowercase(): {
                        "summary": summary,
                        "responses": { "200": { "description": "统一 JSON 信封" } }
                    }
                }),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    json!({
        "openapi": "3.0.3",
        "info": {
            "title": "Task Dock Agent API",
            "version": super::SCHEMA_VERSION,
            "description": "本地 Agent 访问接口；仅监听 127.0.0.1，需 Bearer token；请求/响应均为统一信封。"
        },
        "servers": [{ "url": "http://127.0.0.1:<agent_api_port>/api/v1" }],
        "security": [{ "bearerAuth": [] }],
        "components": {
            "securitySchemes": {
                "bearerAuth": { "type": "http", "scheme": "bearer" }
            }
        },
        "paths": Value::Object(paths),
    })
}
