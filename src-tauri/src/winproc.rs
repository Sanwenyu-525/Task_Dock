//! 控制台窗口抑制：Release 构建是 windows 子系统 GUI 进程，没有父控制台，
//! 直接 spawn tasklist/reg/where/powershell 等控制台工具会新建并显示控制台窗口。

use std::ffi::OsStr;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 构造不弹出控制台窗口的命令（仅用于控制台工具；GUI 程序不受影响）。
pub fn hidden(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 有界执行外部命令：超时后强杀并回收，绝不无限等待。
///
/// `tasklist` / `reg query` / `where` / `<agent> --version` 都是控制台工具，
/// 在注册表/磁盘异常或第三方程序卡死时可能长时间不返回；发现扫描必须始终可控。
/// 返回 `None` 表示启动失败、超时、或进程无法回收，调用方按「该项不可用」处理。
pub fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<Output> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    child.wait_with_output().ok()
}

/// 便捷封装：`hidden(program).args(args)` + 超时。
pub fn run_with_timeout<I, S>(
    program: impl AsRef<OsStr>,
    args: I,
    timeout: Duration,
) -> Option<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut cmd = hidden(program);
    cmd.args(args);
    output_with_timeout(&mut cmd, timeout)
}

#[cfg(test)]
mod tests {
    #[test]
    fn hidden_command_still_runs_and_captures_output() {
        let out = super::hidden("cmd")
            .args(["/C", "echo", "ok"])
            .output()
            .expect("spawn cmd");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("ok"));
    }
}
