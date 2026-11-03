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
use crate::db::{Db, Settings};
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

/// 该 Agent 当前可交互窗口。
///
/// 先用 exe stem 直接命中；命中不到时再按已定位 exe 的**进程树**找窗口
///（CLI 的终端窗口通常由 conhost/子进程持有）。标题提示只在这条路径内做
/// 二次收窄，绝不单独用标题去唤醒一个恰好同名的其他应用。
fn agent_windows(def: &AgentAppDef) -> Vec<window_manager::WindowInfo> {
    let stems: Vec<String> = def
        .exe_stems
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    let direct: Vec<window_manager::WindowInfo> = window_manager::top_windows()
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
        })
        .collect();
    if !direct.is_empty() {
        return direct;
    }
    let Some(exe) = find_agent_exe(def) else {
        return Vec::new();
    };
    window_manager::windows_for_identity(
        &exe.to_string_lossy(),
        (!def.title_hint.is_empty()).then_some(def.title_hint),
    )
}

// ── 外部 CLI 帮助探测（并发消费输出 + 超时 + 退出码）─────────

/// 运行外部命令并在超时内并发消费 stdout/stderr（避免管道写满导致死锁）。
///
/// 返回 `(退出码成功, 合并输出)`；超时/启动失败返回 None（调用方必须当作
/// 「未核验」，不能猜测支持）。注意：stdout 与 stderr 必须由独立线程读取，
/// 只 `wait()` 不读管道在大输出时会永久阻塞。
fn output_with_timeout(
    cmd: &mut std::process::Command,
    timeout: Duration,
) -> Option<(bool, String)> {
    use std::io::Read;
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut s = stdout;
        let _ = s.read_to_end(&mut buf);
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut s = stderr;
        let _ = s.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = out_handle.join().unwrap_or_default();
    let err = err_handle.join().unwrap_or_default();
    let status = status?;
    let text = String::from_utf8_lossy(&out).into_owned() + "\n" + &String::from_utf8_lossy(&err);
    Some((status.success(), text))
}

/// 探测结果：Some(true) = 当前版本支持 `--session <id>`；Some(false) = CLI 存在但不支持；
/// None = 无 CLI / 探测失败（不得据此猜测支持）。
fn opencode_session_flag_support() -> Option<bool> {
    use std::sync::OnceLock;
    type ProbeCache = Mutex<Option<(Instant, Option<bool>)>>;
    static CACHE: OnceLock<ProbeCache> = OnceLock::new();
    let cell = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((at, v)) = cell.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(3600) {
            return *v;
        }
    }
    let v = probe_opencode_session_flag();
    *cell.lock().unwrap() = Some((Instant::now(), v));
    v
}

fn probe_opencode_session_flag() -> Option<bool> {
    let exe = crate::agents::managed::find_exe(&["opencode"])?;
    let mut cmd = crate::winproc::hidden(&exe);
    cmd.arg("--help");
    let (ok, text) = output_with_timeout(&mut cmd, Duration::from_secs(5))?;
    if !ok {
        // 帮助命令非零退出：输出不可作为接口证据
        return Some(false);
    }
    let lower = text.to_ascii_lowercase();
    // 官方 CLI 文档核验：`--session`（短别名 `-s`）用于按 ID 恢复。
    // 旧实现依赖未验证的 `opencode resume <id>`，已移除。
    Some(lower.contains("--session") || lower.contains("-s, "))
}

// ── 能力清单 ────────────────────────────────────────────────

/// 动态核验某 Agent 的跳转能力（UI 徽标与降级菜单共用）。
///
/// 30s 短缓存：避免 UI 高频刷新重复做 PATH 搜索、窗口枚举与 CLI 探测；
/// TTL 短于安装/卸载的感知需求，已卸载的软件不会永久显示可用。
pub fn capabilities(source_id: &str) -> AgentNavCapabilities {
    use std::sync::OnceLock;
    type CapCache = Mutex<std::collections::HashMap<String, (Instant, AgentNavCapabilities)>>;
    static CACHE: OnceLock<CapCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let ttl = Duration::from_secs(30);
    if let Some((at, v)) = cache.lock().unwrap().get(source_id) {
        if at.elapsed() < ttl {
            return v.clone();
        }
    }
    let v = compute_capabilities(source_id);
    {
        let mut guard = cache.lock().unwrap();
        guard.retain(|_, (at, _)| at.elapsed() < ttl);
        guard.insert(source_id.to_string(), (Instant::now(), v.clone()));
    }
    v
}

