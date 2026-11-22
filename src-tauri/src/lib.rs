//! Task Dock 应用入口：插件装配、窗口/托盘/热键、数据库与 Agent 总线初始化。

pub mod actions;
pub mod agent_access;
pub mod agent_stats;
pub mod agents;
pub mod alloc_stats;
pub mod audio;
#[global_allocator]
static GLOBAL_ALLOCATOR: alloc_stats::TrackingAllocator = alloc_stats::TrackingAllocator;
pub mod clipboard;
pub mod command_phrases;
pub mod commands;
pub mod context_menu;
pub mod db;
pub mod devwork;
pub mod diagnostics;
mod exit_handshake;
pub mod dragdrop;
mod drag_signal;
mod drag_watch;
pub mod error;
pub mod file_workspace;
pub mod focus;
pub mod fsops;
mod fs_safety;
pub mod global_search;
pub mod hotkeys;
pub mod lifecycle;
mod magnetic;
pub mod mcp;
pub mod capability;
pub mod collab;
pub mod mobile_sync;
pub mod navigation;
pub mod nlp;
mod notes;
pub mod notification_window;
pub mod project_hub;
pub mod quick_capture;
pub mod recurrence;
mod project_workspace_window;
pub mod recycle;
pub mod resource_cleanup;
pub mod scheduler;
pub mod security_audit;
pub mod secure_vault;
pub mod shelf;
pub mod tab_hint;
pub mod tab_popups;
pub mod task_analytics;
pub mod transfer;
pub mod user_preferences;
mod widget_windows;
mod window_cursor;
mod window_layout;
mod window_shadow;
mod window_shape;
mod winproc;
pub mod workflows;
pub mod workspace;

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use crate::error::AppError;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::ShortcutState;
// 组合多个 Layer（EnvFilter + fmt + 诊断持久化）需要 Layer trait 在作用域内。
use tracing_subscriber::prelude::*;

use agents::{AgentAdapter, AgentHub, AgentState};
use db::Db;

static TRAY: OnceLock<TrayIcon> = OnceLock::new();
static TRAY_STATE: AtomicU8 = AtomicU8::new(255);

/// 启动「空白区域」兜底时长：前端就绪信号迟迟不到（webview 崩溃/加载失败）时，
/// 必须把窗口恢复成正常区域，否则会留下一个只有 1px 的不可见窗口。
const BLANK_REGION_FALLBACK_MS: u64 = 4000;

/// 启动就绪异常告警阈值：4s 兜底只负责让窗口可见；开发态 Vite 模块加载
/// 5–8s 仍属正常，10s 后前端仍未确认就绪才写入诊断异常。
const STARTUP_READY_WARN_MS: u64 = 10_000;

/// 前端是否已确认首屏就绪（`notify_ui_ready`）。只在启动告警线程里消费。
pub(crate) static UI_READY: AtomicBool = AtomicBool::new(false);

// ── 资源管理器「发送到」启动参数 ─────────────────────────────
//
// 第一实例在 setup 里消费；第二实例由 single-instance 插件把 argv 转交过来。
// 只接受 `--send-to-shelf` 之后的路径，避免把任意命令行参数当文件。
static PENDING_SEND_TO: OnceLock<std::sync::Mutex<Vec<String>>> = OnceLock::new();

pub fn queue_send_to(args: &[String]) {
    let paths = shelf::sendto::paths_from_argv(args);
    if paths.is_empty() {
        return;
    }
    let queue = PENDING_SEND_TO.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let Ok(mut pending) = queue.lock() else {
        return;
    };
    for path in paths {
        if pending.iter().any(|p| p.eq_ignore_ascii_case(&path)) {
            continue;
        }
        pending.push(path);
        if pending.len() >= shelf::sendto::MAX_SEND_TO_PATHS {
            break;
        }
    }
}

fn take_pending_send_to() -> Vec<String> {
    PENDING_SEND_TO
        .get_or_init(|| std::sync::Mutex::new(Vec::new()))
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

// ── 启动意图 ────────────────────────────────────────────────
//
// 三层形态收敛后，**大型完整工作台（workspace 窗口）是唯一的大型主界面**，
// 主窗口只承担快捷入口与后台宿主。启动入口因此必须先判定意图：
//
// - `Normal`：手动启动（含 `npm run tauri dev` 与打包后双击）→ 显示工作台；
// - `Autostart`：开机自启动（注册表参数 `--autostart`）→ 不弹大窗口、不抢焦点，
//   保持原有的快捷面板可见性（尊重「后台驻留」意图）；
// - `SendTo`：资源管理器「发送到」→ 明确要求把文件进暂存并回显，保留主面板。
//
// `SendTo` 优先于 `Autostart`：携带文件时用户的意图是「收下这些文件」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupIntent {
    Normal,
    Autostart,
    SendTo,
}

fn startup_intent_from_args(args: &[String]) -> StartupIntent {
    if args.iter().any(|arg| arg == "--send-to-shelf") {
        StartupIntent::SendTo
    } else if args.iter().any(|arg| arg == "--autostart") {
        StartupIntent::Autostart
    } else {
        StartupIntent::Normal
    }
}

/// 普通启动才把大型工作台作为首屏；自启动/发送到不抢占大窗口。
fn startup_opens_workbench(intent: StartupIntent) -> bool {
    matches!(intent, StartupIntent::Normal)
}

/// 主窗口（快捷入口宿主）在启动时是否可见。
///
/// 普通启动默认不显示它（否则旧完整面板会先闪一下，再被工作台取代）；
/// 只有上次退出就停在贴边胶囊态时保留胶囊，快捷入口不断档。
/// 自启动/发送到保留原有可见性：这是入口本身的明确意图。
fn startup_shows_quick_surface(intent: StartupIntent, docked_restore: bool) -> bool {
    match intent {
        StartupIntent::Normal => docked_restore,
        StartupIntent::Autostart | StartupIntent::SendTo => true,
    }
}

/// 把「发送到 Task Dock」的路径写入暂存架（引用模式），并通知前端刷新。
/// 路径只从启动参数来；不移动/复制来源文件。
fn process_send_to(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(st) = app.try_state::<Arc<shelf::ShelfState>>() else {
            tracing::warn!("发送到暂存架失败：暂存架未就绪");
            return;
        };
        let operation_id = uuid::Uuid::new_v4().to_string();
        let outcome = shelf::ingest::save(
            &st.db,
            &st.root,
            shelf::ingest::ClipboardIntake::Files(paths),
            shelf::MODE_REFERENCE,
            "manual",
            None,
        );
        let payload = serde_json::json!({
            "operationId": operation_id,
            "source": "sendto",
            "contentKind": outcome.content_kind,
            "success": !outcome.added.is_empty(),
            "partial": !outcome.added.is_empty()
                && (!outcome.failed.is_empty() || outcome.skipped > 0),
            "added": outcome.added.len(),
            "failed": outcome.failed.len(),
            "skipped": outcome.skipped,
            "duplicates": outcome.duplicates,
            "code": outcome.failure_code,
            "retryable": outcome.retryable,
        });
        let _ = app.emit(shelf::ingest::EVENT_COLLECTED, payload);
        if let Some(win) = app.get_webview_window("main") {
            show_and_focus(&win);
        }
    });
}

// ── 托盘 ────────────────────────────────────────────────────

fn tray_icon_bytes(state: AgentState) -> &'static [u8] {
    match state {
        AgentState::Running => include_bytes!("../icons/status/running.png"),
        AgentState::Waiting => include_bytes!("../icons/status/waiting.png"),
        AgentState::Completed => include_bytes!("../icons/status/done.png"),
        AgentState::Failed => include_bytes!("../icons/status/failed.png"),
        AgentState::Disconnected => include_bytes!("../icons/status/idle.png"),
        AgentState::Idle => include_bytes!("../icons/tray-app.png"),
    }
}

static TRAY_TOOLTIP_CACHE: std::sync::Mutex<Option<(String, std::time::Instant)>> =
    std::sync::Mutex::new(None);
const TOOLTIP_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

fn tray_tooltip(db: &Db) -> String {
    // 单次读查询取齐四项统计：批量进度事件不会放大为 4×N 次锁竞争。
    let (pending, running, waiting, next) = db
        .with_read(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM tasks WHERE status = 'pending'),
                        (SELECT COUNT(*) FROM agent_runs WHERE origin = 'real' AND status = 'running'),
                        (SELECT COUNT(*) FROM agent_runs WHERE origin = 'real' AND status = 'waiting'),
                        (SELECT MIN(remind_at) FROM task_reminders WHERE fired = 0)",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .map_err(AppError::from)
        })
        .unwrap_or((0, 0, 0, None));
    let next_txt = next
        .map(|t| {
            let now = chrono::Utc::now();
            match chrono::DateTime::parse_from_rfc3339(&t) {
                Ok(dt) => {
                    let mins = (dt.with_timezone(&chrono::Utc) - now).num_minutes();
                    if mins <= 0 {
                        "已到期".to_string()
                    } else if mins < 60 {
                        format!("{} 分钟后", mins)
                    } else if mins < 60 * 24 {
                        format!("{} 小时后", mins / 60)
                    } else {
                        format!("{} 天后", mins / (60 * 24))
                    }
                }
                Err(_) => "-".to_string(),
            }
        })
        .unwrap_or_else(|| "无".to_string());
    format!(
        "Task Dock · 待办 {} · Agent 运行 {} / 等待 {} · 下次提醒 {}",
        pending, running, waiting, next_txt
    )
}

/// 由 Agent 总线在状态变化时调用：更新托盘图标与提示。
pub fn refresh_tray(app: &AppHandle, state: AgentState) {
    if let Some(tray) = TRAY.get() {
        let p = state.priority();
        let icon_changed = TRAY_STATE.swap(p, Ordering::Relaxed) != p;
        if icon_changed {
            if let Ok(img) = tauri::image::Image::from_bytes(tray_icon_bytes(state)) {
                let _ = tray.set_icon(Some(img));
            }
        }
        if let Some(db) = app.try_state::<Arc<Db>>() {
            // 节流：状态未变化时最多每 5 秒重算一次；文案相同不重复 set_tooltip。
            let now = std::time::Instant::now();
            let mut cache = TRAY_TOOLTIP_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            let due = icon_changed
                || cache
                    .as_ref()
                    .map(|(_, at)| now.duration_since(*at) >= TOOLTIP_MIN_INTERVAL)
                    .unwrap_or(true);
            if due {
                let tooltip = tray_tooltip(&db);
                let changed = cache.as_ref().map(|(t, _)| t != &tooltip).unwrap_or(true);
                if changed {
                    let _ = tray.set_tooltip(Some(&tooltip));
                }
                *cache = Some((tooltip, now));
            }
        }
    }
}

fn setup_tray(app: &App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    // 液态玻璃右键菜单（context_menu.rs）已取代原生 Menu：
    // 左键切换主窗显示，右键在托盘图标上方弹出玻璃菜单（无原生菜单入口残留）。
    let tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Task Dock")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let app = tray.app_handle();
                match button {
                    // 左键 = 打开/聚焦完整工作台（2026-11-22）：存在则聚焦（含
                    // 还原最小化/隐藏），已销毁则经统一创建入口重建并恢复几何；
                    // 不再切换旧版快捷工具面板（右键菜单「显示/隐藏快捷工具面板」仍保留）。
                    MouseButton::Left => {
                        project_workspace_window::focus_or_open_workbench(app);
                    }
                    // 锚点：托盘图标上缘中点，菜单在其上方展开并按工作区收边
                    // （tauri 的 Position/Size 是枚举；托盘事件里恒为物理坐标）
                    MouseButton::Right => {
                        let pos = rect.position.to_physical::<f64>(1.0);
                        let size = rect.size.to_physical::<f64>(1.0);
                        context_menu::show_at(app, (pos.x + size.width / 2.0, pos.y));
                    }
                    _ => {}
                }
            }
        })
        .build(app)?;
    let _ = TRAY.set(tray);
    Ok(())
}

// ── 窗口 ────────────────────────────────────────────────────

/// 开发模式预检：dev 构建（未启用 custom-protocol）的界面来自 devUrl（Vite）。
/// Vite 不在时若照常显示窗口，会得到一个无边框、不进任务栏的
/// "localhost 拒绝连接"幽灵页（用户无法用标题栏关闭它）。
/// 窗口在配置中默认隐藏，这里在显示它之前先探测 devUrl。
fn dev_server_reachable(app: &App) -> Result<(), String> {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let Some(url) = app.config().build.dev_url.clone() else {
        return Ok(());
    };
    let Some(host) = url.host_str().map(str::to_string) else {
        return Ok(());
    };
    let port = url.port_or_known_default().unwrap_or(80);

    for _ in 0..3 {
        if let Ok(addrs) = (host.as_str(), port).to_socket_addrs() {
            for addr in addrs {
                if TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok() {
                    return Ok(());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    Err(format!("{} 无法连接", url))
}

fn restore_window(app: &AppHandle, db: &Db) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    // 显示模式尺寸（先同步最小尺寸，避免常驻 minWidth 钳制极简模式）
    // 设置读取失败时窗口仍要恢复，但不能静默：记录诊断，尺寸回退默认
    let settings = db::Settings::load(db).unwrap_or_else(|e| {
        tracing::warn!("恢复窗口时读取设置失败，使用默认值: {}", e);
        Default::default()
    });
    commands::system::set_mode_window_size(&win, settings.mode.as_str());

    // 记忆位置（越界则用默认位置）
    if let Some(rect) = db
        .get_setting("window_rect")
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value::<commands::settings::WindowRect>(v).ok())
    {
        // 物理像素 60% 交集判定（与前端 lib/edgeSnap、save_window_rect 同口径）：
        // 旧实现按「逻辑像素 ±80」判断，scale≠1 时会把屏内的有效位置误判为越界
        // （或反之），跨屏/负坐标也不准确。空列表（断连）按不可见处理。
        let on_screen = win
            .available_monitors()
            .map(|monitors| {
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
                commands::settings::is_rect_mostly_visible(&rect, &bounds)
            })
            .unwrap_or(false);
        if on_screen {
            // 前端保存的是**物理像素**（outerPosition/outerSize），这里必须按物理像素还原：
            // 若按逻辑像素还原，125% 缩放下窗口每次启动都会放大 25%（v0.5 遗留缺陷）。
            let _ = win.set_size(tauri::PhysicalSize::new(rect.w, rect.h));
            let _ = win.set_position(tauri::PhysicalPosition::new(rect.x, rect.y));
        }
    }

    // 关闭行为按设置（window_close_behavior）分支：
    // - close_window（默认）：隐藏到托盘（Tauri v2 事件回调为单参数）；
    // - quit_app：所有主界面关闭入口统一走 request_exit（正文保存握手 +
    //   事件管线排空后退出进程），不再隐藏。
    let win_for_close = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let quit_on_close = win_for_close
                .app_handle()
                .try_state::<std::sync::Arc<Db>>()
                .map(|db| commands::settings::window_close_behavior_is_quit(db.inner()))
                .unwrap_or(false);
            if quit_on_close {
                api.prevent_close();
                tracing::info!("主窗关闭请求（quit_app）：转入统一退出流程");
                crate::request_exit(win_for_close.app_handle());
                return;
            }
            let _ = win_for_close.hide();
            if let Some(st) = win_for_close
                .app_handle()
                .try_state::<std::sync::Arc<secure_vault::VaultState>>()
            {
                st.lock(secure_vault::session::LockReason::WindowHidden);
            }
        }
    });

    // 圆角外形：窗口尺寸/DPI 变化后必须按新的物理像素重算，否则区域会停在
    // 旧尺寸上把内容裁掉（v0.6 视觉重构引入）。从最小化/托盘恢复时窗口区域
    // 可能被系统重置，拿回焦点时再做一次“校验 + 必要时重设”。
    // Moved 也在监听之列：贴边吸附的隐藏/恢复只改窗口位置不改尺寸，而吸附
    // 流程会把区域留在中间状态（真机实测恢复后区域卡在 40x150 碎片上），
    // 只监听 Resized/Focused 时位置恢复后内容将永久被裁。apply() 内部有
    // GetWindowRgn 实况校验与缓存；系统模态移动循环（拖拽整个窗口）内还会
    // 跳过回读与 DWM 写入，避免逐帧重合成导致拖动中整窗透明，松手后再补齐。
    let win_for_shape = win.clone();
    win.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
                | tauri::WindowEvent::Focused(true)
        ) {
            window_shape::apply(&win_for_shape);
        }
    });

    // 原生悬浮阴影：DWM 不会为带 SetWindowRgn 区域的无边框窗口绘制投影
    // （实测见 tmp/acceptance/window-appearance-20261115/probe），改由伴生分层
    // 窗口绘制窗口外阴影，胶囊/圆角轮廓都能正确投影。
    window_shadow::attach(&win);

    // 右键菜单收起（含兜底）：主窗夺焦 = 用户点击了菜单外区域，延迟收起；
    // 右键重开时 show 会取消该未决关闭。即使弹窗 set_focus 在受限前台策略下
    // 未生效（收不到自身失焦事件），这条路径也能保证「点击外部关闭」。
    let win_for_menu = win.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(true)) {
            context_menu::schedule_blur_close(win_for_menu.app_handle());
        }
    });

    // 保险箱：窗口失焦记为后台；后台时长由后端 ticker 判定（前端定时器不作安全机制）。
    let win_for_vault = win.clone();
    win.on_window_event(move |event| {
        let Some(st) = win_for_vault
            .app_handle()
            .try_state::<std::sync::Arc<secure_vault::VaultState>>()
        else {
            return;
        };
        match event {
            tauri::WindowEvent::Focused(false) => st.on_background(true),
            tauri::WindowEvent::Focused(true) => st.on_background(false),
            tauri::WindowEvent::Resized(_) => {
                // 最小化不一定触发失焦（部分窗口管理器/多显示器组合下焦点仍留在
                // 隐藏窗口），在尺寸事件后按真实 is_minimized 结果补一次锁定。
                if win_for_vault.is_minimized().unwrap_or(false) {
                    st.lock(secure_vault::session::LockReason::WindowHidden);
                }
            }
            tauri::WindowEvent::Destroyed => {
                st.lock(secure_vault::session::LockReason::WindowHidden);
            }
            _ => {}
        }
    });
}

