#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && args[1] == "--agentctl" {
        // 无头模式：供自动化联调与运维（不启动窗口/托盘）
        std::process::exit(task_dock_lib::agentctl(&args[2..]));
    }
    if args.len() >= 2 && args[1] == "--agent-hook" {
        // Agent Hook 上报（旁路观测，绝不阻塞宿主；失败静默退出 0）
        std::process::exit(task_dock_lib::agents::hook_cli::run(&args[2..]));
    }
    task_dock_lib::run()
}
