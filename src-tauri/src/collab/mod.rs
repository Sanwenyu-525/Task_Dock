//! 协作中心（collab）：外部 Agent + 需求/Bug + 方案 + 可视化 + 原型 + 任务 + 验收。
//!
//! 边界：
//! - 纯追加命名空间；不复制既有 planning / tasks / agent_access 实体；
//! - 所有入口（IPC / MCP）只调用 `service::Core`；
//! - 结构化渲染优先：原型只渲染白名单组件，不执行 HTML/JS；
//! - 版本只增不减；写冲突用 `revision` 乐观锁。

pub mod actor;
pub mod ai;
pub mod commands;
pub mod context;
pub mod evidence;
pub mod issue;
pub mod mcp_tools;
pub mod model;
pub mod plan;
pub mod prototype;
pub mod schema;
pub mod service;
pub mod util;
pub mod visual;

#[cfg(test)]
mod tests;