// ── 入口 ────────────────────────────────────────────────────

/// 隔离实例身份：设置 `TASK_DOCK_DATA_DIR` 时，单实例锁与通知 AUMID 都按数据目录区分。
///
/// 数据目录就是实例边界：隔离实例与正式安装互不顶掉、互不串数据，
/// 而指向同一目录的两个隔离实例仍然互相拦下。未设置时返回原标识，正式安装行为不变。
fn instance_identifier(base: &str) -> String {
    instance_identifier_for(base, std::env::var_os("TASK_DOCK_DATA_DIR").as_deref())
}

/// `instance_identifier` 的纯函数版本：便于直接断言，不依赖进程环境。
fn instance_identifier_for(base: &str, data_dir: Option<&std::ffi::OsStr>) -> String {
    let Some(dir) = data_dir else {
        return base.to_string();
    };
    let key = std::path::PathBuf::from(dir)
        .to_string_lossy()
        .to_ascii_lowercase();
    // FNV-1a 64：只用于区分目录，不需要密码学强度
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{base}.iso.{:08x}", hash as u32)
}

/// 开发实例的专属数据目录（纯函数，便于单测）：`<RoamingAppData>/<应用标识>/dev-instance`。
///
/// 放在正式版数据目录的**子目录**而不是仓库里：不污染工作树、不需要额外忽略规则，
/// 同时与正式版（`<RoamingAppData>/<应用标识>`）严格分开，互为父子但互不覆盖。
fn dev_data_dir_for(
    base: &str,
    appdata: Option<&std::ffi::OsStr>,
) -> Option<std::path::PathBuf> {
    let appdata = appdata.filter(|value| !value.is_empty())?;
    Some(
        std::path::PathBuf::from(appdata)
            .join(base)
            .join("dev-instance"),
    )
}

/// 开发态实例隔离：`npm run tauri dev` 编出的调试程序与安装版共用同一应用标识时，
/// 先启动的一方会把另一方当成「重复启动」拦下——开发版看似启动成功，实际界面仍是
/// 被唤醒的旧进程（用户看到的还是旧版本/旧数据）。
///
/// 未显式设置 `TASK_DOCK_DATA_DIR` 时给 dev 构建换一个专属数据目录：单实例锁、
/// 通知 AUMID、数据库、备份、剪贴板与暂存架资产全部随目录派生/隔离，因此
/// 开发版与正式版可并行、各自重复启动仍各自唤醒。显式设置（验收/便携模式）时
/// 完全尊重现有配置，正式版（非 dev 构建）行为不变。
fn apply_dev_instance_isolation(base: &str) {
    if !tauri::is_dev() {
        return;
    }
    if std::env::var_os("TASK_DOCK_DATA_DIR").is_some() {
        return;
    }
    let appdata = std::env::var_os("APPDATA");
    let Some(dir) = dev_data_dir_for(base, appdata.as_deref()) else {
        tracing::warn!("无法确定开发实例数据目录（APPDATA 缺失），本次沿用正式版目录");
        return;
    };
    if let Err(error) = std::fs::create_dir_all(&dir) {
        tracing::warn!(
            "创建开发实例数据目录失败（{}），本次沿用正式版目录: {error}",
            dir.display()
        );
        return;
    }
    std::env::set_var("TASK_DOCK_DATA_DIR", &dir);
    tracing::info!(
        "开发实例已隔离到专属数据目录: {}（不写入正式版数据库）",
        dir.display()
    );
}

/// 进程启动瞬间（`run()` 入口）：供「启动 → 首屏就绪」耗时埋点使用（module="startup"）。
/// 只记录一次；未被写入时埋点自动跳过，不影响任何启动路径。
pub(crate) static STARTUP_START: std::sync::OnceLock<std::time::Instant> =
    std::sync::OnceLock::new();

