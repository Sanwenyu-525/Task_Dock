//! 只读 git 探测：判断目录是否为 git 仓库/worktree、当前分支、HEAD 与脏文件数。
//!
//! 边界与安全：
//! - 全部命令只读（rev-parse / status / worktree list），绝不执行任何写操作；
//! - 不引入 git2 等依赖，直接调用用户 PATH 上的 `git` 可执行文件；
//! - 参数全部以数组传递，无 shell 拼接；Windows 下抑制控制台窗口（复用
//!   `winproc::hidden`，与 winproc.rs 既有 CREATE_NO_WINDOW 写法一致）；
//! - 每条命令 2s 超时（spawn 后循环 try_wait，超时 kill 并回收）：单步超时只
//!   降级对应字段（置 None），不整体 panic；
//! - **stdout 有实际字节上限**：边读边限制，超限部分直接丢弃并如实标记 truncated，
//!   不把整份输出先读进内存；stderr 直接丢弃（只读命令不需要错误文本，且避免
//!   未读取的管道把子进程堵死）；
//! - 只读调用统一注入 `GIT_OPTIONAL_LOCKS=0` / `GIT_TERMINAL_PROMPT=0`：前者避免
//!   git 为了「更新 index 状态」去抢写锁，后者避免凭证提示挂住探测；
//! - 不缓存、不落库：每次调用都实时探测，结果只反映当次状态。

use serde::Serialize;
use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
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
/// dirty 条目统计上限：超大仓库只统计前 5000 条，避免单次探测卡顿。
const DIRTY_LINE_CAP: usize = 5000;
/// try_wait 轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// 单条只读命令保留的 stdout 字节上限（1 MiB）。
///
/// 上限作用在**读取阶段**：读满之后继续把管道读空但丢弃，这样既不会因为
/// 未读取而让子进程写管道阻塞，也不会把整份输出驻留内存。
pub const STDOUT_BYTE_CAP: usize = 1 << 20;

/// 只读命令的有界输出。`truncated = true` 表示 stdout 触达字节上限被截断，
/// 调用方必须如实标记，不能把截断结果当成完整输出。
#[derive(Debug)]
pub struct GitRead {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub truncated: bool,
}

/// 只读命令失败形态：与「空输出」严格区分，调用方不得把失败当成「没有改动」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitReadError {
    /// spawn 失败（典型：PATH 上没有 git 可执行文件）。
    SpawnNotFound,
    /// 超过 `STEP_TIMEOUT`：子进程已 kill 并回收。
    Timeout,
    /// 命令执行了但退出码非 0。
    CommandFailed,
    /// 管道读取 / 线程异常。
    Io,
}

/// 解析后的 porcelain 单条记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitStatusEntry {
    /// 两位 XY 状态码（如 `M ` / `??` / `UU` / `R `）。
    pub status: String,
    /// 当前路径；重命名 / 复制记录取**新路径**。
    pub path: String,
    /// 重命名 / 复制的原路径（`-z` 格式中位于下一条记录）。
    pub orig_path: Option<String>,
}

/// 一次 status 读取的结果：条目 + 是否因条目/字节上限被截断。
#[derive(Debug)]
pub struct GitStatusSnapshot {
    pub entries: Vec<GitStatusEntry>,
    pub truncated: bool,
}

/// 执行 `<program> -C <root> <args>`：无 shell、无窗口、有超时、有字节上限。
/// program 一般为 "git"；probe_with_program 测试缝可注入必然不存在的名字，
/// 触发与「git 未安装」一致的 spawn NotFound 路径。
fn run_git(program: &str, root_path: &str, args: &[&str]) -> Result<GitRead, GitReadError> {
    let mut cmd = crate::winproc::hidden(program);
    cmd.args(["-C", root_path]);
    cmd.args(args);
    run_command(&mut cmd, STDOUT_BYTE_CAP)
}

