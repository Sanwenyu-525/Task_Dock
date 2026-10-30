//! NavigationRouter：按目标类型执行 L1~L4 动作并按用户偏好降级。
//!
//! L1 打开软件 → L2 唤醒正确窗口 → L3 打开工作区/文件/网页 → L4 恢复 Agent 会话。
//! 每次执行都从数据库读取用户确认过的目标配置并重新校验（安装路径可能已变化）；
//! 无法执行高级动作时按偏好降级并如实标注 fallback，绝不谎报精准定位成功。

use std::time::Duration;

use tauri::AppHandle;

use super::target_resolver::{self, NavTargetRow};
use super::window_manager::{self, FocusOutcome};
use super::{
    NavigationResult, VerificationLevel, ACTION_FOCUS_WINDOW, ACTION_OPEN_APP,
    ACTION_OPEN_DIRECTORY, ACTION_OPEN_FILE, ACTION_OPEN_URL, ACTION_OPEN_WORKSPACE,
    ACTION_RESUME_SESSION, ACTION_REVEAL_FILE,
};
use crate::db::{Db, Settings};
use crate::error::AppError;

#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct NavigateOptions {
    /// 显式动作覆盖：open_app | focus_window | open_url | open_file | reveal_file |
    /// open_directory | resume_session（None = 按目标类型与全局偏好决定）
    pub action: Option<String>,
    /// 本次调用覆盖全局降级偏好
    pub fallback: Option<bool>,
    /// 用户在窗口选择器里明确指定的窗口
    pub window_hwnd: Option<isize>,
    /// 来自任务卡或工作区的关联 ID；后端校验它确实属于本目标。
    pub task_link_id: Option<String>,
}

const LAUNCH_WINDOW_WAIT: Duration = Duration::from_secs(5);

/// 统一导航入口：读取目标 → 重校验 → 执行 → 记日志。
pub fn navigate(
    db: &Db,
    app: &AppHandle,
    target_id: &str,
    options: &NavigateOptions,
) -> NavigationResult {
    if let Some(link_id) = &options.task_link_id {
        if let Err(e) = target_resolver::task_window_config(db, link_id, target_id) {
            return NavigationResult::failure(target_id, "navigate", e.to_string());
        }
    }
    let target = match target_resolver::get_target(db, target_id) {
        Ok(Some(t)) => t,
        Ok(None) => {
            return NavigationResult::failure(
                target_id,
                "navigate",
                format!("目标不存在: {}", target_id),
            )
        }
        Err(e) => return NavigationResult::failure(target_id, "navigate", e.to_string()),
    };
    let settings = Settings::load(db).unwrap_or_default();
    let result = execute_with_ctx(db, app, &target, &settings, options);
    target_resolver::write_log(db, &result, &target.display_name);
    if result.success {
        let _ = target_resolver::bump_use(db, &target.id);
    }
    result
}

/// 类型分发（Db + AppHandle 双上下文）。测试可直接调各分支函数。
pub(crate) fn execute_with_ctx(
    db: &Db,
    app: &AppHandle,
    t: &NavTargetRow,
    settings: &Settings,
    options: &NavigateOptions,
) -> NavigationResult {
    match t.target_type.as_str() {
        "application" => navigate_application(db, t, settings, options),
        "url" => navigate_url(db, t, settings, app, options),
        "file" => navigate_file(t, app, options),
        "directory" => navigate_directory(t),
        "agent_session" => navigate_agent_session(db, t, settings, options),
        other => NavigationResult::failure(&t.id, "navigate", format!("未知目标类型: {}", other)),
    }
}

// ── L1/L2：应用 ─────────────────────────────────────────────

/// UWP/MSIX 启动决策：UWP 窗口无法枚举/唤醒，除显式 open_app 外都只能降级为启动，
/// 且必须尊重 nav_allow_launch——UWP 绝不静默绕过用户「不允许启动」的偏好。
///
/// 语义与 Win32 分支统一（对应验收条款：区分用户明确选择"总是启动"与默认唤醒行为；
/// 无法唤醒时返回明确的失败或降级原因）。
#[derive(Debug, PartialEq)]
pub(crate) enum UwpDecision {
    /// 允许启动。fallback = 本次是否为「唤醒意图降级为启动」；reason 必须如实说明。
    Launch {
        fallback: bool,
        reason: Option<String>,
    },
    /// 拒绝启动（含明确原因，不执行任何进程创建）。
    Refused(String),
}

pub(crate) fn uwp_decision(action: Option<&str>, allow_launch: bool) -> UwpDecision {
    match action {
        // 用户显式选择"总是启动"：直接启动，不算降级
        Some(ACTION_OPEN_APP) => UwpDecision::Launch {
            fallback: false,
            reason: None,
        },
        // 默认行为与显式"唤醒窗口"：UWP 无法定位已有窗口，按偏好降级或明确拒绝
        Some(ACTION_FOCUS_WINDOW) | None => {
            if allow_launch {
                UwpDecision::Launch {
                    fallback: true,
                    reason: Some("UWP 应用无法定位已有窗口，已按设置降级为启动".into()),
                }
            } else {
                UwpDecision::Refused(
                    "UWP 应用无法按窗口唤醒，且当前设置不允许自动启动（可开启「允许启动未运行的程序」，或明确选择启动）"
                        .into(),
                )
            }
        }
        Some(other) => UwpDecision::Refused(format!("UWP 目标不支持动作: {}", other)),
    }
}

/// 生效的窗口记忆：偏好开启时任意记忆都生效；关闭时仅尊重用户显式选择的记忆
/// （用户亲手挑的窗口，绝不允许被"标题最长"冒充）。
pub(crate) fn effective_memory(
    stored: Option<window_manager::WindowMemory>,
    remember_pref: bool,
) -> Option<window_manager::WindowMemory> {
    match remember_pref {
        true => stored,
        false => stored.filter(|m| m.origin == window_manager::MemoryOrigin::User),
    }
}

#[derive(Debug)]
enum WindowChoice<'a> {
    Exact(&'a window_manager::WindowInfo),
    Fallback(&'a window_manager::WindowInfo),
    LaunchFallback,
    Missing,
}

fn choose_window<'a>(
    windows: &'a [window_manager::WindowInfo],
    memory: Option<&window_manager::WindowMemory>,
    fallback: &str,
    hwnd: Option<isize>,
) -> WindowChoice<'a> {
    if let Some(hwnd) = hwnd {
        return windows
            .iter()
            .find(|w| w.hwnd == hwnd)
            .map(WindowChoice::Exact)
            .unwrap_or(WindowChoice::Missing);
    }
    if let Some(m) = memory.filter(|m| m.origin == window_manager::MemoryOrigin::User) {
        if let Some(w) = window_manager::pick_window(windows, Some(m)) {
            return WindowChoice::Exact(w);
        }
        return match fallback {
            "focus_app" => window_manager::pick_window(windows, None)
                .map(WindowChoice::Fallback)
                .unwrap_or(WindowChoice::Missing),
            "launch" => WindowChoice::LaunchFallback,
            _ => WindowChoice::Missing,
        };
    }
    match window_manager::pick_window(windows, memory) {
        Some(w)
            if memory.is_some_and(|m| m.class_name == w.class_name && m.title == w.title)
                || (memory.is_none() && windows.len() == 1) =>
        {
            WindowChoice::Exact(w)
        }
        Some(w) => WindowChoice::Fallback(w),
        None => WindowChoice::Missing,
    }
}