pub fn run() {
    // 性能指标窗口起点：首屏就绪时由 `commands::system::notify_ui_ready` 收尾并落一次聚合。
    let _ = STARTUP_START.set(std::time::Instant::now());
    alloc_stats::init_from_env();
    let mut context = tauri::generate_context!();
    let base_identifier = context.config().identifier.clone();
    // 必须在 `instance_identifier` 之前：单实例锁按数据目录派生，
    // 开发版与正式版因此成为两个互不拦截的实例。
    apply_dev_instance_isolation(&base_identifier);
    context.config_mut().identifier = instance_identifier(&base_identifier);
    tauri::Builder::default()
        // 单实例保护必须最先注册：插件按注册顺序初始化，
        // 第二实例要在其余插件 init 与 setup（建库、绑 47821 端口、注册托盘）之前就被拦下并退出。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = shelf::sendto::paths_from_argv(&argv);
            if !paths.is_empty() {
                tracing::info!(count = paths.len(), "重复启动携带发送到暂存架路径");
                process_send_to(app, paths);
                return;
            }
            // 默认界面是大型工作台：重复启动优先聚焦已存在的工作台；已被关闭则
            // 按同一创建路径重建。只有创建失败才回退主面板（并给出错误提示），
            // 不再「再次展示旧完整面板」。
            tracing::info!("检测到重复启动：唤醒大型工作台");
            project_workspace_window::focus_or_open_workbench(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // 自启动入口标记：setup 据此不弹大窗口、不抢焦点（见 StartupIntent）。
            Some(vec!["--autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // 统一由快捷键管理器匹配「实际注册成功」的动作；
                    // 未匹配（旧配置/已禁用/注册失败）时静默返回，不吞按键。
                    crate::hotkeys::handle_shortcut(app, shortcut);
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 快速预览媒体协议：只服务命令注册的短期 token，支持视频 Range；
        // 不扩大 tauri.conf.json 的 assetProtocol 全盘 scope。
        .register_uri_scheme_protocol("taskdock-preview", |_ctx, request| {
            file_workspace::preview::handle_preview_uri(&request)
        })
        .setup(|app| {
            // 数据目录最先确定：诊断日志、数据库、备份与恢复都依赖它。
            // 测试/便携模式（TASK_DOCK_DATA_DIR）下同时隔离全部本地状态。
            let data_dir = std::env::var_os("TASK_DOCK_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    app.path()
                        .app_data_dir()
                        .expect("无法获取应用数据目录")
                });
            std::fs::create_dir_all(&data_dir).ok();

            // 日志：控制台输出保持原有行为（默认 info；RUST_LOG 可覆盖），
            // 同时挂载诊断持久化层——仓库已有的 tracing::warn!/error! 会自动落盘，
            // 不需要逐个业务文件改埋点（字段白名单见 diagnostics::tracing_layer）。
            let diagnostics = diagnostics::Diagnostics::init(app.handle());
            diagnostics.install();
            // panic 捕获：崩溃现场必须能进诊断日志。此前没有安装 panic hook，
            // Rust panic 直接终止进程，诊断日志里看不到任何崩溃记录。
            diagnostics::panic_hook::install(diagnostics.clone());
            // 动态日志级别：详细诊断模式必须真正改变 `tracing` 过滤，否则 DEBUG 会在
            // 进入诊断层之前被 EnvFilter 丢弃。RUST_LOG 显式设置时始终以开发者意图为准。
            let env_override = std::env::var("RUST_LOG").ok().filter(|v| !v.trim().is_empty());
            let normal_spec = env_override.clone().unwrap_or_else(|| "info".to_string());
            let verbose_spec = env_override
                .clone()
                .unwrap_or_else(|| "info,task_dock_lib=debug".to_string());
            let (filter_layer, filter_handle) = tracing_subscriber::reload::Layer::new(
                tracing_subscriber::EnvFilter::new(normal_spec.clone()),
            );
            tracing_subscriber::registry()
                .with(filter_layer)
                .with(tracing_subscriber::fmt::layer())
                .with(diagnostics::DiagnosticsLayer::new(diagnostics.clone()))
                .init();
            diagnostics.attach_filter_reload(move |verbose| {
                let spec = if verbose { verbose_spec.clone() } else { normal_spec.clone() };
                if let Err(e) = filter_handle.reload(tracing_subscriber::EnvFilter::new(spec)) {
                    // 过滤切换失败只影响详细模式的额外事件，不影响业务。
                    tracing::warn!("诊断日志级别切换失败: {e}");
                }
            });
            app.manage(diagnostics.clone());

            // 开发模式预检：Vite 未启动则不显示窗口，弹窗说明原因后退出，
            // 避免留下无边框幽灵错误页（窗口保持隐藏，见 tauri.conf.json visible:false）
            if tauri::is_dev() {
                if let Err(err) = dev_server_reachable(app) {
                    tracing::error!("开发服务器预检失败: {}", err);
                    let app_handle = app.handle().clone();
                    app.dialog()
                        .message(format!(
                            "开发模式的界面来自 Vite 开发服务器（{}），当前没有启动。\n\n\
                             请在项目目录执行 npm run tauri dev 启动；\n\
                             或使用 release 目录下的正式版安装包（不依赖开发服务器）。",
                            err
                        ))
                        .title("Task Dock — 开发模式")
                        .kind(MessageDialogKind::Error)
                        .show(move |_| app_handle.exit(1));
                    return Ok(());
                }
            }

            let handle = app.handle().clone();

            // Agent 操作可视化：事件只做低延迟推送，事实来源始终是数据库。
            agent_access::operations::init_event_emitter(&handle);

            // 投屏控制栏窗口服务：登记 AppHandle，供 vd_start 的伴随窗口线程使用。
            commands::projection_window::init(&handle);

            let db = Arc::new(Db::open(&data_dir.join("task-dock.db")).expect("数据库打开失败"));
            // Agent 共享工作空间：按设置恢复文件监听与本地 REST（默认都关闭）。
            match db::Settings::load(&db) {
                Ok(settings) => {
                    let _ = agent_access::watch::apply(
                        db.clone(),
                        settings.agent_workspace_watch_enabled,
                    );
                    let _ = agent_access::rest::apply(db.clone());
                }
                Err(err) => tracing::warn!("读取 Agent 接入设置失败: {err}"),
            }
            tracing::info!("setup: Agent 接入设置已应用（REST/监听）");
            // 先处理上次中断的恢复：数据库/文件提交要么续跑完成，要么回滚；
            // 必须在剪贴板监听与 Agent 管线启动前完成，避免恢复期间写入被覆盖。
            match commands::restore::recover_pending(&data_dir, &db) {
                Ok(Some(r)) => {
                    if r.state == commands::restore::RestoreState::RolledBack
                        || r.action == "discarded_before_commit"
                    {
                        tracing::warn!("检测到中断的恢复已回滚: {}", r.message);
                    } else {
                        tracing::info!("检测到中断的恢复并已处理: {}", r.message);
                    }
                }
                Ok(None) => {}
                Err(e) => tracing::error!("处理中断恢复失败（需人工检查恢复日志）: {}", e),
            }
            tracing::info!("setup: 中断恢复检查完成");
            // 项目目录初始化恢复：`create_new` 在「建目录」与「事务提交」之间崩溃时，
            // 只删「空目录 + 无项目引用」的孤儿目录；其他情况一律保留并记录。
            match project_hub::creation::recover_pending(&db) {
                Ok(0) => {}
                Ok(removed) => tracing::info!("项目目录恢复：清理 {removed} 个遗留空目录"),
                Err(e) => tracing::error!("项目目录恢复失败（需人工核对恢复日志）: {}", e),
            }
            // 受理序号起点必须高于库内已持久化的最大序号：
            // 时钟回拨/重启后新事件仍严格新于历史，旧事件不会覆盖新状态。
            match db.max_ingest_seq() {
                Ok(max) => agents::bump_ingest_seq(max),
                Err(e) => tracing::warn!("读取受理序号水位失败: {}", e),
            }
            // 一键工作流：把上次异常退出遗留的 running/paused 运行标记为 interrupted
            //（绝不自动重放有副作用的步骤）。
            commands::workflows::recover_on_startup(&db);
            // Agent 操作可视化：上次进程退出时仍在 running 的操作按租约收敛为
            // interrupted（绝不伪造 committed），并按保留期清理旧记录。
            match agent_access::operations::interrupt_stale(&db) {
                Ok(0) => {}
                Ok(n) => tracing::warn!("检测到 {n} 个中断的 Agent 操作，已标记 interrupted"),
                Err(err) => tracing::warn!("Agent 操作恢复失败: {err}"),
            }
            if let Err(err) =
                agent_access::operations::prune(&db, agent_access::operations::RETENTION_DAYS)
            {
                tracing::warn!("Agent 操作历史清理失败: {err}");
            }
            // v86.1：共享租约调度。同一线程负责
            // 1) 为本进程的长操作续租（短操作只登记 ID，不创建线程）；
            // 2) 周期把过期 running 收敛为 interrupted（CLI 异常退出不再依赖重启）。
            agent_access::operations::start_runtime(db.clone(), true);
            handle.manage(db.clone());
            // 统一音频通知服务（TTS 合成 + 本地缓存）：
            // 缓存目录走 app_cache_dir/audio/tts（验收/便携模式随 TASK_DOCK_DATA_DIR 隔离），
            // 启动时不初始化 WinRT 引擎；只有实际播报/预生成时才合成。
            let audio_cache_dir = std::env::var_os("TASK_DOCK_DATA_DIR")
                .map(std::path::PathBuf::from)
                .map(|d| d.join("audio-cache").join("tts"))
                .or_else(|| {
                    handle
                        .path()
                        .app_cache_dir()
                        .ok()
                        .map(|p| p.join("audio").join("tts"))
                });
            // 资源管理：磁盘占用分布需要数据根与 TTS 缓存根（安装模式两者不在同一目录）。
            handle.manage(Arc::new(resource_cleanup::ResourceCleanupState::with_roots(
                data_dir.clone(),
                audio_cache_dir.clone(),
            )));
            handle.manage(Arc::new(audio::AudioService::new(audio_cache_dir)));
            // 统一文件操作任务注册表 + 固定 worker 池 + 回收站索引服务（v68）：
            // 只持有数据库句柄与两个空转 worker，启动阶段不做任何扫描。
            handle.manage(Arc::new(fsops::JobRegistry::new()));
            handle.manage(fsops::Scheduler::new(handle.clone()));
            handle.manage(recycle::RecycleService::new(db.clone()));
            // 工作篮跨窗口上下文：纯内存、不落库（窗口关闭即失效，避免指向已删除实体）。
            handle.manage(Arc::new(transfer::context::ContextState::default()));
            // 快速捕获语音输入：只构造服务对象，工作线程与 COM 在首次使用时才创建。
            handle.manage(Arc::new(quick_capture::voice::VoiceInput::new()));
            // 快速捕获图片附件：独立托管目录 data_dir/capture-attachments，
            // 与剪贴板资产分属不同生命周期（删除捕获记录不能影响剪贴板历史）。
            let capture_files = Arc::new(
                quick_capture::attachments::CaptureFiles::new(data_dir.join("capture-attachments"))
                    .expect("快速捕获附件目录初始化失败"),
            );
            handle.manage(capture_files);
            let settings = db::Settings::load(&db).unwrap_or_else(|e| {
                tracing::warn!(
                    "启动时读取设置失败，使用默认值（剪贴板等模块将按默认关闭）: {}",
                    e
                );
                Default::default()
            });

            // 智能剪贴板：模块关闭时不启动监听/维护；监听失败只降级为「不自动记录」。
            // 配置不可靠时保持监听线程运行但停止采集（fail-closed），
            // 以便界面显示“配置异常”并在用户显式修复后立即恢复。
            let clipboard_rt = clipboard::ClipboardRuntime::new(
                db.clone(),
                data_dir.join("clipboard"),
                handle.clone(),
            );
            let clip_config = db::Settings::load_clipboard(&db);
            if let Some(error) = clip_config.error.as_ref() {
                tracing::warn!(
                    "剪贴板配置不可靠，监听线程保持运行但不采集：{}",
                    error.message()
                );
                clipboard_rt.start();
            } else if clip_config.settings.clipboard_enabled
                && !clip_config.settings.clipboard_paused
            {
                clipboard_rt.start();
            } else if clip_config.settings.clipboard_paused {
                // 用户明确保存的暂停偏好必须跨重启保持：不创建监听/维护线程，
                // 而不是先启动再靠 capture_allowed 拒绝采集。恢复时由设置写入重建。
                tracing::info!("智能剪贴板处于暂停状态：不启动监听与后台维护");
            } else {
                tracing::info!("智能剪贴板已停用：不启动监听与后台维护");
            }
            handle.manage(clipboard_rt);
            tracing::info!("setup: 剪贴板模块已托管");

            // 安全保险箱（P1）：独立库 + 内存会话。未建库时不创建连接；
            // 锁定 ticker 在构造时启动（单一后台任务，2s 判定一次）。
            let vault_state = secure_vault::VaultState::new(handle.clone(), data_dir.clone());
            handle.manage(vault_state.clone());

            // 文件暂存架（v0.8）：独立托管目录 data_dir/shelf，与剪贴板资产互不影响
            let shelf_state = Arc::new(
                shelf::ShelfState::new(db.clone(), data_dir.join("shelf"), handle.clone())
                    .expect("暂存架目录初始化失败"),
            );
            // 自动清理开关默认关闭：关闭时不创建常驻线程，而不是每小时醒来空转。
            shelf_state.apply_auto_cleanup(settings.shelf_auto_cleanup_enabled);
            handle.manage(shelf_state);

            // 第一实例若是被资源管理器「发送到」拉起的，暂存架就绪后立即入库。
            let pending_send_to = take_pending_send_to();
            if !pending_send_to.is_empty() {
                process_send_to(&handle, pending_send_to);
            }

            // 通用跨应用拖入（v49）：暂存区放 app data 下**独立**目录，
            // 不放 shelf 托管目录——否则会被孤儿文件清扫逻辑误判为托管残留。
            // 启动时扫一次上次异常退出遗留的会话目录，之后不再轮询。
            let drag_drop_state = Arc::new(dragdrop::DragDropState::new(
                data_dir.join("drag-incoming"),
            ));
            drag_drop_state.sweep();
            handle.manage(drag_drop_state.clone());
            tracing::info!("setup: 暂存架与拖入模块已就绪");

            let hub = Arc::new(AgentHub::new(handle.clone(), db.clone()));
            handle.manage(hub.clone());
            tracing::info!("setup: AgentHub 已托管");

            // 主窗口在此显式创建（tauri.conf.json 中 main 设了 "create": false）。
            // 根因：配置窗口会在 setup 完成前创建并开始加载前端，页面里的
            // get_settings / list_tasks 因此可能在 DB 等状态尚未 manage 时失败，
            // 表现为「重启后主题 / 视觉预设 / 材质停在默认值，刷新页面才恢复」。
            // 推迟到上述状态全部托管之后再创建，首屏 IPC 必定可用。
            // 其余窗口（notification / capture）保持原有创建时机；
            // context-menu 也改为 DB 托管后由 context_menu::init 创建，
            // 避免其首屏 get_settings 与 handle.manage(db) 竞态。
            //
            // 验收/无头 Agent 测试专用：跳过窗口、材质、吸附、快捷键与托盘 UI，
            // 只保留 REST / MCP / Hook / 接入管线。正常启动不设置该变量。
            let headless = std::env::var_os("TASKDOCK_TEST_HEADLESS").is_some();
            if headless {
                tracing::warn!("TASKDOCK_TEST_HEADLESS 已设置：跳过主窗口与桌面 UI 初始化");
            }
            if !headless {
            if let Some(cfg) = handle
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
            {
                tauri::WebviewWindowBuilder::from_config(&handle, &cfg)?.build()?;
            }
            tracing::info!("setup: 主窗口已创建");

            // 窗口恢复（位置/模式/关闭行为）
            restore_window(&handle, &db);
            tracing::info!("setup: 窗口恢复完成");

            // 圆角外形按当前视觉预设先落一次（前端加载后会以真实预设再同步一次），
            // 保证窗口第一次显示时四角就是圆角，不会闪一下直角。
            // 两种玻璃预设（柔光 / 清透）同样使用 20px，与前端 presetRadius 保持一致。
            window_shape::set_radius(
                if matches!(
                    settings.visual_preset.as_str(),
                    "liquid-glass" | "frosted" | "clear"
                ) {
                    20.0
                } else {
                    18.0
                },
            );
            if let Some(win) = handle.get_webview_window("main") {
                if !window_shape::apply(&win) {
                    tracing::debug!("窗口圆角区域未应用（可能为无 Win32 句柄的早期阶段）");
                }
                // 启动阶段窗口尺寸会连续变化（模式尺寸 → 记忆矩形 → 前端布局稳定），
                // 延迟重算保证区域最终与窗口尺寸一致。
                window_shape::schedule_reapply(&win);
                // 销毁时清理区域缓存（防句柄复用后误判「已应用」）
                window_shape::watch_destroy(&win);
                // 拖拽磁力：在**主窗**上安装 WM_MOVING 子类化（只此一个窗口；
                // 右键菜单等独立窗口不接管）。必须在窗口所属线程调用。
                match win.hwnd() {
                    Ok(h) => {
                        if !magnetic::install(h.0 as isize) {
                            tracing::warn!("拖拽磁力子类化安装失败，吸附手感退化为纯阈值");
                        }
                        // 拖拽相位：原生移动循环开始/结束都通知本窗口前端，
                        // 载荷带单调代次（`drag_signal`），前端只结束代次匹配的会话，
                        // 迟到的旧结束信号不会清掉刚开始的新拖拽。
                        // 只发给主窗；微件窗口走 `drag_watch` 的同一协议。
                        let win_for_drag = win.clone();
                        magnetic::register_drag_hook(Box::new(move |event| {
                            // 低频（每次拖拽两条）：诊断日志用于核对相位是否送达前端。
                            tracing::debug!(
                                phase = ?event.phase,
                                generation = event.generation,
                                "window-drag 相位发出"
                            );
                            let _ = win_for_drag.emit(drag_signal::DRAG_EVENT, event);
                        }));
                    }
                    Err(e) => tracing::warn!("无法获取主窗句柄，拖拽磁力未安装: {e}"),
                }
                // 通用跨应用拖入：接替 wry 那个**只认 CF_HDROP** 的 IDropTarget
                //（它在 DragEnter 里读不到文件路径就直接返回 NONE，网页图片/链接/
                // 文本/虚拟文件因此在事件层被吞掉，前端与诊断都看不到）。
                // 必须在 WebView 创建之后安装。OLE 每窗口只允许一个 drop target，
                // 接管必须先撤销原处理器；注册失败的窗口无法恢复 wry 的处理器
                //（平台限制，见 dragdrop::windows_ole 顶部），因此失败会如实写诊断。
                match win.hwnd() {
                    Ok(h) => {
                        match dragdrop::install_native_bridge(
                            &handle,
                            "main",
                            h.0 as isize,
                            drag_drop_state.clone(),
                        ) {
                            Ok(report) => tracing::info!(
                                windows = report.installed,
                                failed = report.failed,
                                recovered = report.recovered,
                                top_level_ok = report.top_level_ok,
                                "通用拖入原生接收桥已安装（替换 wry 的路径专用处理器）"
                            ),
                            Err(e) => {
                                tracing::warn!(
                                    "通用拖入原生接收桥安装失败，已退化为仅支持本地文件路径: {e}"
                                );
                                dragdrop::report_install_failure(&e);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("无法获取主窗句柄，通用拖入未安装: {e}");
                        dragdrop::report_install_failure(&format!("无主窗句柄: {e}"));
                    }
                }
                // 窗口销毁时撤销本进程的拖入接管：进程内重建窗口会复用/新建 HWND，
                // 旧注册必须解除，绝不留给系统回收。对已销毁句柄撤销只会返回错误。
                // 同时移除该窗口的跨 Tab 上下文，避免残留指向已删除实体。
                let ctx_handle = handle.clone();
                let window_label = win.label().to_string();
                win.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        dragdrop::uninstall_native_bridge();
                        if let Some(state) = ctx_handle
                            .try_state::<Arc<transfer::context::ContextState>>()
                        {
                            state.forget(&window_label);
                        }
                    }
                });
                magnetic::watch_destroy(&win);
                // 拖拽期间 `window_shape::apply` 会跳过回读与 DWM 写入（逐帧写会让
                // DWM 反复重新合成，表现为拖动中整窗透明）。松手时由磁力层的
                // `WM_EXITSIZEMOVE` 调 `flush_deferred`，通过本回调一次性补做校准。
                let win_for_flush = win.clone();
                window_shape::register_apply_hook(Box::new(move || {
                    let _ = window_shape::apply(&win_for_flush);
                }));
            }
            }

            // 窗口材质（毛玻璃）：在显示窗口之前应用，避免透明闪烁；
            // 失败自动回退 solid（前端 load 时会再次确认实际状态）
            // settings 已在剪贴板启动前加载（同一份快照）

            // Hook 上报 CLI 的传输参数（端口/令牌/启停）：每次启动刷新，设置变更时同步
            if let Err(e) = agents::hook_cli::write_transport_config(
                &data_dir,
                settings.http_port,
                &settings.http_token,
                settings.http_enabled,
            ) {
                tracing::warn!("写入 Hook 传输参数失败: {}", e);
            }

            // 有界接入管线：唯一消费者批量写库，所有高频入口共用。
            // 退出超时/写失败时把未落库事件原子暂存到 data/ingest-spool，下次启动幂等重放。
            let sink: Arc<dyn agents::pipeline::IngestSink> = hub.clone();
            let mut pipeline_config = agents::pipeline::PipelineConfig::from_settings(&settings);
            pipeline_config.spool_dir = Some(data_dir.join("ingest-spool"));
            let pipeline = agents::pipeline::IngestPipeline::new(sink, pipeline_config);
            pipeline.start();
            handle.manage(pipeline.clone());
            if !headless && settings.material == "glass" {
                // 预设一并传入：清透玻璃在启动时就必须走无原生模糊通道。
                if let Ok(r) = commands::system::apply_window_material(
                    handle.clone(),
                    "glass".into(),
                    Some(settings.visual_preset.clone()),
                ) {
                    if !r.applied {
                        tracing::info!("系统不支持毛玻璃材质，已回退 solid（{}）", r.os_version);
                    }
                }
            }

            // 预检已通过（或为正式版），此时才显示窗口。
            //
            // 若上次退出时是停靠态（snap_enabled + snap_state.edge），先把区域裁成
            // 1×1 空白：窗口立刻 show（前台可见 → 定时器不被节流，恢复更快），
            // 但屏幕上没有任何主窗口像素；前端把容器尺寸 + 贴边位置 + 轨道区域
            // 一次做完后由 `notify_ui_ready` 清掉空白区域。旧实现先露出完整主窗口
            // 约 1.9s 再缩成胶囊，正是「停靠态仍看到主窗口矩形」的启动路径。
            // 启动意图只判定一次：后面的工作台启动与回退都用同一个结果。
            let startup_intent = startup_intent_from_args(&std::env::args().collect::<Vec<_>>());
            if !headless {
            let docked_restore = settings.snap_enabled
                && db
                    .get_setting("snap_state")
                    .ok()
                    .flatten()
                    .and_then(|v| {
                        serde_json::from_value::<commands::system::WindowSnapState>(v).ok()
                    })
                    .map(|s| s.is_valid() && s.edge != "none")
                    .unwrap_or(false);
            // 启动意图只判定一次：后面的工作台启动与回退都用同一个结果。
            let show_quick_surface = startup_shows_quick_surface(startup_intent, docked_restore);
            if let Some(win) = handle.get_webview_window("main") {
                if docked_restore {
                    if let Ok(h) = win.hwnd() {
                        window_shape::set_blank(h.0 as isize, true);
                        // 必须在 show() 之前真正裁好：否则窗口会带着上一次的
                        // 整窗区域先显示出来（哪怕只有一帧，也是完整主窗口）。
                        window_shape::apply(&win);
                        tracing::debug!(
                            "启动为停靠恢复：先裁成 1×1 空白区域，等前端区域就绪（兜底 {}ms）",
                            BLANK_REGION_FALLBACK_MS
                        );
                    }
                    let fallback = handle.clone();
                    let boot_mode = settings.mode.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(
                            BLANK_REGION_FALLBACK_MS,
                        ));
                        if clear_startup_blank(&fallback) {
                            // 4s 只负责撤销空白区域（窗口先可见）；再等到 10s 仍未收到
                            // 前端就绪才记异常，避免把开发态 5–8s 的正常加载记成故障。
                            std::thread::sleep(std::time::Duration::from_millis(
                                STARTUP_READY_WARN_MS.saturating_sub(
                                    BLANK_REGION_FALLBACK_MS,
                                ),
                            ));
                            if UI_READY.load(Ordering::SeqCst) {
                                return;
                            }
                            // 记录成结构化启动诊断（而不是普通 tracing 文案）：诊断中心
                            // 只显示「前端未就绪」无法判断是模块加载慢、Wry/WebView 故障，
                            // 还是停靠恢复把窗口卡住；这里带上模式、实际尺寸与 DPI。
                            let (w, h, scale) = fallback
                                .get_webview_window("main")
                                .and_then(|win| {
                                    let size = win.outer_size().ok()?;
                                    let scale = win.scale_factor().unwrap_or(1.0);
                                    Some((size.width, size.height, scale))
                                })
                                .unwrap_or((0, 0, 1.0));
                            diagnostics::emit(startup_timeout_event(
                                STARTUP_READY_WARN_MS,
                                &boot_mode,
                                w,
                                h,
                                scale,
                            ));
                        }
                    });
                }
                // 普通启动：旧完整面板（主窗 full 视图）不再作为首屏，也不先 show
                // 再被工作台切换——那会闪一下并抢一次焦点。胶囊态例外（见判定函数）。
                // 自启动/发送到保持原有主面板可见性。
                if show_quick_surface {
                    let _ = win.show();
                } else {
                    tracing::debug!("普通启动：主窗口保持隐藏，由大型工作台作为首屏");
                }
            }
            }

            // 开机自启动（按设置应用）
            if !headless && settings.autostart {
                use tauri_plugin_autostart::ManagerExt;
                let _ = handle.autolaunch().enable();
            }

            // 自定义快捷键：加载配置 → 合并动作 → 注册系统级组合 → 记录真实状态。
            // 旧版 `hotkey_enabled` 只作为「系统级默认启用」的种子；注册失败会写入状态并在 UI 展示。
            if !headless {
                crate::hotkeys::init(&handle, settings.hotkey_enabled);
                tracing::info!("setup: 快捷键初始化完成");
            }

            // 托盘
            setup_tray(app).expect("托盘初始化失败");
            refresh_tray(&handle, AgentState::Idle);
            tracing::info!("setup: 托盘初始化完成");

            // 验收/无头 Agent 测试专用：跳过四个辅助 WebView 窗口，保留托盘与 MCP/REST。
            // 正常启动不设置该变量，行为不变。
            if !headless && std::env::var_os("TASKDOCK_TEST_SKIP_AUX_WINDOWS").is_none() {
                // 液态玻璃右键菜单：挂接弹窗窗口事件（失焦关闭 / 圆角区域）
                context_menu::init(&handle);
                tracing::info!("setup: 右键菜单模块初始化完成");

                // 极简标签悬停提示：独立透明窗口，点击穿透、不抢焦点
                tab_hint::init(&handle);
                tracing::info!("setup: 标签提示模块初始化完成");

                // 自定义通知窗口：挂接生命周期事件（WS_EX_NOACTIVATE 在每次显示前确保）
                notification_window::init(&handle);
                tracing::info!("setup: 通知窗口模块初始化完成");

                // 全局快速捕获：挂接窗口事件（失焦落草稿后隐藏 / 关闭改为隐藏）
                quick_capture::init(&handle);
                tracing::info!("setup: 窗口辅助模块初始化完成");
            } else if headless {
                tracing::warn!("TASKDOCK_TEST_HEADLESS 已设置：跳过辅助窗口初始化");
            } else {
                tracing::warn!("TASKDOCK_TEST_SKIP_AUX_WINDOWS 已设置：跳过辅助窗口初始化");
            }

            // Agent 适配器
            Box::new(agents::file_drop::FileDropAdapter::new(pipeline.clone())).spawn(hub.clone());
            Box::new(agents::http_ingest::HttpIngestAdapter::new(
                pipeline.clone(),
            ))
            .spawn(hub.clone());
            Box::new(agents::mock::MockAdapter::new()).spawn(hub.clone());

            // Agent MCP Server（v37，默认关闭）：设置开关驱动 loopback bridge，
            // stdio 子命令经 mcp-transport.json 连入；planning-changed 事件广播给前端
            {
                let mcp_status =
                    mcp::bridge::spawn_adapter(handle.clone(), db.clone(), data_dir.clone());
                handle.manage(mcp_status);
            }

            // 手机接入（v0.16，默认关闭）：设置开关驱动局域网配对监听；
            // 关闭/端口变更/应用退出都会让监听循环在 2s 内退出，不留下悬挂任务。
            {
                let files_root = data_dir.join("mobile_files");
                // 上次进程遗留的半成品上传不可恢复：清理记录与 tmp 分块。
                match mobile_sync::files::recover_pending(&db, &files_root) {
                    Ok(0) => {}
                    Ok(count) => tracing::info!("手机文件互传：清理 {} 条未完成上传", count),
                    Err(error) => tracing::warn!("手机文件互传恢复失败: {error}"),
                };
                let mobile_state = mobile_sync::MobileSyncState::new(&db, files_root);
                handle.manage(mobile_state.clone());
                mobile_sync::spawn_supervisor(db.clone(), mobile_state);
            }

            // 异常重启恢复：重启前遗留的活跃轮次按失联规则归位
            if let Err(e) = hub.recover_after_restart() {
                tracing::warn!("重启恢复失败: {}", e);
            }

            // 上次退出超时暂存的事件：启动后异步幂等重放（不阻塞窗口显示）。
            {
                let spool = agents::spool::Spool::new(data_dir.join("ingest-spool"));
                let replay_pipeline = pipeline.clone();
                let replay_dir = data_dir.clone();
                tauri::async_runtime::spawn(async move {
                    let report = agents::spool::replay_pending(&replay_pipeline, &spool).await;
                    if report.files_found == 0 {
                        return;
                    }
                    tracing::info!(
                        files = report.files_found,
                        replayed = report.files_replayed,
                        events = report.events_replayed,
                        deduplicated = report.deduplicated,
                        quarantined = report.files_quarantined,
                        failed = report.failed_files,
                        elapsed_ms = report.elapsed_ms,
                        "退出暂存事件重放完成"
                    );
                    let path = replay_dir.join("last-spool-replay.json");
                    match serde_json::to_string_pretty(&report) {
                        Ok(json) => {
                            if let Err(e) = std::fs::write(&path, json) {
                                tracing::warn!("写入暂存重放报告失败: {}", e);
                            }
                        }
                        Err(e) => tracing::warn!("序列化暂存重放报告失败: {}", e),
                    }
                });
            }

            // 提醒调度引擎
            scheduler::start_scheduler(handle.clone(), db.clone(), hub.clone());

            // 专注会话恢复：上次退出时仍在运行的会话转为「已暂停（应用重启）」，
            // 不补记退出区间。必须在调度器启动后、窗口交互前完成。
            if let Err(e) = focus::restore_on_startup(&db) {
                tracing::warn!("专注会话恢复失败: {}", e);
            }

            // 事件保留/归档：后台任务，启动路径不扫表（首跑延迟 20 秒）
            agents::retention::start_background(handle.clone(), db.clone());

            // 自动备份（超过 24 小时）：阻塞线程池执行，不拖慢启动与 UI
            {
                let backup_handle = handle.clone();
                let db2 = db.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(e) =
                        commands::data::auto_backup_if_needed_inner(&backup_handle, &db2)
                    {
                        tracing::warn!("启动自动备份失败: {}", e);
                    }
                });
            }

            // 默认启动：大型完整工作台（workspace 窗口）是唯一的大型主界面。
            // 位置：DB / 设置 / 托盘 / 快捷键 / 窗口服务全部就绪之后、启动里程碑之前，
            // 满足「必要状态准备完毕再创建」；窗口隐藏创建，前端首帧就绪（
            // `workbench_ui_ready`）后才真正显示，避免先露出空白窗口。
            //
            // 自启动与「发送到」不抢占大窗口（见 `startup_shows_quick_surface`）：
            // 前者是后台驻留，后者要的是暂存回显 + 主面板。
            let workspace_created = if startup_opens_workbench(startup_intent) {
                match project_workspace_window::open_workbench_on_startup(&handle, &db) {
                    Ok(created) => created,
                    Err(error) => {
                        diagnostics::event(
                            diagnostics::DiagLevel::Error,
                            "workbench",
                            "startup-open",
                            "failed",
                        )
                        .window(project_workspace_window::WINDOW_LABEL)
                        .status(diagnostics::DiagStatus::Failed)
                        .message(format!("启动打开大型工作台失败: {error}"))
                        .from_error(&error)
                        .emit();
                        // 失败不能静默退回旧界面：显示主面板并广播明确错误与恢复入口
                        // （托盘 / 快捷入口「打开完整工作台」会重新尝试创建）。
                        project_workspace_window::fallback_to_main(
                            &handle,
                            &format!("大型工作台打开失败：{error}"),
                        );
                        false
                    }
                }
            } else {
                false
            };

            tracing::info!("Task Dock 启动完成（数据目录: {:?}）", data_dir);
            // 显式里程碑（不依赖 tracing 的 INFO：正常模式下 INFO 不落盘）。
            diagnostics::event(
                diagnostics::DiagLevel::Info,
                "system",
                "startup",
                "ready",
            )
            .status(diagnostics::DiagStatus::Success)
            .message("应用启动完成")
            .metadata(
                "mode",
                serde_json::Value::String(
                    db::Settings::load(&db)
                        .map(|settings| settings.mode.clone())
                        .unwrap_or_else(|_| "unknown".to_string()),
                ),
            )
            // 启动环境快照：判断「看到的到底是不是这一版」只需这一条记录。
            // 只记标识、目录、PID 与意图，不含任何令牌/口令。
            .metadata("dev", serde_json::json!(tauri::is_dev()))
            .metadata("pid", serde_json::json!(std::process::id()))
            .metadata(
                "instanceIdentifier",
                serde_json::Value::String(handle.config().identifier.clone()),
            )
            .metadata(
                "dataDir",
                serde_json::Value::String(data_dir.display().to_string()),
            )
            .metadata(
                "intent",
                serde_json::Value::String(format!("{startup_intent:?}")),
            )
            .metadata(
                "workspaceCreated",
                serde_json::json!(workspace_created),
            )
            .emit();
            let _ = handle.emit("app-ready", ());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 任务
            commands::tasks::list_tasks,
            commands::tasks::fetch_task,
            commands::tasks::task_stats,
            commands::tasks::create_task,
            commands::tasks::update_task,
            commands::tasks::update_task_cas,
            commands::tasks::toggle_task,
            commands::tasks::undo_task_completion,
            commands::tasks::delete_task,
            commands::tasks::parse_quick_add,
            commands::tasks::create_from_quick_add,
            commands::tasks::snooze_reminder,
            commands::tasks::undo_snooze,
            commands::tasks::active_reminders,
            commands::tasks::cancel_reminders,
            commands::tasks::link_task_agent,
            commands::tasks::unlink_task_agent,
            commands::tasks::list_task_links,
            commands::tasks::pending_items_to_tasks,
            // 任务提醒联动（v41）：任务 ↔ 场景/工作现场，通知卡显式点击才执行
            commands::tasks::task_reminder_link_get,
            commands::tasks::task_reminder_link_set,
            commands::tasks::task_reminder_link_clear,
            // 生活效率系统 v1（2026-11-16）：生活记录 / 购买历史 / 票据关联。
            // 生活待办不新增命令，复用 tasks / 任务编辑器。
            commands::life::life_items_list,
            commands::life::life_item_history,
            commands::life::life_events_recent,
            commands::life::life_event_detail,
            commands::life::life_event_create,
            commands::life::life_event_update,
            commands::life::life_event_delete,
            commands::life::life_overview,
            commands::life::life_quick_query,
            commands::life::life_document_link_create,
            commands::life::life_document_link_delete,
            commands::life::life_document_links_list,
            // 任务统计（tasks.stats-trends）：只读聚合，打开统计子视图时按需调用
            commands::task_analytics::task_analytics,
            // 句式命令（ux.command-phrases）：确定性帧表解析 + 候选/只读查询
            commands::command_phrases::resolve_command_phrase,
            // 专注与休息（core.focus-timer）：Rust 侧权威状态机 + 既有 1 秒调度推进
            commands::focus::focus_snapshot,
            commands::focus::focus_history,
            commands::focus::focus_start,
            commands::focus::focus_start_break,
            commands::focus::focus_pause,
            commands::focus::focus_resume,
            commands::focus::focus_finish,
            commands::focus::focus_cancel,
            commands::focus::focus_extend_break,
            commands::focus::focus_skip_break,
            commands::focus::focus_update_prefs,
            commands::focus::focus_snooze_sedentary,
            // 快速笔记（core.quick-notes）
            commands::notes::notes_list,
            commands::notes::notes_get,
            commands::notes::notes_create,
            commands::notes::notes_update,
            commands::notes::notes_delete,
            commands::notes::notes_set_flags,
            commands::notes::notes_set_task,
            commands::notes::notes_set_workspace,
            commands::notes::notes_templates,
            commands::notes::notes_search,
            commands::notes::notes_convert_capture,
            // Agent
            commands::agents::agent_snapshot,
            // Agent 历史分页（P1-02）：实时快照之外的历史会话/轮次按需查询
            commands::agents::agent_history_sessions,
            commands::agents::agent_history_runs,
            commands::agents::agent_history_session,
            commands::agents::agent_history_groups,
            // Agent 工作时间统计（只读聚合）
            commands::agent_stats::agent_work_time_stats,
            commands::audit::audit_test_data,
            commands::agents::set_source_enabled,
            commands::agents::create_source,
            commands::agents::update_source,
            commands::agents::delete_source,
            commands::agents::discovery_scan,
            commands::agents::adapter_list,
            commands::agents::adapter_preview,
            commands::agents::adapter_install,
            commands::agents::adapter_verify,
            commands::agents::adapter_uninstall,
            commands::agents::adapter_status,
            commands::agents::mock_start_scenario,
            commands::agents::codex_hooks_status,
            commands::agents::codex_hooks_install,
            commands::agents::codex_hooks_uninstall,
            commands::agents::open_agent_session,
            commands::agents::notification_page,
            commands::agents::notification_inbox_stats,
            commands::agents::mark_notification_read,
            commands::agents::mark_all_notifications_read,
            commands::agents::clear_notifications,
            commands::agents::list_agent_events,
            commands::agents::agent_retention_status,
            commands::agents::agent_retention_run,
            commands::agents::agent_archive_list,
            commands::agents::agent_inbox_retry,
            // 设置
            commands::settings::get_settings,
            commands::settings::update_settings,
            // 手机配对与局域网连接（v0.16；默认关闭，不暴露业务数据）
            commands::mobile_sync::mobile_sync_status,
            commands::mobile_sync::mobile_sync_start_pairing,
            commands::mobile_sync::mobile_sync_cancel_pairing,
            commands::mobile_sync::mobile_sync_list_devices,
            commands::mobile_sync::mobile_sync_revoke_device,
            // 手机文件互传（v1；文件本体在 data_dir/mobile_files）
            commands::mobile_sync::mobile_file_list,
            commands::mobile_sync::mobile_file_offer,
            commands::mobile_sync::mobile_file_delete,
            commands::mobile_sync::mobile_file_reveal,
            commands::mobile_sync::mobile_file_open_inbox,
            commands::mobile_sync::mobile_file_import_shelf,
            commands::mobile_sync::mobile_file_thumbnail,
            // 功能生命周期（只读批量快照；写入仍走 update_settings）
            commands::lifecycle::lifecycle_status,
            // 诊断日志（本地持久化 / 查询 / 摘要 / 导出 / 清理）
            commands::diagnostics::diagnostics_record,
            commands::diagnostics::diagnostics_status,
            commands::diagnostics::diagnostics_set_mode,
            commands::diagnostics::diagnostics_query,
            commands::diagnostics::diagnostics_summary,
            commands::diagnostics::diagnostics_export,
            commands::diagnostics::diagnostics_export_preview,
            commands::diagnostics::diagnostics_metrics_summary,
            commands::diagnostics::diagnostics_clear,
            commands::diagnostics::diagnostics_open_dir,
            // 安全审计（security_audit_log，迁移 v82）：查询与用户显式清理
            commands::security_audit::security_audit_query,
            commands::security_audit::security_audit_prune,
            // 统一提示音 / 语音播报 / 本地语音缓存（v0.13）
            commands::audio::tts_list_voices,
            commands::audio::tts_synthesize,
            commands::audio::tts_cache_stats,
            commands::audio::tts_cache_clear,
            commands::resource_cleanup::resource_snapshot,
            commands::resource_cleanup::resource_cleanup_preview,
            commands::resource_cleanup::resource_cleanup_execute,
            commands::resource_cleanup::resource_process_diagnostics,
            commands::resource_cleanup::resource_disk_usage,
            commands::resource_cleanup::resource_disk_analyze,
            commands::resource_cleanup::resource_junk_preview,
            commands::resource_cleanup::resource_junk_execute,
            commands::resource_cleanup::resource_memory_catalog,
            commands::resource_cleanup::resource_memory_release,
            commands::voice_packs::voice_packs_list,
            commands::voice_packs::voice_pack_create,
            commands::voice_packs::voice_pack_rename,
            commands::voice_packs::voice_pack_delete,
            commands::voice_packs::voice_asset_import,
            commands::voice_packs::voice_asset_remove,
            commands::voice_packs::voice_binding_set,
            commands::voice_packs::voice_resolve_clip,
            commands::voice_packs::voice_asset_path,
            commands::settings::clipboard_repair_config,
            commands::settings::save_window_rect,
            commands::settings::get_window_rect,
            // 用户偏好镜像（语言 / 桌面微件布局；备份恢复经 preferences.json）
            commands::user_preferences::get_user_preferences,
            commands::user_preferences::set_user_preferences,
            // 数据
            commands::data::export_data,
            commands::data::import_data,
            commands::data::inspect_backup,
            commands::data::backup_now,
            commands::data::list_backups,
            commands::data::auto_backup_if_needed,
            // 系统
            // 自定义快捷键（ux.custom-hotkeys）
            commands::hotkeys::hotkeys_snapshot,
            commands::hotkeys::hotkeys_change,
            commands::hotkeys::hotkeys_reset,
            commands::system::quit_app,
            commands::system::app_exit_ack,
            commands::system::set_autostart,
            commands::system::apply_mode,
            commands::system::set_hotkeys_enabled,
            commands::system::get_agent_inbox_dir,
            commands::system::show_main_window,
            commands::system::save_snap_state,
            commands::system::get_snap_state,
            commands::system::hub_health,
            commands::system::performance_diagnostics,
            commands::system::app_build_info,
            commands::system::app_runtime_git_info,
            commands::system::apply_window_material,
            commands::system::apply_window_radius,
            // 工作台窗口半径（与主窗同一口径，按视觉预设由前端下发）
            project_workspace_window::set_workspace_window_radius,
            // 工作台角部曲线（连续圆角；前端确认 corner-shape 支持后下发）
            project_workspace_window::set_workspace_window_corner,
            commands::system::apply_window_capsule,
            commands::system::set_magnetic_drag_config,
            commands::system::drag_loop_active,
            commands::system::arm_drag_session,
            commands::system::set_magnetic_dock,
            commands::system::set_undock_anchor,
            commands::system::take_undock_anchor_applied,
            commands::system::cancel_undock_anchor,
            commands::system::notify_ui_ready,
            // 液态玻璃右键菜单（v0.6；托盘右键入口 + 极简标签三项快捷菜单）
            context_menu::hide_context_menu,
            context_menu::fit_context_menu,
            context_menu::context_menu_action,
            context_menu::tab_menu_action_result,
            // 极简标签（Edge Tab）：独立悬停提示窗 + 标签旁快捷菜单入口
            tab_popups::show_tab_context_menu,
            tab_hint::show_tab_hint,
            tab_hint::hide_tab_hint,
            tab_hint::fit_tab_hint,
            tab_hint::tab_hint_ready,
            // 自定义通知窗口（v0.7 六状态桌面通知）
            notification_window::fit_notification_window,
            notification_window::hide_notification_window,
            notification_window::notification_snooze,
            notification_window::notification_navigate,
            notification_window::notification_ui_ready,
            // 桌面微件独立窗口（P2：主窗口为唯一数据所有者，微件窗口只读快照）
            widget_windows::show_widget_window,
            widget_windows::hide_widget_window,
            widget_windows::dismiss_widget_window,
            widget_windows::set_widget_topmost,
            widget_windows::widget_window_info,
            widget_windows::report_widget_bounds,
            widget_windows::reset_widget_position,
            widget_windows::publish_widget_snapshot,
            widget_windows::request_widget_snapshot,
            widget_windows::dispatch_widget_action,
            // 统一导航（v0.4）
            commands::navigation::nav_scan_apps,
            commands::navigation::nav_cancel_scan,
            commands::navigation::nav_app_icon,
            commands::navigation::nav_list_windows,
            commands::navigation::nav_list_target_windows,
            commands::navigation::nav_list_targets,
            commands::navigation::nav_target_running_states,
            commands::navigation::nav_close_target_windows,
            commands::navigation::nav_quit_target_processes,
            commands::navigation::nav_kill_target_processes,
            commands::navigation::nav_save_target,
            commands::navigation::nav_save_window_target,
            commands::navigation::nav_update_target,
            commands::navigation::nav_delete_target,
            commands::navigation::nav_save_agent_session_target,
            commands::navigation::nav_window_memory,
            commands::navigation::nav_forget_window,
            commands::navigation::nav_pick_window_identity,
            commands::navigation::nav_pick_task_window,
            commands::navigation::nav_link_task_window,
            commands::navigation::nav_forget_task_window,
            commands::navigation::nav_set_task_window_fallback,
            commands::navigation::nav_recent_logs,
            commands::navigation::nav_prune_logs,
            commands::navigation::nav_link_task,
            commands::navigation::nav_unlink_task,
            commands::navigation::nav_update_task_link,
            commands::navigation::nav_task_targets,
            commands::navigation::nav_all_task_links,
            commands::navigation::nav_navigate,
            commands::navigation::nav_agent_capabilities,
            commands::navigation::nav_agent_action,
            commands::navigation::nav_agent_open_workspace,
            // 规划中心（v0.7）：用户自建项目的功能规划、步骤、里程碑与进度历史
            commands::planning::planning_list_projects,
            commands::planning::planning_create_project,
            commands::planning::planning_update_project,
            commands::planning::planning_archive_project,
            commands::planning::planning_delete_project,
            commands::planning::planning_reorder_projects,
            commands::planning::planning_list_features,
            commands::planning::planning_list_feature_agent_links,
            commands::planning::planning_list_agent_feature_links,
            commands::planning::planning_unlink_agent_session,
            commands::planning::planning_create_feature,
            commands::planning::planning_update_feature,
            commands::planning::planning_delete_feature,
            commands::planning::planning_reorder_features,
            commands::planning::planning_add_step,
            commands::planning::planning_update_step,
            commands::planning::planning_delete_step,
            commands::planning::planning_reorder_steps,
            commands::planning::planning_list_milestones,
            commands::planning::planning_create_milestone,
            commands::planning::planning_update_milestone,
            commands::planning::planning_delete_milestone,
            commands::planning::planning_activity_page,
            commands::planning::planning_add_note,
            project_hub::commands::project_hub_list_projects,
            project_hub::commands::project_hub_get_project,
            project_hub::commands::project_hub_create_project,
            project_hub::commands::project_create,
            project_hub::commands::project_hub_resource_candidates,
            project_hub::commands::project_hub_resource_links,
            project_hub::commands::project_hub_resource_link,
            project_hub::commands::project_hub_resource_unlink,
            project_hub::commands::project_hub_resource_validate,
            project_hub::commands::workspace_path_check,
            // Agent MCP Server（v37）：管理命令（第二轮 UI 使用）
            mcp::commands::mcp_status,
            mcp::commands::mcp_agent_list,
            mcp::commands::mcp_agent_create,
            mcp::commands::mcp_agent_rotate_token,
            mcp::commands::mcp_agent_set_scope,
            mcp::commands::mcp_agent_grant_project,
            mcp::commands::mcp_agent_revoke_project,
            mcp::commands::mcp_agent_revoke,
            mcp::commands::mcp_audit_list,
            mcp::commands::mcp_config_snippet,
            mcp::commands::mcp_config_hint,
            mcp::commands::mcp_agent_capabilities,
            mcp::commands::mcp_agent_grant_capability,
            mcp::commands::mcp_agent_revoke_capability,
            mcp::commands::mcp_workspace_roots,
            mcp::commands::mcp_workspace_grant_root,
            mcp::commands::mcp_workspace_revoke_root,
            mcp::commands::mcp_audit_prune,
            mcp::commands::mcp_diagnostics,
            // 知识与 AI 能力中心（v72）
            capability::commands::capability_knowledge_stats,
            capability::commands::capability_kb_list,
            capability::commands::capability_kb_get,
            capability::commands::capability_kb_create,
            capability::commands::capability_kb_update,
            capability::commands::capability_kb_delete,
            capability::commands::capability_kb_set_favorite,
            capability::commands::capability_document_list,
            capability::commands::capability_document_get,
            capability::commands::capability_document_import_file,
            capability::commands::capability_document_import_folder,
            capability::commands::capability_document_import_note,
            capability::commands::capability_document_import_capture,
            capability::commands::capability_document_create_text,
            capability::commands::capability_document_reindex,
            capability::commands::capability_kb_rebuild,
            capability::commands::capability_document_delete,
            capability::commands::capability_knowledge_search,
            capability::commands::capability_knowledge_link_add,
            capability::commands::capability_knowledge_link_remove,
            capability::commands::capability_knowledge_links,
            capability::commands::capability_knowledge_backlinks,
            capability::commands::capability_skill_scan,
            capability::commands::capability_skill_list,
            capability::commands::capability_skill_get,
            capability::commands::capability_skill_set_enabled,
            capability::commands::capability_skill_set_scope,
            capability::commands::capability_skill_import,
            capability::commands::capability_skill_save_content,
            capability::commands::capability_skill_delete,
            capability::commands::capability_mcp_servers_list,
            capability::commands::capability_mcp_server_save,
            capability::commands::capability_mcp_server_delete,
            capability::commands::capability_mcp_server_set_enabled,
            capability::commands::capability_mcp_server_set_allow_high_risk,
            capability::commands::capability_mcp_server_test,
            capability::commands::capability_mcp_server_call,
            capability::commands::capability_mcp_calls,
            capability::commands::capability_context_list,
            capability::commands::capability_context_get,
            capability::commands::capability_context_save,
            capability::commands::capability_context_delete,
            capability::commands::capability_context_duplicate,
            capability::commands::capability_context_assemble,
            capability::commands::capability_recipe_list,
            capability::commands::capability_recipe_get,
            capability::commands::capability_recipe_save,
            capability::commands::capability_recipe_delete,
            capability::commands::capability_recipe_duplicate,
            capability::commands::capability_recipe_export,
            capability::commands::capability_recipe_import,
            capability::commands::capability_recipe_run,
            capability::commands::capability_recipe_runs,
            capability::commands::capability_recipe_run_get,
            // 智能剪贴板（v0.5）
            commands::clipboard::clipboard_view,
            commands::clipboard::clipboard_item,
            commands::clipboard::clipboard_group,
            commands::clipboard::clipboard_group_page,
            commands::clipboard::clipboard_group_item_position,
            commands::clipboard::clipboard_stats,
            commands::clipboard::clipboard_sources,
            commands::clipboard::clipboard_thumb,
            commands::clipboard::clipboard_preview,
            commands::clipboard::clipboard_image,
            commands::clipboard::clipboard_copy_item,
            commands::clipboard::clipboard_copy_text,
            commands::clipboard::clipboard_save_image,
            commands::clipboard::clipboard_ocr,
            commands::clipboard::clipboard_ocr_cancel,
            commands::clipboard::clipboard_open_url,
            commands::clipboard::clipboard_open_local_path,
            commands::clipboard::clipboard_reveal_local_path,
            commands::clipboard::clipboard_path_status,
            commands::clipboard::clipboard_copy_group_rich,
            commands::clipboard::clipboard_copy_group_files,
            commands::clipboard::clipboard_copy_items_rich,
            commands::clipboard::clipboard_copy_items_files,
            commands::clipboard::clipboard_toggle_item,
            commands::clipboard::clipboard_rename_item,
            commands::clipboard::clipboard_toggle_group,
            commands::clipboard::clipboard_close_group,
            commands::clipboard::clipboard_delete_items,
            commands::clipboard::clipboard_delete_group,
            commands::clipboard::clipboard_clear_history,
            commands::clipboard::clipboard_create_group,
            commands::clipboard::clipboard_rename_group,
            commands::clipboard::clipboard_add_to_group,
            commands::clipboard::clipboard_remove_group_item,
            commands::clipboard::clipboard_move_group_item,
            commands::clipboard::clipboard_split_group,
            commands::clipboard::clipboard_merge_groups,
            commands::clipboard::clipboard_link_task,
            commands::clipboard::clipboard_unlink_task,
            commands::clipboard::clipboard_task_links,
            commands::clipboard::clipboard_visible_targets,
            commands::clipboard::clipboard_target_icon,
            commands::clipboard::clipboard_foreground_target,
            commands::clipboard::clipboard_paste_precheck,
            commands::clipboard::clipboard_focus_target,
            commands::clipboard::clipboard_paste_group,
            commands::clipboard::clipboard_paste_items,
            commands::clipboard::clipboard_paste_cancel,
            commands::clipboard::clipboard_paste_resume,
            commands::clipboard::clipboard_paste_job,
        commands::clipboard::clipboard_paste_item_states,
            commands::clipboard::clipboard_paste_active,
            commands::clipboard::clipboard_paste_resumable_job,
            commands::clipboard::clipboard_paste_resumable_jobs,
            commands::clipboard::clipboard_paste_resolve_uncertain,
            commands::clipboard::clipboard_cleanup,
            commands::clipboard::clipboard_status,
            commands::clipboard::clipboard_agent_targets,
            commands::clipboard::clipboard_export_for_agent,
            commands::clipboard::clipboard_export_preview,
            commands::clipboard::clipboard_probe,
            commands::clipboard::clipboard_link_snapshot,
            commands::clipboard::clipboard_unlink_snapshot,
            commands::clipboard::clipboard_snapshot_links,
            // 行动中心（v0.5）
            commands::actions::actions_feed,
            commands::actions::actions_ack,
            commands::actions::actions_unack,
            commands::actions::actions_open_session,
            // 工作现场（v0.5）
            commands::workspace::workspace_list,
            commands::workspace::workspace_get,
            commands::workspace::workspace_create,
            commands::workspace::workspace_capture_task,
            commands::workspace::workspace_rename,
            commands::workspace::workspace_delete,
            commands::workspace::workspace_prune,
            commands::workspace::workspace_detach_task,
            commands::workspace::workspace_capture_windows,
            commands::workspace::workspace_restore,
            commands::workspace::workspace_restore_cancel,
            commands::workspace::workspace_restore_status,
            // 场景工作区（v0.11，迁移 v38）：静态清单 + 现场/工作流软引用
            commands::scenario::scenario_list,
            commands::scenario::scenario_get,
            commands::scenario::scenario_save,
            commands::scenario::scenario_delete,
            commands::scenario::scenario_duplicate,
            commands::scenario::scenario_enter,
            commands::scenario::scenario_enter_cancel,
            // 全局快速捕获（v0.7）
            quick_capture::quick_capture_state,
            quick_capture::quick_capture_save_draft,
            quick_capture::quick_capture_clear_draft,
            quick_capture::quick_capture_set_last_type,
            quick_capture::quick_capture_submit,
            quick_capture::quick_capture_list,
            quick_capture::quick_capture_mark_handled,
            quick_capture::quick_capture_delete,
            quick_capture::quick_capture_convert_to_task,
            quick_capture::quick_capture_show,
            quick_capture::quick_capture_hide,
            quick_capture::quick_capture_voice_start,
            quick_capture::quick_capture_voice_stop,
            quick_capture::quick_capture_open_speech_settings,
            quick_capture::quick_capture_focus,
            quick_capture::quick_capture_add_attachment,
            quick_capture::quick_capture_remove_attachment,
            quick_capture::quick_capture_attachment_thumb,
            quick_capture::quick_capture_attachment_preview,
            // 统一任务上下文（v0.5）
            commands::context::task_context,
            // 文件暂存架（v0.8）
            commands::shelf::shelf_list,
            commands::shelf::shelf_get_item,
            commands::shelf::shelf_stats,
            commands::shelf::shelf_groups,
            commands::shelf::shelf_group_create,
            commands::shelf::shelf_group_rename,
            commands::shelf::shelf_group_delete,
            commands::shelf::shelf_add_paths,
            commands::shelf::shelf_add_link,
            commands::shelf::shelf_add_text,
            commands::shelf::shelf_add_from_clipboard,
            commands::shelf::shelf_paste_current,
            commands::shelf::shelf_sendto_status,
            commands::shelf::shelf_sendto_enable,
            commands::shelf::shelf_sendto_disable,
            commands::shelf::shelf_update,
            commands::shelf::shelf_delete,
            commands::shelf::shelf_clear,
            // 删除撤销（v53 回收站）与外部文件回收站
            commands::shelf::shelf_trash_delete,
            commands::shelf::shelf_trash_restore,
            commands::shelf::shelf_trash_purge,
            commands::shelf::shelf_trash_count,
            commands::shelf::shelf_recycle_preview,
            commands::shelf::shelf_recycle_execute,
            commands::shelf::shelf_cleanup,
            commands::shelf::shelf_check_exists,
            commands::shelf::shelf_open_item,
            commands::shelf::shelf_reveal_item,
            commands::shelf::shelf_read_text,
            commands::shelf::shelf_read_image,
            commands::shelf::shelf_copy_paths,
            commands::shelf::shelf_copy_files,
            commands::shelf::shelf_drag_out,
            commands::shelf::shelf_task_links,
            commands::shelf::shelf_link_task,
            commands::shelf::shelf_unlink_task,
            commands::shelf::shelf_project_links,
            commands::shelf::shelf_link_project,
            commands::shelf::shelf_unlink_project,
            commands::shelf::shelf_batch_link,
            commands::shelf::shelf_paste_screenshot,
            commands::shelf::shelf_item_tags,
            commands::shelf::shelf_tag_items,
            commands::shelf::shelf_recent_tags,
            commands::shelf::shelf_duplicate_scan,
            commands::shelf::shelf_rules_preview,
            commands::shelf::shelf_rules_apply,
            commands::shelf::shelf_ocr_item,
            commands::shelf::shelf_ocr_cancel,
            commands::shelf::shelf_move_items,
            commands::shelf::shelf_copy_to,
            commands::shelf::shelf_relocate_item,
            commands::shelf::shelf_recent_dirs,
            commands::shelf::shelf_recent_dir_pin,
            commands::shelf::shelf_recent_dir_remove,
            commands::shelf::shelf_recent_dirs_clear,
            // 快捷投递目标（收集箱「文件投递」）
            commands::shelf::shelf_drop_targets_list,
            commands::shelf::shelf_drop_target_create,
            commands::shelf::shelf_drop_target_update,
            commands::shelf::shelf_drop_target_delete,
            commands::shelf::shelf_drop_target_move,
            commands::shelf::shelf_drop_target_open,
            commands::shelf::shelf_drop_to_directory,
            // 通用跨应用拖入（v49）：提交 / 放弃 / 桥状态
            commands::dragdrop::drag_bridge_status,
            commands::dragdrop::drag_payload_commit_shelf,
            commands::dragdrop::drag_payload_commit_directory,
            commands::dragdrop::drag_payload_discard,
            commands::dragdrop::drag_report_client_issue,
            // 文件工作区（多目录文件浏览/操作/缩略图）
            commands::file_workspace::fs_list_dir,
            commands::file_workspace::fs_dir_signature,
            commands::file_workspace::fs_places,
            commands::file_workspace::fs_create_dir,
            commands::file_workspace::fs_create_file,
            commands::file_workspace::fs_rename,
            commands::file_workspace::fs_batch_rename,
            commands::file_workspace::fs_hash_files,
            commands::file_workspace::fs_volume_keys,
            commands::file_workspace::fs_preview_image,
            commands::file_workspace::fs_read_text,
            commands::file_workspace::fs_read_binary,
            commands::file_workspace::fs_preview_media_url,
            commands::file_workspace::fs_release_preview_url,
            commands::file_workspace::fs_copy_paths,
            commands::file_workspace::fs_move_paths,
            commands::file_workspace::fs_delete_paths,
            commands::duplicate_delete::fs_delete_verified_duplicates,
            commands::file_workspace::fs_stat,
            commands::file_workspace::fs_open,
            commands::file_workspace::fs_reveal,
            commands::file_workspace::fs_preview_operation,
            commands::file_workspace::fs_open_with,
            commands::file_workspace::fs_show_properties,
            commands::file_workspace::fs_open_terminal,
            commands::file_workspace::fs_thumbnail,
            // 统一文件操作服务 + 回收站索引（v68）：批量任务、进度、取消与缓存查询
            commands::recycle::fs_copy_job_start,
            commands::recycle::fs_drag_out,
            commands::recycle::fs_move_job_start,
            commands::recycle::fs_delete_job_start,
            commands::recycle::fs_job_status,
            commands::recycle::fs_job_report,
            commands::recycle::fs_batch_rename_job_start,
            commands::recycle::fs_job_cancel,
            commands::recycle::fs_jobs,
            commands::recycle::recycle_stats,
            commands::recycle::recycle_list,
            commands::recycle::recycle_sync,
            commands::recycle::recycle_sync_status,
            commands::recycle::recycle_sync_cancel,
            commands::recycle::recycle_restore,
            commands::recycle::recycle_purge,
            commands::recycle::recycle_empty,
            // 全局跨 Tab 联动（v79）：工作篮、目标预览/执行、批次、上下文、实体关联
            commands::transfer::transfer_add,
            commands::transfer::transfer_list,
            commands::transfer::transfer_get,
            commands::transfer::transfer_update,
            commands::transfer::transfer_remove,
            commands::transfer::transfer_reorder,
            commands::transfer::transfer_pin,
            commands::transfer::transfer_clear_temporary,
            commands::transfer::transfer_counts,
            commands::transfer::transfer_validate_target,
            commands::transfer::transfer_preview,
            commands::transfer::transfer_execute,
            commands::transfer::transfer_batch,
            commands::transfer::transfer_batches,
            commands::transfer::transfer_retry,
            commands::transfer::transfer_undo,
            commands::transfer::transfer_context_get,
            commands::transfer::transfer_context_update,
            commands::transfer::transfer_context_clear,
            commands::transfer::entity_link_create,
            commands::transfer::entity_link_batch,
            commands::transfer::entity_link_remove,
            commands::transfer::entity_link_unlink,
            commands::transfer::entity_link_related,
            // 一键工作流（v0.9）
            commands::workflows::workflow_list,
            commands::workflows::workflow_get,
            commands::workflows::workflow_create,
            commands::workflows::workflow_update,
            commands::workflows::workflow_delete,
            commands::workflows::workflow_duplicate,
            commands::workflows::workflow_reorder,
            commands::workflows::workflow_replace_steps,
            commands::workflows::workflow_save,
            commands::workflows::workflow_run,
            commands::workflows::workflow_pause,
            commands::workflows::workflow_resume,
            commands::workflows::workflow_cancel,
            commands::workflows::workflow_active,
            commands::workflows::workflow_run_detail,
            commands::workflows::workflow_last_run,
            commands::workflows::workflow_last_run_summary,
            commands::workflows::workflow_list_runs,
            // 全局搜索（v0.9，统一只读检索层）
            commands::global_search::global_search,
            // 开发工作台（v48）：项目登记 / git 只读探测 / 交接文档版本 / 敏感扫描 / 验收记录
            commands::dev_workbench::dev_project_list,
            commands::dev_workbench::dev_project_save,
            commands::dev_workbench::dev_project_delete,
            commands::dev_workbench::dev_project_probe,
            commands::dev_workbench::dev_handoff_save,
            commands::dev_workbench::dev_handoff_list,
            commands::dev_workbench::dev_handoff_get,
            commands::dev_workbench::dev_handoff_delete,
            commands::dev_workbench::dev_handoff_secret_scan,
            commands::dev_workbench::dev_acceptance_record_create,
            commands::dev_workbench::dev_acceptance_record_list,
            commands::dev_workbench::dev_acceptance_agent_runs,
            // 项目工作空间（v49）：项目 / 实例 / 通用事项 / 任务关联
            commands::project_workspace::workspace_project_list,
            commands::project_workspace::workspace_project_get,
            commands::project_workspace::workspace_project_progress,
            commands::workspace_resources::workspace_resource_save,
            commands::workspace_resources::workspace_resource_list,
            commands::workspace_resources::workspace_resource_remove,
            commands::project_workspace::workspace_project_save,
            commands::project_workspace::workspace_project_set_status,
            commands::project_workspace::workspace_project_delete,
            commands::project_workspace::workspace_set_active_project,
            commands::project_workspace::workspace_instance_get,
            commands::project_workspace::workspace_instance_save,
            commands::project_workspace::workspace_item_list,
            commands::project_workspace::workspace_item_save,
            commands::project_workspace::workspace_item_delete,
            commands::project_workspace::workspace_task_link_list,
            commands::project_workspace::workspace_task_link_add,
            commands::project_workspace::workspace_task_unlink,
            // 小说卷/章（B1，v58）：两级章节树与正文自动保存
            commands::project_workspace::novel_volume_list,
            commands::project_workspace::novel_volume_save,
            commands::project_workspace::novel_volume_delete,
            commands::project_workspace::novel_chapter_list,
            commands::project_workspace::novel_chapter_get,
            commands::project_workspace::novel_chapter_save,
            commands::project_workspace::novel_chapter_save_content,
            commands::project_workspace::novel_chapter_delete,
            // 小说 B2（v59）：人物档案 / 人物关系 / 世界观设定 / 实体→章节引用
            commands::novel_workspace::novel_character_list,
            commands::novel_workspace::novel_character_get,
            commands::novel_workspace::novel_character_save,
            commands::novel_workspace::novel_character_delete,
            commands::novel_workspace::novel_character_relation_list,
            commands::novel_workspace::novel_character_relation_save,
            commands::novel_workspace::novel_character_relation_delete,
            commands::novel_workspace::novel_worldview_list,
            commands::novel_workspace::novel_worldview_get,
            commands::novel_workspace::novel_worldview_save,
            commands::novel_workspace::novel_worldview_delete,
            commands::novel_workspace::novel_entity_ref_list,
            commands::novel_workspace::novel_entity_ref_add,
            commands::novel_workspace::novel_entity_ref_delete,
            // ── 创作工作台五线（B2/G1/C1/U1/D1，v59–v63，2026-11-16）──────────
            // 五条线只写自己的领域文件（commands/*_workspace.rs）；命令注册点统一在这里，
            // 集成负责人按各线交付清单登记，避免五线并发改 lib.rs。
            // 游戏 G1（v60）：引擎识别 / 资源 / 构建 / 测试
            commands::game_workspace::game_project_detect,
            commands::game_workspace::game_project_facts_get,
            commands::game_workspace::game_project_facts_save,
            commands::game_workspace::game_asset_list,
            commands::game_workspace::game_asset_save,
            commands::game_workspace::game_asset_delete,
            commands::game_workspace::game_build_list,
            commands::game_workspace::game_build_save,
            commands::game_workspace::game_build_delete,
            commands::game_workspace::game_test_list,
            commands::game_workspace::game_test_save,
            commands::game_workspace::game_test_delete,
            // AI 漫剧 C1（v61）：剧集 / 分镜 / 角色 / 场景 / 素材版本
            commands::comic_workspace::comic_episode_list,
            commands::comic_workspace::comic_episode_get,
            commands::comic_workspace::comic_episode_save,
            commands::comic_workspace::comic_episode_delete,
            commands::comic_workspace::comic_episode_reorder,
            commands::comic_workspace::comic_shot_list,
            commands::comic_workspace::comic_shot_get,
            commands::comic_workspace::comic_shot_save,
            commands::comic_workspace::comic_shot_delete,
            commands::comic_workspace::comic_shot_reorder,
            commands::comic_workspace::comic_character_list,
            commands::comic_workspace::comic_character_save,
            commands::comic_workspace::comic_character_delete,
            commands::comic_workspace::comic_scene_list,
            commands::comic_workspace::comic_scene_save,
            commands::comic_workspace::comic_scene_delete,
            commands::comic_workspace::comic_media_list,
            commands::comic_workspace::comic_media_import,
            commands::comic_workspace::comic_media_save,
            commands::comic_workspace::comic_media_adopt,
            commands::comic_workspace::comic_media_delete,
            // 通用 U1（v62）：模板 / 里程碑 / 项目资料 / 真实统计
            commands::general_workspace::general_apply_template,
            commands::general_workspace::general_milestone_list,
            commands::general_workspace::general_milestone_save,
            commands::general_workspace::general_milestone_delete,
            commands::general_workspace::general_material_list,
            commands::general_workspace::general_material_save,
            commands::general_workspace::general_material_delete,
            commands::general_workspace::general_material_open,
            commands::general_workspace::general_stats,
            // 开发 D1（v63）：任务接续 / 构建验收追溯 / Git 风险只读探测
            commands::development_workspace::dws_development_summary,
            commands::development_workspace::dws_task_link_save,
            commands::development_workspace::dws_task_link_list,
            commands::development_workspace::dws_task_link_delete,
            commands::development_workspace::dws_task_handoff,
            commands::development_workspace::dws_build_trace,
            commands::development_workspace::dws_git_risk_probe,
            // 项目工作空间独立窗口（v49）：打开/聚焦、在开发工作台打开（含结果回执）
            project_workspace_window::open_project_workspace_window,
            // 统一工作台（U0）：结构化目标导航（排队 + 拉取 + 回执）
            project_workspace_window::workbench_open_window,
            project_workspace_window::workbench_take_nav,
            project_workspace_window::workbench_nav_ack,
            // 启动揭示：工作台首帧就绪后才显示窗口（手动打开时是 no-op）
            project_workspace_window::workbench_ui_ready,
            // 关闭链路诊断：前端阶段写进终端 tracing（白名单 + 字段清洗）
            project_workspace_window::workbench_close_trace,
            project_workspace_window::project_workspace_open_dev_workbench,
            project_workspace_window::project_workspace_open_dev_workbench_ack,
            // Android 投屏（ADB + scrcpy）：设备/应用枚举、双模式会话托管、窗口定位与截屏
            commands::virtual_display::vd_probe,
            commands::virtual_display::vd_devices,
            commands::virtual_display::vd_list_apps,
            commands::virtual_display::vd_start,
            commands::virtual_display::vd_stop,
            commands::virtual_display::vd_nav,
            commands::virtual_display::vd_sessions,
            commands::virtual_display::vd_focus,
            commands::virtual_display::vd_screenshot,
            commands::virtual_display::vd_screenshot_export,
            commands::virtual_display::vd_diagnostics,
            commands::virtual_display::vd_reconnect,
            // 投屏窗口伴随系统（v0.17）：Session 级控制栏、窗口跟随与品牌身份
            commands::projection_window::vd_session,
            commands::projection_window::vd_toolbar_attach,
            commands::projection_window::vd_toolbar_detach,
            commands::projection_window::vd_toolbar_update,
            commands::projection_window::vd_toolbar_destroy,
            commands::projection_window::vd_toolbar_set_locked,
            commands::projection_window::vd_toolbar_set_expanded,
            commands::projection_window::vd_toolbar_screenshot,
            // 投屏窗口一体化：导航动作统一派发 + 品牌身份回读校验
            commands::projection_window::vd_projection_dispatch,
            commands::projection_window::vd_projection_identity,
            // Agent 共享工作空间（v76）：接入管理 / 活动 / 交接 / 同步 / 权限
            agent_access::commands::agent_access_status,
            agent_access::commands::agent_access_init,
            agent_access::commands::agent_access_manifest,
            agent_access::commands::agent_access_export,
            agent_access::commands::agent_access_scan,
            agent_access::commands::agent_access_sync_status,
            agent_access::commands::agent_access_conflicts,
            agent_access::commands::agent_access_conflict_detail,
            agent_access::commands::agent_access_import_requests,
            agent_access::commands::agent_access_import_approve,
            agent_access::commands::agent_access_import_reject,
            agent_access::commands::agent_access_import_policies,
            agent_access::commands::agent_access_import_policy_set,
            agent_access::commands::agent_access_import_policy_remove,
            agent_access::commands::agent_access_resolve_conflict,
            agent_access::commands::agent_access_activity,
            agent_access::commands::agent_access_handoffs,
            agent_access::commands::agent_access_handoff_detail,
            agent_access::commands::agent_access_handoff_transition,
            agent_access::commands::agent_access_reports,
            agent_access::commands::agent_access_agents,
            agent_access::commands::agent_access_permissions,
            agent_access::commands::agent_access_grant,
            agent_access::commands::agent_access_revoke,
            agent_access::commands::agent_access_context,
            agent_access::commands::agent_access_config_info,
            agent_access::commands::agent_operations_sync,
            agent_access::commands::agent_operations_active,
            agent_access::commands::agent_operations_list,
            // 协作中心（v77）：上下文 / 需求与 Bug / 方案 / 可视化 / 原型 / AI / 审计
            collab::commands::collab_context_get,
            collab::commands::collab_context_overview,
            collab::commands::collab_context_knowledge,
            collab::commands::collab_issue_create,
            collab::commands::collab_issue_update,
            collab::commands::collab_issue_get,
            collab::commands::collab_issue_list,
            collab::commands::collab_issue_archive,
            collab::commands::collab_issue_assign,
            collab::commands::collab_issue_link,
            collab::commands::collab_issue_duplicates,
            collab::commands::collab_issue_resolve,
            collab::commands::collab_issue_verify,
            collab::commands::collab_evidence_attach,
            collab::commands::collab_evidence_attach_text,
            collab::commands::collab_evidence_list,
            collab::commands::collab_plan_create_from_issue,
            collab::commands::collab_plan_update,
            collab::commands::collab_plan_get,
            collab::commands::collab_plan_list,
            collab::commands::collab_plan_submit,
            collab::commands::collab_plan_review,
            collab::commands::collab_plan_link_visual,
            collab::commands::collab_plan_create_tasks,
            collab::commands::collab_plan_tasks,
            collab::commands::collab_plan_progress,
            collab::commands::collab_visual_create,
            collab::commands::collab_visual_update,
            collab::commands::collab_visual_get,
            collab::commands::collab_visual_list,
            collab::commands::collab_visual_delete,
            collab::commands::collab_visual_versions,
            collab::commands::collab_visual_version,
            collab::commands::collab_visual_restore,
            collab::commands::collab_visual_compare,
            collab::commands::collab_visual_export,
            collab::commands::collab_visual_asset_import,
            collab::commands::collab_visual_asset_list,
            collab::commands::collab_visual_asset_archive,
            collab::commands::collab_asset_read,
            collab::commands::collab_renderers,
            collab::commands::collab_prototype_state,
            collab::commands::collab_prototype_dispatch,
            collab::commands::collab_prototype_patch,
            collab::commands::collab_prototype_validate,
            collab::commands::collab_ai_generate,
            collab::commands::collab_ai_image,
            collab::commands::collab_ai_jobs,
            collab::commands::collab_ai_modify,
            collab::commands::collab_ai_cancel,
            collab::commands::collab_ai_notice,
            collab::commands::collab_audit_list,
            // 安全保险箱（P1）：全部命令都要求桌面端 `VaultState`，
            // CLI / MCP / REST 进程不 manage 该状态，因此结构性不可达。
            secure_vault::commands::vault_status,
            secure_vault::commands::vault_create,
            secure_vault::commands::vault_create_confirm_recovery,
            secure_vault::commands::vault_unlock,
            secure_vault::commands::vault_lock,
            secure_vault::commands::vault_touch,
            secure_vault::commands::vault_app_background,
            secure_vault::commands::vault_change_master_password,
            secure_vault::commands::vault_recover_set_password,
            secure_vault::commands::vault_regenerate_recovery_key,
            secure_vault::commands::vault_delete,
            secure_vault::commands::vault_record_list,
            secure_vault::commands::vault_record_get,
            secure_vault::commands::vault_record_create,
            secure_vault::commands::vault_record_update,
            secure_vault::commands::vault_record_delete,
            secure_vault::commands::vault_record_restore,
            secure_vault::commands::vault_record_toggle_favorite,
            secure_vault::commands::vault_record_mark_used,
            secure_vault::commands::vault_search_records,
            secure_vault::commands::vault_category_list,
            secure_vault::commands::vault_category_create,
            secure_vault::commands::vault_category_rename,
            secure_vault::commands::vault_category_delete,
            secure_vault::commands::vault_tag_list,
            secure_vault::commands::vault_tag_create,
            secure_vault::commands::vault_tag_rename,
            secure_vault::commands::vault_tag_delete,
            secure_vault::commands::vault_settings_get,
            secure_vault::commands::vault_settings_set,
            secure_vault::commands::vault_generate_password,
            secure_vault::commands::vault_evaluate_password_strength,
            secure_vault::commands::vault_copy_secret,
            secure_vault::commands::vault_clipboard_clear_now,
            secure_vault::commands::vault_audit_list,
            secure_vault::commands::vault_export_backup,
            secure_vault::commands::vault_backup_inspect,
            secure_vault::commands::vault_backup_import,
        ])
        .build(context)
        .expect("启动 Task Dock 失败")
        .run(|app_handle, event| {
            // 所有退出路径统一走异步排空：托盘、quit_app、窗口关闭/系统退出。
            // 禁止在 UI 主线程同步等待 Tokio future。
            // `ref api`：`ExitRequestApi` 不实现 Copy，按值绑定会 move 掉 event，
            // 后面的 `RunEvent::Exit` 分支就无法再判断（同一回调要处理多个事件）。
            if let tauri::RunEvent::ExitRequested { ref api, .. } = event {
                if !EXIT_READY.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    request_exit(app_handle);
                }
            }
            // 进程真正退出前清空拖入暂存：不留悬空临时文件与 GIT 表项。
            if let tauri::RunEvent::Exit = event {
                if let Some(drag) = app_handle.try_state::<Arc<dragdrop::DragDropState>>() {
                    drag.clear();
                }
                // scrcpy 子进程已加入 Job Object；这里再显式优雅关闭一次，
                // 让虚拟屏在正常退出路径上也由 scrcpy 自行销毁（最多等 1.5s/会话）。
                commands::virtual_display::shutdown_all();
            }
        });
}

