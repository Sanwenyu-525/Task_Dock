//! Trae 适配器（Trae IDE / Trae CN）。
//!
//! 官方 Hooks：用户级 `~/.trae/hooks.json`（国际版）与 `~/.trae-cn/hooks.json`（CN 版），
//! 项目级 `.trae/hooks.json`；格式为 Claude 兼容组结构。
//! 事件（官方文档 hook-configuration-reference）：SessionStart / UserPromptSubmit /
//! PreToolUse / PostToolUse / Stop / Notification。
//!
//! 本机实测（Trae CN 1.107.1，`@byted-icube/ai-modules-chat` 内 `icubeContextAsset`）：
//! - 全局 hook 路径 = `<userHome>/<dataFolderName>/hooks.json`，CN 版 dataFolderName 为
//!   `.trae-cn`，国际版为 `.trae`，两版配置相互独立；
//! - 客户端把全局 Hook 作为 Context Asset 管理，执行受 `global_hooks_enabled`
//!   配置控制且默认 false，必须由用户在 Trae 内开启；仅写文件不足以产生事件。
//!
//! 因此识别必须区分实际安装的产品形态，不能仅凭「目录存在」判定（Task Dock 自己
//! 创建的空目录不算已安装）。

use std::path::{Path, PathBuf};

use super::hooks_install::{self, home_dir};
use super::managed::{self, DetectionReport, HooksAdapter};

pub const TRAE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "Notification",
];

/// Trae 自身会写入的配置根标记（用于区分真实安装与 Task Dock 自己创建的空目录）。
const PRODUCT_MARKERS: &[&str] = &["argv.json", "extensions", "rules", "builtin"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TraeProduct {
    Intl,
    Cn,
}

impl TraeProduct {
    const ALL: [TraeProduct; 2] = [TraeProduct::Intl, TraeProduct::Cn];

    /// 安装目录名与进程名（不含 .exe）。
    fn program_name(self) -> &'static str {
        match self {
            TraeProduct::Intl => "Trae",
            TraeProduct::Cn => "Trae CN",
        }
    }

    /// 用户级配置根（数据目录名与 product.json 的 dataFolderName 一致）。
    fn home_name(self) -> &'static str {
        match self {
            TraeProduct::Intl => ".trae",
            TraeProduct::Cn => ".trae-cn",
        }
    }

    fn home(self) -> PathBuf {
        home_dir().join(self.home_name())
    }

    fn program_dir(self) -> Option<PathBuf> {
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|l| PathBuf::from(l).join("Programs").join(self.program_name()))
            .filter(|p| p.exists())
    }
}

/// 配置根是否是真实 Trae 安装留下的（含 IDE 自身产物），而不是仅有 hooks.json 的空壳。
fn home_is_real(home: &Path) -> bool {
    PRODUCT_MARKERS.iter().any(|m| home.join(m).exists())
}

fn hook_file(p: TraeProduct) -> PathBuf {
    p.home().join("hooks.json")
}

fn file_has_ours(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|s| s.contains(hooks_install::MARKER) || s.contains(hooks_install::LEGACY_MARKER))
        .unwrap_or(false)
}

/// 目标 hooks 文件：真实存在的配置根各一份。
///
/// 额外包含「已存在且含 Task Dock 条目」的候选文件——这可能是旧版本写过的路径，
/// 卸载/重装必须能识别并只清理自己的条目；不含标记的第三方/未知目录不碰。
///
/// 注意：仅检测到程序安装目录（`Programs\Trae*`）时，不向其尚未创建的配置根写入，
/// 否则在产品未被启动过（配置根不存在）的机器上，安装会因单个文件失败而整体回滚。
pub fn hooks_files() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in TraeProduct::ALL {
        let file = hook_file(p);
        if home_is_real(&p.home()) || file_has_ours(&file) {
            out.push(file);
        }
    }
    out
}

pub fn supported_events() -> Vec<String> {
    TRAE_EVENTS.iter().map(|s| s.to_string()).collect()
}

