//! Windows 资源管理器「发送到 Task Dock」集成。
//!
//! 采用 **HKCU 动词**（`Software\Classes\*\shell` 与 `Directory\shell`），
//! 不写系统级 HKLM、不改文件关联、不需要管理员权限：
//! - 用户可在暂存架菜单里显式启用/停用，停用即删除本应用创建的键；
//! - 命令固定为 `<当前 exe> --send-to-shelf "%1"`，`MultiSelectModel=Document`
//!   让多选时每个文件各启动一次，由单实例插件转发给已运行实例；
//! - 参数解析只认 `--send-to-shelf` 之后的路径，不把任意 argv 当文件；
//! - 注册表只保存命令字符串，不保存用户文件内容或历史。
//!
//! 真实资源管理器菜单行为必须在 Windows 真机验证；单元测试只覆盖纯函数与
//! 注册表键名/命令生成，不在测试里写用户注册表。

use serde::Serialize;

pub const VERB_KEY: &str = "TaskDockShelf";
pub const VERB_LABEL: &str = "暂存到 Task Dock";
pub const ARG_FLAG: &str = "--send-to-shelf";
pub const MAX_SEND_TO_PATHS: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SendToStatus {
    /// 两个动词都存在且命令指向当前 exe。
    pub enabled: bool,
    /// 当前 exe 路径（只用于展示；不包含用户文件信息）。
    pub exe: String,
    /// 注册表中的 command 值；未启用时为 None。
    pub command: Option<String>,
    /// 部分键存在但命令不匹配（例如程序被移动过）。
    pub stale: bool,
}

/// 只取 `--send-to-shelf` 之后的参数。去重、限长；不在此校验存在性，
/// 让统一入库层逐条报告 NOT_FOUND/权限失败，口径与拖入/文件选择一致。
pub fn paths_from_argv(argv: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut take = false;
    for arg in argv {
        if arg == ARG_FLAG {
            take = true;
            continue;
        }
        if !take {
            continue;
        }
        if arg.starts_with("--") {
            break;
        }
        let trimmed = arg.trim();
        if trimmed.is_empty() {
            continue;
        }
        if out.iter().any(|p| p.eq_ignore_ascii_case(trimmed)) {
            continue;
        }
        out.push(trimmed.to_string());
        if out.len() >= MAX_SEND_TO_PATHS {
            break;
        }
    }
    out
}

/// Windows 命令行引用：exe 与 `%1` 都加双引号；路径里出现双引号直接拒绝。
pub fn quote_command(exe: &str) -> Result<String, String> {
    let trimmed = exe.trim();
    if trimmed.is_empty() {
        return Err("当前程序路径为空".into());
    }
    if trimmed.contains('"') {
        return Err("当前程序路径包含非法引号".into());
    }
    Ok(format!("\"{trimmed}\" {ARG_FLAG} \"%1\""))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    fn verb_paths() -> [&'static str; 2] {
        [
            "Software\\Classes\\*\\shell\\TaskDockShelf",
            "Software\\Classes\\Directory\\shell\\TaskDockShelf",
        ]
    }

    fn current_exe_string() -> Result<String, String> {
        std::env::current_exe()
            .map_err(|e| format!("无法读取当前程序路径: {e}"))
            .map(|p| p.to_string_lossy().to_string())
    }

    fn command_for(exe: &str) -> Result<String, String> {
        quote_command(exe)
    }

    pub fn status() -> SendToStatus {
        let exe = current_exe_string().unwrap_or_default();
        let expected = command_for(&exe).ok();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut present = 0usize;
        let mut matched = 0usize;
        let mut command = None;
        for path in verb_paths() {
            let Ok(key) = hkcu.open_subkey(path) else {
                continue;
            };
            present += 1;
            let Ok(cmd_key) = key.open_subkey("command") else {
                continue;
            };
            let value: String = cmd_key.get_value("").unwrap_or_default();
            if command.is_none() && !value.is_empty() {
                command = Some(value.clone());
            }
            if expected.as_deref() == Some(value.as_str()) {
                matched += 1;
            }
        }
        SendToStatus {
            enabled: present == 2 && matched == 2,
            stale: present > 0 && matched < present,
            exe,
            command,
        }
    }

    pub fn enable() -> Result<SendToStatus, String> {
        let exe = current_exe_string()?;
        let command = command_for(&exe)?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for path in verb_paths() {
            let (verb, _) = hkcu
                .create_subkey(path)
                .map_err(|e| format!("创建右键菜单项失败: {e}"))?;
            verb.set_value("", &VERB_LABEL)
                .map_err(|e| format!("写入菜单名称失败: {e}"))?;
            verb.set_value("Icon", &exe)
                .map_err(|e| format!("写入菜单图标失败: {e}"))?;
            // Document：多选时每个文件各自调用一次，避免只处理第一个。
            verb.set_value("MultiSelectModel", &"Document")
                .map_err(|e| format!("写入多选模式失败: {e}"))?;
            let (cmd, _) = verb
                .create_subkey("command")
                .map_err(|e| format!("创建菜单命令失败: {e}"))?;
            cmd.set_value("", &command)
                .map_err(|e| format!("写入菜单命令失败: {e}"))?;
        }
        Ok(status())
    }

    pub fn disable() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut first_error = None;
        for path in verb_paths() {
            if let Err(e) = hkcu.delete_subkey_all(path) {
                if e.kind() != std::io::ErrorKind::NotFound && first_error.is_none() {
                    first_error = Some(format!("删除右键菜单项失败: {e}"));
                }
            }
        }
        match first_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn status() -> SendToStatus {
        SendToStatus {
            enabled: false,
            exe: String::new(),
            command: None,
            stale: false,
        }
    }

    pub fn enable() -> Result<SendToStatus, String> {
        Err("仅 Windows 支持资源管理器右键发送".into())
    }

    pub fn disable() -> Result<(), String> {
        Err("仅 Windows 支持资源管理器右键发送".into())
    }
}

pub use imp::{disable, enable, status};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_after_flag_dedupes_and_limits() {
        let argv = vec![
            "task-dock.exe".to_string(),
            "--send-to-shelf".to_string(),
            "C:\\a.txt".to_string(),
            "C:\\A.TXT".to_string(),
            "D:\\目录\\b.png".to_string(),
        ];
        assert_eq!(
            paths_from_argv(&argv),
            vec!["C:\\a.txt".to_string(), "D:\\目录\\b.png".to_string()]
        );
        assert!(paths_from_argv(&["task-dock.exe".into(), "C:\\a.txt".into()]).is_empty());
    }

    #[test]
    fn stops_at_next_flag_and_caps_count() {
        let mut argv = vec!["app".into(), ARG_FLAG.into()];
        for i in 0..(MAX_SEND_TO_PATHS + 10) {
            argv.push(format!("C:\\f{i}.txt"));
        }
        argv.push("--other".into());
        assert_eq!(paths_from_argv(&argv).len(), MAX_SEND_TO_PATHS);
    }

    #[test]
    fn command_quotes_exe_and_placeholder() {
        assert_eq!(
            quote_command("C:\\Program Files\\Task Dock\\task-dock.exe").unwrap(),
            "\"C:\\Program Files\\Task Dock\\task-dock.exe\" --send-to-shelf \"%1\""
        );
        assert!(quote_command("").is_err());
        assert!(quote_command("C:\\bad\"path\\app.exe").is_err());
    }
}
