//! 系统级快捷键注册器抽象。
//!
//! 真实实现包一层 global-shortcut 插件；测试用假注册器模拟「被占用」「注销失败」，
//! 让安全替换/回滚流程可以脱离操作系统验证。

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegisterError {
    /// 组合已被系统或其他程序占用（插件报 already registered）。
    Occupied(String),
    /// 其他注册失败（系统拒绝、主线程通信失败等）。
    Failed(String),
}

impl RegisterError {
    pub fn message(&self) -> &str {
        match self {
            Self::Occupied(message) | Self::Failed(message) => message,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Occupied(_) => "occupied",
            Self::Failed(_) => "register_failed",
        }
    }
}

pub trait ShortcutRegistrar: Send + Sync {
    fn register(&self, accelerator: &str) -> Result<(), RegisterError>;
    fn unregister(&self, accelerator: &str) -> Result<(), String>;
    fn is_registered(&self, accelerator: &str) -> bool;
}

pub struct TauriRegistrar {
    app: AppHandle,
}

impl TauriRegistrar {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

fn parse(accelerator: &str) -> Result<Shortcut, String> {
    // 配置统一使用 `Meta`；插件解析器只接受 `Super`。
    crate::hotkeys::model::to_plugin_accelerator(accelerator)
        .parse::<Shortcut>()
        .map_err(|e| format!("无法解析快捷键「{accelerator}」：{e}"))
}

fn classify(error: tauri_plugin_global_shortcut::Error) -> RegisterError {
    let raw = error.to_string();
    let lower = raw.to_ascii_lowercase();
    if lower.contains("already registered") {
        // 插件原文会带 `HotKey { mods: ..., key: ..., id: ... }` 内部 Debug 噪声，
        // 对用户和诊断中心没有价值（组合名已由 accelerator 字段记录）。
        RegisterError::Occupied("该组合已被其他程序占用".into())
    } else if lower.contains("unable to register") {
        RegisterError::Occupied("系统拒绝注册（可能已被其他程序占用）".into())
    } else {
        RegisterError::Failed(raw)
    }
}

impl ShortcutRegistrar for TauriRegistrar {
    fn register(&self, accelerator: &str) -> Result<(), RegisterError> {
        let shortcut = parse(accelerator).map_err(RegisterError::Failed)?;
        self.app
            .global_shortcut()
            .register(shortcut)
            .map_err(classify)
    }

    fn unregister(&self, accelerator: &str) -> Result<(), String> {
        let shortcut = parse(accelerator)?;
        self.app
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|e| format!("注销失败：{e}"))
    }

    fn is_registered(&self, accelerator: &str) -> bool {
        match parse(accelerator) {
            Ok(shortcut) => self.app.global_shortcut().is_registered(shortcut),
            Err(_) => false,
        }
    }
}
