//! Agent 跳转适配：启动、唤醒窗口、打开工作区、恢复会话。
//!
//! 证据原则：
//! - 能力不是静态布尔值：`can_launch` 要找到 exe；`can_resume_session` 要有
//!   已核验的官方接口（Codex：本机实测基线；OpenCode：运行时探测 CLI 帮助）；
//! - 没有可信会话恢复接口的 Agent 明确降级为「启动 / 唤醒窗口」，绝不臆造 Deep Link；
//! - 多实例且无法判定目标实例时，只做应用级唤醒并如实标注 fallback，不冒充精准定位；
//! - Agent 事件携带的路径/命令属于不可信数据，本模块只使用本机探测与用户确认配置。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::window_manager::{self, FocusOutcome};
use super::{
    NavigationResult, VerificationLevel, ACTION_FOCUS_WINDOW, ACTION_OPEN_APP,
    ACTION_RESUME_SESSION,
};
use crate::agents::codex;
use crate::db::Db;
use crate::error::AppError;

/// 单项能力的证据状态。
#[derive(Debug, Clone, Serialize)]
pub struct CapabilityStatus {
    pub supported: bool,
    /// exe-found | cli-help-probed | baseline-verified | official-docs |
    /// unsupported-interface | not-installed
    pub evidence: String,
    pub note: String,
}

