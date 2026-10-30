//! Task Dock 应用入口：插件装配、窗口/托盘/热键、数据库与 Agent 总线初始化。

pub mod actions;
pub mod agents;
pub mod alloc_stats;
#[global_allocator]
static GLOBAL_ALLOCATOR: alloc_stats::TrackingAllocator = alloc_stats::TrackingAllocator;
pub mod clipboard;
pub mod commands;
pub mod db;
pub mod error;
pub mod navigation;
pub mod nlp;
pub mod recurrence;
pub mod scheduler;
mod window_shape;
mod winproc;
pub mod workspace;

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
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
            "quit" => crate::request_exit(app),
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
    commands::system::set_mode_window_size(&win, settings.mode.as_str());

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
            // 前端保存的是**物理像素**（outerPosition/outerSize），这里必须按物理像素还原：
            // 若按逻辑像素还原，125% 缩放下窗口每次启动都会放大 25%（v0.5 遗留缺陷）。
            let _ = win.set_size(tauri::PhysicalSize::new(rect.w, rect.h));
            let _ = win.set_position(tauri::PhysicalPosition::new(rect.x, rect.y));
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

    // 圆角外形：窗口尺寸/DPI 变化后必须按新的物理像素重算，否则区域会停在
    // 旧尺寸上把内容裁掉（v0.6 视觉重构引入）。
    let win_for_shape = win.clone();
    win.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
        ) {
            window_shape::apply(&win_for_shape);
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

pub fn run() {
    alloc_stats::init_from_env();
    let mut context = tauri::generate_context!();
    let base_identifier = context.config().identifier.clone();
    context.config_mut().identifier = instance_identifier(&base_identifier);
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
            // 测试/便携模式：显式数据目录隔离，避免验收脚本触碰真实用户数据库。
            let data_dir = std::env::var_os("TASK_DOCK_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| handle.path().app_data_dir().expect("无法获取应用数据目录"));
            std::fs::create_dir_all(&data_dir).ok();

            let db = Arc::new(Db::open(&data_dir.join("task-dock.db")).expect("数据库打开失败"));
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
            // 受理序号起点必须高于库内已持久化的最大序号：
            // 时钟回拨/重启后新事件仍严格新于历史，旧事件不会覆盖新状态。
            match db.max_ingest_seq() {
                Ok(max) => agents::bump_ingest_seq(max),
                Err(e) => tracing::warn!("读取受理序号水位失败: {}", e),
            }
            handle.manage(db.clone());
            let settings = db::Settings::load(&db).unwrap_or_default();

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
            } else if clip_config.settings.clipboard_enabled {
                clipboard_rt.start();
            } else {
                tracing::info!("智能剪贴板已停用：不启动监听与后台维护");
            }
            handle.manage(clipboard_rt);

            let hub = Arc::new(AgentHub::new(handle.clone(), db.clone()));
            handle.manage(hub.clone());

            // 窗口恢复（位置/模式/关闭行为）
            restore_window(&handle, &db);

            // 圆角外形按当前视觉预设先落一次（前端加载后会以真实预设再同步一次），
            // 保证窗口第一次显示时四角就是圆角，不会闪一下直角。
            window_shape::set_radius(if settings.visual_preset == "liquid-glass" {
                20.0
            } else {
                18.0
            });
            if let Some(win) = handle.get_webview_window("main") {
                if !window_shape::apply(&win) {
                    tracing::debug!("窗口圆角区域未应用（可能为无 Win32 句柄的早期阶段）");
                }
                // 启动阶段窗口尺寸会连续变化（模式尺寸 → 记忆矩形 → 前端布局稳定），
                // 延迟重算保证区域最终与窗口尺寸一致。
                window_shape::schedule_reapply(&win);
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
            if settings.material == "glass" {
                if let Ok(r) =
                    commands::system::apply_window_material(handle.clone(), "glass".into())
                {
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
            Box::new(agents::file_drop::FileDropAdapter::new(pipeline.clone())).spawn(hub.clone());
            Box::new(agents::http_ingest::HttpIngestAdapter::new(
                pipeline.clone(),
            ))
            .spawn(hub.clone());
            Box::new(agents::mock::MockAdapter::new()).spawn(hub.clone());

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
            commands::settings::clipboard_repair_config,
            commands::settings::save_window_rect,
            commands::settings::get_window_rect,
            // 数据
            commands::data::export_data,
            commands::data::import_data,
            commands::data::inspect_backup,
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
            commands::system::performance_diagnostics,
            commands::system::apply_window_material,
            commands::system::apply_window_radius,
            // 统一导航（v0.4）
            commands::navigation::nav_scan_apps,
            commands::navigation::nav_list_windows,
            commands::navigation::nav_list_targets,
            commands::navigation::nav_save_target,
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
            // 智能剪贴板（v0.5）
            commands::clipboard::clipboard_view,
            commands::clipboard::clipboard_item,
            commands::clipboard::clipboard_group,
            commands::clipboard::clipboard_stats,
            commands::clipboard::clipboard_thumb,
            commands::clipboard::clipboard_image,
            commands::clipboard::clipboard_copy_item,
            commands::clipboard::clipboard_copy_group_rich,
            commands::clipboard::clipboard_copy_group_files,
            commands::clipboard::clipboard_toggle_item,
            commands::clipboard::clipboard_toggle_group,
            commands::clipboard::clipboard_close_group,
            commands::clipboard::clipboard_delete_items,
            commands::clipboard::clipboard_delete_group,
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
            commands::clipboard::clipboard_foreground_target,
            commands::clipboard::clipboard_paste_precheck,
            commands::clipboard::clipboard_paste_group,
            commands::clipboard::clipboard_paste_cancel,
            commands::clipboard::clipboard_paste_resume,
            commands::clipboard::clipboard_paste_job,
            commands::clipboard::clipboard_paste_active,
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
            // 统一任务上下文（v0.5）
            commands::context::task_context,
        ])
        .build(context)
        .expect("启动 Task Dock 失败")
        .run(|app_handle, event| {
            // 所有退出路径统一走异步排空：托盘、quit_app、窗口关闭/系统退出。
            // 禁止在 UI 主线程同步等待 Tokio future。
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !EXIT_READY.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    request_exit(app_handle);
                }
            }
        });
}

// 退出流程防重入：第一次请求触发排空，排空完成后置 READY 再真正退出。
static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
static EXIT_READY: AtomicBool = AtomicBool::new(false);

/// 请求退出：异步排空接入管线（有界时限）后退出。
/// 立即返回，不阻塞调用方（托盘事件循环 / Tauri 命令线程）。
pub fn request_exit(app: &AppHandle) {
    if EXIT_REQUESTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // 1. 先停接入方（HTTP accept / 文件投递扫描），避免排空期间又有新事件进入。
    agents::shutdown_signal::begin();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
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
        EXIT_READY.store(true, Ordering::SeqCst);
        app.exit(0);
    });
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
            let sources = commands::backup::BackupSources {
                archive_dir: if kind.is_full() {
                    Some(archive.as_path())
                } else {
                    None
                },
                clipboard_dir: Some(clipboard.as_path()),
            };
            match commands::backup::write_bundle(&db, sources, &target, kind) {
                Ok(r) => serde_json::to_string_pretty(&serde_json::json!({
                    "path": r.path.to_string_lossy(),
                    "kind": r.kind,
                    "partial": r.partial,
                    "bytes": r.bytes,
                    "sha256": r.sha256,
                    "counts": r.counts,
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
}