// 退出流程防重入：第一次请求触发排空，排空完成后置 READY 再真正退出。
static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
static EXIT_READY: AtomicBool = AtomicBool::new(false);
static EXIT_HANDSHAKE: exit_handshake::ExitHandshake = exit_handshake::ExitHandshake::new();
static NEXT_EXIT_REQUEST_ID: AtomicU64 = AtomicU64::new(0);
const EXIT_HANDSHAKE_TIMEOUT_MS: u64 = 5_000;
const EVENT_APP_BEFORE_EXIT: &str = "app-before-exit";
const EVENT_APP_EXIT_BLOCKED: &str = "app-exit-blocked";

/// 接收工作台前端对退出保存请求的回执；只接受当前请求号与首个回执。
pub fn complete_exit_handshake(request_id: u64, ok: bool) -> bool {
    EXIT_HANDSHAKE.complete(request_id, ok)
}

/// 退出前通知工作台落正文，并在有界时间内等待回执。
///
/// 工作台窗口不存在时立即通过；存在但没有正文模块时前端快速回执 true。
/// 回执 false/超时返回 Err，调用方必须取消本次退出，不能继续 shutdown 管线。
async fn flush_workbench_before_exit(app: &AppHandle) -> Result<(), String> {
    if app
        .get_webview_window(project_workspace_window::WINDOW_LABEL)
        .is_none()
    {
        return Ok(());
    }
    let request_id = NEXT_EXIT_REQUEST_ID.fetch_add(1, Ordering::SeqCst) + 1;
    if !EXIT_HANDSHAKE.begin(request_id) {
        return Err("已有退出保存请求正在处理，请稍后重试".into());
    }
    let payload = serde_json::json!({ "requestId": request_id });
    if let Err(error) = app.emit_to(
        project_workspace_window::WINDOW_LABEL,
        EVENT_APP_BEFORE_EXIT,
        payload,
    ) {
        EXIT_HANDSHAKE.cancel(request_id);
        return Err(format!("无法通知工作台保存正文：{error}"));
    }
    match EXIT_HANDSHAKE
        .wait(
            request_id,
            std::time::Duration::from_millis(EXIT_HANDSHAKE_TIMEOUT_MS),
        )
        .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err("工作台正文保存失败，退出已取消".into()),
        Err(exit_handshake::WaitError::Timeout) => {
            Err("工作台正文保存回执超时（5 秒），退出已取消".into())
        }
    }
}

