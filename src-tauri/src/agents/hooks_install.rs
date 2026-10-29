//! Claude 兼容 Hooks 配置的安全读写（P1-7）。
//!
//! 适用：Codex（~/.codex/hooks.json）、Trae（~/.trae/hooks.json、~/.trae-cn/hooks.json）、
//! WorkBuddy/CodeBuddy（settings.json 的 hooks 键）、Qoder（~/.qoder/settings.json 的 hooks 键）。
//! 这些产品的官方格式均为：
//! ```json
//! { "hooks": { "<Event>": [ { "matcher"?: "...", "hooks": [ { "type": "command", "command": "...", "timeout"?: n } ] } ] } }
//! ```
//!
//! 安全规则：
//! 1. 读取失败 / JSON 损坏 → 立即报错，绝不覆盖可疑文件；
//! 2. 写入前自动备份（保留最近 5 份），任何失败自动回滚；
//! 3. 原子写入（临时文件 + rename），避免半写状态；
//! 4. 只增删 Task Dock 自己的条目（按命令行标记识别），第三方 hooks 原样保留；
//! 5. 卸载后清理空组与空事件键，恢复文件原貌。

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Task Dock 写入的 hook 命令中的自我标识（用于识别与安全卸载）。
/// v0.5 起 Hook 由原生 CLI 上报，命令含 `--agent-hook`；旧版 PowerShell 脚本
/// 使用 `task-dock-agent-hook` 文件名，卸载时同样识别。
pub const MARKER: &str = "--agent-hook";
pub const LEGACY_MARKER: &str = "task-dock-agent-hook";

/// 备份保留份数。
const KEEP_BACKUPS: usize = 5;

#[derive(Debug, Clone)]
pub struct HookSpec {
    /// 事件名（如 SessionStart / Stop / PermissionRequest）
    pub event: String,
    /// 工具匹配器（可选；仅对工具类事件有意义）
    pub matcher: Option<String>,
    /// 完整命令行（须包含 MARKER）
    pub command: String,
    /// 超时秒数（可选）
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HooksFileReport {
    pub path: String,
    pub existed_before: bool,
    pub third_party_entries: usize,
    pub installed_events: Vec<String>,
    pub backup: Option<String>,
    pub valid_json_after_write: bool,
}

fn is_our_hook(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(MARKER) || c.contains(LEGACY_MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// 读取并解析 hooks 文件（不存在 → 空 JSON 对象；损坏 → 报错）。
fn read_json(path: &Path) -> AppResult<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(Some(Value::Object(Default::default())));
    }
    serde_json::from_str::<Value>(&raw).map(Some).map_err(|e| {
        AppError::Agent(format!(
            "hooks 配置 {} 不是合法 JSON（{}）；为安全起见 Task Dock 不会修改它，请人工检查",
            path.display(),
            e
        ))
    })
}

fn backup(path: &Path) -> AppResult<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "hooks".into());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let bak = dir.join(format!("{}.taskdock-bak-{}{}", stem, ts, ext));
    std::fs::copy(path, &bak)?;
    // 只保留最近 KEEP_BACKUPS 份
    let mut olds: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .map(|n| {
                    let n = n.to_string_lossy();
                    n.starts_with(&format!("{}.taskdock-bak-", stem))
                        && n != bak
                            .file_name()
                            .map(|f| f.to_string_lossy())
                            .as_deref()
                            .unwrap_or("")
                })
                .unwrap_or(false)
        })
        .collect();
    if olds.len() + 1 > KEEP_BACKUPS {
        olds.sort();
        let drop_n = olds.len() + 1 - KEEP_BACKUPS;
        for p in olds.into_iter().take(drop_n) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(Some(bak))
}

/// 原子写入：先写临时文件再替换；失败时用备份回滚。
fn atomic_write(path: &Path, content: &str, backup_path: Option<&Path>) -> AppResult<()> {
    let tmp = path.with_extension("taskdock-tmp");
    std::fs::write(&tmp, content)?;
    let replaced = std::fs::rename(&tmp, path);
    if replaced.is_err() && path.exists() {
        // Windows 上 rename 不覆盖既有文件：删除原文件后重试（此前已有备份）
        if std::fs::remove_file(path).is_ok() && std::fs::rename(&tmp, path).is_ok() {
            return Ok(());
        }
        // 重试仍失败 → 回滚
        if let Some(bak) = backup_path {
            let _ = std::fs::copy(bak, path);
        }
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Agent(format!(
            "写入 {} 失败（已从备份回滚）",
            path.display()
        )));
    } else if replaced.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Agent(format!("写入 {} 失败", path.display())));
    }
    Ok(())
}

