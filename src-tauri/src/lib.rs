//! Task Dock 应用入口：插件装配、窗口/托盘/热键、数据库与 Agent 总线初始化。

pub mod agents;
pub mod commands;
pub mod db;
pub mod error;
pub mod nlp;
pub mod recurrence;
pub mod scheduler;

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};

use crate::error::AppError;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use agents::{AgentAdapter, AgentHub, AgentState};
use db::Db;

static TRAY: OnceLock<TrayIcon> = OnceLock::new();
static TRAY_STATE: AtomicU8 = AtomicU8::new(255);

// ── 托盘 ────────────────────────────────────────────────────

fn tray_icon_bytes(state: AgentState) -> &'static [u8] {
    match state {
        AgentState::Running => include_bytes!("../icons/status/running.png"),
        AgentState::Waiting => include_bytes!("../icons/status/waiting.png"),
        AgentState::Completed => include_bytes!("../icons/status/done.png"),
        AgentState::Failed => include_bytes!("../icons/status/failed.png"),
        AgentState::Disconnected => include_bytes!("../icons/status/idle.png"),
        AgentState::Idle => include_bytes!("../icons/tray.png"),
    }
}

fn tray_tooltip(db: &Db) -> String {
    let pending: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE status = 'pending'",
                [],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap_or(0);
    let running: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE status = 'running'",
                [],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap_or(0);
    let waiting: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE status = 'waiting'",
                [],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap_or(0);
    let next: Option<String> = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT MIN(remind_at) FROM task_reminders WHERE fired = 0",
                [],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap_or(None);
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
        if TRAY_STATE.swap(p, Ordering::Relaxed) != p {
            if let Ok(img) = tauri::image::Image::from_bytes(tray_icon_bytes(state)) {
                let _ = tray.set_icon(Some(img));
            }
        }
        if let Some(db) = app.try_state::<Arc<Db>>() {
            let tooltip = tray_tooltip(&db);
            let _ = tray.set_tooltip(Some(&tooltip));
        }
    }
}

fn setup_tray(app: &App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "显示 / 隐藏", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick_add", "快速添加任务", true, None::<&str>)?;
    let m_min = MenuItem::with_id(app, "mode_min", "极简模式", true, None::<&str>)?;
    let m_compact = MenuItem::with_id(app, "mode_compact", "紧凑模式", true, None::<&str>)?;
    let m_full = MenuItem::with_id(app, "mode_full", "完整模式", true, None::<&str>)?;
    let theme_light = MenuItem::with_id(app, "theme_light", "浅色主题", true, None::<&str>)?;
    let theme_dark = MenuItem::with_id(app, "theme_dark", "深色主题", true, None::<&str>)?;
    let theme_system = MenuItem::with_id(app, "theme_system", "跟随系统", true, None::<&str>)?;
    let autostart = MenuItem::with_id(app, "autostart", "开机自启动", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &quick,
            &sep1,
            &m_min,
            &m_compact,
            &m_full,
            &sep2,
            &theme_light,
            &theme_dark,
            &theme_system,
            &autostart,
            &sep3,
            &quit,
        ],
    )?;

    let tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Task Dock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_main(app),
            "quick_add" => {
                if let Some(win) = app.get_webview_window("main") {
                    show_and_focus(&win);
                }
                let _ = app.emit("focus-quick-add", ());
            }
            "mode_min" | "mode_compact" | "mode_full" => {
                let mode = event.id.as_ref().replace("mode_", "");
                if let Some(db) = app.try_state::<Arc<Db>>() {
                    let _ = commands::system::apply_mode_inner(app, &db, &mode);
                }
                let _ = app.emit("mode-changed", mode);
            }
            "theme_light" | "theme_dark" | "theme_system" => {
                let theme = event.id.as_ref().replace("theme_", "");
                if let Some(db) = app.try_state::<Arc<Db>>() {
                    let _ = db.set_setting("theme", serde_json::json!(theme));
                }
                let _ = app.emit("theme-changed", theme);
            }
            "autostart" => {
                if let Some(db) = app.try_state::<Arc<Db>>() {
                    let current = db
                        .get_setting("autostart")
                        .ok()
                        .flatten()
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let _ = commands::system::set_autostart_inner(app, &db, !current);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                toggle_main(app);
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
    let settings = db::Settings::load(db).unwrap_or_default();
    commands::system::set_mode_window_size(&win, &settings.mode.as_str());

    // 记忆位置（越界则用默认位置）
    if let Some(rect) = db
        .get_setting("window_rect")
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value::<commands::settings::WindowRect>(v).ok())
    {
        let on_screen = win
            .available_monitors()
            .map(|monitors| {
                monitors.iter().any(|m| {
                    let pos = m.position();
                    let size = m.size();
                    let scale = m.scale_factor();
                    rect.x as f64 >= pos.x as f64 / scale - 80.0
                        && (rect.x as f64) < (pos.x as f64 + size.width as f64 / scale)
                        && rect.y as f64 >= pos.y as f64 / scale - 80.0
                        && (rect.y as f64) < (pos.y as f64 + size.height as f64 / scale)
                })
            })
            .unwrap_or(false);
        if on_screen {
            let _ = win.set_size(tauri::LogicalSize::new(rect.w as f64, rect.h as f64));
            let _ = win.set_position(tauri::LogicalPosition::new(rect.x as f64, rect.y as f64));
        }
    }

    // 关闭 = 隐藏到托盘（Tauri v2 事件回调为单参数）
    let win_for_close = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = win_for_close.hide();
        }
    });
}