impl CapabilityStatus {
    fn yes(evidence: &str, note: &str) -> Self {
        Self {
            supported: true,
            evidence: evidence.into(),
            note: note.into(),
        }
    }
    fn no(evidence: &str, note: &str) -> Self {
        Self {
            supported: false,
            evidence: evidence.into(),
            note: note.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentNavCapabilities {
    pub source_id: String,
    pub can_launch: CapabilityStatus,
    pub can_focus_window: CapabilityStatus,
    pub can_open_workspace: CapabilityStatus,
    pub can_resume_session: CapabilityStatus,
}

// ── Agent 应用定义（进程名 → 安装位置提示）──────────────────

struct AgentAppDef {
    source_id: &'static str,
    /// 进程/窗口匹配名（exe stem，小写）
    exe_stems: &'static [&'static str],
    /// %LOCALAPPDATA%\Programs\{hint}\{exe} 形式的安装提示
    local_hints: &'static [(&'static str, &'static str)], // (子目录, exe 名)
    /// 窗口标题提示（exe 无法判定时）
    title_hint: &'static str,
    /// 工作区打开能力（CLI 名 + 证据级别）
    workspace_cli: Option<(&'static str, &'static str)>,
}

const AGENTS: &[AgentAppDef] = &[
    AgentAppDef {
        source_id: "codex",
        exe_stems: &["codex"],
        local_hints: &[("OpenAI\\Codex\\bin", "codex.exe")],
        title_hint: "Codex",
        workspace_cli: None,
    },
    AgentAppDef {
        source_id: "trae",
        exe_stems: &["trae"],
        local_hints: &[("Trae", "Trae.exe")],
        title_hint: "Trae",
        // Trae/Qoder 为 VS Code 系 IDE；打开目录属 CLI 惯例，帮助文本可核验
        workspace_cli: Some(("trae", "cli-convention")),
    },
    AgentAppDef {
        source_id: "qoder",
        exe_stems: &["qoder"],
        local_hints: &[("Qoder", "Qoder.exe")],
        title_hint: "Qoder",
        workspace_cli: Some(("qoder", "cli-convention")),
    },
    AgentAppDef {
        source_id: "workbuddy",
        exe_stems: &["workbuddy", "codebuddy"],
        local_hints: &[("WorkBuddy", "WorkBuddy.exe")],
        title_hint: "WorkBuddy",
        workspace_cli: None,
    },
    AgentAppDef {
        source_id: "deepseek-harness",
        exe_stems: &["dsh"],
        local_hints: &[],
        title_hint: "",
        workspace_cli: None,
    },
    AgentAppDef {
        source_id: "opencode",
        exe_stems: &["opencode"],
        local_hints: &[],
        title_hint: "opencode",
        workspace_cli: None,
    },
    AgentAppDef {
        source_id: "zcode",
        exe_stems: &["zcode"],
        local_hints: &[],
        title_hint: "",
        workspace_cli: None,
    },
];

fn def_for(source_id: &str) -> Option<&'static AgentAppDef> {
    AGENTS.iter().find(|a| a.source_id == source_id)
}

/// 解析 Agent 的可执行文件（PATH → 已知安装位置）。
fn find_agent_exe(def: &AgentAppDef) -> Option<std::path::PathBuf> {
    if let Some(p) = crate::agents::managed::find_exe(def.exe_stems) {
        return Some(p);
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        for (dir, exe) in def.local_hints {
            let p = std::path::PathBuf::from(&la)
                .join("Programs")
                .join(dir)
                .join(exe);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// 该 Agent 当前可交互窗口（按 exe stem / 标题提示匹配）。
fn agent_windows(def: &AgentAppDef) -> Vec<window_manager::WindowInfo> {
    let stems: Vec<String> = def
        .exe_stems
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    window_manager::top_windows()
        .into_iter()
        .filter(|w| {
            let exe_stem = w
                .exe_path
                .as_deref()
                .and_then(|p| {
                    std::path::Path::new(p)
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_ascii_lowercase())
                })
                .unwrap_or_default();
            stems.contains(&exe_stem)
                || (!def.title_hint.is_empty()
                    && w.title
                        .to_ascii_lowercase()
                        .contains(&def.title_hint.to_ascii_lowercase()))
        })
        .collect()
}

// ── OpenCode 会话恢复接口探测（带 1h 缓存）─────────────────

/// 探测结果：Some(true) = `opencode resume <session>` 支持；Some(false) = 有 resume
/// 子命令但未见会话参数（只能开选择器）；None = 无 CLI / 无 resume。
fn opencode_session_resume_support() -> Option<bool> {
    use std::sync::OnceLock;
    /// (探测时间, 结果)：结果 None = 无 CLI / 无 resume 子命令
    type ResumeProbeCache = Mutex<Option<(Instant, Option<bool>)>>;
    static CACHE: OnceLock<ResumeProbeCache> = OnceLock::new();
    let cell = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((at, v)) = cell.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(3600) {
            return *v;
        }
    }
    let v = probe_opencode_resume();
    *cell.lock().unwrap() = Some((Instant::now(), v));
    v
}

fn probe_opencode_resume() -> Option<bool> {
    let exe = crate::agents::managed::find_exe(&["opencode"])?;
    let out = crate::winproc::hidden(&exe)
        .args(["resume", "--help"])
        .output()
        .ok()?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .to_ascii_lowercase();
    if !text.contains("resume") {
        return None; // 无 resume 子命令
    }
    // 帮助文本出现会话位置参数 → 支持按 ID 恢复
    Some(text.contains("session") || text.contains("<id>") || text.contains("[id]"))
}

// ── 能力清单 ────────────────────────────────────────────────

/// 动态核验某 Agent 的跳转能力（UI 徽标与降级菜单共用）。
pub fn capabilities(source_id: &str) -> AgentNavCapabilities {
    let Some(def) = def_for(source_id) else {
        return AgentNavCapabilities {
            source_id: source_id.to_string(),
            can_launch: CapabilityStatus::no(
                "unsupported-interface",
                "未内置该 Agent 的启动方式；可用「应用管理」手动登记软件后关联任务",
            ),
            can_focus_window: CapabilityStatus::no("unsupported-interface", "无已知窗口身份"),
            can_open_workspace: CapabilityStatus::no("unsupported-interface", "未定义工作区接口"),
            can_resume_session: CapabilityStatus::no(
                "unsupported-interface",
                "无官方会话恢复接口，不臆造 Deep Link",
            ),
        };
    };
    let exe = find_agent_exe(def);

    let can_launch = match &exe {
        Some(p) => CapabilityStatus::yes("exe-found", &format!("已定位 {}", p.display())),
        None => CapabilityStatus::no("not-installed", "未在本机找到可执行文件"),
    };

    let has_window = !agent_windows(def).is_empty();
    let can_focus = if has_window {
        CapabilityStatus::yes("window-present", "当前存在可交互窗口")
    } else if exe.is_some() {
        CapabilityStatus::yes("exe-found", "启动后可按进程/标题匹配窗口")
    } else {
        CapabilityStatus::no("not-installed", "未安装，无从唤醒")
    };

    let can_workspace = match (def.workspace_cli, &exe) {
        (Some((cli, _)), Some(_)) => CapabilityStatus::yes(
            "cli-convention",
            &format!("{} <目录>（VS Code 系 CLI 惯例；以实际启动结果为准）", cli),
        ),
        (Some((cli, _)), None) => {
            CapabilityStatus::no("not-installed", &format!("未找到 {} 可执行文件", cli))
        }
        (None, _) => CapabilityStatus::no("unsupported-interface", "该 Agent 无已知工作区打开接口"),
    };

    let can_resume = match def.source_id {
        "codex" => match &exe {
            Some(_) => CapabilityStatus::yes(
                "baseline-verified",
                "codex resume <会话ID>（0.130.0 实测基线；CLI 与 App 会话库一致，跳转以 CLI 终端呈现）",
            ),
            None => CapabilityStatus::no("not-installed", "未找到 codex CLI"),
        },
        "opencode" => match opencode_session_resume_support() {
            Some(true) => CapabilityStatus::yes("cli-help-probed", "当前版本 resume 支持会话 ID 参数"),
            Some(false) => CapabilityStatus::no(
                "unsupported-interface",
                "resume 仅支持交互选择器，无法按 ID 精准恢复（降级为打开 TUI）",
            ),
            None => match &exe {
                Some(_) => CapabilityStatus::no(
                    "unsupported-interface",
                    "该版本无 resume 子命令（或探测失败）",
                ),
                None => CapabilityStatus::no("not-installed", "未找到 opencode CLI"),
            },
        },
        other => CapabilityStatus::no(
            "unsupported-interface",
            &format!(
                "{} 无官方会话恢复接口（诚实标记不支持，降级为启动/唤醒）",
                other
            ),
        ),
    };

    AgentNavCapabilities {
        source_id: source_id.to_string(),
        can_launch,
        can_focus_window: can_focus,
        can_open_workspace: can_workspace,
        can_resume_session: can_resume,
    }
}

// ── 动作 ────────────────────────────────────────────────────

fn launch_exe(
    exe: &std::path::Path,
    args: &[String],
    working_dir: Option<&str>,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args);
    if let Some(dir) = working_dir.filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.current_dir(dir);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("启动失败: {}", e))
}

