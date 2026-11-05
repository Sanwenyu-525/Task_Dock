//! 用户偏好（语言、桌面微件布局）与快捷键配置的镜像、校验与备份载荷。
//!
//! 运行时权威来源仍是 WebView 的 localStorage（`taskdock.locale` /
//! `taskdock.widgets.layout.v1`）；本模块只做两件事：
//! - 把前端经 bridge 写入的偏好原子落到数据目录 `preferences.json`，供备份打包；
//! - 启动/恢复时把文件内容与 localStorage 对账：缺失时从文件恢复，冲突时
//!   localStorage 优先并回写文件。
//!
//! 备份载荷（`BundleConfig`）作为 bundle **header 的可选 `config` 字段**携带，
//! 而不是新增顶层 record 类型：旧版本读取器遇到未知 record 会整体拒绝备份，
//! 但会忽略 header 里的未知字段。这样「旧版本读新备份」与「新版本读旧备份」
//! 双向都不会因为配置记录被拒；字段缺失时按「无用户配置」处理。
//!
//! 安全边界：配置只包含动作 ID、组合字符串、语言代码与微件展示参数，不含
//! 本机绝对路径、令牌或剪贴板正文；`http_token` 等敏感设置永远不进入这里。

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::hotkeys::model::{find_def, HotkeyBinding, HotkeyConfigFile, CONFIG_VERSION as HOTKEY_CONFIG_VERSION};

pub const PREFERENCES_FILE: &str = "preferences.json";
pub const PREFERENCES_PENDING_FILE: &str = "preferences.restore-pending.json";
pub const CONFIG_VERSION: i64 = 1;
/// 前端收到后重新执行一次「读取并应用」；真正的恢复标志仍是 pending 文件。
pub const EVENT_RESTORED: &str = "user-preferences-restored";

pub const LOCALE_VALUES: &[&str] = &["zh-CN", "en-US", "system"];
pub const WIDGET_SIZES: &[&str] = &["sm", "md", "lg"];
/// 应用网格「添加」伪项 ID，必须与 `src/lib/appGridOrder.ts` 保持一致。
pub const APP_GRID_ADD_KEY: &str = "__taskdock_app_add__";
const APP_GRID_ORDER_MAX: usize = 500;
const APP_GRID_ID_MAX_CHARS: usize = 200;

/// 微件类型与默认值（必须与 `src/lib/widgets/model.ts` 的 WIDGET_DEFINITIONS 一致）。
pub const WIDGET_DEFAULTS: &[(&str, &str, bool)] = &[
    ("today-tasks", "md", true),
    ("next-reminder", "md", true),
    ("agent-status", "md", true),
    ("quick-actions", "md", true),
    ("focus-timer", "sm", false),
    ("efficiency", "sm", false),
];

fn widget_default(kind: &str) -> Option<(&'static str, bool)> {
    WIDGET_DEFAULTS
        .iter()
        .find(|(name, _, _)| *name == kind)
        .map(|(_, size, enabled)| (*size, *enabled))
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_items: Option<i64>,
}

/// 桌面独立窗口配置。位置以归一化锚点（相对显示器工作区 0~1）保存，
/// 不保存物理像素坐标，跨显示器/跨设备恢复时不会把窗口盲放到屏外。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetDesktop {
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub topmost: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nx: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ny: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WidgetItem {
    pub widget_id: String,
    #[serde(rename = "type")]
    pub widget_type: String,
    pub enabled: bool,
    #[serde(default)]
    pub config: WidgetConfig,
    pub size: String,
    pub sort_order: i64,
    /// v1 的增量字段：旧文件缺失时按「不显示桌面窗口」恢复，保持向后兼容。
    #[serde(default)]
    pub desktop: WidgetDesktop,
}

/// 备份包内携带的用户配置（header.config）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BundleConfig {
    #[serde(default)]
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widgets: Option<Vec<WidgetItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkeys: Option<HotkeyConfigFile>,
    /// 应用网格手动顺序（含加号伪项）；缺省表示从未手动排序。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_grid_order: Option<Vec<String>>,
}

impl BundleConfig {
    pub fn is_empty(&self) -> bool {
        self.locale.is_none()
            && self.widgets.is_none()
            && self.hotkeys.is_none()
            && self.app_grid_order.is_none()
    }
}

