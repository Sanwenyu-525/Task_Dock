//! 快捷键动作模型、组合规范化与冲突检测。
//!
//! 本文件只做纯逻辑（不接触窗口/注册器），便于脱离 Tauri 运行单元测试：
//! - **稳定动作 ID**：配置只保存 `action`，不保存导航位置或索引；
//! - **新增动作不漂移**：加载时按 `ACTIONS` 顺序为缺失动作补默认值，旧动作的组合与顺序不变；
//! - **规范化**：统一输出 `Ctrl+Alt+Shift+Meta+Key` 顺序，前后端共用同一套展示格式。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 配置文件版本；仅用于诊断，不做强制迁移（缺省/更高版本都会按动作 ID 合并）。
pub const CONFIG_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotkeyScope {
    /// 仅 Task Dock 窗口获得焦点时生效（前端 keydown 分发）。
    AppLocal,
    /// 操作系统级常驻注册，其他程序在前台时仍生效。
    SystemGlobal,
}

impl HotkeyScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AppLocal => "app_local",
            Self::SystemGlobal => "system_global",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HotkeyBinding {
    pub action: String,
    pub scope: HotkeyScope,
    pub accelerator: String,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct ActionDef {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub scope: HotkeyScope,
    pub default_accelerator: &'static str,
}

const fn app(
    id: &'static str,
    label: &'static str,
    description: &'static str,
    default_accelerator: &'static str,
) -> ActionDef {
    ActionDef {
        id,
        label,
        description,
        scope: HotkeyScope::AppLocal,
        default_accelerator,
    }
}

const fn system(
    id: &'static str,
    label: &'static str,
    description: &'static str,
    default_accelerator: &'static str,
) -> ActionDef {
    ActionDef {
        id,
        label,
        description,
        scope: HotkeyScope::SystemGlobal,
        default_accelerator,
    }
}

/// 动作清单（顺序即 UI 展示顺序；不含 `apps` 入口，避免 Ctrl+数字语义漂移）。
pub const ACTIONS: &[ActionDef] = &[
    system(
        "toggle_main_window",
        "显示 / 隐藏主窗口",
        "系统级：其他程序在前台时也能唤出或收起主窗口",
        "Ctrl+Alt+T",
    ),
    system(
        "open_quick_capture",
        "打开快速捕获窗口",
        "系统级：其他程序在前台时也能唤起快速捕获",
        "Ctrl+Shift+Space",
    ),
    system(
        "collect_to_shelf",
        "收集当前剪贴板到暂存架",
        "系统级：在其他程序复制后，一键读取当前剪贴板并写入暂存架",
        "Ctrl+Alt+G",
    ),
    app(
        "quick_add_task",
        "快速添加任务",
        "应用内：窗口聚焦时打开快速添加输入",
        "Ctrl+K",
    ),
    app(
        "open_clipboard",
        "打开剪贴板",
        "应用内：完整模式切到剪贴板页，紧凑 / 极简模式开关抽屉",
        "Ctrl+Shift+C",
    ),
    app(
        "switch_tab_tasks",
        "切换到任务",
        "应用内：完整模式下切到任务页",
        "Ctrl+1",
    ),
    app(
        "switch_tab_agents",
        "切换到 Agent",
        "应用内：完整模式下切到 Agent 页",
        "Ctrl+2",
    ),
    app(
        "switch_tab_actions",
        "切换到行动",
        "应用内：完整模式下切到行动页",
        "Ctrl+3",
    ),
    app(
        "switch_tab_clipboard",
        "切换到剪贴板页",
        "应用内：完整模式下切到剪贴板页",
        "Ctrl+4",
    ),
    app(
        "switch_tab_inbox",
        "切换到收集箱",
        "应用内：完整模式下切到收集箱子页",
        "Ctrl+5",
    ),
    app(
        "switch_tab_shelf",
        "切换到文件暂存",
        "应用内：完整模式下切到文件暂存子页",
        "Ctrl+6",
    ),
    app(
        "switch_tab_workflows",
        "切换到工作流",
        "应用内：完整模式下切到工作流页",
        "Ctrl+7",
    ),
    app(
        "switch_tab_history",
        "切换到历史",
        "应用内：完整模式下切到历史页",
        "Ctrl+8",
    ),
    app(
        "switch_tab_roadmap",
        "切换到规划中心",
        "应用内：完整模式下切到规划中心页",
        "Ctrl+9",
    ),
    app(
        "switch_tab_settings",
        "切换到设置",
        "应用内：完整模式下切到设置页",
        "Ctrl+0",
    ),
];

pub fn find_def(action: &str) -> Option<&'static ActionDef> {
    ACTIONS.iter().find(|d| d.id == action)
}