/// 在独立线程里读取 stdout：保留至多 `cap` 字节，其余继续读空并丢弃。
fn read_stdout_bounded(
    mut pipe: impl Read + Send + 'static,
    cap: usize,
) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
    std::thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut buf = [0u8; 8192];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                // 管道被 kill 关闭：已有部分内容仍然有效，按读到为止返回。
                Err(_) => break,
                Ok(n) => {
                    let room = cap.saturating_sub(kept.len());
                    if room == 0 {
                        truncated = true;
                        continue;
                    }
                    let take = room.min(n);
                    kept.extend_from_slice(&buf[..take]);
                    if take < n {
                        truncated = true;
                    }
                }
            }
        }
        (kept, truncated)
    })
}

/// 有界执行：spawn 后循环 try_wait，超时 kill 并回收，绝不无限等待。
/// 失败一律返回 `GitReadError`，调用方据此把对应字段置 None 或如实报错。
fn run_command(cmd: &mut Command, cap: usize) -> Result<GitRead, GitReadError> {
    cmd.stdout(Stdio::piped())
        // stderr 不需要：只读命令的失败信息由退出码表达；丢弃可避免未读取的
        // 管道写满后把子进程阻塞在 write() 上。
        .stderr(Stdio::null());
    // 只读探测绝不能让 git 去抢 index 写锁或等待终端凭证输入。
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => return Err(GitReadError::SpawnNotFound),
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(GitReadError::Io);
    };
    let reader = read_stdout_bounded(stdout, cap);
    let started = Instant::now();
    let status: ExitStatus = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= STEP_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    // 进程结束后管道关闭，读线程会自行退出；join 只是避免线程泄漏。
                    let _ = reader.join();
                    return Err(GitReadError::Timeout);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(GitReadError::Io);
            }
        }
    };
    let (stdout, truncated) = reader.join().map_err(|_| GitReadError::Io)?;
    Ok(GitRead {
        success: status.success(),
        stdout,
        truncated,
    })
}

/// 解析 `git status --porcelain -z` 输出。
///
/// `-z` 形态：NUL 分隔、**不做 C 风格引号转义**，因此前导空格、Unicode、空格与
/// 特殊字符都是路径原文；重命名 / 复制记录先给新路径，紧随其后的记录给原路径
/// （`R  new\0old\0`）。
///
/// 第二个返回值表示「末尾记录不完整」：输出为空或不以 NUL 结尾时（字节上限
/// 截断），最后一条路径可能是半截的，调用方必须把结果标为 truncated，不能把
/// 半截路径当成真实文件名。
pub fn parse_status_z(bytes: &[u8]) -> (Vec<GitStatusEntry>, bool) {
    let mut out = Vec::new();
    if bytes.is_empty() {
        return (out, false);
    }
    let tail_partial = bytes.last().copied() != Some(0);
    let mut iter = bytes.split(|b| *b == 0).peekable();
    while let Some(chunk) = iter.next() {
        if chunk.is_empty() {
            continue;
        }
        // `XY <path>` 至少 4 字节：状态 2 字节 + 1 个空格 + 至少 1 字节路径。
        if chunk.len() < 4 {
            continue;
        }
        let status = String::from_utf8_lossy(&chunk[..2]).to_string();
        // git 保证第 3 字节是空格；异常时按无分隔处理，绝不 trim_start 掉路径
        // 自身合法的前导空格。
        let path_bytes = if chunk[2] == b' ' {
            &chunk[3..]
        } else {
            &chunk[2..]
        };
        if path_bytes.is_empty() {
            continue;
        }
        let is_rename = status.starts_with('R') || status.starts_with('C');
        let orig_path = if is_rename {
            iter.next()
                .filter(|c| !c.is_empty())
                .map(|c| String::from_utf8_lossy(c).to_string())
        } else {
            None
        };
        out.push(GitStatusEntry {
            status,
            path: String::from_utf8_lossy(path_bytes).to_string(),
            orig_path,
        });
    }
    (out, tail_partial)
}