#[derive(Debug, Clone, Default)]
pub struct LoadedPreferences {
    pub locale: Option<String>,
    pub widgets: Option<Vec<WidgetItem>>,
    pub app_grid_order: Option<Vec<String>>,
    pub warnings: Vec<String>,
}

/// 归一化应用网格排序：与前端 `normalizeAppGridOrder` 同一规则。
///
/// - 只接受字符串；空串/超长 ID（加号伪项除外）丢弃；
/// - 去重（保留首次出现）、保留加号最多一次、上限 500；
/// - 空数组归一化为 `None`，表示「没有手动排序」，不能用空数组清空本机顺序。
pub fn normalize_app_grid_order(raw: &serde_json::Value) -> (Option<Vec<String>>, Vec<String>) {
    let mut warnings = Vec::new();
    let entries: &[serde_json::Value] = match raw {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Null => return (None, warnings),
        _ => {
            warnings.push("应用网格排序不是数组，已忽略".to_string());
            return (None, warnings);
        }
    };
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        let Some(value) = entry.as_str() else {
            warnings.push("应用网格排序包含非字符串条目，已忽略".to_string());
            continue;
        };
        if value.is_empty() {
            continue;
        }
        if value != APP_GRID_ADD_KEY && value.chars().count() > APP_GRID_ID_MAX_CHARS {
            warnings.push("应用网格排序包含超长应用 ID，已忽略".to_string());
            continue;
        }
        if !seen.insert(value.to_string()) {
            continue;
        }
        out.push(value.to_string());
        if out.len() >= APP_GRID_ORDER_MAX {
            warnings.push(format!(
                "应用网格排序超过 {APP_GRID_ORDER_MAX} 项，超出部分已忽略"
            ));
            break;
        }
    }
    if out.is_empty() {
        (None, warnings)
    } else {
        (Some(out), warnings)
    }
}

fn atomic_write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("序列化配置失败：{e}"))?;
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("preferences"),
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    {
        let mut file = fs::File::create(&tmp).map_err(|e| format!("创建临时配置失败：{e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("写入临时配置失败：{e}"))?;
        file.sync_all()
            .map_err(|e| format!("刷新临时配置失败：{e}"))?;
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换配置文件失败：{e}"));
    }
    Ok(())
}

/// 语言偏好归一化：缺失保持缺失；非法值回退简体中文并给出警告。
pub fn normalize_locale(raw: Option<&str>) -> (Option<String>, Vec<String>) {
    match raw {
        None => (None, Vec::new()),
        Some(value) if LOCALE_VALUES.contains(&value) => (Some(value.to_string()), Vec::new()),
        Some(value) => (
            Some("zh-CN".to_string()),
            vec![format!(
                "语言偏好「{}」无效，已回退为简体中文（zh-CN）",
                value
            )],
        ),
    }
}

/// 与前端 normaliseDesktop 同一规则：尺寸限制在可读范围，锚点 0~1，
/// 显示器名截断；非法值直接丢弃，由窗口层按默认层叠位放置。
fn normalize_desktop(raw: Option<&serde_json::Value>) -> WidgetDesktop {
    let Some(obj) = raw.and_then(|value| value.as_object()) else {
        return WidgetDesktop::default();
    };
    let clamp = |key: &str, min: f64, max: f64| -> Option<f64> {
        obj.get(key)
            .and_then(|value| value.as_f64())
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(min, max).round())
    };
    WidgetDesktop {
        visible: obj.get("visible").and_then(|v| v.as_bool()).unwrap_or(false),
        topmost: obj.get("topmost").and_then(|v| v.as_bool()).unwrap_or(false),
        width: clamp("width", 220.0, 560.0),
        height: clamp("height", 120.0, 640.0),
        nx: clamp("nx", 0.0, 1.0),
        ny: clamp("ny", 0.0, 1.0),
        monitor: obj
            .get("monitor")
            .and_then(|v| v.as_str())
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().take(96).collect()),
    }
}

fn normalize_max_items(raw: Option<&serde_json::Value>) -> i64 {
    let Some(value) = raw else { return 5 };
    let Some(number) = value.as_f64() else { return 5 };
    if !number.is_finite() {
        return 5;
    }
    (number.round() as i64).clamp(1, 12)
}

