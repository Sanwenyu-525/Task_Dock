use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    emit_build_info();
    tauri_build::build()
}

/// 构建溯源：三处版本号相同（0.5.0）无法区分不同构建，因此在编译期注入
/// 短 commit 与构建时间，由 `commands::system::performance_diagnostics`
/// 的 `build` 字段返回（本地诊断面板，不写公开日志）。
fn emit_build_info() {
    println!("cargo:rerun-if-changed=../.git/HEAD");
    let commit = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=TASK_DOCK_GIT_COMMIT={commit}");

    let built_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=TASK_DOCK_BUILD_TIME={built_at}");
}