pub(crate) fn navigate_application(
    db: &Db,
    t: &NavTargetRow,
    settings: &Settings,
    options: &NavigateOptions,
) -> NavigationResult {
    let task_config = match options.task_link_id.as_deref() {
        Some(id) => match target_resolver::task_window_config(db, id, &t.id) {
            Ok(config) => Some(config),
            Err(e) => return NavigationResult::failure(&t.id, ACTION_FOCUS_WINDOW, e.to_string()),
        },
        None => None,
    };
    let task_memory = task_config.as_ref().and_then(|c| c.0.clone());
    if task_memory.as_ref().is_some_and(|m| {
        m.origin != window_manager::MemoryOrigin::User
            || m.exe_path.is_empty()
            || !m.exe_path.eq_ignore_ascii_case(&t.exe_path)
    }) {
        return NavigationResult::failure(
            &t.id,
            ACTION_FOCUS_WINDOW,
            "任务窗口身份与应用不一致，请重新选择",
        );
    }
    let remembered = task_memory.or_else(|| {
        effective_memory(
            window_manager::load_memory(db, &t.id),
            settings.nav_remember_window,
        )
    });
    let explicit_memory = remembered
        .as_ref()
        .is_some_and(|m| m.origin == window_manager::MemoryOrigin::User);
    let prefer_focus = options.action.as_deref() != Some(ACTION_OPEN_APP)
        && (options.action.as_deref() == Some(ACTION_FOCUS_WINDOW) || settings.nav_prefer_focus);
    let prefer_focus =
        prefer_focus || (explicit_memory && options.action.as_deref() != Some(ACTION_OPEN_APP));
    let allow_launch =
        settings.nav_allow_launch || options.action.as_deref() == Some(ACTION_OPEN_APP);

    // UWP / MSIX：explorer shell:AppsFolder（无 exe 身份，无窗口可匹配）
    if !t.app_user_model_id.is_empty() {
        if let Err(e) = super::validate_aumid(&t.app_user_model_id) {
            return NavigationResult::failure(&t.id, ACTION_OPEN_APP, e.to_string());
        }
        let explicit_launch = options.action.as_deref() == Some(ACTION_OPEN_APP);
        let requested = if explicit_launch {
            ACTION_OPEN_APP
        } else {
            ACTION_FOCUS_WINDOW
        };
        return match uwp_decision(options.action.as_deref(), allow_launch) {
            UwpDecision::Launch { fallback, reason } => {
                let arg = format!("shell:AppsFolder\\{}", t.app_user_model_id);
                match std::process::Command::new("explorer.exe").arg(&arg).spawn() {
                    Ok(_) => NavigationResult {
                        success: true,
                        requested_action: requested.into(),
                        actual_action: Some(ACTION_OPEN_APP.into()),
                        fallback_used: fallback,
                        target_id: t.id.clone(),
                        reason,
                        verification_level: VerificationLevel::LaunchRequested.as_str().into(),
                    },
                    Err(e) => {
                        NavigationResult::failure(&t.id, requested, format!("启动失败: {}", e))
                    }
                }
            }
            UwpDecision::Refused(r) => NavigationResult::failure(&t.id, requested, r),
        };
    }

    // Win32 应用：执行前重校验（路径可能已因卸载/迁移失效）
    let exe = match super::validate_exe_path(&t.exe_path) {
        Ok(p) => p,
        Err(e) => {
            return NavigationResult::failure(
                &t.id,
                ACTION_FOCUS_WINDOW,
                format!("{}（目标可能已卸载或迁移，请重新扫描并更新关联）", e),
            )
        }
    };

    // 窗口定位：优先用户指定句柄 → exe 身份 → 标题提示
    let mut windows = if explicit_memory || options.window_hwnd.is_some() {
        let expected = exe.to_string_lossy();
        window_manager::top_windows_force()
            .into_iter()
            .filter(|w| {
                w.exe_path
                    .as_deref()
                    .is_some_and(|p| p.eq_ignore_ascii_case(&expected))
            })
            .collect()
    } else {
        window_manager::windows_for_exe(&exe.to_string_lossy())
    };
    if windows.is_empty()
        && !explicit_memory
        && options.window_hwnd.is_none()
        && !t.window_title_hint.is_empty()
    {
        windows = window_manager::windows_for_title(&t.window_title_hint);
    }
    let mut launch_fallback = false;
    if prefer_focus {
        let fallback = task_config
            .as_ref()
            .map(|c| c.1.as_str())
            .unwrap_or("reselect");
        let choice = choose_window(&windows, remembered.as_ref(), fallback, options.window_hwnd);
        let (chosen, used_fallback) = match choice {
            WindowChoice::Exact(w) => (Some(w), false),
            WindowChoice::Fallback(w) => (Some(w), true),
            WindowChoice::LaunchFallback => {
                launch_fallback = true;
                (None, true)
            }
            WindowChoice::Missing if explicit_memory || options.window_hwnd.is_some() => {
                return NavigationResult::failure(
                    &t.id,
                    ACTION_FOCUS_WINDOW,
                    "指定窗口未找到或身份不唯一，请重新选择窗口",
                );
            }
            WindowChoice::Missing => (None, false),
        };
        if let Some(w) = chosen {
            if (explicit_memory || options.window_hwnd.is_some())
                && !window_manager::top_windows_force().iter().any(|current| {
                    current.hwnd == w.hwnd
                        && current.class_name == w.class_name
                        && current.title == w.title
                        && current.exe_path == w.exe_path
                })
            {
                return NavigationResult::failure(
                    &t.id,
                    ACTION_FOCUS_WINDOW,
                    "窗口身份已变化，请重新选择",
                );
            }
            return match window_manager::focus_window(w.hwnd) {
                Ok(FocusOutcome::Confirmed) => {
                    // 只有真正确认置前后才更新记忆：把"没成功的窗口"记下来
                    // 会让下次跳转继续选错。
                    // 用户显式选择的记忆（origin=user）不被自动记忆覆盖降级——
                    // 否则一次成功的定位就把用户亲手挑的窗口身份冲掉了。
                    if settings.nav_remember_window {
                        let _ = window_manager::save_memory(db, &t.id, w);
                    }
                    NavigationResult {
                        success: true,
                        requested_action: ACTION_FOCUS_WINDOW.into(),
                        actual_action: Some(ACTION_FOCUS_WINDOW.into()),
                        fallback_used: used_fallback,
                        target_id: t.id.clone(),
                        reason: used_fallback.then(|| {
                            if explicit_memory {
                                "指定窗口未找到，已降级唤醒该应用的其他窗口"
                            } else {
                                "窗口记忆未精确匹配，已唤醒该应用的一个窗口"
                            }
                            .into()
                        }),
                        verification_level: VerificationLevel::WindowConfirmed.as_str().into(),
                    }
                }
                Ok(FocusOutcome::Unverified) => NavigationResult {
                    success: true,
                    requested_action: ACTION_FOCUS_WINDOW.into(),
                    actual_action: Some(ACTION_FOCUS_WINDOW.into()),
                    fallback_used: used_fallback,
                    target_id: t.id.clone(),
                    reason: Some(
                        if used_fallback {
                            "已降级请求唤醒其他窗口，但未能核实前台状态"
                        } else {
                            "切换已请求，但未能在超时内核实前台状态"
                        }
                        .into(),
                    ),
                    verification_level: "requested-unverified".into(),
                },
                Err(e) => NavigationResult::failure(&t.id, ACTION_FOCUS_WINDOW, e.reason_cn()),
            };
        }
        // 无现有窗口：按偏好决定是否启动
        if !allow_launch && !launch_fallback {
            return NavigationResult::failure(
                &t.id,
                ACTION_FOCUS_WINDOW,
                "应用未运行，且设置不允许自动启动",
            );
        }
    }

    // L1 启动（结构化参数数组，不经过 shell）
    // 参数按 Windows 命令行规则切分：带空格的引号路径保持为一个参数
    let args: Vec<String> = super::split_launch_args(&t.launch_args);
    if args.iter().any(|a| a.chars().any(|c| c.is_control())) {
        return NavigationResult::failure(&t.id, ACTION_OPEN_APP, "启动参数含控制字符，已拒绝执行");
    }
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&args);
    if !t.working_dir.is_empty() && std::path::Path::new(&t.working_dir).is_dir() {
        cmd.current_dir(&t.working_dir);
    }
    let mut result = match cmd.spawn() {
        Ok(_) => {
            // 进程启动 ≠ 窗口出现 ≠ 窗口已置前，三者必须分别如实标注
            let waited =
                window_manager::wait_for_window_by_exe(&exe.to_string_lossy(), LAUNCH_WINDOW_WAIT);
            match waited {
                Some(w) => {
                    let focus = window_manager::focus_window(w.hwnd);
                    match focus {
                        Ok(FocusOutcome::Confirmed) => {
                            if settings.nav_remember_window {
                                let _ = window_manager::save_memory(db, &t.id, &w);
                            }
                            NavigationResult {
                                success: true,
                                requested_action: ACTION_OPEN_APP.into(),
                                actual_action: Some(ACTION_OPEN_APP.into()),
                                fallback_used: false,
                                target_id: t.id.clone(),
                                reason: None,
                                verification_level: VerificationLevel::WindowConfirmed
                                    .as_str()
                                    .into(),
                            }
                        }
                        // 窗口确实出现了，但没能置前：既不能报 window-confirmed，
                        // 也不该报失败——如实给「窗口已出现，未置前」
                        Ok(FocusOutcome::Unverified) => NavigationResult {
                            success: true,
                            requested_action: ACTION_OPEN_APP.into(),
                            actual_action: Some(ACTION_OPEN_APP.into()),
                            fallback_used: false,
                            target_id: t.id.clone(),
                            reason: Some("窗口已出现，但置前未在超时内核实".into()),
                            verification_level: VerificationLevel::WindowVisible.as_str().into(),
                        },
                        Err(e) => NavigationResult {
                            success: true,
                            requested_action: ACTION_OPEN_APP.into(),
                            actual_action: Some(ACTION_OPEN_APP.into()),
                            fallback_used: false,
                            target_id: t.id.clone(),
                            reason: Some(format!("窗口已出现，但未能置前：{}", e.reason_cn())),
                            verification_level: VerificationLevel::WindowVisible.as_str().into(),
                        },
                    }
                }
                None => NavigationResult {
                    success: true,
                    requested_action: ACTION_OPEN_APP.into(),
                    actual_action: Some(ACTION_OPEN_APP.into()),
                    fallback_used: false,
                    target_id: t.id.clone(),
                    reason: Some(
                        "进程已启动，但 5 秒内未检测到可交互窗口（后台/托盘类应用属正常）".into(),
                    ),
                    verification_level: VerificationLevel::ProcessSpawned.as_str().into(),
                },
            }
        }
        Err(e) => NavigationResult::failure(
            &t.id,
            ACTION_OPEN_APP,
            format!("启动失败: {}（{:?}）", e, exe),
        ),
    };
    if launch_fallback && result.success {
        result.requested_action = ACTION_FOCUS_WINDOW.into();
        result.fallback_used = true;
        result.reason = Some(format!(
            "指定窗口未找到，已按任务设置降级启动应用{}",
            result
                .reason
                .as_ref()
                .map(|r| format!("；{}", r))
                .unwrap_or_default()
        ));
    }
    result
}