/// 请求退出：异步排空接入管线（有界时限）后退出。
/// 立即返回，不阻塞调用方（托盘事件循环 / Tauri 命令线程）。
pub fn request_exit(app: &AppHandle) {
    if EXIT_REQUESTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // 独立工作空间窗口不会走主窗口的关闭流程：退出前强制落一次几何。
    project_workspace_window::persist_geometry_on_exit(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 先完成工作台正文保存握手；失败必须取消退出并保持应用可用，
        // 绝不能已经 begin 管线 shutdown 后才发现正文没落下。
        if let Err(reason) = flush_workbench_before_exit(&app).await {
            EXIT_REQUESTED.store(false, Ordering::SeqCst);
            EXIT_READY.store(false, Ordering::SeqCst);
            tracing::warn!(reason, "退出前正文保存未完成，已取消退出");
            let _ = app.emit(
                EVENT_APP_EXIT_BLOCKED,
                serde_json::json!({ "reason": reason }),
            );
            return;
        }
        // 1. 先停接入方（HTTP accept / 文件投递扫描），避免排空期间又有新事件进入。
        agents::shutdown_signal::begin();
        // 捕获窗口可见时先让前端落草稿（最多等 300ms；未显示则立即返回）
        quick_capture::flush_draft_before_exit(&app).await;
        let report = match app.try_state::<Arc<agents::pipeline::IngestPipeline>>() {
            Some(pipeline) => pipeline.shutdown().await,
            None => {
                tracing::warn!("退出时未找到接入管线（可能为无头模式或启动未完成）");
                agents::pipeline::ShutdownReport {
                    lifecycle: "stopped".into(),
                    already_stopped: true,
                    timed_out: false,
                    elapsed_ms: 0,
                    queued_events_at_start: 0,
                    merge_events_at_start: 0,
                    drained_events: 0,
                    events_processed: 0,
                    unfinished_events: 0,
                    spooled_events: 0,
                    spool_files: 0,
                    unsaved_events: 0,
                    spool_error: None,
                    recovery: "管线未启动，无需排空".into(),
                }
            }
        };
        tracing::info!(
            lifecycle = %report.lifecycle,
            timed_out = report.timed_out,
            drained = report.drained_events,
            unfinished = report.unfinished_events,
            spooled = report.spooled_events,
            unsaved = report.unsaved_events,
            elapsed_ms = report.elapsed_ms,
            "接入管线退出排空完成"
        );
        // 剪贴板模块收尾：停监听线程并等待粘贴工作线程结束。
        // 若跳过这一步，进程被杀会留下「永远运行中」的粘贴任务，
        // 以及被残留粘贴内容覆盖的用户剪贴板。
        let clipboard_stopped = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            move || match app.try_state::<Arc<clipboard::ClipboardRuntime>>() {
                Some(rt) => rt.shutdown(std::time::Duration::from_secs(3)),
                None => {
                    tracing::info!("退出时未找到剪贴板运行时（模块未启用或启动未完成）");
                    true
                }
            }
        })
        .await
        .unwrap_or(true);
        tracing::info!("剪贴板退出收尾完成（粘贴线程已停止={clipboard_stopped}）");
        // 保留机器可读的退出证据，供验收与故障复盘
        {
            let dir = app_data_dir(&app);
            let path = dir.join("last-shutdown-report.json");
            match serde_json::to_string_pretty(&report) {
                Ok(json) => {
                    if let Err(e) = std::fs::write(&path, json) {
                        tracing::warn!("写入退出报告失败: {}", e);
                    }
                }
                Err(e) => tracing::warn!("序列化退出报告失败: {}", e),
            }
        }
        let _ = app.emit("app-shutting-down", ());
        // 停止语音输入：关闭听写会话释放麦克风，并结束工作线程（未使用过时立即返回）。
        if let Some(voice) = app.try_state::<Arc<quick_capture::voice::VoiceInput>>() {
            let voice = Arc::clone(&voice);
            let _ = tauri::async_runtime::spawn_blocking(move || voice.shutdown()).await;
        }
        // 停止语音工作线程：设置退出标志取消在途合成，再等待线程结束（毫秒级）。
        if let Some(audio) = app.try_state::<Arc<audio::AudioService>>() {
            let service = Arc::clone(&audio);
            let _ = tauri::async_runtime::spawn_blocking(move || service.shutdown()).await;
        }
        // 退出流程销毁微件窗口时统一标记 app-exit，避免被当成用户主动关闭而改写配置。
        crate::widget_windows::mark_app_exit();
        // 诊断日志最后收尾：刷出队列尾部与聚合摘要，再结束写线程。
        // 失败不影响退出（写线程内部已降级）。
        if let Some(diag) = app.try_state::<Arc<diagnostics::Diagnostics>>() {
            diagnostics::event(
                diagnostics::DiagLevel::Info,
                "system",
                "shutdown",
                "exit",
            )
            .status(diagnostics::DiagStatus::Success)
            .message("应用正常退出")
            .emit();
            diag.shutdown();
        }
        EXIT_READY.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