/// 默认绑定；`legacy_system_enabled` 对应旧版 `hotkey_enabled` 设置。
pub fn default_bindings(legacy_system_enabled: bool) -> Vec<HotkeyBinding> {
    ACTIONS
        .iter()
        .map(|def| HotkeyBinding {
            action: def.id.to_string(),
            scope: def.scope,
            accelerator: def.default_accelerator.to_string(),
            enabled: def.scope == HotkeyScope::AppLocal || legacy_system_enabled,
        })
        .collect()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HotkeyConfigFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub bindings: Vec<HotkeyBinding>,
}

impl HotkeyConfigFile {
    pub fn from_bindings(bindings: &[HotkeyBinding]) -> Self {
        Self {
            version: CONFIG_VERSION,
            bindings: bindings.to_vec(),
        }
    }
}

/// 合并已保存配置与当前动作清单。
///
/// 返回的 `issues` 是可展示的中文提示（配置损坏 / 未知动作 / 重复组合等），
/// 不把任何失败静默吞掉。
pub fn build_bindings(
    saved: Option<&HotkeyConfigFile>,
    legacy_system_enabled: Option<bool>,
) -> (Vec<HotkeyBinding>, Vec<String>) {
    let mut issues = Vec::new();
    let mut saved_by_action: HashMap<&str, &HotkeyBinding> = HashMap::new();
    if let Some(file) = saved {
        for binding in &file.bindings {
            saved_by_action.insert(binding.action.as_str(), binding);
        }
        for binding in &file.bindings {
            if find_def(&binding.action).is_none() {
                issues.push(format!(
                    "配置中的快捷键动作「{}」已不存在，已忽略",
                    binding.action
                ));
            }
        }
    }

    let mut out = Vec::with_capacity(ACTIONS.len());
    for def in ACTIONS {
        let mut binding = HotkeyBinding {
            action: def.id.to_string(),
            scope: def.scope,
            accelerator: def.default_accelerator.to_string(),
            enabled: true,
        };
        if let Some(s) = saved_by_action.get(def.id) {
            match validate_accelerator(&s.accelerator) {
                Ok(accelerator) => binding.accelerator = accelerator,
                Err(message) => issues.push(format!(
                    "「{}」的组合「{}」无效（{}），已回退默认 {}",
                    def.label, s.accelerator, message, def.default_accelerator
                )),
            }
            binding.enabled = s.enabled;
        } else if saved.is_none() {
            if let Some(enabled) = legacy_system_enabled {
                if def.scope == HotkeyScope::SystemGlobal {
                    binding.enabled = enabled;
                }
            }
        }
        // 作用域由动作定义决定，绝不信任配置文件里的 scope（避免旧配置改写语义）。
        binding.scope = def.scope;
        out.push(binding);
    }

    // 重复组合：后出现的启用项自动禁用并明确提示，避免一个按键触发两个动作。
    let mut seen: Vec<(String, String, String)> = Vec::new();
    for binding in out.iter_mut() {
        if !binding.enabled {
            continue;
        }
        if let Some((other_action, other_accel, _)) = seen
            .iter()
            .find(|(_, accelerator, _)| accelerator == &binding.accelerator)
        {
            let other_label = find_def(other_action)
                .map(|d| d.label)
                .unwrap_or(other_action.as_str());
            issues.push(format!(
                "「{}」与「{}」使用了相同组合 {}，已自动禁用「{}」",
                find_def(&binding.action)
                    .map(|d| d.label)
                    .unwrap_or("未知动作"),
                other_label,
                other_accel,
                find_def(&binding.action)
                    .map(|d| d.label)
                    .unwrap_or("未知动作")
            ));
            binding.enabled = false;
        } else {
            seen.push((
                binding.action.clone(),
                binding.accelerator.clone(),
                binding.scope.as_str().to_string(),
            ));
        }
    }

    (out, issues)
}