fn detect_impl(r: &mut DetectionReport) {
    let mut installed_any = false;
    for p in TraeProduct::ALL {
        let home = p.home();
        let program = p.program_dir();
        let real = home_is_real(&home);
        if real {
            r.config_homes.push(home.to_string_lossy().to_string());
        }
        if let Some(dir) = &program {
            r.install_paths.push(dir.to_string_lossy().to_string());
        }
        if real || program.is_some() {
            installed_any = true;
        }
    }
    r.installed = installed_any;
    r.install_method = "product-home-marker-or-program-dir".into();
    // 国际版进程名 `Trae.exe`，CN 版 `Trae CN.exe`；只匹配国际版会漏掉 CN 版。
    r.running_instances = managed::find_processes(&["Trae", "Trae CN"]);
    // 注意：不探测 IDE 版本——Trae 的 CLI 启动器会拉起整个 IDE，探测会阻塞并打扰用户；
    // 版本信息留待官方 CLI 元数据可用时再补充。
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "trae",
        display_name: "Trae",
        docs_url: "https://docs.trae.ai/ide/hook-configuration-reference",
        hooks_files,
        events: supported_events,
        detect_impl,
        // 通用命令以引号路径开头，在 PowerShell 下解析失败（实测），Trae 使用专用构造器
        hook_command: hooks_install::trae_hook_command,
        layout: hooks_install::HooksLayout::Flat,
        limitations: vec![
            "事件名以官方 Hook 配置参考为准（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification）；未在本机完成真实会话联调前标记「待验证」".into(),
            "Trae 全局 Hooks 默认关闭（global_hooks_enabled=false），写入配置后仍需在 Trae 设置中开启，否则不会产生事件".into(),
            "国际版与 CN 版配置独立，接入会写入所有已安装版本的配置".into(),
        ],
        timeout_secs: 10,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_product(root: &Path, home_name: &str, real: bool) -> PathBuf {
        let home = root.join(home_name);
        std::fs::create_dir_all(&home).unwrap();
        if real {
            std::fs::write(home.join("argv.json"), "{}").unwrap();
        }
        home
    }

    #[test]
    fn cn_only_home_is_detected_without_intl_fallback() {
        let root = std::env::temp_dir().join(format!("td-trae-cn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let cn = fake_product(&root, ".trae-cn", true);
        assert!(home_is_real(&cn));
        assert!(!home_is_real(&root.join(".trae")));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn empty_shell_dir_is_not_a_product_install() {
        // Task Dock 旧版本可能创建了只有 hooks.json 的目录：不能据此判断 Trae 已安装
        let root = std::env::temp_dir().join(format!("td-trae-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let shell = fake_product(&root, ".trae", false);
        std::fs::write(shell.join("hooks.json"), "{}").unwrap();
        assert!(!home_is_real(&shell));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn marker_detection_distinguishes_ours_from_third_party() {
        let root = std::env::temp_dir().join(format!("td-trae-marker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let ours = root.join("hooks.json");
        std::fs::write(&ours, r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\"C:\\x\\task-dock.exe\" --agent-hook"}]}]}}"#).unwrap();
        assert!(file_has_ours(&ours));
        let third = root.join("third.json");
        std::fs::write(&third, r#"{"hooks":{}}"#).unwrap();
        assert!(!file_has_ours(&third));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn trae_command_uses_cmd_wrapper_not_leading_quote() {
        let exe = PathBuf::from(r"C:\Program Files\Task Dock\task-dock.exe");
        let cmd = hooks_install::trae_hook_command(&exe, "trae", "Stop");
        assert!(
            !cmd.trim_start().starts_with('"'),
            "不得以引号开头: {}",
            cmd
        );
        assert!(cmd.contains("/c call \""), "{}", cmd);
        assert!(cmd.contains("--agent-hook --source trae --event Stop"));
    }

    #[test]
    fn supported_events_stay_within_official_list() {
        let events = supported_events();
        assert_eq!(events.len(), TRAE_EVENTS.len());
        assert!(events.iter().all(|e| TRAE_EVENTS.contains(&e.as_str())));
    }
}