// ── 入口 ────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        // 单实例保护必须最先注册：插件按注册顺序初始化，
        // 第二实例要在其余插件 init 与 setup（建库、绑 47821 端口、注册托盘）之前就被拦下并退出。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tracing::info!("检测到重复启动，已把焦点交给现有实例");
            if let Some(win) = app.get_webview_window("main") {
                show_and_focus(&win);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let hotkey_on = app
                        .try_state::<Arc<Db>>()
                        .map(|db| {
                            db::Settings::load(&db)
                                .map(|s| s.hotkey_enabled)
                                .unwrap_or(true)
                        })
                        .unwrap_or(true);
                    if !hotkey_on {
                        return;
                    }
                    if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyT) {
                        toggle_main(app);
                    } else if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space) {
                        if let Some(win) = app.get_webview_window("main") {
                            show_and_focus(&win);
                        }
                        let _ = app.emit("focus-quick-add", ());
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 日志（默认 info；RUST_LOG 可覆盖）
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                )
                .init();

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
            let data_dir = handle
                .path()
                .app_data_dir()
                .expect("无法获取应用数据目录");
            std::fs::create_dir_all(&data_dir).ok();

            let db = Arc::new(Db::open(&data_dir.join("task-dock.db")).expect("数据库打开失败"));
            handle.manage(db.clone());

            let hub = Arc::new(AgentHub::new(handle.clone(), db.clone()));
            handle.manage(hub.clone());

            // 窗口恢复（位置/模式/关闭行为）
            restore_window(&handle, &db);

            let settings = db::Settings::load(&db).unwrap_or_default();

            // 窗口材质（毛玻璃）：在显示窗口之前应用，避免透明闪烁；
            // 失败自动回退 solid（前端 load 时会再次确认实际状态）
            if settings.material == "glass" {
                if let Ok(r) = commands::system::apply_window_material(handle.clone(), "glass".into()) {
                    if !r.applied {
                        tracing::info!("系统不支持毛玻璃材质，已回退 solid（{}）", r.os_version);
                    }
                }
            }

            // 预检已通过（或为正式版），此时才显示窗口
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.show();
            }

            // 开机自启动（按设置应用）
            if settings.autostart {
                use tauri_plugin_autostart::ManagerExt;
                let _ = handle.autolaunch().enable();
            }

            // 全局热键
            if settings.hotkey_enabled {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let gs = handle.global_shortcut();
                let _ = gs.register("Ctrl+Alt+T".parse::<Shortcut>().unwrap());
                let _ = gs.register("Ctrl+Shift+Space".parse::<Shortcut>().unwrap());
            }

            // 托盘
            setup_tray(app).expect("托盘初始化失败");
            refresh_tray(&handle, AgentState::Idle);

            // Agent 适配器
            Box::new(agents::file_drop::FileDropAdapter::new()).spawn(hub.clone());
            Box::new(agents::http_ingest::HttpIngestAdapter::new()).spawn(hub.clone());
            Box::new(agents::mock::MockAdapter::new()).spawn(hub.clone());

            // 异常重启恢复：重启前遗留的活跃轮次按失联规则归位
            if let Err(e) = hub.recover_after_restart() {
                tracing::warn!("重启恢复失败: {}", e);
            }

            // 提醒调度引擎
            scheduler::start_scheduler(handle.clone(), db.clone(), hub.clone());

            // 自动备份（超过 24 小时）
            {
                let db2 = db.clone();
                let _ = commands::data::auto_backup_if_needed_inner(&handle, &db2);
            }

            tracing::info!("Task Dock 启动完成（数据目录: {:?}）", data_dir);
            let _ = handle.emit("app-ready", ());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 任务
            commands::tasks::list_tasks,
            commands::tasks::task_stats,
            commands::tasks::create_task,
            commands::tasks::update_task,
            commands::tasks::toggle_task,
            commands::tasks::delete_task,
            commands::tasks::parse_quick_add,
            commands::tasks::create_from_quick_add,
            commands::tasks::snooze_reminder,
            commands::tasks::link_task_agent,
            commands::tasks::unlink_task_agent,
            commands::tasks::list_task_links,
            commands::tasks::pending_items_to_tasks,
            // Agent
            commands::agents::agent_snapshot,
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
            commands::agents::list_notifications,
            commands::agents::mark_notification_read,
            commands::agents::mark_all_notifications_read,
            commands::agents::clear_notifications,
            commands::agents::list_agent_events,
            // 设置
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::save_window_rect,
            commands::settings::get_window_rect,
            // 数据
            commands::data::export_data,
            commands::data::import_data,
            commands::data::backup_now,
            commands::data::list_backups,
            commands::data::auto_backup_if_needed,
            // 系统
            commands::system::quit_app,
            commands::system::set_autostart,
            commands::system::apply_mode,
            commands::system::set_hotkeys_enabled,
            commands::system::get_agent_inbox_dir,
            commands::system::show_main_window,
            commands::system::save_snap_state,
            commands::system::get_snap_state,
            commands::system::hub_health,
            commands::system::apply_window_material,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Task Dock 失败");
}

