//! 能力步骤执行器（KnowledgeSearch / McpTool / SaveNote 的唯一实现）。
//!
//! 能力配方（Recipe）只负责模板、顺序调度与运行记录，步骤执行统一走本模块；
//! 工作流侧如需要同类步骤，也应调用这里，避免出现第二套执行逻辑。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{check_text, truncate_chars};

const MAX_STEP_OUTPUT_CHARS: usize = 8000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum CapabilityStep {
    KnowledgeSearch {
        #[serde(default)]
        kb_ids: Vec<String>,
        query: String,
        #[serde(default = "default_limit")]
        limit: u32,
    },
    McpTool {
        server_id: String,
        tool_name: String,
        #[serde(default)]
        args: Value,
        #[serde(default)]
        high_risk: bool,
    },
    SaveNote {
        title: String,
    },
}

fn default_limit() -> u32 {
    5
}

impl CapabilityStep {
    pub fn kind(&self) -> &'static str {
        match self {
            CapabilityStep::KnowledgeSearch { .. } => "knowledge_search",
            CapabilityStep::McpTool { .. } => "mcp_tool",
            CapabilityStep::SaveNote { .. } => "save_note",
        }
    }
}

/// 高风险判定：优先使用 Server 快照里的风险等级；快照缺失时回退步骤标记与静态名称规则。
pub fn step_is_high_risk(db: &Db, step: &CapabilityStep) -> AppResult<bool> {
    match step {
        CapabilityStep::McpTool {
            server_id,
            tool_name,
            high_risk,
            ..
        } => {
            let snapshot: Option<bool> = db.with_read(|conn| {
                use rusqlite::OptionalExtension;
                let tools_json: Option<String> = conn
                    .query_row(
                        "SELECT tools_json FROM external_mcp_servers WHERE id=?1",
                        [server_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(raw) = tools_json else {
                    return Ok(None);
                };
                let tools: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
                Ok(tools.iter().find_map(|tool| {
                    (tool.get("name").and_then(Value::as_str) == Some(tool_name)).then(|| {
                        tool.get("riskLevel")
                            .and_then(Value::as_str)
                            .map(|level| level == "high")
                            .or_else(|| tool.get("highRisk").and_then(Value::as_bool))
                            .unwrap_or(false)
                    })
                }))
            })?;
            Ok(snapshot.unwrap_or(*high_risk)
                || super::external_mcp::is_high_risk(tool_name, ""))
        }
        _ => Ok(false),
    }
}

/// 执行单个能力步骤。`previous` 是本步骤之前的已完成输出（SaveNote 汇总用）。
pub fn execute_step(
    db: &Db,
    step: &CapabilityStep,
    previous: &[(String, Value)],
) -> AppResult<Value> {
    match step {
        CapabilityStep::KnowledgeSearch { kb_ids, query, limit } => {
            let page = super::knowledge::search_impl(db, query, kb_ids, None, None, *limit, 0)?;
            Ok(json!({
                "query": page.query,
                "total": page.total,
                "hits": page.hits.iter().map(|hit| json!({
                    "docId": hit.doc_id,
                    "kbId": hit.kb_id,
                    "title": hit.title,
                    "source": hit.source_path,
                    "snippet": hit.snippet,
                    "offset": hit.chunk_offset,
                })).collect::<Vec<_>>()
            }))
        }
        CapabilityStep::McpTool {
            server_id,
            tool_name,
            args,
            ..
        } => {
            let report = super::external_mcp::call_tool_impl(
                db,
                server_id,
                tool_name,
                &args.to_string(),
                true,
            )?;
            if let Some(error) = report.error {
                return Err(AppError::Validation(error));
            }
            if report.is_error {
                return Err(AppError::Validation(
                    "MCP 工具返回 isError=true；内容已记录但按失败处理".into(),
                ));
            }
            Ok(json!({
                "tool": tool_name,
                "durationMs": report.duration_ms,
                "content": report.content,
            }))
        }
        CapabilityStep::SaveNote { title } => {
            let mut body = String::new();
            body.push_str("# 配方运行结果\n\n");
            for (kind, output) in previous {
                body.push_str(&format!(
                    "## 步骤 · {kind}\n\n```json\n{}\n```\n\n",
                    serde_json::to_string_pretty(output).unwrap_or_default()
                ));
            }
            let content = truncate_chars(&body, 190_000);
            let note = crate::notes::store::create(
                db,
                crate::notes::store::CreateNoteInput {
                    title: Some(check_text(title, "笔记标题", 200)?),
                    content: Some(content),
                },
            )?;
            Ok(json!({ "noteId": note.id, "title": note.title }))
        }
    }
}

/// 输出超过上限时截断为可追溯的预览，避免运行记录被大结果撑爆。
pub fn cap_step_output(output: Value) -> Value {
    let serialized = output.to_string();
    if serialized.len() > 32 * 1024 {
        json!({
            "truncated": true,
            "preview": truncate_chars(&serialized, MAX_STEP_OUTPUT_CHARS)
        })
    } else {
        output
    }
}