/// 启动 Agent（L1）。
pub fn launch_agent(source_id: &str) -> NavigationResult {
    let requested = ACTION_OPEN_APP.to_string();
    let Some(def) = def_for(source_id) else {
        return NavigationResult::failure(source_id, &requested, "该 Agent 未内置启动方式");
    };
    let Some(exe) = find_agent_exe(def) else {
        return NavigationResult::failure(
            source_id,
            &requested,
            "未找到可执行文件（可能未安装或不在 PATH）",
        );
    };
    match launch_exe(&exe, &[], None) {
        Ok(()) => NavigationResult {
            success: true,
            requested_action: requested,
            actual_action: Some(ACTION_OPEN_APP.into()),
            fallback_used: false,
            target_id: source_id.to_string(),
            reason: None,
            verification_level: VerificationLevel::ProcessSpawned.as_str().into(),
        },
        Err(e) => NavigationResult::failure(source_id, &requested, e),
    }
}

/// 唤醒 Agent 现有窗口（L2）。没有窗口时按 allow_launch 决定是否启动。
pub fn focus_agent(source_id: &str, allow_launch: bool) -> NavigationResult {
    let requested = ACTION_FOCUS_WINDOW.to_string();
    let Some(def) = def_for(source_id) else {
        return NavigationResult::failure(source_id, &requested, "该 Agent 无已知窗口身份");
    };
    let wins = agent_windows(def);
    if wins.is_empty() {
        if allow_launch {
            let mut r = launch_agent(source_id);
            r.requested_action = requested;
            r.fallback_used = true;
            r.reason = Some("无现有窗口，已降级为启动".into());
            return r;
        }
        return NavigationResult::failure(source_id, &requested, "未运行且设置不允许启动新进程");
    }
    // 多窗口：唤醒最近活跃（标题最长）的一个，并如实标注是应用级唤醒
    let target = wins.iter().max_by_key(|w| w.title.chars().count()).unwrap();
    match window_manager::focus_window(target.hwnd) {
        Ok(FocusOutcome::Confirmed) => NavigationResult {
            success: true,
            requested_action: requested,
            actual_action: Some(ACTION_FOCUS_WINDOW.into()),
            fallback_used: wins.len() > 1,
            target_id: source_id.to_string(),
            reason: (wins.len() > 1).then(|| {
                format!(
                    "该应用有 {} 个窗口，已唤醒其一（无法关联到具体实例）",
                    wins.len()
                )
            }),
            verification_level: VerificationLevel::WindowConfirmed.as_str().into(),
        },
        Ok(FocusOutcome::Unverified) => NavigationResult {
            success: true,
            requested_action: requested,
            actual_action: Some(ACTION_FOCUS_WINDOW.into()),
            fallback_used: false,
            target_id: source_id.to_string(),
            reason: Some("切换已请求，但未能在超时内核实前台状态".into()),
            verification_level: "requested-unverified".into(),
        },
        Err(e) => NavigationResult::failure(source_id, &requested, e.reason_cn()),
    }
}