/// 主窗口「可见但大部分在屏外」（吸附隐藏态）判定。
/// 托盘/快捷键等唤回入口必须据此通知前端吸附引擎安全展开——
/// 仅 show()+set_focus() 无法找回物理位置在屏外的窗口。
fn window_mostly_offscreen<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) -> bool {
    (|| {
        let pos = win.outer_position().ok()?;
        let size = win.outer_size().ok()?;
        let monitors = win.available_monitors().ok()?;
        let rect = commands::settings::WindowRect {
            x: pos.x,
            y: pos.y,
            w: size.width,
            h: size.height,
        };
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
        Some(!commands::settings::is_rect_mostly_visible(&rect, &bounds))
    })()
    .unwrap_or(false)
}

/// 启动就绪超时的结构化诊断事件（纯构造，单测锁定模块/动作/错误码与元数据）。
fn startup_timeout_event(
    elapsed_ms: u64,
    mode: &str,
    w: u32,
    h: u32,
    scale: f64,
) -> diagnostics::DiagnosticEvent {
    diagnostics::event(
        diagnostics::DiagLevel::Warn,
        "window",
        "startup_ready_timeout",
        "timeout",
    )
    .status(diagnostics::DiagStatus::Failed)
    .error_code("UI_BOOT_TIMEOUT")
    .error_category("unknown")
    .duration_ms(elapsed_ms)
    .message(format!(
        "应用启动 {}ms 后前端仍未确认就绪（mode={}，窗口 {}x{}，scale={:.2}），窗口已先恢复可见",
        elapsed_ms, mode, w, h, scale
    ))
    .metadata("mode", serde_json::Value::String(mode.to_string()))
    .metadata(
        "reason",
        serde_json::Value::String("frontend_not_ready".to_string()),
    )
    .build()
}

