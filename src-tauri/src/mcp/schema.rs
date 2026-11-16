//! MCP 资源授权相关的表结构（迁移 64）。
//!
//! 为什么单独一个迁移号：`db::MIGRATIONS` 是共享枢纽文件，59–63 已被创作工作台
//! 五条线占用；MCP 只追加自己的常量，不改动其他领域 DDL，避免并发改同一文件。
//!
//! 三张表各司其职，**互不越界**：
//! - `mcp_agent_capabilities`：能力 × 资源范围授权。`resource_id = ''` 表示全局，
//!   否则只对该条资源（任务 id / 笔记 id / 工作流 id）生效。
//! - `mcp_note_ownership`：Agent 通过 MCP 创建的笔记归属。归属只表示「可读写自己
//!   创建的笔记」，不等于读取用户全部私人笔记——那需要显式 `notes.read` 授权。
//! - `mcp_workspace_roots`：用户显式授予 Agent 的文件工作区根目录（绝对路径）。
//!   没有根目录授权的 Agent 无法读取任何文件，路径校验以规范化后的真实路径为准。

pub const MIGRATION_64: (i64, &str) = (
    64,
    r#"
-- v64（MCP 资源能力授权）：在既有 scope（disabled/readonly/project_rw）之上，
-- 为任务、笔记、工作流、文件工作区增加独立的资源能力。scope 仍决定「能否调用工具」，
-- 本表决定「能触达哪些资源」。默认无授权 = 最小权限，未授权明确拒绝、不降级执行。
CREATE TABLE mcp_agent_capabilities (
  id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN (
    'tasks.read','tasks.write','notes.read','notes.write','workflows.read','workspace.read'
  )),
  -- '' = 全局能力；非空 = 仅该资源（任务/笔记/工作流 id）
  resource_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (agent_row_id, capability, resource_id)
);
CREATE INDEX idx_mcp_caps_agent ON mcp_agent_capabilities(agent_row_id, capability);

-- Agent 通过 MCP 创建的笔记归属。删除 Agent 级联清理；笔记本身不级联删除，
-- 避免一次凭据撤销连带销毁用户内容（保留为普通笔记，用户仍可读）。
CREATE TABLE mcp_note_ownership (
  note_id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mcp_note_owner ON mcp_note_ownership(agent_row_id);

-- 文件工作区根目录授权。root_path 存规范化后的绝对路径（Windows 忽略大小写）。
CREATE TABLE mcp_workspace_roots (
  id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  UNIQUE (agent_row_id, root_path)
);
CREATE INDEX idx_mcp_workspace_roots_agent ON mcp_workspace_roots(agent_row_id);
"#,
);
