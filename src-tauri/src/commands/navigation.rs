//! 导航命令层：软件扫描、目标管理、任务关联、统一跳转、Agent 能力与窗口枚举。
//!
//! 重操作（扫描 / 跳转等待窗口）放 spawn_blocking，不阻塞 IPC 线程。

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::navigation;
use crate::navigation::router::{self, NavigateOptions};

// ── 软件发现 ────────────────────────────────────────────────

/// 扫描本机应用：分批推送 `nav-scan-batch` 渐进事件，最终返回完整权威结果。
///
/// 前端按 `scan_id`（请求代际）过滤过期批次；扫描线程只做事件推送，不阻塞 IPC。
/// 同一来源内按固定上限分块（最后一块才推进 `sources_done`），不做百分比估算。
/// 扫描期间可通过 [`nav_cancel_scan`] 置取消标志：扫描在来源/条目/子进程检查点退出，
/// 返回 `cancelled = true` 的部分结果，且**不写入扫描缓存**。
#[tauri::command]
pub async fn nav_scan_apps(
    app: AppHandle,
    force: Option<bool>,
    scan_id: Option<String>,
) -> AppResult<navigation::app_discovery::AppScanResult> {
    use tauri::Emitter;
    let force = force.unwrap_or(false);
    let scan_id = scan_id.unwrap_or_default();
    // 守卫在扫描线程内持有：扫描结束（含 panic 展开）后自动注销，不遗留取消注册项。
    let guard = navigation::app_discovery::ScanGuard::register(&scan_id);
    tauri::async_runtime::spawn_blocking(move || {
        let mut sources_done = 0usize;
        let mut emit_failures: u32 = 0;
        let mut result = navigation::app_discovery::scan_installed_apps_streaming(
            force,
            guard.as_ref().map(|g| g.token()),
            |apps, source, discovered, source_done| {
                if source_done {
                    sources_done += 1;
                }
                let payload = navigation::app_discovery::AppScanBatch {
                    scan_id: scan_id.clone(),
                    source: source.to_string(),
                    apps: apps.to_vec(),
                    discovered,
                    sources_done,
                    sources_total: navigation::app_discovery::SCAN_SOURCES_TOTAL,
                };
                // 事件失败不影响扫描本身（例如窗口已关闭）；最终结果仍经 invoke 返回。
                // 但必须计数并作为诊断返回，不能静默当成「进度推送正常」。
                if app.emit("nav-scan-batch", payload).is_err() {
                    emit_failures += 1;
                }
            },
        );
        if emit_failures > 0 {
            result
                .diagnostics
                .insert("batch_event_failed".into(), emit_failures);
        }
        Ok(result)
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("扫描任务失败: {}", e)))?
}

/// 取消一次在途扫描（按 `scan_id`）：只置取消标志并立即返回，不等待扫描线程退出。
///
/// 返回 `false` 表示该请求已结束或不存在——前端不得据此声称「已取消」，
/// 应等 `nav_scan_apps` 的真实返回（`cancelled` 字段）确认结果。
#[tauri::command]
pub fn nav_cancel_scan(scan_id: String) -> bool {
    navigation::app_discovery::request_cancel(&scan_id)
}

/// 真实应用图标（PNG data URL）。只接受已保存目标 id、扫描发现的 app_key，
/// 或窗口选择页给出的真实 exe 路径（后端仍做安全校验）。
/// 提取在阻塞线程执行，全局最多 2 个并发；失败返回 null 由前端回退，不阻塞列表。
#[tauri::command]
pub async fn nav_app_icon(
    db: State<'_, Arc<Db>>,
    target_id: Option<String>,
    app_key: Option<String>,
    exe_path: Option<String>,
) -> AppResult<Option<navigation::app_icons::AppIconData>> {
    use std::sync::OnceLock;
    static LIMIT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let limit = LIMIT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone();
    let permit = limit
        .acquire_owned()
        .await
        .map_err(|_| AppError::Agent("图标任务队列已关闭".into()))?;
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // exe_path 只用于窗口选择页的「尚未保存」窗口；后端仍做绝对路径/.exe/存在/非解释器校验。
        let result = navigation::app_icons::extract_icon(
            &db,
            target_id.as_deref(),
            app_key.as_deref(),
            exe_path.as_deref(),
        );
        drop(permit);
        result
    })
    .await
    .map_err(|e| AppError::Agent(format!("图标提取任务失败: {}", e)))?
}