/// 启动阶段的主窗口显示：窗口始终 show()，但若上次退出是停靠态，先把 Win32
/// 区域裁成 1×1 空白区域——窗口"可见"（定时器不被后台节流）但屏幕上没有
/// 任何主窗口像素，直到前端把容器尺寸 + 贴边位置 + 轨道区域一次做完。
/// 这是「停靠态仍看到主窗口矩形」的启动路径修复：旧实现先露出完整主窗口
/// （实测约 1.9s）再缩成胶囊。
///
/// `notify_ui_ready`（前端就绪）或 `BLANK_REGION_FALLBACK_MS` 兜底会把空白
/// 区域清掉；清掉后由 `apply` 按当前状态重算（停靠 → 轨道，未停靠 → 整窗）。
pub(crate) fn clear_startup_blank<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    let Ok(handle) = win.hwnd() else {
        return false;
    };
    if !window_shape::take_blank(handle.0 as isize) {
        return false;
    }
    window_shape::apply_on_main_thread(&win)
}

/// 唤回窗口：显示 + 还原最小化 + 聚焦。
/// 主窗口不占任务栏（tauri.conf.json main `skipTaskbar=true`），最小化后任务栏
/// 没有入口，所有唤回路径（托盘/热键/第二实例）都必须带 unminimize，
/// 否则最小化的窗口 show() 后仍停留在最小化状态。
pub(crate) fn show_and_focus(win: &tauri::WebviewWindow) {
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    // 吸附隐藏态（物理位置在屏外）：通知前端引擎安全展开，
    // 否则用户按托盘/快捷键后窗口仍然"看不见"。
    if window_mostly_offscreen(win) {
        let _ = win.app_handle().emit("snap-recall", ());
    }
    // 恢复显示后重新校验区域：最小化/隐藏期间系统可能重置窗口区域，
    // 不阻塞托盘菜单线程，直接投递到事件循环。
    let w = win.clone();
    let _ = win.run_on_main_thread(move || {
        let _ = window_shape::apply(&w);
    });
}