// ── L3：网址 ────────────────────────────────────────────────

fn navigate_url(
    db: &Db,
    t: &NavTargetRow,
    settings: &Settings,
    app: &AppHandle,
    options: &NavigateOptions,
) -> NavigationResult {
    // 执行时重校验（库中数据可能被篡改）
    if let Err(e) = super::validate_url(&t.url) {
        return NavigationResult::failure(&t.id, ACTION_OPEN_URL, e.to_string());
    }
    let browser_key = settings.nav_default_browser.trim().to_string();
    if !browser_key.is_empty() {
        // 指定浏览器也必须是已存且通过校验的目标（不信任自由字符串拼命令）
        let browser_target = target_resolver::list_targets(db, true)
            .ok()
            .and_then(|list| {
                list.into_iter()
                    .find(|x| x.app_key == browser_key && x.target_type == "application")
            })
            .filter(|x| super::validate_exe_path(&x.exe_path).is_ok());
        if let Some(bt) = browser_target {
            // 浏览器进程以 URL 参数再次启动 = 在既有实例中开新标签（原生行为）
            if std::process::Command::new(&bt.exe_path)
                .arg(t.url.trim())
                .spawn()
                .is_ok()
            {
                return NavigationResult {
                    success: true,
                    requested_action: ACTION_OPEN_URL.into(),
                    actual_action: Some(ACTION_OPEN_URL.into()),
                    fallback_used: false,
                    target_id: t.id.clone(),
                    reason: Some(format!(
                        "已通过 {} 打开（新标签是否置前由浏览器决定）",
                        bt.display_name
                    )),
                    verification_level: VerificationLevel::ProcessSpawned.as_str().into(),
                };
            }
            if !options.fallback.unwrap_or(settings.nav_fallback) {
                return NavigationResult::failure(&t.id, ACTION_OPEN_URL, "指定的浏览器启动失败");
            }
        }
    }
    // 系统默认浏览器（委托，无法核实结果，如实标注）
    use tauri_plugin_opener::OpenerExt;
    match app.opener().open_url(t.url.trim(), None::<&str>) {
        Ok(()) => NavigationResult {
            success: true,
            requested_action: ACTION_OPEN_URL.into(),
            actual_action: Some(ACTION_OPEN_URL.into()),
            fallback_used: !browser_key.is_empty(),
            target_id: t.id.clone(),
            reason: (!browser_key.is_empty())
                .then(|| "指定的浏览器不可用，已回退系统默认浏览器".into()),
            verification_level: VerificationLevel::Delegated.as_str().into(),
        },
        Err(e) => NavigationResult::failure(&t.id, ACTION_OPEN_URL, format!("打开网址失败: {}", e)),
    }
}

// ── L3：文件与目录 ──────────────────────────────────────────

