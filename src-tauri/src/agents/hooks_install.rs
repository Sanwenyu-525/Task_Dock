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

/// Hooks 配置布局。
///
/// - `Flat`：Claude 兼容格式 `{ "hooks": { "<Event>": [ ... ] } }`
///   （Codex / Trae / WorkBuddy / Qoder / Claude / Cursor / Gemini）；
/// - `NestedEvents`：ZCode 用户配置格式
///   `{ "hooks": { "enabled": true, "events": { "<Event>": [ ... ] } } }`。
///   ZCode 的配置式 hooks 默认关闭，安装时必须同时写 `enabled: true`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HooksLayout {
    Flat,
    NestedEvents,
}

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

fn tmp_path_for(path: &Path, tag: &str) -> PathBuf {
    let name = format!(
        "taskdock-{}-{}.tmp",
        tag,
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    path.with_file_name(name)
}

/// 原子替换目标文件。
///
/// Windows 上 `std::fs::rename` 不能覆盖既有文件，旧实现「删除原文件再 rename」
/// 存在原文件已删、新文件未就位的窗口期（进程中断/杀毒占用时配置直接丢失）。
/// 改用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`：
/// 单次 API 完成替换，且写穿透到磁盘后才返回。
#[cfg(windows)]
fn replace_file(tmp: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    #[cfg(test)]
    if fail_replace_injected(tmp) {
        return Err(std::io::Error::other("fault-injection: replace failed"));
    }

    let wide = |p: &Path| -> Vec<u16> {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let src = wide(tmp);
    let dst = wide(path);
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, path: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if fail_replace_injected(tmp) {
        return Err(std::io::Error::other("fault-injection: replace failed"));
    }
    std::fs::rename(tmp, path)
}

#[cfg(test)]
thread_local! {
    // 每个测试在独立线程运行，thread_local 保证故障注入不会影响并行测试。
    static FAIL_REPLACE_AFTER: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// 故障注入：让第 N 次替换失败（0 表示不注入）。用于验证回滚与多文件一致性。
#[cfg(test)]
fn fail_replace_injected(_tmp: &Path) -> bool {
    FAIL_REPLACE_AFTER.with(|c| {
        let remaining = c.get();
        if remaining == 0 {
            return false;
        }
        c.set(remaining - 1);
        remaining == 1
    })
}

#[cfg(test)]
fn inject_replace_failure_after(n: usize) {
    FAIL_REPLACE_AFTER.with(|c| c.set(n));
}

/// 从备份恢复并做内容校验：返回 Err 时调用方必须如实报告「回滚失败」。
fn restore_from_backup(path: &Path, backup: &Path) -> std::io::Result<()> {
    let data = std::fs::read(backup)?;
    let tmp = tmp_path_for(path, "restore");
    std::fs::write(&tmp, &data)?;
    let replaced = replace_file(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    replaced?;
    let after = std::fs::read(path)?;
    if after != data {
        return Err(std::io::Error::other("恢复后内容校验不一致"));
    }
    Ok(())
}

/// 原子写入：临时文件 + 同步落盘 + 单次原子替换；任何失败都尝试备份回滚，
/// 并如实区分「回滚成功」与「回滚失败（备份保留，需人工恢复）」。
fn atomic_write(path: &Path, content: &str, backup_path: Option<&Path>) -> AppResult<()> {
    let Some(parent) = path.parent() else {
        return Err(AppError::Agent(format!(
            "写入 {} 失败：无法确定配置目录",
            path.display()
        )));
    };
    if !parent.exists() {
        return Err(AppError::Agent(format!(
            "写入 {} 失败：配置目录 {} 不存在",
            path.display(),
            parent.display()
        )));
    }
    let tmp = tmp_path_for(path, "tmp");
    let write_res = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Agent(format!(
            "写入 {} 的临时文件失败：{}（原文件未改动）",
            path.display(),
            e
        )));
    }
    if let Err(e) = replace_file(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(match backup_path {
            Some(bak) => match restore_from_backup(path, bak) {
                Ok(()) => AppError::Agent(format!(
                    "写入 {} 失败：{}；已从备份 {} 回滚并通过内容校验",
                    path.display(),
                    e,
                    bak.display()
                )),
                Err(restore_err) => AppError::Agent(format!(
                    "写入 {} 失败：{}；回滚失败（{}），备份保留在 {}，请人工恢复",
                    path.display(),
                    e,
                    restore_err,
                    bak.display()
                )),
            },
            None => AppError::Agent(format!(
                "写入 {} 失败：{}；原文件不存在，未产生可回滚状态",
                path.display(),
                e
            )),
        });
    }
    Ok(())
}

/// 校验所有 spec 都带 Task Dock 标记，避免写入无法识别的条目。
fn validate_specs(specs: &[HookSpec]) -> AppResult<()> {
    for s in specs {
        if !s.command.contains(MARKER) {
            return Err(AppError::Validation("hook 命令缺少 Task Dock 标记".into()));
        }
    }
    Ok(())
}

/// 读取并校验目标文件可作为 hooks 配置修改（损坏/非对象一律拒绝，不做任何写入）。
fn validated_root(path: &Path) -> AppResult<Option<Value>> {
    let root = read_json(path)?;
    if let Some(v) = &root {
        if !v.is_object() {
            return Err(AppError::Agent(format!(
                "{} 顶层不是 JSON 对象，拒绝修改（请人工检查）",
                path.display()
            )));
        }
    }
    Ok(root)
}

/// 取出「事件表」对象：Flat 是 `hooks` 自身，NestedEvents 是 `hooks.events`。
/// NestedEvents 同时保证 `hooks.enabled = true`（ZCode 默认关闭配置式 hooks）。
fn events_object_mut(root: &mut Value, layout: HooksLayout) -> &mut serde_json::Map<String, Value> {
    let obj = root.as_object_mut().unwrap();
    let hooks = obj
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if !hooks.is_object() {
        *hooks = Value::Object(Default::default());
    }
    let hooks_obj = hooks.as_object_mut().unwrap();
    match layout {
        HooksLayout::Flat => hooks_obj,
        HooksLayout::NestedEvents => {
            hooks_obj.insert("enabled".into(), Value::Bool(true));
            let events = hooks_obj
                .entry("events".to_string())
                .or_insert_with(|| Value::Object(Default::default()));
            if !events.is_object() {
                *events = Value::Object(Default::default());
            }
            events.as_object_mut().unwrap()
        }
    }
}

/// 只读取「事件表」对象（不改变结构）。
fn events_object(root: &Value, layout: HooksLayout) -> Option<&serde_json::Map<String, Value>> {
    let hooks = root.get("hooks")?.as_object()?;
    match layout {
        HooksLayout::Flat => Some(hooks),
        HooksLayout::NestedEvents => hooks.get("events")?.as_object(),
    }
}

/// 只增删 Task Dock 自己的条目，返回（第三方条目数，Task Dock 事件列表）。
fn apply_specs(root: &mut Value, specs: &[HookSpec], layout: HooksLayout) -> (usize, Vec<String>) {
    let hooks_obj = events_object_mut(root, layout);

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
    (third_party, installed)
}

/// 写后语义校验：文件可解析，且每个 spec 事件下确实存在 Task Dock 条目。
fn verify_applied(path: &Path, specs: &[HookSpec], layout: HooksLayout) -> bool {
    let Ok(Some(root)) = read_json(path) else {
        return false;
    };
    let Some(hooks) = events_object(&root, layout) else {
        return false;
    };
    specs.iter().all(|s| {
        hooks
            .get(&s.event)
            .and_then(|l| l.as_array())
            .map(|arr| arr.iter().any(is_our_hook))
            .unwrap_or(false)
    })
}

/// 单文件安装（自动备份 + 写后校验 + 失败回滚）。
fn install_one(
    path: &Path,
    specs: &[HookSpec],
    existed: bool,
    bak: Option<&Path>,
    layout: HooksLayout,
) -> AppResult<HooksFileReport> {
    let mut root = validated_root(path)?.unwrap_or_else(|| Value::Object(Default::default()));
    let (third_party, installed) = apply_specs(&mut root, specs, layout);
    let pretty = serde_json::to_string_pretty(&root)?;
    atomic_write(path, &pretty, bak)?;

    if !verify_applied(path, specs, layout) {
        let rollback = match bak {
            Some(b) => restore_from_backup(path, b)
                .map(|_| "，已从备份回滚".to_string())
                .unwrap_or_else(|e| format!("，回滚失败（{}），需人工恢复", e)),
            None => {
                let _ = std::fs::remove_file(path);
                "，已移除本次新建文件".to_string()
            }
        };
        return Err(AppError::Agent(format!(
            "{} 写入后校验失败{}",
            path.display(),
            rollback
        )));
    }

    Ok(HooksFileReport {
        path: path.to_string_lossy().to_string(),
        existed_before: existed,
        third_party_entries: third_party,
        installed_events: installed,
        backup: bak.map(|b| b.to_string_lossy().to_string()),
        valid_json_after_write: true,
    })
}

/// 安装（或幂等更新）Task Dock hooks，保留全部第三方配置。
pub fn install_hooks(path: &Path, specs: &[HookSpec]) -> AppResult<HooksFileReport> {
    install_hooks_with(path, specs, HooksLayout::Flat)
}

/// 按指定布局安装 hooks。
pub fn install_hooks_with(
    path: &Path,
    specs: &[HookSpec],
    layout: HooksLayout,
) -> AppResult<HooksFileReport> {
    validate_specs(specs)?;
    let existed = path.exists();
    let _ = validated_root(path)?;
    let bak = backup(path)?;
    install_one(path, specs, existed, bak.as_deref(), layout)
}

/// 多配置文件事务化安装（Trae 国际/CN、WorkBuddy 多配置根）。
///
/// 任一步失败时按快照恢复**全部**目标文件；恢复失败逐项如实报告，
/// 不会把「部分写入」伪装成成功，也不会删除第三方 hooks。
pub fn install_hooks_set(paths: &[PathBuf], specs: &[HookSpec]) -> AppResult<Vec<HooksFileReport>> {
    install_hooks_set_with(paths, specs, HooksLayout::Flat)
}

/// 按指定布局执行多配置文件事务化安装。
pub fn install_hooks_set_with(
    paths: &[PathBuf],
    specs: &[HookSpec],
    layout: HooksLayout,
) -> AppResult<Vec<HooksFileReport>> {
    validate_specs(specs)?;
    if paths.is_empty() {
        return Err(AppError::Agent("没有可写入的 hooks 配置文件".into()));
    }
    // 预校验所有目标：任一文件损坏或顶层非对象，整体拒绝，绝不先写一半。
    for p in paths {
        validated_root(p)
            .map_err(|e| AppError::Agent(format!("预检查失败，未写入任何文件：{}", e)))?;
    }

    // 统一快照（备份文件独立于事务；失败后仍可用于人工恢复）。
    let mut snapshots: Vec<(PathBuf, bool, Option<PathBuf>)> = Vec::new();
    for p in paths {
        let existed = p.exists();
        let bak = backup(p)?;
        snapshots.push((p.clone(), existed, bak));
    }

    let mut reports = Vec::new();
    for (idx, p) in paths.iter().enumerate() {
        let (_, existed, bak) = &snapshots[idx];
        match install_one(p, specs, *existed, bak.as_deref(), layout) {
            Ok(r) => reports.push(r),
            Err(e) => {
                let mut restored = 0usize;
                let mut failed: Vec<String> = Vec::new();
                for (sp, sp_existed, sp_bak) in &snapshots {
                    let outcome = match sp_bak {
                        Some(b) => restore_from_backup(sp, b),
                        None if !*sp_existed => {
                            if sp.exists() {
                                std::fs::remove_file(sp)
                            } else {
                                Ok(())
                            }
                        }
                        None => Ok(()),
                    };
                    match outcome {
                        Ok(()) => restored += 1,
                        Err(x) => failed.push(format!("{}（{}）", sp.display(), x)),
                    }
                }
                let detail = if failed.is_empty() {
                    format!("已按快照恢复全部 {} 个配置文件", restored)
                } else {
                    format!(
                        "已恢复 {} 个文件；{} 个恢复失败：{}",
                        restored,
                        failed.len(),
                        failed.join("；")
                    )
                };
                return Err(AppError::Agent(format!(
                    "{} 安装失败：{}；{}",
                    p.display(),
                    e,
                    detail
                )));
            }
        }
    }
    Ok(reports)
}

/// 移除事件表中的 Task Dock 条目并清理空事件键，返回移除的事件与第三方条目数。
fn strip_our_hooks(
    events: &mut serde_json::Map<String, Value>,
    removed_events: &mut Vec<String>,
    third_party: &mut usize,
) {
    let mut empty_events = Vec::new();
    for (event, list) in events.iter_mut() {
        if let Some(arr) = list.as_array_mut() {
            let before = arr.len();
            arr.retain(|g| !is_our_hook(g));
            if arr.len() < before {
                removed_events.push(event.clone());
            }
            *third_party += arr.len();
            if arr.is_empty() {
                empty_events.push(event.clone());
            }
        }
    }
    for e in empty_events {
        events.remove(&e);
    }
}

/// 卸载 Task Dock hooks：只删自己的条目，保留第三方；清理空组。
pub fn uninstall_hooks(path: &Path) -> AppResult<HooksFileReport> {
    uninstall_hooks_with(path, HooksLayout::Flat)
}

/// 按指定布局卸载 Task Dock hooks。
///
/// NestedEvents 下只清理 `hooks.events` 中的自身条目与空事件键；
/// `hooks.enabled` 及 `timeoutMs` / `maxOutputBytes` 等用户级设置原样保留。
pub fn uninstall_hooks_with(path: &Path, layout: HooksLayout) -> AppResult<HooksFileReport> {
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
        match layout {
            HooksLayout::Flat => {
                strip_our_hooks(hooks, &mut removed_events, &mut third_party);
            }
            HooksLayout::NestedEvents => {
                if let Some(events) = hooks.get_mut("events").and_then(|v| v.as_object_mut()) {
                    strip_our_hooks(events, &mut removed_events, &mut third_party);
                }
                // 事件表清空后移除空对象，保留用户自己的 enabled / 其他字段。
                if hooks
                    .get("events")
                    .and_then(|v| v.as_object())
                    .is_some_and(|m| m.is_empty())
                {
                    hooks.remove("events");
                }
            }
        }
        if hooks.is_empty() {
            if let Some(obj) = root.as_object_mut() {
                obj.remove("hooks");
            }
        }
    }

    let pretty = serde_json::to_string_pretty(&root)?;
    atomic_write(path, &pretty, bak.as_deref())?;

    // 写后校验：必须可解析，且确实不再包含任何 Task Dock 条目。
    let mut valid = read_json(path)?.is_some();
    if valid {
        if let Some(v) = read_json(path)? {
            if let Some(events) = events_object(&v, layout) {
                if events
                    .values()
                    .filter_map(|l| l.as_array())
                    .any(|arr| arr.iter().any(is_our_hook))
                {
                    valid = false;
                }
            }
        }
    }
    if !valid {
        if let Some(b) = bak.as_deref() {
            let restored = restore_from_backup(path, b)
                .map(|_| "已从备份回滚".to_string())
                .unwrap_or_else(|e| format!("回滚失败（{}），需人工恢复", e));
            return Err(AppError::Agent(format!(
                "{} 卸载后校验失败；{}",
                path.display(),
                restored
            )));
        }
    }

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
    status_hooks_with(path, events, HooksLayout::Flat)
}

/// 按指定布局检查 hooks 状态。
pub fn status_hooks_with(path: &Path, events: &[&str], layout: HooksLayout) -> AppResult<Value> {
    let mut registered: Vec<String> = Vec::new();
    let mut third_party = 0usize;
    let mut valid_json = true;
    let mut existed = false;
    let mut hooks_enabled: Option<bool> = None;
    if let Some(root) = read_json(path)? {
        existed = true;
        if let Some(events_map) = events_object(&root, layout) {
            for ev in events {
                if let Some(arr) = events_map.get(*ev).and_then(|l| l.as_array()) {
                    let ours = arr.iter().any(is_our_hook);
                    third_party += arr.iter().filter(|g| !is_our_hook(g)).count();
                    if ours {
                        registered.push(ev.to_string());
                    }
                }
            }
        }
        if layout == HooksLayout::NestedEvents {
            hooks_enabled = root
                .get("hooks")
                .and_then(|h| h.get("enabled"))
                .and_then(|v| v.as_bool());
        }
    } else {
        valid_json = false;
    }
    let mut out = serde_json::json!({
        "path": path.to_string_lossy(),
        "exists": existed,
        "valid_json": valid_json,
        "registered_events": registered,
        "expected_events": events,
        "third_party_entries": third_party,
    });
    if layout == HooksLayout::NestedEvents {
        out["hooks_enabled"] = serde_json::json!(hooks_enabled);
        out["enabled_required"] = serde_json::json!(true);
    }
    Ok(out)
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

/// Codex 专用 hook 命令行。
///
/// Codex 在 Windows 上把 command 交给 `cmd` 执行，且不会像 Claude 兼容产品那样
/// 自行剥离引号：命令以 `"` 开头时，cmd 会把引号当作路径的一部分，
/// 导致 `hook: <Event> Failed`（0.165.0-alpha.1.2 实测）。
/// `cmd /c call "<exe>" ...` 让 cmd 二次解析参数，带空格的安装路径也能正确执行，
/// 且比 `powershell -Command` 少约 300ms 冷启动。
pub fn codex_hook_command(exe: &Path, source_id: &str, event: &str) -> String {
    format!(
        "cmd.exe /c call \"{}\" {} --source {} --event {}",
        exe.to_string_lossy(),
        MARKER,
        source_id,
        event
    )
}

/// Trae 专用 hook 命令行。
///
/// Trae 宿主如何执行 `command` 无法从客户端包内确认（本机 Trae CN 1.107.1 包内
/// 未发现本地 hook 执行器），因此命令必须同时满足三种可能的解析方式：
/// - **cmd / Node `child_process`**：以 `"` 开头的命令会被 cmd 当作路径的一部分；
/// - **PowerShell**：`"<exe>" --agent-hook` 不是函数式调用，实测报
///   `Unexpected token '--agent-hook'` / `'--' 运算符仅适用于变量或属性`；
/// - **直接 CreateProcess（lpApplicationName = NULL）**：首 token 必须可解析。
///
/// `C:\Windows\System32\cmd.exe /c call "<exe>" ...` 三者都成立：cmd 二次解析参数、
/// PowerShell 把无空格的绝对 cmd.exe 当命令、CreateProcess 也能解析首 token。
/// 每个事件只多一层 cmd.exe（约 5ms），不引入 PowerShell 包装。
pub fn trae_hook_command(exe: &Path, source_id: &str, event: &str) -> String {
    let shell = std::env::var("SystemRoot")
        .map(|r| format!("{}\\System32\\cmd.exe", r))
        .unwrap_or_else(|_| "cmd.exe".to_string());
    format!(
        "{} /c call \"{}\" {} --source {} --event {}",
        shell,
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
    use serde_json::json;

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
    fn codex_hook_command_survives_cmd_quote_handling() {
        // Codex 在 Windows 上把 command 交给 cmd 且不剥离引号：
        // 命令不能以 `"` 开头，否则 cmd 会把引号当成路径的一部分（实测 hook: <Event> Failed）。
        let exe = PathBuf::from(r"C:\Program Files\Task Dock\task-dock.exe");
        let cmd = codex_hook_command(&exe, "codex", "Stop");
        assert!(cmd.starts_with("cmd.exe /c call \""), "{}", cmd);
        assert!(cmd.contains("--agent-hook --source codex --event Stop"));
        assert!(!cmd.trim_start().starts_with('"'), "命令不得以引号开头");
    }

    #[test]
    fn generic_hook_command_keeps_claude_compatible_form() {
        let exe = PathBuf::from(r"C:\Program Files\Task Dock\task-dock.exe");
        let cmd = hook_command(&exe, "workbuddy", "Stop");
        assert_eq!(
            cmd,
            r#""C:\Program Files\Task Dock\task-dock.exe" --agent-hook --source workbuddy --event Stop"#
        );
    }

    #[test]
    fn nested_install_enables_hooks_and_preserves_user_config() {
        let dir = tmpdir();
        let path = dir.join("config.json");
        // 模拟 ZCode 用户配置：mcp / 其他 hooks 设置 / 第三方 Stop 组
        std::fs::write(
            &path,
            r#"{
  "mcp": { "servers": {} },
  "hooks": {
    "enabled": false,
    "timeoutMs": 5000,
    "events": {
      "Stop": [ { "hooks": [ { "type": "command", "command": "C:\\third-party.cmd" } ] } ]
    }
  }
}"#,
        )
        .unwrap();

        let r = install_hooks_with(
            &path,
            &[spec("Stop"), spec("SessionStart")],
            HooksLayout::NestedEvents,
        )
        .unwrap();
        assert_eq!(r.third_party_entries, 1, "第三方 Stop 组必须保留");
        assert_eq!(r.installed_events, vec!["Stop", "SessionStart"]);

        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            root["hooks"]["enabled"],
            json!(true),
            "配置式 hooks 必须启用"
        );
        assert_eq!(root["hooks"]["timeoutMs"], json!(5000), "用户级设置保留");
        assert_eq!(root["mcp"]["servers"], json!({}), "其他配置保留");
        assert_eq!(root["hooks"]["events"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            root["hooks"]["events"]["SessionStart"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        // 嵌套布局不得把事件写到 hooks 顶层（ZCode schema 只认 hooks.events）
        assert!(root["hooks"].get("SessionStart").is_none());

        // 幂等
        install_hooks_with(
            &path,
            &[spec("Stop"), spec("SessionStart")],
            HooksLayout::NestedEvents,
        )
        .unwrap();
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(root["hooks"]["events"]["Stop"].as_array().unwrap().len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nested_uninstall_removes_only_ours_and_keeps_enabled() {
        let dir = tmpdir();
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            r#"{"hooks":{"enabled":true,"timeoutMs":5000,"events":{"Stop":[{"hooks":[{"type":"command","command":"C:\\third-party.cmd"}]}]}}}"#,
        )
        .unwrap();
        install_hooks_with(
            &path,
            &[spec("Stop"), spec("SessionStart")],
            HooksLayout::NestedEvents,
        )
        .unwrap();

        let r = uninstall_hooks_with(&path, HooksLayout::NestedEvents).unwrap();
        let mut removed = r.installed_events.clone();
        removed.sort();
        assert_eq!(removed, vec!["SessionStart", "Stop"]);
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // 第三方组保留；Task Dock 的 SessionStart 事件被清理
        assert_eq!(root["hooks"]["events"]["Stop"].as_array().unwrap().len(), 1);
        assert!(root["hooks"]["events"].get("SessionStart").is_none());
        // enabled / timeoutMs 属于用户配置，不因卸载被删除
        assert_eq!(root["hooks"]["enabled"], json!(true));
        assert_eq!(root["hooks"]["timeoutMs"], json!(5000));

        // 只有 Task Dock 条目时，卸载后移除空 events 对象
        let only_ours = dir.join("only-ours.json");
        std::fs::write(&only_ours, r#"{"hooks":{"enabled":true,"events":{}}}"#).unwrap();
        install_hooks_with(&only_ours, &[spec("Stop")], HooksLayout::NestedEvents).unwrap();
        uninstall_hooks_with(&only_ours, HooksLayout::NestedEvents).unwrap();
        let root: Value =
            serde_json::from_str(&std::fs::read_to_string(&only_ours).unwrap()).unwrap();
        assert!(root["hooks"].get("events").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nested_status_reports_enabled_state() {
        let dir = tmpdir();
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"hooks":{"enabled":false,"events":{}}}"#).unwrap();
        let status = status_hooks_with(&path, &["Stop"], HooksLayout::NestedEvents).unwrap();
        assert_eq!(status["hooks_enabled"], json!(false));
        assert_eq!(status["enabled_required"], json!(true));
        install_hooks_with(&path, &[spec("Stop")], HooksLayout::NestedEvents).unwrap();
        let status = status_hooks_with(&path, &["Stop"], HooksLayout::NestedEvents).unwrap();
        assert_eq!(status["hooks_enabled"], json!(true));
        assert_eq!(status["registered_events"], json!(["Stop"]));
        std::fs::remove_dir_all(&dir).ok();
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
    fn replace_failure_rolls_back_original_and_reports_rollback() {
        let dir = tmpdir();
        let path = dir.join("hooks.json");
        let original = r#"{"hooks":{"Stop":[{"hooks":[{"command":"third-party"}]}]}}"#;
        std::fs::write(&path, original).unwrap();

        inject_replace_failure_after(1);
        let err = install_hooks(&path, &[spec("Stop")]).unwrap_err();
        inject_replace_failure_after(0);

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            original,
            "替换失败后必须恢复原始内容"
        );
        let msg = err.to_string();
        assert!(msg.contains("回滚"), "错误必须如实说明回滚结果: {msg}");
        assert!(!msg.contains("回滚失败"), "本次注入的回滚应成功: {msg}");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不得遗留临时文件");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn multi_file_prevalidation_prevents_partial_write() {
        let dir = tmpdir();
        let good = dir.join("a.json");
        let bad = dir.join("b.json");
        std::fs::write(&good, r#"{"hooks":{}}"#).unwrap();
        std::fs::write(&bad, "{ not json !!!").unwrap();

        let err = install_hooks_set(&[good.clone(), bad.clone()], &[spec("Stop")]).unwrap_err();
        assert!(err.to_string().contains("预检查"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&good).unwrap(),
            r#"{"hooks":{}}"#,
            "预检查失败时不得写入第一个文件"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn multi_file_failure_restores_every_target() {
        let dir = tmpdir();
        let a = dir.join("a.json");
        let b = dir.join("b.json");
        let a_original = r#"{"hooks":{"Stop":[{"hooks":[{"command":"a-third"}]}]}}"#;
        let b_original = r#"{"hooks":{"Stop":[{"hooks":[{"command":"b-third"}]}]}}"#;
        std::fs::write(&a, a_original).unwrap();
        std::fs::write(&b, b_original).unwrap();

        // 第 1 次替换成功（a），第 2 次失败（b）→ 必须把 a、b 都恢复到快照。
        inject_replace_failure_after(2);
        let err = install_hooks_set(&[a.clone(), b.clone()], &[spec("Stop")]).unwrap_err();
        inject_replace_failure_after(0);

        assert_eq!(std::fs::read_to_string(&a).unwrap(), a_original);
        assert_eq!(std::fs::read_to_string(&b).unwrap(), b_original);
        assert!(
            err.to_string().contains("恢复"),
            "错误必须说明一致性恢复结果: {err}"
        );
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

    /// 编译产物中的主程序（target/{debug,release}/task-dock.exe）。
    #[cfg(windows)]
    fn built_app_binary() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let base = exe.parent()?.parent()?;
        ["task-dock.exe", "task_dock.exe"]
            .iter()
            .map(|n| base.join(n))
            .find(|p| p.exists())
    }

    /// 真实执行：命令必须能被 PowerShell 解析并真正拉起 hook 进程（不是字符串比较）。
    /// 覆盖带空格 + 中文的安装路径，与本机 Trae CN 实际目录形态一致。
    #[cfg(windows)]
    #[test]
    fn trae_hook_command_really_executes_from_powershell() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let Some(bin) = built_app_binary() else {
            eprintln!("跳过：未找到 task-dock.exe（cargo test 应已构建 bin）");
            return;
        };
        let dir = tmpdir().join("Trae CN 工作 目录");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("task-dock.exe");
        std::fs::copy(&bin, &target).unwrap();

        let cmd = trae_hook_command(&target, "trae", "SessionStart");
        assert!(cmd.contains("/c call \""), "{}", cmd);
        assert!(!cmd.trim_start().starts_with('"'), "不得以引号开头");

        let data = tmpdir();
        let payload =
            r#"{"hook_event_name":"SessionStart","session_id":"win-exec-test","cwd":"C:\\"}"#;
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
            .env("TASK_DOCK_DATA_DIR", &data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("powershell 应可启动");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "PowerShell 执行失败: status={:?} stderr={}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data).ok();
    }
}
