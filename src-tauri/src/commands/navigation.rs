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

/// 扫描本机应用：逐来源推送 `nav-scan-batch` 渐进事件，最终返回完整权威结果。
///
/// 前端按 `scan_id`（请求代际）过滤过期批次；扫描线程只做事件推送，不阻塞 IPC。
/// 事件保留来源级粒度（5 个来源 + 缓存命中），不做百分比估算。
#[tauri::command]
pub async fn nav_scan_apps(
    app: AppHandle,
    force: Option<bool>,
    scan_id: Option<String>,
) -> AppResult<navigation::app_discovery::AppScanResult> {
    use tauri::Emitter;
    let force = force.unwrap_or(false);
    let scan_id = scan_id.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sources_done = 0usize;
        Ok(navigation::app_discovery::scan_installed_apps_streaming(
            force,
            |apps, source, discovered| {
                sources_done += 1;
                let payload = navigation::app_discovery::AppScanBatch {
                    scan_id: scan_id.clone(),
                    source: source.to_string(),
                    apps: apps.to_vec(),
                    discovered,
                    sources_done,
                    sources_total: navigation::app_discovery::SCAN_SOURCES_TOTAL,
                };
                // 事件失败不影响扫描本身（例如窗口已关闭）；最终结果仍经 invoke 返回。
                let _ = app.emit("nav-scan-batch", payload);
            },
        ))
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("扫描任务失败: {}", e)))?
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