fn navigate_file(t: &NavTargetRow, app: &AppHandle, options: &NavigateOptions) -> NavigationResult {
    if options.action.as_deref() == Some(ACTION_REVEAL_FILE) {
        return reveal_in_explorer(t);
    }
    let p = match super::validate_local_path(&t.path) {
        Ok(p) => p,
        Err(e) => return NavigationResult::failure(&t.id, ACTION_OPEN_FILE, e.to_string()),
    };
    use tauri_plugin_opener::OpenerExt;
    match app
        .opener()
        .open_path(p.to_string_lossy().as_ref(), None::<&str>)
    {
        Ok(()) => NavigationResult {
            success: true,
            requested_action: ACTION_OPEN_FILE.into(),
            actual_action: Some(ACTION_OPEN_FILE.into()),
            fallback_used: false,
            target_id: t.id.clone(),
            reason: Some("已交给系统文件关联程序打开".into()),
            verification_level: VerificationLevel::Delegated.as_str().into(),
        },
        Err(e) => {
            NavigationResult::failure(&t.id, ACTION_OPEN_FILE, format!("打开文件失败: {}", e))
        }
    }
}

fn reveal_in_explorer(t: &NavTargetRow) -> NavigationResult {
    let p = match super::validate_local_path(&t.path) {
        Ok(p) => p,
        Err(e) => return NavigationResult::failure(&t.id, ACTION_REVEAL_FILE, e.to_string()),
    };
    let arg = format!("/select,{}", p.display());
    match std::process::Command::new("explorer.exe").arg(&arg).spawn() {
        Ok(_) => NavigationResult {
            success: true,
            requested_action: ACTION_REVEAL_FILE.into(),
            actual_action: Some(ACTION_REVEAL_FILE.into()),
            fallback_used: false,
            target_id: t.id.clone(),
            reason: None,
            verification_level: VerificationLevel::Delegated.as_str().into(),
        },
        Err(e) => NavigationResult::failure(
            &t.id,
            ACTION_REVEAL_FILE,
            format!("资源管理器启动失败: {}", e),
        ),
    }
}

fn navigate_directory(t: &NavTargetRow) -> NavigationResult {
    let p = match super::validate_local_path(&t.path) {
        Ok(p) => p,
        Err(e) => return NavigationResult::failure(&t.id, ACTION_OPEN_DIRECTORY, e.to_string()),
    };
    match std::process::Command::new("explorer.exe").arg(&p).spawn() {
        Ok(_) => NavigationResult {
            success: true,
            requested_action: ACTION_OPEN_DIRECTORY.into(),
            actual_action: Some(ACTION_OPEN_DIRECTORY.into()),
            fallback_used: false,
            target_id: t.id.clone(),
            reason: None,
            verification_level: VerificationLevel::Delegated.as_str().into(),
        },
        Err(e) => NavigationResult::failure(
            &t.id,
            ACTION_OPEN_DIRECTORY,
            format!("资源管理器启动失败: {}", e),
        ),
    }
}

// ── L4：Agent 会话 ──────────────────────────────────────────