/// 按前端 `normalizeLayout` 同一规则归一化微件：
/// - 未知/重复类型丢弃（未知 ID 在 v1 与类型等价，按类型重建）；
/// - 已知类型保留相对顺序、启用状态、尺寸与 today-tasks.maxItems；
/// - 缺失的受支持类型追加到末尾并采用默认值；sort_order 重排 0..n。
pub fn normalize_widgets(raw: &serde_json::Value) -> (Vec<WidgetItem>, Vec<String>) {
    let mut warnings = Vec::new();
    let mut out: Vec<WidgetItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let entries: &[serde_json::Value] = match raw {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Null => &[],
        _ => {
            warnings.push("微件布局不是数组，已忽略并按默认布局处理".to_string());
            &[]
        }
    };

    for entry in entries {
        let Some(obj) = entry.as_object() else {
            warnings.push("微件布局包含非对象条目，已忽略".to_string());
            continue;
        };
        let Some(kind) = obj.get("type").and_then(|v| v.as_str()) else {
            warnings.push("微件布局条目缺少 type，已忽略".to_string());
            continue;
        };
        let Some((default_size, default_enabled)) = widget_default(kind) else {
            warnings.push(format!("未知微件类型「{}」，已忽略", kind));
            continue;
        };
        if !seen.insert(kind.to_string()) {
            warnings.push(format!("微件「{}」重复出现，已忽略后一条", kind));
            continue;
        }
        // v1 的 widget_id 与 type 一一对应；旧文件里未知 ID 不参与匹配。
        let widget_id = obj
            .get("widget_id")
            .and_then(|v| v.as_str())
            .unwrap_or(kind);
        if widget_id != kind {
            warnings.push(format!(
                "微件「{}」的实例 ID「{}」不受支持，已按类型重建",
                kind, widget_id
            ));
        }
        let enabled = obj
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(default_enabled);
        let size = obj
            .get("size")
            .and_then(|v| v.as_str())
            .filter(|s| WIDGET_SIZES.contains(s))
            .map(|s| s.to_string())
            .unwrap_or_else(|| default_size.to_string());
        let config = if kind == "today-tasks" {
            let raw_config = obj.get("config");
            WidgetConfig {
                max_items: Some(normalize_max_items(
                    raw_config.and_then(|c| c.get("maxItems")),
                )),
            }
        } else {
            WidgetConfig::default()
        };
        out.push(WidgetItem {
            widget_id: kind.to_string(),
            widget_type: kind.to_string(),
            enabled,
            config,
            size,
            sort_order: out.len() as i64,
            desktop: normalize_desktop(obj.get("desktop")),
        });
    }

    for (kind, default_size, default_enabled) in WIDGET_DEFAULTS {
        if seen.contains(*kind) {
            continue;
        }
        out.push(WidgetItem {
            widget_id: (*kind).to_string(),
            widget_type: (*kind).to_string(),
            enabled: *default_enabled,
            config: if *kind == "today-tasks" {
                WidgetConfig {
                    max_items: Some(5),
                }
            } else {
                WidgetConfig::default()
            },
            size: (*default_size).to_string(),
            sort_order: out.len() as i64,
            desktop: WidgetDesktop::default(),
        });
    }

    (out, warnings)
}

/// 过滤快捷键配置里的未知动作/重复动作，并按动作定义修正 scope。
pub fn sanitize_hotkeys(config: &HotkeyConfigFile) -> (HotkeyConfigFile, Vec<String>) {
    let mut warnings = Vec::new();
    let mut out: Vec<HotkeyBinding> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for binding in &config.bindings {
        let Some(def) = find_def(&binding.action) else {
            warnings.push(format!(
                "快捷键配置中的动作「{}」已不存在，已忽略",
                binding.action
            ));
            continue;
        };
        if !seen.insert(binding.action.clone()) {
            warnings.push(format!(
                "快捷键动作「{}」重复出现，已忽略后一条",
                def.label
            ));
            continue;
        }
        out.push(HotkeyBinding {
            action: binding.action.clone(),
            // scope 永远由动作定义决定，不信任配置文件。
            scope: def.scope,
            accelerator: binding.accelerator.clone(),
            enabled: binding.enabled,
        });
    }
    (
        HotkeyConfigFile {
            version: HOTKEY_CONFIG_VERSION,
            bindings: out,
        },
        warnings,
    )
}

