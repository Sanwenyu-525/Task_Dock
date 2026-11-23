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
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};
use crate::mcp::auth::{self, McpAgentRow};
use crate::mcp::permissions::Capability;

use super::{
    context, domains::{comic, novel}, error_code, handoff, http_status, operations, permissions as perms,
    service, store, sync as file_sync, workspace, Envelope, Identity, Meta, Page, Principal, Source,
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
    ("GET", "/api/v1/projects/{id}", "项目详情（项目根 + activePlanId）"),
    ("PATCH", "/api/v1/projects/{id}", "更新项目根（需 projects.write 与 expectedRevision）"),
    ("GET", "/api/v1/projects/{id}/status", "项目状态与下一步"),
    ("GET", "/api/v1/tasks", "任务列表（支持 project/status/search/limit/offset）"),
    ("GET", "/api/v1/tasks/{id}", "任务详情"),
    ("POST", "/api/v1/tasks", "创建任务，可指定 project_id"),
    ("POST", "/api/v1/tasks/{id}/link", "关联任务与 project_id"),
    ("POST", "/api/v1/tasks/{id}/unlink", "解除任务与 project_id 的关联"),
    ("PATCH", "/api/v1/tasks/{id}", "更新任务（需 base_revision）"),
    ("POST", "/api/v1/tasks/{id}/complete", "完成任务"),
    ("GET", "/api/v1/plans", "规划列表"),
    ("GET", "/api/v1/plans/current", "当前规划"),
    ("GET", "/api/v1/plans/{planId}", "规划详情（严格计划 ID）"),
    ("PATCH", "/api/v1/plans/{planId}", "更新计划执行状态/排序（严格计划 ID，需 expectedRevision）"),
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
    ("GET", "/api/v1/projects/{id}/domain-manifest", "项目领域能力 Manifest"),
    ("GET", "/api/v1/projects/{id}/novel/chapters", "小说章节摘要列表"),
    ("GET", "/api/v1/projects/{id}/novel/chapters/{chapterId}", "单章元信息"),
    ("GET", "/api/v1/projects/{id}/novel/chapters/{chapterId}/content", "单章正文"),
    ("PUT", "/api/v1/projects/{id}/novel/chapters/{chapterId}/content", "更新单章正文"),
    ("GET", "/api/v1/projects/{id}/novel/characters", "小说人物列表"),
    ("GET", "/api/v1/projects/{id}/novel/worldview", "小说世界观列表"),
    ("GET", "/api/v1/projects/{id}/novel/refs", "小说章节实体引用列表"),
    ("GET", "/api/v1/projects/{id}/comic/episodes", "漫剧剧集列表"),
    ("GET", "/api/v1/projects/{id}/comic/shots", "漫剧镜头列表"),
    ("GET", "/api/v1/projects/{id}/comic/media-versions", "漫剧素材版本列表"),
    ("GET", "/api/v1/projects/{id}/comic/characters", "漫剧角色列表"),
    ("GET", "/api/v1/projects/{id}/comic/scenes", "漫剧场景列表"),
    ("PUT", "/api/v1/projects/{id}/comic/media-versions/{mediaId}", "更新素材版本元信息"),
    ("POST", "/api/v1/projects/{id}/comic/media-versions/{mediaId}/adopt", "采用素材版本"),
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
    // PUT 语义是「带 expectedRevision 的幂等更新」，网络重试可能已经提交成功，
    // 必须支持 Idempotency-Key 才能避免误报冲突；PATCH/GET 仍不支持。
    if method != &hyper::Method::POST && method != &hyper::Method::PUT {
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
    let project_id = operations::rest_project_ref(path)
        .and_then(|raw| {
            db.with_read(|conn| perms::resolve_project_root(conn, &raw))
                .ok()
                .flatten()
        })
        .unwrap_or_default();
    operations::try_start(
        db,
        principal,
        &operations::OperationInput {
            action,
            resource_kind: kind,
            resource_id: &target_id,
            project_id: &project_id,
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
        "novel.chapter" => novel::rebuild_committed(db, principal, operation_id),
        "comic.media_version" => comic::rebuild_committed(db, principal, operation_id),
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

    // 幂等：POST/PUT + Idempotency-Key + 已注册 Agent（本地人/系统身份没有 agent_row_id）。
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
        if let Err(err) = authorize_project_task_request(&state.db, &principal, &path, &body) {
            let status = StatusCode::from_u16(http_status(error_code(&err)))
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            return fail_response(status, &err, &principal, &request_id);
        }
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
                        let status = if method == hyper::Method::PUT {
                            StatusCode::OK
                        } else {
                            StatusCode::CREATED
                        };
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

#[derive(Deserialize)]
struct CreateTaskBody {
    #[serde(flatten)]
    task: service::TaskCreateInput,
    project_id: Option<String>,
}

#[derive(Deserialize)]
struct TaskProjectBody {
    project_id: String,
}

/// 缓存重放也必须在当前授权范围内，项目授权被撤销后不能读出旧响应。
fn authorize_project_task_request(
    db: &Db,
    principal: &Principal,
    path: &str,
    body: &[u8],
) -> AppResult<()> {
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    let (project, task) = match segments.as_slice() {
        ["api", "v1", "tasks"] => {
            let request: CreateTaskBody = parse_body(body)?;
            let Some(project) = request.project_id else {
                return Ok(());
            };
            (project, "")
        }
        ["api", "v1", "tasks", task, "link" | "unlink"] => {
            let request: TaskProjectBody = parse_body(body)?;
            (request.project_id, *task)
        }
        _ => return Ok(()),
    };
    db.with_read(|conn| perms::authorize_project_task_write(conn, principal, &project, task))?;
    Ok(())
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

/// `PATCH /api/v1/projects/{id}` 请求体（项目根聚合）。
///
/// 事实源是项目根（`workspace_projects`）：name/kind/description/goal/
/// lifecycleStatus 可选，targetDate 三态（缺省 = 保持原值；null = 清除；值 = 设置）。
/// `status` 是旧客户端兼容字段：值 ∈ {active, archived} 时按生命周期处理；
/// 值 ∈ 计划执行状态（planning/in_progress/paused/completed）时明确拒绝并指向
/// `PATCH /api/v1/plans/{planId}`。
/// expectedRevision 是**项目根 revision**（`workspace_projects.revision`）；外部写入口
/// 必填，缺失返回 Validation；不匹配返回 Conflict（→ 409）。
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct RestPatchProject {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    goal: Option<String>,
    /// 项目根生命周期状态（active|archived）。
    #[serde(default)]
    lifecycle_status: Option<String>,
    /// 旧客户端兼容字段：语义见结构体注释，与 lifecycleStatus 合并后校验一致性。
    #[serde(default)]
    status: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::commands::tasks::deserialize_optional_field"
    )]
    target_date: Option<Option<String>>,
    #[serde(default)]
    expected_revision: Option<i64>,
}

/// `PATCH /api/v1/plans/{planId}` 请求体（**计划聚合**）。
///
/// 只接受计划自身字段：执行状态与排序。名称/描述/目标日期属于项目根，
/// 请使用 `PATCH /api/v1/projects/{projectId}`；`expectedRevision` 是**计划
/// revision**，必填（缺失返回 Validation），与项目根 revision 完全独立。
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct RestPatchPlan {
    /// 计划执行状态（planning|in_progress|paused|completed）。
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    sort_order: Option<i64>,
    #[serde(default)]
    expected_revision: Option<i64>,
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
    if let Some(result) = super::domain_rest::handle(
        db, principal, m, rest, query, body, guard,
    ) {
        return result;
    }
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
                    crate::project_hub::creation::AgentAccessPolicy::CreatorProject,
                principal: match principal.identity {
                    Identity::RegisteredAgent => {
                        crate::project_hub::creation::RequestPrincipal::agent(
                            principal.agent_row_id.as_deref().unwrap_or_default(),
                        )
                    }
                    _ => crate::project_hub::creation::RequestPrincipal::local_human(),
                },
            };
            // Agent 走统一创建用例（scope/能力/创建/自动授权单事务完成，
            // 消除「创建已提交、事务外授权失败」的不一致窗口）；其余身份保持原路径。
            let created = match principal.identity {
                Identity::RegisteredAgent => {
                    crate::agent_access::project_creation::create_for_agent(
                        db,
                        principal.agent_row_id.as_deref().unwrap_or_default(),
                        request,
                    )?
                }
                _ => crate::project_hub::creation::create(db, request)?,
            };
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
        ("PATCH", ["projects", _]) => {
            let id = seg(1);
            // 先解析项目根（入参兼容计划 ID）：统一授权第三层按项目根判定 grant。
            let root = db
                .with_read(|conn| perms::resolve_project_root(conn, id))?
                .ok_or_else(|| AppError::NotFound(format!("项目不存在: {id}")))?;
            // LocalHuman 直接过；RegisteredAgent 需 projects.write 能力 + 项目根 grant。
            perms::require(db, principal, Capability::ProjectsWrite, &root)?;
            let patch: RestPatchProject = parse_body(body)?;
            // 旧客户端兼容：`status` 可能带的是计划执行状态——项目根聚合明确拒绝并指路，
            // 其余值交由服务层枚举校验（不在 REST 层吞掉非法值）。
            let status_lifecycle = match patch.status.as_deref().map(str::trim) {
                None => None,
                Some(s) if crate::commands::planning::PROJECT_STATUSES.contains(&s) => {
                    return Err(AppError::Validation(format!(
                        "项目根不接受计划执行状态（status={s}），请使用 PATCH /api/v1/plans/{{planId}}"
                    )));
                }
                Some(s) => Some(s.to_string()),
            };
            // lifecycleStatus 与 status 同时出现且不一致 → Validation。
            let lifecycle_status = match (&patch.lifecycle_status, &status_lifecycle) {
                (Some(a), Some(b)) if a.trim() != b.as_str() => {
                    return Err(AppError::Validation(format!(
                        "lifecycleStatus({}) 与 status({}) 不一致",
                        a.trim(),
                        b
                    )));
                }
                (Some(a), _) => Some(a.clone()),
                (None, b) => b.clone(),
            };
            // 项目根聚合：返回 ProjectSummary（revision = 根列，与计划 revision 独立）。
            // 外部写入口必须携带 expectedRevision：不传直接 Validation，不允许跳过并发检查。
            let expected = patch.expected_revision.ok_or_else(|| {
                AppError::Validation(
                    "缺少 expectedRevision：项目根更新必须携带读取时获得的项目 revision".into(),
                )
            })?;
            let updated = crate::project_hub::service::update_project(
                db,
                &root,
                crate::project_hub::service::ProjectRootPatch {
                    name: patch.name,
                    kind: patch.kind,
                    description: patch.description,
                    goal: patch.goal,
                    lifecycle_status,
                    target_date: patch.target_date,
                    expected_project_revision: Some(expected),
                },
            )?;
            Ok((serde_json::to_value(updated)?, None))
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
            let limit = q_num(query, "limit", 50);
            let offset = q_off(query);
            let (items, page) = match query.get("project") {
                Some(project) => service::list_project_tasks(db, principal, project, filter, limit, offset)?,
                None => service::list_tasks(db, principal, filter, limit, offset)?,
            };
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["tasks"]) => {
            let request: CreateTaskBody = parse_body(body)?;
            if request.project_id.as_deref().is_some_and(|id| id.trim().is_empty()) {
                return Err(AppError::Validation("project_id 不能为空".into()));
            }
            let task = service::create_task_guarded(
                db, principal, request.task, guard, request.project_id.as_deref().unwrap_or(""),
            )?;
            Ok((serde_json::to_value(task)?, None))
        }
        ("POST", ["tasks", task, action @ ("link" | "unlink")]) => {
            let request: TaskProjectBody = parse_body(body)?;
            let link = service::set_project_task_link(
                db, principal, &request.project_id, task, *action == "link", guard,
            )?;
            Ok((serde_json::to_value(link)?, None))
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
        ("PATCH", ["plans", _]) => {
            let id = seg(1);
            // 身份语义严格：/plans/{planId} 只接受计划 ID，项目根 ID → Validation。
            // （项目根到 active 计划请用 GET /api/v1/plans/current 或 GET /api/v1/projects/{id}。）
            match db.with_read(|conn| crate::project_hub::service::resolve_project_ref(conn, id))? {
                Some(crate::project_hub::service::ProjectRef::Project(_)) => {
                    return Err(AppError::Validation(format!(
                        "{id} 是项目根 ID，不是计划；请使用 GET /api/v1/projects/{id} 读取项目根，或 GET /api/v1/plans/current 读取当前计划"
                    )));
                }
                Some(crate::project_hub::service::ProjectRef::Plan { project_id, .. }) => {
                    // 授权锚定项目根。
                    perms::require(db, principal, Capability::ProjectsWrite, &project_id.0)?;
                }
                None => return Err(AppError::NotFound(format!("计划不存在: {id}"))),
            }
            let patch: RestPatchPlan = parse_body(body)?;
            let expected = patch.expected_revision.ok_or_else(|| {
                AppError::Validation(
                    "缺少 expectedRevision：计划更新必须携带读取时获得的计划 revision".into(),
                )
            })?;
            // 计划聚合：只改执行状态/排序；项目根与镜像列不在本入口职责内。
            let updated = db.with_transaction(|conn| {
                crate::commands::planning::update_plan_tx(
                    conn,
                    id,
                    crate::commands::planning::PlanPatch {
                        execution_status: patch.status,
                        sort_order: patch.sort_order,
                        expected_plan_revision: Some(expected),
                    },
                )
            })?;
            Ok((serde_json::to_value(updated)?, None))
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

/// 项目 PATCH/创建门禁的入口级测试：直接驱动 `dispatch`，不绑端口。
/// 身份覆盖 HTTP 无法构造的 LocalHuman（REST 真实请求只会是 RegisteredAgent）。
#[cfg(test)]
mod project_patch_tests {
    use super::*;
    use std::str::FromStr;
    use std::time::Instant;

    fn rest_state(db: &Arc<Db>) -> RestState {
        RestState {
            db: db.clone(),
            port: 0,
            shutdown: Arc::new(Notify::new()),
            rate: Mutex::new(RateState {
                window: Instant::now(),
                count: 0,
            }),
        }
    }

    fn agent_with_capabilities(
        db: &Db,
        suffix: &str,
        capabilities: &[(&str, &str)],
    ) -> (Principal, String) {
        let created = auth::create_agent(db, &format!("rest-patch-{suffix}"), "REST PATCH 测试")
            .expect("创建 Agent");
        auth::set_agent_scope(db, &created.info.id, "project_rw").expect("设置 scope");
        for (capability, resource) in capabilities {
            crate::mcp::permissions::grant(db, &created.info.id, capability, resource)
                .expect("授予能力");
        }
        (
            Principal::agent(
                created.info.id.clone(),
                created.info.agent_id.clone(),
                Source::Rest,
            ),
            created.info.id,
        )
    }

    /// 项目根 + 关联计划（根/计划 ID 分离；grant 与授权都锚定项目根，v91/v92 规则）。
    /// 根与计划名称一致（兼容镜像状态，§七）；根 revision=5（v93）、计划 revision=3，
    /// 两个值刻意错开，便于断言两条聚合互不影响。
    fn seed_project(db: &Db, root_id: &str, plan_id: &str) {
        let now = crate::agents::now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects
                   (id, name, kind, status, root_path, dev_project_id, note, active_plan_id, created_at, updated_at, revision)
                 VALUES (?1, ?1, 'general', 'active', '', NULL, '', ?2, ?3, ?3, 5)",
                rusqlite::params![root_id, plan_id, now],
            )?;
            conn.execute(
                "INSERT INTO planning_projects
                   (id, name, workspace_project_id, is_active, revision, created_at, updated_at)
                 VALUES (?2, ?1, ?1, 1, 3, ?3, ?3)",
                rusqlite::params![root_id, plan_id, now],
            )?;
            Ok(())
        })
        .expect("写入项目根与计划");
    }

    /// 直读两条聚合的 revision（根列 / 计划列），用于断言互不影响。
    fn sql_revisions(db: &Db, root_id: &str, plan_id: &str) -> (i64, i64) {
        db.with_read(|conn| {
            Ok((
                conn.query_row(
                    "SELECT revision FROM workspace_projects WHERE id = ?1",
                    rusqlite::params![root_id],
                    |r| r.get(0),
                )
                .expect("根行存在"),
                conn.query_row(
                    "SELECT revision FROM planning_projects WHERE id = ?1",
                    rusqlite::params![plan_id],
                    |r| r.get(0),
                )
                .expect("计划行存在"),
            ))
        })
        .expect("读取 revision")
    }

    fn grant_project(db: &Db, row_id: &str, project: &str) {
        auth::grant_project(db, row_id, project).expect("授予项目根授权");
    }

    async fn call(
        state: &RestState,
        principal: &Principal,
        method: &'static str,
        path: &str,
        body: &Value,
    ) -> AppResult<Value> {
        let method = hyper::Method::from_str(method).expect("合法方法");
        let (data, _) = dispatch(
            state,
            principal,
            &method,
            path,
            &HashMap::new(),
            serde_json::to_vec(body).expect("序列化").as_slice(),
            &store::NoGuard,
        )
        .await?;
        Ok(data)
    }

    #[tokio::test]
    async fn agent_with_capability_and_grant_updates_project() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-patch", "plan-patch");
        let (principal, _) =
            agent_with_capabilities(&db, "ok", &[("projects.write", "")]);
        grant_project(&db, &principal.agent_row_id.as_deref().expect("row_id"), "proj-patch");

        let data = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-patch",
            &json!({ "name": "改名后", "expectedRevision": 5 }),
        )
        .await
        .expect("有能力 + 授权必须成功");
        // 项目根聚合返回 ProjectSummary：id/revision 是项目根，不携带 PlanningProject 的 stats。
        assert_eq!(data["id"], json!("proj-patch"));
        assert_eq!(data["name"], json!("改名后"));
        assert_eq!(data["revision"], json!(6), "写成功根 revision +1");
        assert_eq!(data["activePlanId"], json!("plan-patch"));
        assert!(data["stats"].is_null(), "不再返回 PlanningProject");
    }

    #[tokio::test]
    async fn agent_without_grant_is_forbidden() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-nogrant", "plan-nogrant");
        // 有能力但无项目根授权 → 403（统一授权第三层）。
        let (principal, _) =
            agent_with_capabilities(&db, "nogrant", &[("projects.write", "")]);

        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-nogrant",
            &json!({ "name": "越权改名" }),
        )
        .await
        .expect_err("无 grant 必须拒绝");
        assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
        assert_eq!(http_status(error_code(&err)), 403);
    }

    #[tokio::test]
    async fn project_expected_revision_conflict_maps_to_409() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-conflict", "plan-conflict");
        let (principal, row_id) =
            agent_with_capabilities(&db, "conflict", &[("projects.write", "")]);
        grant_project(&db, &row_id, "proj-conflict");

        // 当前根 revision=5，过期期望值 → CONFLICT。
        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-conflict",
            &json!({ "name": "迟到提交", "expectedRevision": 4 }),
        )
        .await
        .expect_err("过期 revision 必须冲突");
        assert_eq!(error_code(&err), "CONFLICT", "{err:?}");
        assert_eq!(http_status(error_code(&err)), 409);
    }

    #[tokio::test]
    async fn plan_expected_revision_conflict_maps_to_409() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-pconflict", "plan-pconflict");
        let (principal, row_id) =
            agent_with_capabilities(&db, "pconflict", &[("projects.write", "")]);
        grant_project(&db, &row_id, "proj-pconflict");

        // 当前计划 revision=3，过期期望值 → CONFLICT。
        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/plans/plan-pconflict",
            &json!({ "status": "paused", "expectedRevision": 2 }),
        )
        .await
        .expect_err("过期计划 revision 必须冲突");
        assert_eq!(error_code(&err), "CONFLICT", "{err:?}");
        assert_eq!(http_status(error_code(&err)), 409);
    }

    #[tokio::test]
    async fn local_human_updates_lifecycle_directly() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-local", "plan-local");
        // 本机人类身份不要求能力/grant（统一授权：LocalHuman 直接过）。
        let principal = Principal::local(Source::Rest);

        let data = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-local",
            &json!({ "name": "本地改名", "lifecycleStatus": "archived", "expectedRevision": 5 }),
        )
        .await
        .expect("LocalHuman 直接成功");
        assert_eq!(data["name"], json!("本地改名"));
        assert_eq!(data["status"], json!("archived"), "status 字段返回项目根生命周期");
    }

    #[tokio::test]
    async fn patch_project_rejects_plan_execution_status() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-compat", "plan-compat");
        let principal = Principal::local(Source::Rest);

        // 旧客户端把计划执行状态传进项目聚合：明确拒绝并指路计划聚合端点。
        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-compat",
            &json!({ "status": "in_progress" }),
        )
        .await
        .expect_err("项目根不接受计划执行状态");
        assert_eq!(error_code(&err), "VALIDATION", "{err:?}");
        assert!(
            err.user_message().contains("PATCH /api/v1/plans/"),
            "错误必须指向计划聚合端点: {}",
            err.user_message()
        );
        assert_eq!(sql_revisions(&db, "proj-compat", "plan-compat"), (5, 3));

        // lifecycleStatus 与 status 同时出现且不一致 → Validation。
        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-compat",
            &json!({ "lifecycleStatus": "active", "status": "archived" }),
        )
        .await
        .expect_err("两个字段不一致必须拒绝");
        assert_eq!(error_code(&err), "VALIDATION", "{err:?}");
        assert!(
            err.user_message().contains("不一致"),
            "错误必须说明字段冲突: {}",
            err.user_message()
        );
    }

    #[tokio::test]
    async fn patch_plan_by_plan_id_returns_planning_project() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-plan", "plan-plan");
        let (principal, row_id) =
            agent_with_capabilities(&db, "plan", &[("projects.write", "")]);
        grant_project(&db, &row_id, "proj-plan");

        let data = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/plans/plan-plan",
            &json!({ "status": "in_progress", "expectedRevision": 3 }),
        )
        .await
        .expect("计划聚合必须成功");
        // 计划聚合返回 PlanningProject（snake_case）：id/revision 是计划自身。
        assert_eq!(data["id"], json!("plan-plan"));
        assert_eq!(data["status"], json!("in_progress"));
        assert_eq!(data["revision"], json!(4), "计划 revision +1");
        assert_eq!(data["workspace_project_id"], json!("proj-plan"));
    }

    #[tokio::test]
    async fn plan_endpoints_are_strictly_plan_scoped() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-scope", "plan-scope");
        let principal = Principal::local(Source::Rest);

        // GET /plans/{planId}：严格计划 ID → 成功，返回计划自身身份。
        let plan = call(
            &rest_state(&db),
            &principal,
            "GET",
            "/api/v1/plans/plan-scope",
            &json!({}),
        )
        .await
        .expect("GET 计划 ID 必须成功");
        assert_eq!(plan["id"], json!("plan-scope"), "计划 ID 原样返回");
        assert_eq!(plan["projectId"], json!("proj-scope"), "projectId 是所属项目根");

        // GET /plans/{projectId}：项目根 ID → Validation（不再静默取 active 计划）。
        let err = call(
            &rest_state(&db),
            &principal,
            "GET",
            "/api/v1/plans/proj-scope",
            &json!({}),
        )
        .await
        .expect_err("GET 项目根 ID 必须拒绝");
        assert_eq!(error_code(&err), "VALIDATION", "{err:?}");
        assert!(
            err.user_message().contains("项目根 ID"),
            "错误必须说明身份混用: {}",
            err.user_message()
        );

        // 未知 ID → NotFound。
        let err = call(
            &rest_state(&db),
            &principal,
            "GET",
            "/api/v1/plans/ghost-plan",
            &json!({}),
        )
        .await
        .expect_err("未知 ID 必须 NotFound");
        assert_eq!(error_code(&err), "NOT_FOUND", "{err:?}");

        // 未授权项目 → Forbidden（授权锚定项目根）。
        let (agent, _) = agent_with_capabilities(&db, "scope", &[("plans.read", "")]);
        let err = call(
            &rest_state(&db),
            &agent,
            "GET",
            "/api/v1/plans/plan-scope",
            &json!({}),
        )
        .await
        .expect_err("无 grant 必须拒绝");
        assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");

        // 当前计划仍可经 /plans/current 获取（语义明确的快捷入口）。
        let current = call(
            &rest_state(&db),
            &principal,
            "GET",
            "/api/v1/plans/current",
            &json!({}),
        )
        .await
        .expect("current 可用");
        assert_eq!(current["id"], json!("plan-scope"));
        assert_eq!(current["projectId"], json!("proj-scope"));
    }

    #[tokio::test]
    async fn empty_patch_is_rejected_without_bumping_revisions() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-empty", "plan-empty");
        let principal = Principal::local(Source::Rest);
        assert_eq!(sql_revisions(&db, "proj-empty", "plan-empty"), (5, 3));

        // 项目根：只有版本令牌、没有字段 → Validation，revision 不变。
        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-empty",
            &json!({ "expectedRevision": 5 }),
        )
        .await
        .expect_err("空项目根补丁必须拒绝");
        assert_eq!(error_code(&err), "VALIDATION", "{err:?}");
        assert!(
            err.user_message().contains("没有可更新的字段"),
            "{}",
            err.user_message()
        );

        // 计划：同理。
        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/plans/plan-empty",
            &json!({ "expectedRevision": 3 }),
        )
        .await
        .expect_err("空计划补丁必须拒绝");
        assert_eq!(error_code(&err), "VALIDATION", "{err:?}");
        assert_eq!(
            sql_revisions(&db, "proj-empty", "plan-empty"),
            (5, 3),
            "空补丁不得推进任何 revision"
        );
    }

    #[tokio::test]
    async fn patch_requires_expected_revision() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-norev", "plan-norev");
        let principal = Principal::local(Source::Rest);

        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-norev",
            &json!({ "name": "无令牌改名" }),
        )
        .await
        .expect_err("缺少 expectedRevision 必须拒绝");
        assert_eq!(error_code(&err), "VALIDATION", "{err:?}");
        assert!(
            err.user_message().contains("expectedRevision"),
            "{}",
            err.user_message()
        );

        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/plans/plan-norev",
            &json!({ "status": "paused" }),
        )
        .await
        .expect_err("缺少 expectedRevision 必须拒绝");
        assert_eq!(error_code(&err), "VALIDATION", "{err:?}");
        assert_eq!(sql_revisions(&db, "proj-norev", "plan-norev"), (5, 3));
    }

    #[tokio::test]
    async fn aggregates_only_accept_their_own_id_domain() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-agg", "plan-agg");
        let (principal, row_id) =
            agent_with_capabilities(&db, "agg", &[("projects.write", "")]);
        grant_project(&db, &row_id, "proj-agg");

        // PATCH /projects/{planId}：入参兼容计划 ID，归一到项目根成功。
        let data = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/plan-agg",
            &json!({ "name": "经计划改根", "expectedRevision": 5 }),
        )
        .await
        .expect("项目聚合兼容计划 ID");
        assert_eq!(data["id"], json!("proj-agg"), "响应归一为项目根");

        // PATCH /plans/{rootId}：计划聚合不接受根 ID（严格 PlanId 语义）。
        let err = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/plans/proj-agg",
            &json!({ "status": "in_progress", "expectedRevision": 3 }),
        )
        .await
        .expect_err("计划聚合必须拒绝根 ID，不伪造计划行");
        // 错误类别锁定：严格身份判定是 Validation（4xx），
        // 绝不能退化为 DATABASE/500 这类把身份错误当基础设施故障的响应。
        assert!(
            matches!(err, AppError::Validation(_)),
            "根 ID 落在计划聚合必须是 Validation: {err:?}"
        );
        // 成功的根改名（根 5→6）+ 失败的计划请求不得改变任何 revision（计划 3）。
        assert_eq!(sql_revisions(&db, "proj-agg", "plan-agg"), (6, 3));
    }

    #[tokio::test]
    async fn patch_project_mirrors_name_to_plan_rows() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-mirror", "plan-mirror");
        let principal = Principal::local(Source::Rest);

        call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-mirror",
            &json!({ "name": "根改名", "description": "根描述", "expectedRevision": 5 }),
        )
        .await
        .expect("LocalHuman 直接成功");
        // 兼容镜像：计划行的 name/description 同步为根字段（唯一事实源是项目根）。
        let mirrored: (String, String) = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT name, description FROM planning_projects WHERE id = ?1",
                    rusqlite::params!["plan-mirror"],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(AppError::from)
            })
            .expect("计划行存在");
        assert_eq!(mirrored.0, "根改名", "计划行名称镜像根名称");
        assert_eq!(mirrored.1, "根描述", "计划行描述镜像根描述");
    }

    #[tokio::test]
    async fn patch_project_lifecycle_keeps_plan_execution_status() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-lc", "plan-lc");
        let principal = Principal::local(Source::Rest);

        let data = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-lc",
            &json!({ "lifecycleStatus": "archived", "expectedRevision": 5 }),
        )
        .await
        .expect("归档项目根成功");
        assert_eq!(data["status"], json!("archived"));
        let plan_status: String = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT status FROM planning_projects WHERE id = ?1",
                    rusqlite::params!["plan-lc"],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .expect("计划行存在");
        assert_eq!(plan_status, "planning", "项目根生命周期不影响计划执行状态");
    }

    #[tokio::test]
    async fn patch_plan_execution_status_keeps_root_lifecycle() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-exec", "plan-exec");
        let principal = Principal::local(Source::Rest);

        let data = call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/plans/plan-exec",
            &json!({ "status": "completed", "expectedRevision": 3 }),
        )
        .await
        .expect("改计划执行状态成功");
        assert_eq!(data["id"], json!("plan-exec"));
        assert_eq!(data["status"], json!("completed"));
        let root_status: String = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT status FROM workspace_projects WHERE id = ?1",
                    rusqlite::params!["proj-exec"],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .expect("根行存在");
        assert_eq!(root_status, "active", "计划执行状态不改项目根生命周期");
    }

    #[tokio::test]
    async fn root_and_plan_revisions_are_independent() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-rev", "plan-rev");
        let principal = Principal::local(Source::Rest);
        assert_eq!(sql_revisions(&db, "proj-rev", "plan-rev"), (5, 3), "种子状态");

        // 计划聚合只改执行状态：计划 revision +1，根 revision 不变。
        call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/plans/plan-rev",
            &json!({ "status": "paused", "expectedRevision": 3 }),
        )
        .await
        .expect("计划聚合成功");
        assert_eq!(sql_revisions(&db, "proj-rev", "plan-rev"), (5, 4));

        // 项目聚合只改根字段：根 revision +1，计划 revision 不变（镜像不动计划版本）。
        call(
            &rest_state(&db),
            &principal,
            "PATCH",
            "/api/v1/projects/proj-rev",
            &json!({ "name": "只动根", "expectedRevision": 5 }),
        )
        .await
        .expect("项目聚合成功");
        assert_eq!(sql_revisions(&db, "proj-rev", "plan-rev"), (6, 4));
    }

    #[tokio::test]
    async fn get_patch_get_chain_stays_consistent() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-chain", "plan-chain");
        let (principal, row_id) = agent_with_capabilities(
            &db,
            "chain",
            &[("projects.read", ""), ("projects.write", "")],
        );
        grant_project(&db, &row_id, "proj-chain");
        let state = rest_state(&db);

        let before = call(&state, &principal, "GET", "/api/v1/projects/proj-chain", &json!({}))
            .await
            .expect("GET 项目详情");
        assert_eq!(before["projectId"], json!("proj-chain"));
        assert_eq!(before["summary"]["revision"], json!(5));
        assert_eq!(before["summary"]["activePlanId"], json!("plan-chain"));

        let patched = call(
            &state,
            &principal,
            "PATCH",
            "/api/v1/projects/proj-chain",
            &json!({ "name": "链路改名", "expectedRevision": 5 }),
        )
        .await
        .expect("PATCH 成功");
        assert_eq!(patched["revision"], json!(6));

        let after = call(&state, &principal, "GET", "/api/v1/projects/proj-chain", &json!({}))
            .await
            .expect("GET 项目详情");
        // GET 详情读模型（agent_access::service::ProjectSummary）的 revision
        // 与 PATCH 返回值同源（workspace_projects.revision）。
        assert_eq!(after["summary"]["revision"], json!(6), "revision 与 PATCH 返回一致");
        assert_eq!(after["summary"]["name"], json!("链路改名"));
        assert_eq!(after["summary"]["activePlanId"], json!("plan-chain"));
        assert_eq!(after["summary"]["status"], json!("active"));
    }

    #[tokio::test]
    async fn plan_patch_requires_root_grant_but_local_human_passes() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        seed_project(&db, "proj-authz", "plan-authz");
        // Agent 有能力但无根 grant → FORBIDDEN（授权锚定项目根）。
        let (agent, _) =
            agent_with_capabilities(&db, "no-grant", &[("projects.write", "")]);
        let err = call(
            &rest_state(&db),
            &agent,
            "PATCH",
            "/api/v1/plans/plan-authz",
            &json!({ "status": "in_progress" }),
        )
        .await
        .expect_err("无 grant 必须拒绝");
        assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
        assert_eq!(http_status(error_code(&err)), 403);

        // LocalHuman 直过：同一计划、同一补丁。
        let data = call(
            &rest_state(&db),
            &Principal::local(Source::Rest),
            "PATCH",
            "/api/v1/plans/plan-authz",
            &json!({ "status": "in_progress", "expectedRevision": 3 }),
        )
        .await
        .expect("LocalHuman 直接成功");
        assert_eq!(data["id"], json!("plan-authz"));
        assert_eq!(data["status"], json!("in_progress"));
        assert_eq!(data["revision"], json!(4), "拒绝路径不消耗计划 revision");
    }

    #[tokio::test]
    async fn create_new_is_rejected_and_creates_no_directory() {
        let db = Arc::new(Db::open_in_memory().expect("内存库"));
        let (principal, _) =
            agent_with_capabilities(&db, "gate", &[("projects.create", "")]);
        let parent = std::env::temp_dir()
            .join(format!("td-rest-gate-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&parent).expect("建立父目录");
        let target = parent.join("不得创建");

        let err = call(
            &rest_state(&db),
            &principal,
            "POST",
            "/api/v1/projects",
            &json!({
                "name": "越权建目录",
                "rootPath": target.to_str().expect("utf8 路径"),
                "directoryMode": "create_new"
            }),
        )
        .await
        .expect_err("REST Agent 不得 create_new");
        assert_eq!(error_code(&err), "VALIDATION", "{err:?}");
        assert!(
            err.user_message().contains("create_new"),
            "错误必须明确拒绝 create_new: {}",
            err.user_message()
        );
        assert!(!target.exists(), "拒绝后不得落目录");
        std::fs::remove_dir_all(&parent).ok();
    }
}
