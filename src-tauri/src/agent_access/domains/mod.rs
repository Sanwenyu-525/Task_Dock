//! Agent 专业领域接入层（架构文档 V1.0 Phase 0）。
//!
//! 本模块把五类专业工作空间（开发 / 通用 / 小说 / 漫剧 / 游戏）的业务能力，
//! 以稳定的操作 ID 暴露给 CLI / MCP / REST / 文件四种 Agent 入口。
//!
//! 设计约束（见架构文档 §3）：
//! - 静态模块 + 显式枚举分发，不做动态插件 / trait object / JSON 反射调用；
//! - 注册中心只放静态元数据，**实际执行仍是各领域已有的 `*_impl` 业务函数**；
//! - Manifest 是能力发现，不是授权凭证；每次调用仍走完整权限与归属校验；
//! - 不新增第二套身份、权限、版本、幂等、审计系统，全部复用 `agent_access`。

pub mod comic;
pub mod idempotency;
pub mod manifest;
pub mod novel;
pub mod policy;
pub mod registry;
pub mod revision;

pub use manifest::{DomainManifest, DomainManifestOperation, ProjectDomainInfo};
pub use policy::{ensure_domain, ensure_domain_write, resource_access_error};
pub use registry::{
    all_operations, find_operation, DomainKind, DomainOperationDef, Interface, OperationAccess,
};
pub use revision::{bump_revision_from, read_revision_snapshot, RevisionSnapshot};