/// 当前顶层窗口列表（窗口选择器用；绕过缓存取最新）。
#[tauri::command]
pub fn nav_list_windows() -> Vec<navigation::window_manager::WindowInfo> {
    navigation::window_manager::top_windows_force()
}

/// 某应用目标的候选窗口：按进程身份过滤（含多进程宿主的子进程窗口），
/// 前端窗口选择器不再用「exe 路径相等」把微信/QQ 的子窗口过滤掉。
#[tauri::command]
pub fn nav_list_target_windows(
    db: State<'_, Arc<Db>>,
    target_id: String,
) -> AppResult<Vec<navigation::window_manager::WindowInfo>> {
    let t = navigation::target_resolver::get_target(&db, &target_id)?
        .ok_or_else(|| AppError::NotFound("目标不存在".into()))?;
    if t.target_type != "application" || t.exe_path.is_empty() {
        return Err(AppError::Validation("只有应用目标可以选择窗口".into()));
    }
    Ok(navigation::window_manager::windows_for_identity(
        &t.exe_path,
        (!t.window_title_hint.is_empty()).then_some(t.window_title_hint.as_str()),
    ))
}

// ── 目标管理 ────────────────────────────────────────────────

#[tauri::command]
pub fn nav_list_targets(
    db: State<'_, Arc<Db>>,
    include_hidden: Option<bool>,
) -> AppResult<Vec<navigation::target_resolver::NavTargetRow>> {
    navigation::target_resolver::list_targets(&db, include_hidden.unwrap_or(false))
}

/// 已保存应用目标的实时运行状态（应用中心按需查询；不做轮询）。
/// 只接受 application 目标；配置失效返回 unavailable，不虚报运行中。
#[tauri::command]
pub async fn nav_target_running_states(
    db: State<'_, Arc<Db>>,
    ids: Vec<String>,
) -> AppResult<std::collections::HashMap<String, String>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        navigation::target_resolver::running_states_by_id(&db, &ids)
    })
    .await
    .map_err(|e| AppError::Agent(format!("运行状态查询失败: {}", e)))?
}

/// 关闭窗口结果：requested = 候选窗口数，closed = 已消失数，
/// stillOpen = 超时后仍在的窗口标题（典型原因：应用在等「是否保存」确认）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetWindowCloseReport {
    pub requested: usize,
    pub closed: usize,
    pub still_open: Vec<String>,
}

/// 按目标身份优雅关闭其全部顶层窗口（WM_CLOSE，等价点标题栏 ×）。
/// 不结束进程、不抢焦点；窗口每次现查现关，绝不复用前端传入的句柄。
#[tauri::command]
pub async fn nav_close_target_windows(
    db: State<'_, Arc<Db>>,
    target_id: String,
) -> AppResult<TargetWindowCloseReport> {
    let db = db.inner().clone();
    let (requested, closed, still_open) =
        tauri::async_runtime::spawn_blocking(move || {
            navigation::target_resolver::close_windows_for_target(&db, &target_id)
        })
        .await
        .map_err(|e| AppError::Agent(format!("关闭窗口任务失败: {}", e)))??;
    Ok(TargetWindowCloseReport {
        requested,
        closed,
        still_open,
    })
}

/// 强制结束进程结果：matched = 匹配进程数（含多进程宿主的子进程），
/// killed = 已结束数，failedPids = 打开句柄被拒或竞争中已退出的 PID。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetProcessKillReport {
    pub matched: usize,
    pub killed: usize,
    pub failed_pids: Vec<u32>,
}