const LETTERS: [&str; 26] = [
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S",
    "T", "U", "V", "W", "X", "Y", "Z",
];
const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const FUNCTION_KEYS: [&str; 24] = [
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15",
    "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
];
const NAMED_KEYS: &[(&str, &str)] = &[
    ("SPACE", "Space"),
    ("TAB", "Tab"),
    ("ENTER", "Enter"),
    ("RETURN", "Enter"),
    ("ESC", "Escape"),
    ("ESCAPE", "Escape"),
    ("BACKSPACE", "Backspace"),
    ("DELETE", "Delete"),
    ("DEL", "Delete"),
    ("INSERT", "Insert"),
    ("INS", "Insert"),
    ("HOME", "Home"),
    ("END", "End"),
    ("PAGEUP", "PageUp"),
    ("PGUP", "PageUp"),
    ("PAGEDOWN", "PageDown"),
    ("PGDN", "PageDown"),
    ("UP", "Up"),
    ("ARROWUP", "Up"),
    ("DOWN", "Down"),
    ("ARROWDOWN", "Down"),
    ("LEFT", "Left"),
    ("ARROWLEFT", "Left"),
    ("RIGHT", "Right"),
    ("ARROWRIGHT", "Right"),
];

/// 系统保留组合：不允许注册，录制阶段即拒绝。
pub const RESERVED_ACCELERATORS: &[(&str, &str)] = &[
    ("Ctrl+Alt+Delete", "Windows 安全组合键"),
    ("Ctrl+Shift+Escape", "Windows 任务管理器组合键"),
    ("Alt+Tab", "Windows 任务切换组合键"),
    ("Alt+F4", "Windows 关闭窗口组合键"),
    ("Ctrl+Escape", "Windows 开始菜单组合键"),
    ("Meta+L", "Windows 锁屏组合键"),
    ("Meta+D", "Windows 显示桌面组合键"),
    ("Meta+E", "Windows 资源管理器组合键"),
    ("Meta+R", "Windows 运行组合键"),
    ("Meta+Tab", "Windows 任务视图组合键"),
    ("Ctrl+Shift+F", "全局搜索模块占用"),
];

pub fn reserved_reason(accelerator: &str) -> Option<&'static str> {
    RESERVED_ACCELERATORS
        .iter()
        .find(|(accel, _)| *accel == accelerator)
        .map(|(_, reason)| *reason)
}

/// 语法规范化（不检查系统保留）：统一修饰键顺序，并校验主键在白名单内。
pub fn normalize_accelerator(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("快捷键不能为空".to_string());
    }
    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut key: Option<&'static str> = None;

    for token in raw.split('+') {
        let token = token.trim();
        if token.is_empty() {
            return Err(format!("无法解析的快捷键「{raw}」"));
        }
        match token.to_ascii_uppercase().as_str() {
            "CTRL" | "CONTROL" => ctrl = true,
            "ALT" | "OPTION" => alt = true,
            "SHIFT" => shift = true,
            "META" | "SUPER" | "CMD" | "COMMAND" | "WIN" => meta = true,
            other => {
                if key.is_some() {
                    return Err(format!(
                        "「{raw}」包含多个主键；请按「修饰键+一个主键」录制"
                    ));
                }
                key = Some(normalize_key(other)?);
            }
        }
    }

    if !ctrl && !alt && !shift && !meta {
        return Err("快捷键必须包含至少一个修饰键（Ctrl / Alt / Shift / Meta）".to_string());
    }
    let key = key.ok_or_else(|| "快捷键缺少主键（例如 K、1、F5）".to_string())?;
    let mut parts: Vec<&str> = Vec::new();
    if ctrl {
        parts.push("Ctrl");
    }
    if alt {
        parts.push("Alt");
    }
    if shift {
        parts.push("Shift");
    }
    if meta {
        parts.push("Meta");
    }
    parts.push(key);
    let canonical = parts.join("+");

    // 交给插件解析器再校验一次，避免前后端白名单与 OS 注册器不一致。
    // global-hotkey 用 `SUPER` 表示 Windows 键，这里先把展示用的 `Meta` 转成插件写法。
    if to_plugin_accelerator(&canonical)
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .is_err()
    {
        return Err(format!("不支持的按键组合「{canonical}」"));
    }
    Ok(canonical)
}

