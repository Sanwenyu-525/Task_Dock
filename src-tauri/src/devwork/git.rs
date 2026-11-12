//! 只读 git 探测：判断目录是否为 git 仓库/worktree、当前分支、HEAD 与脏文件数。
//!
//! 边界与安全：
//! - 全部命令只读（rev-parse / status / worktree list），绝不执行任何写操作；
//! - 不引入 git2 等依赖，直接调用用户 PATH 上的 `git` 可执行文件；
//! - 参数全部以数组传递，无 shell 拼接；Windows 下抑制控制台窗口（复用
//!   `winproc::hidden`，与 winproc.rs 既有 CREATE_NO_WINDOW 写法一致）；
//! - 每条命令 2s 超时（spawn 后循环 try_wait，超时 kill 并回收）：单步超时只
//!   降级对应字段（置 None），不整体 panic；
//! - 不缓存、不落库：每次调用都实时探测，结果只反映当次状态。

use serde::Serialize;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// 探测状态：ok = 正常仓库/worktree；not_a_repo = 不是 git 仓库；
/// git_unavailable = git 不可用（可执行文件缺失或单步超时无法判定）；
/// path_missing = 路径不存在或不是目录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DevGitStatus {
    Ok,
    NotARepo,
    GitUnavailable,
    PathMissing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevGitInfo {
    pub status: DevGitStatus,
    pub branch: Option<String>,
    pub detached: bool,
    pub is_worktree: bool,
    /// is_worktree 为 true 时的主仓库根目录（`worktree list --porcelain` 首行）。
    pub main_repo_path: Option<String>,
    pub head_sha: Option<String>,
    /// `status --porcelain` 非空行数（统计上限 5000 行，只用于规模示意）。
    pub dirty_count: Option<i64>,
    /// 探测时间（ISO8601），供前端判断结果新鲜度。
    pub probed_at: String,
}

/// 单条 git 命令的超时上限。探测是用户主动触发的前台操作，
/// 2s 足够本地仓库完成 rev-parse/status，又不会让 UI 长时间等待。
const STEP_TIMEOUT: Duration = Duration::from_secs(2);
/// dirty 行数统计上限：超大仓库只统计前 5000 行，避免单次探测卡顿。
const DIRTY_LINE_CAP: usize = 5000;
/// try_wait 轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// git 命令执行结果：与 `Option<Output>` 不同，能区分「git 不存在」和「超时」。
#[derive(Debug)]
enum GitRun {
    Ok(Output),
    /// spawn 失败（典型：PATH 上没有 git 可执行文件）。
    SpawnNotFound,
    Timeout,
}

/// 执行 `git -C <root> <args>`：无 shell、无窗口、有超时。
fn run_git(root_path: &str, args: &[&str]) -> GitRun {
    let mut cmd = crate::winproc::hidden("git");
    cmd.args(["-C", root_path]);
    cmd.args(args);
    run_command(&mut cmd)
}

/// 有界执行：spawn 后循环 try_wait，超时 kill 并回收，绝不无限等待。
/// 失败一律降级（GitRun 的非 Ok 变体），调用方据此把对应字段置 None，不 panic。
fn run_command(cmd: &mut Command) -> GitRun {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return GitRun::SpawnNotFound,
        Err(_) => return GitRun::SpawnNotFound,
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                // 已退出：回收并读取输出（stdin 未接管，wait_with_output 不会阻塞）
                return match child.wait_with_output() {
                    Ok(out) => GitRun::Ok(out),
                    Err(_) => GitRun::Timeout,
                };
            }
            Ok(None) => {
                if started.elapsed() >= STEP_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return GitRun::Timeout;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return GitRun::Timeout;
            }
        }
    }
}