/// 按目标身份强制结束其全部相关进程（TerminateProcess，破坏性动作）。
/// 前端必须先经确认弹窗取得用户同意才可调用；本命令不做二次确认。
#[tauri::command]
pub async fn nav_kill_target_processes(
    db: State<'_, Arc<Db>>,
    target_id: String,
) -> AppResult<TargetProcessKillReport> {
    let db = db.inner().clone();
    let (matched, killed, failed_pids) =
        tauri::async_runtime::spawn_blocking(move || {
            navigation::target_resolver::kill_target_processes(&db, &target_id)
        })
        .await
        .map_err(|e| AppError::Agent(format!("结束进程任务失败: {}", e)))??;
    Ok(TargetProcessKillReport {
        matched,
        killed,
        failed_pids,
    })
}

/// 请求退出结果：processTotal = 参与进程数（不含本进程），processExited =
/// 有界等待（3s）内确认已退出的进程数，postedThreads = 成功投递 WM_QUIT 的线程数。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetProcessQuitReport {
    pub process_total: usize,
    pub process_exited: usize,
    pub posted_threads: usize,
}

/// 请求目标身份的全部进程自行退出（向其线程投递 WM_QUIT，等价应用自己的
/// 「退出」命令：保存配置、移除托盘图标后正常结束）。不是强杀；不配合的
/// 应用会如实报未完全退出，前端引导改用「结束进程」。
#[tauri::command]
pub async fn nav_quit_target_processes(
    db: State<'_, Arc<Db>>,
    target_id: String,
) -> AppResult<TargetProcessQuitReport> {
    let db = db.inner().clone();
    let (process_total, process_exited, posted_threads) =
        tauri::async_runtime::spawn_blocking(move || {
            navigation::target_resolver::quit_target_processes(&db, &target_id)
        })
        .await
        .map_err(|e| AppError::Agent(format!("退出应用任务失败: {}", e)))??;
    Ok(TargetProcessQuitReport {
        process_total,
        process_exited,
        posted_threads,
    })
}

#[tauri::command]
pub fn nav_save_target(
    db: State<'_, Arc<Db>>,
    input: navigation::target_resolver::TargetInput,
) -> AppResult<navigation::target_resolver::NavTargetRow> {
    navigation::target_resolver::save_target(&db, &input)
}

/// 由真实窗口创建「指定窗口快捷方式」：后端即时解析稳定身份（类名+标题+exe）落库，
/// HWND 只用于本次解析、绝不持久化。不聚焦、不启动、不改动用户当前窗口。
#[tauri::command]
pub fn nav_save_window_target(
    db: State<'_, Arc<Db>>,
    hwnd: isize,
    display_name: Option<String>,
) -> AppResult<navigation::target_resolver::NavTargetRow> {
    navigation::target_resolver::save_window_shortcut(&db, hwnd, display_name.as_deref())
}

#[tauri::command]
pub fn nav_update_target(
    db: State<'_, Arc<Db>>,
    id: String,
    patch: navigation::target_resolver::TargetPatch,
) -> AppResult<()> {
    navigation::target_resolver::update_target(&db, &id, &patch)
}

#[tauri::command]
pub fn nav_delete_target(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    // 目标删除时同步清掉窗口记忆，避免 id 复用后"继承"到别人的窗口
    let _ = navigation::window_manager::forget_memory(&db, &id);
    navigation::target_resolver::delete_target(&db, &id)
}

/// 读取某目标记住的窗口身份（类名+标题；不含 HWND）。
#[tauri::command]
pub fn nav_window_memory(
    db: State<'_, Arc<Db>>,
    target_id: String,
) -> Option<navigation::window_manager::WindowMemory> {
    navigation::window_manager::load_memory(&db, &target_id)
}

/// 清除窗口记忆（多窗口选错后手动重置）。
#[tauri::command]
pub fn nav_forget_window(db: State<'_, Arc<Db>>, target_id: String) -> AppResult<()> {
    navigation::window_manager::forget_memory(&db, &target_id)
}