/// 解析 bundle header 里的可选 config 字段。任何单字段损坏都只跳过该字段，
/// 绝不连累数据恢复；返回 `None` 表示「本次备份不含用户配置」。
pub fn parse_bundle_config(raw: &serde_json::Value) -> (Option<BundleConfig>, Vec<String>) {
    let mut warnings = Vec::new();
    let Some(obj) = raw.as_object() else {
        return (
            None,
            vec!["备份中的用户配置不是对象，已忽略（其余数据照常恢复）".to_string()],
        );
    };
    let version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1);
    if version > CONFIG_VERSION {
        return (
            None,
            vec![format!(
                "备份中的用户配置版本 {} 高于当前支持的 {}，已忽略（请升级应用）",
                version, CONFIG_VERSION
            )],
        );
    }

    let locale = match obj.get("locale") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(value)) => {
            let (normalized, mut issues) = normalize_locale(Some(value));
            warnings.append(&mut issues);
            normalized
        }
        Some(_) => {
            warnings.push("备份中的语言偏好格式非法，已忽略".to_string());
            None
        }
    };

    let widgets = match obj.get("widgets") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let (normalized, mut issues) = normalize_widgets(value);
            warnings.append(&mut issues);
            Some(normalized)
        }
    };

    let hotkeys = match obj.get("hotkeys") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => match serde_json::from_value::<HotkeyConfigFile>(value.clone()) {
            Ok(config) => {
                let (sanitized, mut issues) = sanitize_hotkeys(&config);
                warnings.append(&mut issues);
                Some(sanitized)
            }
            Err(e) => {
                warnings.push(format!("备份中的快捷键配置损坏，已跳过：{e}"));
                None
            }
        },
    };

    let app_grid_order = match obj.get("app_grid_order") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let (normalized, mut issues) = normalize_app_grid_order(value);
            warnings.append(&mut issues);
            normalized
        }
    };

    let config = BundleConfig {
        version: CONFIG_VERSION,
        locale,
        widgets,
        hotkeys,
        app_grid_order,
    };
    if config.is_empty() {
        (None, warnings)
    } else {
        (Some(config), warnings)
    }
}

/// 读取并归一化 `preferences.json`；返回配置与可展示的警告。
fn read_preferences_file(
    data_dir: &Path,
) -> Result<(Option<BundleConfig>, Vec<String>), String> {
    let path = data_dir.join(PREFERENCES_FILE);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((None, Vec::new()))
        }
        Err(error) => return Err(format!("读取用户偏好失败：{error}")),
    };
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("用户偏好不是合法 JSON：{e}"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| "用户偏好不是 JSON 对象".to_string())?;
    let version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1);
    if version > CONFIG_VERSION {
        return Err(format!(
            "用户偏好版本 {} 高于当前支持的 {}",
            version, CONFIG_VERSION
        ));
    }
    let mut warnings = Vec::new();
    let locale = match obj.get("locale") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(value)) => {
            let (normalized, mut issues) = normalize_locale(Some(value));
            warnings.append(&mut issues);
            normalized
        }
        Some(_) => {
            warnings.push("用户偏好中的语言格式非法，已忽略".to_string());
            None
        }
    };
    let widgets = match obj.get("widgets") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let (normalized, mut issues) = normalize_widgets(value);
            warnings.append(&mut issues);
            Some(normalized)
        }
    };
    let app_grid_order = match obj.get("app_grid_order") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let (normalized, mut issues) = normalize_app_grid_order(value);
            warnings.append(&mut issues);
            normalized
        }
    };
    Ok((
        Some(BundleConfig {
            version: CONFIG_VERSION,
            locale,
            widgets,
            hotkeys: None,
            app_grid_order,
        }),
        warnings,
    ))
}