/// 只读读取一个仓库的 porcelain 状态（`-z -uall`）。
///
/// `-uall` 把未跟踪目录展开成逐文件条目（默认折叠会把整个新目录记成一条
/// `?? dir/`，丢失文件级判定所需的路径）。条目数与字节数双上限，超限如实标记。
pub fn status_entries(root_path: &str, entry_cap: usize) -> Result<GitStatusSnapshot, GitReadError> {
    let read = run_git("git", root_path, &["status", "--porcelain", "-z", "-uall"])?;
    if !read.success {
        return Err(GitReadError::CommandFailed);
    }
    let (mut entries, tail_partial) = parse_status_z(&read.stdout);
    let over_cap = entries.len() > entry_cap;
    let truncated = read.truncated || tail_partial || over_cap;
    entries.truncate(entry_cap);
    Ok(GitStatusSnapshot { entries, truncated })
}

/// stdout 按行取出并 UTF-8 lossy 解码（仅用于非 `-z` 输出，如 worktree list）。
fn stdout_lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
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

/// 一次探测的完整结果：Git 摘要 + 同一条 `status` 命令解析出的改动条目。
///
/// 存在意义：DWS 既需要分支 / 脏计数（摘要），又需要逐文件改动清单（风险判定）。
/// 过去两条命令各跑一次 `git status`，现在一次读取同时满足两者，避免重复执行
/// 相同命令，也避免两次结果之间出现竞态（第二次读到的已不是同一个工作树状态）。
#[derive(Debug)]
pub struct DevGitProbe {
    pub info: DevGitInfo,
    /// status 读取成功时的改动条目（已按 entry_cap 截断）；读取失败为 None。
    pub status_entries: Option<Vec<GitStatusEntry>>,
    /// status 读取失败原因（超时 / git 缺失 / 退出码异常）。
    /// `status_error.is_some()` 时 `info.dirty_count` 必为 None —— 调用方不得把
    /// 「没读到」显示成「没有改动」。
    pub status_error: Option<GitReadError>,
    /// 条目数或字节数触达上限被截断。
    pub status_truncated: bool,
}

/// 只读探测一个目录的 git 状态。永不 panic：任何一步失败都降级为对应字段为空。
pub fn probe(root_path: &str) -> DevGitInfo {
    probe_core(root_path, "git", DIRTY_LINE_CAP, false).info
}

/// 探测并同时返回改动条目（`-uall` 展开未跟踪目录）。条目数上限由调用方给定。
pub fn probe_detailed(root_path: &str, entry_cap: usize) -> DevGitProbe {
    probe_core(root_path, "git", entry_cap, true)
}

/// probe 的测试缝：`git_program` 为 Some(name) 时用 name 替代 "git"。
///
/// 原理与限制（选型说明）：
/// - Windows 上 `Command` 的可执行文件解析发生在 spawn 时、依据**父进程**的
///   PATH，子进程环境变量（`.env("PATH", …)`）不影响解析，因此无法用环境
///   变量伪造「git 不存在」——`probe_with_env_path` 形态的缝不可靠；
/// - `run_command` 把一切 spawn 失败（含 `ErrorKind::NotFound`）都归为
///   `GitReadError::SpawnNotFound`，probe 对它统一降级 `git_unavailable`。
///   所以注入一个必然不存在的程序名即可复现与「git 未安装」**完全相同**的
///   代码路径，断言结果与真实缺失等价；
/// - 生产路径 `probe()` 传 None，行为与引入本缝之前逐字节一致；
/// - 覆盖范围：本缝只复现 spawn 失败形态的 git_unavailable；「git 存在但
///   单步超时」形态由 `run_command` 的 Timeout 分支覆盖，不属本缝范围。
pub fn probe_with_program(root_path: &str, git_program: Option<&str>) -> DevGitInfo {
    let program = git_program.unwrap_or("git");
    probe_core(root_path, program, DIRTY_LINE_CAP, false).info
}

