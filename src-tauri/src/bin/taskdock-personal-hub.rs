//! `taskdock-personal-hub` —— Personal Hub v1.0 独立普通用户进程入口。
//!
//! 关键约束（基线 D2 / §4.1）：
//! - 与 Tauri WebView GUI 完全分离的独立进程；关闭主窗口不终止本进程。
//! - 不以 SYSTEM / SCM 服务运行；不监听 0.0.0.0 或任何公网网卡。
//! - 本地管理接口只走当前用户 ACL 保护的 Named Pipe。
//!
//! 本文件是进程骨架：不写配对(P3)、本机认证(P5)、远控(P6)、云端(P2) 代码。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// personal_hub 模块不挂到 GUI 的 lib.rs（共享枢纽文件由主 Agent 集成时处理）。
// 通过 #[path] 让本独立进程直接编译该模块，保持与 GUI 的完全解耦。
#[path = "../personal_hub/mod.rs"]
mod personal_hub;

use personal_hub::{HubConfig, PersonalHubService, StopReason};

fn main() {
    let service = PersonalHubService::new();

    let config = HubConfig::default();
    match service.start(config.clone()) {
        Ok(status) => {
            eprintln!(
                "taskdock-personal-hub started: state={:?}, pipe={:?}",
                status.state, status.pipe_name
            );
        }
        Err(err) => {
            eprintln!("taskdock-personal-hub failed to start: {}", err);
            std::process::exit(1);
        }
    }

    // 阻塞直到管道线程结束：收到 STOP 命令或底层异常。
    service.wait_for_shutdown();

    // 显式收尾（仅用户经本地管道触发 STOP 或进程自身退出，关主窗口不调用）。
    if let Err(err) = service.stop(StopReason::ExplicitUserRequest) {
        eprintln!("taskdock-personal-hub stop error: {}", err);
        std::process::exit(1);
    }
    eprintln!("taskdock-personal-hub stopped");
}
