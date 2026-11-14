//! 项目工作空间独立窗口（v49）。
//!
//! 与主窗口、桌面微件的边界：
//! - 单一窗口（label = `workspace`），普通装饰、任务栏可见、可缩放/最大化、
//!   非置顶；关闭只销毁自身，不影响胶囊/托盘/主窗口；
//! - 不挂载主窗口的 `App.tsx`，只加载 `workspace.html`，不启动贴边吸附、通知调度
//!   与主窗口轮询；能力集由 `capabilities/workspace.json` 隔离；
//! - 几何按**物理像素**持久化到内部设置键 `workspace_window_rect`（不进入前端
//!   `Settings` 快照）；恢复时收敛到目标显示器工作区，显示器消失时回落到主屏；
//! - 最大化状态单独记忆：最大化期间不覆盖正常几何，下次打开仍可还原窗口大小。

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use rusqlite::OptionalExtension;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::commands::settings::is_rect_mostly_visible;
use crate::commands::settings::WindowRect;
use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const WINDOW_LABEL: &str = "workspace";
pub const EVENT_WINDOW_CLOSED: &str = "project-workspace-window-closed";
pub const EVENT_PROJECT_SELECTED: &str = "project-workspace-project-selected";
pub const EVENT_OPEN_DEV_WORKBENCH: &str = "project-workspace-open-dev-workbench";
/// 主窗口 → 工作空间窗口：本次「打开开发工作台」事务的**真实结果**回执。
/// 事件已发送不等于用户看到了开发工作台（主窗口可能仍在胶囊里），
/// 因此必须由主窗口在解除停靠、切页完成后再回传结果。
pub const EVENT_OPEN_DEV_WORKBENCH_RESULT: &str =
    "project-workspace-open-dev-workbench-result";

/// 跨窗口请求序号：工作空间窗口发起，主窗口回执时带回同一个 id，
/// 迟到的重复回执按 id 去重（不与后来的请求混淆）。
static DEV_WORKBENCH_REQ_ID: AtomicI64 = AtomicI64::new(1);

/// 分配下一个跨窗口请求序号（单调递增；迟到回执靠它去重）。
fn next_dev_workbench_request_id() -> i64 {
    DEV_WORKBENCH_REQ_ID.fetch_add(1, Ordering::SeqCst)
}

const SETTING_RECT: &str = "workspace_window_rect";
const MAIN_LABEL: &str = "main";
const DEFAULT_WIDTH: f64 = 1180.0;
const DEFAULT_HEIGHT: f64 = 760.0;
const MIN_WIDTH: f64 = 880.0;
const MIN_HEIGHT: f64 = 600.0;
const EDGE_MARGIN: i32 = 24;
const SAVE_THROTTLE: Duration = Duration::from_millis(500);

/// 窗口几何（物理像素）。`maximized` 与正常矩形一起保存，恢复时先还原矩形再最大化。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
struct WorkspaceGeometry {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    #[serde(default)]
    maximized: bool,
}

