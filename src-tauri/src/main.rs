#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && args[1] == "--agentctl" {
        // 无头模式：供自动化联调与运维（不启动窗口/托盘）
        std::process::exit(task_dock_lib::agentctl(&args[2..]));
    }
    task_dock_lib::run()
}