/// 唤回窗口：显示 + 还原最小化 + 聚焦。
/// skipTaskbar 窗口最小化后任务栏没有入口，所有唤回路径都必须带 unminimize，
/// 否则最小化的窗口 show() 后仍停留在最小化状态。
fn show_and_focus(win: &tauri::WebviewWindow) {
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

fn toggle_main(app: &AppHandle) {
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

/// 应用数据目录（无头模式下与 Tauri app_data_dir 一致）。
fn headless_data_dir() -> std::path::PathBuf {
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
pub fn agentctl(args: &[String]) -> i32 {
    if args.is_empty() {
        eprintln!("用法: task-dock --agentctl <scan|install|verify|uninstall|status|events|post> [参数]");
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
                "uninstall" => a.uninstall(&data_dir),
                _ => a.config_status(&data_dir),
            };
            match r {
                Ok(v) => {
                    let mut obj = v;
                    if let Some(o) = obj.as_object_mut() {
                        o.insert("health".into(), agents::managed::source_health(&db, a.id()));
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
            let limit = args.get(1).and_then(|v| v.parse::<i64>().ok()).unwrap_or(20);
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
            let settings = db::Settings::load(&db).unwrap_or_default();
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
        other => {
            eprintln!("未知操作: {}", other);
            return 2;
        }
    };
    println!("{}", out);
    0
}