/// 探测主体：`expand_untracked=true` 时额外返回逐文件改动条目。
fn probe_core(
    root_path: &str,
    program: &str,
    entry_cap: usize,
    expand_untracked: bool,
) -> DevGitProbe {
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
    let fail = |info: DevGitInfo, err: GitReadError| DevGitProbe {
        info,
        status_entries: None,
        status_error: Some(err),
        status_truncated: false,
    };
    let path = std::path::Path::new(root_path);
    if !path.is_absolute() || !path.is_dir() {
        return DevGitProbe {
            info: missing,
            status_entries: None,
            status_error: None,
            status_truncated: false,
        };
    }

    // ① 是否位于 git 工作树内：失败则终止（不是仓库 / git 不可用）。
    match run_git(program, root_path, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(read) if read.success && read.stdout.starts_with(b"true") => {}
        // 非成功退出：git 2.x 对非仓库目录输出 "fatal: not a git repository..."；
        // 其他失败（权限异常等）同样无法继续探测，统一按 not_a_repo 降级。
        Ok(_) => {
            return DevGitProbe {
                info: DevGitInfo {
                    status: DevGitStatus::NotARepo,
                    ..missing
                },
                status_entries: None,
                status_error: None,
                status_truncated: false,
            };
        }
        // spawn 失败 = git 不存在；超时 = 本次无法判定：两者都按 git 不可用降级。
        Err(e) => {
            return fail(
                DevGitInfo {
                    status: DevGitStatus::GitUnavailable,
                    ..missing
                },
                e,
            );
        }
    }

    // ② 当前分支：detached 时 --abbrev-ref 输出字面 "HEAD"（成功退出）；
    //    未born 分支（git init 后未提交）退出码非 0 且 stdout 也是 "HEAD"，
    //    用 symbolic-ref 兜底拿分支名。
    let mut branch: Option<String> = None;
    let mut detached = false;
    match run_git(program, root_path, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(read) if read.success => {
            let name = String::from_utf8_lossy(&read.stdout).trim().to_string();
            if name == "HEAD" {
                detached = true;
            } else if !name.is_empty() {
                branch = Some(name);
            }
        }
        Ok(_) => {
            // 未born 分支：symbolic-ref 直接解析 HEAD 指向的引用名。
            if let Ok(read) = run_git(program, root_path, &["symbolic-ref", "--short", "HEAD"]) {
                if read.success {
                    let name = String::from_utf8_lossy(&read.stdout).trim().to_string();
                    if !name.is_empty() {
                        branch = Some(name);
                    }
                }
            }
        }
        Err(_) => {}
    }

    // ③ HEAD SHA：未born 分支必然失败，保持 None 即可。
    let head_sha = match run_git(program, root_path, &["rev-parse", "HEAD"]) {
        Ok(read) if read.success => {
            let sha = String::from_utf8_lossy(&read.stdout).trim().to_string();
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
    let (is_worktree, main_repo_path) = match (
        run_git(program, root_path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        run_git(program, root_path, &["rev-parse", "--path-format=absolute", "--git-dir"]),
    ) {
        (Ok(common), Ok(git_dir)) if common.success && git_dir.success => {
            let common = String::from_utf8_lossy(&common.stdout).trim().to_string();
            let git_dir = String::from_utf8_lossy(&git_dir.stdout).trim().to_string();
            if !common.is_empty() && common != git_dir {
                // worktree list --porcelain 首行：`worktree <主仓库路径>`
                let main = match run_git(program, root_path, &["worktree", "list", "--porcelain"]) {
                    Ok(read) if read.success => stdout_lines(&read.stdout)
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

    // ⑤ 改动条目：`-z` 输出（NUL 分隔、无引号转义），一次读取同时得到计数与清单。
    let status_args: &[&str] = if expand_untracked {
        &["status", "--porcelain", "-z", "-uall"]
    } else {
        &["status", "--porcelain", "-z"]
    };
    let mut status_error: Option<GitReadError> = None;
    let mut status_truncated = false;
    let mut status_entries: Option<Vec<GitStatusEntry>> = None;
    let dirty_count = match run_git(program, root_path, status_args) {
        Ok(read) if read.success => {
            let (mut entries, tail_partial) = parse_status_z(&read.stdout);
            let over_cap = entries.len() > entry_cap;
            status_truncated = read.truncated || tail_partial || over_cap;
            entries.truncate(entry_cap);
            let count = entries.len() as i64;
            if expand_untracked {
                status_entries = Some(entries);
            }
            Some(count)
        }
        // 退出码非 0 / 超时 / git 缺失：计数置 None，并保留失败原因供上层如实提示。
        Ok(_) => {
            status_error = Some(GitReadError::CommandFailed);
            None
        }
        Err(e) => {
            status_error = Some(e);
            None
        }
    };

    DevGitProbe {
        info: DevGitInfo {
            status: DevGitStatus::Ok,
            branch,
            detached,
            is_worktree,
            main_repo_path,
            head_sha,
            dirty_count,
            probed_at,
        },
        status_entries,
        status_error,
        status_truncated,
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
        match run_command(&mut cmd, STDOUT_BYTE_CAP) {
            Err(GitReadError::SpawnNotFound) => {}
            other => panic!("不存在的可执行文件必须返回 SpawnNotFound，实际 {other:?}"),
        }
    }

    /// stdout 字节上限必须作用在读取阶段：超过上限时保留前缀并标记 truncated，
    /// 而不是先整份读进内存再截断展示。
    #[test]
    fn run_command_truncates_stdout_at_byte_cap() {
        if !require_git() {
            return;
        }
        let mut cmd = crate::winproc::hidden("git");
        cmd.args(["--version"]);
        let read = run_command(&mut cmd, 8).expect("git --version 必须可执行");
        assert!(read.success, "git --version 必须成功");
        assert_eq!(read.stdout.len(), 8, "超过上限必须只保留上限字节");
        assert!(read.truncated, "超过字节上限必须标记 truncated");
    }

    /// porcelain `-z` 解析：前导空格路径不被 trim、Unicode 原样保留、
    /// 重命名取新路径并记录原路径、末尾半截记录提示截断。
    #[test]
    fn parse_status_z_keeps_leading_space_unicode_and_rename() {
        // `XY <path>\0`；重命名记录为 `R  new\0old\0`。
        let raw = concat!(
            " M  lead space.txt\u{0}",
            "?? 中文 目录/文件.txt\u{0}",
            "R  src/new name.ts\u{0}src/old name.ts\u{0}",
            "A  a.txt\u{0}",
        );
        let (entries, tail) = parse_status_z(raw.as_bytes());
        assert!(!tail, "以 NUL 结尾的输出不应标记半截");
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].status, " M");
        assert_eq!(entries[0].path, " lead space.txt");
        assert_eq!(entries[1].status, "??");
        assert_eq!(entries[1].path, "中文 目录/文件.txt");
        assert_eq!(entries[2].status, "R ");
        assert_eq!(entries[2].path, "src/new name.ts");
        assert_eq!(entries[2].orig_path.as_deref(), Some("src/old name.ts"));
        assert_eq!(entries[3].path, "a.txt");

        // 字节上限把最后一条路径截成半截：必须报 tail_partial，不能当成真实文件名。
        let cut = "A  partial-long-name.txt".as_bytes();
        let (entries, tail) = parse_status_z(&cut[..12]);
        assert!(tail, "不以 NUL 结尾的输出必须标记半截");
        assert!(entries.is_empty() || entries.len() == 1);
    }

    /// 真实仓库：特殊路径（前导空格 / Unicode / 空格 / 重命名）全部按原文解析。
    #[test]
    fn status_entries_handles_special_paths_in_real_repo() {
        if !require_git() {
            return;
        }
        let dir = temp_sub("weird-paths");
        init_repo_with_commit(&dir);
        std::fs::write(dir.join(" lead.txt"), "x\n").expect("写前导空格文件");
        std::fs::write(dir.join("中文 文件.txt"), "x\n").expect("写 Unicode 文件");
        std::fs::write(dir.join("with space.txt"), "x\n").expect("写含空格文件");
        // 重命名：README.md → renamed readme.md（工作树内 staged rename）。
        git_in(&dir, &["mv", "README.md", "renamed readme.md"]);

        let snap = status_entries(dir.to_str().unwrap(), 50).expect("status 必须可读");
        assert!(!snap.truncated, "少量改动不应标记截断");
        let paths: Vec<&str> = snap.entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&" lead.txt"), "前导空格路径必须原样保留: {paths:?}");
        assert!(paths.contains(&"中文 文件.txt"), "Unicode 路径必须原样保留: {paths:?}");
        assert!(paths.contains(&"with space.txt"), "含空格路径必须原样保留: {paths:?}");
        let renamed = snap
            .entries
            .iter()
            .find(|e| e.path == "renamed readme.md")
            .expect("重命名必须给出新路径");
        assert_eq!(renamed.orig_path.as_deref(), Some("README.md"));
        assert!(renamed.status.starts_with('R'));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 条目数上限：超过 cap 时只保留 cap 条并标记 truncated。
    #[test]
    fn status_entries_marks_truncated_at_entry_cap() {
        if !require_git() {
            return;
        }
        let dir = temp_sub("many-files");
        init_repo_with_commit(&dir);
        for i in 0..8 {
            std::fs::write(dir.join(format!("bulk-{i}.txt")), "x\n").expect("写批量文件");
        }
        let snap = status_entries(dir.to_str().unwrap(), 3).expect("status 必须可读");
        assert_eq!(snap.entries.len(), 3, "必须截断到条目上限");
        assert!(snap.truncated, "超过条目上限必须标记 truncated");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// probe_detailed 一次命令同时给出 dirty 计数与条目，且与 probe 的计数一致。
    #[test]
    fn probe_detailed_reuses_single_status_read() {
        if !require_git() {
            return;
        }
        let dir = temp_sub("detail");
        init_repo_with_commit(&dir);
        std::fs::write(dir.join("README.md"), "modified\n").expect("改文件");
        std::fs::create_dir_all(dir.join("newdir")).expect("建目录");
        std::fs::write(dir.join("newdir").join("a.txt"), "new\n").expect("写新文件");

        let detailed = probe_detailed(dir.to_str().unwrap(), 50);
        assert_eq!(detailed.info.status, DevGitStatus::Ok);
        assert!(detailed.status_error.is_none(), "正常仓库不应有 status 错误");
        assert!(!detailed.status_truncated);
        let entries = detailed.status_entries.expect("展开模式必须给出条目");
        // `-uall` 展开未跟踪目录：newdir/ 必须变成 newdir/a.txt，而不是目录一条。
        assert!(entries.iter().any(|e| e.path == "newdir/a.txt"), "{entries:?}");
        assert_eq!(
            detailed.info.dirty_count,
            Some(entries.len() as i64),
            "dirty 计数必须与同一次读取的条目数一致"
        );

        let info = probe(dir.to_str().unwrap());
        assert_eq!(info.dirty_count, detailed.info.dirty_count);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// probe 入口端到端：git 可执行文件缺失时整体降级 git_unavailable，
    /// 所有探测字段为空、probed_at 始终有值；全程只读、不 panic。
    /// 本测试不依赖 git 是否安装（缺失形态本来就是被测对象）。
    #[test]
    fn probe_reports_git_unavailable_when_executable_missing() {
        // 目录真实存在且为目录：排除 path_missing 干扰，断言只针对 git 缺失
        let dir = temp_sub("no-git");
        let absent = format!("td-git-absent-{}", uuid::Uuid::new_v4().simple());
        let info = probe_with_program(dir.to_str().unwrap(), Some(&absent));
        assert_eq!(info.status, DevGitStatus::GitUnavailable);
        assert!(info.branch.is_none(), "git 缺失不得报告分支");
        assert!(info.head_sha.is_none(), "git 缺失不得报告 HEAD");
        assert!(info.dirty_count.is_none(), "git 缺失不得报告脏文件数");
        assert!(info.main_repo_path.is_none());
        assert!(!info.detached);
        assert!(!info.is_worktree);
        assert!(!info.probed_at.is_empty(), "probed_at 必须始终有值");
        // None 缝与生产 probe 行为一致（同为默认程序名，这里目录无 git → not_a_repo）
        let via_none = probe_with_program(dir.to_str().unwrap(), None);
        assert_eq!(via_none.status, DevGitStatus::NotARepo);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
