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
//! **可粘贴边界**：返回值必须能被对应客户端直接解析——
//! - JSON 客户端：严格 JSON，不含 `//` 注释、不含尾逗号；
//! - Codex：严格 TOML，字符串使用 basic string（`"..."`）并转义反斜杠/引号，
//!   因为 TOML literal string（`'...'`）没有任何转义手段，路径含 `'` 即损坏。
//!
//! 客户端配置文件路径提示由 [`config_hint`] 单独返回，**不得混入配置正文**。
//! Task Dock 只生成片段，不代写任何第三方客户端配置文件。

use crate::error::{AppError, AppResult};

pub const CLIENTS: &[&str] = &["claude-code", "codex", "cursor", "trae", "generic"];

/// TOML basic string 转义：反斜杠与双引号，控制字符按 TOML 规则转义。
fn escape_toml_basic(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

fn escape_json(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// 客户端配置文件位置说明（纯文字，不可粘贴执行）。
pub fn config_hint(client: &str) -> AppResult<&'static str> {
    match client {
        "claude-code" => Ok(
            "写入项目根目录的 .mcp.json（团队共享），或用 `claude mcp add` 写入用户级配置。",
        ),
        "codex" => Ok("追加到 ~/.codex/config.toml（Windows 为 %USERPROFILE%\\.codex\\config.toml）。"),
        "cursor" => Ok("写入 ~/.cursor/mcp.json（全局）或项目内 .cursor/mcp.json。"),
        "trae" => Ok("在 Trae 设置 → MCP → 手动添加 JSON 中粘贴。"),
        "generic" => Ok("任何接受 mcpServers JSON 的 MCP 客户端均可使用。"),
        other => Err(AppError::Validation(format!(
            "未知客户端: {other}（允许 {}）",
            CLIENTS.join(" | ")
        ))),
    }
}

pub fn config_snippet(client: &str, exe_path: &str, agent_token: &str) -> AppResult<String> {
    if agent_token.trim().is_empty() {
        return Err(AppError::Validation(
            "agent token 不能为空（请先用 mcp_agent_create 生成）".into(),
        ));
    }
    match client {
        "claude-code" => Ok(format!(
            r#"{{
  "mcpServers": {{
    "taskdock": {{
      "type": "stdio",
      "command": {},
      "args": ["--mcp-server"],
      "env": {{
        "TASKDOCK_MCP_TOKEN": {}
      }}
    }}
  }}
}}"#,
            escape_json(exe_path),
            escape_json(agent_token),
        )),
        "generic" | "cursor" | "trae" => Ok(format!(
            r#"{{
  "mcpServers": {{
    "taskdock": {{
      "command": {},
      "args": ["--mcp-server"],
      "env": {{
        "TASKDOCK_MCP_TOKEN": {}
      }}
    }}
  }}
}}"#,
            escape_json(exe_path),
            escape_json(agent_token),
        )),
        "codex" => Ok(format!(
            r#"[mcp_servers.taskdock]
command = "{}"
args = ["--mcp-server"]
env = {{ "TASKDOCK_MCP_TOKEN" = "{}" }}"#,
            escape_toml_basic(exe_path),
            escape_toml_basic(agent_token),
        )),
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
    fn claude_code_snippet_is_strict_json_with_stdio_type() {
        let s = config_snippet("claude-code", "C:\\app\\taskdock.exe", "tdm_abc").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&s).expect("必须是严格 JSON");
        assert_eq!(parsed["mcpServers"]["taskdock"]["type"], "stdio");
        assert_eq!(
            parsed["mcpServers"]["taskdock"]["command"],
            "C:\\app\\taskdock.exe"
        );
        assert_eq!(
            parsed["mcpServers"]["taskdock"]["env"]["TASKDOCK_MCP_TOKEN"],
            "tdm_abc"
        );
    }

    #[test]
    fn cursor_and_trae_snippets_contain_no_comments_and_parse_as_json() {
        for client in ["cursor", "trae", "generic"] {
            let s = config_snippet(client, "C:\\Program Files\\Task Dock\\taskdock.exe", "tok")
                .unwrap();
            assert!(!s.contains("//"), "{client} 片段不得包含 JSON 注释");
            let parsed: serde_json::Value =
                serde_json::from_str(&s).unwrap_or_else(|e| panic!("{client} 不是合法 JSON: {e}"));
            assert_eq!(parsed["mcpServers"]["taskdock"]["args"][0], "--mcp-server");
            assert_eq!(
                parsed["mcpServers"]["taskdock"]["command"],
                "C:\\Program Files\\Task Dock\\taskdock.exe"
            );
        }
    }

    #[test]
    fn codex_snippet_escapes_windows_paths_and_quotes() {
        let s = config_snippet("codex", "C:\\Program Files\\it's\\taskdock.exe", "tdm_x").unwrap();
        // TOML basic string：反斜杠必须成对，双引号转义；literal string 会损坏路径
        assert!(s.contains(r#"command = "C:\\Program Files\\it's\\taskdock.exe""#));
        assert!(s.contains(r#"env = { "TASKDOCK_MCP_TOKEN" = "tdm_x" }"#));
        assert!(!s.contains("command = '"), "不得使用无法转义的 literal string");
    }

    #[test]
    fn codex_token_control_chars_are_escaped() {
        let s = config_snippet("codex", "exe", "a\"b\\c").unwrap();
        assert!(s.contains(r#"a\"b\\c"#));
    }

    #[test]
    fn unknown_client_rejected_and_empty_token_rejected() {
        assert!(config_snippet("windsurf", "exe", "tok").is_err());
        assert!(config_snippet("codex", "exe", "  ").is_err());
        assert!(config_hint("windsurf").is_err());
    }

    #[test]
    fn hints_never_contain_configuration_syntax() {
        for client in CLIENTS {
            let hint = config_hint(client).unwrap();
            assert!(!hint.contains("mcpServers"));
            assert!(!hint.contains("[mcp_servers"));
        }
    }
}