/// 读取运行时偏好镜像（供 `get_user_preferences` 与偏好对账使用）。
pub fn load_preferences(data_dir: &Path) -> LoadedPreferences {
    match read_preferences_file(data_dir) {
        Ok((Some(config), warnings)) => LoadedPreferences {
            locale: config.locale,
            widgets: config.widgets,
            app_grid_order: config.app_grid_order,
            warnings,
        },
        Ok((None, warnings)) => LoadedPreferences {
            locale: None,
            widgets: None,
            app_grid_order: None,
            warnings,
        },
        Err(error) => LoadedPreferences {
            locale: None,
            widgets: None,
            app_grid_order: None,
            warnings: vec![format!("{error}；本次按 localStorage 当前值处理")],
        },
    }
}

/// 原子写入偏好镜像（临时文件 + sync + rename）。
/// `locale`/`widgets`/`app_grid_order` 为 None 时省略对应字段，
/// 保留文件里已有值由调用方合并。
pub fn write_preferences(
    data_dir: &Path,
    locale: Option<&str>,
    widgets: Option<&[WidgetItem]>,
    app_grid_order: Option<&[String]>,
) -> Result<(), String> {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "version".to_string(),
        serde_json::Value::Number(CONFIG_VERSION.into()),
    );
    if let Some(locale) = locale {
        obj.insert(
            "locale".to_string(),
            serde_json::Value::String(locale.to_string()),
        );
    }
    if let Some(widgets) = widgets {
        obj.insert(
            "widgets".to_string(),
            serde_json::to_value(widgets).map_err(|e| format!("序列化微件布局失败：{e}"))?,
        );
    }
    if let Some(order) = app_grid_order {
        obj.insert(
            "app_grid_order".to_string(),
            serde_json::to_value(order).map_err(|e| format!("序列化应用网格排序失败：{e}"))?,
        );
    }
    atomic_write_json(
        &data_dir.join(PREFERENCES_FILE),
        &serde_json::Value::Object(obj),
    )
}

#[derive(Clone, Debug, Default)]
pub struct CollectedConfig {
    pub config: Option<BundleConfig>,
    pub warnings: Vec<String>,
}