/// 安装（或幂等更新）Task Dock hooks，保留全部第三方配置。
pub fn install_hooks(path: &Path, specs: &[HookSpec]) -> AppResult<HooksFileReport> {
    for s in specs {
        if !s.command.contains(MARKER) {
            return Err(AppError::Validation("hook 命令缺少 Task Dock 标记".into()));
        }
    }
    let existed = path.exists();
    let mut root = read_json(path)?.unwrap_or_else(|| Value::Object(Default::default()));
    if !root.is_object() {
        return Err(AppError::Agent(format!(
            "{} 顶层不是 JSON 对象，拒绝修改（请人工检查）",
            path.display()
        )));
    }

    let bak = backup(path)?;

    let obj = root.as_object_mut().unwrap();
    let hooks = obj
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if !hooks.is_object() {
        *hooks = Value::Object(Default::default());
    }
    let hooks_obj = hooks.as_object_mut().unwrap();

    let mut third_party = 0usize;
    let mut installed = Vec::new();
    for spec in specs {
        let list = hooks_obj
            .entry(spec.event.clone())
            .or_insert_with(|| Value::Array(Vec::new()));
        if !list.is_array() {
            *list = Value::Array(Vec::new());
        }
        let arr = list.as_array_mut().unwrap();
        // 统计第三方（同事件下既有的非 Task Dock 组）
        third_party += arr.iter().filter(|g| !is_our_hook(g)).count();
        // 移除旧版 Task Dock 条目（幂等更新），再追加新条目
        arr.retain(|g| !is_our_hook(g));
        let mut hook_cmd = serde_json::Map::new();
        hook_cmd.insert("type".into(), Value::String("command".into()));
        hook_cmd.insert("command".into(), Value::String(spec.command.clone()));
        if let Some(t) = spec.timeout_secs {
            hook_cmd.insert("timeout".into(), Value::Number(t.into()));
        }
        let mut group = serde_json::Map::new();
        if let Some(m) = &spec.matcher {
            group.insert("matcher".into(), Value::String(m.clone()));
        }
        group.insert("hooks".into(), Value::Array(vec![Value::Object(hook_cmd)]));
        arr.push(Value::Object(group));
        installed.push(spec.event.clone());
    }

    let pretty = serde_json::to_string_pretty(&root)?;
    atomic_write(path, &pretty, bak.as_deref())?;

    // 写后校验：重新读取必须可解析
    let valid = read_json(path)?.is_some();

    Ok(HooksFileReport {
        path: path.to_string_lossy().to_string(),
        existed_before: existed,
        third_party_entries: third_party,
        installed_events: installed,
        backup: bak.as_ref().map(|b| b.to_string_lossy().to_string()),
        valid_json_after_write: valid,
    })
}

/// 卸载 Task Dock hooks：只删自己的条目，保留第三方；清理空组。
pub fn uninstall_hooks(path: &Path) -> AppResult<HooksFileReport> {
    let existed = path.exists();
    let mut root = match read_json(path)? {
        Some(v) => v,
        None => {
            return Ok(HooksFileReport {
                path: path.to_string_lossy().to_string(),
                existed_before: false,
                third_party_entries: 0,
                installed_events: vec![],
                backup: None,
                valid_json_after_write: true,
            })
        }
    };
    if !root.is_object() {
        return Err(AppError::Agent(format!(
            "{} 顶层不是 JSON 对象，拒绝修改",
            path.display()
        )));
    }

    let bak = backup(path)?;
    let mut removed_events = Vec::new();
    let mut third_party = 0usize;

    if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        let mut empty_events = Vec::new();
        for (event, list) in hooks.iter_mut() {
            if let Some(arr) = list.as_array_mut() {
                let before = arr.len();
                arr.retain(|g| !is_our_hook(g));
                if arr.len() < before {
                    removed_events.push(event.clone());
                }
                third_party += arr.len();
                if arr.is_empty() {
                    empty_events.push(event.clone());
                }
            }
        }
        for e in empty_events {
            hooks.remove(&e);
        }
        if hooks.is_empty() {
            if let Some(obj) = root.as_object_mut() {
                obj.remove("hooks");
            }
        }
    }

    let pretty = serde_json::to_string_pretty(&root)?;
    atomic_write(path, &pretty, bak.as_deref())?;
    let valid = read_json(path)?.is_some();

    Ok(HooksFileReport {
        path: path.to_string_lossy().to_string(),
        existed_before: existed,
        third_party_entries: third_party,
        installed_events: removed_events,
        backup: bak.as_ref().map(|b| b.to_string_lossy().to_string()),
        valid_json_after_write: valid,
    })
}

