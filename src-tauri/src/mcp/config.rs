//! MCP 客户端配置片段生成。
//!
//! 格式来源（2026-11 核实，见交付报告引用）：
//! - Claude Code：项目根 `.mcp.json`（或 `claude mcp add`），顶层 `mcpServers`，
//!   每项 `{ "type": "stdio", "command", "args", "env" }`；
//!   https://code.claude.com/docs/en/mcp
//! - Codex CLI：`~/.codex/config.toml` 的 `[mcp_servers.<id>]`，
//!   `command` / `args` / `env`；
//!   https://learn.chatgpt.com/docs/config-file/config-reference
//! - Cursor：`~/.cursor/mcp.json`（或项目 `.cursor/mcp.json`），`mcpServers`，
//!   `{ "command", "args", "env" }`；
//!   https://cursor.com/docs/mcp
//! - Trae：其 MCP 配置的 `mcpServers` JSON，`{ "command", "args", "env" }`；
//!   https://docs.trae.ai/ide/add-mcp-servers
//! - generic：Claude Code 风格的通用 JSON（大多数 MCP 客户端兼容该形态）。
//!
//! 片段只含 agent token（用户主动生成并保存的凭据），由用户自行粘贴到
//! 对应客户端配置；Task Dock 不代写任何第三方客户端的配置文件。

use crate::error::{AppError, AppResult};

pub const CLIENTS: &[&str] = &["claude-code", "codex", "cursor", "trae", "generic"];

fn escape_toml(s: &str) -> String {
    // 单引号 literal string：只需处理内部单引号（拆成两段拼接）
    s.replace('\'', "''")
}

fn escape_json(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

pub fn config_snippet(client: &str, exe_path: &str, agent_token: &str) -> AppResult<String> {
    if agent_token.trim().is_empty() {
        return Err(AppError::Validation(
            "agent token 不能为空（请先用 mcp_agent_create 生成）".into(),
        ));
    }
    match client {
        "claude-code" | "generic" => Ok(format!(
            r#"{{
  "mcpServers": {{
    "taskdock": {{
      {type_field}"command": {command},
      "args": ["--mcp-server"],
      "env": {{
        "TASKDOCK_MCP_TOKEN": {token}
      }}
    }}
  }}
}}"#,
            type_field = if client == "claude-code" {
                "\"type\": \"stdio\",\n      "
            } else {
                ""
            },
            command = escape_json(exe_path),
            token = escape_json(agent_token),
        )),
        "codex" => Ok(format!(
            r#"# ~/.codex/config.toml
[mcp_servers.taskdock]
command = '{command}'
args = ["--mcp-server"]
env = {{ "TASKDOCK_MCP_TOKEN" = '{token}' }}"#,
            command = escape_toml(exe_path),
            token = escape_toml(agent_token),
        )),
        "cursor" | "trae" => {
            let path_hint = if client == "cursor" {
                "~/.cursor/mcp.json（全局）或项目 .cursor/mcp.json"
            } else {
                "Trae 的 MCP 配置文件（设置 → MCP → 手动添加 JSON）"
            };
            Ok(format!(
                r#"// {path_hint}
{{
  "mcpServers": {{
    "taskdock": {{
      "command": {command},
      "args": ["--mcp-server"],
      "env": {{
        "TASKDOCK_MCP_TOKEN": {token}
      }}
    }}
  }}
}}"#,
                command = escape_json(exe_path),
                token = escape_json(agent_token),
            ))
        }
        other => Err(AppError::Validation(format!(
            "未知客户端: {other}（允许 {}）",
            CLIENTS.join(" | ")
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_snippet_has_mcp_servers_with_type() {
        let s = config_snippet("claude-code", "C:\\app\\taskdock.exe", "tdm_abc").unwrap();
        assert!(s.contains("\"mcpServers\""));
        assert!(s.contains("\"type\": \"stdio\""));
        assert!(s.contains("\"command\": \"C:\\\\app\\\\taskdock.exe\""));
        assert!(s.contains("\"--mcp-server\""));
        assert!(s.contains("TASKDOCK_MCP_TOKEN"));
        assert!(s.contains("tdm_abc"));
    }

    #[test]
    fn codex_snippet_is_toml() {
        let s = config_snippet("codex", "C:\\app\\taskdock.exe", "tdm_x").unwrap();
        assert!(s.contains("[mcp_servers.taskdock]"));
        assert!(s.contains("command = 'C:\\app\\taskdock.exe'"));
        assert!(s.contains("env = { \"TASKDOCK_MCP_TOKEN\" = 'tdm_x' }"));
    }

    #[test]
    fn cursor_and_trae_use_plain_mcp_servers_json() {
        for client in ["cursor", "trae"] {
            let s = config_snippet(client, "exe", "tok").unwrap();
            assert!(s.contains("\"mcpServers\""));
            assert!(!s.contains("\"type\""), "{client} 不需要 type 字段");
        }
    }

    #[test]
    fn unknown_client_rejected_and_empty_token_rejected() {
        assert!(config_snippet("windsurf", "exe", "tok").is_err());
        assert!(config_snippet("codex", "exe", "  ").is_err());
    }
}