/// 备份写入侧：读取数据目录中的 `preferences.json` 与 `hotkeys.json`。
/// 单个文件损坏只跳过该部分并给出警告，绝不阻断数据备份。
pub fn collect_export_config(data_dir: &Path) -> CollectedConfig {
    let mut warnings = Vec::new();

    let preferences = match read_preferences_file(data_dir) {
        Ok((config, issues)) => {
            warnings.extend(issues);
            config
        }
        Err(error) => {
            warnings.push(format!("{error}；该部分未写入备份"));
            None
        }
    };

    let hotkeys_path = data_dir.join("hotkeys.json");
    let hotkeys = match fs::read_to_string(&hotkeys_path) {
        Ok(raw) => match serde_json::from_str::<HotkeyConfigFile>(&raw) {
            Ok(config) => {
                let (sanitized, mut issues) = sanitize_hotkeys(&config);
                warnings.append(&mut issues);
                Some(sanitized)
            }
            Err(error) => {
                warnings.push(format!(
                    "快捷键配置不是合法 JSON（{error}）；该部分未写入备份"
                ));
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            warnings.push(format!("读取快捷键配置失败（{error}）；该部分未写入备份"));
            None
        }
    };

    let config = BundleConfig {
        version: CONFIG_VERSION,
        locale: preferences.as_ref().and_then(|p| p.locale.clone()),
        widgets: preferences.as_ref().and_then(|p| p.widgets.clone()),
        hotkeys,
        app_grid_order: preferences.and_then(|p| p.app_grid_order),
    };
    CollectedConfig {
        config: if config.is_empty() { None } else { Some(config) },
        warnings,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PendingRestore {
    version: i64,
    restore_id: String,
    created_at: String,
}

/// 标记「本次恢复带来的偏好需要在下一次前端启动时强制应用」。
/// 仅写文件，不触碰 localStorage；前端 `get_user_preferences` 看到标记后应用并回执。
pub fn mark_restore_pending(data_dir: &Path, restore_id: &str) -> Result<(), String> {
    let pending = PendingRestore {
        version: CONFIG_VERSION,
        restore_id: restore_id.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    let value = serde_json::to_value(pending).map_err(|e| format!("序列化恢复标记失败：{e}"))?;
    atomic_write_json(&data_dir.join(PREFERENCES_PENDING_FILE), &value)
}

/// 读取待应用恢复标记；损坏时给出警告并当作不存在（文件保留，便于排查）。
pub fn pending_restore(data_dir: &Path) -> (Option<String>, Option<String>) {
    let path = data_dir.join(PREFERENCES_PENDING_FILE);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return (None, None),
        Err(error) => return (None, Some(format!("读取偏好恢复标记失败：{error}"))),
    };
    match serde_json::from_str::<PendingRestore>(&raw) {
        Ok(pending) if pending.version <= CONFIG_VERSION => (Some(pending.restore_id), None),
        Ok(pending) => (
            None,
            Some(format!(
                "偏好恢复标记版本 {} 高于当前支持版本，已忽略",
                pending.version
            )),
        ),
        Err(error) => (
            None,
            Some(format!("偏好恢复标记损坏（{error}），已忽略")),
        ),
    }
}

/// 前端确认已应用恢复标记后清除；`restore_id` 不匹配时保留（避免误清新标记）。
pub fn clear_restore_pending(data_dir: &Path, restore_id: &str) -> Result<(), String> {
    let path = data_dir.join(PREFERENCES_PENDING_FILE);
    let (pending, _) = pending_restore(data_dir);
    match pending.as_deref() {
        Some(current) if current == restore_id => fs::remove_file(&path)
            .map_err(|e| format!("清除偏好恢复标记失败：{e}")),
        Some(_) => Ok(()),
        None => {
            // 标记不存在或已损坏：清理损坏文件，避免永久残留。
            let _ = fs::remove_file(&path);
            Ok(())
        }
    }
}

pub fn preferences_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PREFERENCES_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-user-prefs-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn invalid_locale_falls_back_to_zh_cn_with_warning() {
        let (locale, warnings) = normalize_locale(Some("fr-FR"));
        assert_eq!(locale.as_deref(), Some("zh-CN"));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("fr-FR"));
        assert_eq!(normalize_locale(Some("en-US")).0.as_deref(), Some("en-US"));
        assert_eq!(normalize_locale(None).0, None);
    }

    #[test]
    fn widgets_filter_unknown_dedupe_preserve_order_and_append_missing() {
        let raw = serde_json::json!([
            {"type":"efficiency","widget_id":"efficiency","enabled":true,"size":"lg"},
            {"type":"unknown-widget","enabled":true},
            {"type":"today-tasks","enabled":false,"config":{"maxItems":99},"size":"nope"},
            {"type":"efficiency","enabled":false},
            {"type":"focus-timer","widget_id":"legacy-id","enabled":true,"size":"sm"}
        ]);
        let (items, warnings) = normalize_widgets(&raw);
        assert_eq!(items.len(), WIDGET_DEFAULTS.len());
        assert_eq!(items[0].widget_type, "efficiency");
        assert!(items[0].enabled);
        assert_eq!(items[0].size, "lg");
        // 未知类型与重复项被过滤，未知 ID 按类型重建。
        assert!(warnings.iter().any(|w| w.contains("unknown-widget")));
        assert!(warnings.iter().any(|w| w.contains("重复")));
        let today = items.iter().find(|w| w.widget_type == "today-tasks").unwrap();
        assert!(!today.enabled);
        assert_eq!(today.config.max_items, Some(12));
        assert_eq!(today.size, "md");
        // 前端 WidgetConfig 使用 camelCase：序列化必须是 maxItems。
        assert_eq!(
            serde_json::to_value(&today.config).unwrap()["maxItems"],
            serde_json::json!(12)
        );
        // 输入顺序保留：efficiency / today-tasks / focus-timer，随后补齐缺失类型。
        let kinds: Vec<&str> = items.iter().map(|w| w.widget_type.as_str()).collect();
        assert_eq!(&kinds[..3], &["efficiency", "today-tasks", "focus-timer"]);
        assert_eq!(kinds.len(), WIDGET_DEFAULTS.len());
        let order: Vec<i64> = items.iter().map(|w| w.sort_order).collect();
        assert_eq!(order, (0..items.len() as i64).collect::<Vec<_>>());
    }

    #[test]
    fn invalid_widget_container_is_ignored_with_warning() {
        let (items, warnings) = normalize_widgets(&serde_json::json!({"widgets":[]}));
        assert_eq!(items.len(), WIDGET_DEFAULTS.len());
        assert!(warnings[0].contains("不是数组"));
    }

    #[test]
    fn app_grid_order_normalizes_like_frontend() {
        let (order, warnings) = normalize_app_grid_order(&serde_json::json!([
            APP_GRID_ADD_KEY,
            "app-a",
            "app-a",
            "",
            42,
            "x".repeat(APP_GRID_ID_MAX_CHARS + 1),
            "app-b"
        ]));
        assert_eq!(
            order.unwrap(),
            vec![
                APP_GRID_ADD_KEY.to_string(),
                "app-a".to_string(),
                "app-b".to_string()
            ]
        );
        assert!(warnings.iter().any(|w| w.contains("非字符串")));
        assert!(warnings.iter().any(|w| w.contains("超长")));
        // 空数组/非数组归一化为 None，不能用来清空本机排序。
        assert!(normalize_app_grid_order(&serde_json::json!([])).0.is_none());
        let (none, warnings) = normalize_app_grid_order(&serde_json::json!({"bad": true}));
        assert!(none.is_none());
        assert!(warnings[0].contains("不是数组"));
    }

    #[test]
    fn app_grid_order_roundtrips_and_only_order_is_not_empty() {
        let dir = temp_dir("order-roundtrip");
        let order = vec![APP_GRID_ADD_KEY.to_string(), "app-a".to_string()];
        write_preferences(&dir, None, None, Some(&order)).unwrap();
        let loaded = load_preferences(&dir);
        assert_eq!(loaded.app_grid_order.as_ref(), Some(&order));
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);

        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(PREFERENCES_FILE)).unwrap()).unwrap();
        let (config, warnings) = parse_bundle_config(&raw);
        let config = config.unwrap();
        assert_eq!(config.app_grid_order.as_ref(), Some(&order));
        assert!(!config.is_empty());
        assert!(warnings.is_empty(), "{warnings:?}");

        // 损坏排序只跳过该字段，不拒绝其他配置。
        let corrupt = serde_json::json!({
            "version": 1,
            "locale": "en-US",
            "app_grid_order": "not-an-array"
        });
        let (config, warnings) = parse_bundle_config(&corrupt);
        let config = config.unwrap();
        assert_eq!(config.locale.as_deref(), Some("en-US"));
        assert!(config.app_grid_order.is_none());
        assert!(warnings.iter().any(|w| w.contains("应用网格排序")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_export_config_includes_app_grid_order() {
        let dir = temp_dir("order-export");
        let order = vec!["app-b".to_string(), APP_GRID_ADD_KEY.to_string()];
        write_preferences(&dir, None, None, Some(&order)).unwrap();
        let collected = collect_export_config(&dir);
        let config = collected.config.unwrap();
        assert_eq!(config.app_grid_order.as_ref(), Some(&order));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundle_config_parses_partially_and_skips_corrupt_sections() {
        let raw = serde_json::json!({
            "version": 1,
            "locale": "en-US",
            "widgets": [{"type":"today-tasks","enabled":true,"config":{"maxItems":3}}],
            "hotkeys": "not-an-object"
        });
        let (config, warnings) = parse_bundle_config(&raw);
        let config = config.unwrap();
        assert_eq!(config.locale.as_deref(), Some("en-US"));
        assert_eq!(config.widgets.as_ref().unwrap().len(), WIDGET_DEFAULTS.len());
        assert!(config.hotkeys.is_none());
        assert!(warnings.iter().any(|w| w.contains("快捷键配置损坏")));
        let (config, warnings) = parse_bundle_config(&serde_json::json!({"version":99}));
        assert!(config.is_none());
        assert!(warnings[0].contains("版本 99"));
    }

    #[test]
    fn bundle_config_supports_partial_sections() {
        let only_hotkeys = serde_json::json!({
            "version": 1,
            "hotkeys": {
                "version": 1,
                "bindings": [{
                    "action": "quick_add_task",
                    "scope": "app_local",
                    "accelerator": "Ctrl+Shift+K",
                    "enabled": true
                }]
            }
        });
        let (config, warnings) = parse_bundle_config(&only_hotkeys);
        let config = config.unwrap();
        assert!(config.locale.is_none());
        assert!(config.widgets.is_none());
        assert_eq!(config.hotkeys.as_ref().unwrap().bindings.len(), 1);
        assert!(warnings.is_empty(), "{warnings:?}");

        let only_locale = serde_json::json!({"version": 1, "locale": "en-US"});
        let (config, _) = parse_bundle_config(&only_locale);
        let config = config.unwrap();
        assert_eq!(config.locale.as_deref(), Some("en-US"));
        assert!(config.widgets.is_none());
        assert!(config.hotkeys.is_none());
    }

    #[test]
    fn hotkeys_sanitize_drops_unknown_and_duplicate_actions() {
        let config = HotkeyConfigFile {
            version: HOTKEY_CONFIG_VERSION,
            bindings: vec![
                HotkeyBinding {
                    action: "quick_add_task".into(),
                    scope: crate::hotkeys::model::HotkeyScope::SystemGlobal,
                    accelerator: "Ctrl+Shift+K".into(),
                    enabled: true,
                },
                HotkeyBinding {
                    action: "quick_add_task".into(),
                    scope: crate::hotkeys::model::HotkeyScope::AppLocal,
                    accelerator: "Ctrl+Shift+L".into(),
                    enabled: false,
                },
                HotkeyBinding {
                    action: "removed_action".into(),
                    scope: crate::hotkeys::model::HotkeyScope::AppLocal,
                    accelerator: "Ctrl+Shift+M".into(),
                    enabled: true,
                },
            ],
        };
        let (sanitized, warnings) = sanitize_hotkeys(&config);
        assert_eq!(sanitized.bindings.len(), 1);
        // scope 由动作定义修正为 app_local，而不是文件里的 system_global。
        assert_eq!(
            sanitized.bindings[0].scope,
            crate::hotkeys::model::HotkeyScope::AppLocal
        );
        assert_eq!(sanitized.bindings[0].accelerator, "Ctrl+Shift+K");
        assert!(warnings.iter().any(|w| w.contains("removed_action")));
        assert!(warnings.iter().any(|w| w.contains("重复")));
    }

    #[test]
    fn preferences_attach_widgets_and_locale_atomically() {
        let dir = temp_dir("roundtrip");
        let widgets = normalize_widgets(&serde_json::json!([])).0;
        write_preferences(&dir, Some("en-US"), Some(&widgets), None).unwrap();
        let loaded = load_preferences(&dir);
        assert_eq!(loaded.locale.as_deref(), Some("en-US"));
        assert_eq!(loaded.widgets.as_ref().unwrap().len(), widgets.len());
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        // 未传 widgets 时文件保留旧值（命令层负责合并）。
        write_preferences(&dir, Some("zh-CN"), None, None).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(PREFERENCES_FILE)).unwrap()).unwrap();
        assert_eq!(raw["locale"], "zh-CN");
        assert!(raw.get("widgets").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_preferences_are_reported_not_panicked() {
        let dir = temp_dir("corrupt");
        fs::write(dir.join(PREFERENCES_FILE), "{not-json").unwrap();
        let loaded = load_preferences(&dir);
        assert!(loaded.locale.is_none());
        assert!(loaded.widgets.is_none());
        assert!(loaded.warnings.iter().any(|w| w.contains("不是合法 JSON")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_marker_roundtrip_and_mismatch_keeps_marker() {
        let dir = temp_dir("pending");
        mark_restore_pending(&dir, "session-a").unwrap();
        let (id, warning) = pending_restore(&dir);
        assert_eq!(id.as_deref(), Some("session-a"));
        assert!(warning.is_none());
        clear_restore_pending(&dir, "session-b").unwrap();
        assert_eq!(pending_restore(&dir).0.as_deref(), Some("session-a"));
        clear_restore_pending(&dir, "session-a").unwrap();
        assert!(pending_restore(&dir).0.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_export_config_skips_corrupt_hotkeys_but_keeps_preferences() {
        let dir = temp_dir("collect");
        let widgets = normalize_widgets(&serde_json::json!([])).0;
        write_preferences(&dir, Some("en-US"), Some(&widgets), None).unwrap();
        fs::write(dir.join("hotkeys.json"), "broken").unwrap();
        let collected = collect_export_config(&dir);
        let config = collected.config.unwrap();
        assert_eq!(config.locale.as_deref(), Some("en-US"));
        assert!(config.hotkeys.is_none());
        assert!(!collected.warnings.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
