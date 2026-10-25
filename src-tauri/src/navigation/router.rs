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
    NavigationResult, VerificationLevel, ACTION_FOCUS_WINDOW, ACTION_OPEN_APP, ACTION_OPEN_DIRECTORY,
    ACTION_OPEN_FILE, ACTION_OPEN_URL, ACTION_REVEAL_FILE, ACTION_RESUME_SESSION,
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
}

const LAUNCH_WINDOW_WAIT: Duration = Duration::from_secs(5);

/// 统一导航入口：读取目标 → 重校验 → 执行 → 记日志。
pub fn navigate(
    db: &Db,
    app: &AppHandle,
    target_id: &str,
    options: &NavigateOptions,
) -> NavigationResult {
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
        "application" => navigate_application(t, settings, options),
        "url" => navigate_url(db, t, settings, app, options),
        "file" => navigate_file(t, app, options),
        "directory" => navigate_directory(t),
        "agent_session" => navigate_agent_session(db, t, settings, options),
        other => NavigationResult::failure(&t.id, "navigate", format!("未知目标类型: {}", other)),
    }
}

// ── L1/L2：应用 ─────────────────────────────────────────────

pub(crate) fn navigate_application(
    t: &NavTargetRow,
    settings: &Settings,
    options: &NavigateOptions,
) -> NavigationResult {
    let prefer_focus = options.action.as_deref() != Some(ACTION_OPEN_APP)
        && (options.action.as_deref() == Some(ACTION_FOCUS_WINDOW) || settings.nav_prefer_focus);
    let allow_launch =
        settings.nav_allow_launch || options.action.as_deref() == Some(ACTION_OPEN_APP);

    // UWP / MSIX：explorer shell:AppsFolder（无 exe 身份，无窗口可匹配）
    if !t.app_user_model_id.is_empty() {
        if let Err(e) = super::validate_aumid(&t.app_user_model_id) {
            return NavigationResult::failure(&t.id, ACTION_OPEN_APP, e.to_string());
        }
        let arg = format!("shell:AppsFolder\\{}", t.app_user_model_id);
        return match std::process::Command::new("explorer.exe").arg(&arg).spawn() {
            Ok(_) => NavigationResult {
                success: true,
                requested_action: ACTION_OPEN_APP.into(),
                actual_action: Some(ACTION_OPEN_APP.into()),
                fallback_used: false,
                target_id: t.id.clone(),
                reason: Some("已提交启动请求（UWP 应用窗口由系统按需创建）".into()),
                verification_level: VerificationLevel::LaunchRequested.as_str().into(),
            },
            Err(e) => NavigationResult::failure(&t.id, ACTION_OPEN_APP, format!("启动失败: {}", e)),
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
    let mut windows = window_manager::windows_for_exe(&exe.to_string_lossy());
    if windows.is_empty() && !t.window_title_hint.is_empty() {
        windows = window_manager::windows_for_title(&t.window_title_hint);
    }
    if let Some(picked) = options.window_hwnd.filter(|_| !windows.is_empty()) {
        if let Some(w) = windows.iter().find(|w| w.hwnd == picked) {
            windows = vec![w.clone()];
        }
    }

    if prefer_focus {
        if let Some(w) = windows.iter().max_by_key(|w| w.title.chars().count()) {
            return match window_manager::focus_window(w.hwnd) {
                Ok(FocusOutcome::Confirmed) => {
                    let multi = windows.len() > 1;
                    NavigationResult {
                        success: true,
                        requested_action: ACTION_FOCUS_WINDOW.into(),
                        actual_action: Some(ACTION_FOCUS_WINDOW.into()),
                        fallback_used: multi,
                        target_id: t.id.clone(),
                        reason: multi.then(|| {
                            format!(
                                "该应用有 {} 个窗口，已唤醒其一；可在窗口选择器中指定目标窗口",
                                windows.len()
                            )
                        }),
                        verification_level: VerificationLevel::WindowConfirmed.as_str().into(),
                    }
                }
                Ok(FocusOutcome::Unverified) => NavigationResult {
                    success: true,
                    requested_action: ACTION_FOCUS_WINDOW.into(),
                    actual_action: Some(ACTION_FOCUS_WINDOW.into()),
                    fallback_used: false,
                    target_id: t.id.clone(),
                    reason: Some("切换已请求，但未能在超时内核实前台状态".into()),
                    verification_level: "requested-unverified".into(),
                },
                Err(e) => {
                    NavigationResult::failure(&t.id, ACTION_FOCUS_WINDOW, e.reason_cn())
                }
            };
        }
        // 无现有窗口：按偏好决定是否启动
        if !allow_launch {
            return NavigationResult::failure(
                &t.id,
                ACTION_FOCUS_WINDOW,
                "应用未运行，且设置不允许自动启动",
            );
        }
    }

    // L1 启动（结构化参数数组，不经过 shell）
    let args: Vec<String> = if t.launch_args.trim().is_empty() {
        Vec::new()
    } else {
        t.launch_args
            .split_whitespace()
            .map(|s| s.trim_matches('"').to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&args);
    if !t.working_dir.is_empty() && std::path::Path::new(&t.working_dir).is_dir() {
        cmd.current_dir(&t.working_dir);
    }
    match cmd.spawn() {
        Ok(_) => {
            // 进程启动 ≠ 窗口出现：短等确认窗口（不阻塞过久）
            let waited =
                window_manager::wait_for_window_by_exe(&exe.to_string_lossy(), LAUNCH_WINDOW_WAIT);
            match waited {
                Some(w) => {
                    // 新窗口通常自带前台；仅在未置前时补一次切换
                    let _ = window_manager::focus_window(w.hwnd);
                    NavigationResult {
                        success: true,
                        requested_action: ACTION_OPEN_APP.into(),
                        actual_action: Some(ACTION_OPEN_APP.into()),
                        fallback_used: false,
                        target_id: t.id.clone(),
                        reason: None,
                        verification_level: VerificationLevel::WindowConfirmed.as_str().into(),
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
    }
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
                list.into_iter().find(|x| {
                    x.app_key == browser_key && x.target_type == "application"
                })
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
                return NavigationResult::failure(
                    &t.id,
                    ACTION_OPEN_URL,
                    "指定的浏览器启动失败",
                );
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
    match app.opener().open_path(p.to_string_lossy().as_ref(), None::<&str>) {
        Ok(()) => NavigationResult {
            success: true,
            requested_action: ACTION_OPEN_FILE.into(),
            actual_action: Some(ACTION_OPEN_FILE.into()),
            fallback_used: false,
            target_id: t.id.clone(),
            reason: Some("已交给系统文件关联程序打开".into()),
            verification_level: VerificationLevel::Delegated.as_str().into(),
        },
        Err(e) => NavigationResult::failure(&t.id, ACTION_OPEN_FILE, format!("打开文件失败: {}", e)),
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
        Err(e) => {
            NavigationResult::failure(&t.id, ACTION_REVEAL_FILE, format!("资源管理器启动失败: {}", e))
        }
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
        Err(e) => {
            NavigationResult::failure(&t.id, ACTION_OPEN_DIRECTORY, format!("资源管理器启动失败: {}", e))
        }
    }
}

// ── L4：Agent 会话 ──────────────────────────────────────────

fn navigate_agent_session(
    db: &Db,
    t: &NavTargetRow,
    settings: &Settings,
    options: &NavigateOptions,
) -> NavigationResult {
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
            let f = super::agent_navigation::focus_agent(
                &t.agent_source_id,
                settings.nav_allow_launch,
            );
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
    let mut r = super::agent_navigation::resume_session(db, &t.agent_source_id, &t.agent_session_id);
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
        let r = navigate_application(&t, &Settings::default(), &NavigateOptions::default());
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
        assert!(super::super::validate_url(&t2.url).is_err(), "执行时校验必须拦住篡改");
    }

    #[cfg(windows)]
    #[test]
    fn notepad_launch_prefers_focus_then_launches() {
        // 真机测试：notepad.exe 存在于所有 Windows；
        // 已运行 → 唤醒；未运行 → 启动并等待窗口（验证级别必须如实）
        let d = db();
        let t = target_resolver::save_target(
            &d,
            &target_resolver::TargetInput {
                target_type: "application".into(),
                display_name: "记事本(测试)".into(),
                exe_path: "C:\\Windows\\notepad.exe".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let r = navigate_application(&t, &Settings::default(), &NavigateOptions::default());
        assert!(r.success, "notepad 应可启动/唤醒: {:?}", r.reason);
        assert!(
            r.verification_level == "window-confirmed" || r.verification_level == "process-spawned",
            "验证级别必须如实（实际: {}）",
            r.verification_level
        );
        // 清理测试拉起的记事本
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "notepad.exe", "/F"])
            .output();
    }

    #[cfg(windows)]
    #[test]
    fn launch_disallowed_reports_failure_or_focus_only() {
        let d = db();
        let t = target_resolver::save_target(
            &d,
            &target_resolver::TargetInput {
                target_type: "application".into(),
                display_name: "记事本(禁启测试)".into(),
                exe_path: "C:\\Windows\\notepad.exe".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let mut settings = Settings::default();
        settings.nav_allow_launch = false;
        // notepad 未运行时 → 拒绝启动；已运行 → 唤醒成功（两种都合法，但不能启动新进程）
        let r = navigate_application(&t, &settings, &NavigateOptions::default());
        if r.success {
            assert_eq!(r.actual_action.as_deref(), Some("focus_window"));
        } else {
            assert!(r.reason.unwrap().contains("不允许"));
        }
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "notepad.exe", "/F"])
            .output();
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
        let mut opts = NavigateOptions::default();
        opts.fallback = Some(false);
        let r = navigate_agent_session(&d, &t, &Settings::default(), &opts);
        assert!(!r.success);
        assert!(r.reason.unwrap().contains("不存在"));
    }
}