/// 恢复 Agent 会话（L4）。仅对有核验接口的 Agent 生效，其余诚实降级。
pub fn resume_session(db: &Db, source_id: &str, session_id: &str) -> NavigationResult {
    let requested = ACTION_RESUME_SESSION.to_string();
    let target_id = format!("{}:{}", source_id, session_id);
    // 会话 ID 白名单校验（防参数注入）
    if let Err(e) = crate::agents::validate_session_id(session_id) {
        return NavigationResult::failure(&target_id, &requested, e.to_string());
    }
    // 会话必须在本地数据库中存在（外部传入的任意 ID 不跳）
    let known: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2",
                rusqlite::params![source_id, session_id],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap_or(0);
    if known == 0 {
        return NavigationResult::failure(
            &target_id,
            &requested,
            "本地无此会话记录（可能是外部伪造的会话 ID）",
        );
    }

    match source_id {
        "codex" => {
            let Some(exe) = codex::find_codex_exe() else {
                // 降级：尝试唤醒 Codex App 窗口
                let mut r = focus_agent("codex", false);
                if r.success {
                    r.requested_action = requested;
                    r.fallback_used = true;
                    r.reason =
                        Some("未找到 codex CLI（App 安装不含 CLI），降级为唤醒 Codex 窗口".into());
                }
                return r;
            };
            match launch_exe(&exe, &["resume".into(), session_id.to_string()], None) {
                Ok(()) => NavigationResult {
                    success: true,
                    requested_action: requested,
                    actual_action: Some(ACTION_RESUME_SESSION.into()),
                    fallback_used: false,
                    target_id,
                    reason: Some(
                        "已在新的终端进程中执行 codex resume（多窗口应用请以终端内容为准）".into(),
                    ),
                    verification_level: VerificationLevel::ProcessSpawned.as_str().into(),
                },
                Err(e) => NavigationResult::failure(&target_id, &requested, e),
            }
        }
        "opencode" => {
            if opencode_session_resume_support() == Some(true) {
                let Some(exe) = crate::agents::managed::find_exe(&["opencode"]) else {
                    return NavigationResult::failure(
                        &target_id,
                        &requested,
                        "未找到 opencode CLI",
                    );
                };
                return match launch_exe(&exe, &["resume".into(), session_id.to_string()], None) {
                    Ok(()) => NavigationResult {
                        success: true,
                        requested_action: requested.clone(),
                        actual_action: Some(ACTION_RESUME_SESSION.into()),
                        fallback_used: false,
                        target_id,
                        reason: Some("已执行 opencode resume <id>（CLI 帮助文本核验支持）".into()),
                        verification_level: VerificationLevel::ProcessSpawned.as_str().into(),
                    },
                    Err(e) => NavigationResult::failure(&target_id, &requested, e),
                };
            }
            // 无会话参数支持：降级为打开 TUI（选择器）
            let mut r = launch_agent("opencode");
            r.requested_action = requested;
            r.target_id = target_id;
            if r.success {
                r.fallback_used = true;
                r.reason = Some(
                    "当前版本 resume 不支持按 ID 恢复，已降级为打开 opencode（会话列表中手动选择）"
                        .into(),
                );
            }
            r
        }
        other => {
            // 无官方接口：诚实降级（启动/唤醒），绝不臆造 Deep Link
            let mut r = focus_agent(other, true);
            r.requested_action = requested;
            r.target_id = target_id;
            if r.success {
                r.fallback_used = true;
                r.reason = Some(format!(
                    "{} 暂无官方会话恢复接口，已降级为启动/唤醒（不冒充精准定位）",
                    other
                ));
            } else if r.reason.is_none() {
                r.reason = Some(format!("{} 不支持会话恢复，且启动/唤醒也失败", other));
            }
            r
        }
    }
}

