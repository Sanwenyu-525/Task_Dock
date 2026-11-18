//! `taskdock` CLI 可执行入口（独立于 Tauri 主程序，不启动窗口）。
//!
//! 退出码与 `docs/agent-workspace/cli-specification.md` 一致：
//! 0 成功 / 2 用法 / 3 未找到 / 4 校验 / 5 冲突 / 6 权限 / 7 不可用 / 8 其他。

#![cfg_attr(not(debug_assertions), windows_subsystem = "console")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(task_dock_lib::agent_access::cli::main_entry(args));
}