fn navigate_agent_session(
    db: &Db,
    t: &NavTargetRow,
    settings: &Settings,
    options: &NavigateOptions,
) -> NavigationResult {
    // L3：该会话所在的工作区目录（仅 IDE 类 Agent 有接口）。
    // 目录来自用户确认过的目标配置（working_dir），执行前仍要求真实存在。
    if options.action.as_deref() == Some(ACTION_OPEN_WORKSPACE) {
        let dir = if !t.working_dir.trim().is_empty() {
            t.working_dir.trim()
        } else {
            t.path.trim()
        };
        if dir.is_empty() {
            return NavigationResult::failure(
                &t.id,
                ACTION_OPEN_WORKSPACE,
                "该 Agent 会话目标未登记工作区目录",
            );
        }
        let mut r = super::agent_navigation::open_workspace(&t.agent_source_id, dir);
        r.target_id = t.id.clone();
        return r;
    }
    // 会话行必须仍存在于本地观测库（防外部伪造 ID）
    let exists: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2",
                rusqlite::params![t.agent_source_id, t.agent_session_id],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap_or(0);
    if exists == 0 {
        let fallback = options.fallback.unwrap_or(settings.nav_fallback);
        if fallback {
            let f =
                super::agent_navigation::focus_agent(&t.agent_source_id, settings.nav_allow_launch);
            if f.success {
                let mut r = f;
                r.target_id = t.id.clone();
                r.requested_action = ACTION_RESUME_SESSION.into();
                r.fallback_used = true;
                r.reason = Some("该会话已不存在（可能被宿主清理），降级为应用级唤醒".into());
                return r;
            }
        }
        return NavigationResult::failure(
            &t.id,
            ACTION_RESUME_SESSION,
            "该会话已不存在（可能被宿主清理）",
        );
    }
    let mut r =
        super::agent_navigation::resume_session(db, &t.agent_source_id, &t.agent_session_id);
    // agent_navigation 以 source:id 作为 target_id；统一回写目标行 ID 供日志关联
    r.target_id = t.id.clone();
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    // ── 测试进程安全（P1：绝不误伤用户进程）────────────────────
    //
    // 旧实现「测试前后窗口快照差集 + taskkill」有竞态：测试期间用户自己打开的
    // 记事本也会被算作"新窗口"而遭强杀。现策略：
    // - 每个测试只启动**自己的**子进程并持有 Child 句柄（RAII 守卫）；
    // - 清理仅按「父 PID == 我们子进程 PID 且镜像名匹配 notepad.exe」归属
    //   （覆盖 Win11 notepad 存根把真实记事本作为子进程拉起的形态）；
    // - 无法归属的进程一律不碰（宁可跳过清理，绝不猜测）；
    // - Drop 保证断言失败/panic 时同样清理；并发测试各杀各的子进程树。

    /// 测试专属子进程守卫：Drop 时清理自己拉起的进程树。
    struct OwnedProc(std::process::Child);

    impl Drop for OwnedProc {
        fn drop(&mut self) {
            #[cfg(windows)]
            kill_owned_descendants(self.0.id());
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// 终止「父进程 == parent_pid 且镜像名为 notepad.exe」的直接子进程。
    /// 只按 PID 精确清理自证归属的进程；找不到就什么都不杀。
    #[cfg(windows)]
    fn kill_owned_descendants(parent_pid: u32) {
        use std::mem::zeroed;

        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        const NOTEPAD: &str = "notepad.exe";
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap as usize == usize::MAX {
                return;
            }
            let mut entry: PROCESSENTRY32W = zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    let exe = String::from_utf16_lossy(
                        &entry.szExeFile
                            [..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0)],
                    )
                    .to_ascii_lowercase();
                    if entry.th32ParentProcessID == parent_pid && exe == NOTEPAD {
                        let _ = std::process::Command::new("taskkill")
                            .args(["/PID", &entry.th32ProcessID.to_string(), "/F"])
                            .output();
                    }
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            windows_sys::Win32::Foundation::CloseHandle(snap);
        }
    }

    /// 轮询等待「属于本测试子进程树」的记事本窗口出现；超时返回 None。
    ///
    /// Win11 实测形态：System32\notepad.exe 是存根，立即退出并把打包版
    /// Notepad.exe（WindowsApps）作为子进程拉起，父 PID 关系保留。
    /// 因此必须在**全量顶层窗口**里按 PID 归属（窗口进程的 exe 路径不是
    /// C:\Windows\notepad.exe，按 exe 过滤会漏掉真实窗口）。
    #[cfg(windows)]
    fn wait_for_owned_window(
        child_pid: u32,
        timeout: std::time::Duration,
    ) -> Option<window_manager::WindowInfo> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let wins = window_manager::top_windows_force();
            // 直接形态：窗口就属于我们 spawn 的进程
            if let Some(w) = wins.iter().find(|w| w.pid == child_pid) {
                return Some(w.clone());
            }
            // Win11 存根形态：真实记事本是子进程（父 == child_pid）
            let owned = owned_descendant_pids(child_pid);
            if let Some(w) = wins.iter().find(|w| owned.contains(&w.pid)) {
                return Some(w.clone());
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    /// 列出父 PID == parent_pid 且镜像名为 notepad.exe 的子进程 PID（不杀，只查询）。
    #[cfg(windows)]
    fn owned_descendant_pids(parent_pid: u32) -> std::collections::HashSet<u32> {
        use std::mem::zeroed;

        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        let mut out = std::collections::HashSet::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap as usize == usize::MAX {
                return out;
            }
            let mut entry: PROCESSENTRY32W = zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    let exe = String::from_utf16_lossy(
                        &entry.szExeFile
                            [..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0)],
                    )
                    .to_ascii_lowercase();
                    if entry.th32ParentProcessID == parent_pid && exe == "notepad.exe" {
                        out.insert(entry.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            windows_sys::Win32::Foundation::CloseHandle(snap);
        }
        out
    }

    /// 列出机器上**所有**记事本进程 PID（不限父进程），用于如实判定 Win11
    /// 「单实例多标签」形态：已有别人的记事本时，我们的 spawn 只会在它的进程里
    /// 开标签，父 PID 归属随之失效——这是环境前提，不是产品缺陷。
    #[cfg(windows)]
    fn all_notepad_pids() -> Vec<u32> {
        use std::mem::zeroed;

        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap as usize == usize::MAX {
                return out;
            }
            let mut entry: PROCESSENTRY32W = zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    let exe = String::from_utf16_lossy(
                        &entry.szExeFile
                            [..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0)],
                    )
                    .to_ascii_lowercase();
                    if exe == "notepad.exe" {
                        out.push(entry.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            windows_sys::Win32::Foundation::CloseHandle(snap);
        }
        out
    }

    /// 不做任何过滤的原始顶层窗口枚举（按 PID 归属）。
    /// 用来把两件事分开：系统里**确实没有**这个窗口（环境形态）vs
    /// 窗口在但我们的枚举看不到（产品缺陷，必须让测试变红）。
    #[cfg(windows)]
    struct RawEnumCtx {
        wanted: Vec<u32>,
        found: Vec<isize>,
    }

    #[cfg(windows)]
    fn raw_windows_of_pids(pids: &[u32]) -> Vec<isize> {
        use windows_sys::Win32::Foundation::{HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};

        unsafe extern "system" fn proc(hwnd: HWND, lparam: LPARAM) -> i32 {
            let ctx = &mut *(lparam as *mut RawEnumCtx);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if ctx.wanted.contains(&pid) {
                ctx.found.push(hwnd as isize);
            }
            1
        }

        let mut ctx = RawEnumCtx {
            wanted: pids.to_vec(),
            found: Vec::new(),
        };
        unsafe {
            EnumWindows(Some(proc), &mut ctx as *mut RawEnumCtx as LPARAM);
        }
        ctx.found
    }

    /// 真实桌面前提不成立时**如实登记**（不是把「跳过」粉饰成「通过」）：
    /// 验收文档按 `ENVIRONMENT-BLOCKED` 标记逐条统计并给出复跑条件。
    #[cfg(windows)]
    fn env_blocked(test: &str, reason: &str) {
        eprintln!("ENVIRONMENT-BLOCKED [{test}] {reason}");
    }

    /// 「等不到归属自己子进程的记事本窗口」的如实归因：
    /// - 系统里存在属于我们子进程的窗口，但产品枚举看不到 → 产品缺陷（panic，必须红）；
    /// - 别的记事本实例已存在（Win11 单实例多标签，我们的 spawn 不产生自己的进程）
    ///   或子进程根本没建窗口 → 环境前提不成立，明确标记阻塞。
    #[cfg(windows)]
    fn missing_owned_window_verdict(test: &str, child_pid: u32) {
        let descendants = owned_descendant_pids(child_pid);
        let mut own_pids: Vec<u32> = descendants.clone().into_iter().collect();
        own_pids.push(child_pid);
        let raw = raw_windows_of_pids(&own_pids);
        if !raw.is_empty() {
            panic!(
                "产品缺陷：进程 {own_pids:?} 在系统里有顶层窗口 {raw:?}，但 top_windows_force 枚举不到它"
            );
        }
        let ours: std::collections::HashSet<u32> = own_pids.iter().copied().collect();
        let foreign: Vec<u32> = all_notepad_pids()
            .into_iter()
            .filter(|p| !ours.contains(p))
            .collect();
        if !foreign.is_empty() {
            env_blocked(
                test,
                &format!(
                    "Win11 记事本单实例多标签：已存在他人记事本进程 {foreign:?}，本次 spawn 不会拥有窗口归属\
                     （需在无其他记事本的交互桌面复跑；绝不拿用户窗口凑数）"
                ),
            );
        } else {
            env_blocked(
                test,
                &format!(
                    "子进程 {} 10 秒内未创建任何记事本窗口（桌面受限或静默启动形态）",
                    child_pid
                ),
            );
        }
    }

    /// 本测试进程直接拉起的记事本 PID（证明「已有窗口→只唤醒，不再启动进程」）。
    #[cfg(windows)]
    fn own_notepad_children() -> std::collections::HashSet<u32> {
        owned_descendant_pids(std::process::id())
    }

    // ── 自有窗口夹具（P2-06：不依赖第三方应用形态的真实桌面覆盖）────────
    //
    // Win11 打包版记事本是单实例多标签：用户开着自己的记事本时，测试 spawn 只会
    // 在**它的**进程里开标签，父 PID 归属失效 → 真实「枚举 + 置前」链路无法覆盖。
    // 因此再准备一个属于本测试进程自己的顶层窗口（放在屏幕外，不打扰用户），
    // 确定性地覆盖「窗口枚举看得到 → 焦点结果与事实一致」。

    #[cfg(windows)]
    struct OwnWindow {
        hwnd: isize,
        pump: Option<std::thread::JoinHandle<()>>,
    }

    #[cfg(windows)]
    impl Drop for OwnWindow {
        fn drop(&mut self) {
            use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
            unsafe {
                PostMessageW(self.hwnd as _, WM_CLOSE, 0, 0);
            }
            if let Some(p) = self.pump.take() {
                let _ = p.join();
            }
        }
    }

    #[cfg(windows)]
    unsafe extern "system" fn own_wnd_proc(
        hwnd: windows_sys::Win32::Foundation::HWND,
        msg: u32,
        wparam: windows_sys::Win32::Foundation::WPARAM,
        lparam: windows_sys::Win32::Foundation::LPARAM,
    ) -> windows_sys::Win32::Foundation::LRESULT {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            DefWindowProcW, PostQuitMessage, WM_DESTROY,
        };
        if msg == WM_DESTROY {
            PostQuitMessage(0);
            return 0;
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// 打开属于本测试进程的真实可见窗口（屏幕外 32000 像素，用户看不到）。
    /// 建不出来（无窗口站/桌面不可交互）返回 None，由调用方如实登记环境阻塞。
    #[cfg(windows)]
    fn open_own_window() -> Option<OwnWindow> {
        use std::mem::zeroed;
        use std::sync::mpsc;

        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, GetMessageW, RegisterClassExW,
            TranslateMessage, CW_USEDEFAULT, MSG, WNDCLASSEXW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        };

        let (tx, rx) = mpsc::channel::<Option<isize>>();
        let title = format!("TaskDock 焦点自检 {}", std::process::id());
        let pump = std::thread::spawn(move || unsafe {
            let class: Vec<u16> = "TaskDockOwnFixtureWnd\0".encode_utf16().collect();
            let name: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
            let hinst = GetModuleHandleW(std::ptr::null());
            let mut wc: WNDCLASSEXW = zeroed();
            wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
            wc.lpfnWndProc = Some(own_wnd_proc);
            wc.hInstance = hinst;
            wc.lpszClassName = class.as_ptr();
            if RegisterClassExW(&wc) == 0 {
                let _ = tx.send(None);
                return;
            }
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                name.as_ptr(),
                WS_VISIBLE | WS_OVERLAPPEDWINDOW,
                -32_000,
                -32_000,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinst,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                let _ = tx.send(None);
                return;
            }
            let _ = tx.send(Some(hwnd as isize));
            let mut msg: MSG = zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            DestroyWindow(hwnd);
        });
        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Some(hwnd)) => Some(OwnWindow {
                hwnd,
                pump: Some(pump),
            }),
            _ => {
                let _ = pump.join();
                None
            }
        }
    }

    /// 记事本测试互斥锁：Win11 打包版记事本是「单进程多标签」形态——
    /// 已有实例存在时，再次 spawn 会在既有进程里开新标签而不产生新进程，
    /// 父 PID 归属随之失效。串行化让每个测试的 spawn 都从干净状态开始，
    /// 归属（父 == 本测试子进程 PID）始终可靠。
    #[cfg(windows)]
    static NOTEPAD_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 拉起测试专属记事本；失败返回 None（连自己的子进程都拉不起来是环境受限，
    /// 绝不拿用户已打开的窗口凑数）。
    #[cfg(windows)]
    fn spawn_owned_notepad() -> Option<OwnedProc> {
        match std::process::Command::new("C:\\Windows\\notepad.exe").spawn() {
            Ok(c) => Some(OwnedProc(c)),
            Err(e) => {
                eprintln!("ENVIRONMENT-PRECHECK: 无法拉起测试专属记事本进程: {e}");
                None
            }
        }
    }

    #[test]
    fn application_target_with_gone_exe_fails_not_fake() {
        let d = db();
        d.with_conn(|c| {
            c.execute(
                "INSERT INTO navigation_targets (id, display_name, target_type, app_key, exe_path, launch_args, working_dir, app_user_model_id, url, path, agent_source_id, agent_session_id, window_title_hint, icon, category, favorite, hidden, use_count, created_at, updated_at)
                 VALUES ('gone', '已卸载应用', 'application', 'c:\\gone\\app.exe', 'C:\\Gone\\App.exe', '', '', '', '', '', '', '', '', '', '', 0, 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let t = target_resolver::get_target(&d, "gone").unwrap().unwrap();
        let r = navigate_application(&d, &t, &Settings::default(), &NavigateOptions::default());
        assert!(!r.success, "exe 消失后不得假装跳转成功");
        assert!(r.reason.unwrap().contains("卸载或迁移"));
    }

    #[test]
    fn url_revalidated_at_execution_time() {
        let d = db();
        let t = target_resolver::save_target(
            &d,
            &target_resolver::TargetInput {
                target_type: "url".into(),
                display_name: "OK".into(),
                url: "https://ok.example.com".into(),
                ..Default::default()
            },
        )
        .unwrap();
        // 保存后改库注入危险 URL：执行时必须再次校验拒绝
        d.with_conn(|c| {
            c.execute(
                "UPDATE navigation_targets SET url = 'javascript:alert(1)' WHERE id = ?1",
                rusqlite::params![t.id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let t2 = target_resolver::get_target(&d, &t.id).unwrap().unwrap();
        assert!(
            super::super::validate_url(&t2.url).is_err(),
            "执行时校验必须拦住篡改"
        );
    }

    #[cfg(windows)]
    #[test]
    fn notepad_launch_focuses_existing_window_of_owned_process() {
        // 真机测试：只针对**本测试自己拉起的**记事本进程，绝不触碰用户已打开的窗口。
        // 契约分两层：
        //  A. 与 OS 前台资格无关、任何时候都必须成立——已有自己的窗口时决策必须是
        //     focus_window、不得再启动新进程、失败原因必须如实（不得谎报成功）。
        //  B. 真正把窗口带到前台，需要本进程此刻具备设置前台的资格；被系统前台锁定
        //     拒绝时如实登记 ENVIRONMENT-BLOCKED，不删断言、不伪造焦点成功。
        let test = "notepad_launch_focuses_existing_window_of_owned_process";
        let _lock = NOTEPAD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(guard) = spawn_owned_notepad() else {
            env_blocked(
                test,
                "连本测试自己的记事本子进程都无法拉起（会话/桌面受限）",
            );
            return;
        };
        let child_pid = guard.0.id();
        let Some(own) = wait_for_owned_window(child_pid, std::time::Duration::from_secs(10)) else {
            missing_owned_window_verdict(test, child_pid);
            return;
        };
        // 目标身份用窗口进程的真实 exe（与「从当前窗口选择」的落库行为一致）。
        // Win11 打包版记事本的窗口进程是 WindowsApps\...\Notepad.exe，
        // 用 C:\Windows\notepad.exe 存根路径按 exe 匹配不到窗口（属真实世界形态）。
        let Some(exe) = own.exe_path.clone() else {
            eprintln!("跳过：无法解析测试窗口所属进程 exe");
            return;
        };
        let d = db();
        let t = target_resolver::save_target(
            &d,
            &target_resolver::TargetInput {
                target_type: "application".into(),
                display_name: "记事本(测试)".into(),
                exe_path: exe.clone(),
                ..Default::default()
            },
        )
        .unwrap();
        // 用户显式指定自己的窗口（HWND 仅本次调用即时使用）
        let opts = NavigateOptions {
            window_hwnd: Some(own.hwnd),
            ..Default::default()
        };
        let before_children = own_notepad_children();
        let r = navigate_application(&d, &t, &Settings::default(), &opts);
        let spawned: Vec<u32> = own_notepad_children()
            .difference(&before_children)
            .copied()
            .collect();
        assert!(
            spawned.is_empty(),
            "已存在自己的窗口时不得再启动记事本进程（新增 PID: {spawned:?}）"
        );
        assert_eq!(
            r.actual_action.as_deref(),
            Some("focus_window"),
            "已存在窗口时必须走唤醒而不是启动（实际: {:?}）",
            r.actual_action
        );
        if r.success {
            assert!(
                r.verification_level == "window-confirmed"
                    || r.verification_level == "requested-unverified",
                "唤醒的验证级别必须如实（实际: {}）",
                r.verification_level
            );
        } else {
            let reason = r.reason.clone().unwrap_or_default();
            assert_eq!(
                reason,
                window_manager::FocusError::ForegroundDenied.reason_cn(),
                "唤醒失败只能是因为系统拒绝置前，其他原因说明实现有缺陷（实际: {reason}）"
            );
            env_blocked(
                test,
                "Windows 前台锁定拒绝置前（本测试进程此刻不具备前台资格）；\
                 同一 focus 实现在真实交互桌面上的成功证据见 P1-03 图文粘贴验收",
            );
        }
        // 清理由 OwnedProc::Drop 完成：只杀自己子进程树（父==child_pid 且镜像名匹配）
    }

    #[cfg(windows)]
    #[test]
    fn launch_disallowed_reports_failure_or_focus_only() {
        // 用自己的记事本保证「窗口存在 → 只允许唤醒」分支可确定性覆盖；
        // 前提不成立时如实登记环境阻塞，不依赖用户恰好开着的窗口。
        let test = "launch_disallowed_reports_failure_or_focus_only";
        let _lock = NOTEPAD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(guard) = spawn_owned_notepad() else {
            env_blocked(
                test,
                "连本测试自己的记事本子进程都无法拉起（会话/桌面受限）",
            );
            return;
        };
        let child_pid = guard.0.id();
        let Some(own) = wait_for_owned_window(child_pid, std::time::Duration::from_secs(10)) else {
            missing_owned_window_verdict(test, child_pid);
            return;
        };
        let Some(exe) = own.exe_path.clone() else {
            env_blocked(test, "无法解析测试窗口所属进程的 exe（权限受限）");
            return;
        };
        let d = db();
        let t = target_resolver::save_target(
            &d,
            &target_resolver::TargetInput {
                target_type: "application".into(),
                display_name: "记事本(禁启测试)".into(),
                exe_path: exe,
                ..Default::default()
            },
        )
        .unwrap();
        let settings = Settings {
            nav_allow_launch: false,
            ..Default::default()
        };
        // 窗口存在（本测试自己的）→ 只允许唤醒；绝不产生新进程
        let opts = NavigateOptions {
            window_hwnd: Some(own.hwnd),
            ..Default::default()
        };
        let before_children = own_notepad_children();
        let r = navigate_application(&d, &t, &settings, &opts);
        let spawned: Vec<u32> = own_notepad_children()
            .difference(&before_children)
            .copied()
            .collect();
        assert!(
            spawned.is_empty(),
            "禁止启动时更不能借唤醒之名启动新进程（新增 PID: {spawned:?}）"
        );
        assert_eq!(
            r.actual_action.as_deref(),
            Some("focus_window"),
            "窗口已存在时必须是唤醒（实际: {:?}）",
            r.actual_action
        );
        if !r.success {
            let reason = r.reason.clone().unwrap_or_default();
            assert_eq!(
                reason,
                window_manager::FocusError::ForegroundDenied.reason_cn(),
                "失败只能源于系统拒绝置前，其他原因说明实现有缺陷（实际: {reason}）"
            );
            env_blocked(
                test,
                "Windows 前台锁定拒绝置前（本测试进程不具备前台资格）；\
                 「窗口存在→只唤醒不启动」的决策契约与不新增进程均已断言通过",
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn own_process_window_is_enumerated_and_focus_reported_truthfully() {
        // 真实桌面上的确定性覆盖：窗口属于本测试进程自己，不依赖记事本的单实例形态。
        // 断言分三层，全部与 OS 是否授予前台资格无关：
        //  1) 产品窗口枚举必须看到刚创建的可见顶层窗口（看不到 = 真实缺陷）；
        //  2) focus 的结果必须与「此刻真正的前台句柄」一致（报 Confirmed 就必须是前台）；
        //  3) 路由器面对已存在的自己的窗口必须决策为 focus_window。
        let test = "own_process_window_is_enumerated_and_focus_reported_truthfully";
        let Some(win) = open_own_window() else {
            env_blocked(test, "本测试进程无法创建顶层窗口（窗口站/桌面不可交互）");
            return;
        };
        let info = window_manager::top_windows_force()
            .into_iter()
            .find(|w| w.hwnd == win.hwnd);
        let Some(info) = info else {
            panic!(
                "产品缺陷：top_windows_force 看不到本进程刚创建的可见顶层窗口 hwnd={}",
                win.hwnd
            );
        };
        let outcome = window_manager::focus_window(win.hwnd);
        let now_fg =
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() } as isize;
        let focus_report = match outcome {
            Ok(FocusOutcome::Confirmed) => {
                assert_eq!(
                    now_fg, win.hwnd,
                    "报告已确认置前，前台句柄就必须是它（实际前台 {now_fg}）"
                );
                "confirmed"
            }
            Ok(FocusOutcome::Unverified) => {
                // 诚实回报：请求已发出但未能核实；不强判成功，也不当成失败掩盖
                "unverified"
            }
            Err(e) => {
                assert_eq!(
                    e.reason_cn(),
                    window_manager::FocusError::ForegroundDenied.reason_cn(),
                    "自有窗口的焦点失败只能源于系统拒绝置前（实际: {}）",
                    e.reason_cn()
                );
                env_blocked(
                    test,
                    "Windows 前台锁定拒绝置前（本测试进程不具备前台资格，需在交互会话前台复跑）",
                );
                "foreground-denied"
            }
        };
        eprintln!(
            "REAL-DESKTOP [{test}] hwnd={} 已被产品窗口枚举看到；focus_window 回报={focus_report}",
            win.hwnd
        );
        let d = db();
        let Some(exe) = info.exe_path.clone() else {
            env_blocked(
                test,
                "无法解析本测试进程 exe 路径（权限受限），不覆盖路由器分支",
            );
            return;
        };
        let t = target_resolver::save_target(
            &d,
            &target_resolver::TargetInput {
                target_type: "application".into(),
                display_name: "自有窗口(测试)".into(),
                exe_path: exe,
                ..Default::default()
            },
        )
        .unwrap();
        let r = navigate_application(
            &d,
            &t,
            &Settings::default(),
            &NavigateOptions {
                window_hwnd: Some(win.hwnd),
                ..Default::default()
            },
        );
        assert_eq!(
            r.actual_action.as_deref(),
            Some("focus_window"),
            "自己的窗口已存在时必须决策为唤醒（原因: {:?}）",
            r.reason
        );
        // 路由器自己会再点一次前台：成功口径必须与「那一刻的真实前台句柄」对齐，
        // 这比与本次直接调用的结果比对更可靠（前台资格是逐步授予的）。
        let fg_after_router =
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() } as isize;
        if r.success {
            if r.verification_level == "window-confirmed" {
                assert_eq!(
                    fg_after_router, win.hwnd,
                    "路由器声称已确认置前，前台句柄就必须是它（实际前台 {fg_after_router} != {}",
                    win.hwnd
                );
            } else {
                assert_eq!(
                    r.verification_level, "requested-unverified",
                    "成功但未确认时只能如实标注 requested-unverified（实际 {}）",
                    r.verification_level
                );
            }
        } else {
            assert_eq!(
                r.reason.as_deref(),
                Some(window_manager::FocusError::ForegroundDenied.reason_cn()),
                "自有窗口的唤醒失败只能是因为系统拒绝置前（实际 {:?}）",
                r.reason
            );
        }
        eprintln!(
            "REAL-DESKTOP [{test}] 路由器决策={} success={} verification_level={}",
            r.actual_action.as_deref().unwrap_or("-"),
            r.success,
            r.verification_level
        );
    }

    #[test]
    fn effective_memory_honors_user_pick_even_when_remember_disabled() {
        let auto = window_manager::WindowMemory {
            class_name: "Chrome_WidgetWin_1".into(),
            title: "自动记忆".into(),
            exe_path: String::new(),
            origin: window_manager::MemoryOrigin::Auto,
        };
        let user = window_manager::WindowMemory {
            class_name: "Chrome_WidgetWin_1".into(),
            title: "用户挑的窗口".into(),
            exe_path: String::new(),
            origin: window_manager::MemoryOrigin::User,
        };
        // 偏好开启：任意记忆生效
        assert!(effective_memory(Some(auto.clone()), true).is_some());
        // 偏好关闭：自动记忆停用，但用户显式选择必须生效（不被"标题最长"冒充）
        assert!(effective_memory(Some(auto), false).is_none());
        assert_eq!(effective_memory(Some(user.clone()), false).unwrap(), user);
        assert!(effective_memory(None, true).is_none());
    }

    #[test]
    fn explicit_window_selection_requires_unique_identity_and_marks_fallback() {
        use window_manager::{MemoryOrigin, WindowInfo, WindowMemory};
        let win = |hwnd, title: &str| WindowInfo {
            hwnd,
            pid: 10,
            title: title.into(),
            class_name: "Class".into(),
            is_minimized: false,
            exe_path: Some("c:\\app.exe".into()),
        };
        let memory = WindowMemory {
            title: "项目 A".into(),
            class_name: "Class".into(),
            exe_path: "C:\\APP.EXE".into(),
            origin: MemoryOrigin::User,
        };
        let windows = vec![win(1, "项目 A"), win(2, "项目 B")];
        assert!(
            matches!(choose_window(&windows, Some(&memory), "reselect", None), WindowChoice::Exact(w) if w.hwnd == 1)
        );
        let restarted = vec![win(3, "项目 A"), win(4, "项目 B")];
        assert!(
            matches!(choose_window(&restarted, Some(&memory), "reselect", None), WindowChoice::Exact(w) if w.hwnd == 3)
        );
        let changed = vec![win(3, "项目 A - 新标题"), win(4, "项目 B")];
        assert!(matches!(
            choose_window(&changed, Some(&memory), "reselect", None),
            WindowChoice::Missing
        ));
        assert!(matches!(
            choose_window(&changed, Some(&memory), "focus_app", None),
            WindowChoice::Fallback(_)
        ));
        assert!(matches!(
            choose_window(&changed, Some(&memory), "launch", None),
            WindowChoice::LaunchFallback
        ));
        assert!(matches!(
            choose_window(
                &[win(1, "项目 A"), win(2, "项目 A")],
                Some(&memory),
                "reselect",
                None
            ),
            WindowChoice::Missing
        ));
        assert!(matches!(
            choose_window(&windows, Some(&memory), "reselect", Some(999)),
            WindowChoice::Missing
        ));
    }

    #[test]
    fn uwp_decision_respects_launch_preference() {
        use super::UwpDecision;
        // 显式"总是启动"：直接启动，不算降级
        assert_eq!(
            uwp_decision(Some(ACTION_OPEN_APP), false),
            UwpDecision::Launch {
                fallback: false,
                reason: None
            }
        );
        // 默认行为 + 允许启动：降级启动并如实说明
        match uwp_decision(None, true) {
            UwpDecision::Launch { fallback, reason } => {
                assert!(fallback, "默认唤醒意图降级必须标记 fallback");
                assert!(reason.is_some(), "降级必须携带原因");
            }
            other => panic!("应为 Launch，实际: {:?}", other),
        }
        // 默认行为 + 禁止启动：明确拒绝，绝不静默绕过偏好
        match uwp_decision(None, false) {
            UwpDecision::Refused(r) => assert!(r.contains("不允许"), "拒绝原因要明确: {}", r),
            other => panic!("应为 Refused，实际: {:?}", other),
        }
        // 显式"唤醒窗口" + 禁止启动：同样拒绝（UWP 无法唤醒）
        match uwp_decision(Some(ACTION_FOCUS_WINDOW), false) {
            UwpDecision::Refused(r) => assert!(r.contains("不允许")),
            other => panic!("应为 Refused，实际: {:?}", other),
        }
        // 未知动作拒绝
        assert!(matches!(
            uwp_decision(Some("evil"), true),
            UwpDecision::Refused(_)
        ));
    }

    #[test]
    fn uwp_target_refused_before_any_process_spawn_when_launch_disallowed() {
        // 带合法 AUMID 的目标 + 禁止启动：决策在 spawn 之前拒绝，不产生任何进程
        let d = db();
        d.with_conn(|c| {
            c.execute(
                "INSERT INTO navigation_targets (id, display_name, target_type, app_key, exe_path, launch_args, working_dir, app_user_model_id, url, path, agent_source_id, agent_session_id, window_title_hint, icon, category, favorite, hidden, use_count, created_at, updated_at)
                 VALUES ('uwp1','计算器','application','uwp:calc','','','','Test.App_8wekyb3d8bbwe!App','','','','','','','uwp',0,0,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let t = target_resolver::get_target(&d, "uwp1").unwrap().unwrap();
        let settings = Settings {
            nav_allow_launch: false,
            ..Default::default()
        };
        let r = navigate_application(&d, &t, &settings, &NavigateOptions::default());
        assert!(!r.success, "禁止启动时 UWP 默认行为必须失败而非启动");
        assert!(r.reason.unwrap().contains("不允许"));
        assert_eq!(r.requested_action, ACTION_FOCUS_WINDOW, "默认语义是唤醒");
        // 显式 open_app 越过偏好（用户明确选择"总是启动"）——只测决策语义，不真启动：
        let explicit = uwp_decision(Some(ACTION_OPEN_APP), false);
        assert!(matches!(
            explicit,
            super::UwpDecision::Launch {
                fallback: false,
                ..
            }
        ));
    }

    #[test]
    fn agent_session_target_requires_existing_session() {
        let d = db();
        d.with_conn(|c| {
            c.execute(
                "INSERT INTO navigation_targets (id, display_name, target_type, app_key, exe_path, launch_args, working_dir, app_user_model_id, url, path, agent_source_id, agent_session_id, window_title_hint, icon, category, favorite, hidden, use_count, created_at, updated_at)
                 VALUES ('s1', 'Codex 会话', 'agent_session', 'codex:old', '', '', '', '', '', '', 'codex', 'old-session', '', '', '', 0, 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let t = target_resolver::get_target(&d, "s1").unwrap().unwrap();
        // 会话在本地不存在 → 失败（禁降级时）
        let opts = NavigateOptions {
            fallback: Some(false),
            ..Default::default()
        };
        let r = navigate_agent_session(&d, &t, &Settings::default(), &opts);
        assert!(!r.success);
        assert!(r.reason.unwrap().contains("不存在"));
    }
}