/// stdout 按行取出并 UTF-8 lossy 解码。
fn stdout_lines(out: &Output) -> Vec<String> {
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// 去除路径两侧的引号（git 新版本 porcelain v2 会给特殊路径加引号）与首尾空白。
fn unquote(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// 只读探测一个目录的 git 状态。永不 panic：任何一步失败都降级为对应字段为空。
pub fn probe(root_path: &str) -> DevGitInfo {
    let probed_at = chrono::Utc::now().to_rfc3339();
    let missing = DevGitInfo {
        status: DevGitStatus::PathMissing,
        branch: None,
        detached: false,
        is_worktree: false,
        main_repo_path: None,
        head_sha: None,
        dirty_count: None,
        probed_at: probed_at.clone(),
    };
    let path = std::path::Path::new(root_path);
    if !path.is_absolute() || !path.is_dir() {
        return missing;
    }

    // ① 是否位于 git 工作树内：失败则终止（不是仓库 / git 不可用）。
    match run_git(root_path, &["rev-parse", "--is-inside-work-tree"]) {
        GitRun::Ok(out) if out.status.success() && out.stdout.starts_with(b"true") => {}
        // 非成功退出：git 2.x 对非仓库目录输出 "fatal: not a git repository..."；
        // 其他失败（权限异常等）同样无法继续探测，统一按 not_a_repo 降级。
        GitRun::Ok(_) => {
            return DevGitInfo {
                status: DevGitStatus::NotARepo,
                ..missing
            };
        }
        // spawn 失败 = git 不存在；超时 = 本次无法判定：两者都按 git 不可用降级。
        _ => {
            return DevGitInfo {
                status: DevGitStatus::GitUnavailable,
                ..missing
            };
        }
    }

    // ② 当前分支：detached 时 --abbrev-ref 输出字面 "HEAD"（成功退出）；
    //    未born 分支（git init 后未提交）退出码非 0 且 stdout 也是 "HEAD"，
    //    用 symbolic-ref 兜底拿分支名。
    let mut branch: Option<String> = None;
    let mut detached = false;
    match run_git(root_path, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        GitRun::Ok(out) if out.status.success() => {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if name == "HEAD" {
                detached = true;
            } else if !name.is_empty() {
                branch = Some(name);
            }
        }
        GitRun::Ok(_) => {
            // 未born 分支：symbolic-ref 直接解析 HEAD 指向的引用名。
            if let GitRun::Ok(out) = run_git(root_path, &["symbolic-ref", "--short", "HEAD"]) {
                if out.status.success() {
                    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !name.is_empty() {
                        branch = Some(name);
                    }
                }
            }
        }
        _ => {}
    }

    // ③ HEAD SHA：未born 分支必然失败，保持 None 即可。
    let head_sha = match run_git(root_path, &["rev-parse", "HEAD"]) {
        GitRun::Ok(out) if out.status.success() => {
            let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()) {
                Some(sha)
            } else {
                None
            }
        }
        _ => None,
    };

    // ④ worktree 判定：linked worktree 的 git-dir（.git/worktrees/<name>）与
    //    git-common-dir（主仓库 .git）不同；主仓库内两者相同。
    //    --path-format=absolute 需要 git >= 2.31；旧 git 上该参数报错，按非
    //    worktree 降级（is_worktree=false），不影响其余字段。
    let (is_worktree, main_repo_path) =
        match (
            run_git(root_path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]),
            run_git(root_path, &["rev-parse", "--path-format=absolute", "--git-dir"]),
        ) {
            (GitRun::Ok(common), GitRun::Ok(git_dir))
                if common.status.success() && git_dir.status.success() =>
            {
                let common = String::from_utf8_lossy(&common.stdout).trim().to_string();
                let git_dir = String::from_utf8_lossy(&git_dir.stdout).trim().to_string();
                if !common.is_empty() && common != git_dir {
                    // worktree list --porcelain 首行：`worktree <主仓库路径>`
                    let main = match run_git(root_path, &["worktree", "list", "--porcelain"]) {
                        GitRun::Ok(out) if out.status.success() => stdout_lines(&out)
                            .first()
                            .and_then(|line| line.strip_prefix("worktree "))
                            .map(unquote),
                        _ => None,
                    };
                    (true, main)
                } else {
                    (false, None)
                }
            }
            _ => (false, None),
        };

    // ⑤ 脏文件数：porcelain 非空行数，统计上限 5000 行。
    let dirty_count = match run_git(root_path, &["status", "--porcelain"]) {
        GitRun::Ok(out) if out.status.success() => {
            let count = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .take(DIRTY_LINE_CAP)
                .count() as i64;
            Some(count)
        }
        _ => None,
    };

    DevGitInfo {
        status: DevGitStatus::Ok,
        branch,
        detached,
        is_worktree,
        main_repo_path,
        head_sha,
        dirty_count,
        probed_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// 测试目录统一前缀，便于识别与清理（只清理自己创建的目录）。
    const TEST_PREFIX: &str = "td-devwork-git-";

    /// git 可用性检查：不可用时打印 SKIPPED 并跳过（测试不算失败）。
    fn require_git() -> bool {
        match Command::new("git").arg("--version").output() {
            Ok(out) if out.status.success() => true,
            _ => {
                println!("SKIPPED: git 可执行文件不可用，跳过真实 git 探测测试");
                false
            }
        }
    }

    /// 唯一的临时目录（测试结束清理）。
    fn temp_sub(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{}{}-{}",
            TEST_PREFIX,
            name,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 在目录内执行一条 git 命令（测试夹具用，需要写操作）。
    fn git_in(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {:?} 失败: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 归一路径比较：统一分隔符并忽略大小写（Windows 文件系统不区分大小写）。
    fn norm_path(p: &str) -> String {
        p.replace('\\', "/").to_lowercase()
    }

    /// git init + 一个提交，得到可探测的常规仓库。
    fn init_repo_with_commit(dir: &Path) {
        git_in(dir, &["init", "-q"]);
        std::fs::write(dir.join("README.md"), "init\n").expect("写文件");
        git_in(dir, &["add", "."]);
        git_in(dir, &["commit", "-q", "-m", "init"]);
    }

    #[test]
    fn probe_reports_not_a_repo_for_plain_directory() {
        let dir = temp_sub("plain");
        let info = probe(dir.to_str().unwrap());
        assert_eq!(info.status, DevGitStatus::NotARepo);
        assert!(info.branch.is_none());
        assert!(!info.detached);
        assert!(!info.is_worktree);
        assert!(info.head_sha.is_none());
        assert!(info.dirty_count.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_reports_missing_for_nonexistent_path() {
        let dir = std::env::temp_dir().join(format!(
            "{}missing-{}",
            TEST_PREFIX,
            uuid::Uuid::new_v4().simple()
        ));
        let info = probe(dir.to_str().unwrap());
        assert_eq!(info.status, DevGitStatus::PathMissing);
        // 相对路径同样按 path_missing 处理（探测要求绝对路径）
        let rel = probe("not-an-absolute-path");
        assert_eq!(rel.status, DevGitStatus::PathMissing);
    }

    #[test]
    fn probe_reports_fresh_repo_with_branch_and_clean_status() {
        if !require_git() {
            return;
        }
        let dir = temp_sub("repo");
        git_in(&dir, &["init", "-q"]);
        let info = probe(dir.to_str().unwrap());
        assert_eq!(info.status, DevGitStatus::Ok);
        // 未born 分支也必须给出分支名（master 或 main，取决于 git 版本与配置）
        let branch = info.branch.expect("git init 后必须有分支名");
        assert!(
            branch == "master" || branch == "main",
            "默认分支应为 master/main，实际 {branch}"
        );
        assert!(!info.detached);
        assert!(!info.is_worktree);
        assert!(info.main_repo_path.is_none());
        // 未提交：无 HEAD SHA，无脏文件
        assert!(info.head_sha.is_none());
        assert_eq!(info.dirty_count, Some(0));

        // 提交后：HEAD SHA 可用且为 40 位十六进制
        init_repo_with_commit(&dir);
        let info = probe(dir.to_str().unwrap());
        let sha = info.head_sha.expect("提交后必须有 HEAD SHA");
        assert_eq!(sha.len(), 40);
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(info.dirty_count, Some(0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_counts_dirty_files_after_modification() {
        if !require_git() {
            return;
        }
        let dir = temp_sub("dirty");
        init_repo_with_commit(&dir);
        // 新增未跟踪文件 + 修改已跟踪文件 → porcelain 至少 2 行
        std::fs::write(dir.join("README.md"), "modified\n").expect("改文件");
        std::fs::write(dir.join("untracked.txt"), "new\n").expect("加文件");
        let info = probe(dir.to_str().unwrap());
        assert_eq!(info.status, DevGitStatus::Ok);
        let dirty = info.dirty_count.expect("成功探测必须有 dirty_count");
        assert!(dirty >= 2, "1 修改 + 1 未跟踪应 >= 2，实际 {dirty}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_detects_linked_worktree_and_main_repo_path() {
        if !require_git() {
            return;
        }
        let main = temp_sub("wt-main");
        init_repo_with_commit(&main);
        let linked = temp_sub("wt-linked");
        git_in(&main, &["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "feature"]);

        let info = probe(linked.to_str().unwrap());
        assert_eq!(info.status, DevGitStatus::Ok, "linked worktree 必须可探测");
        assert!(info.is_worktree, "linked worktree 必须识别为 worktree");
        assert_eq!(
            info.branch.as_deref(),
            Some("feature"),
            "worktree 分支名必须正确"
        );
        let main_path = info
            .main_repo_path
            .expect("worktree 必须给出主仓库路径");
        assert_eq!(
            norm_path(&main_path),
            norm_path(main.to_str().unwrap()),
            "主仓库路径必须一致（git 输出与本地路径仅分隔符/大小写差异）"
        );

        // 主仓库自身不是 worktree
        let main_info = probe(main.to_str().unwrap());
        assert!(!main_info.is_worktree);
        assert!(main_info.main_repo_path.is_none());

        // 清理 worktree 元数据后再删目录，避免残留引用（清理失败不影响断言）
        let _ = Command::new("git")
            .arg("-C")
            .arg(&main)
            .args(["worktree", "remove", "--force", linked.to_str().unwrap()])
            .output();
        let _ = std::fs::remove_dir_all(&main);
        let _ = std::fs::remove_dir_all(&linked);
    }

    #[test]
    fn probe_detects_detached_head() {
        if !require_git() {
            return;
        }
        let dir = temp_sub("detached");
        init_repo_with_commit(&dir);
        std::fs::write(dir.join("a.txt"), "second\n").expect("写文件");
        git_in(&dir, &["add", "."]);
        git_in(&dir, &["commit", "-q", "-m", "second"]);
        git_in(&dir, &["checkout", "-q", "--detach", "HEAD~1"]);
        let info = probe(dir.to_str().unwrap());
        assert_eq!(info.status, DevGitStatus::Ok);
        assert!(info.detached, "detach 后必须报告 detached");
        assert!(info.branch.is_none(), "detached 状态不得报告分支名");
        assert!(info.head_sha.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_run_reports_spawn_not_found_for_missing_executable() {
        // 用一个必然不存在的可执行名验证 spawn 失败路径（不依赖 git 是否安装）。
        let mut cmd = crate::winproc::hidden(format!(
            "td-no-such-bin-{}",
            uuid::Uuid::new_v4().simple()
        ));
        cmd.args(["--version"]);
        match run_command(&mut cmd) {
            GitRun::SpawnNotFound => {}
            other => panic!("不存在的可执行文件必须返回 SpawnNotFound，实际 {other:?}"),
        }
    }
}