/// 配置与 UI 统一使用 `Meta`（Windows 键）；注册器解析需要 `Super`。
pub fn to_plugin_accelerator(accelerator: &str) -> String {
    accelerator.replace("Meta+", "Super+")
}

/// 完整校验：语法 + 系统保留组合。
pub fn validate_accelerator(raw: &str) -> Result<String, String> {
    let canonical = normalize_accelerator(raw)?;
    if let Some(reason) = reserved_reason(&canonical) {
        return Err(format!("{canonical} 是系统保留组合（{reason}），不能注册"));
    }
    Ok(canonical)
}

fn normalize_key(token: &str) -> Result<&'static str, String> {
    let upper = token.to_ascii_uppercase();
    if let Some(found) = LETTERS.iter().find(|key| **key == upper) {
        return Ok(found);
    }
    if let Some(found) = DIGITS.iter().find(|key| **key == upper) {
        return Ok(found);
    }
    if let Some(found) = FUNCTION_KEYS.iter().find(|key| **key == upper) {
        return Ok(found);
    }
    if let Some((_, display)) = NAMED_KEYS.iter().find(|(alias, _)| *alias == upper) {
        return Ok(display);
    }
    Err(format!(
        "不支持的按键「{token}」；支持字母、数字、F1-F24 与常用控制键"
    ))
}