pub(crate) fn toggle_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        // 最小化中的窗口 is_visible 仍为 true，必须先判最小化，否则托盘/热键会误执行隐藏
        if win.is_minimized().unwrap_or(false) || !win.is_visible().unwrap_or(false) {
            show_and_focus(&win);
        } else {
            let _ = win.hide();
        }
    }
}

// ── 无头 CLI（--agentctl，供自动化联调）────────────────────

/// 本机数据目录：测试/便携模式（TASK_DOCK_DATA_DIR）下同时隔离数据库、
/// 收件箱、备份与归档，避免验收脚本触碰真实用户数据。
pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Some(dir) = std::env::var_os("TASK_DOCK_DATA_DIR") {
        return std::path::PathBuf::from(dir);
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// 应用数据目录（无头模式下与 Tauri app_data_dir 一致）。
fn headless_data_dir() -> std::path::PathBuf {
    if let Some(dir) = std::env::var_os("TASK_DOCK_DATA_DIR") {
        return std::path::PathBuf::from(dir);
    }
    std::env::var("APPDATA")
        .map(|a| std::path::PathBuf::from(a).join("com.taskdock.desktop"))
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// `task-dock --agentctl <op> [args]`
/// - scan                          四层发现扫描（JSON）
/// - install <adapter>             安装 Hooks/插件（备份+原子写+保留第三方）
/// - verify <adapter>              真实链路验证（Hook 脚本 → ingest → DB）
/// - uninstall <adapter>           可逆卸载
/// - status <adapter>              配置存在性 + 健康状态
/// - events [source]               最近事件流水
/// - post <source> <state>         向本地 ingest 直接上报一次（调试）
/// - backup [quick|full] [path]    备份当前库（full 含全部事件/通知/归档）
/// - restore <备份文件>            恢复分块备份或旧版 JSON（先写完整恢复点，失败自动回滚）
pub fn agentctl(args: &[String]) -> i32 {
    alloc_stats::init_from_env();
    if args.is_empty() {
        eprintln!(
            "用法: task-dock --agentctl <scan|install|verify|uninstall|status|events|post|backup|restore> [参数]"
        );
        return 2;
    }
    let data_dir = headless_data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    let db = match Db::open(&data_dir.join("task-dock.db")) {
        Ok(d) => std::sync::Arc::new(d),
        Err(e) => {
            eprintln!("数据库打开失败: {}", e);
            return 1;
        }
    };
    // 无头命令同样先处理中断的恢复，避免在未完成的恢复上继续操作。
    if let Err(e) = commands::restore::recover_pending(&data_dir, &db) {
        eprintln!("处理中断恢复失败: {}", e);
        return 1;
    }
    let op = args[0].as_str();
    let out = match op {
        "scan" => {
            let r = agents::discovery::scan_all(&db);
            serde_json::to_string_pretty(&r).unwrap_or_default()
        }
        "install" | "verify" | "uninstall" | "status" => {
            let Some(id) = args.get(1) else {
                eprintln!("缺少 adapter id");
                return 2;
            };
            let Some(a) = agents::managed::find_adapter(id) else {
                eprintln!("未知适配器: {}", id);
                return 2;
            };
            let r = match op {
                "install" => a.install(&data_dir, &db),
                "verify" => a.verify(&data_dir, &db),
                "uninstall" => a.uninstall(&data_dir, &db),
                _ => a.config_status(&data_dir),
            };
            match r {
                Ok(v) => {
                    let mut obj = v;
                    if let Some(o) = obj.as_object_mut() {
                        o.insert(
                            "health".into(),
                            agents::managed::source_health(&db, a.source_id()),
                        );
                    }
                    serde_json::to_string_pretty(&obj).unwrap_or_default()
                }
                Err(e) => {
                    eprintln!("{} 失败: {}", op, e);
                    return 1;
                }
            }
        }
        "events" => {
            let limit = args
                .get(1)
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(20);
            let rows = db
                .with_conn(|conn| {
                    let mut stmt = conn.prepare(
                        "SELECT source_id, session_external_id, state, transport, occurred_at, received_at
                         FROM agent_events ORDER BY received_at DESC LIMIT ?1",
                    )?;
                    let rows = stmt.query_map(rusqlite::params![limit], |r| {
                        Ok(serde_json::json!({
                            "source": r.get::<_, String>(0)?,
                            "session": r.get::<_, String>(1)?,
                            "state": r.get::<_, String>(2)?,
                            "transport": r.get::<_, String>(3)?,
                            "occurred_at": r.get::<_, Option<String>>(4)?,
                            "received_at": r.get::<_, String>(5)?,
                        }))
                    })?;
                    rows.collect::<Result<Vec<_>, _>>().map_err(error::AppError::from)
                })
                .unwrap_or_default();
            serde_json::to_string_pretty(&rows).unwrap_or_default()
        }
        "post" => {
            let (source, state) = match (args.get(1), args.get(2)) {
                (Some(s), Some(st)) => (s.clone(), st.clone()),
                _ => {
                    eprintln!("用法: --agentctl post <source> <state>");
                    return 2;
                }
            };
            let settings = db::Settings::load(&db).unwrap_or_else(|e| {
                tracing::warn!("agentctl 读取设置失败，使用默认端口: {}", e);
                Default::default()
            });
            let body = serde_json::json!({
                "source_id": source,
                "session_id": format!("agentctl-{}", uuid::Uuid::new_v4()),
                "state": state,
                "transport": "manual",
            });
            match agents::opencode::reqwest_like_post(
                &format!("http://127.0.0.1:{}/api/v1/events", settings.http_port),
                &settings.http_token,
                &body,
            ) {
                Ok(200) => "posted".to_string(),
                Ok(s) => format!("HTTP {}", s),
                Err(e) => format!("连接失败: {}（Task Dock 是否在运行？）", e),
            }
        }
        "backup" => {
            let kind = match args.get(1).map(|s| s.as_str()).unwrap_or("quick") {
                "full" => commands::backup::BackupKind::Full,
                "quick" => commands::backup::BackupKind::Quick,
                other => {
                    eprintln!("未知备份类型: {}（quick|full）", other);
                    return 2;
                }
            };
            let target = args
                .get(2)
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    data_dir.join("backups").join(format!(
                        "backup-{}-{}.json",
                        chrono::Local::now().format("%Y%m%d-%H%M%S"),
                        kind.as_str()
                    ))
                });
            let archive = agents::retention::archive_dir(&data_dir);
            let clipboard = data_dir.join("clipboard");
            let shelf = data_dir.join("shelf");
            let sources = commands::backup::BackupSources {
                archive_dir: if kind.is_full() {
                    Some(archive.as_path())
                } else {
                    None
                },
                clipboard_dir: Some(clipboard.as_path()),
                shelf_dir: Some(shelf.as_path()),
                data_dir: Some(data_dir.as_path()),
            };
            match commands::backup::write_bundle(&db, sources, &target, kind) {
                Ok(r) => serde_json::to_string_pretty(&serde_json::json!({
                    "path": r.path.to_string_lossy(),
                    "kind": r.kind,
                    "partial": r.partial,
                    "bytes": r.bytes,
                    "sha256": r.sha256,
                    "counts": r.counts,
                    "config_included": r.config_included,
                    "warnings": r.warnings,
                }))
                .unwrap_or_default(),
                Err(e) => {
                    eprintln!("备份失败: {}", e);
                    return 1;
                }
            }
        }
        "restore" => {
            let Some(path) = args.get(1) else {
                eprintln!("用法: --agentctl restore <备份文件>");
                return 2;
            };
            let source = std::path::Path::new(path);
            let result = if commands::backup::is_bundle(source).unwrap_or(false) {
                commands::restore::restore_bundle(
                    &data_dir,
                    &db,
                    source,
                    &commands::restore::RestoreOptions {
                        // 命令行显式恢复允许部分备份，但输出中如实标注 partial。
                        allow_partial: true,
                        ..Default::default()
                    },
                )
                .map(|o| serde_json::to_value(o).unwrap_or_default())
            } else {
                match std::fs::read_to_string(source) {
                    Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
                        .map_err(error::AppError::from)
                        .and_then(|value| {
                            commands::restore::restore_legacy_json(&data_dir, &db, source, &value)
                                .map(|o| serde_json::to_value(o).unwrap_or_default())
                        }),
                    Err(e) => Err(e.into()),
                }
            };
            match result {
                Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
                Err(e) => {
                    eprintln!("恢复失败: {}", e);
                    return 1;
                }
            }
        }
        other => {
            eprintln!("未知操作: {}", other);
            return 2;
        }
    };
    println!("{}", out);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_identity_is_unchanged_without_data_dir_override() {
        assert_eq!(
            instance_identifier_for("com.taskdock.desktop", None),
            "com.taskdock.desktop"
        );
    }

    #[test]
    fn isolated_data_dir_gets_its_own_instance_identity() {
        let a =
            instance_identifier_for("com.taskdock.desktop", Some(std::ffi::OsStr::new("/tmp/a")));
        let b =
            instance_identifier_for("com.taskdock.desktop", Some(std::ffi::OsStr::new("/tmp/b")));
        assert_ne!(a, b, "不同数据目录必须是不同实例身份");
        assert!(a.starts_with("com.taskdock.desktop.iso."));
        assert!(b.starts_with("com.taskdock.desktop.iso."));
        let a2 =
            instance_identifier_for("com.taskdock.desktop", Some(std::ffi::OsStr::new("/tmp/a")));
        assert_eq!(a, a2, "同一数据目录必须得到稳定的实例身份");
    }

    #[test]
    fn isolated_identity_is_case_insensitive_on_windows_paths() {
        let a = instance_identifier_for("x", Some(std::ffi::OsStr::new("C:/Tmp/Ab")));
        let b = instance_identifier_for("x", Some(std::ffi::OsStr::new("c:/tmp/ab")));
        assert_eq!(a, b, "Windows 路径大小写不同不应产生第二个实例身份");
    }

    #[test]
    fn dev_data_dir_lives_under_release_app_data_dir() {
        let dir = dev_data_dir_for(
            "com.taskdock.desktop",
            Some(std::ffi::OsStr::new(r"C:\Users\x\AppData\Roaming")),
        )
        .expect("APPDATA 存在时必须能算出开发目录");
        assert_eq!(
            dir,
            std::path::PathBuf::from(
                r"C:\Users\x\AppData\Roaming\com.taskdock.desktop\dev-instance"
            )
        );
    }

    #[test]
    fn dev_data_dir_requires_appdata() {
        assert!(dev_data_dir_for("com.taskdock.desktop", None).is_none());
        assert!(
            dev_data_dir_for("com.taskdock.desktop", Some(std::ffi::OsStr::new(""))).is_none(),
            "空 APPDATA 不能拼出相对路径"
        );
    }

    #[test]
    fn dev_instance_never_shares_identity_with_release() {
        let release = instance_identifier_for("com.taskdock.desktop", None);
        let dev_dir = dev_data_dir_for(
            "com.taskdock.desktop",
            Some(std::ffi::OsStr::new(r"C:\Users\x\AppData\Roaming")),
        )
        .expect("开发目录");
        let dev = instance_identifier_for("com.taskdock.desktop", Some(dev_dir.as_os_str()));
        assert_ne!(release, dev, "开发版与正式版不能共用单实例身份");
        assert!(dev.starts_with("com.taskdock.desktop.iso."));
    }

    #[test]
    fn startup_timeout_event_is_structured_for_diagnostics_center() {
        let event = startup_timeout_event(10_000, "full", 500, 700, 1.25);
        assert_eq!(event.level, diagnostics::DiagLevel::Warn);
        assert_eq!(event.module, "window");
        assert_eq!(event.action, "startup_ready_timeout");
        assert_eq!(event.event, "timeout");
        assert_eq!(event.error_code.as_deref(), Some("UI_BOOT_TIMEOUT"));
        assert_eq!(event.status, Some(diagnostics::DiagStatus::Failed));
        assert_eq!(event.duration_ms, Some(10_000));
        let message = event.message.as_deref().unwrap_or_default();
        assert!(message.contains("10000ms"), "message 必须带阈值：{message}");
        assert!(message.contains("mode=full"), "message 必须带模式：{message}");
        assert!(message.contains("500x700"), "message 必须带窗口尺寸：{message}");
        let metadata = event.metadata.as_ref().expect("必须有结构化元数据");
        assert_eq!(
            metadata.get("mode").and_then(|v| v.as_str()),
            Some("full")
        );
        assert_eq!(
            metadata.get("reason").and_then(|v| v.as_str()),
            Some("frontend_not_ready")
        );
    }

    #[test]
    fn startup_intent_defaults_to_workbench_for_manual_launch() {
        let args = vec!["task-dock.exe".to_string()];
        assert_eq!(startup_intent_from_args(&args), StartupIntent::Normal);
        assert!(
            startup_opens_workbench(StartupIntent::Normal),
            "手动启动 / npm run tauri dev 必须首屏大型工作台"
        );
        assert!(
            !startup_shows_quick_surface(StartupIntent::Normal, false),
            "普通启动不得先展示旧完整面板"
        );
    }

    #[test]
    fn autostart_and_send_to_do_not_steal_the_workbench_screen() {
        let autostart = vec![
            "task-dock.exe".to_string(),
            "--autostart".to_string(),
        ];
        assert_eq!(
            startup_intent_from_args(&autostart),
            StartupIntent::Autostart
        );
        assert!(
            !startup_opens_workbench(StartupIntent::Autostart),
            "开机自启动不应弹大窗口抢焦点"
        );
        assert!(
            startup_shows_quick_surface(StartupIntent::Autostart, false),
            "自启动仍保留原有快捷面板宿主"
        );

        let send_to = vec![
            "task-dock.exe".to_string(),
            "--send-to-shelf".to_string(),
            "C:\\tmp\\a.txt".to_string(),
        ];
        assert_eq!(startup_intent_from_args(&send_to), StartupIntent::SendTo);
        assert!(!startup_opens_workbench(StartupIntent::SendTo));
        assert!(startup_shows_quick_surface(StartupIntent::SendTo, false));
    }

    #[test]
    fn send_to_wins_over_autostart_when_both_flags_are_present() {
        let args = vec![
            "task-dock.exe".to_string(),
            "--autostart".to_string(),
            "--send-to-shelf".to_string(),
            "C:\\tmp\\b.txt".to_string(),
        ];
        assert_eq!(startup_intent_from_args(&args), StartupIntent::SendTo);
    }

    #[test]
    fn docked_capsule_stays_available_on_manual_startup() {
        assert!(
            startup_shows_quick_surface(StartupIntent::Normal, true),
            "上次停在胶囊态时必须保留快捷入口，而不是只显示工作台"
        );
    }
}
