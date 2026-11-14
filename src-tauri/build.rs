use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    emit_build_info();
    emit_test_manifest();
    tauri_build::build()
}

/// Rust 测试 exe 不会继承 Tauri 主程序的 manifest。`rfd`（tauri-plugin-dialog
/// 的 Windows 后端）静态引用 `comctl32!TaskDialogIndirect`，该导出只存在于
/// Common-Controls v6；缺少 manifest 时测试进程在加载阶段即 0xC0000139
/// STATUS_ENTRYPOINT_NOT_FOUND（主程序正常）。这里把 manifest 编成 .res 资源，
/// 只链接到测试目标（`rustc-link-arg-tests`），不改变发布二进制。
///
/// 说明：直接用 `/MANIFESTINPUT` 链接参数会被 rustc 的默认 manifest 策略覆盖，
/// 因此走 rc.exe → .res → 资源链接的路径。
#[cfg(windows)]
fn emit_test_manifest() {
    let rc = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests-manifest.rc");
    println!("cargo:rerun-if-changed={}", rc.display());
    println!(
        "cargo:rerun-if-changed={}",
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests.manifest")
            .display()
    );
    if let Err(err) = embed_resource::compile_for_tests(&rc, embed_resource::NONE)
        .manifest_required()
    {
        // 不阻断非测试构建（例如没有 rc.exe 的环境）；测试 exe 若因此仍是旧
        // 状态，会在运行阶段以明确的 STATUS_ENTRYPOINT_NOT_FOUND 暴露。
        eprintln!("embed test manifest failed: {err:?}");
    }
}

#[cfg(not(windows))]
fn emit_test_manifest() {}

/// 构建溯源：三处版本号相同（0.5.0）无法区分不同构建，因此在编译期注入
/// 短 commit 与构建时间，由 `commands::system::performance_diagnostics`
/// 的 `build` 字段返回（本地诊断面板，不写公开日志）。
fn emit_build_info() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .join("..")
        .canonicalize()
        .unwrap_or_else(|_| manifest_dir.join(".."));
    emit_git_watch_paths(&repo_root);

    let commit = git_output(&repo_root, &["rev-parse", "--short", "HEAD"])
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=TASK_DOCK_GIT_COMMIT={commit}");

    // 轻量 dirty 标记：只表示构建时是否存在未提交的已跟踪修改
    //（未跟踪文件不计入，避免 .screenshots/ 等长期未跟踪项恒为脏）。
    // 不做全仓哈希；git 不可用时报 unknown，不误判为干净。
    let dirty = match git_status_dirty(&repo_root) {
        Some(true) => "true",
        Some(false) => "false",
        None => "unknown",
    };
    println!("cargo:rustc-env=TASK_DOCK_GIT_DIRTY={dirty}");

    let built_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=TASK_DOCK_BUILD_TIME={built_at}");
}

fn git_status_dirty(repo_root: &Path) -> Option<bool> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["status", "--porcelain", "--untracked-files=no"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8(output.stdout)
            .ok()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
    )
}

fn git_output(repo_root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn git_path(repo_root: &Path, path: &str) -> Option<PathBuf> {
    let resolved = git_output(repo_root, &["rev-parse", "--git-path", path])?;
    let path = PathBuf::from(resolved);
    Some(if path.is_absolute() {
        path
    } else {
        repo_root.join(path)
    })
}

fn emit_git_watch_paths(repo_root: &Path) {
    let Some(head_path) = git_path(repo_root, "HEAD") else {
        return;
    };
    println!("cargo:rerun-if-changed={}", head_path.display());

    if let Ok(head) = std::fs::read_to_string(&head_path) {
        if let Some(reference) = head.trim().strip_prefix("ref:") {
            if let Some(reference_path) = git_path(repo_root, reference.trim()) {
                println!("cargo:rerun-if-changed={}", reference_path.display());
            }
        }
    }

    // A packed branch ref can move without a loose refs/heads/<name> file.
    if let Some(packed_refs_path) = git_path(repo_root, "packed-refs") {
        println!("cargo:rerun-if-changed={}", packed_refs_path.display());
    }
}