fn compute_capabilities(source_id: &str) -> AgentNavCapabilities {
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
        CapabilityStatus::yes("exe-found", "启动后可按进程身份匹配窗口")
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
        "opencode" => match opencode_session_flag_support() {
            Some(true) => CapabilityStatus::yes(
                "cli-help-probed",
                "当前版本支持 opencode --session <会话ID>（CLI --help 实测，已核对官方文档）",
            ),
            Some(false) => CapabilityStatus::no(
                "unsupported-interface",
                "当前版本 --help 未提供 --session，无法按 ID 精准恢复（降级为打开 TUI）",
            ),
            None => match &exe {
                Some(_) => CapabilityStatus::no(
                    "unsupported-interface",
                    "CLI 帮助探测超时/失败，不能确认 --session 支持（降级为打开 TUI）",
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

/// 交互式 CLI（必须有真实控制台窗口才能算启动成功）。
fn is_cli_agent(source_id: &str) -> bool {
    matches!(source_id, "codex" | "opencode")
}

/// 在**新控制台窗口**中启动交互式 CLI，并核实确实出现了该进程树的窗口。
///
/// 不用 CREATE_NO_WINDOW：那会得到没有可交互窗口的后台进程，不能当成
/// 「启动成功」或「会话已恢复」。若超时内没有窗口，如实返回失败原因；
/// 进程可能仍在运行，但绝不冒充成功。
fn launch_cli_in_terminal(
    exe: &std::path::Path,
    args: &[String],
    working_dir: Option<&str>,
    timeout: Duration,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args);
    if let Some(dir) = working_dir.filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动交互式终端失败: {}", e))?;
    let pid = child.id();
    let deadline = Instant::now() + timeout;
    loop {
        if !window_manager::windows_for_pid_tree(pid).is_empty() {
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "CLI 已退出（退出码 {}），未能建立可交互终端（会话 ID 可能无效或当前版本不支持）",
                    status.code().unwrap_or(-1)
                ));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("等待 CLI 进程失败: {}", e)),
        }
        if Instant::now() >= deadline {
            return Err("已创建进程但未检测到可交互终端窗口，不能确认命令已在终端中执行".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
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
    if is_cli_agent(source_id) {
        return match launch_cli_in_terminal(&exe, &[], None, Duration::from_secs(3)) {
            Ok(()) => NavigationResult {
                success: true,
                requested_action: requested,
                actual_action: Some(ACTION_OPEN_APP.into()),
                fallback_used: false,
                target_id: source_id.to_string(),
                reason: Some("已在新控制台窗口启动 CLI".into()),
                verification_level: VerificationLevel::ProcessSpawned.as_str().into(),
            },
            Err(e) => NavigationResult::failure(source_id, &requested, e),
        };
    }
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
///
/// 所有启动行为都遵守 `nav_allow_launch` / `nav_fallback`：用户关闭自动启动或
/// 降级时，不得为了「恢复成功」而静默开进程。
pub fn resume_session(
    db: &Db,
    source_id: &str,
    session_id: &str,
    settings: &Settings,
) -> NavigationResult {
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
                if !settings.nav_fallback {
                    return NavigationResult::failure(
                        &target_id,
                        &requested,
                        "未找到 codex CLI，且已关闭降级（设置中可重新开启）",
                    );
                }
                // 降级：尝试唤醒 Codex App 窗口（是否允许启动仍由用户设置决定）
                let mut r = focus_agent("codex", settings.nav_allow_launch);
                if r.success {
                    r.requested_action = requested;
                    r.fallback_used = true;
                    r.reason =
                        Some("未找到 codex CLI（App 安装不含 CLI），降级为唤醒 Codex 窗口".into());
                }
                return r;
            };
            if !settings.nav_allow_launch {
                return NavigationResult::failure(
                    &target_id,
                    &requested,
                    "设置已禁止启动新进程，无法在终端执行 codex resume（可先允许启动）",
                );
            }
            match launch_cli_in_terminal(
                &exe,
                &["resume".into(), session_id.to_string()],
                None,
                Duration::from_secs(4),
            ) {
                Ok(()) => NavigationResult {
                    success: true,
                    requested_action: requested,
                    actual_action: Some(ACTION_RESUME_SESSION.into()),
                    fallback_used: false,
                    target_id,
                    reason: Some(
                        "已在新控制台窗口执行 codex resume（恢复内容需以终端实际输出为准）".into(),
                    ),
                    verification_level: VerificationLevel::ProcessSpawned.as_str().into(),
                },
                Err(e) => NavigationResult::failure(&target_id, &requested, e),
            }
        }
        "opencode" => {
            if opencode_session_flag_support() == Some(true) {
                let Some(exe) = crate::agents::managed::find_exe(&["opencode"]) else {
                    return NavigationResult::failure(
                        &target_id,
                        &requested,
                        "未找到 opencode CLI",
                    );
                };
                if !settings.nav_allow_launch {
                    return NavigationResult::failure(
                        &target_id,
                        &requested,
                        "设置已禁止启动新进程，无法在终端执行 opencode --session（可先允许启动）",
                    );
                }
                return match launch_cli_in_terminal(
                    &exe,
                    &["--session".into(), session_id.to_string()],
                    None,
                    Duration::from_secs(4),
                ) {
                    Ok(()) => NavigationResult {
                        success: true,
                        requested_action: requested.clone(),
                        actual_action: Some(ACTION_RESUME_SESSION.into()),
                        fallback_used: false,
                        target_id,
                        reason: Some(
                            "已在新控制台窗口执行 opencode --session <id>（CLI 帮助实测支持）"
                                .into(),
                        ),
                        verification_level: VerificationLevel::ProcessSpawned.as_str().into(),
                    },
                    Err(e) => NavigationResult::failure(&target_id, &requested, e),
                };
            }
            if !settings.nav_fallback {
                return NavigationResult::failure(
                    &target_id,
                    &requested,
                    "当前版本不支持 --session 按 ID 恢复，且已关闭降级",
                );
            }
            if !settings.nav_allow_launch {
                return NavigationResult::failure(
                    &target_id,
                    &requested,
                    "当前版本不支持按 ID 恢复；设置已禁止启动新进程，无法打开 TUI",
                );
            }
            // 无会话参数支持：降级为打开 TUI（选择器）
            let mut r = launch_agent("opencode");
            r.requested_action = requested;
            r.target_id = target_id;
            if r.success {
                r.fallback_used = true;
                r.reason = Some(
                    "当前版本 --help 未提供 --session，已降级为打开 opencode（会话列表中手动选择）"
                        .into(),
                );
            }
            r
        }
        other => {
            if !settings.nav_fallback {
                return NavigationResult::failure(
                    &target_id,
                    &requested,
                    &format!("{} 不支持会话恢复，且已关闭降级", other),
                );
            }
            // 无官方接口：诚实降级（启动/唤醒），绝不臆造 Deep Link
            let mut r = focus_agent(other, settings.nav_allow_launch);
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
        let s = Settings::default();
        // 非法字符
        let r = resume_session(&d, "codex", "bad session; rm -rf", &s);
        assert!(!r.success);
        // 合法格式但本地不存在
        let r = resume_session(&d, "codex", "e1f0c0de-0000-4000-8000-000000000000", &s);
        assert!(!r.success);
        assert!(r.reason.unwrap().contains("本地无此会话"));
    }

    #[test]
    fn resume_rejects_non_whitelisted_source() {
        let d = db();
        let r = resume_session(&d, "weird-agent", "abc123", &Settings::default());
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
        let r = resume_session(&d, "no-such-agent", "sess-1", &Settings::default());
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