/// 查找与候选组合冲突的已启用绑定（跨应用内/系统级都算冲突，避免同一按键触发两次）。
pub fn conflict_with<'a>(
    bindings: &'a [HotkeyBinding],
    action: &str,
    accelerator: &str,
) -> Option<&'a HotkeyBinding> {
    bindings
        .iter()
        .find(|b| b.action != action && b.enabled && b.accelerator == accelerator)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(action: &str, accelerator: &str, enabled: bool) -> HotkeyBinding {
        HotkeyBinding {
            action: action.to_string(),
            scope: find_def(action)
                .map(|d| d.scope)
                .unwrap_or(HotkeyScope::AppLocal),
            accelerator: accelerator.to_string(),
            enabled,
        }
    }

    #[test]
    fn defaults_are_complete_and_unique() {
        let bindings = default_bindings(true);
        assert_eq!(bindings.len(), ACTIONS.len());
        let mut accelerators = std::collections::HashSet::new();
        for binding in &bindings {
            assert!(
                validate_accelerator(&binding.accelerator).is_ok(),
                "{}",
                binding.action
            );
            assert!(binding.enabled);
            assert!(
                accelerators.insert(binding.accelerator.clone()),
                "重复: {}",
                binding.accelerator
            );
            let def = find_def(&binding.action).unwrap();
            assert_eq!(binding.scope, def.scope);
            assert_eq!(binding.accelerator, def.default_accelerator);
        }
        // 契约：动作 ID 必须稳定，新增入口不得挤占已有数字键。
        assert_eq!(
            find_def("switch_tab_tasks").unwrap().default_accelerator,
            "Ctrl+1"
        );
        assert_eq!(
            find_def("switch_tab_settings").unwrap().default_accelerator,
            "Ctrl+0"
        );
        assert!(find_def("switch_tab_apps").is_none());
    }

    #[test]
    fn legacy_switch_only_disables_system_scope() {
        let bindings = default_bindings(false);
        for binding in &bindings {
            let expected = binding.scope == HotkeyScope::AppLocal;
            assert_eq!(binding.enabled, expected, "{}", binding.action);
        }
    }

    #[test]
    fn saved_config_keeps_user_binding_and_appends_new_actions() {
        let saved = HotkeyConfigFile {
            version: CONFIG_VERSION,
            bindings: vec![binding("quick_add_task", "Ctrl+Shift+K", true)],
        };
        let (bindings, issues) = build_bindings(Some(&saved), Some(false));
        assert!(issues.is_empty());
        assert_eq!(bindings.len(), ACTIONS.len());
        assert_eq!(
            bindings[0].action, ACTIONS[0].id,
            "顺序按动作清单，不受旧配置影响"
        );
        let quick_add = bindings
            .iter()
            .find(|b| b.action == "quick_add_task")
            .unwrap();
        assert_eq!(quick_add.accelerator, "Ctrl+Shift+K");
        // 旧配置未包含的系统动作补默认值；旧版开关不应覆盖已有文件。
        let toggle = bindings
            .iter()
            .find(|b| b.action == "toggle_main_window")
            .unwrap();
        assert!(toggle.enabled);
        assert_eq!(toggle.accelerator, "Ctrl+Alt+T");
    }

    #[test]
    fn invalid_saved_accelerator_falls_back_with_issue() {
        let saved = HotkeyConfigFile {
            version: CONFIG_VERSION,
            bindings: vec![binding("quick_add_task", "Ctrl", true)],
        };
        let (bindings, issues) = build_bindings(Some(&saved), None);
        assert_eq!(issues.len(), 1);
        assert!(issues[0].contains("已回退默认"));
        let quick_add = bindings
            .iter()
            .find(|b| b.action == "quick_add_task")
            .unwrap();
        assert_eq!(quick_add.accelerator, "Ctrl+K");
    }

    #[test]
    fn duplicate_saved_accelerator_disables_later_action() {
        let saved = HotkeyConfigFile {
            version: CONFIG_VERSION,
            bindings: vec![
                binding("quick_add_task", "Ctrl+Shift+C", true),
                binding("open_clipboard", "Ctrl+Shift+C", true),
            ],
        };
        let (bindings, issues) = build_bindings(Some(&saved), None);
        assert!(issues.iter().any(|i| i.contains("相同组合")));
        let quick_add = bindings
            .iter()
            .find(|b| b.action == "quick_add_task")
            .unwrap();
        let clipboard = bindings
            .iter()
            .find(|b| b.action == "open_clipboard")
            .unwrap();
        assert!(quick_add.enabled);
        assert!(!clipboard.enabled);
    }

    #[test]
    fn unknown_saved_action_is_reported() {
        let saved = HotkeyConfigFile {
            version: CONFIG_VERSION,
            bindings: vec![binding("open_global_search", "Ctrl+Shift+F", true)],
        };
        let (bindings, issues) = build_bindings(Some(&saved), None);
        assert_eq!(bindings.len(), ACTIONS.len());
        assert!(issues.iter().any(|i| i.contains("已不存在")));
    }

    #[test]
    fn normalize_orders_modifiers_and_accepts_case() {
        assert_eq!(
            normalize_accelerator("shift+ctrl+k").unwrap(),
            "Ctrl+Shift+K"
        );
        assert_eq!(normalize_accelerator("Alt + F5").unwrap(), "Alt+F5");
        assert_eq!(normalize_accelerator("win+space").unwrap(), "Meta+Space");
        assert_eq!(normalize_accelerator("Ctrl+Up").unwrap(), "Ctrl+Up");
    }

    #[test]
    fn normalize_rejects_modifier_only_and_missing_modifier() {
        assert!(normalize_accelerator("Ctrl").is_err());
        assert!(normalize_accelerator("Ctrl+Shift").is_err());
        assert!(normalize_accelerator("K").is_err());
        assert!(normalize_accelerator("Ctrl+K+L").is_err());
        assert!(normalize_accelerator("Ctrl+é").is_err());
    }

    #[test]
    fn reserved_combinations_are_rejected() {
        for (accelerator, _) in RESERVED_ACCELERATORS {
            assert!(validate_accelerator(accelerator).is_err(), "{accelerator}");
        }
        assert!(validate_accelerator("Ctrl+Alt+T").is_ok());
    }

    #[test]
    fn conflict_detection_covers_scopes_but_ignores_disabled() {
        let bindings = vec![
            binding("toggle_main_window", "Ctrl+Alt+T", true),
            binding("quick_add_task", "Ctrl+K", true),
            binding("open_clipboard", "Ctrl+K", false),
        ];
        assert!(conflict_with(&bindings, "quick_add_task", "Ctrl+Alt+T").is_some());
        assert!(conflict_with(&bindings, "quick_add_task", "Ctrl+K").is_none());
        assert!(conflict_with(&bindings, "switch_tab_tasks", "Ctrl+K").is_some());
    }
}