/// 用户显式指定窗口身份：后端由 hwnd **即时**解析当前窗口（重新枚举核对，
/// 不信任陈旧句柄），把稳定身份（类名+标题，origin=user）写入目标记忆。
///
/// HWND 只用于这一次即时解析，绝不持久化；落库的是可重新解析的
/// 类名+标题身份，导航时按身份重新枚举核对。窗口已不存在时返回明确错误，
/// 前端据此如实提示（不静默降级成别的窗口）。
#[tauri::command]
pub fn nav_pick_window_identity(
    db: State<'_, Arc<Db>>,
    target_id: String,
    hwnd: isize,
) -> AppResult<navigation::window_manager::WindowMemory> {
    let w = navigation::window_manager::top_windows_force()
        .into_iter()
        .find(|w| w.hwnd == hwnd)
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "窗口已不存在（句柄失效），未能记录窗口身份: target={}",
                target_id
            ))
        })?;
    let target = navigation::target_resolver::get_target(&db, &target_id)?
        .ok_or_else(|| AppError::NotFound("目标不存在".into()))?;
    if target.target_type != "application"
        || !navigation::window_manager::window_belongs_to_target(&w, &target.exe_path)
    {
        return Err(AppError::Validation("窗口所属程序与目标不一致".into()));
    }
    navigation::window_manager::save_user_memory(&db, &target_id, &w)?;
    Ok(
        navigation::window_manager::WindowMemory::from_window_with_origin(
            &w,
            navigation::window_manager::MemoryOrigin::User,
        ),
    )
}

#[tauri::command]
pub fn nav_pick_task_window(db: State<'_, Arc<Db>>, link_id: String, hwnd: isize) -> AppResult<()> {
    let w = navigation::window_manager::top_windows_force()
        .into_iter()
        .find(|w| w.hwnd == hwnd)
        .ok_or_else(|| AppError::NotFound("窗口已关闭，请重新选择".into()))?;
    navigation::target_resolver::set_task_window(&db, &link_id, Some(&w))
}

#[tauri::command]
pub fn nav_link_task_window(
    db: State<'_, Arc<Db>>,
    task_id: String,
    target_id: String,
    hwnd: isize,
) -> AppResult<String> {
    let w = navigation::window_manager::top_windows_force()
        .into_iter()
        .find(|w| w.hwnd == hwnd)
        .ok_or_else(|| AppError::NotFound("窗口已关闭，请重新选择".into()))?;
    navigation::target_resolver::link_task_window(&db, &task_id, &target_id, &w)
}

#[tauri::command]
pub fn nav_forget_task_window(db: State<'_, Arc<Db>>, link_id: String) -> AppResult<()> {
    navigation::target_resolver::set_task_window(&db, &link_id, None)
}

#[tauri::command]
pub fn nav_set_task_window_fallback(
    db: State<'_, Arc<Db>>,
    link_id: String,
    fallback: String,
) -> AppResult<()> {
    navigation::target_resolver::set_task_window_fallback(&db, &link_id, &fallback)
}

/// 把某个真实存在的 Agent 会话登记为可信导航目标（供任务关联与工作区启动使用）。
///
/// 单独提供而不是让前端拼 `TargetInput`：会话身份必须由后端从库里核验，
/// 前端只能提供 (source_id, session_id)，不能自造显示名/路径。
#[tauri::command]
pub fn nav_save_agent_session_target(
    db: State<'_, Arc<Db>>,
    source_id: String,
    session_id: String,
    display_name: Option<String>,
    working_dir: Option<String>,
) -> AppResult<navigation::target_resolver::NavTargetRow> {
    navigation::target_resolver::save_target(
        &db,
        &navigation::target_resolver::TargetInput {
            target_type: "agent_session".into(),
            display_name: display_name.unwrap_or_default(),
            agent_source_id: source_id,
            agent_session_id: session_id,
            working_dir: working_dir.unwrap_or_default(),
            ..Default::default()
        },
    )
}

#[tauri::command]
pub fn nav_recent_logs(
    db: State<'_, Arc<Db>>,
    limit: Option<i64>,
) -> AppResult<Vec<navigation::target_resolver::NavLogRow>> {
    navigation::target_resolver::recent_logs(&db, limit.unwrap_or(50))
}