/// 为 Agent 打开工作区目录（L3，IDE 类）。
pub fn open_workspace(source_id: &str, dir: &str) -> NavigationResult {
    let requested = super::ACTION_OPEN_WORKSPACE.to_string();
    let path = std::path::PathBuf::from(dir);
    if !path.is_absolute() || !path.is_dir() {
        return NavigationResult::failure(source_id, &requested, format!("目录无效: {}", dir));
    }
    let Some(def) = def_for(source_id) else {
        return NavigationResult::failure(source_id, &requested, "该 Agent 无工作区接口");
    };
    let Some((cli, _)) = def.workspace_cli else {
        return NavigationResult::failure(source_id, &requested, "该 Agent 无已知工作区打开接口");
    };
    let Some(exe) = find_agent_exe(def) else {
        return NavigationResult::failure(
            source_id,
            &requested,
            format!("未找到 {} 可执行文件", cli),
        );
    };
    match launch_exe(&exe, &[dir.to_string()], None) {
        Ok(()) => NavigationResult {
            success: true,
            requested_action: requested,
            actual_action: Some(super::ACTION_OPEN_WORKSPACE.into()),
            fallback_used: false,
            target_id: source_id.to_string(),
            reason: None,
            verification_level: VerificationLevel::ProcessSpawned.as_str().into(),
        },
        Err(e) => NavigationResult::failure(source_id, &requested, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    #[test]
    fn unknown_agent_capabilities_unsupported() {
        let c = capabilities("my-custom-agent");
        assert!(!c.can_launch.supported);
        assert!(!c.can_resume_session.supported);
        assert_eq!(c.can_resume_session.evidence, "unsupported-interface");
    }

    #[test]
    fn resume_rejects_unknown_or_malformed_session() {
        let d = db();
        // 非法字符
        let r = resume_session(&d, "codex", "bad session; rm -rf");
        assert!(!r.success);
        // 合法格式但本地不存在
        let r = resume_session(&d, "codex", "e1f0c0de-0000-4000-8000-000000000000");
        assert!(!r.success);
        assert!(r.reason.unwrap().contains("本地无此会话"));
    }

    #[test]
    fn resume_rejects_non_whitelisted_source() {
        let d = db();
        let r = resume_session(&d, "weird-agent", "abc123");
        assert!(!r.success);
    }

    #[test]
    fn workspace_rejects_bad_dir() {
        let r = open_workspace("trae", "C:\\no\\such\\dir");
        assert!(!r.success);
        // 非 IDE Agent
        let r = open_workspace("codex", "C:\\");
        assert!(!r.success, "codex 无工作区接口，必须拒绝");
    }

    /// Agent 未安装 / 未接入：必须如实失败，不得假装已启动。
    #[test]
    fn uninstalled_or_unknown_agent_reports_failure() {
        // 完全未知的 source：无启动方式
        let r = launch_agent("no-such-agent");
        assert!(!r.success);
        assert_eq!(r.verification_level, "none");
        assert!(r.reason.unwrap().contains("未内置启动方式"));
        // 未知 source 的会话恢复：拒绝且不产生"已恢复"假象
        let d = db();
        let r = resume_session(&d, "no-such-agent", "sess-1");
        assert!(!r.success);
        assert_eq!(r.verification_level, "none");
        // 未知 source 的能力清单：三项均不支持，证据为 unsupported-interface
        let c = capabilities("no-such-agent");
        assert!(!c.can_launch.supported);
        assert!(!c.can_open_workspace.supported);
        assert!(!c.can_resume_session.supported);
    }

    #[test]
    fn codex_capabilities_are_evidence_based() {
        // 无论装没装 codex，能力都必须带证据标注
        let c = capabilities("codex");
        assert!(
            c.can_launch.evidence == "exe-found" || c.can_launch.evidence == "not-installed",
            "can_launch 必须由本机探测决定"
        );
        assert!(
            c.can_resume_session.evidence == "baseline-verified"
                || c.can_resume_session.evidence == "not-installed"
        );
    }
}
