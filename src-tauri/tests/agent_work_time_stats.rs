//! Agent 工作时间统计模块的独立编译 / 测试入口。
//!
//! 背景：`agent_stats` 模块由本任务实现，但 `lib.rs` 与 `commands/mod.rs` 属于并行
//! 会话的共享文件，需由集成会话接入。本测试把 `src/agent_stats/*` 以 `#[path]` 方式
//! 编入独立测试 crate，使聚合查询与时间线口径在接入前就能被 `cargo test` 验证；
//! 集成完成后可保留（等价于模块内单测）或删除，不影响正式代码。

pub mod db {
    pub use task_dock_lib::db::*;
}

pub mod agents {
    pub use task_dock_lib::agents::*;
}

pub mod error {
    pub use task_dock_lib::error::*;
}

#[path = "../src/agent_stats/mod.rs"]
pub mod agent_stats;