/// 检查状态：文件是否存在、JSON 是否合法、我们的事件哪些已注册、第三方条目数。
pub fn status_hooks(path: &Path, events: &[&str]) -> AppResult<Value> {
    let mut registered: Vec<String> = Vec::new();
    let mut third_party = 0usize;
    let mut valid_json = true;
    let mut existed = false;
    if let Some(root) = read_json(path)? {
        existed = true;
        if let Some(hooks) = root.get("hooks").and_then(|h| h.as_object()) {
            for ev in events {
                if let Some(arr) = hooks.get(*ev).and_then(|l| l.as_array()) {
                    let ours = arr.iter().any(is_our_hook);
                    third_party += arr.iter().filter(|g| !is_our_hook(g)).count();
                    if ours {
                        registered.push(ev.to_string());
                    }
                }
            }
        }
    } else {
        valid_json = false;
    }
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "exists": existed,
        "valid_json": valid_json,
        "registered_events": registered,
        "expected_events": events,
        "third_party_entries": third_party,
    }))
}

/// 用户主目录。
pub fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Task Dock hook 命令行（写入各 Agent 配置的 command 字段）。
/// 原生 CLI 单事件进程开销约 10ms（旧 PowerShell 脚本约 300ms+）。
/// event 来自 Task Dock 的静态白名单事件表，不接收外部输入，无注入面。
pub fn hook_command(exe: &Path, source_id: &str, event: &str) -> String {
    format!(
        "\"{}\" {} --source {} --event {}",
        exe.to_string_lossy(),
        MARKER,
        source_id,
        event
    )
}

/// 旧版 PowerShell 脚本路径（仅用于卸载清理与兼容检测）。
pub fn legacy_script_path(app_data: &Path, source_id: &str) -> PathBuf {
    app_data
        .join("hooks")
        .join(format!("task-dock-agent-hook-{}.ps1", source_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-hook-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spec(event: &str) -> HookSpec {
        HookSpec {
            event: event.into(),
            matcher: None,
            command: format!("powershell -File task-dock-agent-hook.ps1 {}", MARKER),
            timeout_secs: Some(10),
        }
    }

    #[test]
    fn install_preserves_third_party_and_is_idempotent() {
        let dir = tmpdir();
        let path = dir.join("hooks.json");
        // 第三方已有配置（cc_ring 形态）
        std::fs::write(
            &path,
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"C:\\play.sh","timeout":5}]}]}}"#,
        )
        .unwrap();

        let r1 = install_hooks(&path, &[spec("Stop"), spec("SessionStart")]).unwrap();
        assert_eq!(r1.third_party_entries, 1, "第三方 Stop 组保留");
        assert_eq!(r1.installed_events, vec!["Stop", "SessionStart"]);
        assert!(r1.valid_json_after_write);
        assert!(r1.backup.is_some(), "写入前备份");

        // 幂等：重复安装不产生重复条目
        install_hooks(&path, &[spec("Stop"), spec("SessionStart")]).unwrap();
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let stop = root["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "Stop = 1 第三方组 + 1 Task Dock 组");
        let ss = root["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(ss.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let dir = tmpdir();
        let path = dir.join("hooks.json");
        std::fs::write(
            &path,
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"C:\\play.sh","timeout":5}]}]}}"#,
        )
        .unwrap();
        install_hooks(&path, &[spec("Stop"), spec("SessionStart")]).unwrap();
        let r = uninstall_hooks(&path).unwrap();
        let mut removed = r.installed_events.clone();
        removed.sort();
        assert_eq!(removed, vec!["SessionStart", "Stop"]);
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // SessionStart 只剩空 → 键被清理；Stop 只剩第三方
        assert!(root["hooks"].get("SessionStart").is_none());
        assert_eq!(root["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(root["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("play.sh"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupted_json_is_never_touched() {
        let dir = tmpdir();
        let path = dir.join("hooks.json");
        std::fs::write(&path, "{ not json !!!").unwrap();
        let err = install_hooks(&path, &[spec("Stop")]).unwrap_err();
        assert!(err.to_string().contains("不是合法 JSON"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json !!!");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn status_reports_registration() {
        let dir = tmpdir();
        let path = dir.join("hooks.json");
        install_hooks(&path, &[spec("Stop")]).unwrap();
        let s = status_hooks(&path, &["Stop", "PreToolUse"]).unwrap();
        assert_eq!(s["registered_events"], serde_json::json!(["Stop"]));
        assert_eq!(s["third_party_entries"], 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