impl WorkspaceGeometry {
    fn to_window_rect(self) -> WindowRect {
        WindowRect {
            x: self.x,
            y: self.y,
            w: self.w,
            h: self.h,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct WorkArea {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl WorkArea {
    fn from_monitor(monitor: &tauri::Monitor) -> Self {
        let rect = monitor.work_area();
        Self {
            x: rect.position.x,
            y: rect.position.y,
            width: rect.size.width as i32,
            height: rect.size.height as i32,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWindowInfo {
    pub opened: bool,
    pub project_id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectSelectedEvent {
    project_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenDevWorkbenchEvent {
    pub request_id: i64,
    pub dev_project_id: String,
}

/// 「在开发工作台打开」的受理结果：`requestId` 用于等待主窗口回执。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDevWorkbenchRequest {
    pub request_id: i64,
    pub dev_project_id: String,
}

/// 回执的最终状态。
///
/// `pending` **不是终态**：主窗口被未保存草稿拦截后先回 pending，用户确认/取消
/// 之后必须再回一条 `succeeded` / `cancelled`；否则工作空间窗口只能一直等。
pub const ACK_STATUS_PENDING: &str = "pending";
pub const ACK_STATUS_SUCCEEDED: &str = "succeeded";
pub const ACK_STATUS_CANCELLED: &str = "cancelled";
pub const ACK_STATUS_FAILED: &str = "failed";

/// 主窗口回执载荷：`ok=false` 时必须带可读原因；`pending=true` 表示被未保存
/// 草稿拦截、等用户确认（不是失败，也不是成功）。
///
/// `status` 是权威字段（旧字段 `ok`/`pending` 保留给旧窗口兼容）：
/// `succeeded` / `pending` / `cancelled` / `failed`。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenDevWorkbenchAckEvent {
    pub request_id: i64,
    pub ok: bool,
    pub pending: bool,
    pub status: String,
    pub error: Option<String>,
}

/// 规整调用方传入的状态：非法值直接拒绝，避免「未知状态」被当成成功。
fn normalize_ack_status(ok: bool, pending: bool, status: Option<&str>) -> AppResult<String> {
    let status = match status.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => {
            if pending {
                ACK_STATUS_PENDING.to_string()
            } else if ok {
                ACK_STATUS_SUCCEEDED.to_string()
            } else {
                ACK_STATUS_FAILED.to_string()
            }
        }
    };
    match status.as_str() {
        ACK_STATUS_PENDING | ACK_STATUS_SUCCEEDED | ACK_STATUS_CANCELLED | ACK_STATUS_FAILED => {
            Ok(status)
        }
        other => Err(AppError::Validation(format!(
            "未知的导航回执状态: {other}"
        ))),
    }
}

static LAST_GEOMETRY_SAVE: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));

fn assert_main_or_workspace(window: &WebviewWindow) -> AppResult<()> {
    match window.label() {
        MAIN_LABEL | WINDOW_LABEL => Ok(()),
        _ => Err(AppError::Validation(
            "该命令仅限主窗口或工作空间窗口调用".to_string(),
        )),
    }
}

fn read_geometry(db: &Db) -> Option<WorkspaceGeometry> {
    db.get_setting(SETTING_RECT)
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// 选择恢复目标：优先与保存矩形交集最大的显示器；完全不可见时回落到主显示器，
/// 再退到任意显示器。返回工作区与显示器物理边界（用于可见性判定）。
fn pick_restore_area(
    app: &AppHandle,
    rect: &WorkspaceGeometry,
) -> Option<(WorkArea, Vec<(i32, i32, u32, u32)>)> {
    let monitors = app.available_monitors().ok().unwrap_or_default();
    if monitors.is_empty() {
        return None;
    }
    let bounds: Vec<(i32, i32, u32, u32)> = monitors
        .iter()
        .map(|m| {
            (
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
            )
        })
        .collect();
    let mostly_visible = is_rect_mostly_visible(&rect.to_window_rect(), &bounds);
    let target = if mostly_visible {
        monitors
            .iter()
            .max_by(|a, b| {
                visible_area(rect, a)
                    .partial_cmp(&visible_area(rect, b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .cloned()
    } else {
        app.primary_monitor().ok().flatten()
    };
    let target = target.or_else(|| monitors.into_iter().next())?;
    Some((WorkArea::from_monitor(&target), bounds))
}

fn visible_area(rect: &WorkspaceGeometry, monitor: &tauri::Monitor) -> f64 {
    let m = monitor.size();
    let p = monitor.position();
    let ix0 = rect.x.max(p.x);
    let iy0 = rect.y.max(p.y);
    let ix1 = (rect.x + rect.w as i32).min(p.x + m.width as i32);
    let iy1 = (rect.y + rect.h as i32).min(p.y + m.height as i32);
    ((ix1 - ix0).max(0) as f64) * ((iy1 - iy0).max(0) as f64)
}

/// 把保存几何收敛进工作区：尺寸不超过工作区（留边），位置不越界。
fn clamp_into_area(area: WorkArea, rect: WorkspaceGeometry) -> (PhysicalSize<u32>, PhysicalPosition<i32>) {
    let max_w = (area.width - EDGE_MARGIN * 2).max(MIN_WIDTH as i32);
    let max_h = (area.height - EDGE_MARGIN * 2).max(MIN_HEIGHT as i32);
    let w = (rect.w as i32).clamp(MIN_WIDTH as i32, max_w);
    let h = (rect.h as i32).clamp(MIN_HEIGHT as i32, max_h);
    let max_x = area.x + (area.width - w).max(0);
    let max_y = area.y + (area.height - h).max(0);
    let x = rect.x.clamp(area.x, max_x);
    let y = rect.y.clamp(area.y, max_y);
    (PhysicalSize::new(w as u32, h as u32), PhysicalPosition::new(x, y))
}

fn restore_geometry(app: &AppHandle, win: &WebviewWindow, db: &Db) {
    let Some(saved) = read_geometry(db) else {
        // 首次打开：默认尺寸居中（仅在没有保存几何时执行，避免覆盖用户摆放）。
        let _ = win.set_size(PhysicalSize::new(DEFAULT_WIDTH as u32, DEFAULT_HEIGHT as u32));
        let _ = win.center();
        return;
    };
    let Some((area, bounds)) = pick_restore_area(app, &saved) else {
        return;
    };
    // 保存值在双屏切换/缩放下可能部分越界：仍收敛到目标工作区。
    let mostly_visible = is_rect_mostly_visible(&saved.to_window_rect(), &bounds);
    let target = if mostly_visible {
        saved
    } else {
        // 完全屏外：保持尺寸但放到主屏工作区左上角（不把窗口丢到用户找不到的位置）。
        WorkspaceGeometry {
            x: area.x + EDGE_MARGIN,
            y: area.y + EDGE_MARGIN,
            w: saved.w,
            h: saved.h,
            maximized: saved.maximized,
        }
    };
    let (size, position) = clamp_into_area(area, target);
    if let Err(error) = win.set_size(size) {
        tracing::warn!("恢复工作空间窗口尺寸失败: {error}");
    }
    if let Err(error) = win.set_position(position) {
        tracing::warn!("恢复工作空间窗口位置失败: {error}");
    }
    if saved.maximized {
        let _ = win.maximize();
    }
}

fn geometry_from_window(win: &WebviewWindow) -> Option<WorkspaceGeometry> {
    let position = win.outer_position().ok()?;
    let size = win.inner_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(WorkspaceGeometry {
        x: position.x,
        y: position.y,
        w: size.width,
        h: size.height,
        maximized: win.is_maximized().unwrap_or(false),
    })
}

/// 保存几何：最大化时只更新标记，不覆盖正常矩形；`force=false` 按 500ms 节流，
/// 避免拖动/缩放期间每一帧都写库。
fn save_geometry(app: &AppHandle, win: &WebviewWindow, force: bool) {
    if !force {
        let Ok(mut last) = LAST_GEOMETRY_SAVE.lock() else {
            return;
        };
        let now = Instant::now();
        if last.map(|t| now.duration_since(t) < SAVE_THROTTLE).unwrap_or(false) {
            return;
        }
        *last = Some(now);
    }
    let Some(db) = app.try_state::<Arc<Db>>() else {
        return;
    };
    let Some(current) = geometry_from_window(win) else {
        return;
    };

    if current.maximized {
        // 保留关闭前的正常矩形，只记录最大化标记；没有历史矩形时记录当前值，
        // 下次打开至少能恢复「最大化」状态，而不是回到默认居中。
        let mut saved = read_geometry(&db).unwrap_or(current);
        saved.maximized = true;
        match serde_json::to_value(saved) {
            Ok(value) => {
                if let Err(error) = db.set_setting(SETTING_RECT, value) {
                    tracing::debug!("保存工作空间最大化状态失败: {error}");
                }
            }
            Err(error) => tracing::debug!("序列化工作空间窗口几何失败: {error}"),
        }
        return;
    }

    // 只保存大部分可见的位置（与主窗口 window_rect 同口径），屏外位置不落库。
    let monitors: Vec<(i32, i32, u32, u32)> = app
        .available_monitors()
        .map(|list| {
            list.iter()
                .map(|m| {
                    (
                        m.position().x,
                        m.position().y,
                        m.size().width,
                        m.size().height,
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if !monitors.is_empty() && !is_rect_mostly_visible(&current.to_window_rect(), &monitors) {
        return;
    }
    match serde_json::to_value(current) {
        Ok(value) => {
            if let Err(error) = db.set_setting(SETTING_RECT, value) {
                tracing::debug!("保存工作空间窗口几何失败: {error}");
            }
        }
        Err(error) => tracing::debug!("序列化工作空间窗口几何失败: {error}"),
    }
}

fn attach_events(app: &AppHandle, win: &WebviewWindow) {
    let app = app.clone();
    let w = win.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { .. } => {
            // 关闭按钮 / Alt+F4：保存几何后正常销毁；不 prevent_close，窗口才是真关闭。
            save_geometry(&app, &w, true);
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            save_geometry(&app, &w, false);
        }
        tauri::WindowEvent::Destroyed => {
            if let Some(main) = app.get_webview_window(MAIN_LABEL) {
                let _ = main.emit(EVENT_WINDOW_CLOSED, ());
            }
        }
        _ => {}
    });
}

/// 打开/聚焦专业窗口。由主窗口胶囊肩部入口或完整面板调用。
///
/// 必须是 async：同步命令阻塞 IPC 线程时，WebView2 控制器创建等待消息循环会卡死。
#[tauri::command]
pub async fn open_project_workspace_window(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, Arc<Db>>,
    project_id: Option<String>,
) -> AppResult<WorkspaceWindowInfo> {
    if window.label() != MAIN_LABEL {
        return Err(AppError::Validation(
            "工作空间窗口只能由主窗口打开".to_string(),
        ));
    }
    let project_id = project_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(id) = project_id.as_deref() {
        // 打开前校验存在性：失败直接报错，不把悬空 ID 写成活跃项目。
        crate::commands::project_workspace::workspace_project_get_impl(&db, id)?;
    }

    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.unminimize();
        if !existing.is_visible().unwrap_or(false) {
            existing.show()?;
        }
        let _ = existing.set_focus();
        if let Some(id) = project_id.clone() {
            let _ = existing.emit(EVENT_PROJECT_SELECTED, ProjectSelectedEvent { project_id: id });
        }
        // 窗口已存在且已聚焦：此时把「用户明确要打开的项目」记为活跃项目。
        if let Some(id) = project_id.as_deref() {
            crate::commands::project_workspace::workspace_set_active_project_impl(
                &db,
                Some(id.to_string()),
            )?;
        }
        return Ok(WorkspaceWindowInfo {
            opened: true,
            project_id: None,
        });
    }

    // 新窗口：UI 启动时会读取 `workspace_active_project` 决定初始项目，因此必须在
    // WebView 加载之前写活跃值；窗口创建/显示失败则回滚，避免「没打开却已切换」。
    let previous_active = db
        .get_setting("workspace_active_project")
        .ok()
        .flatten()
        .and_then(|v| v.as_str().map(str::to_string));
    if let Some(id) = project_id.as_deref() {
        crate::commands::project_workspace::workspace_set_active_project_impl(
            &db,
            Some(id.to_string()),
        )?;
    }
    let rollback_active = |db: &Db, previous: Option<String>| {
        let _ = crate::commands::project_workspace::workspace_set_active_project_impl(db, previous);
    };

    let win = match WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::App("workspace.html".into()))
        .title("Task Dock · 工作空间")
        .decorations(true)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .closable(true)
        .always_on_top(false)
        .skip_taskbar(false)
        .visible(false)
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .build()
    {
        Ok(win) => win,
        Err(e) => {
            if project_id.is_some() {
                rollback_active(&db, previous_active);
            }
            return Err(e.into());
        }
    };

    attach_events(&app, &win);
    restore_geometry(&app, &win, &db);
    if let Err(e) = win.show() {
        let _ = win.close();
        if project_id.is_some() {
            rollback_active(&db, previous_active);
        }
        return Err(e.into());
    }
    let _ = win.set_focus();

    Ok(WorkspaceWindowInfo {
        opened: true,
        project_id,
    })
}

/// 「在开发工作台打开」：校验工作空间与开发项目登记，显示主窗口并发出导航请求。
///
/// 返回 `requestId`：事件只是**请求**，主窗口解除胶囊/切页完成后必须用
/// `project_workspace_open_dev_workbench_ack` 回传真实结果（`EVENT_..._RESULT`）。
///
/// ## requestId 由调用方（工作空间窗口）生成
/// 若由本命令分配再通过返回值传给前端，主窗口的回执可能**先于**命令响应到达
/// 工作空间窗口，此时前端还没登记 requestId，回执会被当成过期消息丢弃，最终
/// 假超时。因此允许调用方在**发命令之前**生成并登记 requestId，再传进来；
/// 未传时仍用本进程的单调计数器（老调用方兼容）。
///
/// ## 不在这里写 `workbench_current_project`
/// 「切换当前开发项目」是导航事务的一部分：主窗口不存在、事件发送失败、被未保存
/// 草稿拦截、用户取消都不应改写上下文。上下文提交由主窗口在确认导航真正生效时
/// 完成，失败则由主窗口按原值回滚。
#[tauri::command]
pub fn project_workspace_open_dev_workbench(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, Arc<Db>>,
    project_id: String,
    request_id: Option<i64>,
) -> AppResult<OpenDevWorkbenchRequest> {
    assert_main_or_workspace(&window)?;
    let project = crate::commands::project_workspace::workspace_project_get_impl(&db, &project_id)?;
    let Some(dev_project_id) = project.dev_project_id else {
        return Err(AppError::Validation(
            "该项目未关联开发项目，请先在开发工作台登记并关联".to_string(),
        ));
    };
    // 弱引用失效时明确报错，不静默改写到别的项目。
    let exists = db.with_read(|conn| {
        conn.query_row(
            "SELECT 1 FROM dev_projects WHERE id = ?1",
            rusqlite::params![dev_project_id],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(AppError::from)
    })?;
    if !exists {
        return Err(AppError::NotFound(
            "关联的开发项目已不存在，请重新关联".to_string(),
        ));
    }
    if let Some(id) = request_id {
        if id <= 0 {
            return Err(AppError::Validation(
                "导航请求编号必须为正整数".to_string(),
            ));
        }
    }
    // 主窗口不可用时直接失败：不修改任何上下文，也不返回「已受理」。
    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        return Err(AppError::NotFound(
            "主窗口不可用，无法打开开发工作台".to_string(),
        ));
    };
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    let request_id = request_id.unwrap_or_else(next_dev_workbench_request_id);
    main.emit(
        EVENT_OPEN_DEV_WORKBENCH,
        OpenDevWorkbenchEvent {
            request_id,
            dev_project_id: dev_project_id.clone(),
        },
    )
    .map_err(|e| {
        AppError::Agent(format!("向主窗口发送打开请求失败：{e}"))
    })?;
    Ok(OpenDevWorkbenchRequest {
        request_id,
        dev_project_id,
    })
}

/// 主窗口回执：把本次事务的真实结果转给工作空间窗口。
///
/// 只允许主窗口调用；工作空间窗口已关闭时忽略（没有接收方不是错误）。
/// `status` 为权威状态；未传时按旧字段 `ok`/`pending` 推导。
#[tauri::command]
pub fn project_workspace_open_dev_workbench_ack(
    app: AppHandle,
    window: WebviewWindow,
    request_id: i64,
    ok: bool,
    pending: bool,
    status: Option<String>,
    error: Option<String>,
) -> AppResult<()> {
    if window.label() != MAIN_LABEL {
        return Err(AppError::Validation(
            "该回执只能由主窗口发送".to_string(),
        ));
    }
    if request_id <= 0 {
        return Err(AppError::Validation(
            "导航请求编号必须为正整数".to_string(),
        ));
    }
    let status = normalize_ack_status(ok, pending, status.as_deref())?;
    if let Some(ws) = app.get_webview_window(WINDOW_LABEL) {
        let _ = ws.emit(
            EVENT_OPEN_DEV_WORKBENCH_RESULT,
            OpenDevWorkbenchAckEvent {
                request_id,
                ok,
                pending,
                status,
                error,
            },
        );
    }
    Ok(())
}

/// 应用退出前强制落一次几何：正常关闭会走 CloseRequested，强制退出/托盘退出
/// 不保证触发，因此在退出流程显式调用。
pub fn persist_geometry_on_exit(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        save_geometry(app, &win, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> WorkArea {
        WorkArea {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        }
    }

    #[test]
    fn clamp_geometry_keeps_window_inside_work_area() {
        let (size, pos) = clamp_into_area(
            area(),
            WorkspaceGeometry {
                x: -3000,
                y: -500,
                w: 4000,
                h: 2000,
                maximized: false,
            },
        );
        assert!(size.width as i32 <= area().width);
        assert!(size.height as i32 <= area().height);
        assert!(pos.x >= area().x);
        assert!(pos.y >= area().y);
        assert!(pos.x + size.width as i32 <= area().x + area().width);
        assert!(pos.y + size.height as i32 <= area().y + area().height);
    }

    #[test]
    fn clamp_geometry_preserves_valid_position_and_size() {
        let rect = WorkspaceGeometry {
            x: -1800,
            y: 100,
            w: 1000,
            h: 700,
            maximized: false,
        };
        let (size, pos) = clamp_into_area(area(), rect);
        assert_eq!(size.width, 1000);
        assert_eq!(size.height, 700);
        assert_eq!(pos.x, -1800);
        assert_eq!(pos.y, 100);
    }

    #[test]
    fn geometry_round_trip_through_json() {
        let rect = WorkspaceGeometry {
            x: 10,
            y: 20,
            w: 1180,
            h: 760,
            maximized: true,
        };
        let value = serde_json::to_value(rect).unwrap();
        let back: WorkspaceGeometry = serde_json::from_value(value).unwrap();
        assert_eq!(rect, back);
        // 兼容早期只有矩形、没有 maximized 的 JSON
        let legacy: WorkspaceGeometry =
            serde_json::from_str(r#"{"x":1,"y":2,"w":900,"h":700}"#).unwrap();
        assert!(!legacy.maximized);
    }

    /// P0-02 契约：跨窗口「打开开发工作台」载荷与回执必须是 camelCase，
    /// 且请求里同时带 requestId 与 devProjectId（两者语义不同，不能合并）。
    #[test]
    fn open_dev_workbench_payloads_are_camel_case() {
        let event = serde_json::to_string(&OpenDevWorkbenchEvent {
            request_id: 7,
            dev_project_id: "dev-1".into(),
        })
        .unwrap();
        assert!(event.contains("\"requestId\":7"), "{event}");
        assert!(event.contains("\"devProjectId\":\"dev-1\""), "{event}");

        let request = serde_json::to_string(&OpenDevWorkbenchRequest {
            request_id: 8,
            dev_project_id: "dev-2".into(),
        })
        .unwrap();
        assert!(request.contains("\"requestId\":8"), "{request}");

        // 成功回执：error 为 null，status 是权威终态字段
        let ack = serde_json::to_string(&OpenDevWorkbenchAckEvent {
            request_id: 7,
            ok: true,
            pending: false,
            status: ACK_STATUS_SUCCEEDED.into(),
            error: None,
        })
        .unwrap();
        assert!(ack.contains("\"requestId\":7"), "{ack}");
        assert!(ack.contains("\"ok\":true"), "{ack}");
        assert!(ack.contains("\"pending\":false"), "{ack}");
        assert!(ack.contains("\"status\":\"succeeded\""), "{ack}");
        assert!(ack.contains("\"error\":null"), "{ack}");

        // 失败回执必须带可读原因
        let failed = serde_json::to_string(&OpenDevWorkbenchAckEvent {
            request_id: 9,
            ok: false,
            pending: false,
            status: ACK_STATUS_FAILED.into(),
            error: Some("页面切换未生效".into()),
        })
        .unwrap();
        assert!(failed.contains("\"ok\":false"), "{failed}");
        assert!(failed.contains("\"status\":\"failed\""), "{failed}");
        assert!(failed.contains("页面切换未生效"), "{failed}");
    }

    /// status 缺省时按旧字段推导；非法状态直接拒绝，不能被当成成功。
    #[test]
    fn ack_status_derives_from_legacy_flags_and_rejects_unknown() {
        assert_eq!(
            normalize_ack_status(false, true, None).unwrap(),
            ACK_STATUS_PENDING
        );
        assert_eq!(
            normalize_ack_status(true, false, None).unwrap(),
            ACK_STATUS_SUCCEEDED
        );
        assert_eq!(
            normalize_ack_status(false, false, Some("")).unwrap(),
            ACK_STATUS_FAILED
        );
        assert_eq!(
            normalize_ack_status(true, false, Some(ACK_STATUS_CANCELLED)).unwrap(),
            ACK_STATUS_CANCELLED
        );
        assert!(normalize_ack_status(false, false, Some("done")).is_err());
    }

    /// requestId 单调递增，迟到回执可按 id 去重。
    #[test]
    fn dev_workbench_request_ids_are_monotonic() {
        let a = next_dev_workbench_request_id();
        let b = next_dev_workbench_request_id();
        assert!(b > a);
    }
}