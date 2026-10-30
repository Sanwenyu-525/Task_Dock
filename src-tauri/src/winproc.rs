//! 控制台窗口抑制：Release 构建是 windows 子系统 GUI 进程，没有父控制台，
//! 直接 spawn tasklist/reg/where/powershell 等控制台工具会新建并显示控制台窗口。

use std::ffi::OsStr;
use std::process::Command;

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