#[tauri::command]
pub fn nav_prune_logs(db: State<'_, Arc<Db>>, keep: Option<i64>) -> AppResult<usize> {
    navigation::target_resolver::prune_logs(&db, keep.unwrap_or(200))
}

// ── 任务关联 ────────────────────────────────────────────────

#[tauri::command]
pub fn nav_link_task(
    db: State<'_, Arc<Db>>,
    task_id: String,
    target_id: String,
    is_default: Option<bool>,
    launch_behavior: Option<String>,
) -> AppResult<String> {
    navigation::target_resolver::link_task(
        &db,
        &task_id,
        &target_id,
        is_default.unwrap_or(false),
        launch_behavior.as_deref().unwrap_or("default"),
    )
}

#[tauri::command]
pub fn nav_unlink_task(db: State<'_, Arc<Db>>, link_id: String) -> AppResult<()> {
    navigation::target_resolver::unlink_task(&db, &link_id)
}

#[tauri::command]
pub fn nav_update_task_link(
    db: State<'_, Arc<Db>>,
    link_id: String,
    display_order: Option<i64>,
    is_default: Option<bool>,
    launch_behavior: Option<String>,
) -> AppResult<()> {
    navigation::target_resolver::update_task_link(
        &db,
        &link_id,
        display_order,
        is_default,
        launch_behavior.as_deref(),
    )
}

#[tauri::command]
pub fn nav_task_targets(
    db: State<'_, Arc<Db>>,
    task_id: String,
) -> AppResult<Vec<navigation::target_resolver::TaskNavLinkRow>> {
    navigation::target_resolver::task_targets(&db, &task_id)
}

/// 全部任务关联（任务卡批量渲染；含各目标实时运行状态）。
#[tauri::command]
pub fn nav_all_task_links(
    db: State<'_, Arc<Db>>,
) -> AppResult<Vec<navigation::target_resolver::TaskNavLinkRow>> {
    navigation::target_resolver::all_task_links(&db)
}

// ── 统一跳转 ────────────────────────────────────────────────

#[tauri::command]
pub async fn nav_navigate(
    db: State<'_, Arc<Db>>,
    app: AppHandle,
    target_id: String,
    options: Option<NavigateOptions>,
) -> AppResult<navigation::NavigationResult> {
    let db = db.inner().clone();
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(router::navigate(&db, &app, &target_id, &options))
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("导航任务失败: {}", e)))?
}

// ── Agent 导航 ──────────────────────────────────────────────

/// 能力检测会做 PATH 搜索、窗口枚举与 CLI 帮助探测（可能秒级），
/// 必须移出 IPC 主线程，避免 UI 卡顿。
#[tauri::command]
pub async fn nav_agent_capabilities(
    source_id: String,
) -> AppResult<navigation::agent_navigation::AgentNavCapabilities> {
    tauri::async_runtime::spawn_blocking(move || {
        navigation::agent_navigation::capabilities(&source_id)
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("能力检测失败: {}", e)))
}

/// Agent 树按钮动作：open_app | focus_window。
#[tauri::command]
pub async fn nav_agent_action(
    db: State<'_, Arc<Db>>,
    source_id: String,
    action: String,
) -> AppResult<navigation::NavigationResult> {
    let settings = crate::db::Settings::load(&db).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(match action.as_str() {
            "open_app" => navigation::agent_navigation::launch_agent(&source_id),
            "focus_window" => {
                navigation::agent_navigation::focus_agent(&source_id, settings.nav_allow_launch)
            }
            other => navigation::NavigationResult::failure(
                &source_id,
                other,
                format!("未知 Agent 动作: {}", other),
            ),
        })
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("Agent 动作失败: {}", e)))?
}

/// 为 Agent 打开工作区目录（IDE 类；目录必须存在）。
#[tauri::command]
pub async fn nav_agent_open_workspace(
    source_id: String,
    dir: String,
) -> AppResult<navigation::NavigationResult> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(navigation::agent_navigation::open_workspace(
            &source_id, &dir,
        ))
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("工作区打开失败: {}", e)))?
}
